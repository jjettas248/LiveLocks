import Stripe from 'stripe';

let connectionSettings: any;

// Canonical production env vars (Railway). STRIPE_ELITE_PRICE_ID is not and has never
// been used by this codebase — STRIPE_ALL_SPORTS_PRICE_ID is the sole canonical name for
// the elite/all-sports tier's price ID. No alias is needed unless one is introduced later.
export interface StripeEnvStatus {
  hasSecretKey: boolean;
  secretKeyPrefix: "sk_live" | "sk_test" | "other" | "missing";
  hasWebhookSecret: boolean;
  webhookSecretPrefix: "whsec" | "other" | "missing";
  hasProPrice: boolean;
  hasAllSportsPrice: boolean;
}

export function getStripeEnvStatus(): StripeEnvStatus {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() || "";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || "";
  const proPrice = process.env.STRIPE_PRO_PRICE_ID?.trim() || "";
  const allSportsPrice = process.env.STRIPE_ALL_SPORTS_PRICE_ID?.trim() || "";

  const secretKeyPrefix: StripeEnvStatus["secretKeyPrefix"] = !secretKey
    ? "missing"
    : secretKey.startsWith("sk_live")
      ? "sk_live"
      : secretKey.startsWith("sk_test")
        ? "sk_test"
        : "other";

  const webhookSecretPrefix: StripeEnvStatus["webhookSecretPrefix"] = !webhookSecret
    ? "missing"
    : webhookSecret.startsWith("whsec")
      ? "whsec"
      : "other";

  return {
    hasSecretKey: !!secretKey,
    secretKeyPrefix,
    hasWebhookSecret: !!webhookSecret,
    webhookSecretPrefix,
    hasProPrice: !!proPrice,
    hasAllSportsPrice: !!allSportsPrice,
  };
}

async function getCredentials() {
  // Railway is the production home for this app now — Stripe credentials come
  // from Railway environment variables (STRIPE_SECRET_KEY). The Replit
  // Connector path below is retained only as a fallback for local Replit dev
  // environments that never had STRIPE_SECRET_KEY configured.
  // Trimmed defensively: a stray trailing newline/space pasted into Railway's
  // variable editor would otherwise silently pass as a non-empty value here.
  const envSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (envSecretKey) {
    return {
      publishableKey: process.env.VITE_STRIPE_PUBLISHABLE_KEY?.trim() || process.env.STRIPE_PUBLISHABLE_KEY?.trim() || "",
      secretKey: envSecretKey,
    };
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? 'depl ' + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error(
      'Stripe is not configured: STRIPE_SECRET_KEY is missing or empty in this running process. ' +
      'Most likely causes: (1) STRIPE_SECRET_KEY was not added to this Railway service\'s Variables, ' +
      '(2) it was added to a different Railway environment (e.g. staging) than the one currently serving requests, or ' +
      '(3) it was added but the service has not been redeployed since — Railway only picks up new/changed variables on the next deploy. ' +
      'Check GET /api/admin/stripe/config-status to confirm what this running process currently sees.'
    );
  }

  const connectorName = 'stripe';
  const isProduction = process.env.REPLIT_DEPLOYMENT === '1';
  const targetEnvironment = isProduction ? 'production' : 'development';

  const url = new URL(`https://${hostname}/api/v2/connection`);
  url.searchParams.set('include_secrets', 'true');
  url.searchParams.set('connector_names', connectorName);
  url.searchParams.set('environment', targetEnvironment);

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'X-Replit-Token': xReplitToken
    }
  });

  const data = await response.json();
  connectionSettings = data.items?.[0];

  if (!connectionSettings || (!connectionSettings.settings.publishable || !connectionSettings.settings.secret)) {
    throw new Error(`Stripe ${targetEnvironment} connection not found`);
  }

  return {
    publishableKey: connectionSettings.settings.publishable,
    secretKey: connectionSettings.settings.secret,
  };
}

export async function getUncachableStripeClient() {
  const { secretKey } = await getCredentials();
  return new Stripe(secretKey, {
    apiVersion: '2025-01-27.acacia' as any,
  });
}

export async function getStripeSecretKey() {
  const { secretKey } = await getCredentials();
  return secretKey;
}

let stripeSync: any = null;

export async function getStripeSync() {
  if (!stripeSync) {
    const { StripeSync } = await import('stripe-replit-sync');
    const secretKey = await getStripeSecretKey();
    stripeSync = new StripeSync({
      poolConfig: {
        connectionString: process.env.DATABASE_URL!,
        max: 2,
      },
      stripeSecretKey: secretKey,
    });
  }
  return stripeSync;
}
