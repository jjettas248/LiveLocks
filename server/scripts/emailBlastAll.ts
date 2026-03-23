/**
 * One-time wall-hit email blast — sends the wall-hit upgrade email to ALL
 * free-tier verified users, regardless of sentWall flag or playsUsed count.
 *
 * Usage:
 *   npx tsx server/scripts/emailBlastAll.ts              # live send
 *   DRY_RUN=true npx tsx server/scripts/emailBlastAll.ts # preview only
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, isNull, and } from "drizzle-orm";
import { users } from "../../shared/schema";
import { sendWallEmail } from "../email";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
  console.log(`[blast-all] Starting wall-hit full blast (DRY_RUN=${DRY_RUN})...`);

  const eligible = await db
    .select()
    .from(users)
    .where(
      and(
        isNull(users.subscriptionTier),
        eq(users.emailVerified, true)
      )
    );

  console.log(`[blast-all] Found ${eligible.length} eligible free verified users`);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const user of eligible) {
    if (DRY_RUN) {
      console.log(`[blast-all] DRY RUN — would send to: ${user.email} (id=${user.id}, playsUsed=${user.playsUsed}, sentWall=${user.sentWall})`);
      skipped++;
      continue;
    }

    try {
      await sendWallEmail(user.email);
      await db.update(users).set({ sentWall: true }).where(eq(users.id, user.id));
      console.log(`[blast-all] user ${user.id} (${user.email}) — sent`);
      sent++;
    } catch (err: any) {
      console.error(`[blast-all] user ${user.id} (${user.email}) — FAILED: ${err.message}`);
      failed++;
    }
  }

  if (DRY_RUN) {
    console.log(`[blast-all] DRY RUN complete — would have sent to ${skipped} users`);
  } else {
    console.log(`[blast-all] Complete — sent: ${sent}, failed: ${failed}, total: ${eligible.length}`);
  }

  await pool.end();
}

main().catch(err => {
  console.error("[blast-all] Fatal error:", err);
  process.exit(1);
});
