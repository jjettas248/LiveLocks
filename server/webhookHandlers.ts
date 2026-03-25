import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { storage } from "./storage";
import { sendProWelcomeEmail, sendAllSportsWelcomeEmail, sendPaymentIssueEmail } from "./email";
import { getTierFromPriceId } from "./billing/planMap";

const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "invoice.payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

async function syncSubscriptionToDb(stripe: any, subscriptionId: string): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? "";
  if (!customerId) return;

  // Clean model: active = access granted; anything else = access revoked
  if (sub.status !== "active") {
    if (sub.status === "past_due" || sub.status === "unpaid") {
      const issueUser = await storage.getUserByStripeCustomerId(customerId);
      if (issueUser) {
        await storage.setUserSubscriptionTier(issueUser.id, null);
        sendPaymentIssueEmail(issueUser.email).catch(console.error);
        console.log("[PLAN UPDATE]", { userId: issueUser.id, status: sub.status, action: "access_revoked" });
      }
    }
    return;
  }

  const priceId = sub.items.data[0]?.price?.id ?? "";
  const tier = getTierFromPriceId(priceId);
  if (!tier) return;

  const user = await storage.getUserByStripeCustomerId(customerId);
  if (!user) return;

  await storage.updateUserSubscription(user.id, tier, customerId, subscriptionId);
  console.log("[PLAN UPDATE]", { userId: user.id, priceId, tier, status: sub.status });

  if (tier === "all" && !user.sentProWelcome) {
    sendProWelcomeEmail(user.email)
      .then(() => storage.updateUserEmailFlags(user.id, { sentProWelcome: true }).catch(console.error))
      .catch(console.error);
  } else if (tier === "elite" && !user.sentAllSportsWelcome) {
    sendAllSportsWelcomeEmail(user.email)
      .then(() => storage.updateUserEmailFlags(user.id, { sentAllSportsWelcome: true }).catch(console.error))
      .catch(console.error);
  }
}

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "Payload must be a Buffer. This means express.json() ran before the webhook route."
      );
    }

    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("[webhook] STRIPE_WEBHOOK_SECRET not configured — cannot verify event");
      return;
    }

    let event: any;
    try {
      const stripe = await getUncachableStripeClient();
      event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (parseErr: any) {
      console.error("[webhook] Failed to construct event:", parseErr.message);
      return;
    }

    if (!HANDLED_EVENTS.has(event.type)) return;

    // DB-backed idempotency: guarantees every Stripe event is processed exactly once,
    // across server restarts and duplicate deliveries.
    const alreadyProcessed = await storage.hasProcessedStripeEvent(event.id);
    if (alreadyProcessed) {
      console.log("[webhook] Skipping duplicate event", { id: event.id, type: event.type });
      return;
    }
    await storage.recordStripeEvent(event.id);

    console.log("[STRIPE EVENT] received", { type: event.type, id: event.id });

    try {
      const stripe = await getUncachableStripeClient();

      if (event.type === "checkout.session.completed") {
        const session = event.data?.object;
        const userId = parseInt(session?.metadata?.userId || "0", 10);
        const metaTier = session?.metadata?.tier;
        const customerId = typeof session?.customer === "string" ? session.customer : "";
        const subscriptionId = typeof session?.subscription === "string" ? session.subscription : "";

        if (userId && metaTier) {
          await storage.updateUserSubscription(userId, metaTier, customerId, subscriptionId);
          console.log("[PLAN UPDATE]", { userId, tier: metaTier, customerId, event: "checkout.session.completed" });

          const user = await storage.getUserById(userId);
          if (user) {
            if (metaTier === "all" && !user.sentProWelcome) {
              sendProWelcomeEmail(user.email)
                .then(() => storage.updateUserEmailFlags(user.id, { sentProWelcome: true }).catch(console.error))
                .catch(console.error);
            } else if (metaTier === "elite" && !user.sentAllSportsWelcome) {
              sendAllSportsWelcomeEmail(user.email)
                .then(() => storage.updateUserEmailFlags(user.id, { sentAllSportsWelcome: true }).catch(console.error))
                .catch(console.error);
            }
          }
        }
        if (subscriptionId) {
          await syncSubscriptionToDb(stripe, subscriptionId).catch(console.error);
        }
      } else if (event.type === "invoice.payment_succeeded") {
        const invoice = event.data?.object;
        const subscriptionId = typeof invoice?.subscription === "string" ? invoice.subscription : "";
        if (subscriptionId) {
          await syncSubscriptionToDb(stripe, subscriptionId);
        }
      } else if (
        event.type === "customer.subscription.created" ||
        event.type === "customer.subscription.updated"
      ) {
        const subscription = event.data?.object;
        if (subscription?.id) {
          await syncSubscriptionToDb(stripe, subscription.id);
        }
      } else if (event.type === "customer.subscription.deleted") {
        const subscription = event.data?.object;
        const customerId = typeof subscription?.customer === "string" ? subscription.customer : "";

        if (customerId) {
          const user = await storage.getUserByStripeCustomerId(customerId);
          if (user) {
            await storage.setUserSubscriptionTier(user.id, null);
            console.log("[PLAN UPDATE]", { userId: user.id, tier: null, event: "subscription.deleted" });
            sendPaymentIssueEmail(user.email).catch(console.error);
          }
        }
      }
    } catch (err: any) {
      console.error("[webhook] Custom event handler error:", err.message);
    }
  }
}
