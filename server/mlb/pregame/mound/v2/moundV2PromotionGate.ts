// Mound Radar V2 (shadow) — promotion readiness gate.
//
// A criteria CHECKER only — it does not promote anything, and nothing calls
// it automatically. Per CLAUDE.md Phase 2 doctrine: "Do not automatically
// replace production Mound with V2. V2 remains shadow-only until forward
// validation demonstrates sufficient [evidence]." This module defines what
// "sufficient" means as pure, testable thresholds so a future backtesting/
// grading pass has a concrete bar to evaluate graded V2 predictions
// against, rather than an unsupported/ad-hoc promotion decision.
//
// Correction 1: requires BOTH criteria families below, always. Neither one
// alone is sufficient, and neither is ever presented as "V2 beats V1" on a
// probability metric — V1 has no probability (score10 is a matchup-quality
// composite, never a probability, CLAUDE.md §3.9), so probabilityComparator
// names the actual non-V1 reference every probability delta is computed
// against (climatology or a de-vigged market-implied price). Decision-policy
// non-inferiority against V1 is a SEPARATE, second criteria family, scored
// on real captured-price win rate and ROI over the paired population — not
// a probability metric at all.

export interface MoundV2PromotionEvidence {
  /** Which non-V1 reference every probability delta below is computed against — never V1 itself. */
  probabilityComparator: "climatology" | "market_implied";
  /** Count of graded, resolved V2 predictions the probability evidence is computed from. */
  sampleSize: number;
  /** V2's calibration error minus probabilityComparator's, over the SAME sample. Negative/zero = V2 at least as well-calibrated. */
  calibrationErrorDelta: number;
  /** V2's Brier score minus probabilityComparator's. Negative/zero = V2 improves or matches. */
  brierDelta: number;
  /** V2's log loss minus probabilityComparator's. Negative/zero = V2 improves or matches. */
  logLossDelta: number;
  /** Fraction of eligible starts for which V2 produced a usable (dataAvailable) distribution. */
  marketCoverage: number;

  /** Count of rows where BOTH V1 (real recommended side + real captured price) and V2 (graded with a real line) have a gradeable decision — the population winRateDelta/roiDelta are computed over. Excludes legacy rows (see below) and rows where V1 had no recommendation. */
  decisionPolicyPairedN: number;
  /** Rows excluded because they predate v1RecommendedSide capture entirely (an old contractVersion) — never silently blended into decisionPolicyPairedN as if V1 "had no recommendation" on them. */
  decisionPolicyLegacyIncompleteCount: number;
  /** V2's win rate minus V1's, over decisionPolicyPairedN only. Null if either side has no decided (non-push) sample. */
  winRateDelta: number | null;
  /** V2's captured-price ROI minus V1's, over decisionPolicyPairedN only. Null if either side has no roi-eligible (real captured price) sample. */
  roiDelta: number | null;

  /** True if evaluating/wiring V2 was ever observed to alter a frozen episode, primaryMarket, moundDirection, or any production settlement field. Any true value blocks promotion outright, regardless of every other criterion. */
  settlementOrProvenanceRegressionDetected: boolean;
}

export const MOUND_V2_PROMOTION_THRESHOLDS = {
  minSampleSize: 200,
  maxCalibrationErrorDelta: 0,
  maxBrierDelta: 0,
  maxLogLossDelta: 0,
  minMarketCoverage: 0.8,
  minDecisionPolicyPairedN: 100,
  /** V2's win rate may trail V1's by at most this much and still count "non-inferior" — 0 would require V2 to strictly match or beat V1. */
  minWinRateDelta: -0.02,
  /** V2's ROI may trail V1's by at most this many units-per-bet and still count "non-inferior". */
  minRoiDelta: -0.02,
} as const;

export const MOUND_V2_PROMOTION_BLOCKERS = [
  "INSUFFICIENT_SAMPLE_SIZE",
  "CALIBRATION_NOT_IMPROVED",
  "BRIER_NOT_IMPROVED",
  "LOG_LOSS_NOT_IMPROVED",
  "INSUFFICIENT_MARKET_COVERAGE",
  "INSUFFICIENT_PAIRED_DECISION_POLICY_SAMPLE",
  "DECISION_POLICY_WIN_RATE_NOT_NON_INFERIOR",
  "DECISION_POLICY_ROI_NOT_NON_INFERIOR",
  "SETTLEMENT_OR_PROVENANCE_REGRESSION",
] as const;
export type MoundV2PromotionBlocker = (typeof MOUND_V2_PROMOTION_BLOCKERS)[number];

export interface MoundV2PromotionVerdict {
  readyForPromotion: boolean;
  blockers: MoundV2PromotionBlocker[];
  /** Restates which comparator the probability-quality criteria were checked against — so a verdict can never be read out of context as "vs V1". */
  probabilityComparator: "climatology" | "market_implied";
}

export function evaluateMoundV2PromotionReadiness(evidence: MoundV2PromotionEvidence): MoundV2PromotionVerdict {
  const blockers: MoundV2PromotionBlocker[] = [];

  // Criterion family 1: absolute V2 probability quality vs the named comparator.
  if (evidence.sampleSize < MOUND_V2_PROMOTION_THRESHOLDS.minSampleSize) blockers.push("INSUFFICIENT_SAMPLE_SIZE");
  if (evidence.calibrationErrorDelta > MOUND_V2_PROMOTION_THRESHOLDS.maxCalibrationErrorDelta) blockers.push("CALIBRATION_NOT_IMPROVED");
  if (evidence.brierDelta > MOUND_V2_PROMOTION_THRESHOLDS.maxBrierDelta) blockers.push("BRIER_NOT_IMPROVED");
  if (evidence.logLossDelta > MOUND_V2_PROMOTION_THRESHOLDS.maxLogLossDelta) blockers.push("LOG_LOSS_NOT_IMPROVED");
  if (evidence.marketCoverage < MOUND_V2_PROMOTION_THRESHOLDS.minMarketCoverage) blockers.push("INSUFFICIENT_MARKET_COVERAGE");

  // Criterion family 2: paired decision-policy performance vs V1, real captured prices.
  if (evidence.decisionPolicyPairedN < MOUND_V2_PROMOTION_THRESHOLDS.minDecisionPolicyPairedN) {
    blockers.push("INSUFFICIENT_PAIRED_DECISION_POLICY_SAMPLE");
  } else {
    if (evidence.winRateDelta == null || evidence.winRateDelta < MOUND_V2_PROMOTION_THRESHOLDS.minWinRateDelta) {
      blockers.push("DECISION_POLICY_WIN_RATE_NOT_NON_INFERIOR");
    }
    if (evidence.roiDelta == null || evidence.roiDelta < MOUND_V2_PROMOTION_THRESHOLDS.minRoiDelta) {
      blockers.push("DECISION_POLICY_ROI_NOT_NON_INFERIOR");
    }
  }

  // Checked last but never suppressed by the others — a regression blocks
  // promotion even if every other criterion above is otherwise clean.
  if (evidence.settlementOrProvenanceRegressionDetected) blockers.push("SETTLEMENT_OR_PROVENANCE_REGRESSION");

  return { readyForPromotion: blockers.length === 0, blockers, probabilityComparator: evidence.probabilityComparator };
}
