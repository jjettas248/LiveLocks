import { sendPush } from "./webpush";
import { storage } from "./storage";

/**
 * Per-user push delivery wrapper.
 *
 * Centralises two concerns that every caller previously had to remember (and
 * none did): cleaning up dead subscriptions, and not hammering a single user
 * with back-to-back notifications. `webpush.sendPush` stays a thin transport;
 * this layer owns delivery policy and is the single function the alert paths
 * (`alertManager.ts`, admin test sends in `routes.ts`) call.
 */

// Minimum spacing between pushes to the same user. Prevents a runaway signal
// from firing a burst of notifications at one subscriber.
const MIN_PUSH_INTERVAL_MS = 10_000;
const lastPushAtByUser = new Map<number, number>();

type PushUser = { id: number; pushSubscription?: string | null };

type PushPayload = {
  title: string;
  body: string;
  url?: string;
  data?: Record<string, any>;
};

export type PushDeliveryResult = "sent" | "skipped_no_subscription" | "rate_limited" | "expired" | "failed";

export async function sendPushToUser(user: PushUser, payload: PushPayload): Promise<PushDeliveryResult> {
  if (!user.pushSubscription) return "skipped_no_subscription";

  const now = Date.now();
  const last = lastPushAtByUser.get(user.id) ?? 0;
  if (now - last < MIN_PUSH_INTERVAL_MS) {
    console.warn("[LL_PUSH_RATE_LIMITED]", { userId: user.id, sinceLastMs: now - last });
    return "rate_limited";
  }
  lastPushAtByUser.set(user.id, now);

  try {
    await sendPush(user.pushSubscription, payload);
    return "sent";
  } catch (err: any) {
    if (err?.expired) {
      // 410/404 — the browser revoked this subscription. Clear it so we stop
      // trying (and so the user can re-enable cleanly).
      console.warn("[LL_PUSH_SUBSCRIPTION_EXPIRED]", { userId: user.id, statusCode: err.statusCode });
      try {
        await storage.updateUserAlerts(user.id, { pushSubscription: null, pushAlerts: false });
      } catch (cleanupErr: any) {
        console.warn("[LL_PUSH_SUBSCRIPTION_EXPIRED] cleanup failed:", cleanupErr?.message);
      }
      return "expired";
    }
    console.warn("[LL_PUSH_SEND_FAILED]", { userId: user.id, message: err?.message });
    return "failed";
  }
}

/** Test-only: reset the rate-limit memory between runs. */
export function _resetPushRateLimitForTests(): void {
  lastPushAtByUser.clear();
}
