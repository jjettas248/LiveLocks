// Mound V2 promotion-readiness gate — invariants (Final Pre-Push Integrity
// Pass, Section 5: full failure-condition matrix, fails closed on every
// unmeasurable/unsupplied evidence field).
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2PromotionGate.test.ts

import {
  evaluateMoundV2PromotionReadiness,
  MOUND_V2_PROMOTION_THRESHOLDS,
  type MoundV2PromotionEvidence,
  type MoundV2PromotionSubgroupEvidence,
} from "./moundV2PromotionGate";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function goodEvidence(overrides: Partial<MoundV2PromotionEvidence> = {}): MoundV2PromotionEvidence {
  return {
    probabilityComparator: "climatology",
    sampleSize: 500,
    calibrationErrorDelta: -0.01,
    brierDelta: -0.005,
    logLossDelta: -0.02,
    marketCoverage: 0.9,
    decisionPolicyPairedN: 300,
    decisionPolicyLegacyIncompleteCount: 0,
    winRateDelta: 0.01,
    roiDelta: 0.02,
    settlementOrProvenanceRegressionDetected: false,
    evalWindowStart: "2026-07-01",
    evalWindowEnd: "2026-07-30",
    absoluteCalibrationError: 0.05,
    pairedPopulationRatio: 0.8,
    roiEligiblePriceRatio: 0.95,
    sportsbookProvenanceRatio: 0.98,
    settlementErrorRatio: 0.01,
    pendingGradingRatio: 0.05,
    subgroups: [],
    workerJobFailureRatio: 0.01,
    shadowEvaluationFailureRatio: 0.01,
    v2ModelVersionDeclared: true,
    v2ModelPolicyVersionDeclared: true,
    ...overrides,
  };
}

function subgroup(overrides: Partial<MoundV2PromotionSubgroupEvidence> = {}): MoundV2PromotionSubgroupEvidence {
  return {
    dimension: "market",
    key: "pitcher_strikeouts",
    sampleSize: 50,
    winRateDelta: 0.01,
    roiDelta: 0.02,
    ...overrides,
  };
}

// ── Fully clean evidence is ready for promotion ─────────────────────────────
{
  const verdict = evaluateMoundV2PromotionReadiness(goodEvidence());
  ok(verdict.readyForPromotion === true, "clean evidence across every criterion (old and new) is ready for promotion");
  ok(verdict.blockers.length === 0, "no blockers are reported when every criterion passes");
  ok(verdict.probabilityComparator === "climatology", "the verdict restates which comparator the probability criteria were checked against");
  ok(verdict.subgroupRegressions.length === 0, "no subgroup regressions reported when subgroups is empty");
}

// ── Insufficient sample size blocks regardless of everything else ─────────
{
  const verdict = evaluateMoundV2PromotionReadiness(goodEvidence({ sampleSize: 50 }));
  ok(!verdict.readyForPromotion, "a small sample size blocks promotion");
  ok(verdict.blockers.includes("INSUFFICIENT_SAMPLE_SIZE"), "the specific blocker is reported");
}

// ── Any statistical regression (positive delta = worse than the named comparator) blocks ──
{
  const calibrationWorse = evaluateMoundV2PromotionReadiness(goodEvidence({ calibrationErrorDelta: 0.02 }));
  ok(!calibrationWorse.readyForPromotion && calibrationWorse.blockers.includes("CALIBRATION_NOT_IMPROVED"), "worse calibration than the comparator blocks promotion");

  const brierWorse = evaluateMoundV2PromotionReadiness(goodEvidence({ brierDelta: 0.01 }));
  ok(!brierWorse.readyForPromotion && brierWorse.blockers.includes("BRIER_NOT_IMPROVED"), "worse Brier score than the comparator blocks promotion");

  const logLossWorse = evaluateMoundV2PromotionReadiness(goodEvidence({ logLossDelta: 0.03 }));
  ok(!logLossWorse.readyForPromotion && logLossWorse.blockers.includes("LOG_LOSS_NOT_IMPROVED"), "worse log loss than the comparator blocks promotion");
}

// ── Thin market coverage blocks promotion ───────────────────────────────────
{
  const verdict = evaluateMoundV2PromotionReadiness(goodEvidence({ marketCoverage: 0.4 }));
  ok(!verdict.readyForPromotion && verdict.blockers.includes("INSUFFICIENT_MARKET_COVERAGE"), "thin market coverage blocks promotion");
}

