const PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID || "price_1T6hh82ceUNmv10tdIMnFF5N";
const ALL_SPORTS_PRICE_ID = process.env.STRIPE_ALL_SPORTS_PRICE_ID || "price_1T6hh92ceUNmv10tShQlLUYt";

export const PLAN_MAP: Record<string, string> = {
  [PRO_PRICE_ID]: "all",
  [ALL_SPORTS_PRICE_ID]: "elite",
};

export function getTierFromPriceId(priceId: string): string | null {
  return PLAN_MAP[priceId] ?? null;
}
