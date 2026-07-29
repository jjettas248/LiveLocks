// Mound Radar V2 (shadow) — promotion readiness gate.
//
// A criteria CHECKER only — it does not promote anything, and nothing calls
// it automatically. Per CLAUDE.md Phase 2 doctrine: "Do not automatically
// replace production Mound with V2. V2 remains shadow-only until forward
// validation demonstrates sufficient [evidence]." This module defines what
// "sufficient" means as pure, testable thresholds so a future backtesting/
// grading pass (not built in this pass — see the module header note) has a
// concrete bar to evaluate graded V2 predictions against, rather than an
// unsupported/ad-hoc promotion decision.

export interface MoundV2PromotionEvidence {
  /** Count of graded, resolved V2 predictions the evidence below is computed from. */
  sampleSize: number;
  /** V2's calibration error minus production's (or a baseline forecast's) calibration error over the same graded sample. Negative/zero = V2 at least as well-calibrated. */
  strikeoutsCalibrationErrorDelta: number;
  /** V2's Brier score minus the baseline's. Negative/zero = V2 improves or matches. */
  strikeoutsBrierDelta: number;
  /** V2's log loss minus the baseline's. Negative/zero = V2 improves or matches. */
  strikeoutsLogLossDelta: number;
  /** Fraction of eligible starts for which V2 produced a usable (dataAvailable) distribution. */
  marketCoverage: number;
  /** True if evaluating/wiring V2 was ever observed to alter a frozen episode, primaryMarket, moundDirection, or any production settlement field. Any true value blocks promotion outright, regardless of the other four criteria. */
  settlementOrProvenanceRegressionDetected: boolean;
}

export const MOUND_V2_PROMOTION_THRESHOLDS = {
  minSampleSize: 200,
  maxCalibrationErrorDelta: 0,
  maxBrierDelta: 0,
  maxLogLossDelta: 0,
  minMarketCoverage: 0.8,
} as const;

export const MOUND_V2_PROMOTION_BLOCKERS = [
  "INSUFFICIENT_SAMPLE_SIZE",
  "CALIBRATION_NOT_IMPROVED",
  "BRIER_NOT_IMPROVED",
  "LOG_LOSS_NOT_IMPROVED",
  "INSUFFICIENT_MARKET_COVERAGE",
  "SETTLEMENT_OR_PROVENANCE_REGRESSION",
] as const;
export type MoundV2PromotionBlocker = (typeof MOUND_V2_PROMOTION_BLOCKERS)[number];

export interface MoundV2PromotionVerdict {
  readyForPromotion: boolean;
  blockers: MoundV2PromotionBlocker[];
}

export function evaluateMoundV2PromotionReadiness(evidence: MoundV2PromotionEvidence): MoundV2PromotionVerdict {
  const blockers: MoundV2PromotionBlocker[] = [];

  if (evidence.sampleSize < MOUND_V2_PROMOTION_THRESHOLDS.minSampleSize) blockers.push("INSUFFICIENT_SAMPLE_SIZE");
  if (evidence.strikeoutsCalibrationErrorDelta > MOUND_V2_PROMOTION_THRESHOLDS.maxCalibrationErrorDelta) blockers.push("CALIBRATION_NOT_IMPROVED");
  if (evidence.strikeoutsBrierDelta > MOUND_V2_PROMOTION_THRESHOLDS.maxBrierDelta) blockers.push("BRIER_NOT_IMPROVED");
  if (evidence.strikeoutsLogLossDelta > MOUND_V2_PROMOTION_THRESHOLDS.maxLogLossDelta) blockers.push("LOG_LOSS_NOT_IMPROVED");
  if (evidence.marketCoverage < MOUND_V2_PROMOTION_THRESHOLDS.minMarketCoverage) blockers.push("INSUFFICIENT_MARKET_COVERAGE");
  // Checked last but never suppressed by the others — a regression blocks
  // promotion even if every statistical criterion above is otherwise clean.
  if (evidence.settlementOrProvenanceRegressionDetected) blockers.push("SETTLEMENT_OR_PROVENANCE_REGRESSION");

  return { readyForPromotion: blockers.length === 0, blockers };
}
