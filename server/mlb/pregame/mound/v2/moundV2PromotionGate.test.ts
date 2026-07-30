// Mound V2 promotion-readiness gate — invariants.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2PromotionGate.test.ts

import { evaluateMoundV2PromotionReadiness, MOUND_V2_PROMOTION_THRESHOLDS, type MoundV2PromotionEvidence } from "./moundV2PromotionGate";

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
    ...overrides,
  };
}

// ── Fully clean evidence is ready for promotion ─────────────────────────────
{
  const verdict = evaluateMoundV2PromotionReadiness(goodEvidence());
  ok(verdict.readyForPromotion === true, "clean evidence across every criterion is ready for promotion");
  ok(verdict.blockers.length === 0, "no blockers are reported when every criterion passes");
  ok(verdict.probabilityComparator === "climatology", "the verdict restates which comparator the probability criteria were checked against");
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

console.log(`\nmoundV2PromotionGate.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
