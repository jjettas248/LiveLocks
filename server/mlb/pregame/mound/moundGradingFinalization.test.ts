// Mound Radar — grading-measurement finalization invariants (blocker #2).
//
// An early monotonic-safe live Follow win (gradedLive: true) must NOT
// permanently compute the shadow grading measurements (§7b) from partial,
// still-climbing live totals. They must stay pending until the pitcher's
// outing is genuinely complete, then be computed exactly once from the true
// final counting stats and persisted. This test drives the real
// gradeMoundOutcomes() orchestration across two ticks — mid-outing, then
// post-outing — monkey-patching storage (no live database in this
// environment) and mutating the exported mlbGameCache/mlbPlayerCache caches
// directly to simulate a live game.
//
// Run: DATABASE_URL=postgres://... npx tsx server/mlb/pregame/mound/moundGradingFinalization.test.ts

import { gradeMoundOutcomes } from "./moundShadowOutcomes";
import { setMoundSnapshot, _resetMoundStoreForTests, type MoundRadarSnapshot } from "./mlbMoundRadarStore";
import { mlbGameCache, mlbPlayerCache } from "../../dataPullService";
import { storage } from "../../../storage";
import { buildMoundEvaluationSnapshot } from "./evaluationSnapshot";
import type { MoundSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const originalGetSignalsByDate = storage.getMlbMoundRadarSignalsByDate.bind(storage);
const originalUpsert = storage.upsertMlbMoundRadarSignal.bind(storage);
function restore() {
  (storage as any).getMlbMoundRadarSignalsByDate = originalGetSignalsByDate;
  (storage as any).upsertMlbMoundRadarSignal = originalUpsert;
}

const GAME_ID = "g1";
const PITCHER_ID = "p1";
const TEAM = "NYY";

function sig(over: Partial<MoundSignal>): MoundSignal {
  const base: MoundSignal = {
    signalId: "mlb-mound:2026-07-01:g1:p1", sport: "mlb", engine: "mound_radar",
    sessionDate: "2026-07-01", gameId: GAME_ID, gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b1", pitcherId: PITCHER_ID, pitcherName: "P", team: TEAM, opponent: "BOS",
    throws: "R", opposingLineupConfirmed: true, opposingLineupLabel: "vs BOS confirmed lineup",
    primaryMarket: "pitcher_strikeouts", marketTags: ["pitcher_strikeouts"],
    marketScores: { pitcher_strikeouts: 8 }, marketSetups: [],
    kStuffScore: 8, kStuffLabel: "Elite", platoonKFitScore: 6, platoonKFitLabel: "Solid",
    kProjectionLabel: null, kLineValue: null, parkContext: null,
    score10: 8, tier: "strong", moundDirection: "follow",
    drivers: [], warnings: [], tags: [], lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "live", firstPitchLockEligible: false, lockedAt: "2026-07-01T20:00:00Z",
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, marketEdgeContext: null,
    projectedStrikeouts: 6, matchupAdjustedStrikeouts: 6.5,
    status: "locked", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: true, everPubliclyFlaggedFade: false,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      pitcherSkillScore: 8, opponentKProfileScore: 6, workloadScore: 6, runEnvironmentScore: 5,
      recentFormScore: 6, marketFitScore: 0, contactRiskScore: null, riskPenalty: 0,
      appliedDrivers: [], appliedWarnings: [], dataCoverageScore: 0.9,
      finalScoreBeforeCaps: 8, finalScoreAfterCaps: 8, publicTier: "strong",
      suppressed: false, suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: {
        confirmedStarter: true, confirmedOpposingLineup: true, pitcherSeasonStats: true,
        pitcherHandednessSplits: true, pitcherRecentStarts: true, pitcherStuffMetrics: true,
        park: true, weather: true,
      },
    },
    ...over,
  };
  // A legitimate frozen pregame snapshot, exactly as a real pre-lock build would have stamped.
  const finalPregameSnapshot = buildMoundEvaluationSnapshot(base, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", 9, null);
  base.diagnostics.evaluation = {
    firstPublicSnapshot: finalPregameSnapshot, firstPublicUnavailableReason: null, firstPublicDirection: "follow", directionConflict: false,
    finalPregameSnapshot, finalPregameUnavailableReason: null, gradingMeasurements: null,
  };
  return base;
}

async function main() {
  (storage as any).getMlbMoundRadarSignalsByDate = async () => [];
  (storage as any).upsertMlbMoundRadarSignal = async () => {};

  _resetMoundStoreForTests();
  const signal = sig({});
  const snapshot: MoundRadarSnapshot = {
    buildId: "b1", sessionDate: "2026-07-01", generatedAt: "", builtAtMs: Date.now(),
    gamesScanned: 1, pitchersEvaluated: 1,
    signals: new Map([[signal.signalId, signal]]),
    coverage: { starterCoverage: 1, weatherCoverage: 1, pitcherCoverage: 1, lineupCoverage: 1 },
  };
  setMoundSnapshot(snapshot);

  // Frozen K/9 baseline = round(9*6/9,1) = 6.0. Live season K/9 is ALSO 9
  // here (kept identical to the frozen one so deriveMoundOutcome's public
  // classification and the shadow measurement agree on the baseline VALUE —
  // this test isolates the "partial vs final actual" bug, not baseline
  // provenance, which is covered separately).
  mlbPlayerCache.pitcherSeasonStats[PITCHER_ID] = { kPer9: 9 } as any;

  // ── Tick 1: pitcher still actively in the game, PARTIAL box score (7 Ks) ──
  mlbGameCache.gamePitchingBoxScore[GAME_ID] = {
    byPitcherId: { [PITCHER_ID]: { pitcherId: PITCHER_ID, pitcherName: "P", team: TEAM, strikeOuts: 7, outsRecorded: 10, baseOnBalls: 1, earnedRuns: 1 } },
    // pitcher is the LAST (only) entry → still in the game, not pulled.
    pitcherOrderByTeam: { [TEAM]: [PITCHER_ID] },
    fetchedAt: Date.now(),
  };

  await gradeMoundOutcomes();

  ok(signal.status === "graded", "tick 1: monotonic-safe live win grades immediately (status=graded)");
  ok(signal.outcomes?.gradedLive === true, "tick 1: gradedLive=true — outing not yet complete");
  ok(signal.outcomes?.finalStrikeouts === 7, "tick 1: outcomes carries the current (partial) live total, 7");
  ok(signal.diagnostics.evaluation?.gradingMeasurements == null,
    "tick 1: gradingMeasurements STAYS PENDING (null) — never computed from the partial live total");

  // ── Tick 2: outing now complete — pitcher pulled (no longer last in appearance order), FINAL box score (9 Ks) ──
  mlbGameCache.gamePitchingBoxScore[GAME_ID] = {
    byPitcherId: { [PITCHER_ID]: { pitcherId: PITCHER_ID, pitcherName: "P", team: TEAM, strikeOuts: 9, outsRecorded: 18, baseOnBalls: 2, earnedRuns: 2 } },
    // A later pitcher now appears after this one → hasPitcherBeenPulled() = true → outingComplete.
    pitcherOrderByTeam: { [TEAM]: [PITCHER_ID, "p2"] },
    fetchedAt: Date.now(),
  };

  await gradeMoundOutcomes();

  ok(signal.outcomes?.gradedLive === false, "tick 2: gradedLive flips to false once the outing completes and counting stats refresh");
  ok(signal.outcomes?.finalStrikeouts === 9, "tick 2: outcomes.finalStrikeouts refreshed to the TRUE final total, 9");
  ok(signal.diagnostics.evaluation?.gradingMeasurements != null,
    "tick 2: gradingMeasurements are NOW computed, exactly once, at the final refresh");
  ok(signal.diagnostics.evaluation?.gradingMeasurements?.championVsFrozenBaseline.actual === 9,
    "tick 2: the computed measurement uses the FINAL total (9), never the earlier partial live total (7)");
  ok(signal.diagnostics.evaluation?.gradingMeasurements?.championVsFrozenBaseline.baselineValue === 6,
    "tick 2: still compares against the frozen production baseline (6.0), unaffected by the timing of computation");
  ok(signal.diagnostics.evaluation?.gradingMeasurements?.projectionError.actual === 9,
    "tick 2: projection-error measurement also uses the final total, not the partial one");

  restore();
  _resetMoundStoreForTests();
  console.log(`\nmoundGradingFinalization.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  restore();
  console.error(e);
  process.exit(1);
});
