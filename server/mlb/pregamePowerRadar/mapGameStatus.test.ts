// Pre-Game Power Radar — mapGameStatus invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/mapGameStatus.test.ts

import { mapGameStatus } from "./buildPregamePowerRadar";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

ok(mapGameStatus("STATUS_SCHEDULED") === "scheduled", "scheduled maps correctly");
ok(mapGameStatus("STATUS_PRE_GAME") === "pre", "pre-game maps correctly");
ok(mapGameStatus("STATUS_IN_PROGRESS") === "live", "in-progress maps to live");
ok(mapGameStatus("STATUS_LIVE") === "live", "live maps correctly");
ok(mapGameStatus("STATUS_FINAL") === "final", "final maps correctly");
ok(mapGameStatus("STATUS_POSTPONED") === "postponed", "postponed maps correctly");
ok(mapGameStatus("STATUS_DELAYED") === "delayed", "delayed maps correctly");
ok(mapGameStatus(undefined) === "unknown", "undefined status maps to unknown");
ok(mapGameStatus("SOMETHING_UNRECOGNIZED") === "unknown", "unrecognized status maps to unknown");

// ── Suspended: must resolve to its own distinct, non-terminal status ────────
ok(mapGameStatus("STATUS_SUSPENDED") === "suspended", "suspended maps to its own status");
ok(mapGameStatus("STATUS_GAME_SUSPENDED") === "suspended", "any SUSPEND substring maps to suspended");
// Critical ordering check: a suspended game must never be misclassified as
// live just because some feeds describe a suspended game as still "in
// progress" — the SUSPEND check must win.
ok(mapGameStatus("STATUS_IN_PROGRESS_SUSPENDED") !== "live", "a suspended-in-progress status is never classified as live");
ok(mapGameStatus("STATUS_IN_PROGRESS_SUSPENDED") === "suspended", "suspended check takes priority over the live check");

console.log(`\nmapGameStatus.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
