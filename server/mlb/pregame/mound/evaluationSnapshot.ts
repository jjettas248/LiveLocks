// Mound Radar — frozen evaluation-snapshot instrumentation (pure, no I/O).
// Mirrors pregamePowerRadar/evaluationSnapshot.ts's role for pitcher signals —
// independent implementation per this module's isolation convention (no
// shared type imports, no shared scoring/driver logic with Plate).
//
// Research-only measurement layer (Phase 1). Snapshots every evaluated
// candidate's champion state — including suppressed ones — at first public
// surface and at the last valid pregame moment before lock. Follow and Fade
// are independent durable public tracks (everPubliclyFlagged /
// everPubliclyFlaggedFade) — both are checked, and a same-cycle conflict is
// tracked explicitly rather than silently double-counted.
//
// Hard boundaries (do not weaken):
//   • Never read by scoring.ts, marketTagger.ts, or diagnostics.ts's public
//     sort/filter.
//   • No shadow-challenger scoring here — Phase 1 snapshots and ranks the
//     EXISTING champion marketScores only (Phase 2 is not built in this pass).
//   • The `championVsFrozenBaseline` measurement here is a SEPARATE, shadow-
//     only computation — it never alters the existing public mound_win /
//     mound_fade_win / mound_calibration_miss classification produced by
//     moundOutcomeAttribution.ts's deriveMoundOutcome, which stays unchanged.

import type {
  MoundMarket,
  MoundSignal,
  MoundEvaluationRecord,
  MoundEvaluationSnapshot,
  MoundGradingMeasurements,
} from "./types";
import type { MoundDirection } from "./moundDirection";

export interface MoundPopulationRank {
  holistic: number;
  byMarket: Partial<Record<MoundMarket, number>>;
}

const RANKED_MARKETS: MoundMarket[] = ["pitcher_strikeouts", "pitcher_outs"];

/** Deterministic tie-breaker: score descending, data-completeness descending, signalId ascending. */
function compareForRank(a: MoundSignal, b: MoundSignal, scoreA: number, scoreB: number): number {
  if (scoreB !== scoreA) return scoreB - scoreA;
  const covA = a.diagnostics.dataCoverageScore ?? 0;
  const covB = b.diagnostics.dataCoverageScore ?? 0;
  if (covB !== covA) return covB - covA;
  return a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0;
}

/**
 * Rank the COMPLETE candidate population — never computed inside a single
 * candidate's build step. Ranks by holistic score10 and, independently, by
 * each existing champion marketScores[market] (no challenger ranks in Phase 1).
 */
export function computeMoundPopulationRanks(signals: MoundSignal[]): Map<string, MoundPopulationRank> {
  const result = new Map<string, MoundPopulationRank>();
  for (const s of signals) result.set(s.signalId, { holistic: 0, byMarket: {} });

  const holisticSorted = signals.slice().sort((a, b) => compareForRank(a, b, a.score10, b.score10));
  holisticSorted.forEach((s, i) => {
    result.get(s.signalId)!.holistic = i + 1;
  });

  for (const market of RANKED_MARKETS) {
    const withScore = signals.filter((s) => s.marketScores[market] != null);
    const sorted = withScore
      .slice()
      .sort((a, b) => compareForRank(a, b, a.marketScores[market]!, b.marketScores[market]!));
    sorted.forEach((s, i) => {
      result.get(s.signalId)!.byMarket[market] = i + 1;
    });
  }

  return result;
}

/** Season-rate-derived frozen baseline, same shape as moundOutcomeAttribution.ts's seasonBaseline(). */
export function computeFrozenProductionBaseline(
  seasonKPer9: number | null,
  seasonAvgInningsPerStart: number | null,
): { strikeouts: { value: number | null }; outs: { value: number | null } } {
  const strikeouts = seasonKPer9 != null ? Math.round(((seasonKPer9 * 6) / 9) * 10) / 10 : null;
  const outs = seasonAvgInningsPerStart != null ? Math.round(seasonAvgInningsPerStart * 3 * 10) / 10 : null;
  return { strikeouts: { value: strikeouts }, outs: { value: outs } };
}

