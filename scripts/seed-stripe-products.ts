import { getUncachableStripeClient } from "../server/stripeClient";

const OLD_PRODUCT_NAMES = [
  "NBA Pro – LiveLocks",
  "All Sports – LiveLocks",
  "Elite – LiveLocks",
];

const NEW_PRODUCTS = [
  {
    key: "all",
    name: "Pro – LiveLocks",
    description: "Unlimited NBA prop calculations, NCAAB Live analytics, 2H Plays, parlay builder, push alerts, SMS alerts",
    amount: 4000,
    features: ["Unlimited NBA props", "NCAAB Live", "NBA 2H Plays", "SMS Alerts", "Push Notifications"],
  },
  {
    key: "elite",
    name: "All Sports – LiveLocks",
    description: "Everything in Pro + MLB Live (coming soon) + Priority SMS alerts",
    amount: 6500,
    features: ["Everything in Pro", "MLB Live (coming soon)", "Priority SMS", "Early access to new sports"],
  },
];

async function seed() {
  const stripe = await getUncachableStripeClient();

  // Archive old products
  for (const oldName of OLD_PRODUCT_NAMES) {
    const existing = await stripe.products.search({ query: `name:'${oldName}'` });
    for (const prod of existing.data) {
      if (prod.active) {
        await stripe.products.update(prod.id, { active: false });
        console.log(`[archived] "${oldName}" (${prod.id})`);
      } else {
        console.log(`[skip archive] "${oldName}" already inactive`);
      }
    }
  }

  // Create or update new products
  for (const plan of NEW_PRODUCTS) {
    const existing = await stripe.products.search({ query: `name:'${plan.name}'` });
    if (existing.data.length > 0) {
      const prod = existing.data[0];
      if (!prod.active) {
        await stripe.products.update(prod.id, { active: true });
        console.log(`[reactivated] "${plan.name}"`);
      } else {
        console.log(`[exists] "${plan.name}" (${prod.id})`);
      }
      const prices = await stripe.prices.list({ product: prod.id, active: true });
      if (prices.data.length > 0) {
        console.log(`           Price: ${prices.data[0].id} ($${prices.data[0].unit_amount! / 100}/mo)`);
      }
      continue;
    }

    const product = await stripe.products.create({
      name: plan.name,
      description: plan.description,
      metadata: { tier: plan.key },
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: plan.amount,
      currency: "usd",
      recurring: { interval: "month" },
    });

    console.log(`[created] "${plan.name}"`);
    console.log(`          Product: ${product.id}`);
    console.log(`          Price:   ${price.id} ($${plan.amount / 100}/mo)`);
  }

  console.log("\nDone. Stripe products are ready.");
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
