// Mound Radar — frozen evaluation-snapshot invariants.
// Mirrors pregamePowerRadar/evaluationSnapshot.test.ts's coverage, plus the
// Mound-specific Follow/Fade conflict handling and the three-measurement
// grading design (§7b).
//
// Run: npx tsx server/mlb/pregame/mound/evaluationSnapshot.test.ts

import {
  computeMoundPopulationRanks,
  buildMoundEvaluationSnapshot,
  detectMoundTransition,
  applyMoundSnapshotLifecycle,
  applyMoundEvaluationSnapshots,
  computeMoundGradingMeasurements,
} from "./evaluationSnapshot";
import { deriveMoundOutcome } from "./moundOutcomeAttribution";
import type { MoundSignal, MoundEvaluationRecord } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function sig(over: Partial<MoundSignal>): MoundSignal {
  return {
    signalId: "mlb-mound:2026-07-01:g1:p1", sport: "mlb", engine: "mound_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b1", pitcherId: "p1", pitcherName: "P", team: "NYY", opponent: "BOS",
    throws: "R", opposingLineupConfirmed: true, opposingLineupLabel: "vs BOS confirmed lineup",
    primaryMarket: "pitcher_strikeouts", marketTags: ["pitcher_strikeouts", "pitcher_outs"],
    marketScores: { pitcher_strikeouts: 7, pitcher_outs: 6 }, marketSetups: [],
    kStuffScore: 7, kStuffLabel: "Strong", platoonKFitScore: 6, platoonKFitLabel: "Solid",
    kProjectionLabel: null, kLineValue: null, parkContext: null,
    score10: 7, tier: "strong", moundDirection: "follow",
    drivers: [], warnings: [], tags: [], lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, marketEdgeContext: null,
    projectedStrikeouts: 5, matchupAdjustedStrikeouts: 5.5,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, everPubliclyFlaggedFade: false,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      pitcherSkillScore: 7, opponentKProfileScore: 6, workloadScore: 6, runEnvironmentScore: 5,
      recentFormScore: 6, marketFitScore: 0, contactRiskScore: null, riskPenalty: 0,
      appliedDrivers: [], appliedWarnings: [], dataCoverageScore: 0.9,
      finalScoreBeforeCaps: 7, finalScoreAfterCaps: 7, publicTier: "strong",
      suppressed: false, suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: {
        confirmedStarter: true, confirmedOpposingLineup: true, pitcherSeasonStats: true,
        pitcherHandednessSplits: true, pitcherRecentStarts: true, pitcherStuffMetrics: true,
        park: true, weather: true,
      },
    },
    ...over,
  };
}

