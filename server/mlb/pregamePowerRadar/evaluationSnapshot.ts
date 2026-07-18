// Pre-Game Power Radar — frozen evaluation-snapshot instrumentation (pure, no I/O).
//
// Research-only measurement layer (Phase 1). Snapshots every evaluated
// candidate's champion state — including suppressed/never-publicly-flagged
// ones — at the moment it first surfaces publicly and at the last valid
// pregame moment before lock, so a later rebuild's freshly-recomputed
// score10/tier/drivers/marketScores can never silently overwrite what a user
// (or a future promotion analysis) actually saw pregame.
//
// Hard boundaries (do not weaken):
//   • Never read by scoring.ts, marketTagger.ts, or diagnostics.ts's public
//     sort/filter — measurement only, zero effect on production behavior.
//   • No shadow-challenger scoring here — Phase 1 snapshots and ranks the
//     EXISTING champion marketScores only (see CLAUDE.md-adjacent research
//     plan, Rev 6 §8: challenger modules are Phase 2, not built here).
//   • Mutates `signal.diagnostics.evaluation` in place, mirroring the
//     existing carryForwardGradedState mutation convention — never touches
//     any other field.

import type {
  PregamePowerMarket,
  PregamePowerSignal,
  PregameEvaluationRecord,
  PregameEvaluationSnapshot,
} from "./types";

export interface PopulationRank {
  holistic: number;
  byMarket: Partial<Record<PregamePowerMarket, number>>;
}

const RANKED_MARKETS: PregamePowerMarket[] = ["home_runs", "total_bases"];

/**
 * Deterministic tie-breaker: score descending, data-completeness descending,
 * signalId ascending. Applied identically to the holistic ranking and every
 * per-market ranking.
 */
function compareForRank(
  a: PregamePowerSignal,
  b: PregamePowerSignal,
  scoreA: number,
  scoreB: number,
): number {
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
export function computePopulationRanks(signals: PregamePowerSignal[]): Map<string, PopulationRank> {
  const result = new Map<string, PopulationRank>();
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

/** Construct the current-cycle snapshot for one candidate from its already-built champion state. */
export function buildEvaluationSnapshot(
  signal: PregamePowerSignal,
  rank: PopulationRank,
  buildId: string,
  candidatePoolSize: number,
  frozenAt: string,
): PregameEvaluationSnapshot {
  return {
    frozenAt,
    buildId,
    candidatePoolSize,
    champion: {
      score10: signal.score10,
      tier: signal.tier,
      componentScores: {
        batterPowerScore: signal.diagnostics.batterPowerScore,
        pitcherVulnerabilityScore: signal.diagnostics.pitcherVulnerabilityScore,
        matchupFitScore: signal.diagnostics.matchupFitScore,
        parkWeatherScore: signal.diagnostics.parkWeatherScore,
        lineupOpportunityScore: signal.diagnostics.lineupOpportunityScore,
        nearHrRecentFormScore: signal.diagnostics.nearHrRecentFormScore ?? null,
      },
      marketScores: signal.marketScores,
      drivers: signal.drivers,
      rank,
      dataCoverageScore: signal.diagnostics.dataCoverageScore,
      lineupStatus: signal.lineupStatus,
      weatherStatus: signal.weatherStatus,
      // Plate's real odds fetch (attachBestOddsDisplay, oddsDisplay.ts) only
      // ever runs for a signal's own primaryMarket, and is not currently
      // wired into the build cycle at all — honestly reflects "not fetched
      // at build time" rather than fabricating a line.
      postedLine: {
        market: signal.primaryMarket,
        line: null,
        lineUnavailableReason: "not_fetched_at_build_time",
        sourceTimestamp: null,
      },
    },
  };
}

export interface PregameTransition {
  becamePublicNow: boolean;
  instrumentationGapDetected: boolean;
  lockedForEvaluation: boolean;
  hadPriorSignal: boolean;
  hadPriorEvaluationField: boolean;
}

/**
 * Compares the REAL signal objects directly — never a derived snapshot.
 * `prevSignal === null` (a brand-new candidate) becoming public on its first
 * build IS a genuine observed transition and mints firstPublicSnapshot
 * normally. An instrumentation gap exists only when a previously-hydrated
 * signal was already publicly flagged with no frozen firstPublicSnapshot on
 * record.
 */
export function detectTransition(
  fresh: PregamePowerSignal,
  prev: PregamePowerSignal | undefined,
): PregameTransition {
  const hadPriorSignal = prev != null;
  const priorEvaluation = prev?.diagnostics?.evaluation;
  const hadPriorEvaluationField = priorEvaluation !== undefined;
  const previouslyPublic = prev?.everPubliclyFlagged === true;
  const becamePublicNow = fresh.everPubliclyFlagged === true && !previouslyPublic;
  const instrumentationGapDetected =
    hadPriorSignal && previouslyPublic && (priorEvaluation == null || priorEvaluation.firstPublicSnapshot == null);
  const lockedForEvaluation =
    fresh.status === "locked" || fresh.status === "graded" || fresh.firstPitchLockEligible === false;
  return { becamePublicNow, instrumentationGapDetected, lockedForEvaluation, hadPriorSignal, hadPriorEvaluationField };
}

/**
 * Freeze/carry rules: mint firstPublicSnapshot once on a genuine transition;
 * refresh finalPregameSnapshot every pre-lock cycle; freeze both permanently
 * once locked. No post-lock rebuild may modify either snapshot.
 */
export function applySnapshotLifecycle(
  prevEvaluation: PregameEvaluationRecord | null,
  currentSnapshot: PregameEvaluationSnapshot,
  transition: PregameTransition,
): PregameEvaluationRecord {
  let firstPublicSnapshot = prevEvaluation?.firstPublicSnapshot ?? null;
  let firstPublicUnavailableReason: PregameEvaluationRecord["firstPublicUnavailableReason"] =
    prevEvaluation?.firstPublicUnavailableReason ?? "not_yet_public";
  if (firstPublicSnapshot == null) {
    if (transition.becamePublicNow) {
      firstPublicSnapshot = currentSnapshot;
      firstPublicUnavailableReason = null;
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

  return { firstPublicSnapshot, firstPublicUnavailableReason, finalPregameSnapshot, finalPregameUnavailableReason };
}

/**
 * Orchestrator: rank the complete population, then for every candidate
 * construct/compare/freeze its evaluation record and stamp it onto
 * `signal.diagnostics.evaluation`. Call once per build cycle, after every
 * candidate for the cycle has been built (and after the existing
 * carryForwardGradedState pass), before persistence.
 */
export function applyEvaluationSnapshots(
  signals: Map<string, PregamePowerSignal>,
  prevSignals: Map<string, PregamePowerSignal> | null,
  buildId: string,
): void {
  const all = Array.from(signals.values());
  const ranks = computePopulationRanks(all);
  const frozenAt = new Date().toISOString();
  for (const fresh of all) {
    const prev = prevSignals?.get(fresh.signalId);
    const rank = ranks.get(fresh.signalId)!;
    const currentSnapshot = buildEvaluationSnapshot(fresh, rank, buildId, all.length, frozenAt);
    const transition = detectTransition(fresh, prev);
    const prevEvaluation = prev?.diagnostics?.evaluation ?? null;
    fresh.diagnostics.evaluation = applySnapshotLifecycle(prevEvaluation, currentSnapshot, transition);
  }
}
