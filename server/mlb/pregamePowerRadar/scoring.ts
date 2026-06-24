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
  // ── Matchup-quality context (optional; default neutral/unknown) ──────────────
  /** Direction of the batter-vs-pitcher history. */
  bvpDirection?: "positive" | "neutral" | "negative";
  /** Direction of the pitcher's batting-order-slot split. */
  orderSplitDirection?: "vulnerable" | "neutral" | "suppressive" | "unknown";
}

export interface ScoringResult {
  baseScore: number;
  /** Weighted composite + BvP modifier, BEFORE coverage caps / matchup penalty. */
  finalScoreBeforeCaps: number;
  score10: number;
  /** Visible penalty applied for a weak/negative pitcher matchup or BvP. */
  matchupPenalty: number;
  tier: PregamePowerTier;
  dataCoverageScore: number;
  finalScoreCap?: number;
  suppressed: boolean;
  suppressedReasons: string[];
  /** Human-readable downgrade tags surfaced to the UI / debug. */
  warningTags: string[];
}

/** Minimum published composite score. */
export const PUBLISH_MIN_SCORE = 6.0;

/**
 * Gated public tier. "Elite Setup" REQUIRES both batter power AND a positive
 * pitcher matchup — high batter power alone can only reach `power_watch`
 * ("Batter Power Only"). A negative BvP/order-split blocks the elite/nuclear/
 * clean-strong tiers.
 */
export function classifyTier(
  score10: number,
  batterPowerScore: number,
  pitcherVulnerabilityScore: number,
  negativeMatchup: boolean,
): PregamePowerTier {
  // Power-only: elite raw power but a weak pitcher matchup → never an elite setup.
  if (batterPowerScore >= 7.0 && pitcherVulnerabilityScore < 5.5) return "power_watch";
  if (score10 >= 8.8 && batterPowerScore >= 7.0 && pitcherVulnerabilityScore >= 6.0 && !negativeMatchup) return "nuclear";
  if (score10 >= 7.3 && batterPowerScore >= 7.0 && pitcherVulnerabilityScore >= 6.0 && !negativeMatchup) return "elite";
  if (score10 >= 6.8 && batterPowerScore >= 6.7 && pitcherVulnerabilityScore >= 5.5) return "strong";
  // Gates not met: cap at "strong" max so a high raw score can never label elite.
  if (score10 >= PUBLISH_MIN_SCORE) return "strong";
  if (score10 >= 4.0) return "watch";
  return "track";
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

  // ── Matchup penalty (visible) ───────────────────────────────────────────────
  // A weak pitcher matchup or bearish BvP/order-split downgrades the score AND
  // (via classifyTier) blocks elite labeling. This is the orientation fix: the
  // pitcher's strength is never read as the hitter's opportunity.
  const bvpDirection = flags.bvpDirection ?? "neutral";
  const orderSplitDirection = flags.orderSplitDirection ?? "unknown";
  const negativeMatchup = bvpDirection === "negative" || orderSplitDirection === "suppressive";

  let matchupPenalty = 0;
  if (c.pitcherVulnerabilityScore < 5) matchupPenalty += (5 - c.pitcherVulnerabilityScore) * 0.2;
  if (bvpDirection === "negative") matchupPenalty += 0.4;
  if (orderSplitDirection === "suppressive") matchupPenalty += 0.8;
  matchupPenalty = round1(Math.min(matchupPenalty, 2.5));

  const score10 = round1(clamp10(cappedScore - matchupPenalty));
  const tier = classifyTier(score10, c.batterPowerScore, c.pitcherVulnerabilityScore, negativeMatchup);

  // ── Downgrade tags (UI / debug) ─────────────────────────────────────────────
  const warningTags: string[] = [];
  if (orderSplitDirection === "suppressive") warningTags.push("Pitcher Slot Suppression");
  if (bvpDirection === "negative") warningTags.push("Poor BvP History");
  if (matchupPenalty > 0 || negativeMatchup) warningTags.push("Matchup Downgrade");
  if (tier === "power_watch") warningTags.push("Batter Power Only");
  if (!flags.pitcherProfileAvailable) warningTags.push("Needs Live Confirmation");

  // ── Suppression (public eligibility) ────────────────────────────────────────
  // Hard suppression is reserved for FATAL missing data (handled by the caller
  // for no-lineup / no-batter-identity / no-pitcher / postponed). Here:
  if (!flags.pitcherProfileAvailable) suppressedReasons.push("missing_pitcher_splits");
  if (flags.positiveDriverCount < 2) suppressedReasons.push("insufficient_drivers");
  if (score10 < PUBLISH_MIN_SCORE) {
    // Distinguish "held down by a data-quality cap" from "genuinely weak with full data".
    suppressedReasons.push(cap < 10 ? "capped_by_data_quality" : "below_threshold_after_full_data");
  }

  const suppressed = suppressedReasons.length > 0;

  return {
    baseScore: round1(baseScore),
    finalScoreBeforeCaps: round1(clamp10(bvpAdjustedScore)),
    score10,
    matchupPenalty,
    tier,
    dataCoverageScore,
    finalScoreCap: cap < 10 ? cap : undefined,
    suppressed,
    suppressedReasons,
    warningTags,
  };
}