// ── Decision-policy criteria: a SECOND, independent, required family ───────
{
  const smallPaired = evaluateMoundV2PromotionReadiness(goodEvidence({ decisionPolicyPairedN: 10 }));
  ok(!smallPaired.readyForPromotion && smallPaired.blockers.includes("INSUFFICIENT_PAIRED_DECISION_POLICY_SAMPLE"), "a thin paired decision-policy sample blocks promotion even when probability quality is otherwise clean");

  const worseWinRate = evaluateMoundV2PromotionReadiness(goodEvidence({ winRateDelta: -0.5 }));
  ok(!worseWinRate.readyForPromotion && worseWinRate.blockers.includes("DECISION_POLICY_WIN_RATE_NOT_NON_INFERIOR"), "V2 win rate meaningfully trailing V1's blocks promotion");

  const worseRoi = evaluateMoundV2PromotionReadiness(goodEvidence({ roiDelta: -0.5 }));
  ok(!worseRoi.readyForPromotion && worseRoi.blockers.includes("DECISION_POLICY_ROI_NOT_NON_INFERIOR"), "V2 ROI meaningfully trailing V1's blocks promotion");

  const nullDeltas = evaluateMoundV2PromotionReadiness(goodEvidence({ winRateDelta: null, roiDelta: null }));
  ok(!nullDeltas.readyForPromotion && nullDeltas.blockers.includes("DECISION_POLICY_WIN_RATE_NOT_NON_INFERIOR") && nullDeltas.blockers.includes("DECISION_POLICY_ROI_NOT_NON_INFERIOR"), "unmeasurable (null) win-rate/ROI deltas fail closed — never silently treated as non-inferior");

  ok(goodEvidence().winRateDelta! >= MOUND_V2_PROMOTION_THRESHOLDS.minWinRateDelta, "sanity: the happy-path fixture's winRateDelta genuinely clears the threshold");
}

// ── Absolute probability quality alone is NOT sufficient — decision policy is a required second family ──
{
  const probabilityGreatButNoDecisionPolicyEvidence = evaluateMoundV2PromotionReadiness(
    goodEvidence({ decisionPolicyPairedN: 0, winRateDelta: null, roiDelta: null }),
  );
  ok(!probabilityGreatButNoDecisionPolicyEvidence.readyForPromotion, "great probability-quality evidence alone, with zero paired decision-policy evidence, is NOT ready for promotion — both families are required");
}

// ── A settlement/provenance regression blocks promotion even with otherwise-perfect evidence ──
{
  const verdict = evaluateMoundV2PromotionReadiness(goodEvidence({ settlementOrProvenanceRegressionDetected: true }));
  ok(!verdict.readyForPromotion, "a detected settlement/provenance regression blocks promotion");
  ok(verdict.blockers.includes("SETTLEMENT_OR_PROVENANCE_REGRESSION"), "the regression blocker is reported even though every statistical criterion passed");
  ok(verdict.blockers.length === 1, "no other blockers are spuriously reported alongside the regression flag when everything else is clean");
}

// ── Multiple simultaneous failures are all reported, not just the first ────
{
  const verdict = evaluateMoundV2PromotionReadiness(
    goodEvidence({ sampleSize: 10, marketCoverage: 0.1, decisionPolicyPairedN: 5, settlementOrProvenanceRegressionDetected: true }),
  );
  ok(verdict.blockers.length === 4, `all four simultaneous failures are reported (got ${verdict.blockers.length}: ${verdict.blockers.join(", ")})`);
}

// ── Threshold boundaries are exact (>=, not >) ──────────────────────────────
{
  const atThreshold = evaluateMoundV2PromotionReadiness(goodEvidence({ sampleSize: MOUND_V2_PROMOTION_THRESHOLDS.minSampleSize }));
  ok(!atThreshold.blockers.includes("INSUFFICIENT_SAMPLE_SIZE"), "a sample size exactly at the minimum threshold is sufficient (not a strict >)");
  const belowThreshold = evaluateMoundV2PromotionReadiness(goodEvidence({ sampleSize: MOUND_V2_PROMOTION_THRESHOLDS.minSampleSize - 1 }));
  ok(belowThreshold.blockers.includes("INSUFFICIENT_SAMPLE_SIZE"), "one below the minimum threshold is insufficient");

  const pairedAtThreshold = evaluateMoundV2PromotionReadiness(goodEvidence({ decisionPolicyPairedN: MOUND_V2_PROMOTION_THRESHOLDS.minDecisionPolicyPairedN }));
  ok(!pairedAtThreshold.blockers.includes("INSUFFICIENT_PAIRED_DECISION_POLICY_SAMPLE"), "a paired decision-policy sample exactly at the minimum threshold is sufficient");

  const winRateAtThreshold = evaluateMoundV2PromotionReadiness(goodEvidence({ winRateDelta: MOUND_V2_PROMOTION_THRESHOLDS.minWinRateDelta }));
  ok(!winRateAtThreshold.blockers.includes("DECISION_POLICY_WIN_RATE_NOT_NON_INFERIOR"), "a winRateDelta exactly at the minimum tolerance is non-inferior (not a strict >)");
}

