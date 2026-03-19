/**
 * Standalone email blast script — sends wall-hit emails to eligible free users.
 * Usage: npx tsx server/scripts/emailBlast.ts
 *
 * Eligible: free tier, email verified, sentWall=false, playsUsed >= 2
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, isNull, gte, and } from "drizzle-orm";
import { users } from "../../shared/schema";
import { sendWallEmail } from "../email";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

async function main() {
  console.log("[blast] Starting wall-hit email blast...");

  const eligible = await db
    .select()
    .from(users)
    .where(
      and(
        isNull(users.subscriptionTier),
        eq(users.emailVerified, true),
        eq(users.sentWall, false),
        gte(users.playsUsed, 2)
      )
    );

  console.log(`[blast] Found ${eligible.length} eligible users`);
  let sent = 0;
  let failed = 0;

  for (const user of eligible) {
    try {
      await sendWallEmail(user.email);
      await db.update(users).set({ sentWall: true }).where(eq(users.id, user.id));
      console.log(`[blast] user ${user.id} — wall sent`);
      sent++;
    } catch (err: any) {
      console.error(`[blast] user ${user.id} — wall failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`[blast] Complete — ${sent} sent, ${failed} failed`);
  await pool.end();
}

main().catch(err => {
  console.error("[blast] Fatal error:", err);
  process.exit(1);
});
