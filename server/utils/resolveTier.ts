import { getTierFromPriceId, getTierFromProductId } from "../billing/planMap";

export function resolveTierFromSubscription(subscription: any): "all" | "elite" | null {
  if (!subscription?.items?.data?.length) return null;
  const item = subscription.items.data[0];
  const priceId: string = item?.price?.id ?? "";
  const tier = getTierFromPriceId(priceId);
  if (tier === "all" || tier === "elite") return tier;
  const productId: string =
    typeof item?.price?.product === "string"
      ? item.price.product
      : item?.price?.product?.id ?? "";
  if (productId) {
    const productTier = getTierFromProductId(productId);
    if (productTier === "all" || productTier === "elite") return productTier;
  }
  console.warn("[resolveTierFromSubscription] Unknown Stripe subscription mapping", {
    priceId,
    productId,
  });
  return null;
}
