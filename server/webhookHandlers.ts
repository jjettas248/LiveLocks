import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { storage } from "./storage";
import { sendProWelcomeEmail, sendAllSportsWelcomeEmail, sendPaymentIssueEmail, sendChurnEmail } from "./email";
import { resolveTierFromSubscription } from "./utils/resolveTier";

const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "invoice.payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

// ---- Pass 3 — additive lifecycle sync (does NOT mutate subscriptionTier) ----
// Persists subscriptionStatus, trial timestamps, cancelAtPeriodEnd, subscriptionSource,
// and detects real post-trial conversion. Safe to call after the existing tier flow.
async function syncLifecycleFromSubscription(user: any, sub: any): Promise<void> {
  const stripeStatus: string = sub?.status ?? "";
  let lifecycleStatus: string | null;
  switch (stripeStatus) {
    case "trialing": lifecycleStatus = "trialing"; break;
    case "active": lifecycleStatus = "active"; break;
    case "past_due":
    case "unpaid": lifecycleStatus = "past_due"; break;
    case "canceled":
    case "incomplete_expired": lifecycleStatus = "canceled"; break;
    default: lifecycleStatus = null; // unknown/incomplete — leave unchanged
  }
  if (lifecycleStatus === null) return;

  const trialStartedAt = typeof sub?.trial_start === "number" ? new Date(sub.trial_start * 1000) : null;
  const trialEndsAt = typeof sub?.trial_end === "number" ? new Date(sub.trial_end * 1000) : null;
  const cancelAtPeriodEnd = !!sub?.cancel_at_period_end;

  const lifecycleUpdate: Parameters<typeof storage.updateSubscriptionLifecycle>[1] = {
    subscriptionStatus: lifecycleStatus,
    cancelAtPeriodEnd,
  };
  if (trialStartedAt && !user.trialStartedAt) {
    lifecycleUpdate.trialStartedAt = trialStartedAt;
  }
  if (trialEndsAt) {
    const existing = user.trialEndsAt instanceof Date
      ? user.trialEndsAt.getTime()
      : user.trialEndsAt
        ? new Date(user.trialEndsAt as any).getTime()
        : null;
    if (existing === null || existing !== trialEndsAt.getTime()) {
      lifecycleUpdate.trialEndsAt = trialEndsAt;
    }
  }
  // First-time source attribution. Never overwrite once set.
  if (!user.subscriptionSource) {
    if (lifecycleStatus === "trialing" || trialStartedAt) {
      lifecycleUpdate.subscriptionSource = "trial";
    } else if (lifecycleStatus === "active") {
      lifecycleUpdate.subscriptionSource = "direct_paid";
    }
  }

  await storage.updateSubscriptionLifecycle(user.id, lifecycleUpdate);

  // Real post-trial conversion: previously trialing (or had a trial start) → now active for the
  // first time. markTrialConverted re-asserts subscriptionStatus="active" and stamps convertedToPaidAt.
  const wasTrialing = user.subscriptionStatus === "trialing"
    || (!!user.trialStartedAt && !user.convertedToPaidAt);
  if (lifecycleStatus === "active" && wasTrialing && !user.convertedToPaidAt) {
    await storage.markTrialConverted(user.id, new Date());
    console.log("[LIFECYCLE]", { userId: user.id, event: "trial_converted_to_paid" });
  }
}

