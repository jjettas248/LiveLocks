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
//
// Final Pre-Push Integrity Pass (Section 5): every value below fails CLOSED.
// A ratio/ delta this module cannot honestly compute (no data, an empty
// denominator, a required evidence field never supplied by the caller) is
// represented as `null`, and null is *always* treated as "does not clear the
// gate" — never silently passed as if it were 0 or "matches". There is no
// path from "we don't know" to "promotion-ready".

export type MoundV2PromotionSubgroupDimension =
  | "market"
  | "side"
  | "setupGrade"
  | "dataQuality"
  | "lineupStatus"
  | "workloadBand"
  | "sportsbook";

export interface MoundV2PromotionSubgroupEvidence {
  dimension: MoundV2PromotionSubgroupDimension;
  key: string;
  /** Paired (both V1 and V2 have a real decision) sample size for this subgroup specifically — NOT the subgroup's total row count, so a subgroup dominated by non-paired rows can't masquerade as well-sampled. */
  sampleSize: number;
  winRateDelta: number | null;
  roiDelta: number | null;
}

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

  // ── Section 5 additions ──────────────────────────────────────────────────

  /** ET slate date the evidence window starts/ends on (inclusive), as declared by whoever assembled this evidence. Null (either one) means the evaluation window itself was never declared — a report with no stated window cannot be trusted to represent a real, bounded evaluation period. */
  evalWindowStart: string | null;
  evalWindowEnd: string | null;

  /** V2's OWN absolute calibration error (not a delta against any comparator) over the same sample as calibrationErrorDelta. Null when unmeasurable (no graded sample). Guards against "V2 merely beats a bad comparator while still being badly miscalibrated in absolute terms." */
  absoluteCalibrationError: number | null;

  /** decisionPolicyPairedN / (decisionPolicyPairedN + decisionPolicyLegacyIncompleteCount + v1NoRecommendationCount). Null when the denominator is 0 (no evidence at all). Guards against a technically-adequate pairedN that is actually a tiny sliver of an otherwise mismatched/incomparable population. */
  pairedPopulationRatio: number | null;

  /** Fraction of V1's-and-V2's-OWN recommended/implied sides that had a real, usable captured price to grade ROI from (the worse of V1's and V2's own price-coverage ratios). Null when unmeasurable. A low ratio means the ROI conclusion above is drawn from a price-starved subset, not the full paired population. */
  roiEligiblePriceRatio: number | null;

  /** Fraction of the graded-with-a-line population carrying a real sportsbook name AND a real odds-fetch timestamp (never a placeholder/blank). Null when there is no graded-with-line population to check at all. */
  sportsbookProvenanceRatio: number | null;

  /** Fraction of ALL captured predictions (not just graded-with-line) whose most recent grading/reconciliation attempt recorded a real failure reason — a genuine settlement ERROR (a provider fetch failure, an unexpected exception), never a legitimate void (game_cancelled/pitcher_no_appearance). Null when no grading-coverage evidence was supplied at all. */
  settlementErrorRatio: number | null;
  /** Fraction of ALL captured predictions still settlementStatus=pending. Null when no grading-coverage evidence was supplied. A high ratio means the evidence above is drawn from a population that hasn't finished resolving yet. */
  pendingGradingRatio: number | null;

  /** Per-subgroup paired win-rate/ROI deltas across market/side/setupGrade/dataQuality/lineupStatus/workloadBand/sportsbook. Subgroups below minSubgroupSampleSize are reported but never gate promotion on their own (avoids tiny-subgroup false decisiveness) — see evaluateMoundV2PromotionReadiness. workloadBand has no persisted source data yet (see moundV2ComparisonStats.ts's buildPromotionSubgroups doc comment) and will simply never appear in this array until that's wired — its absence is not silently treated as "passing". */
  subgroups: MoundV2PromotionSubgroupEvidence[];

  /** Terminal (dead_letter) worker jobs as a fraction of all TERMINAL (completed + dead_letter) jobs. Null when no queue-stats evidence was supplied. */
  workerJobFailureRatio: number | null;
  /** Shadow evaluation failures (evaluateMoundV2Shadow returning a failureReason) as a fraction of total evaluation attempts — always computable from the SAME shadowEvaluationTotal/shadowEvaluationFailures inputs marketCoverage already uses, but reported and gated SEPARATELY: coverage conflates "no market line available" with "the evaluator actually failed/threw", which are different signals. 0 when there were zero evaluation attempts (nothing to have failed). */
  shadowEvaluationFailureRatio: number;

  /** Every row in the evaluated population carries a non-empty v2ModelVersion. */
  v2ModelVersionDeclared: boolean;
  /** Every row in the evaluated population carries a non-empty v2DecisionPolicyVersion (the qualify/abstain policy version, distinct from the probability-model version above). */
  v2DecisionPolicyVersionDeclared: boolean;
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

  /** A conservative ceiling meant to catch GROSS miscalibration (e.g. a model that's confidently wrong) — not a fine-tuned bar. Tune with real graded data before this gate is load-bearing in an actual promotion decision. */
  maxAbsoluteCalibrationError: 0.15,
  /** At least this fraction of the graded-with-line population must be genuinely paired (both V1 and V2 have a real decision) for the paired comparison to be considered representative rather than a small, possibly-unrepresentative sliver. */
  minPairedPopulationRatio: 0.4,
  minRoiEligiblePriceRatio: 0.85,
  minSportsbookProvenanceRatio: 0.9,
  maxSettlementErrorRatio: 0.05,
  maxPendingGradingRatio: 0.15,
  /** Subgroups smaller than this are reported for visibility but never gate promotion on their own — a 3-sample subgroup showing a "regression" is noise, not evidence. */
  minSubgroupSampleSize: 30,
  maxWorkerJobFailureRatio: 0.05,
  maxShadowEvaluationFailureRatio: 0.05,
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
  "MISSING_EVAL_WINDOW",
  "ABSOLUTE_CALIBRATION_TOO_HIGH",
  "INSUFFICIENT_PAIRED_POPULATION_RATIO",
  "INSUFFICIENT_ROI_PRICE_COVERAGE",
  "INSUFFICIENT_SPORTSBOOK_PROVENANCE",
  "EXCESSIVE_SETTLEMENT_ERRORS",
  "EXCESSIVE_GRADING_INCOMPLETENESS",
  "SEVERE_SUBGROUP_REGRESSION",
  "EXCESSIVE_WORKER_FAILURES",
  "EXCESSIVE_SHADOW_CAPTURE_LOSS",
  "UNDECLARED_MODEL_OR_POLICY_VERSION",
] as const;
export type MoundV2PromotionBlocker = (typeof MOUND_V2_PROMOTION_BLOCKERS)[number];

