// Mound Radar — analytics separation invariants.
//
// Asserts Mound's outcome taxonomy never overlaps Plate's, and that the two
// engines' in-memory snapshot stores are fully independent (grading/rebuilding
// one can never mutate the other's state).
//
// Run: npx tsx server/mlb/pregame/mound/moundAnalyticsSeparation.test.ts

import { setMoundSnapshot, getMoundSnapshot, _resetMoundStoreForTests, type MoundRadarSnapshot } from "./mlbMoundRadarStore";
import { getSnapshot as getPlateSnapshot, _resetForTests as resetPlateStore } from "../../pregamePowerRadar/pregamePowerRadarStore";
import type { MoundOutcomeType } from "../../../../shared/moundRadarWin";
import type { PregameOutcomeType } from "../../../../shared/pregameRadarWin";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── Outcome taxonomies never overlap (compile-time + runtime) ────────────────
const moundOutcomes: MoundOutcomeType[] = ["mound_win", "mound_calibration_miss"];
const plateOutcomes: PregameOutcomeType[] = ["pregame_win", "calibration_miss"];
const overlap = moundOutcomes.filter((m) => (plateOutcomes as string[]).includes(m));
ok(overlap.length === 0, `no overlap between mound and plate outcome types (found: ${overlap.join(",")})`);

// ── Mound and Plate in-memory stores are independent singletons ──────────────
_resetMoundStoreForTests();
resetPlateStore();

ok(getMoundSnapshot() === null, "mound store starts empty");
ok(getPlateSnapshot() === null, "plate store starts empty (independently reset)");

const moundSnapshot: MoundRadarSnapshot = {
  buildId: "mound_test_1",
  sessionDate: "2026-07-03",
  generatedAt: new Date(0).toISOString(),
  builtAtMs: Date.now(),
  gamesScanned: 1,
  pitchersEvaluated: 1,
  signals: new Map(),
  coverage: { starterCoverage: 1, weatherCoverage: 1, pitcherCoverage: 1, lineupCoverage: 1 },
};
setMoundSnapshot(moundSnapshot);

ok(getMoundSnapshot()?.buildId === "mound_test_1", "mound snapshot set correctly");
ok(getPlateSnapshot() === null, "setting a mound snapshot never populates the plate store");

_resetMoundStoreForTests();
resetPlateStore();

console.log(`\nmoundAnalyticsSeparation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