async function syncSubscriptionToDb(stripe: any, subscriptionId: string): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? "";
  if (!customerId) return;

  if (sub.status !== "active" && sub.status !== "trialing") {
    if (sub.status === "past_due" || sub.status === "unpaid") {
      const issueUser = await storage.getUserByStripeCustomerId(customerId);
      if (issueUser) {
        await storage.setUserSubscriptionTier(issueUser.id, null);
        // Pass 3 — record lifecycle status alongside the existing revoke (additive).
        await syncLifecycleFromSubscription(issueUser, sub).catch((err) =>
          console.warn("[LIFECYCLE] past_due sync failed:", err?.message ?? err)
        );
        sendPaymentIssueEmail(issueUser.email).catch(console.error);
        console.log("[PLAN UPDATE]", { userId: issueUser.id, status: sub.status, action: "access_revoked" });
      }
    }
    return;
  }

  const priceId = sub.items.data[0]?.price?.id ?? "";
  const tier = resolveTierFromSubscription(sub);
  if (!tier) {
    console.warn("[STRIPE SYNC] Unknown priceId — cannot resolve tier:", priceId);
    return;
  }

  const user = await storage.getUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn("[STRIPE SYNC] No user found for customerId:", customerId);
    return;
  }

  await storage.updateUserSubscription(user.id, tier, customerId, subscriptionId);
  console.log("[STRIPE SYNC]", { userId: user.id, priceId, resolvedTier: tier, status: sub.status });

  // Pass 3 — write lifecycle state separately AFTER the entitlement update so any failure
  // here cannot block tier provisioning. Re-fetch the user so conversion detection sees
  // the prior subscriptionStatus (not the one we just wrote via tier path, which doesn't
  // touch lifecycle columns).
  await syncLifecycleFromSubscription(user, sub).catch((err) =>
    console.warn("[LIFECYCLE] sync failed:", err?.message ?? err)
  );

  if (tier === "all" && !user.sentProWelcome) {
    storage.updateUserEmailFlags(user.id, { sentProWelcome: true })
      .then(() => sendProWelcomeEmail(user.email))
      .catch((err) => {
        storage.updateUserEmailFlags(user.id, { sentProWelcome: false }).catch(() => {});
        console.error("[webhook] proWelcome send failed (flag rolled back):", err.message);
      });
  } else if (tier === "elite" && !user.sentAllSportsWelcome) {
    storage.updateUserEmailFlags(user.id, { sentAllSportsWelcome: true })
      .then(() => sendAllSportsWelcomeEmail(user.email))
      .catch((err) => {
        storage.updateUserEmailFlags(user.id, { sentAllSportsWelcome: false }).catch(() => {});
        console.error("[webhook] allSportsWelcome send failed (flag rolled back):", err.message);
      });
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

    let event: any;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (webhookSecret) {
      try {
        const stripe = await getUncachableStripeClient();
        event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
      } catch (parseErr: any) {
        console.error("[webhook] Failed to construct event:", parseErr.message);
        return;
      }
    } else {
      try {
        event = JSON.parse(payload.toString());
      } catch (parseErr: any) {
        console.error("[webhook] Failed to parse event payload:", parseErr.message);
        return;
      }
      if (!event?.id || !event?.type) {
        console.error("[webhook] Parsed payload missing id or type — skipping");
        return;
      }
    }

    if (!HANDLED_EVENTS.has(event.type)) return;

    const alreadyProcessed = await storage.hasProcessedStripeEvent(event.id);
    if (alreadyProcessed) {
      console.log("[webhook] Skipping duplicate event", { id: event.id, type: event.type });
      return;
    }

    console.log("[STRIPE EVENT] received", { type: event.type, id: event.id });

    try {
      const stripe = await getUncachableStripeClient();

      if (event.type === "checkout.session.completed") {
        const session = event.data?.object;
        const subscriptionId = typeof session?.subscription === "string" ? session.subscription : "";
        const customerId = typeof session?.customer === "string" ? session.customer : "";
        const metadataUserId = session?.metadata?.userId ? Number(session.metadata.userId) : null;

        console.log("[STRIPE SYNC]", {
          source: "webhook:checkout.session.completed",
          customerId,
          subscriptionId,
          metadataTier: session?.metadata?.tier,
          metadataUserId,
        });

        if (metadataUserId && customerId) {
          const existingUser = await storage.getUserById(metadataUserId);
          if (existingUser && !existingUser.stripeCustomerId) {
            await storage.updateUserStripeCustomer(metadataUserId, customerId);
            console.log(`[STRIPE SYNC] Pre-linked customerId=${customerId} to userId=${metadataUserId} via checkout metadata`);
          }
        }

        if (subscriptionId) {
          await syncSubscriptionToDb(stripe, subscriptionId).catch(console.error);
        }

        try {
          const tier = session?.metadata?.tier;
          const metaUserId = session?.metadata?.userId ? parseInt(session.metadata.userId) : null;
          if (tier && metaUserId) {
            const backstopUser = await storage.getUserById(metaUserId);
            if (backstopUser && !backstopUser.subscriptionTier) {
              const bsCustomerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
              const bsSubId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
              await storage.updateUserSubscription(metaUserId, tier, bsCustomerId ?? null, bsSubId ?? null);
              console.log(`[STRIPE BACKSTOP] Granted tier=${tier} to userId=${metaUserId} from checkout metadata`);
            }
          }
        } catch (backstopErr: any) {
          console.warn("[STRIPE BACKSTOP] Failed:", backstopErr.message);
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
            const previousTier = user.subscriptionTier ?? resolveTierFromSubscription(subscription);
            await storage.setUserSubscriptionTier(user.id, null);

            // Pass 3 — split trial abandonment from paid churn.
            //
            // CORRECTNESS NOTE (post-architect review):
            // We must NOT rely on DB lifecycle fields alone to make this call. The
            // lifecycle writes elsewhere are non-blocking (`.catch(...)`), so a paid
            // user whose `convertedToPaidAt` write previously failed could be silently
            // misclassified as trial-abandoned and skip the churn flow.
            //
            // Use Stripe's authoritative trial fields on the deleted subscription
            // first; treat the DB `convertedToPaidAt` only as a *positive* override
            // (if the DB knows the user converted, definitely paid churn).
            const trialStartUnix = typeof subscription?.trial_start === "number" ? subscription.trial_start : 0;
            const trialEndUnix = typeof subscription?.trial_end === "number" ? subscription.trial_end : 0;
            const stripeStatus = typeof subscription?.status === "string" ? subscription.status : "";
            const hadTrial = trialStartUnix > 0 || trialEndUnix > 0;
            const nowSec = Math.floor(Date.now() / 1000);
            // Stripe-authoritative: the trial never completed before this deletion if
            // either the sub is still in `trialing` status, or trial_end is in the future.
            const stripeSaysTrialAbandoned =
              hadTrial && (stripeStatus === "trialing" || (trialEndUnix > 0 && trialEndUnix > nowSec));
            // Positive DB override — if we ever recorded a paid conversion, this is paid churn.
            const dbConfirmsPaid = !!user.convertedToPaidAt;
            const isTrialAbandonment = stripeSaysTrialAbandoned && !dbConfirmsPaid;

            if (isTrialAbandonment) {
              await storage.markTrialAbandoned(user.id, new Date());
              console.log("[LIFECYCLE]", {
                userId: user.id,
                email: user.email,
                event: "trial_abandoned",
                previousTier,
                stripeStatus,
                trialEndUnix,
                source: "stripe_authoritative",
              });
            } else {
              await storage.recordChurn(user.id, previousTier);
              await storage.updateSubscriptionLifecycle(user.id, {
                subscriptionStatus: "canceled",
                cancelAtPeriodEnd: false,
              }).catch((err) =>
                console.warn("[LIFECYCLE] churn lifecycle write failed:", err?.message ?? err)
              );
              console.log("[CHURN]", {
                userId: user.id,
                email: user.email,
                previousTier,
                event: "subscription.deleted",
                hadTrial,
                stripeStatus,
                dbConfirmsPaid,
              });
              sendChurnEmail(user.email, previousTier ?? "subscription").catch(console.error);
            }
          }
        }
      }

      await storage.recordStripeEvent(event.id);
    } catch (err: any) {
      console.error("[webhook] Custom event handler error:", err.message);
    }
  }
}
