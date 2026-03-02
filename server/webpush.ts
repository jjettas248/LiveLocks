import webpush from "web-push";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = "mailto:support@livelocksai.app";

let initialized = false;

function ensureInit() {
  if (initialized) return;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn("[webpush] VAPID keys not set — push notifications disabled");
    return;
  }
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  initialized = true;
}

export function getVapidPublicKey(): string | null {
  return VAPID_PUBLIC_KEY ?? null;
}

export async function sendPush(
  subscriptionJson: string,
  payload: { title: string; body: string; url?: string }
): Promise<void> {
  ensureInit();
  if (!initialized) return;
  try {
    const subscription = JSON.parse(subscriptionJson) as webpush.PushSubscription;
    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title: payload.title, body: payload.body, url: payload.url ?? "/" })
    );
  } catch (err: any) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.warn("[webpush] Subscription expired/invalid — should remove:", err.statusCode);
      throw Object.assign(err, { expired: true });
    }
    console.warn("[webpush] Send failed:", err.message);
  }
}