// ── Section 5: missing evaluation window ────────────────────────────────────
{
  const noStart = evaluateMoundV2PromotionReadiness(goodEvidence({ evalWindowStart: null }));
  ok(!noStart.readyForPromotion && noStart.blockers.includes("MISSING_EVAL_WINDOW"), "a null evalWindowStart blocks promotion — a report that never declares when its evidence starts cannot be trusted");

  const noEnd = evaluateMoundV2PromotionReadiness(goodEvidence({ evalWindowEnd: null }));
  ok(!noEnd.readyForPromotion && noEnd.blockers.includes("MISSING_EVAL_WINDOW"), "a null evalWindowEnd also blocks promotion");

  const emptyStart = evaluateMoundV2PromotionReadiness(goodEvidence({ evalWindowStart: "" }));
  ok(emptyStart.blockers.includes("MISSING_EVAL_WINDOW"), "an empty-string evalWindowStart is treated the same as null, never as 'declared'");
}

// ── Section 5: absolute V2 calibration (not just a delta vs. the comparator) ──
{
  const tooHigh = evaluateMoundV2PromotionReadiness(goodEvidence({ absoluteCalibrationError: 0.3 }));
  ok(!tooHigh.readyForPromotion && tooHigh.blockers.includes("ABSOLUTE_CALIBRATION_TOO_HIGH"), "V2's own absolute calibration error above the ceiling blocks promotion EVEN THOUGH calibrationErrorDelta (vs the comparator) is clean — beating a bad comparator is not the same as being well-calibrated");

  const unmeasurable = evaluateMoundV2PromotionReadiness(goodEvidence({ absoluteCalibrationError: null }));
  ok(!unmeasurable.readyForPromotion && unmeasurable.blockers.includes("ABSOLUTE_CALIBRATION_TOO_HIGH"), "an unmeasurable (null) absolute calibration error fails closed, never silently passes");

  const atCeiling = evaluateMoundV2PromotionReadiness(goodEvidence({ absoluteCalibrationError: MOUND_V2_PROMOTION_THRESHOLDS.maxAbsoluteCalibrationError }));
  ok(!atCeiling.blockers.includes("ABSOLUTE_CALIBRATION_TOO_HIGH"), "exactly at the ceiling is acceptable (not a strict >)");
}

// ── Section 5: paired-population ratio (guards against a technically-adequate pairedN drawn from a tiny, unrepresentative sliver) ──
{
  const tooLow = evaluateMoundV2PromotionReadiness(goodEvidence({ pairedPopulationRatio: 0.1 }));
  ok(!tooLow.readyForPromotion && tooLow.blockers.includes("INSUFFICIENT_PAIRED_POPULATION_RATIO"), "a low paired-population ratio blocks promotion even with a large absolute pairedN");

  const unmeasurable = evaluateMoundV2PromotionReadiness(goodEvidence({ pairedPopulationRatio: null }));
  ok(!unmeasurable.readyForPromotion && unmeasurable.blockers.includes("INSUFFICIENT_PAIRED_POPULATION_RATIO"), "an unmeasurable (null) paired-population ratio (empty denominator) fails closed");
}

// ── Section 5: ROI price coverage (missing/stale prices) ────────────────────
{
  const tooLow = evaluateMoundV2PromotionReadiness(goodEvidence({ roiEligiblePriceRatio: 0.3 }));
  ok(!tooLow.readyForPromotion && tooLow.blockers.includes("INSUFFICIENT_ROI_PRICE_COVERAGE"), "a low ROI-eligible-price ratio blocks promotion — the ROI conclusion would be drawn from a price-starved subset");

  const unmeasurable = evaluateMoundV2PromotionReadiness(goodEvidence({ roiEligiblePriceRatio: null }));
  ok(!unmeasurable.readyForPromotion && unmeasurable.blockers.includes("INSUFFICIENT_ROI_PRICE_COVERAGE"), "an unmeasurable (null) price-coverage ratio fails closed");
}

