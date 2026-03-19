import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sendWelcomeEmail } from "../email";

async function main() {
  const verifiedUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.emailVerified, true));

  console.log(`Found ${verifiedUsers.length} verified users`);

  let sent = 0;
  let failed = 0;

  for (const u of verifiedUsers) {
    try {
      await sendWelcomeEmail(u.email);
      sent++;
      console.log(`[${sent}/${verifiedUsers.length}] Sent to ${u.email}`);
    } catch (err) {
      failed++;
      console.error(`Failed to send to ${u.email}:`, err);
    }
  }

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
