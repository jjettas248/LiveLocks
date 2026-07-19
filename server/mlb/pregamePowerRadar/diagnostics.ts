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
 * Intrinsic public-quality gates, independent of live/final game status.
 *
 * Answers "was this a publicly-surfaced pre-game target, flagged before first
 * pitch?" — the question Win Attribution must ask at grading time, when the
 * game is already `final` (so the live-status gates in `isPublicPregameSignal`
 * no longer apply). A pregame win is only `userVisible` when this is true.
 */
export function wasPubliclyFlaggedPregame(signal: PregamePowerSignal): boolean {
  // Tier gate: surface only strong+ setups and `power_watch` (Batter Power Only)
  // candidates — never bare `watch`/`track`.
  const tierEligible =
    signal.tier === "power_watch" ||
    signal.tier === "strong" ||
    signal.tier === "elite" ||
    signal.tier === "nuclear";

  return (
    signal.lineupStatus === "posted" &&
    tierEligible &&
    signal.score10 >= 6.0 &&
    positiveDrivers(signal).length >= 2 &&
    signal.diagnostics.dataCoverageScore >= 0.6 &&
    signal.diagnostics.rawInputsAvailable.batterPower === true &&
    signal.isOfficialPlay === false &&
    signal.isPregameTarget === true &&
    !signal.suppressed
  );
}

/**
 * Frozen historical public-admission flag. Reads the durable `everPubliclyFlagged`
 * value (set once pre-first-pitch, OR-forwarded across rebuilds and DB-hydrated by
 * `carryForwardGradedState` + storage's SQL `OR`-upsert), NEVER a live re-evaluation
 * of mutable fields. This is the basis for **retained visibility** and for
 * historical/calibration counts: a target genuinely public before first pitch stays
 * counted/visible for the rest of the slate regardless of later mutable dips or its
 * win/miss outcome. `wasPubliclyFlaggedPregame` (which re-evaluates live fields) is
 * used ONLY for the initial pre-first-pitch eligibility question, never for retention.
 */
export function flaggedBeforeFirstPitchPregame(signal: PregamePowerSignal): boolean {
  return signal.everPubliclyFlagged === true;
}

/**
 * Final public-visibility predicate — one shared lifecycle principle, no per-outcome
 * exceptions. Two orthogonal questions:
 *
 *   1. INITIAL public eligibility (pre-first-pitch): may a signal surface for the
 *      first time? Answered by the intrinsic quality gate `wasPubliclyFlaggedPregame`.
 *      Unchanged — this pass never alters candidate volume or the eligibility bar.
 *   2. RETAINED visibility (first pitch has passed): does an already-publicly-surfaced,
 *      first-pitch-locked target stay on today's board through slate rollover? Answered
 *      by the durable frozen flag `flaggedBeforeFirstPitchPregame` + a locked/graded
 *      status — win OR miss, graded or not. A graded miss now stays visible (it moves
 *      into the Completed section rather than being deleted). Cold-start minting of the
 *      frozen flag is blocked in `gradedStateCarry.ts` (requires firstPitchLockEligible),
 *      so retention can never surface a signal never shown before first pitch.
 *
 * `status === "graded"` implies first pitch has passed (a signal only grades once its
 * game is live/final), so it always routes to retention regardless of `gameStatus`.
 */
export function isPublicPregameSignal(signal: PregamePowerSignal): boolean {
  if (signal.gameStatus === "postponed") return false;
  if (signal.status === "expired") return false;

  const firstPitchPassed =
    signal.status === "graded" ||
    signal.gameStatus === "live" ||
    signal.gameStatus === "final" ||
    signal.gameStatus === "suspended";

  // Pre-first-pitch: INITIAL public eligibility (unchanged intrinsic gate).
  if (!firstPitchPassed) return wasPubliclyFlaggedPregame(signal);

  // First pitch has passed: RETENTION off the durable frozen flag only.
  return flaggedBeforeFirstPitchPregame(signal) && (signal.status === "locked" || signal.status === "graded");
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
