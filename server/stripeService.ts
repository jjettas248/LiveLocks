import type { Request, Response } from "express";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import { getUncachableStripeClient } from "./stripeClient";
import { db } from "./db";
import { sql } from "drizzle-orm";

const PLAN_META = {
  nba: { name: "NBA Only – LiveLocks", description: "Unlimited NBA prop calculations", amount: 2500 },
  all: { name: "All Sports – LiveLocks", description: "Unlimited NBA + Baseball prop calculations", amount: 5000 },
};

async function getPriceIdForTier(tier: "nba" | "all"): Promise<string | null> {
  try {
    const meta = PLAN_META[tier];
    const result = await db.execute(sql`
      SELECT pr.id
      FROM stripe.prices pr
      JOIN stripe.products p ON pr.product = p.id
      WHERE p.name = ${meta.name}
        AND pr.active = true
        AND pr.unit_amount = ${meta.amount}
      LIMIT 1
    `);
    const row = result.rows[0] as any;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

export async function registerStripeRoutes(app: import("express").Express) {
  app.post("/api/stripe/checkout", requireAuth, async (req: Request, res: Response) => {
    const { tier } = req.body;
    if (!tier || !PLAN_META[tier as keyof typeof PLAN_META]) {
      return res.status(400).json({ error: "Invalid subscription tier. Must be 'nba' or 'all'." });
    }

    try {
      const stripe = await getUncachableStripeClient();
      const userId = (req as any).resolvedUserId!;
      const user = await storage.getUserById(userId);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const priceId = await getPriceIdForTier(tier as "nba" | "all");
      const origin = req.headers.origin || `${req.protocol}://${req.headers.host}`;
      const meta = PLAN_META[tier as keyof typeof PLAN_META];

      const sessionParams: any = {
        mode: "subscription",
        payment_method_types: ["card"],
        success_url: `${origin}/?payment=success&tier=${tier}`,
        cancel_url: `${origin}/?payment=cancelled`,
        metadata: { userId: String(userId), tier },
      };

      if (priceId) {
        sessionParams.line_items = [{ price: priceId, quantity: 1 }];
      } else {
        sessionParams.line_items = [{
          price_data: {
            currency: "usd",
            product_data: { name: meta.name, description: meta.description },
            unit_amount: meta.amount,
            recurring: { interval: "month" },
          },
          quantity: 1,
        }];
      }

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
    const { tier, stripeCustomerId, stripeSubscriptionId } = req.body;
    const userId = (req as any).resolvedUserId!;
    if (!tier) return res.status(400).json({ error: "Missing tier" });
    try {
      await storage.updateUserSubscription(userId, tier, stripeCustomerId || "", stripeSubscriptionId || "");
      const user = await storage.getUserById(userId);
      return res.json({ success: true, subscriptionTier: user?.subscriptionTier });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });
}
