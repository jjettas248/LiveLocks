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
import { ATTACK_ENVIRONMENT_THRESHOLDS } from "./attackEnvironment";
import type { AttackEnvironmentTier } from "./attackEnvironment";

export interface ScoringComponents {
  batterPowerScore: number;
  pitcherVulnerabilityScore: number;
  matchupFitScore: number;
  parkWeatherScore: number;
  lineupOpportunityScore: number;
  nearHrRecentFormScore: number;
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
  // ── Matchup-quality context (optional; default neutral/unavailable) ─────────
  /** Direction of the batter-vs-pitcher history. */
  bvpDirection?: "positive" | "neutral" | "negative";
  /** 5+ AB with ≥2 key BvP production fields at .000 (hard block on clean Elite). */
  bvpZeroProduction?: boolean;
  /** Pitcher's allowed production to the batter's slot. */
  pitcherOrderSplitDirection?: "vulnerable" | "neutral" | "suppressive" | "unavailable";
  /** Batter's own production from today's lineup slot. */
  batterOrderSplitDirection?: "strong" | "neutral" | "weak" | "unavailable";
  // ── Attack Environment (pitcher × park/weather × matchup-fit interaction) ────
  /** Gate only — never adds/subtracts from score10. See classifyTier. */
  attackEnvironmentTier: AttackEnvironmentTier;
  /** Already-computed by computeAttackEnvironment() (includes the
   *  independently-elite override) — must NOT be re-derived here. */
  attackEnvironmentEliminationEligible: boolean;
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
  /** Machine-readable downgrade reasons (one per applied penalty source). */
  downgradeReasons: string[];
}

/** Minimum published composite score. */
export const PUBLISH_MIN_SCORE = 6.0;

/**
 * Gated public tier. "Elite Setup" REQUIRES both batter power AND positive
 * pitcher evidence — high batter power alone can only reach `power_watch`
 * ("Batter Power Only"). A negative BvP history blocks the elite/nuclear tiers.
 *
 * Attack Environment gate (added on top, never a numeric change to score10):
 *   • "elite"/"nuclear" additionally require FAVORABLE-or-better Attack
 *     Environment (pitcher vulnerability + park/weather + matchup fit all
 *     aligned for this batter — not just raw batter power).
 *   • "nuclear" additionally requires ELITE (the full three-way alignment).
 *   • HOSTILE never appears in this gate — its thresholds
 *     (pitcherVulnerabilityScore < 5.0) can never satisfy the >= 6.0 gate below
 *     in the first place, so it has no effect here; its only behavioral effect
 *     is the borderline-suppression rule in composePregameScore.
 */
export function classifyTier(
  score10: number,
  batterPowerScore: number,
  pitcherVulnerabilityScore: number,
  eliteBlocked: boolean,
  attackEnvironmentTier: AttackEnvironmentTier,
): PregamePowerTier {
  // Power-only: elite raw power but a weak pitcher matchup → never an elite setup.
  if (batterPowerScore >= 7.0 && pitcherVulnerabilityScore < 5.5) return "power_watch";
  if (
    score10 >= 8.8 && batterPowerScore >= 7.0 && pitcherVulnerabilityScore >= 6.0 &&
    attackEnvironmentTier === "ELITE" && !eliteBlocked
  ) return "nuclear";
  if (
    score10 >= 7.3 && batterPowerScore >= 7.0 && pitcherVulnerabilityScore >= 6.0 &&
    (attackEnvironmentTier === "ELITE" || attackEnvironmentTier === "FAVORABLE") &&
    !eliteBlocked
  ) return "elite";
  if (score10 >= 6.8 && batterPowerScore >= 6.7 && pitcherVulnerabilityScore >= 5.5) return "strong";
  // Gates not met: cap at "strong" max so a high raw score can never label elite.
  if (score10 >= PUBLISH_MIN_SCORE) return "strong";
  if (score10 >= 4.0) return "watch";
  return "track";
}