/** Construct the current-cycle snapshot for one candidate from its already-built champion state. */
export function buildMoundEvaluationSnapshot(
  signal: MoundSignal,
  rank: MoundPopulationRank,
  buildId: string,
  candidatePoolSize: number,
  frozenAt: string,
  seasonKPer9: number | null,
  seasonAvgInningsPerStart: number | null,
): MoundEvaluationSnapshot {
  return {
    frozenAt,
    buildId,
    candidatePoolSize,
    champion: {
      score10: signal.score10,
      tier: signal.tier,
      componentScores: {
        pitcherSkillScore: signal.diagnostics.pitcherSkillScore,
        opponentKProfileScore: signal.diagnostics.opponentKProfileScore,
        workloadScore: signal.diagnostics.workloadScore,
        runEnvironmentScore: signal.diagnostics.runEnvironmentScore,
        recentFormScore: signal.diagnostics.recentFormScore,
      },
      marketScores: signal.marketScores,
      drivers: signal.drivers,
      rank,
      dataCoverageScore: signal.diagnostics.dataCoverageScore,
      lineupStatus: signal.lineupStatus,
      weatherStatus: signal.weatherStatus,
      frozenProductionBaseline: computeFrozenProductionBaseline(seasonKPer9, seasonAvgInningsPerStart),
      postedLine: {
        // Real fetch path exists (readOddsSnapshot market: "pitcher_strikeouts")
        // — reflect whatever the signal's own marketEdgeContext carries.
        strikeouts: {
          line: signal.marketEdgeContext?.line ?? null,
          lineUnavailableReason: signal.marketEdgeContext?.line != null ? null : "no_line_posted",
          sourceTimestamp: signal.marketEdgeContext?.oddsUpdatedAt ?? null,
        },
        // No fetch/match path exists anywhere for pitcher_outs today — always
        // unavailable, never derived/cross-substituted from Strikeouts.
        outs: { line: null, lineUnavailableReason: "no_data_source", sourceTimestamp: null },
      },
      predictionTimeProjections: {
        matchupAdjustedStrikeouts: signal.matchupAdjustedStrikeouts,
      },
    },
  };
}

export interface MoundTransition {
  becamePublicFollowNow: boolean;
  becamePublicFadeNow: boolean;
  /** True iff both of the above are true this cycle. */
  directionConflict: boolean;
  instrumentationGapDetected: boolean;
  lockedForEvaluation: boolean;
  hadPriorSignal: boolean;
  hadPriorEvaluationField: boolean;
}

/**
 * Compares the REAL signal objects directly — never a derived snapshot.
 * ONLY detects raw Follow/Fade transitions and whether a conflict exists; it
 * does NOT resolve a conflict via moundDirection — that must happen only
 * after the existing carryForwardMoundGradedState pinning has run (see
 * applyMoundEvaluationSnapshots below), never here.
 */
export function detectMoundTransition(
  fresh: MoundSignal,
  prev: MoundSignal | undefined,
): MoundTransition {
  const hadPriorSignal = prev != null;
  const priorEvaluation = prev?.diagnostics?.evaluation;
  const hadPriorEvaluationField = priorEvaluation !== undefined;
  const previouslyFollowPublic = prev?.everPubliclyFlagged === true;
  const previouslyFadePublic = prev?.everPubliclyFlaggedFade === true;
  const becamePublicFollowNow = fresh.everPubliclyFlagged === true && !previouslyFollowPublic;
  const becamePublicFadeNow = fresh.everPubliclyFlaggedFade === true && !previouslyFadePublic;
  const directionConflict = becamePublicFollowNow && becamePublicFadeNow;
  const previousWasPublic = previouslyFollowPublic || previouslyFadePublic;
  const instrumentationGapDetected =
    hadPriorSignal && previousWasPublic && (priorEvaluation == null || priorEvaluation.firstPublicSnapshot == null);
  // "active" is confirmed the SOLE open-for-write status — do NOT
  // additionally gate on firstPitchLockEligible. A DELAY/UNKNOWN gameStatus
  // before first pitch sets firstPitchLockEligible=false while status stays
  // "active" (mirrors the Plate build's isLocked computation), and the
  // public predicate can still surface that row — treating it as
  // locked-for-evaluation here would prematurely freeze finalPregameSnapshot
  // on a row that's still legitimately pregame.
  const lockedForEvaluation = fresh.status !== "active";
  return {
    becamePublicFollowNow,
    becamePublicFadeNow,
    directionConflict,
    instrumentationGapDetected,
    lockedForEvaluation,
    hadPriorSignal,
    hadPriorEvaluationField,
  };
}

/**
 * Freeze/carry rules. `pinnedMoundDirection` must be read AFTER
 * carryForwardMoundGradedState's existing pinning logic has run (the caller
 * guarantees this ordering — see applyMoundEvaluationSnapshots) — a
 * same-cycle Follow+Fade conflict is resolved using it only here, never
 * inside detectMoundTransition.
 */
