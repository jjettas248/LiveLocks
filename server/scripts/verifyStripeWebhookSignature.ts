// Diagnostic script — proves the Stripe webhook route correctly verifies a signature
// generated with the same STRIPE_WEBHOOK_SECRET the server is configured with, and that
// a valid-but-unhandled event type (payment_link.created) is accepted (200) rather than
// rejected. Mounts the real WebhookHandlers.processWebhook against a throwaway local
// Express server — no real Stripe API calls, no DB writes (unhandled events return before
// any storage access).
//
// Usage: STRIPE_WEBHOOK_SECRET=whsec_... DATABASE_URL=postgres://... npx tsx server/scripts/verifyStripeWebhookSignature.ts
import express from "express";
import Stripe from "stripe";
import { WebhookHandlers, WebhookConfigError, WebhookSignatureError } from "../webhookHandlers";

async function main() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("Set STRIPE_WEBHOOK_SECRET before running this script.");
    process.exit(1);
  }

  const app = express();
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const signature = req.headers["stripe-signature"];
    const sig = Array.isArray(signature) ? signature[0] : signature;
    if (!sig) return res.status(400).json({ error: "Missing stripe-signature" });
    try {
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (err: any) {
      if (err instanceof WebhookConfigError) return res.status(500).json({ error: "Webhook not configured" });
      if (err instanceof WebhookSignatureError) return res.status(400).json({ error: "Invalid signature" });
      res.status(400).json({ error: "Webhook processing error" });
    }
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;

  // A minimal but well-formed event body — "payload" must be exactly the string that
  // gets HMAC-signed AND exactly the bytes sent as the request body, or verification
  // will (correctly) fail. There is no live Stripe API call here; this only exercises
  // the local HMAC signing/verification path.
  const payload = JSON.stringify({
    id: "evt_test_payment_link_created",
    object: "event",
    type: "payment_link.created",
    data: { object: { id: "plink_test", object: "payment_link" } },
  });

  // Stripe's own test-header generator — guarantees the signature matches exactly what
  // constructEvent expects, so a failure here means the route/verification code is
  // wrong, not that the test script hand-rolled HMAC incorrectly.
  const stripeSignature = Stripe.webhooks.generateTestHeaderString({ payload, secret });

  const res = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": stripeSignature,
    },
    body: payload,
  });
  const body = await res.json().catch(() => null);

  server.close();

  console.log("Response status:", res.status, body);
  if (res.status !== 200) {
    console.error("FAIL: expected 200 for a valid signature + unhandled event type");
    process.exit(1);
  }
  console.log("PASS: valid signature + unhandled event type (payment_link.created) returned 200");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
