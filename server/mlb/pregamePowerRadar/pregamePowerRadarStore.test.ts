// Pre-Game Power Radar — store invariants, focused on commitGradedSignal's
// compare-and-swap semantics (the copy-on-write grading commit primitive).
// Run: npx tsx server/mlb/pregamePowerRadar/pregamePowerRadarStore.test.ts

import {
  setSnapshot,
  getSnapshot,
  commitGradedSignal,
  _resetForTests,
  type PregamePowerSnapshot,
} from "./pregamePowerRadarStore";
import type { PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function makeSignal(over: Partial<PregamePowerSignal> & { signalId: string; sessionDate: string }): PregamePowerSignal {
  return {
    signalId: over.signalId,
    sport: "mlb",
    engine: "pregame_power_radar",
    sessionDate: over.sessionDate,
    gameId: "g1",
    gameDate: over.sessionDate,
    startsAt: null,
    generatedAt: "2026-06-29T12:00:00Z",
    buildId: "ppr_test",
    batterId: "b1",
    batterName: "Test Batter",
    team: "NYY",
    opponent: "BOS",
    pitcherId: "p1",
    pitcherName: "Opposing Ace",
    battingOrderSlot: 3,
    handednessMatchup: "R vs L",
    primaryMarket: "home_runs",
    marketTags: ["home_runs"],
    marketScores: {},
    marketSetups: [],
    parkContext: null,
    score10: 7.5,
    tier: "strong",
    drivers: [],
    warnings: [],
    tags: [],
    lineupStatus: "posted",
    weatherStatus: "estimated",
    gameStatus: "final",
    firstPitchLockEligible: false,
    lockedAt: "2026-06-29T17:00:00Z",
    hasMarketLine: false,
    isOfficialPlay: false,
    isPregameTarget: true,
    status: "locked",
    suppressed: false,
    suppressedReasons: [],
    outcomes: null,
    everPubliclyFlagged: true,
    becameLiveReady: false,
    becameLiveFire: false,
    convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, pitcherHandednessScore: 7,
      matchupFitScore: 6, parkWeatherScore: 6, lineupOpportunityScore: 6, marketFitScore: 7,
      pitcherOrderSplitAvailable: false, pitcherOrderSplitScore: null, pitcherOrderSplitDirection: "unavailable",
      batterCurrentOrderSlot: 3, batterOrderSplitAvailable: false, batterOrderSplitScore: null, batterOrderSplitDirection: "unavailable",
      bvpAvailable: false, bvpScore: null, bvpSampleSize: null, bvpDirection: "neutral", zeroProductionBvpFlags: [],
      dataCoverageScore: 0.9, finalScoreBeforeCaps: 7.5, finalScoreAfterCaps: 7.5, matchupPenalty: 0,
      publicTier: "strong", warningTags: [], downgradeReasons: [], suppressed: false, suppressedReasons: [],
      sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    },
    ...over,
  } as PregamePowerSignal;
}

function makeSnapshot(signals: PregamePowerSignal[], sessionDate: string): PregamePowerSnapshot {
  return {
    buildId: "ppr_test_build",
    sessionDate,
    generatedAt: "2026-06-29T12:00:00Z",
    builtAtMs: Date.now(),
    gamesScanned: 1,
    battersEvaluated: signals.length,
    signals: new Map(signals.map((s) => [s.signalId, s])),
    coverage: { lineupCoverage: 1, weatherCoverage: 1, batterCoverage: 1, pitcherCoverage: 1 },
  };
}

// ── CAS succeeds when the current entry is still the expected reference ────
{
  _resetForTests();
  const original = makeSignal({ signalId: "s1", sessionDate: "2026-06-29" });
  setSnapshot(makeSnapshot([original], "2026-06-29"));

  const graded = { ...original, status: "graded", outcomes: { hitHr: true } } as PregamePowerSignal;
  const committed = commitGradedSignal(original, graded);
  ok(committed === true, "CAS commit succeeds when current entry === expected reference");
  ok(getSnapshot()?.signals.get("s1") === graded, "store now holds the graded draft");
}

// ── CAS refuses when the snapshot is empty ──────────────────────────────────
{
  _resetForTests();
  const original = makeSignal({ signalId: "s2", sessionDate: "2026-06-29" });
  const graded = { ...original, status: "graded" } as PregamePowerSignal;
  const committed = commitGradedSignal(original, graded);
  ok(committed === false, "CAS refuses when there is no current snapshot at all");
}

// ── CAS refuses when the snapshot has rolled to a new slate day ─────────────
{
  _resetForTests();
  const original = makeSignal({ signalId: "s3", sessionDate: "2026-06-29" });
  setSnapshot(makeSnapshot([original], "2026-06-29"));
  // A new day's snapshot has replaced the one this grading pass started from.
  setSnapshot(makeSnapshot([], "2026-06-30"));

  const graded = { ...original, status: "graded" } as PregamePowerSignal;
  const committed = commitGradedSignal(original, graded);
  ok(committed === false, "CAS refuses a cross-slate-day commit");
  ok(getSnapshot()?.signals.get("s3") === undefined, "the new day's snapshot is untouched by the stale commit attempt");
}

// ── CAS refuses when a live rebuild already replaced this exact signal ─────
{
  _resetForTests();
  const original = makeSignal({ signalId: "s4", sessionDate: "2026-06-29" });
  setSnapshot(makeSnapshot([original], "2026-06-29"));

  // Simulate a live rebuild superseding this signal with a fresh object
  // (same signalId, same sessionDate, but a different reference) while a
  // grading pass's DB write was still in flight.
  const rebuiltSignal = makeSignal({ signalId: "s4", sessionDate: "2026-06-29", score10: 8.1 });
  setSnapshot(makeSnapshot([rebuiltSignal], "2026-06-29"));

  const staleGraded = { ...original, status: "graded" } as PregamePowerSignal;
  const committed = commitGradedSignal(original, staleGraded);
  ok(committed === false, "CAS refuses to overwrite a signal a live rebuild already replaced");
  ok(getSnapshot()?.signals.get("s4") === rebuiltSignal, "the fresher rebuilt signal survives untouched");
}

console.log(`\npregamePowerRadarStore.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
