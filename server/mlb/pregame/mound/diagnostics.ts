// Mound Radar — diagnostics rollups + public visibility predicate.
// Mirrors pregamePowerRadar/diagnostics.ts's role, own thresholds.

import type { MoundSignal, MoundRadarResponse } from "./types";

export function positiveMoundDrivers(signal: MoundSignal) {
  return signal.drivers.filter((d) => d.direction === "positive");
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
    signal.score10 >= 6.0 &&
    positiveMoundDrivers(signal).length >= 2 &&
    signal.diagnostics.dataCoverageScore >= 0.6 &&
    signal.diagnostics.rawInputsAvailable.pitcherSeasonStats === true &&
    signal.isOfficialPlay === false &&
    signal.isPregameTarget === true &&
    !signal.suppressed
  );
}

/** Final public-visibility predicate. Mirrors isPublicPregameSignal's structure. */
export function isPublicMoundSignal(signal: MoundSignal): boolean {
  const flaggedNow = wasPubliclyFlaggedMound(signal);
  const flagged = signal.status === "graded" ? flaggedNow || signal.everPubliclyFlagged : flaggedNow;
  if (!flagged) return false;
  if (signal.status === "graded" && signal.outcomes?.outcome === "mound_win") return true;
  if (signal.status !== "active" && signal.status !== "locked") return false;
  if (signal.gameStatus === "final" || signal.gameStatus === "postponed") return false;
  if (signal.gameStatus === "live") return signal.status === "locked";
  return true;
}

export interface MoundCoverageCounters {
  gamesScanned: number;
  pitchersEvaluated: number;
  starterCoverage: number;
  weatherCoverage: number;
  pitcherCoverage: number;
  lineupCoverage: number;
}

export function buildMoundResponse(
  date: string,
  buildId: string,
  generatedAt: string,
  source: MoundRadarResponse["source"],
  signals: MoundSignal[],
  counters: MoundCoverageCounters,
  includeSuppressed: boolean,
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

  return {
    date,
    buildId,
    generatedAt,
    source,
    gamesScanned: counters.gamesScanned,
    signals: out.slice().sort((a, b) => b.score10 - a.score10),
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
