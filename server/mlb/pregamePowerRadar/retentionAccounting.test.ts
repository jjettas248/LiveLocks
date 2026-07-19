// Pre-Game Power Radar — retention vs performance-accounting SEPARATION.
//
// Making completed misses VISIBLE (the retention fix) must not touch win/
// calibration accounting: a visible miss is never a win, the visible-card count
// is a different number from the win count, and pre-first-pitch candidate volume
// is unchanged. Visibility (isPublicPregameSignal) and accounting (buildPublicStats
// / buildCalibrationStats) are decoupled — this asserts both sides explicitly.
//
// Run: npx tsx server/mlb/pregamePowerRadar/retentionAccounting.test.ts

import { isPublicPregameSignal } from "./diagnostics";
import { buildPublicStats, buildCalibrationStats } from "./calibrationStats";
import type { PregameOutcome, PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function sig(over: Partial<PregamePowerSignal>): PregamePowerSignal {
  return {
    signalId: "mlb-pregame:2026-07-01:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b", batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    score10: 7, tier: "strong",
    drivers: [
      { key: "power", label: "Elite raw power", direction: "positive" },
      { key: "park", label: "HR park boost", direction: "positive" },
    ],
    warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "final", firstPitchLockEligible: false, lockedAt: "2026-07-01T20:00:00Z",
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "locked", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: true, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
    ...over,
  };
}

const win: PregameOutcome = { hitHr: true, totalBases: 4, outcome: "pregame_win", userVisible: true, firstAbPregameWin: false };
const miss: PregameOutcome = { hitHr: false, totalBases: 0, outcome: "calibration_miss", userVisible: false };

const gradedWin = sig({ signalId: "s-win", batterName: "Judge", status: "graded", outcomes: win });
const gradedMiss = sig({ signalId: "s-miss", batterName: "Miss Guy", status: "graded", outcomes: miss });
const scheduled = sig({ signalId: "s-sched", batterName: "Upcoming", gameStatus: "scheduled", firstPitchLockEligible: true, status: "active", lockedAt: null });

const slate = [gradedWin, gradedMiss, scheduled];

// ── Visibility: all three visible (win + completed miss + scheduled) ─────────
const visible = slate.filter(isPublicPregameSignal);
ok(visible.length === 3, "visible-card count includes the win, the completed miss, AND the scheduled candidate");
ok(isPublicPregameSignal(gradedMiss) === true, "a graded miss is a VISIBLE completed card");

// ── Accounting: win count is a DIFFERENT number from the visible count ───────
const publicStats = buildPublicStats(slate, slate, "2026-07-01");
ok(publicStats.pregameWinsToday === 1, "win count is wins-only (1), not the visible-card count");
ok(visible.length !== publicStats.pregameWinsToday, "visible-card count (3) ≠ win count (1) — retention did not inflate wins");

// ── The visible miss is NEVER counted as a win ──────────────────────────────
ok(!publicStats.topPregameWinPlayers.some((w) => /miss/i.test(w.label)), "the completed miss never appears as a win");
const calibration = buildCalibrationStats(slate, { startET: "2026-07-01", endET: "2026-07-01" });
ok(calibration.wins === 1 && calibration.calibrationMisses === 1, "calibration keeps the miss as a miss, the win as a win");

// ── Pre-first-pitch candidate volume is unchanged by retention ──────────────
// Retention only affects post-first-pitch signals; a scheduled candidate is
// visible via unchanged initial eligibility, not via the retention branch.
ok(isPublicPregameSignal(scheduled) === true, "scheduled candidate remains visible (candidate volume unchanged)");

console.log(`\nretentionAccounting.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
