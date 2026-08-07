// PR7A stage 4 — PLATE_DISCIPLINE_NO_LOCATION_V1_ENABLED flag: fail-closed,
// and the composite capture gate requires BOTH flags.
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateDisciplineNoLocationFlag.test.ts

import {
  PLATE_DISCIPLINE_NO_LOCATION_V1_ENV,
  PLATE_HR_V2_FORWARD_CAPTURE_ENV,
  parsePlateDisciplineNoLocationFlag,
  isPlateDisciplineNoLocationEnabled,
  isPlateDisciplineNoLocationCaptureEnabled,
} from "./plateHrV2CaptureFlags";

let passed = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }

// pure parser: fail-closed
ok(parsePlateDisciplineNoLocationFlag(undefined) === false, "undefined => false");
ok(parsePlateDisciplineNoLocationFlag(null) === false, "null => false");
ok(parsePlateDisciplineNoLocationFlag("") === false, "empty => false");
ok(parsePlateDisciplineNoLocationFlag("ture") === false, "typo => false");
ok(parsePlateDisciplineNoLocationFlag("false") === false, "false => false");
for (const v of ["true", "1", "on", "yes", "TRUE", " Yes "]) ok(parsePlateDisciplineNoLocationFlag(v) === true, `affirmative ${JSON.stringify(v)} => true`);

// env-driven single flag
const savedDisc = process.env[PLATE_DISCIPLINE_NO_LOCATION_V1_ENV];
const savedMaster = process.env[PLATE_HR_V2_FORWARD_CAPTURE_ENV];
try {
  delete process.env[PLATE_DISCIPLINE_NO_LOCATION_V1_ENV];
  delete process.env[PLATE_HR_V2_FORWARD_CAPTURE_ENV];
  ok(isPlateDisciplineNoLocationEnabled() === false, "both unset => discipline flag off");
  ok(isPlateDisciplineNoLocationCaptureEnabled() === false, "both unset => capture inert");

  // composite gate: BOTH must be affirmative
  process.env[PLATE_DISCIPLINE_NO_LOCATION_V1_ENV] = "true";
  ok(isPlateDisciplineNoLocationEnabled() === true, "discipline flag on");
  ok(isPlateDisciplineNoLocationCaptureEnabled() === false, "discipline on but master off => inert");

  process.env[PLATE_HR_V2_FORWARD_CAPTURE_ENV] = "true";
  ok(isPlateDisciplineNoLocationCaptureEnabled() === true, "both on => capture enabled");

  process.env[PLATE_DISCIPLINE_NO_LOCATION_V1_ENV] = "false";
  ok(isPlateDisciplineNoLocationCaptureEnabled() === false, "master on but discipline off => inert");
} finally {
  if (savedDisc === undefined) delete process.env[PLATE_DISCIPLINE_NO_LOCATION_V1_ENV]; else process.env[PLATE_DISCIPLINE_NO_LOCATION_V1_ENV] = savedDisc;
  if (savedMaster === undefined) delete process.env[PLATE_HR_V2_FORWARD_CAPTURE_ENV]; else process.env[PLATE_HR_V2_FORWARD_CAPTURE_ENV] = savedMaster;
}

console.log(`plateDisciplineNoLocationFlag.test: ${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL:", f);
process.exit(fails.length ? 1 : 0);
