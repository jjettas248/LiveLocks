import { getUncachableStripeClient } from "../server/stripeClient";

const PRODUCTS = [
  {
    key: "nba",
    name: "NBA Only – LiveLocks",
    description: "Unlimited NBA prop probability calculations",
    amount: 2500,
  },
  {
    key: "all",
    name: "All Sports – LiveLocks",
    description: "Unlimited NBA + Baseball (coming soon) prop probability calculations",
    amount: 5000,
  },
];

async function seed() {
  const stripe = await getUncachableStripeClient();

  for (const plan of PRODUCTS) {
    const existing = await stripe.products.search({ query: `name:'${plan.name}'` });
    if (existing.data.length > 0) {
      const prod = existing.data[0];
      console.log(`[skip] "${plan.name}" already exists: ${prod.id}`);
      const prices = await stripe.prices.list({ product: prod.id, active: true });
      if (prices.data.length > 0) {
        console.log(`       Price: ${prices.data[0].id} ($${prices.data[0].unit_amount! / 100}/mo)`);
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