export function applyMoundSnapshotLifecycle(
  prevEvaluation: MoundEvaluationRecord | null,
  currentSnapshot: MoundEvaluationSnapshot,
  transition: MoundTransition,
  pinnedMoundDirection: MoundDirection,
): MoundEvaluationRecord {
  let firstPublicSnapshot = prevEvaluation?.firstPublicSnapshot ?? null;
  let firstPublicUnavailableReason: MoundEvaluationRecord["firstPublicUnavailableReason"] =
    prevEvaluation?.firstPublicUnavailableReason ?? "not_yet_public";
  let firstPublicDirection = prevEvaluation?.firstPublicDirection ?? null;
  let directionConflict = prevEvaluation?.directionConflict ?? false;

  if (firstPublicSnapshot == null) {
    const becamePublicNow = transition.becamePublicFollowNow || transition.becamePublicFadeNow;
    if (becamePublicNow) {
      let resolvedDirection: "follow" | "fade" | null;
      if (transition.directionConflict) {
        directionConflict = true;
        // Resolve using the ALREADY-pinned moundDirection only; if it's
        // itself unresolved, exclude from direction-specific reporting
        // (null) rather than guessing — reporting counts this as a conflict.
        resolvedDirection = pinnedMoundDirection === "follow" || pinnedMoundDirection === "fade" ? pinnedMoundDirection : null;
      } else {
        resolvedDirection = transition.becamePublicFollowNow ? "follow" : "fade";
      }
      firstPublicSnapshot = currentSnapshot;
      firstPublicUnavailableReason = null;
      firstPublicDirection = resolvedDirection;
    } else if (transition.instrumentationGapDetected) {
      firstPublicUnavailableReason = "instrumentation_started_after_surface";
    }
  }

  let finalPregameSnapshot = prevEvaluation?.finalPregameSnapshot ?? null;
  let finalPregameUnavailableReason = prevEvaluation?.finalPregameUnavailableReason ?? null;
  if (!transition.lockedForEvaluation) {
    finalPregameSnapshot = currentSnapshot;
    finalPregameUnavailableReason = null;
  } else if (finalPregameSnapshot == null && finalPregameUnavailableReason == null) {
    finalPregameUnavailableReason = !transition.hadPriorSignal
      ? "first_seen_post_lock"
      : !transition.hadPriorEvaluationField
        ? "legacy_row"
        : "no_complete_pregame_build";
  }

  return {
    firstPublicSnapshot,
    firstPublicUnavailableReason,
    firstPublicDirection,
    directionConflict,
    finalPregameSnapshot,
    finalPregameUnavailableReason,
    gradingMeasurements: prevEvaluation?.gradingMeasurements ?? null,
  };
}

/**
 * Orchestrator: rank the complete population, then for every candidate
 * construct/compare/freeze its evaluation record and stamp it onto
 * `signal.diagnostics.evaluation`. Call once per build cycle, strictly AFTER
 * every candidate has been built AND carryForwardMoundGradedState has already
 * pinned moundDirection for each (buildMlbMoundRadar.ts's existing per-pitcher
 * loop already does this before this function runs) — this function reads
 * `signal.moundDirection` as already-pinned, never re-derives it.
 *
 * IMPORTANT: `carryForwardDroppedFromMound` (moundGradedStateCarry.ts)
 * produces a carried-over signal via a SHALLOW spread of `prev`
 * (`{ ...prev, ... }`), so `carried.diagnostics` is the SAME object
 * reference as `prev.diagnostics` — not a copy, and `prev` may still be
 * reachable from the retained previous snapshot until this build's
 * `setMoundSnapshot()` call swaps it in. `diagnostics` is therefore always
 * shallow-cloned here before attaching the new `evaluation` field, never
 * assigned into the existing object, so this pass can never mutate a
 * retained prior-build or hydration object.
 */
