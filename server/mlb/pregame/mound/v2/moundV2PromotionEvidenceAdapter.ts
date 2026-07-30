// Mound Radar V2 (shadow) — promotion evidence adapter (Flagship Program
// Phase 2, Part 7, corrected). Converts REAL Part 6 comparison rows (plus
// REAL Part 3 shadow-evaluation metrics) into the MoundV2PromotionEvidence
// shape moundV2PromotionGate.ts's evaluateMoundV2PromotionReadiness checks
// against fixed thresholds. Produces EVIDENCE ONLY — nothing here promotes
// anything, and nothing calls this automatically. Promotion requires a
// separate, deliberate, explicit code/config change.
//
// Thin by design: both criteria families the gate needs (absolute
// probability quality vs an explicitly-named comparator, and paired
// decision-policy non-inferiority vs V1's real captured-price performance)
// are already computed by moundV2ComparisonStats.ts's
// computeMoundV2ProbabilityEvaluation / computeMoundV2DecisionPolicyComparison
// — this file only selects the strikeouts-market subset (the outs market
// has no real line today, so it can never feed a probability/decision-
// policy criterion) and re-shapes their output into the gate's evidence.
//
// Fail-closed: every value that can't be honestly computed reads as
// "blocks promotion," never as "clears the gate." Market coverage with no
// evaluation data at all reads as 0. settlementOrProvenanceRegressionDetected
// has no live runtime monitor today and is therefore a REQUIRED explicit
// input, not a defaulted one — there is no way to silently get a favorable
// "false" out of this function.

import {
  computeMoundV2ProbabilityEvaluation,
  computeMoundV2DecisionPolicyComparison,
  type MoundV2ComparisonRow,
} from "./moundV2ComparisonStats";
import { evaluateMoundV2PromotionReadiness, type MoundV2PromotionEvidence, type MoundV2PromotionVerdict } from "./moundV2PromotionGate";

const STRIKEOUTS_MARKET = "pitcher_strikeouts";

export interface MoundV2PromotionEvidenceOpts {
  /** Which non-V1 reference to score V2's absolute probability quality against — see moundV2PromotionGate.ts's own doc comment for why this is never V1. */
  probabilityComparator: "climatology" | "market_implied";
  /** From moundV2ShadowStore.ts's getMoundV2ShadowMetrics().totalEvaluations. */
  shadowEvaluationTotal: number;
  /** From moundV2ShadowStore.ts's getMoundV2ShadowMetrics().totalFailures. */
  shadowEvaluationFailures: number;
  /**
   * Required, not defaulted. No live runtime monitor for a V2-caused
   * settlement/provenance regression exists today — the actual evidence
   * base right now is (a) moundV2ShadowWiring.test.ts's structural,
   * source-level proof that the shadow block never assigns to `signal.`
   * or calls `signals.set(` and always runs after V1's own signal object
   * is fully built, and (b) the explicit per-file grep confirming zero
   * production-Mound import edges into v2/ (moundV2Engine.test.ts's own
   * isolation check). Passing `false` here asserts "I have reviewed that
   * evidence for the code currently deployed and it holds" — it is a
   * human/CI attestation, not something this function can verify itself.
   */
  settlementOrProvenanceRegressionDetected: boolean;
}

/**
 * Builds real MoundV2PromotionEvidence from a set of comparison rows
 * (the pitcher_strikeouts subset of what moundV2ComparisonGatherer.ts
 * fetches for a declared window).
 */
export function buildMoundV2PromotionEvidence(
  v2Rows: readonly MoundV2ComparisonRow[],
  opts: MoundV2PromotionEvidenceOpts,
): MoundV2PromotionEvidence {
  const strikeoutsRows = v2Rows.filter((r) => r.market === STRIKEOUTS_MARKET);
  const gradedWithLine = strikeoutsRows.filter((r) => r.settlementStatus === "graded" && r.finalResult != null);

  const probabilityEvaluation = computeMoundV2ProbabilityEvaluation(gradedWithLine, opts.probabilityComparator);
  const decisionPolicy = computeMoundV2DecisionPolicyComparison(gradedWithLine);

  const marketCoverage = opts.shadowEvaluationTotal > 0
    ? (opts.shadowEvaluationTotal - opts.shadowEvaluationFailures) / opts.shadowEvaluationTotal
    : 0;

  // Fail-closed: an unmeasurable probability delta (no V2 or comparator
  // metric to diff) reads as +Infinity ("not improved"), never 0 ("matches
  // exactly") — missing/insufficient data must never silently pass a gate
  // meant to require PROVEN improvement.
  const toBlockingDelta = (d: number | null): number => d ?? Number.POSITIVE_INFINITY;

  return {
    probabilityComparator: opts.probabilityComparator,
    sampleSize: probabilityEvaluation.sampleSize,
    calibrationErrorDelta: toBlockingDelta(probabilityEvaluation.calibrationErrorDelta),
    brierDelta: toBlockingDelta(probabilityEvaluation.brierDelta),
    logLossDelta: toBlockingDelta(probabilityEvaluation.logLossDelta),
    marketCoverage,
    decisionPolicyPairedN: decisionPolicy.pairedN,
    decisionPolicyLegacyIncompleteCount: decisionPolicy.legacyIncompleteDataCount,
    winRateDelta: decisionPolicy.winRateDelta,
    roiDelta: decisionPolicy.roiDelta,
    settlementOrProvenanceRegressionDetected: opts.settlementOrProvenanceRegressionDetected,
  };
}

/** Convenience combinator — still just evidence + a verdict; nothing here writes/applies a promotion. */
export function buildAndEvaluateMoundV2Promotion(
  v2Rows: readonly MoundV2ComparisonRow[],
  opts: MoundV2PromotionEvidenceOpts,
): { evidence: MoundV2PromotionEvidence; verdict: MoundV2PromotionVerdict } {
  const evidence = buildMoundV2PromotionEvidence(v2Rows, opts);
  return { evidence, verdict: evaluateMoundV2PromotionReadiness(evidence) };
}