export interface MoundV2PromotionVerdict {
  readyForPromotion: boolean;
  blockers: MoundV2PromotionBlocker[];
  /** Restates which comparator the probability-quality criteria were checked against — so a verdict can never be read out of context as "vs V1". */
  probabilityComparator: "climatology" | "market_implied";
  /** Populated only when SEVERE_SUBGROUP_REGRESSION fires — the specific offending subgroup(s), for diagnosability (never required reading to understand readyForPromotion itself). */
  subgroupRegressions: MoundV2PromotionSubgroupEvidence[];
}

export function evaluateMoundV2PromotionReadiness(evidence: MoundV2PromotionEvidence): MoundV2PromotionVerdict {
  const blockers: MoundV2PromotionBlocker[] = [];

  // Criterion family 1: absolute V2 probability quality vs the named comparator.
  if (evidence.sampleSize < MOUND_V2_PROMOTION_THRESHOLDS.minSampleSize) blockers.push("INSUFFICIENT_SAMPLE_SIZE");
  if (evidence.calibrationErrorDelta > MOUND_V2_PROMOTION_THRESHOLDS.maxCalibrationErrorDelta) blockers.push("CALIBRATION_NOT_IMPROVED");
  if (evidence.brierDelta > MOUND_V2_PROMOTION_THRESHOLDS.maxBrierDelta) blockers.push("BRIER_NOT_IMPROVED");
  if (evidence.logLossDelta > MOUND_V2_PROMOTION_THRESHOLDS.maxLogLossDelta) blockers.push("LOG_LOSS_NOT_IMPROVED");
  if (evidence.marketCoverage < MOUND_V2_PROMOTION_THRESHOLDS.minMarketCoverage) blockers.push("INSUFFICIENT_MARKET_COVERAGE");
  if (evidence.absoluteCalibrationError == null || evidence.absoluteCalibrationError > MOUND_V2_PROMOTION_THRESHOLDS.maxAbsoluteCalibrationError) {
    blockers.push("ABSOLUTE_CALIBRATION_TOO_HIGH");
  }

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
  if (evidence.pairedPopulationRatio == null || evidence.pairedPopulationRatio < MOUND_V2_PROMOTION_THRESHOLDS.minPairedPopulationRatio) {
    blockers.push("INSUFFICIENT_PAIRED_POPULATION_RATIO");
  }
  if (evidence.roiEligiblePriceRatio == null || evidence.roiEligiblePriceRatio < MOUND_V2_PROMOTION_THRESHOLDS.minRoiEligiblePriceRatio) {
    blockers.push("INSUFFICIENT_ROI_PRICE_COVERAGE");
  }

  // Criterion family 3: evidence-integrity / data-hygiene gates.
  if (!evidence.evalWindowStart || !evidence.evalWindowEnd) blockers.push("MISSING_EVAL_WINDOW");
  if (evidence.sportsbookProvenanceRatio == null || evidence.sportsbookProvenanceRatio < MOUND_V2_PROMOTION_THRESHOLDS.minSportsbookProvenanceRatio) {
    blockers.push("INSUFFICIENT_SPORTSBOOK_PROVENANCE");
  }
  if (evidence.settlementErrorRatio == null || evidence.settlementErrorRatio > MOUND_V2_PROMOTION_THRESHOLDS.maxSettlementErrorRatio) {
    blockers.push("EXCESSIVE_SETTLEMENT_ERRORS");
  }
  if (evidence.pendingGradingRatio == null || evidence.pendingGradingRatio > MOUND_V2_PROMOTION_THRESHOLDS.maxPendingGradingRatio) {
    blockers.push("EXCESSIVE_GRADING_INCOMPLETENESS");
  }
  if (evidence.workerJobFailureRatio == null || evidence.workerJobFailureRatio > MOUND_V2_PROMOTION_THRESHOLDS.maxWorkerJobFailureRatio) {
    blockers.push("EXCESSIVE_WORKER_FAILURES");
  }
  if (evidence.shadowEvaluationFailureRatio > MOUND_V2_PROMOTION_THRESHOLDS.maxShadowEvaluationFailureRatio) {
    blockers.push("EXCESSIVE_SHADOW_CAPTURE_LOSS");
  }
  if (!evidence.v2ModelVersionDeclared || !evidence.v2DecisionPolicyVersionDeclared) {
    blockers.push("UNDECLARED_MODEL_OR_POLICY_VERSION");
  }

  // Subgroup regression: only subgroups meeting the minimum sample size can
  // gate — a tiny subgroup "failing" is noise, not evidence (reported
  // separately on the verdict either way, for visibility).
  const subgroupRegressions = evidence.subgroups.filter((sg) => {
    if (sg.sampleSize < MOUND_V2_PROMOTION_THRESHOLDS.minSubgroupSampleSize) return false;
    const winRateFails = sg.winRateDelta == null || sg.winRateDelta < MOUND_V2_PROMOTION_THRESHOLDS.minWinRateDelta;
    const roiFails = sg.roiDelta == null || sg.roiDelta < MOUND_V2_PROMOTION_THRESHOLDS.minRoiDelta;
    return winRateFails || roiFails;
  });
  if (subgroupRegressions.length > 0) blockers.push("SEVERE_SUBGROUP_REGRESSION");

  // Checked last but never suppressed by the others — a regression blocks
  // promotion even if every other criterion above is otherwise clean.
  if (evidence.settlementOrProvenanceRegressionDetected) blockers.push("SETTLEMENT_OR_PROVENANCE_REGRESSION");

  return {
    readyForPromotion: blockers.length === 0,
    blockers,
    probabilityComparator: evidence.probabilityComparator,
    subgroupRegressions,
  };
}
