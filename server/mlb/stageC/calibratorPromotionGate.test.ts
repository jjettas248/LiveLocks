// MLB Stage C — calibrator promotion-readiness gate invariants (never applies).
//
// Run: npx tsx server/mlb/stageC/calibratorPromotionGate.test.ts

import { evaluateCalibratorPromotionReadiness, type CalibratorPromotionEvidence } from "./calibratorPromotionGate";
import { MLB_CALIBRATION_ARTIFACT_VERSION, type MlbCalibrationArtifact } from "@shared/mlbCalibration";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// Default thresholds (productionPolicy): minDecided 200, minDistinctSlateDates 20,
// maxBrier 0.25, maxEcePct 5, requirePositiveForwardRoi true, requireTierMonotonicity true.
function art(fit: Partial<MlbCalibrationArtifact["fitStats"]>): MlbCalibrationArtifact {
  return {
    segment: "hits", method: "reliability_isotonic_v1", bins: [{ lo: 0, hi: 1, center: 0.5, count: 300, empiricalRate: 0.5, calibratedRate: 0.5 }],
    fitStats: {
      sampleSize: 300, distinctSlateDates: 25, basePositiveRate: 0.5,
      rawBrier: 0.30, calibratedBrier: 0.20, rawLogLoss: 0.7, calibratedLogLoss: 0.6,
      rawEcePct: 8, calibratedEcePct: 3, inSample: true, ...fit,
    },
    builtAtMs: 1, ledgerContractVersion: "mlb_prediction_ledger_v1", artifactVersion: MLB_CALIBRATION_ARTIFACT_VERSION,
  };
}

// In-sample only ⇒ never ready (a model can't be promoted on its own fit set)
{
  const r = evaluateCalibratorPromotionReadiness({ artifact: art({}) });
  ok(!r.ready, "in-sample artifact is not promotion-ready");
  ok(r.reasons.includes("in_sample_only"), "reason: in_sample_only");
}

// Fully-qualified out-of-sample evidence ⇒ ready
{
  const ev: CalibratorPromotionEvidence = {
    artifact: art({}),
    outOfSample: true,
    heldOutBrier: 0.20, heldOutRawBrier: 0.30, heldOutEcePct: 3,
    forwardRoiUnits: 4.2, tierMonotonic: true,
  };
  const r = evaluateCalibratorPromotionReadiness(ev);
  ok(r.ready && r.reasons.length === 0, "all criteria met (held-out) ⇒ ready");
  ok(r.usedOutOfSample && r.evaluatedBrier === 0.20 && r.evaluatedRawBrier === 0.30, "held-out metrics used");
}

// Insufficient sample / slate dates ⇒ blocked
{
  const r = evaluateCalibratorPromotionReadiness({
    artifact: art({ sampleSize: 50, distinctSlateDates: 5 }),
    outOfSample: true, heldOutBrier: 0.2, heldOutRawBrier: 0.3, heldOutEcePct: 3,
    forwardRoiUnits: 1, tierMonotonic: true,
  });
  ok(!r.ready && r.reasons.includes("insufficient_sample") && r.reasons.includes("insufficient_slate_dates"), "small sample + few dates ⇒ blocked");
}

// No Brier improvement ⇒ blocked even if under the cap
{
  const r = evaluateCalibratorPromotionReadiness({
    artifact: art({}), outOfSample: true,
    heldOutBrier: 0.24, heldOutRawBrier: 0.23, heldOutEcePct: 3, // calibrated worse than raw
    forwardRoiUnits: 1, tierMonotonic: true,
  });
  ok(!r.ready && r.reasons.includes("no_brier_improvement"), "calibrated not better than raw ⇒ no_brier_improvement");
}

// Brier above cap / ECE above cap ⇒ blocked
{
  const r = evaluateCalibratorPromotionReadiness({
    artifact: art({}), outOfSample: true,
    heldOutBrier: 0.30, heldOutRawBrier: 0.40, heldOutEcePct: 9,
    forwardRoiUnits: 1, tierMonotonic: true,
  });
  ok(r.reasons.includes("calibrated_brier_above_max") && r.reasons.includes("ece_above_max"), "over-cap Brier + ECE ⇒ blocked");
}

// Missing forward ROI / tier monotonicity ⇒ fail-closed
{
  const r = evaluateCalibratorPromotionReadiness({
    artifact: art({}), outOfSample: true,
    heldOutBrier: 0.2, heldOutRawBrier: 0.3, heldOutEcePct: 3,
    forwardRoiUnits: null, tierMonotonic: null,
  });
  ok(r.reasons.includes("forward_roi_not_positive_or_unknown"), "unknown forward ROI ⇒ blocked (fail-closed)");
  ok(r.reasons.includes("tier_not_monotonic_or_unknown"), "unknown tier monotonicity ⇒ blocked (fail-closed)");
}

// Negative forward ROI ⇒ blocked
{
  const r = evaluateCalibratorPromotionReadiness({
    artifact: art({}), outOfSample: true,
    heldOutBrier: 0.2, heldOutRawBrier: 0.3, heldOutEcePct: 3,
    forwardRoiUnits: -1.5, tierMonotonic: true,
  });
  ok(r.reasons.includes("forward_roi_not_positive_or_unknown"), "negative forward ROI ⇒ blocked");
}

console.log(`\ncalibratorPromotionGate.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
