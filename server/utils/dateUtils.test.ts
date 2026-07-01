// server/utils/dateUtils — slateDateET() invariants.
// Run: npx tsx server/utils/dateUtils.test.ts
//
// slateDateET() must roll over at 6am ET, not midnight ET, so that a Pre-Game
// Power Radar rebuild running overnight agrees with discoverTodaysGames() on
// which slate is currently in play (see buildPregamePowerRadar.ts).

import { slateDateET } from "./dateUtils";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// A UTC instant is chosen per case such that its ET wall-clock time lands at
// the desired hour; EST (UTC-5) is used to match slateDateET()'s own offset.
function utcFor(y: number, m: number, d: number, etHour: number, etMinute = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, etHour + 5, etMinute));
}

// 5:59am ET on July 1 → still the June 30 slate.
const justBeforeCutoff = utcFor(2026, 7, 1, 5, 59);
ok(slateDateET(justBeforeCutoff) === "2026-06-30", "5:59am ET is still yesterday's slate");

// 6:00am ET on July 1 → rolls over to the July 1 slate.
const atCutoff = utcFor(2026, 7, 1, 6, 0);
ok(slateDateET(atCutoff) === "2026-07-01", "6:00am ET rolls over to today's slate");

// 2:00am ET on July 1 → still June 30 (the overnight window where the bug lived).
const overnight = utcFor(2026, 7, 1, 2, 0);
ok(slateDateET(overnight) === "2026-06-30", "2am ET is still yesterday's slate");

// Midday and evening ET agree with plain calendar-day todayET() semantics —
// spot-check against a fixed instant rather than the live clock.
const midday = utcFor(2026, 7, 1, 13, 0);
ok(slateDateET(midday) === "2026-07-01", "1pm ET matches the calendar day");

const evening = utcFor(2026, 7, 1, 23, 0);
ok(slateDateET(evening) === "2026-07-01", "11pm ET matches the calendar day");

// Sanity: calling with no argument uses the real clock and returns a
// YYYY-MM-DD string (doesn't throw, format matches todayET()'s pattern).
ok(/^\d{4}-\d{2}-\d{2}$/.test(slateDateET()), "no-arg call returns YYYY-MM-DD");

console.log(`\ndateUtils.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
