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
    sampleSize: 500,
    strikeoutsCalibrationErrorDelta: -0.01,
    strikeoutsBrierDelta: -0.005,
    strikeoutsLogLossDelta: -0.02,
    marketCoverage: 0.9,
    settlementOrProvenanceRegressionDetected: false,
    ...overrides,
  };
}

// ── Fully clean evidence is ready for promotion ─────────────────────────────
{
  const verdict = evaluateMoundV2PromotionReadiness(goodEvidence());
  ok(verdict.readyForPromotion === true, "clean evidence across every criterion is ready for promotion");
  ok(verdict.blockers.length === 0, "no blockers are reported when every criterion passes");
}

// ── Insufficient sample size blocks regardless of everything else ─────────
{
  const verdict = evaluateMoundV2PromotionReadiness(goodEvidence({ sampleSize: 50 }));
  ok(!verdict.readyForPromotion, "a small sample size blocks promotion");
  ok(verdict.blockers.includes("INSUFFICIENT_SAMPLE_SIZE"), "the specific blocker is reported");
}

// ── Any statistical regression (positive delta = worse than baseline) blocks ──
{
  const calibrationWorse = evaluateMoundV2PromotionReadiness(goodEvidence({ strikeoutsCalibrationErrorDelta: 0.02 }));
  ok(!calibrationWorse.readyForPromotion && calibrationWorse.blockers.includes("CALIBRATION_NOT_IMPROVED"), "worse calibration than baseline blocks promotion");

  const brierWorse = evaluateMoundV2PromotionReadiness(goodEvidence({ strikeoutsBrierDelta: 0.01 }));
  ok(!brierWorse.readyForPromotion && brierWorse.blockers.includes("BRIER_NOT_IMPROVED"), "worse Brier score than baseline blocks promotion");

  const logLossWorse = evaluateMoundV2PromotionReadiness(goodEvidence({ strikeoutsLogLossDelta: 0.03 }));
  ok(!logLossWorse.readyForPromotion && logLossWorse.blockers.includes("LOG_LOSS_NOT_IMPROVED"), "worse log loss than baseline blocks promotion");
}

// ── Thin market coverage blocks promotion ───────────────────────────────────
{
  const verdict = evaluateMoundV2PromotionReadiness(goodEvidence({ marketCoverage: 0.4 }));
  ok(!verdict.readyForPromotion && verdict.blockers.includes("INSUFFICIENT_MARKET_COVERAGE"), "thin market coverage blocks promotion");
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
    goodEvidence({ sampleSize: 10, marketCoverage: 0.1, settlementOrProvenanceRegressionDetected: true }),
  );
  ok(verdict.blockers.length === 3, `all three simultaneous failures are reported (got ${verdict.blockers.length}: ${verdict.blockers.join(", ")})`);
}

// ── Threshold boundaries are exact (>=, not >) ──────────────────────────────
{
  const atThreshold = evaluateMoundV2PromotionReadiness(goodEvidence({ sampleSize: MOUND_V2_PROMOTION_THRESHOLDS.minSampleSize }));
  ok(!atThreshold.blockers.includes("INSUFFICIENT_SAMPLE_SIZE"), "a sample size exactly at the minimum threshold is sufficient (not a strict >)");
  const belowThreshold = evaluateMoundV2PromotionReadiness(goodEvidence({ sampleSize: MOUND_V2_PROMOTION_THRESHOLDS.minSampleSize - 1 }));
  ok(belowThreshold.blockers.includes("INSUFFICIENT_SAMPLE_SIZE"), "one below the minimum threshold is insufficient");
}

console.log(`\nmoundV2PromotionGate.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
