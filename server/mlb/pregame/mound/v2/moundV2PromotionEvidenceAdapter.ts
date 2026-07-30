// Mound Radar V2 (shadow) — promotion evidence adapter (Flagship Program
// Phase 2, Part 7, corrected; Final Pre-Push Integrity Pass, Section 5).
// Converts REAL Part 6 comparison rows (plus REAL Part 3 shadow-evaluation
// metrics, and — as of Section 5 — real grading-coverage and worker-queue
// stats) into the MoundV2PromotionEvidence shape
// moundV2PromotionGate.ts's evaluateMoundV2PromotionReadiness checks against
// fixed thresholds. Produces EVIDENCE ONLY — nothing here promotes
// anything, and nothing calls this automatically. Promotion requires a
// separate, deliberate, explicit code/config change.
//
// Thin by design: every criteria family the gate needs is already computed
// by moundV2ComparisonStats.ts (probability quality vs an explicitly-named
// comparator, paired decision-policy non-inferiority, subgroup breakdowns,
// and the evidence-integrity ratios added in Section 5) — this file only
// selects the strikeouts-market subset (the outs market has no real line
// today, so it can never feed a probability/decision-policy criterion) and
// re-shapes everything into the gate's evidence.
//
// Fail-closed: every value that can't be honestly computed reads as
// "blocks promotion," never as "clears the gate." Market coverage with no
// evaluation data at all reads as 0. settlementOrProvenanceRegressionDetected,
// gradingCoverageReport, and workerQueueStats have no live runtime monitor
// wired into THIS function today and are therefore REQUIRED explicit inputs
// (nullable, but never defaulted/omitted) — there is no way to silently get
// a favorable readout out of this function when real evidence wasn't
// supplied.

import {
  computeMoundV2ProbabilityEvaluation,
  computeMoundV2DecisionPolicyComparison,
  buildMoundV2PromotionSubgroups,
  computeRoiEligiblePriceRatio,
  computeSportsbookProvenanceRatio,
  computePairedPopulationRatio,
  computeMoundV2VersionDeclaration,
  type MoundV2ComparisonRow,
} from "./moundV2ComparisonStats";
import { evaluateMoundV2PromotionReadiness, type MoundV2PromotionEvidence, type MoundV2PromotionVerdict } from "./moundV2PromotionGate";

const STRIKEOUTS_MARKET = "pitcher_strikeouts";

/** Same shape as storage.ts's getMoundV2ShadowJobQueueStats — only the two fields this adapter needs. */
export interface MoundV2WorkerQueueStatsForPromotion {
  completed: number;
  deadLetter: number;
}

/** Same shape as moundV2ShadowReconciliation.ts's MoundV2GradingCoverageReport — only the fields this adapter needs. */
export interface MoundV2GradingCoverageForPromotion {
  totalRows: number;
  pendingCount: number;
  providerFailureCount: number;
}

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
  /** ET slate date strings ("YYYY-MM-DD") declaring the evaluation window — required so a report can never silently omit stating what period it covers. */
  evalWindowStart: string | null;
  evalWindowEnd: string | null;
  /** From moundV2ShadowReconciliation.ts's buildMoundV2GradingCoverageReport, run over the SAME window's full row population (not just graded-with-line). Null (not omitted) when the caller genuinely has no such report available — the gate then fails closed on settlementErrorRatio/pendingGradingRatio rather than silently passing. */
  gradingCoverageReport: MoundV2GradingCoverageForPromotion | null;
  /** From storage.ts's getMoundV2ShadowJobQueueStats. Null when unavailable — the gate fails closed on workerJobFailureRatio. */
  workerQueueStats: MoundV2WorkerQueueStatsForPromotion | null;
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
  // Reported/gated SEPARATELY from marketCoverage above: coverage conflates
  // "no market line available for this candidate" with "the evaluator
  // actually failed/threw" as the same shortfall. 0 when there were zero
  // attempts (nothing to have failed) — not 1 ("perfect"), since
  // marketCoverage already carries the "no attempts" case.
  const shadowEvaluationFailureRatio = opts.shadowEvaluationTotal > 0
    ? opts.shadowEvaluationFailures / opts.shadowEvaluationTotal
    : 0;

  // Fail-closed: an unmeasurable probability delta (no V2 or comparator
  // metric to diff) reads as +Infinity ("not improved"), never 0 ("matches
  // exactly") — missing/insufficient data must never silently pass a gate
  // meant to require PROVEN improvement.
  const toBlockingDelta = (d: number | null): number => d ?? Number.POSITIVE_INFINITY;

  const { v2ModelVersionDeclared, v2DecisionPolicyVersionDeclared } = computeMoundV2VersionDeclaration(gradedWithLine);

  const settlementErrorRatio = opts.gradingCoverageReport && opts.gradingCoverageReport.totalRows > 0
    ? opts.gradingCoverageReport.providerFailureCount / opts.gradingCoverageReport.totalRows
    : null;
  const pendingGradingRatio = opts.gradingCoverageReport && opts.gradingCoverageReport.totalRows > 0
    ? opts.gradingCoverageReport.pendingCount / opts.gradingCoverageReport.totalRows
    : null;

  const workerJobFailureRatio = opts.workerQueueStats && (opts.workerQueueStats.completed + opts.workerQueueStats.deadLetter) > 0
    ? opts.workerQueueStats.deadLetter / (opts.workerQueueStats.completed + opts.workerQueueStats.deadLetter)
    : null;

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

    evalWindowStart: opts.evalWindowStart,
    evalWindowEnd: opts.evalWindowEnd,
    absoluteCalibrationError: probabilityEvaluation.v2CalibrationError,
    pairedPopulationRatio: computePairedPopulationRatio(decisionPolicy.pairedN, decisionPolicy.legacyIncompleteDataCount, decisionPolicy.v1NoRecommendationCount),
    roiEligiblePriceRatio: computeRoiEligiblePriceRatio(gradedWithLine),
    sportsbookProvenanceRatio: computeSportsbookProvenanceRatio(gradedWithLine),
    settlementErrorRatio,
    pendingGradingRatio,
    subgroups: buildMoundV2PromotionSubgroups(gradedWithLine),
    workerJobFailureRatio,
    shadowEvaluationFailureRatio,
    v2ModelVersionDeclared,
    v2DecisionPolicyVersionDeclared,
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
