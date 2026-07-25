// Pre-Game Power Radar — diagnostics rollups + public visibility predicate.

import type { PregamePowerSignal, PregamePowerRadarResponse } from "./types";
import { countPositivePregameEvidenceFamilies } from "./evidenceFamilies";
import { PLATE_CHAMPION_POLICY } from "./modelVersions/plateChampionJul20";
import { countPositiveDrivers, driverKeysForUniverse } from "./modelVersions/plateDriverUniverse";
import {
  decidePlatePublication,
  type PlatePublicationInput,
} from "./modelVersions/platePublicationDecision";

/** Derived helper: positive drivers on a signal (display/analytics only). */
export function positiveDrivers(signal: PregamePowerSignal) {
  return signal.drivers.filter((d) => d.direction === "positive");
}

/** Derived helper: whether the batter power profile was available. */
export function batterPowerAvailable(signal: PregamePowerSignal): boolean {
  return signal.diagnostics.rawInputsAvailable.batterPower === true;
}

/**
 * Independent evidence families on a persisted signal. Retained and exported
 * for the shadow/admin comparison layer — it is NOT the champion's publication
 * gate (see `wasPubliclyFlaggedPregame` below).
 */
export function predictiveEvidenceFamilyCount(signal: PregamePowerSignal): number {
  return countPositivePregameEvidenceFamilies({
    batterPowerScore: signal.diagnostics.batterPowerScore,
    pitcherVulnerabilityScore: signal.diagnostics.pitcherVulnerabilityScore,
    matchupFitScore: signal.diagnostics.matchupFitScore,
    parkWeatherScore: signal.diagnostics.parkWeatherScore,
    lineupOpportunityScore: signal.diagnostics.lineupOpportunityScore,
    nearHrRecentFormScore: signal.diagnostics.nearHrRecentFormScore ?? null,
  });
}

/**
 * Intrinsic public-quality gates, independent of live/final game status.
 *
 * Answers "was this a publicly-surfaced pre-game target, flagged before first
 * pitch?" — the question Win Attribution must ask at grading time, when the
 * game is already `final` (so the live-status gates in `isPublicPregameSignal`
 * no longer apply). A pregame win is only `userVisible` when this is true.
 */
export function buildChampionPublicationInput(signal: PregamePowerSignal): PlatePublicationInput {
  return {
    tier: signal.tier,
    score10: signal.score10,
    suppressed: signal.suppressed,
    // Counted against the CHAMPION's July-20 driver universe. This matters
    // here specifically: `signal.drivers` is the post-assembly array, so it
    // already contains the `atkenv_*` tags appended after scoring. Restricting
    // to the July-20 keys is what stops a zero-weight research tag from
    // satisfying the two-driver minimum at read time.
    positiveDriverCount: countPositiveDrivers(
      signal.drivers,
      driverKeysForUniverse(PLATE_CHAMPION_POLICY.drivers.universe),
    ),
    evidenceFamilyCount: predictiveEvidenceFamilyCount(signal),
    dataCoverageScore: signal.diagnostics.dataCoverageScore,
    batterPowerAvailable: signal.diagnostics.rawInputsAvailable.batterPower === true,
    lineupStatus: signal.lineupStatus,
    isOfficialPlay: signal.isOfficialPlay,
    isPregameTarget: signal.isPregameTarget,
  };
}

export function wasPubliclyFlaggedPregame(signal: PregamePowerSignal): boolean {
  // Thin adapter — this function owns NO gate logic. `decidePlatePublication`
  // is the single authority for what "public" means, so the read-time predicate
  // and the build-time model evaluation cannot drift apart.
  return decidePlatePublication(buildChampionPublicationInput(signal), PLATE_CHAMPION_POLICY)
    .publicEligible;
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

  // Pre-first-pitch: INITIAL public eligibility.
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