// ── Section 5: sportsbook provenance ────────────────────────────────────────
{
  const tooLow = evaluateMoundV2PromotionReadiness(goodEvidence({ sportsbookProvenanceRatio: 0.5 }));
  ok(!tooLow.readyForPromotion && tooLow.blockers.includes("INSUFFICIENT_SPORTSBOOK_PROVENANCE"), "too many rows missing a real sportsbook/fetch-timestamp blocks promotion");

  const unmeasurable = evaluateMoundV2PromotionReadiness(goodEvidence({ sportsbookProvenanceRatio: null }));
  ok(!unmeasurable.readyForPromotion && unmeasurable.blockers.includes("INSUFFICIENT_SPORTSBOOK_PROVENANCE"), "an unmeasurable (null) provenance ratio fails closed");
}

// ── Section 5: settlement errors vs legitimate voids ────────────────────────
{
  const tooHigh = evaluateMoundV2PromotionReadiness(goodEvidence({ settlementErrorRatio: 0.2 }));
  ok(!tooHigh.readyForPromotion && tooHigh.blockers.includes("EXCESSIVE_SETTLEMENT_ERRORS"), "too many genuine settlement errors (provider failures during grading, not legitimate game_cancelled/pitcher_no_appearance voids) blocks promotion");

  const unmeasurable = evaluateMoundV2PromotionReadiness(goodEvidence({ settlementErrorRatio: null }));
  ok(!unmeasurable.readyForPromotion && unmeasurable.blockers.includes("EXCESSIVE_SETTLEMENT_ERRORS"), "no grading-coverage evidence supplied at all (null) fails closed rather than silently passing");
}

// ── Section 5: grading incompleteness ───────────────────────────────────────
{
  const tooHigh = evaluateMoundV2PromotionReadiness(goodEvidence({ pendingGradingRatio: 0.5 }));
  ok(!tooHigh.readyForPromotion && tooHigh.blockers.includes("EXCESSIVE_GRADING_INCOMPLETENESS"), "too large a fraction still pending (ungraded) blocks promotion — the evidence hasn't finished resolving");

  const unmeasurable = evaluateMoundV2PromotionReadiness(goodEvidence({ pendingGradingRatio: null }));
  ok(!unmeasurable.readyForPromotion && unmeasurable.blockers.includes("EXCESSIVE_GRADING_INCOMPLETENESS"), "no grading-coverage evidence supplied (null) fails closed");
}

// ── Section 5: worker/capture health ────────────────────────────────────────
{
  const tooHigh = evaluateMoundV2PromotionReadiness(goodEvidence({ workerJobFailureRatio: 0.3 }));
  ok(!tooHigh.readyForPromotion && tooHigh.blockers.includes("EXCESSIVE_WORKER_FAILURES"), "an excessive dead-letter rate among the durable outbox's worker jobs blocks promotion");

  const unmeasurable = evaluateMoundV2PromotionReadiness(goodEvidence({ workerJobFailureRatio: null }));
  ok(!unmeasurable.readyForPromotion && unmeasurable.blockers.includes("EXCESSIVE_WORKER_FAILURES"), "no worker-queue evidence supplied (null) fails closed");

  const evalTooHigh = evaluateMoundV2PromotionReadiness(goodEvidence({ shadowEvaluationFailureRatio: 0.3 }));
  ok(!evalTooHigh.readyForPromotion && evalTooHigh.blockers.includes("EXCESSIVE_SHADOW_CAPTURE_LOSS"), "an excessive shadow-EVALUATION failure rate (evaluateMoundV2Shadow itself throwing/reporting a failureReason) blocks promotion, distinctly from marketCoverage");

  // marketCoverage and shadowEvaluationFailureRatio are DIFFERENT signals —
  // a high failure rate must gate even when marketCoverage happens to look
  // fine (e.g. coverage math computed over a different/larger population).
  const highFailureButOkCoverage = evaluateMoundV2PromotionReadiness(goodEvidence({ shadowEvaluationFailureRatio: 0.3, marketCoverage: 0.95 }));
  ok(!highFailureButOkCoverage.readyForPromotion && highFailureButOkCoverage.blockers.includes("EXCESSIVE_SHADOW_CAPTURE_LOSS"), "excessive evaluation-failure rate blocks promotion even when marketCoverage itself looks healthy — coverage and capture-loss are gated independently");
}