// ── 1. Brand-new candidate becoming public (Follow) on first build → genuine mint ──
{
  const fresh = sig({ everPubliclyFlagged: true, moundDirection: "follow" });
  const transition = detectMoundTransition(fresh, undefined);
  ok(transition.becamePublicFollowNow === true, "prevSignal null + fresh follow-public → mint");
  ok(transition.directionConflict === false, "single-direction transition is not a conflict");
  ok(transition.instrumentationGapDetected === false, "prevSignal null never triggers a gap");

  const snapshot = buildMoundEvaluationSnapshot(fresh, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", 9, 6);
  const record = applyMoundSnapshotLifecycle(null, snapshot, transition, fresh.moundDirection);
  ok(record.firstPublicSnapshot === snapshot, "mints firstPublicSnapshot");
  ok(record.firstPublicDirection === "follow", "direction recorded as follow");
  ok(record.directionConflict === false, "no conflict flagged");
}

// ── 2. Simultaneous Follow+Fade transition → conflict, resolved via PINNED moundDirection ──
{
  // Same cycle both flags flip true (e.g. a build recomputing marginal
  // scores) — detectMoundTransition must only report the raw conflict, never
  // resolve it itself.
  const fresh = sig({ everPubliclyFlagged: true, everPubliclyFlaggedFade: true, moundDirection: "fade" });
  const prev = sig({ everPubliclyFlagged: false, everPubliclyFlaggedFade: false });
  const transition = detectMoundTransition(fresh, prev);
  ok(transition.becamePublicFollowNow === true && transition.becamePublicFadeNow === true, "both directions transition this cycle");
  ok(transition.directionConflict === true, "raw conflict detected");

  // Resolution uses fresh.moundDirection AS ALREADY PINNED by the existing
  // carryForwardMoundGradedState call (which runs before this in the real
  // build loop) — here that's simulated by passing fresh.moundDirection in.
  const snapshot = buildMoundEvaluationSnapshot(fresh, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", 9, 6);
  const record = applyMoundSnapshotLifecycle(null, snapshot, transition, fresh.moundDirection);
  ok(record.firstPublicSnapshot === snapshot, "conflict is still resolved to a mint, not suppressed entirely");
  ok(record.firstPublicDirection === "fade", "resolved via the pinned moundDirection (fade)");
  ok(record.directionConflict === true, "conflict flag persists for reporting even though resolved");
}

// ── 2b. Conflict with an UNRESOLVED pinned direction → excluded, not guessed ──
{
  const fresh = sig({ everPubliclyFlagged: true, everPubliclyFlaggedFade: true, moundDirection: null });
  const transition = detectMoundTransition(fresh, undefined);
  const snapshot = buildMoundEvaluationSnapshot(fresh, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", 9, 6);
  const record = applyMoundSnapshotLifecycle(null, snapshot, transition, null);
  ok(record.directionConflict === true, "conflict still flagged");
  ok(record.firstPublicDirection === null, "unresolved pinned direction → firstPublicDirection stays null, never guessed");
}

// ── 3. Instrumentation gap: hydrated prior signal already Fade-public, no recorded snapshot ──
{
  const prevBase = sig({ everPubliclyFlaggedFade: true, moundDirection: "fade" });
  const prev: MoundSignal = { ...prevBase, diagnostics: { ...prevBase.diagnostics, evaluation: undefined } };
  const fresh = sig({ everPubliclyFlaggedFade: true, moundDirection: "fade" });
  const transition = detectMoundTransition(fresh, prev);
  ok(transition.becamePublicFadeNow === false, "already-fade-public prev → not a fresh transition");
  ok(transition.instrumentationGapDetected === true, "hydrated already-public prior with no firstPublicSnapshot → gap");
  const snapshot = buildMoundEvaluationSnapshot(fresh, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", 9, 6);
  const record = applyMoundSnapshotLifecycle(null, snapshot, transition, fresh.moundDirection);
  ok(record.firstPublicSnapshot === null && record.firstPublicUnavailableReason === "instrumentation_started_after_surface",
    "gap case tagged correctly, snapshot stays null");
}

// ── 4. finalPregameSnapshot freezes once locked; frozenProductionBaseline never mutates after ──
{
  const pregameSnapshot = buildMoundEvaluationSnapshot(sig({}), { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", 9, 6);
  ok(pregameSnapshot.champion.frozenProductionBaseline.strikeouts.value === 6, "frozen K baseline = round(9*6/9,1) = 6.0");
  const prevEvaluation: MoundEvaluationRecord = {
    firstPublicSnapshot: null, firstPublicUnavailableReason: "not_yet_public", firstPublicDirection: null, directionConflict: false,
    finalPregameSnapshot: pregameSnapshot, finalPregameUnavailableReason: null,
  };
  const freshLocked = sig({ status: "locked", firstPitchLockEligible: false, gameStatus: "live" });
  const transition = detectMoundTransition(freshLocked, sig({ status: "active" }));
  ok(transition.lockedForEvaluation === true, "locked status detected");
  // Season rates drifted live (11 K/9 instead of 9) — must NOT leak into the frozen snapshot.
  const laterSnapshot = buildMoundEvaluationSnapshot(freshLocked, { holistic: 1, byMarket: {} }, "b2", 1, "2026-07-02T00:00:00Z", 11, 6);
  const record = applyMoundSnapshotLifecycle(prevEvaluation, laterSnapshot, transition, freshLocked.moundDirection);
  ok(record.finalPregameSnapshot === pregameSnapshot, "locked signal keeps the ORIGINAL frozen snapshot");
  ok(record.finalPregameSnapshot!.champion.frozenProductionBaseline.strikeouts.value === 6,
    "frozen baseline unaffected by the later live K/9 drift to 11");
}

// ── 5. computeMoundPopulationRanks: independent Ks/Outs ranks over the full population ──
{
  const a = sig({ signalId: "a", score10: 7, marketScores: { pitcher_strikeouts: 8, pitcher_outs: 5 } });
  const b = sig({ signalId: "b", score10: 9, marketScores: { pitcher_strikeouts: 6, pitcher_outs: 9 } });
  const ranks = computeMoundPopulationRanks([a, b]);
  ok(ranks.get("b")!.holistic === 1, "higher score10 ranks first holistically");
  ok(ranks.get("a")!.byMarket.pitcher_strikeouts === 1, "a leads pitcher_strikeouts despite trailing holistically");
  ok(ranks.get("b")!.byMarket.pitcher_outs === 1, "b leads pitcher_outs");
}

// ── 6. applyMoundEvaluationSnapshots orchestrator, with season-rate map ──
{
  const signals = new Map<string, MoundSignal>();
  signals.set("s1", sig({ signalId: "s1", pitcherId: "p1", everPubliclyFlagged: true }));
  const rates = new Map([["p1", { seasonKPer9: 9, seasonAvgInningsPerStart: 6 }]]);
  applyMoundEvaluationSnapshots(signals, null, "build-1", rates);
  const evaluation = signals.get("s1")!.diagnostics.evaluation!;
  ok(evaluation.finalPregameSnapshot!.champion.frozenProductionBaseline.strikeouts.value === 6, "orchestrator wires season rates through to the frozen baseline");
  ok(evaluation.firstPublicDirection === "follow", "orchestrator resolves direction using the signal's own (pinned) moundDirection");
}

// ── 7. computeMoundGradingMeasurements: primary result uses frozen baseline, NEVER the posted line ──
{
  const finalPregameSnapshot = buildMoundEvaluationSnapshot(
    sig({ marketEdgeContext: { line: 4.5, oddsUpdatedAt: "2026-07-01T12:00:00Z" } }),
    { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", 9, 6,
  );
  // baseline = 6.0 Ks; posted line = 4.5 Ks (deliberately different) — actual = 7.
  const m = computeMoundGradingMeasurements("pitcher_strikeouts", "follow", finalPregameSnapshot, 7, null, null);
  ok(m.championVsFrozenBaseline.baselineValue === 6, "primary measurement uses the frozen production baseline (6.0)");
  ok(m.championVsFrozenBaseline.comparison === "over", "7 > 6 → over");
  ok(m.championVsFrozenBaseline.directionResult === "follow_win", "Follow + over baseline → follow_win");
  ok(m.championVsFrozenBaseline.legacyMovingBaseline === false, "frozen baseline was available — not a legacy fallback");
  ok(m.actualVsFrozenLine.line === 4.5, "secondary measurement uses the posted line (4.5), separately");
  ok(m.actualVsFrozenLine.result === "over", "7 > 4.5 → over, independent of the primary result");
  ok(m.projectionError.projectedValue === 5.5, "projection-error measurement uses matchupAdjustedStrikeouts (5.5), a THIRD distinct value");
  ok(m.projectionError.error === 1.5, "7 - 5.5 = 1.5");
}

// ── 8. Push (exact tie) on the frozen baseline — outs equality is structurally real ──
{
  const finalPregameSnapshot = buildMoundEvaluationSnapshot(sig({}), { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", null, 4);
  ok(finalPregameSnapshot.champion.frozenProductionBaseline.outs.value === 12, "outs baseline = avgIP(4)*3 = 12");
  const m = computeMoundGradingMeasurements("pitcher_outs", "follow", finalPregameSnapshot, null, 12, null);
  ok(m.championVsFrozenBaseline.comparison === "push", "exact tie on outs → push");
  ok(m.championVsFrozenBaseline.directionResult === "push", "push never counts as a win or a loss");
}

// ── 9. No frozen baseline → legacy live-refetched fallback, tagged and reported ──
{
  const m = computeMoundGradingMeasurements("pitcher_strikeouts", "follow", null, 7, null, 6);
  ok(m.championVsFrozenBaseline.baselineValue === 6, "falls back to the caller-supplied legacy live baseline");
  ok(m.championVsFrozenBaseline.legacyMovingBaseline === true, "tagged legacyMovingBaseline for promotion-grade exclusion");
}

// ── 10. Mound Outs never has a posted line — always unavailable, never cross-substituted from Ks ──
{
  const finalPregameSnapshot = buildMoundEvaluationSnapshot(
    sig({ marketEdgeContext: { line: 4.5, oddsUpdatedAt: "2026-07-01T12:00:00Z" } }),
    { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", 9, 6,
  );
  ok(finalPregameSnapshot.champion.postedLine.outs.line === null, "Outs postedLine is always null");
  ok(finalPregameSnapshot.champion.postedLine.outs.lineUnavailableReason === "no_data_source", "reason is no_data_source, not borrowed from Ks");
  const m = computeMoundGradingMeasurements("pitcher_outs", "follow", finalPregameSnapshot, null, 15, null);
  ok(m.actualVsFrozenLine.line === null, "Outs grading measurement never uses the Ks line as a substitute");
}

// ── 11. Existing public classification (deriveMoundOutcome) is untouched and independent of the new shadow measurement ──
// deriveMoundOutcome is moundOutcomeAttribution.ts's PRODUCTION function — not
// modified by this instrumentation (see the diff). This test runs BOTH the
// existing public classifier and the new shadow-only measurement against the
// identical inputs and proves neither reads from nor writes into the other:
// the public outcome uses the LIVE-refetched baseline (unchanged, as today),
// while the shadow measurement independently uses the FROZEN baseline — two
// different baseline sources can legitimately disagree without either one
// mutating or depending on the other's result.
{
  const liveRefetchedBaseline = 5; // what deriveMoundOutcome uses today, live
  const frozenBaselineAtBuildTime = 6; // what was captured pregame — deliberately different
  const finalStrikeouts = 5; // clears the live baseline (5) but NOT the frozen one (6)

  const publicOutcome = deriveMoundOutcome({
    primaryMarket: "pitcher_strikeouts",
    finalStrikeouts,
    finalOutsRecorded: null,
    seasonKPer9: (liveRefetchedBaseline * 9) / 6, // reverse the projectedStrikeoutsFromKPer9 math for a clean baseline of 5
    seasonAvgInningsPerStart: null,
    wasPubliclyFlagged: true,
    moundDirection: "follow",
  });
  ok(publicOutcome.outcome === "mound_win" && publicOutcome.userVisible === true,
    "Public classification (deriveMoundOutcome, UNMODIFIED production code): 5 clears the live baseline (5) → mound_win");
  ok(publicOutcome.seasonBaselineValue === 5, "Public classification's baseline is the LIVE one (5), exactly as it is in production today");

  const finalPregameSnapshot = buildMoundEvaluationSnapshot(
    sig({}), { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", (frozenBaselineAtBuildTime * 9) / 6, null,
  );
  const shadowMeasurement = computeMoundGradingMeasurements("pitcher_strikeouts", "follow", finalPregameSnapshot, finalStrikeouts, null, null);
  ok(shadowMeasurement.championVsFrozenBaseline.baselineValue === 6, "Shadow measurement's baseline is the FROZEN one (6), independently sourced");
  ok(shadowMeasurement.championVsFrozenBaseline.directionResult === "loss",
    "Shadow measurement: 5 does NOT clear the frozen baseline (6) → loss — DISAGREES with the public mound_win, proving true independence");

  ok(publicOutcome.outcome === "mound_win", "Public outcome is STILL mound_win after computing the disagreeing shadow measurement — no cross-contamination either direction");
}

console.log(`\nevaluationSnapshot.test (Mound): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