export function applyMoundEvaluationSnapshots(
  signals: Map<string, MoundSignal>,
  prevSignals: Map<string, MoundSignal> | null,
  buildId: string,
  seasonRatesByPitcherId: Map<string, { seasonKPer9: number | null; seasonAvgInningsPerStart: number | null }>,
): void {
  const all = Array.from(signals.values());
  const ranks = computeMoundPopulationRanks(all);
  const frozenAt = new Date().toISOString();
  for (const fresh of all) {
    const prev = prevSignals?.get(fresh.signalId);
    const rank = ranks.get(fresh.signalId)!;
    const seasonRates = seasonRatesByPitcherId.get(fresh.pitcherId) ?? { seasonKPer9: null, seasonAvgInningsPerStart: null };
    const currentSnapshot = buildMoundEvaluationSnapshot(
      fresh,
      rank,
      buildId,
      all.length,
      frozenAt,
      seasonRates.seasonKPer9,
      seasonRates.seasonAvgInningsPerStart,
    );
    const transition = detectMoundTransition(fresh, prev);
    const prevEvaluation = prev?.diagnostics?.evaluation ?? null;
    // fresh.moundDirection is already correctly pinned by this point — see
    // this function's own doc comment above.
    const evaluation = applyMoundSnapshotLifecycle(prevEvaluation, currentSnapshot, transition, fresh.moundDirection);
    // Never mutate fresh.diagnostics in place — see doc comment above.
    fresh.diagnostics = { ...fresh.diagnostics, evaluation };
  }
}

/**
 * Shadow-only grading measurements (§7b) — computed at grading time,
 * independent of and never altering deriveMoundOutcome's existing public
 * classification. Reads the frozen baseline from `finalPregameSnapshot` when
 * legitimate; falls back to a caller-supplied live baseline (tagged
 * legacyMovingBaseline) only when no frozen snapshot exists.
 */
export function computeMoundGradingMeasurements(
  primaryMarket: MoundMarket,
  moundDirection: MoundDirection,
  finalPregameSnapshot: MoundEvaluationSnapshot | null,
  finalStrikeouts: number | null,
  finalOutsRecorded: number | null,
  legacyLiveBaseline: number | null,
): MoundGradingMeasurements {
  const actual = primaryMarket === "pitcher_strikeouts" ? finalStrikeouts : finalOutsRecorded;

  const frozenBaseline =
    primaryMarket === "pitcher_strikeouts"
      ? finalPregameSnapshot?.champion.frozenProductionBaseline.strikeouts.value ?? null
      : finalPregameSnapshot?.champion.frozenProductionBaseline.outs.value ?? null;
  const legacyMovingBaseline = frozenBaseline == null && legacyLiveBaseline != null;
  const baselineValue = frozenBaseline ?? legacyLiveBaseline;

  let comparison: MoundGradingMeasurements["championVsFrozenBaseline"]["comparison"] = "unavailable";
  let gradingUnavailableReason: "no_baseline" | null = null;
  if (baselineValue == null || actual == null) {
    gradingUnavailableReason = "no_baseline";
  } else if (actual === baselineValue) {
    comparison = "push";
  } else {
    comparison = actual > baselineValue ? "over" : "under";
  }

  let directionResult: MoundGradingMeasurements["championVsFrozenBaseline"]["directionResult"] = "unavailable";
  if (comparison === "unavailable") directionResult = "unavailable";
  else if (comparison === "push") directionResult = "push";
  else if (moundDirection === "fade") directionResult = comparison === "under" ? "fade_win" : "loss";
  else directionResult = comparison === "over" ? "follow_win" : "loss";

  const line =
    primaryMarket === "pitcher_strikeouts"
      ? finalPregameSnapshot?.champion.postedLine.strikeouts ?? null
      : finalPregameSnapshot?.champion.postedLine.outs ?? null;
  let lineResult: MoundGradingMeasurements["actualVsFrozenLine"]["result"] = "unavailable";
  if (line?.line != null && actual != null) {
    lineResult = actual === line.line ? "push" : actual > line.line ? "over" : "under";
  }

  const projectedValue =
    primaryMarket === "pitcher_strikeouts"
      ? finalPregameSnapshot?.champion.predictionTimeProjections.matchupAdjustedStrikeouts ?? frozenBaseline
      : frozenBaseline; // No distinct outs projection exists today — reuses the frozen baseline honestly.
  const error = projectedValue != null && actual != null ? actual - projectedValue : null;

  return {
    championVsFrozenBaseline: {
      baselineSource: "frozen_production_baseline",
      baselineValue,
      actual,
      comparison,
      directionResult,
      gradingUnavailableReason,
      legacyMovingBaseline,
    },
    actualVsFrozenLine: {
      line: line?.line ?? null,
      lineUnavailableReason: line?.lineUnavailableReason ?? null,
      actual,
      result: lineResult,
    },
    projectionError: {
      projectedValue: projectedValue ?? null,
      actual,
      error,
    },
  };
}
