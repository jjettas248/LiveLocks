// Mound Radar — diagnostics rollups + public visibility predicate.
// Mirrors pregamePowerRadar/diagnostics.ts's role, own thresholds.

import type { MoundSignal, MoundRadarResponse } from "./types";
import { MOUND_PUBLISH_MIN_SCORE } from "./scoring";

// contactRisk.ts's chips (cr_high/cr_low) are informational-only — like
// marketSetups, they must never affect suppression/publish gating, only
// what's displayed on the card. Excluded here (the sole gating use of this
// count) AND from buildMlbMoundRadar.ts's own positiveDriverCount, which
// independently computes the same count before it's stamped onto the signal.
export function positiveMoundDrivers(signal: MoundSignal) {
  return signal.drivers.filter((d) => d.direction === "positive" && !d.key.startsWith("cr_"));
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
    positiveMoundDrivers(signal).length >= 2 &&
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
 * "Fade Candidate" badge everywhere else (moundDirection === "fade"), plus
 * the same non-suppressed/non-official/pregame-target guards
 * wasPubliclyFlaggedMound applies.
 *
 * firstPitchLockEligible === true (gameStatus scheduled/pre) is REQUIRED —
 * this predicate is called with no `prev` signal for a game's first-ever
 * build (server restart, a delayed build, or an earlier unresolved gamePk),
 * and without this guard a build that first evaluates a pitcher AFTER the
 * game already went live/final would flag him as a Fade candidate using
 * hindsight (final box score) data, even though nothing was ever shown to a
 * user before first pitch. Once legitimately set true pre-game, the flag
 * still survives into live/final builds via carryForwardMoundGradedState's
 * OR — this guard only blocks a flag being MINTED post-first-pitch with no
 * prior true value to inherit.
 */
export function wasPubliclyFlaggedMoundFade(signal: MoundSignal): boolean {
  return (
    signal.moundDirection === "fade" &&
    signal.firstPitchLockEligible === true &&
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
