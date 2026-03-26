import { getTierFromPriceId } from "../billing/planMap";

export function resolveTierFromSubscription(subscription: any): "all" | "elite" | null {
  if (!subscription?.items?.data?.length) return null;
  const priceId: string = subscription.items.data[0]?.price?.id ?? "";
  const tier = getTierFromPriceId(priceId);
  if (tier === "all" || tier === "elite") return tier;
  return null;
}
