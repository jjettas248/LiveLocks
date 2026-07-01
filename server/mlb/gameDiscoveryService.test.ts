// MLB Game Discovery — slate-date resolution invariants.
// Run: npx tsx server/mlb/gameDiscoveryService.test.ts
//
// Product rule under test:
//   • getMlbSlateDateET() rolls over at 6am ET (not midnight) — games that
//     finish after midnight stay attributed to the previous night's slate
//     while still finishing / being graded.
//   • The resolution must be DST-correct (Intl-based ET wall clock), not a
//     hardcoded EST (-5h) offset that silently drifts an hour wrong during
//     EDT (roughly Mar-Nov) — that drift used to shift the 6am cutover to
//     effectively 7am EDT, mis-filing an hour of "already today" games under
//     yesterday's slate every single morning.

import { getMlbSlateDateET } from "./gameDiscoveryService";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── 6am ET cutover ──────────────────────────────────────────────────────────
ok(
  getMlbSlateDateET(new Date("2026-07-01T05:00:00-04:00")) === "2026-06-30",
  "5am EDT rolls back to the previous day's slate",
);
ok(
  getMlbSlateDateET(new Date("2026-07-01T06:00:00-04:00")) === "2026-07-01",
  "6am EDT (at the cutover) is already today's slate",
);
ok(
  getMlbSlateDateET(new Date("2026-07-01T23:00:00-04:00")) === "2026-07-01",
  "11pm EDT is today's slate",
);

// ── DST correctness (the actual bug being fixed) ────────────────────────────
// True ET at this UTC instant is 06:15 EDT (July 1) — already past the 6am
// cutover, so the slate should already be July 1. The old hardcoded EST
// (-5h) math would have read this as 05:15 "EST" (before 6am) and wrongly
// rolled it back to June 30.
ok(
  getMlbSlateDateET(new Date("2026-07-01T10:15:00Z")) === "2026-07-01",
  "EDT-correct: 06:15 EDT is past the cutover, not shifted a day early by a hardcoded EST offset",
);

// ── Winter (EST, non-DST) sanity check — behavior unchanged ────────────────
ok(
  getMlbSlateDateET(new Date("2026-01-15T05:00:00-05:00")) === "2026-01-14",
  "5am EST (winter) still rolls back to the previous day's slate",
);
ok(
  getMlbSlateDateET(new Date("2026-01-15T06:00:00-05:00")) === "2026-01-15",
  "6am EST (winter) is already today's slate",
);

// ── Midnight-boundary consistency ───────────────────────────────────────────
ok(
  getMlbSlateDateET(new Date("2026-06-30T23:59:59-04:00")) === "2026-06-30",
  "23:59:59 ET is still June 30's slate",
);
ok(
  getMlbSlateDateET(new Date("2026-07-01T00:00:01-04:00")) === "2026-06-30",
  "00:00:01 ET (just past midnight) is still June 30's slate — the whole point of the 6am cutover",
);

console.log(`\ngameDiscoveryService.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
