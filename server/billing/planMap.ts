const PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID || "price_1TJJ4M2ceUNmv10tYSsYXA6T";
const ALL_SPORTS_PRICE_ID = process.env.STRIPE_ALL_SPORTS_PRICE_ID || "price_1TJJ4M2ceUNmv10tB8JCzPYe";

const LEGACY_PRO_PRICE_ID = "price_1T6hh82ceUNmv10tdIMnFF5N";
const LEGACY_ALL_SPORTS_PRICE_ID = "price_1T6hh92ceUNmv10tShQlLUYt";

export const PLAN_MAP: Record<string, string> = {
  [PRO_PRICE_ID]: "all",
  [ALL_SPORTS_PRICE_ID]: "elite",
  [LEGACY_PRO_PRICE_ID]: "all",
  [LEGACY_ALL_SPORTS_PRICE_ID]: "elite",
};

export const PRODUCT_MAP: Record<string, string> = {
  [process.env.STRIPE_PRO_PRODUCT_ID || "prod_U4rP9VYoK6FC5I"]: "all",
  [process.env.STRIPE_ALL_SPORTS_PRODUCT_ID || "prod_U4rPSI6tQ4CGz7"]: "elite",
};

export function getTierFromPriceId(priceId: string): string | null {
  return PLAN_MAP[priceId] ?? null;
}

export function getTierFromProductId(productId: string): string | null {
  return PRODUCT_MAP[productId] ?? null;
}