// ── Section 5: undeclared model/policy version ──────────────────────────────
{
  const noModelVersion = evaluateMoundV2PromotionReadiness(goodEvidence({ v2ModelVersionDeclared: false }));
  ok(!noModelVersion.readyForPromotion && noModelVersion.blockers.includes("UNDECLARED_MODEL_OR_POLICY_VERSION"), "an undeclared probability-model version blocks promotion");

  const noPolicyVersion = evaluateMoundV2PromotionReadiness(goodEvidence({ v2ModelPolicyVersionDeclared: false }));
  ok(!noPolicyVersion.readyForPromotion && noPolicyVersion.blockers.includes("UNDECLARED_MODEL_OR_POLICY_VERSION"), "an undeclared model-policy version ALSO blocks promotion, independently of the probability-model version");
}

// ── Section 5: subgroup regression, with the minimum-sample-size exclusion ──
{
  // A large, clearly-regressed subgroup blocks promotion even though every
  // TOP-LEVEL (aggregate) metric is clean.
  const bigRegressedSubgroup = subgroup({ dimension: "sportsbook", key: "hardrockbet", sampleSize: 200, winRateDelta: -0.4, roiDelta: -0.5 });
  const verdict = evaluateMoundV2PromotionReadiness(goodEvidence({ subgroups: [subgroup(), bigRegressedSubgroup] }));
  ok(!verdict.readyForPromotion && verdict.blockers.includes("SEVERE_SUBGROUP_REGRESSION"), "a large, severely-regressed subgroup blocks promotion even when every top-level/aggregate metric is otherwise clean");
  ok(verdict.subgroupRegressions.length === 1 && verdict.subgroupRegressions[0].key === "hardrockbet", "the verdict names the SPECIFIC offending subgroup for diagnosability");

  // A tiny subgroup showing the SAME "regression" numbers must NOT gate —
  // avoids tiny-subgroup false decisiveness (explicitly required).
  const tinyRegressedSubgroup = subgroup({ dimension: "lineupStatus", key: "unconfirmed", sampleSize: 5, winRateDelta: -0.9, roiDelta: -0.9 });
  const tinyVerdict = evaluateMoundV2PromotionReadiness(goodEvidence({ subgroups: [subgroup(), tinyRegressedSubgroup] }));
  ok(tinyVerdict.readyForPromotion, "a tiny subgroup (below minSubgroupSampleSize) showing a severe regression does NOT block promotion on its own — avoids false decisiveness from a handful of samples");
  ok(tinyVerdict.subgroupRegressions.length === 0, "the tiny subgroup is not even listed as a regression (it never cleared the minimum sample size to be judged one way or the other)");

  // Exactly at the minimum sample size DOES count.
  const atMinSample = subgroup({ dimension: "dataQuality", key: "degraded", sampleSize: MOUND_V2_PROMOTION_THRESHOLDS.minSubgroupSampleSize, winRateDelta: -0.9, roiDelta: -0.9 });
  const atMinVerdict = evaluateMoundV2PromotionReadiness(goodEvidence({ subgroups: [subgroup(), atMinSample] }));
  ok(!atMinVerdict.readyForPromotion && atMinVerdict.blockers.includes("SEVERE_SUBGROUP_REGRESSION"), "a subgroup exactly AT the minimum sample size is judged (not exempted) — the exclusion is only for BELOW the threshold");

  // A subgroup with a null (unmeasurable) delta, at adequate sample size,
  // fails closed just like the top-level winRateDelta/roiDelta do.
  const nullDeltaSubgroup = subgroup({ dimension: "market", key: "pitcher_outs", sampleSize: 100, winRateDelta: null, roiDelta: null });
  const nullDeltaVerdict = evaluateMoundV2PromotionReadiness(goodEvidence({ subgroups: [subgroup(), nullDeltaSubgroup] }));
  ok(!nullDeltaVerdict.readyForPromotion && nullDeltaVerdict.blockers.includes("SEVERE_SUBGROUP_REGRESSION"), "a well-sampled subgroup with unmeasurable (null) deltas fails closed, exactly like the top-level metrics");

  // Multiple well-sampled, healthy subgroups never spuriously trigger the gate.
  const manyHealthy = Array.from({ length: 5 }, (_, i) => subgroup({ dimension: "market", key: `k${i}`, sampleSize: 80, winRateDelta: 0.01, roiDelta: 0.03 }));
  const healthyVerdict = evaluateMoundV2PromotionReadiness(goodEvidence({ subgroups: manyHealthy }));
  ok(healthyVerdict.readyForPromotion, "several well-sampled, genuinely healthy subgroups never spuriously trigger SEVERE_SUBGROUP_REGRESSION");
}

console.log(`\nmoundV2PromotionGate.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
