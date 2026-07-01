// server/utils/dateUtils — slateDateET() invariants.
// Run: npx tsx server/utils/dateUtils.test.ts
//
// slateDateET() must roll over at 6am ET (America/New_York wall-clock, DST
// aware), not midnight ET and not a fixed UTC-5 offset, so that a Pre-Game
// Power Radar rebuild running overnight agrees with discoverTodaysGames() on
// which slate is currently in play (see buildPregamePowerRadar.ts).

import { slateDateET } from "./dateUtils";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// Builds the UTC instant for a given ET wall-clock time. `utcOffsetHours` is
// how many hours ahead of ET that UTC is at that instant — 5 for EST
// (winter), 4 for EDT (summer) — passed explicitly per case so the test
// doesn't rely on the same DST assumption being verified.
function utcFor(y: number, m: number, d: number, etHour: number, etMinute: number, utcOffsetHours: number): Date {
  return new Date(Date.UTC(y, m - 1, d, etHour + utcOffsetHours, etMinute));
}

// ── EDT (summer, UTC-4) — the bulk of the MLB season ──────────────────────

// 5:59am EDT on July 1 → still the June 30 slate.
ok(slateDateET(utcFor(2026, 7, 1, 5, 59, 4)) === "2026-06-30", "5:59am EDT is still yesterday's slate");

// 6:00am EDT on July 1 → rolls over to the July 1 slate.
ok(slateDateET(utcFor(2026, 7, 1, 6, 0, 4)) === "2026-07-01", "6:00am EDT rolls over to today's slate");

// 6:30am EDT on July 1 — the exact case a fixed UTC-5 offset gets wrong
// (it would compute 5:30 and incorrectly report June 30).
ok(slateDateET(utcFor(2026, 7, 1, 6, 30, 4)) === "2026-07-01", "6:30am EDT is already today's slate (DST-aware cutoff)");

// 2:00am EDT on July 1 → still June 30 (the overnight window where the original bug lived).
ok(slateDateET(utcFor(2026, 7, 1, 2, 0, 4)) === "2026-06-30", "2am EDT is still yesterday's slate");

// Midday and evening EDT agree with the calendar day.
ok(slateDateET(utcFor(2026, 7, 1, 13, 0, 4)) === "2026-07-01", "1pm EDT matches the calendar day");
ok(slateDateET(utcFor(2026, 7, 1, 23, 0, 4)) === "2026-07-01", "11pm EDT matches the calendar day");

// ── EST (winter, UTC-5) ─────────────────────────────────────────────────────

// 5:59am EST on Jan 15 → still the Jan 14 slate.
ok(slateDateET(utcFor(2026, 1, 15, 5, 59, 5)) === "2026-01-14", "5:59am EST is still yesterday's slate");

// 6:00am EST on Jan 15 → rolls over to the Jan 15 slate.
ok(slateDateET(utcFor(2026, 1, 15, 6, 0, 5)) === "2026-01-15", "6:00am EST rolls over to today's slate");

// Month/year boundary: 3am EST on Jan 1 → still Dec 31 of the prior year.
ok(slateDateET(utcFor(2026, 1, 1, 3, 0, 5)) === "2025-12-31", "3am EST on Jan 1 rolls back across a year boundary");

// Sanity: calling with no argument uses the real clock and returns a
// YYYY-MM-DD string (doesn't throw, format matches todayET()'s pattern).
ok(/^\d{4}-\d{2}-\d{2}$/.test(slateDateET()), "no-arg call returns YYYY-MM-DD");

console.log(`\ndateUtils.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