export const COMPONENT_WEIGHTS = {
  batterPower: 0.28,
  pitcherVulnerability: 0.23,
  matchupFit: 0.18,
  parkWeather: 0.14,
  lineupOpportunity: 0.09,
  nearHrRecentForm: 0.08,
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
      c.lineupOpportunityScore * COMPONENT_WEIGHTS.lineupOpportunity +
      c.nearHrRecentFormScore * COMPONENT_WEIGHTS.nearHrRecentForm,
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

  // ── Matchup penalty (visible) + elite gate ──────────────────────────────────
  // Three matchup layers downgrade the score AND (via classifyTier) block elite
  // labeling, so batter power is never enough on its own to mint "Elite Setup":
  //   1. pitcher vs the batter's lineup slot (allowed-by-slot)
  //   2. batter's own production from today's slot
  //   3. batter-vs-pitcher (BvP) history, incl. the zero-production rule
  const bvpDirection = flags.bvpDirection ?? "neutral";
  const bvpZeroProduction = flags.bvpZeroProduction ?? false;
  const pitcherOrderSplitDirection = flags.pitcherOrderSplitDirection ?? "unavailable";
  const batterOrderSplitDirection = flags.batterOrderSplitDirection ?? "unavailable";

  const downgradeReasons: string[] = [];
  const warningTags: string[] = [];
  let matchupPenalty = 0;

  if (c.pitcherVulnerabilityScore < 5) {
    matchupPenalty += (5 - c.pitcherVulnerabilityScore) * 0.2;
    downgradeReasons.push("weak_pitcher_vulnerability");
  }
  if (pitcherOrderSplitDirection === "suppressive") {
    matchupPenalty += 0.8;
    downgradeReasons.push("pitcher_slot_suppression");
    warningTags.push("Pitcher Slot Suppression");
  }
  if (batterOrderSplitDirection === "weak") {
    matchupPenalty += 0.5;
    downgradeReasons.push("weak_from_lineup_slot");
    warningTags.push("Weak From Lineup Slot");
  }
  if (bvpZeroProduction) {
    matchupPenalty += 0.6;
    downgradeReasons.push("bvp_zero_production");
    warningTags.push("Poor BvP History");
  } else if (bvpDirection === "negative") {
    matchupPenalty += 0.4;
    downgradeReasons.push("bvp_negative");
    warningTags.push("Poor BvP History");
  }
  matchupPenalty = round1(Math.min(matchupPenalty, 2.5));

  // Elite is blocked by any meaningful pitcher/order/BvP downgrade OR a weak slot
  // context (Elite requires favorable/neutral slot context + no downgrade).
  const eliteBlocked =
    bvpDirection === "negative" ||
    bvpZeroProduction ||
    pitcherOrderSplitDirection === "suppressive" ||
    batterOrderSplitDirection === "weak";

  const score10 = round1(clamp10(cappedScore - matchupPenalty));
  const tier = classifyTier(
    score10,
    c.batterPowerScore,
    c.pitcherVulnerabilityScore,
    eliteBlocked,
    flags.attackEnvironmentTier,
  );

  // ── Downgrade tags (UI / debug) ─────────────────────────────────────────────
  if (matchupPenalty > 0 || eliteBlocked) warningTags.push("Matchup Downgrade");
  if (tier === "power_watch") warningTags.push("Batter Power Only");
  if (!flags.pitcherProfileAvailable) warningTags.push("Needs Live Confirmation");

  // ── Suppression (public eligibility) ────────────────────────────────────────
  // Hard suppression is reserved for FATAL missing data (handled by the caller
  // for no-lineup / no-batter-identity / no-pitcher / postponed). Here:
  if (!flags.pitcherProfileAvailable) suppressedReasons.push("missing_pitcher_splits");
  if (flags.positiveDriverCount < 2) suppressedReasons.push("insufficient_drivers");

  // Attack Environment HOSTILE elimination — the ONLY behavioral effect HOSTILE
  // has anywhere. Must run AFTER every other suppressedReasons push above (a card
  // already suppressed for another reason wasn't "eliminated by Attack
  // Environment") and BEFORE the final PUBLISH_MIN_SCORE check (a card below the
  // publish floor was never going to publish regardless of this feature).
  // `attackEnvironmentEliminationEligible` already encodes the independently-elite
  // override computed once by computeAttackEnvironment() — never re-derived here.
  const otherwisePublishable = suppressedReasons.length === 0 && score10 >= PUBLISH_MIN_SCORE;
  if (
    flags.attackEnvironmentEliminationEligible &&
    otherwisePublishable &&
    score10 < ATTACK_ENVIRONMENT_THRESHOLDS.borderlineScore
  ) {
    suppressedReasons.push("attack_environment_hostile_borderline");
  }

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
    downgradeReasons,
  };
}
