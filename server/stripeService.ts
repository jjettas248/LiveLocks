import type { Request, Response } from "express";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import { getUncachableStripeClient } from "./stripeClient";

const PLAN_META = {
  all:   { name: "Pro – LiveLocks",        description: "Unlimited NBA + NCAAB Live analytics, 2H Plays, Parlay Builder, SMS Alerts, Push Notifications", amount: 4000, priceId: "price_1T6fl12cW8Vmrgt3B6ffBIuw" },
  elite: { name: "All Sports – LiveLocks", description: "Everything in Pro + MLB Live prop predictions + Priority SMS",                                     amount: 6500, priceId: "price_1T6fly2cW8Vmrgt3WU9uHL7L" },
};

async function getPriceIdForTier(tier: "all" | "elite"): Promise<string> {
  return PLAN_META[tier].priceId;
}

export async function registerStripeRoutes(app: import("express").Express) {
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

      const priceId = await getPriceIdForTier(tier as "all" | "elite");
      const origin = req.headers.origin || `${req.protocol}://${req.headers.host}`;
      const meta = PLAN_META[tier as keyof typeof PLAN_META];

      const sessionParams: any = {
        mode: "subscription",
        payment_method_types: ["card"],
        success_url: `${origin}/?payment=success&tier=${tier}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?payment=cancelled`,
        metadata: { userId: String(userId), tier },
      };

      sessionParams.line_items = [{ price: priceId, quantity: 1 }];

      if (user.stripeCustomerId) {
        sessionParams.customer = user.stripeCustomerId;
      } else {
        sessionParams.customer_email = user.email;
      }

      const checkoutSession = await stripe.checkout.sessions.create(sessionParams);
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
        const existing = await getPriceIdForTier(key as "nba" | "all");
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

  app.post("/api/stripe/checkout-complete", requireAuth, async (req: Request, res: Response) => {
    const { tier, sessionId } = req.body;
    const userId = (req as any).resolvedUserId!;
    if (!tier || !PLAN_META[tier as keyof typeof PLAN_META]) {
      return res.status(400).json({ error: "Invalid tier" });
    }
    try {
      let stripeCustomerId = "";
      let stripeSubscriptionId = "";

      if (sessionId) {
        try {
          const stripe = await getUncachableStripeClient();
          const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ["subscription"],
          });
          if (session.payment_status === "paid" || session.status === "complete") {
            stripeCustomerId = typeof session.customer === "string" ? session.customer : (session.customer as any)?.id ?? "";
            const sub = session.subscription as any;
            stripeSubscriptionId = typeof sub === "string" ? sub : sub?.id ?? "";
          } else {
            console.warn(`[checkout-complete] Session ${sessionId} not paid — status: ${session.payment_status}`);
            return res.status(400).json({ error: "Payment not confirmed" });
          }
        } catch (stripeErr: any) {
          console.error("[checkout-complete] Stripe session lookup failed:", stripeErr.message);
        }
      }

      await storage.updateUserSubscription(userId, tier, stripeCustomerId, stripeSubscriptionId);
      const user = await storage.getUserById(userId);
      console.log(`[checkout-complete] User ${userId} activated tier="${tier}" customer=${stripeCustomerId}`);
      return res.json({ success: true, subscriptionTier: user?.subscriptionTier });
    } catch (err: any) {
      console.error("[checkout-complete] Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  });
}
