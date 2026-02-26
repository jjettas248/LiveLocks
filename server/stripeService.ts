import Stripe from "stripe";
import { storage } from "./storage";
import type { Request, Response } from "express";
import { requireAuth } from "./auth";

function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-01-27.acacia",
  });
}

const PLAN_CONFIG = {
  nba: {
    name: "NBA – Solo Sport",
    price: 2500,
    description: "Unlimited NBA play calculations",
  },
  all: {
    name: "All Sports",
    price: 5000,
    description: "Unlimited calculations for all sports (NBA + Baseball)",
  },
};

export async function registerStripeRoutes(app: import("express").Express) {
  app.post("/api/stripe/checkout", requireAuth, async (req: Request, res: Response) => {
    const { tier } = req.body;
    if (!tier || !PLAN_CONFIG[tier as keyof typeof PLAN_CONFIG]) {
      return res.status(400).json({ error: "Invalid subscription tier. Must be 'nba' or 'all'." });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: "Payment processing is not configured yet." });
    }

    try {
      const stripe = getStripe();
      const userId = req.session.userId!;
      const user = await storage.getUserById(userId);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const plan = PLAN_CONFIG[tier as keyof typeof PLAN_CONFIG];
      const origin = req.headers.origin || `${req.protocol}://${req.headers.host}`;

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: plan.name,
                description: plan.description,
              },
              unit_amount: plan.price,
              recurring: { interval: "month" },
            },
            quantity: 1,
          },
        ],
        success_url: `${origin}/?payment=success&tier=${tier}`,
        cancel_url: `${origin}/?payment=cancelled`,
        metadata: { userId: String(userId), tier },
        customer_email: user.stripeCustomerId ? undefined : user.email,
        customer: user.stripeCustomerId || undefined,
      };

      const checkoutSession = await stripe.checkout.sessions.create(sessionParams);
      return res.json({ url: checkoutSession.url });
    } catch (err: any) {
      console.error("[Stripe checkout error]", err.message);
      return res.status(500).json({ error: err.message || "Failed to create checkout session" });
    }
  });

  app.post("/api/stripe/webhook", async (req: Request, res: Response) => {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    const stripe = getStripe();
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event: Stripe.Event;

    try {
      if (webhookSecret && sig) {
        const rawBody = (req as any).rawBody;
        event = stripe.webhooks.constructEvent(rawBody, sig as string, webhookSecret);
      } else {
        event = req.body as Stripe.Event;
      }
    } catch (err: any) {
      console.error("[Stripe webhook signature error]", err.message);
      return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = Number(session.metadata?.userId);
      const tier = session.metadata?.tier;

      if (userId && tier) {
        const stripeCustomerId = typeof session.customer === "string" ? session.customer : session.customer?.id || "";
        const stripeSubscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id || "";
        await storage.updateUserSubscription(userId, tier, stripeCustomerId, stripeSubscriptionId);
        console.log(`[Stripe] Updated user ${userId} subscription to tier: ${tier}`);
      }
    }

    return res.json({ received: true });
  });
}
