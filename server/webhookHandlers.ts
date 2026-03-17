import { getStripeSync } from "./stripeClient";
import { storage } from "./storage";
import { sendProWelcomeEmail, sendAllSportsWelcomeEmail, sendPaymentIssueEmail } from "./email";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "Payload must be a Buffer. This means express.json() ran before the webhook route."
      );
    }

    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);

    try {
      const event = JSON.parse(payload.toString());

      if (event.type === "checkout.session.completed") {
        const session = event.data?.object;
        const userId = parseInt(session?.metadata?.userId || "0", 10);
        const tier = session?.metadata?.tier;
        const customerId = typeof session?.customer === "string" ? session.customer : "";
        const subscriptionId = typeof session?.subscription === "string" ? session.subscription : "";

        if (userId && tier) {
          await storage.updateUserSubscription(userId, tier, customerId, subscriptionId);
          console.log(`[webhook] Ungated user ${userId} → tier: ${tier}, isNewProUser: true, upgradedAt: ${new Date().toISOString()}`);

          const user = await storage.getUserById(userId);
          if (user) {
            if (tier === "all") {
              sendProWelcomeEmail(user.email).catch(console.error);
            } else if (tier === "elite") {
              sendAllSportsWelcomeEmail(user.email).catch(console.error);
            }
          }
        }
      } else if (event.type === "customer.subscription.updated") {
        const subscription = event.data?.object;
        const previousAttributes = event.data?.previous_attributes;
        const customerId = typeof subscription?.customer === "string" ? subscription.customer : "";
        const status = subscription?.status;

        if (customerId && previousAttributes?.metadata?.tier) {
          const previousTier = previousAttributes.metadata.tier;
          const newTier = subscription?.metadata?.tier;

          if (previousTier === "all" && newTier === "elite") {
            const user = await storage.getUserByStripeCustomerId(customerId);
            if (user) {
              sendAllSportsWelcomeEmail(user.email).catch(console.error);
            }
          }
        }

        if (customerId && (status === "past_due" || status === "canceled")) {
          const user = await storage.getUserByStripeCustomerId(customerId);
          if (user) {
            sendPaymentIssueEmail(user.email).catch(console.error);
          }
        }
      } else if (event.type === "customer.subscription.deleted") {
        const subscription = event.data?.object;
        const customerId = typeof subscription?.customer === "string" ? subscription.customer : "";

        if (customerId) {
          const user = await storage.getUserByStripeCustomerId(customerId);
          if (user) {
            await storage.setUserSubscriptionTier(user.id, null);
            console.log(`[webhook] Downgraded user ${user.id} (subscription cancelled)`);
            sendPaymentIssueEmail(user.email).catch(console.error);
          }
        }
      }
    } catch (err: any) {
      console.error("[webhook] Custom event handler error:", err.message);
    }
  }
}
