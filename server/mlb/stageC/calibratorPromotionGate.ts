// ── MLB Live Edge Stage C — calibrator promotion-readiness gate ──────────────
// A pure CHECKER that decides whether a fitted calibration artifact has cleared
// the bar to be considered for promotion into the live engine. It is NEVER
// auto-applied — exactly like server/mlb/pregame/mound/v2/moundV2PromotionGate.ts.
// Promotion (wiring an artifact so mlbProductionLane stops returning
// calibratedProbability = null for a segment) is a separate, explicit,
// human-reviewed step that does not exist yet. This function only reports
// readiness + the reasons a candidate fell short.
//
// Fail-closed throughout: any missing/insufficient evidence is a BLOCK, never a
// pass. Thresholds default to productionPolicy.ts's single-owner
// MlbPromotionThresholds so the bar lives in one place.

import { DEFAULT_MLB_POLICY_THRESHOLDS, type MlbPromotionThresholds } from "../productionPolicy";
import type { MlbCalibrationArtifact } from "@shared/mlbCalibration";

export interface CalibratorPromotionEvidence {
  artifact: MlbCalibrationArtifact;
  // The artifact's fitStats are IN-SAMPLE. Promotion requires held-out /
  // walk-forward metrics: pass them here and set outOfSample = true. When
  // omitted, the in-sample fitStats are used and the gate blocks on
  // `in_sample_only` (a fit can always overfit itself).
  outOfSample?: boolean;
  heldOutBrier?: number | null;
  heldOutRawBrier?: number | null;
  heldOutEcePct?: number | null;
  // Forward captured-price ROI (units) on held-out predictions, null if unknown.
  forwardRoiUnits?: number | null;
  // Whether higher setup/tier bands show monotonically-non-decreasing hit rates
  // on held-out data, null if unknown.
  tierMonotonic?: boolean | null;
}

export type CalibratorPromotionReason =
  | "insufficient_sample"
  | "insufficient_slate_dates"
  | "in_sample_only"
  | "held_out_evidence_incomplete"
  | "calibrated_brier_above_max"
  | "no_brier_improvement"
  | "ece_above_max"
  | "forward_roi_not_positive_or_unknown"
  | "tier_not_monotonic_or_unknown";

export interface CalibratorPromotionResult {
  ready: boolean;
  reasons: CalibratorPromotionReason[];
  // Echo of the effective (held-out if provided, else in-sample) metrics used.
  evaluatedBrier: number;
  evaluatedRawBrier: number;
  evaluatedEcePct: number;
  usedOutOfSample: boolean;
}

/**
 * Evaluates promotion readiness. Returns { ready, reasons }. Pure; never mutates
 * anything and NEVER promotes — a `ready: true` result is an invitation for a
 * human-reviewed promotion, not the promotion itself.
 */
export function evaluateCalibratorPromotionReadiness(
  evidence: CalibratorPromotionEvidence,
  thresholds: MlbPromotionThresholds = DEFAULT_MLB_POLICY_THRESHOLDS.promotion,
): CalibratorPromotionResult {
  const reasons: CalibratorPromotionReason[] = [];
  const fit = evidence.artifact.fitStats;

  // Out-of-sample evidence must be COMPLETE to be trusted. A caller claiming
  // outOfSample=true while leaving any held-out metric null must NOT silently
  // fall back to the in-sample fit and pass — that is the exact overfit
  // promotion this gate exists to prevent. Fail-closed: incomplete held-out
  // evidence blocks, and the evaluated metrics stay coherently in-sample (never
  // a held-out-vs-in-sample mix), since the result is blocked regardless.
  const hasCompleteHeldOut =
    evidence.outOfSample === true &&
    evidence.heldOutBrier != null &&
    evidence.heldOutRawBrier != null &&
    evidence.heldOutEcePct != null;
  const usedOutOfSample = hasCompleteHeldOut;

  const evaluatedBrier = hasCompleteHeldOut ? evidence.heldOutBrier! : fit.calibratedBrier;
  const evaluatedRawBrier = hasCompleteHeldOut ? evidence.heldOutRawBrier! : fit.rawBrier;
  const evaluatedEcePct = hasCompleteHeldOut ? evidence.heldOutEcePct! : fit.calibratedEcePct;

  if (fit.sampleSize < thresholds.minDecidedPredictions) reasons.push("insufficient_sample");
  if (fit.distinctSlateDates < thresholds.minDistinctSlateDates) reasons.push("insufficient_slate_dates");

  // A model cannot be promoted on the same data it was fit to. Distinguish
  // "no out-of-sample evidence offered" from "out-of-sample claimed but
  // incomplete" so the caller knows which — both block.
  if (!usedOutOfSample) {
    reasons.push(evidence.outOfSample === true ? "held_out_evidence_incomplete" : "in_sample_only");
  }

  if (!(evaluatedBrier <= thresholds.maxBrier)) reasons.push("calibrated_brier_above_max");
  // Calibration must IMPROVE on the raw probabilities, not merely be under the cap.
  if (!(evaluatedBrier < evaluatedRawBrier)) reasons.push("no_brier_improvement");

  if (!(evaluatedEcePct <= thresholds.maxExpectedCalibrationErrorPct)) reasons.push("ece_above_max");

  if (thresholds.requirePositiveForwardRoi) {
    if (evidence.forwardRoiUnits == null || !(evidence.forwardRoiUnits > 0)) {
      reasons.push("forward_roi_not_positive_or_unknown");
    }
  }
  if (thresholds.requireTierMonotonicity) {
    if (evidence.tierMonotonic !== true) reasons.push("tier_not_monotonic_or_unknown");
  }

  return {
    ready: reasons.length === 0,
    reasons,
    evaluatedBrier,
    evaluatedRawBrier,
    evaluatedEcePct,
    usedOutOfSample,
  };
}
