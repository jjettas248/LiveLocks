/**
 * One-time wall-hit blast to real production free users.
 * Paid accounts (Pro / All Sports) are excluded.
 *
 * Usage:
 *   DRY_RUN=true npx tsx server/scripts/emailBlastRealUsers.ts --confirm   # preview
 *   npx tsx server/scripts/emailBlastRealUsers.ts --confirm                # live send
 *
 * --confirm flag is REQUIRED to prevent accidental execution.
 */

import { sendWallEmail } from "../email";

if (!process.argv.includes("--confirm")) {
  console.error("[blast-real] ABORTED: --confirm flag is required to run this script.");
  console.error("[blast-real] Usage: npx tsx server/scripts/emailBlastRealUsers.ts --confirm");
  process.exit(1);
}

const FREE_USERS = [
  "danielcole2006@yahoo.com",
  "dfg@gmail.com",
  "dfgh@gmail.com",
  "cozyjahh215@gmail.com",
  "ldunn221@gmail.com",
  "cokrystle786@gmail.com",
  "donc11262@gmail.com",
  "dc1282006@gmail.com",
  "nathanjr.66@gmail.com",
  "donkon2358@gmail.com",
  "jmatthews5121@gmail.com",
  "ducerain@gmail.com",
  "cambam0511@gmail.com",
  "joseph.mcclarnon4@gmail.com",
  "jenkinsjoshuaa3@gmail.com",
  "mcombary@gmail.com",
  "rjacksonjr4891@gmail.com",
  "winstonbryant@hotmail.com",
  "atlascopropertygroup@gmail.com",
  "ethanjturner1@gmail.com",
  "aznivgaiyan@yahoo.com",
  "mzanellis@gmail.com",
  "gaimsly21@gmail.com",
  "danmanthatman@gmail.com",
  "benhursson55@gmail.com",
  "michael0713b@gmail.com",
  "thomark92@gmail.com",
  "salimfcharles@gmail.com",
  "jetwalker19@gmail.com",
  "austinzimmerman38@gmail.com",
  "fb01hockey@yahoo.com",
  "cleefvalbonard84@gmail.com",
  "anthonylee.it4@gmail.com",
  "ihatepizza201@protonmail.com",
  "better151@gmail.com",
  "nicholas.steger@icloud.com",
  "Jay4nyah@gmail.com",
  "baricarter15@gmail.com",
  "crazyumichfan@gmail.com",
  "Jpdavis0124@gmail.com",
  "Jalen7324@gmail.com",
  "ennard775@gmail.com",
  "john_t_toombs@yahoo.com",
  "sparksbrandon17@gmail.com",
  "bijongaming2@gmail.com",
  "mitch.vezina@yahoo.com",
  "alexmitura@gmail.com",
  "brydsonmain@gmail.com",
  "seanrmc12@gmail.com",
  "christian@knowledgex.us",
  "seanhmobley@gmail.com",
  "anthonymastrioni@gmail.com",
  "Nicholasterifay@yahoo.com",
];

const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
  console.log(`[blast-real] Starting real-user wall-hit blast (DRY_RUN=${DRY_RUN})`);
  console.log(`[blast-real] ${FREE_USERS.length} free users targeted`);

  let sent = 0;
  let failed = 0;

  for (const email of FREE_USERS) {
    if (DRY_RUN) {
      console.log(`[blast-real] DRY RUN — would send to: ${email}`);
      continue;
    }

    try {
      await sendWallEmail(email);
      console.log(`[blast-real] SENT → ${email}`);
      sent++;
    } catch (err: any) {
      console.error(`[blast-real] FAILED → ${email}: ${err.message}`);
      failed++;
    }
  }

  if (DRY_RUN) {
    console.log(`[blast-real] DRY RUN complete — ${FREE_USERS.length} would be sent`);
  } else {
    console.log(`[blast-real] Complete — sent: ${sent}, failed: ${failed}, total: ${FREE_USERS.length}`);
  }
}

main().catch(err => {
  console.error("[blast-real] Fatal:", err);
  process.exit(1);
});
