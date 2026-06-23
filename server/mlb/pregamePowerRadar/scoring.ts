// Pre-Game Power Radar — composite scoring (single 0–10 scale).
//
// Exact operation order (BvP can never beat a coverage cap):
//   baseScore        = weighted component scores
//   bvpAdjustedScore = clamp(baseScore + bvpModifier, 0, 10)
//   cappedScore      = applyCoverageCaps(bvpAdjustedScore, flags)   // AFTER BvP
//   score10          = clamp(cappedScore, 0, 10)
//   tier             = tierFromScore(score10)
//   suppressedReasons= getSuppressionReasons(...)

import type { PregamePowerTier } from "./types";
import { clamp10, round1 } from "./scoreUtils";

export interface ScoringComponents {
  batterPowerScore: number;
  pitcherVulnerabilityScore: number;
  matchupFitScore: number;
  parkWeatherScore: number;
  lineupOpportunityScore: number;
  bvpModifier: number;
}

export interface ScoringFlags {
  batterPowerAvailable: boolean;
  pitcherProfileAvailable: boolean;
  confirmedLineup: boolean;
  parkAvailable: boolean;
  weatherAvailable: boolean;
  bvpAvailable: boolean;
  parkIsOnlyPositiveDriver: boolean;
  positiveDriverCount: number;
}

export interface ScoringResult {
  baseScore: number;
  score10: number;
  tier: PregamePowerTier;
  dataCoverageScore: number;
  finalScoreCap?: number;
  suppressed: boolean;
  suppressedReasons: string[];
}

export const COMPONENT_WEIGHTS = {
  batterPower: 0.3,
  pitcherVulnerability: 0.25,
  matchupFit: 0.2,
  parkWeather: 0.15,
  lineupOpportunity: 0.1,
} as const;

/** Fixed data-coverage formula — do not invent another. Returns 0–1. */
export function computeDataCoverage(flags: ScoringFlags): number {
  return round1cov(
    (flags.batterPowerAvailable ? 0.35 : 0) +
      (flags.pitcherProfileAvailable ? 0.25 : 0) +
      (flags.confirmedLineup ? 0.2 : 0) +
      (flags.parkAvailable ? 0.1 : 0) +
      (flags.weatherAvailable ? 0.05 : 0) +
      (flags.bvpAvailable ? 0.05 : 0),
  );
}

function round1cov(v: number): number {
  return Math.round(v * 100) / 100;
}

export function tierFromScore(score10: number): PregamePowerTier {
  if (score10 >= 8.8) return "nuclear";
  if (score10 >= 7.5) return "elite";
  if (score10 >= 6.0) return "strong";
  if (score10 >= 4.0) return "watch";
  return "track";
}

export function composePregameScore(
  c: ScoringComponents,
  flags: ScoringFlags,
): ScoringResult {
  const baseScore = clamp10(
    c.batterPowerScore * COMPONENT_WEIGHTS.batterPower +
      c.pitcherVulnerabilityScore * COMPONENT_WEIGHTS.pitcherVulnerability +
      c.matchupFitScore * COMPONENT_WEIGHTS.matchupFit +
      c.parkWeatherScore * COMPONENT_WEIGHTS.parkWeather +
      c.lineupOpportunityScore * COMPONENT_WEIGHTS.lineupOpportunity,
  );

  const bvpAdjustedScore = clamp10(baseScore + c.bvpModifier);

  const dataCoverageScore = computeDataCoverage(flags);

  // ── Coverage caps (applied AFTER BvP — BvP can never beat a cap) ────────────
  let cap = 10;
  const suppressedReasons: string[] = [];

  if (!flags.batterPowerAvailable) {
    cap = Math.min(cap, 3.9);
    suppressedReasons.push("batter_power_missing");
  }
  if (!flags.pitcherProfileAvailable) {
    cap = Math.min(cap, 5.9);
  }
  if (!flags.confirmedLineup) {
    suppressedReasons.push("lineup_not_confirmed");
  }
  if (flags.parkIsOnlyPositiveDriver && !flags.weatherAvailable) {
    cap = Math.min(cap, 5.9);
  }
  if (dataCoverageScore < 0.6) {
    cap = Math.min(cap, 5.9);
  }

  const cappedScore = Math.min(bvpAdjustedScore, cap);
  const score10 = round1(clamp10(cappedScore));
  const tier = tierFromScore(score10);

  // ── Suppression (public eligibility) ────────────────────────────────────────
  if (flags.positiveDriverCount < 2) suppressedReasons.push("insufficient_drivers");
  if (score10 < 6.0) suppressedReasons.push("below_strong_threshold");

  const suppressed = suppressedReasons.length > 0;

  return {
    baseScore: round1(baseScore),
    score10,
    tier,
    dataCoverageScore,
    finalScoreCap: cap < 10 ? cap : undefined,
    suppressed,
    suppressedReasons,
  };
}
