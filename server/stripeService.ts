import type { Request, Response } from "express";
import Stripe from "stripe";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import { getUncachableStripeClient } from "./stripeClient";
import { resolveAccess } from "./utils/access";

const PLAN_META = {
  all:   { name: "Pro – LiveLocks",        description: "Unlimited NBA + NCAAB Live analytics, 2H Plays, Parlay Builder, SMS Alerts, Push Notifications", amount: 4000, priceId: process.env.STRIPE_PRO_PRICE_ID        || "price_1TJJ4M2ceUNmv10tYSsYXA6T" },
  elite: { name: "All Sports – LiveLocks", description: "Everything in Pro + MLB Live prop predictions + Priority SMS",                                     amount: 6500, priceId: process.env.STRIPE_ALL_SPORTS_PRICE_ID || "price_1TJJ4M2ceUNmv10tB8JCzPYe" },
};

async function getPriceIdForTier(tier: "all" | "elite"): Promise<string> {
  return PLAN_META[tier].priceId;
}

export async function registerStripeRoutes(app: import("express").Express) {
  console.log("[stripe] Pro:", process.env.STRIPE_PRO_PRICE_ID ?? "fallback");
  console.log("[stripe] All Sports:", process.env.STRIPE_ALL_SPORTS_PRICE_ID ?? "fallback");

  app.post("/api/stripe/checkout", requireAuth, async (req: Request, res: Response) => {
    const { tier } = req.body;
    if (!tier || !PLAN_META[tier as keyof typeof PLAN_META]) {
      return res.status(400).json({ error: "Invalid subscription tier. Must be 'all' or 'elite'." });
    }

    try {
      const stripe = await getUncachableStripeClient();
      const userId = (req as any).resolvedUserId!;
      const user = await storage.getUserById(userId);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const plan = tier as "all" | "elite";
      if (!PLAN_META[plan]) {
        console.error("[stripe] Invalid plan:", plan);
        return res.status(400).json({ error: "Invalid plan" });
      }
      const priceId = await getPriceIdForTier(plan);
      const origin = req.headers.origin || `${req.protocol}://${req.headers.host}`;
      const meta = PLAN_META[plan];

      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { userId: String(userId) },
        });
        customerId = customer.id;
        await storage.updateUserStripeCustomer(userId, customerId);
        console.log(`[STRIPE] Created customer ${customerId} for userId=${userId}`);
      }

      const pendingItems = await stripe.invoiceItems.list({ customer: customerId, pending: true, limit: 100 });
      for (const item of pendingItems.data) {
        if (item.description === "3-Day Trial – LiveLocks") {
          await stripe.invoiceItems.del(item.id);
          console.log(`[STRIPE] Cleaned up orphaned trial invoice item ${item.id}`);
        }
      }

      await stripe.invoiceItems.create({
        customer: customerId,
        amount: 100,
        currency: "usd",
        description: "3-Day Trial – LiveLocks",
      });
      console.log(`[STRIPE] Attached $1 trial invoice item to customer ${customerId}`);

      const sessionParams: any = {
        customer: customerId,
        mode: "subscription",
        payment_method_types: ["card"],
        success_url: `${origin}/dashboard?payment=success&tier=${tier}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/dashboard?payment=cancelled`,
        metadata: { userId: String(userId), tier },
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: {
          trial_period_days: 3,
          metadata: { tier: plan, userId: String(userId) },
        },
      };

      const checkoutSession = await stripe.checkout.sessions.create(sessionParams);
      console.log(`[STRIPE] Checkout session created for userId=${userId} tier=${plan}`);
      return res.json({ url: checkoutSession.url });
    } catch (err: any) {
      console.error("[Stripe checkout error]", err.message);
      return res.status(500).json({ error: err.message || "Failed to create checkout session" });
    }
  });

  app.post("/api/stripe/setup-products", requireAuth, async (req: Request, res: Response) => {
    const userId = (req as any).resolvedUserId!;
    const user = await storage.getUserById(userId);
    if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

    try {
      const stripe = await getUncachableStripeClient();
      const result: Record<string, string> = {};

      for (const [key, meta] of Object.entries(PLAN_META) as [string, typeof PLAN_META[keyof typeof PLAN_META]][]) {
        const existing = await getPriceIdForTier(key as "all" | "elite");
        if (existing) {
          result[key] = existing;
          continue;
        }

        const product = await stripe.products.create({
          name: meta.name,
          description: meta.description,
        });

        const price = await stripe.prices.create({
          product: product.id,
          unit_amount: meta.amount,
          currency: "usd",
          recurring: { interval: "month" },
        });

        result[key] = price.id;
        console.log(`[stripe] Created product "${meta.name}" → price ${price.id}`);
      }

      return res.json({ success: true, priceIds: result });
    } catch (err: any) {
      console.error("[stripe setup-products error]", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/stripe/portal", requireAuth, async (req: Request, res: Response) => {
    const userId = (req as any).resolvedUserId!;
    const user = await storage.getUserById(userId);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: "No billing account found. Please contact support." });
    }
    try {
      const stripe = await getUncachableStripeClient();
      const origin = req.headers.origin || `${req.protocol}://${req.headers.host}`;
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: origin,
      });
      return res.json({ url: portalSession.url });
    } catch (err: any) {
      console.error("[Stripe portal error]", err.message);
      return res.status(500).json({ error: err.message || "Failed to open billing portal" });
    }
  });

  app.post("/api/stripe/upgrade", requireAuth, async (req: Request, res: Response) => {
    const { tier } = req.body;
    if (!tier || !PLAN_META[tier as keyof typeof PLAN_META]) {
      return res.status(400).json({ error: "Invalid subscription tier. Must be 'all' or 'elite'." });
    }

    const userId = (req as any).resolvedUserId!;
    const user = await storage.getUserById(userId);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    try {
      const stripe = await getUncachableStripeClient();
      const plan = tier as "all" | "elite";
      const newPriceId = await getPriceIdForTier(plan);

      if (user.stripeSubscriptionId && user.subscriptionTier === "all" && tier === "elite") {
        try {
          const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
          const item = subscription.items.data[0];
          if (item && subscription.status === "active") {
            await stripe.subscriptions.update(user.stripeSubscriptionId, {
              proration_behavior: "create_prorations",
              billing_cycle_anchor: "unchanged",
              items: [{ id: item.id, price: newPriceId }],
            });

            console.log(`[stripe-upgrade] User ${userId} prorated upgrade all→elite — DB update deferred to webhook`);
            return res.json({ success: true, tier });
          }
          console.warn(`[stripe-upgrade] Subscription ${user.stripeSubscriptionId} not active (status=${subscription.status}) — falling back to checkout`);
        } catch (subErr: any) {
          console.warn(`[stripe-upgrade] Could not retrieve/update subscription ${user.stripeSubscriptionId}: ${subErr.message} — falling back to checkout`);
        }
      }

      const origin = req.headers.origin || `${req.protocol}://${req.headers.host}`;
      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: "subscription",
        payment_method_types: ["card"],
        success_url: `${origin}/dashboard?payment=success&tier=${tier}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/dashboard?payment=cancelled`,
        metadata: { userId: String(userId), tier },
        line_items: [{ price: newPriceId, quantity: 1 }],
        ...(user.stripeCustomerId
          ? { customer: user.stripeCustomerId }
          : { customer_email: user.email }),
      };
      const checkoutSession = await stripe.checkout.sessions.create(sessionParams);
      return res.json({ url: checkoutSession.url });
    } catch (err: any) {
      console.error("[stripe-upgrade error]", err.message);
      return res.status(500).json({ error: err.message || "Failed to upgrade subscription" });
    }
  });

  app.post("/api/stripe/checkout-complete", requireAuth, async (req: Request, res: Response) => {
    const { tier, sessionId } = req.body;
    const userId = (req as any).resolvedUserId!;
    if (!tier || !PLAN_META[tier as keyof typeof PLAN_META]) {
      return res.status(400).json({ error: "Invalid tier" });
    }
    try {
      let stripeCustomerId = "";
      let stripeSubscriptionId = "";

      if (!sessionId) {
        return res.status(400).json({ error: "Session ID required" });
      }

      try {
        const stripe = await getUncachableStripeClient();
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ["subscription"],
        });

        const metadataUserId = session.metadata?.userId;
        if (metadataUserId && String(metadataUserId) !== String(userId)) {
          console.warn(`[checkout-complete] Session userId mismatch: metadata=${metadataUserId} auth=${userId}`);
          return res.status(403).json({ error: "Session does not belong to this user" });
        }

        const validPayment = session.payment_status === "paid"
          || session.payment_status === "no_payment_required"
          || session.status === "complete";
        if (!validPayment) {
          console.warn(`[checkout-complete] Session ${sessionId} not paid — payment_status=${session.payment_status} status=${session.status}`);
          return res.status(400).json({ error: "Payment not confirmed" });
        }

        stripeCustomerId = typeof session.customer === "string" ? session.customer : (session.customer as any)?.id ?? "";
        const sub = session.subscription as any;
        stripeSubscriptionId = typeof sub === "string" ? sub : sub?.id ?? "";
        console.log(`[checkout-complete] Session verified — payment_status=${session.payment_status} status=${session.status} customerId=${stripeCustomerId} subId=${stripeSubscriptionId}`);
      } catch (stripeErr: any) {
        console.error("[checkout-complete] Stripe session lookup failed:", stripeErr.message);
        return res.status(502).json({ error: "Unable to verify checkout session with Stripe" });
      }

      let resolvedTier: string | null = null;

      if (stripeSubscriptionId) {
        try {
          const stripeClient = await getUncachableStripeClient();
          const subscription = await stripeClient.subscriptions.retrieve(stripeSubscriptionId, {
            expand: ["items.data.price"],
          });
          const { resolveTierFromSubscription } = await import("./utils/resolveTier");
          resolvedTier = resolveTierFromSubscription(subscription);
        } catch (resolveErr: any) {
          console.error("[checkout-complete] Stripe subscription resolve failed:", resolveErr.message);
        }
      }

      if (!resolvedTier) {
        console.warn(`[checkout-complete] Could not resolve tier from Stripe — deferring to webhook`);
        return res.status(202).json({ error: "Tier verification pending — webhook will complete setup" });
      }

      await storage.updateUserSubscription(userId, resolvedTier, stripeCustomerId, stripeSubscriptionId);
      const user = await storage.getUserById(userId);
      const access = resolveAccess(user?.subscriptionTier, user?.isAdmin ?? false);
      console.log("[checkout-complete]", {
        userId,
        sessionId,
        stripeCustomerId,
        stripeSubscriptionId,
        resolvedTier,
        dbTier: user?.subscriptionTier,
      });
      return res.json({
        success: true,
        subscriptionTier: user?.subscriptionTier,
        hasNBA: access.hasNBA,
        hasNCAAB: access.hasNCAAB,
        hasMLB: access.hasMLB,
        hasUnlimited: access.hasUnlimited,
      });
    } catch (err: any) {
      console.error("[checkout-complete] Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  });
}
