// Pre-Game Power Radar — diagnostics rollups + public visibility predicate.

import type { PregamePowerSignal, PregamePowerRadarResponse } from "./types";

/** Derived helper: positive drivers on a signal. */
export function positiveDrivers(signal: PregamePowerSignal) {
  return signal.drivers.filter((d) => d.direction === "positive");
}

/** Derived helper: whether the batter power profile was available. */
export function batterPowerAvailable(signal: PregamePowerSignal): boolean {
  return signal.diagnostics.rawInputsAvailable.batterPower === true;
}

/**
 * Final public-visibility predicate. Public surfaces only confirmed-lineup,
 * non-suppressed, strong+ targets. Live games show only locked rows.
 */
export function isPublicPregameSignal(signal: PregamePowerSignal): boolean {
  const base =
    signal.lineupStatus === "confirmed" &&
    (signal.status === "active" || signal.status === "locked") &&
    signal.score10 >= 6.0 &&
    positiveDrivers(signal).length >= 2 &&
    signal.diagnostics.dataCoverageScore >= 0.6 &&
    signal.diagnostics.rawInputsAvailable.batterPower === true &&
    signal.gameStatus !== "final" &&
    signal.gameStatus !== "postponed" &&
    signal.isOfficialPlay === false &&
    signal.isPregameTarget === true &&
    !signal.suppressed;

  if (!base) return false;
  if (signal.gameStatus === "live") return signal.status === "locked";
  return true;
}

export interface CoverageCounters {
  gamesScanned: number;
  battersEvaluated: number;
  lineupCoverage: number;
  weatherCoverage: number;
  batterCoverage: number;
  pitcherCoverage: number;
}

export function buildResponse(
  date: string,
  buildId: string,
  generatedAt: string,
  source: PregamePowerRadarResponse["source"],
  signals: PregamePowerSignal[],
  counters: CoverageCounters,
  includeSuppressed: boolean,
): PregamePowerRadarResponse {
  const publicSignals = signals.filter(isPublicPregameSignal);
  const suppressedSignals = signals.filter((s) => !isPublicPregameSignal(s));

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
      lineupCoverage: counters.lineupCoverage,
      weatherCoverage: counters.weatherCoverage,
      batterCoverage: counters.batterCoverage,
      pitcherCoverage: counters.pitcherCoverage,
      totalBattersEvaluated: counters.battersEvaluated,
      publicSignals: publicSignals.length,
      suppressedSignals: suppressedSignals.length,
      topSuppressionReasons,
    },
  };
}
