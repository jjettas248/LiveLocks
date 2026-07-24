// Mound Radar — diagnostics rollups + public visibility predicate.
// Mirrors pregamePowerRadar/diagnostics.ts's role, own thresholds.

import type { MoundSignal, MoundRadarResponse, MoundEvaluationSnapshot } from "./types";
import { MOUND_PUBLISH_MIN_SCORE } from "./scoring";
import { buildMoundSettlementView } from "./moundOutcomeAttribution";
import { countPositiveMoundEvidenceFamilies } from "./evidenceFamilies";

// Driver chips remain useful display/analytics context, but they are no longer
// used as the public-quality evidence count. Context chips (Confirmed Starter,
// Confirmed Lineup) and correlated chips must not masquerade as independent
// predictive confirmation.
export function positiveMoundDrivers(signal: MoundSignal) {
  return signal.drivers.filter((d) => d.direction === "positive" && !d.key.startsWith("cr_"));
}

function predictiveEvidenceFamilyCount(signal: MoundSignal): number {
  return countPositiveMoundEvidenceFamilies({
    pitcherSkillScore: signal.diagnostics.pitcherSkillScore,
    opponentKProfileScore: signal.diagnostics.opponentKProfileScore,
    workloadScore: signal.diagnostics.workloadScore,
    runEnvironmentScore: signal.diagnostics.runEnvironmentScore,
    recentFormScore: signal.diagnostics.recentFormScore,
  });
}

/**
 * Intrinsic public-quality gate — "was this a publicly-surfaced Mound target,
 * flagged before first pitch?" Mirrors wasPubliclyFlaggedPregame's structure.
 */
export function wasPubliclyFlaggedMound(signal: MoundSignal): boolean {
  const tierEligible = signal.tier === "strong" || signal.tier === "elite" || signal.tier === "nuclear";

  return (
    signal.lineupStatus === "confirmed" &&
    tierEligible &&
    signal.score10 >= MOUND_PUBLISH_MIN_SCORE &&
    predictiveEvidenceFamilyCount(signal) >= 2 &&
    signal.diagnostics.dataCoverageScore >= 0.6 &&
    signal.diagnostics.rawInputsAvailable.pitcherSeasonStats === true &&
    signal.isOfficialPlay === false &&
    signal.isPregameTarget === true &&
    !signal.suppressed
  );
}

/**
 * Fade-track analog of wasPubliclyFlaggedMound — that predicate's tierEligible
 * check (strong/elite/nuclear only) structurally excludes "track" tier, so a
 * Fade Candidate signal can never satisfy it. "Was this shown as a Fade
 * Candidate before first pitch?" is exactly the same condition that gates the
 * "Fade Candidate" badge everywhere else (moundDirection === "fade").
 *
 * Deliberately does NOT check `!signal.suppressed` — composeMoundScore suppresses
 * every score below MOUND_PUBLISH_MIN_SCORE, and "track" tier is defined below
 * that bar. For Fade, a low score is the signal, not a data-quality failure.
 * computeMoundDirection's own fade branch requires real pitcher skill plus a
 * settlement baseline, which prevents missing-data artifacts from becoming fades.
 *
 * firstPitchLockEligible === true is still required so a first post-start build
 * can never mint a hindsight Fade. Once set pregame, carry-forward preserves it.
 */
export function wasPubliclyFlaggedMoundFade(signal: MoundSignal): boolean {
  return (
    signal.moundDirection === "fade" &&
    signal.firstPitchLockEligible === true &&
    signal.isOfficialPlay === false &&
    signal.isPregameTarget === true
  );
}

/** Frozen historical public-admission flag — Follow only. */
export function flaggedBeforeFirstPitchMound(signal: MoundSignal): boolean {
  return signal.everPubliclyFlagged === true;
}

/**
 * Final public-visibility predicate. Fade remains internally measured but is not
 * newly activated publicly by this PR; public Fade rollout is a separate product
 * decision. Follow retention continues off the durable frozen flag.
 */
export function isPublicMoundSignal(signal: MoundSignal): boolean {
  if (signal.gameStatus === "postponed") return false;
  if (signal.status === "expired") return false;

  const firstPitchPassed =
    signal.status === "graded" || signal.gameStatus === "live" || signal.gameStatus === "final";

  if (!firstPitchPassed) return wasPubliclyFlaggedMound(signal);

  return flaggedBeforeFirstPitchMound(signal) && (signal.status === "locked" || signal.status === "graded");
}

export interface MoundCoverageCounters {
  gamesScanned: number;
  pitchersEvaluated: number;
  starterCoverage: number;
  weatherCoverage: number;
  pitcherCoverage: number;
  lineupCoverage: number;
}

/** Omits only research-only raw contact instrumentation from public responses. */
function stripRawContactSnapshot(
  snapshot: MoundEvaluationSnapshot | null,
): MoundEvaluationSnapshot | null {
  if (!snapshot || snapshot.champion.rawContactSnapshot === undefined) return snapshot;
  const { rawContactSnapshot, ...restChampion } = snapshot.champion;
  return { ...snapshot, champion: restChampion };
}

function withoutResearchInstrumentation(signal: MoundSignal): MoundSignal {
  const evaluation = signal.diagnostics.evaluation;
  if (!evaluation) return signal;
  return {
    ...signal,
    diagnostics: {
      ...signal.diagnostics,
      evaluation: {
        ...evaluation,
        firstPublicSnapshot: stripRawContactSnapshot(evaluation.firstPublicSnapshot),
        finalPregameSnapshot: stripRawContactSnapshot(evaluation.finalPregameSnapshot),
      },
    },
  };
}

export function buildMoundResponse(
  date: string,
  buildId: string,
  generatedAt: string,
  source: MoundRadarResponse["source"],
  signals: MoundSignal[],
  counters: MoundCoverageCounters,
  includeSuppressed: boolean,
  includeResearchInstrumentation: boolean,
): MoundRadarResponse {
  const publicSignals = signals.filter(isPublicMoundSignal);
  const suppressedSignals = signals.filter((s) => !isPublicMoundSignal(s));

  const reasonCounts = new Map<string, number>();
  for (const s of suppressedSignals) {
    for (const r of s.suppressedReasons) {
      reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
    }
  }
  const topSuppressionReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const out = includeSuppressed ? signals : publicSignals;
  const outWithInstrumentation = includeResearchInstrumentation ? out : out.map(withoutResearchInstrumentation);

  // Stamp the public settlement-view contract fresh per response — never
  // persisted redundantly. Durable public flags, not outcome.userVisible, decide
  // whether a card was a genuine public recommendation.
  const withSettlementView = outWithInstrumentation.map((s) => ({
    ...s,
    settlementView: buildMoundSettlementView(
      s.outcomes,
      s.primaryMarket,
      s.moundDirection,
      s.everPubliclyFlagged,
      s.everPubliclyFlaggedFade,
    ),
  }));

  return {
    date,
    buildId,
    generatedAt,
    source,
    gamesScanned: counters.gamesScanned,
    signals: withSettlementView.slice().sort((a, b) => b.score10 - a.score10),
    diagnostics: {
      starterCoverage: counters.starterCoverage,
      weatherCoverage: counters.weatherCoverage,
      pitcherCoverage: counters.pitcherCoverage,
      lineupCoverage: counters.lineupCoverage,
      totalPitchersEvaluated: counters.pitchersEvaluated,
      publicSignals: publicSignals.length,
      suppressedSignals: suppressedSignals.length,
      topSuppressionReasons,
    },
  };
}
