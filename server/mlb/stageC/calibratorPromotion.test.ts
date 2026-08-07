// MLB Stage C PR3 — calibrator auto-promotion planner invariants (pure).
//
// Run: npx tsx server/mlb/stageC/calibratorPromotion.test.ts

import {
  evaluateSegmentPromotion,
  planCalibratorPromotions,
} from "./calibratorPromotion";
import { MLB_CALIBRATION_ARTIFACT_VERSION, type MlbCalibrationArtifact } from "@shared/mlbCalibration";
import { MLB_PREDICTION_LEDGER_CONTRACT_VERSION } from "@shared/mlbPredictionLedger";
import { DEFAULT_MLB_POLICY_THRESHOLDS } from "../productionPolicy";
import type { WalkForwardResult } from "./walkForwardEvaluation";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const T = DEFAULT_MLB_POLICY_THRESHOLDS.promotion;

function artifact(segment: string, sampleSize = T.minDecidedPredictions, distinctSlateDates = T.minDistinctSlateDates): MlbCalibrationArtifact {
  return {
    segment, method: "reliability_isotonic_v1",
    bins: [
      { lo: 0.5, hi: 0.6, center: 0.55, count: sampleSize / 2, empiricalRate: 0.52, calibratedRate: 0.52 },
      { lo: 0.6, hi: 0.7, center: 0.65, count: sampleSize / 2, empiricalRate: 0.67, calibratedRate: 0.67 },
    ],
    fitStats: {
      sampleSize, distinctSlateDates, basePositiveRate: 0.55,
      rawBrier: 0.28, calibratedBrier: 0.23, rawLogLoss: 0.7, calibratedLogLoss: 0.6,
      rawEcePct: 9, calibratedEcePct: 2, inSample: true,
    },
    builtAtMs: 1_700_000_000_000,
    ledgerContractVersion: MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
    artifactVersion: MLB_CALIBRATION_ARTIFACT_VERSION,
  };
}

// A walk-forward result that clears every gate criterion.
function passingWf(segment: string): WalkForwardResult {
  return {
    segment, hasHeldOutEvidence: true, folds: 15,
    validationSampleSize: T.minDecidedPredictions, validationDistinctSlateDates: T.minDistinctSlateDates,
    heldOutRawBrier: 0.28, heldOutCalibratedBrier: 0.23, heldOutEcePct: 2,
    forwardRoiUnits: 5.5, forwardBetsPlaced: 120, tierMonotonic: true,
  };
}

// Passing evidence ⇒ ready.
{
  const d = evaluateSegmentPromotion("hits", artifact("hits"), passingWf("hits"), T);
  ok(d.ready && d.reasons.length === 0, "complete passing held-out evidence ⇒ ready");
  ok(d.snapshot.usedOutOfSample === true && d.snapshot.heldOutSampleSize === T.minDecidedPredictions, "snapshot records out-of-sample held-out evidence");
  ok(d.snapshot.forwardRoiUnits === 5.5 && d.snapshot.tierMonotonic === true, "snapshot carries forward ROI + tier monotonicity");
}

// No held-out evidence ⇒ blocks as held_out_evidence_incomplete (NEVER in-sample).
{
  const noWf: WalkForwardResult = { ...passingWf("hits"), hasHeldOutEvidence: false, heldOutCalibratedBrier: null, heldOutRawBrier: null, heldOutEcePct: null };
  const d = evaluateSegmentPromotion("hits", artifact("hits"), noWf, T);
  ok(!d.ready && d.reasons.includes("held_out_evidence_incomplete"), "no walk-forward evidence ⇒ blocked (fail-closed, no in-sample fallback)");
  ok(!d.reasons.includes("in_sample_only"), "does NOT fall through to in_sample_only (evidence was claimed)");
}

// Undefined walk-forward (segment never evaluated) ⇒ also blocked incomplete.
{
  const d = evaluateSegmentPromotion("hits", artifact("hits"), undefined, T);
  ok(!d.ready && d.reasons.includes("held_out_evidence_incomplete"), "missing walk-forward ⇒ blocked incomplete");
}

// Held-out calibrated Brier not improving on raw ⇒ blocked.
{
  const wf: WalkForwardResult = { ...passingWf("hits"), heldOutCalibratedBrier: 0.28, heldOutRawBrier: 0.28 };
  const d = evaluateSegmentPromotion("hits", artifact("hits"), wf, T);
  ok(!d.ready && d.reasons.includes("no_brier_improvement"), "no held-out Brier improvement ⇒ blocked");
}

// Negative forward ROI ⇒ blocked.
{
  const wf: WalkForwardResult = { ...passingWf("hits"), forwardRoiUnits: -3 };
  const d = evaluateSegmentPromotion("hits", artifact("hits"), wf, T);
  ok(!d.ready && d.reasons.includes("forward_roi_not_positive_or_unknown"), "negative forward ROI ⇒ blocked");
}

// Non-monotonic tiers ⇒ blocked.
{
  const wf: WalkForwardResult = { ...passingWf("hits"), tierMonotonic: false };
  const d = evaluateSegmentPromotion("hits", artifact("hits"), wf, T);
  ok(!d.ready && d.reasons.includes("tier_not_monotonic_or_unknown"), "non-monotonic tiers ⇒ blocked");
}

// Plan with flag OFF ⇒ EMPTY (no writes) even for a passing segment.
{
  const plan = planCalibratorPromotions({
    artifacts: { hits: artifact("hits") },
    walkForward: { hits: passingWf("hits") },
    activeSegments: new Set(),
    enabled: false,
  });
  ok(!plan.enabled && plan.activate.length === 0 && plan.deactivate.length === 0, "flag OFF ⇒ empty plan (nothing written)");
  ok(plan.decisions.length === 1 && plan.decisions[0].ready, "flag OFF still evaluates for logging visibility");
}

// Plan with flag ON ⇒ passing segment activated.
{
  const plan = planCalibratorPromotions({
    artifacts: { hits: artifact("hits") },
    walkForward: { hits: passingWf("hits") },
    activeSegments: new Set(),
    enabled: true,
  });
  ok(plan.enabled && plan.activate.length === 1 && plan.activate[0].segment === "hits", "flag ON + passing ⇒ activation planned");
  ok(plan.deactivate.length === 0, "no deactivation for a passing segment");
}

// Flag ON: a currently-active segment that now FAILS ⇒ deactivated.
{
  const failWf: WalkForwardResult = { ...passingWf("total_bases"), forwardRoiUnits: -2 };
  const plan = planCalibratorPromotions({
    artifacts: { total_bases: artifact("total_bases") },
    walkForward: { total_bases: failWf },
    activeSegments: new Set(["total_bases"]),
    enabled: true,
  });
  ok(plan.activate.length === 0 && plan.deactivate.length === 1, "active segment that no longer qualifies ⇒ deactivated");
  ok(plan.deactivate[0].segment === "total_bases" && plan.deactivate[0].reason.startsWith("no_longer_qualifies:"), "deactivation carries a reason");
}

// Flag ON: a NON-active segment that fails is simply not activated (no spurious deactivate).
{
  const failWf: WalkForwardResult = { ...passingWf("hrr"), tierMonotonic: false };
  const plan = planCalibratorPromotions({
    artifacts: { hrr: artifact("hrr") },
    walkForward: { hrr: failWf },
    activeSegments: new Set(),
    enabled: true,
  });
  ok(plan.activate.length === 0 && plan.deactivate.length === 0, "failing non-active segment ⇒ neither activated nor deactivated");
}

console.log(`\ncalibratorPromotion.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
