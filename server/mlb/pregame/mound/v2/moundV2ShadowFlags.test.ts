// Mound V2 shadow feature flag / kill switch — invariants.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ShadowFlags.test.ts

import { parseMoundV2BooleanFlag, isMoundV2ShadowEnabled } from "./moundV2ShadowFlags";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── Fail-closed parsing: only exact true-like tokens enable ─────────────────
{
  const trueLike = ["true", "TRUE", " true ", "True", "1", "on", "ON", "yes", "Yes", " yes "];
  for (const raw of trueLike) {
    ok(parseMoundV2BooleanFlag(raw) === true, `"${raw}" parses as true`);
  }
  const falseLike = ["false", "0", "off", "no", "banana", "", "  ", "TRUE ish", "2", undefined];
  for (const raw of falseLike) {
    ok(parseMoundV2BooleanFlag(raw) === false, `"${raw}" fails closed to false`);
  }
}

// ── Default (nothing set) is disabled — this process sets no such env var ──
{
  ok(isMoundV2ShadowEnabled() === false, "MOUND_V2_SHADOW_ENABLED defaults to disabled with nothing set in this process's environment");
}

// ── The kill switch: setting it off after having been on disables it ───────
{
  process.env.MOUND_V2_SHADOW_ENABLED = "true";
  ok(isMoundV2ShadowEnabled() === true, "explicitly setting the flag true enables it");
  process.env.MOUND_V2_SHADOW_ENABLED = "false";
  ok(isMoundV2ShadowEnabled() === false, "the kill switch (explicitly setting it back to false) disables it again");
  delete process.env.MOUND_V2_SHADOW_ENABLED;
  ok(isMoundV2ShadowEnabled() === false, "unsetting it entirely also leaves it disabled (fail-closed, not stuck-on)");
}

console.log(`\nmoundV2ShadowFlags.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
