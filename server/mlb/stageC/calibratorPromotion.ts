// ── MLB Live Edge Stage C PR3 — calibrator auto-promotion planner ────────────
// Pure decision layer that turns (full-data fitted artifacts + walk-forward
// held-out evidence + currently-active registry state) into a concrete plan of
// activations and deactivations. It runs the SAME calibratorPromotionGate every
// candidate must clear — the only new thing is that the evidence is now the real
// OUT-OF-SAMPLE walk-forward result, so a segment can actually pass.
//
// Fail-closed and flag-gated:
//   * When the master switch is off, the plan is EMPTY (the runner writes
//     nothing to the registry — production stays calibratedProbability = null).
//   * A segment is activated only when the gate passes on COMPLETE held-out
//     evidence (calibratorPromotionGate enforces completeness; a missing metric
//     blocks). No in-sample fallback ever reaches an activation.
//   * A currently-active segment that is re-evaluated this run and no longer
//     passes is DEACTIVATED. A segment with no data this run is left as-is
//     (transient absence is not a promotion regression) — documented, not silent.
//
// Pure: no I/O, no clock. The runner supplies the artifacts, evidence, active
// set, flag, and clock, and applies the returned plan via storage.

import type { MlbCalibrationArtifact, MlbCalibratorPromotionSnapshot } from "@shared/mlbCalibration";
import { DEFAULT_MLB_POLICY_THRESHOLDS, type MlbPromotionThresholds } from "../productionPolicy";
import { evaluateCalibratorPromotionReadiness } from "./calibratorPromotionGate";
import type { WalkForwardResult } from "./walkForwardEvaluation";

export interface CalibratorPromotionDecision {
  segment: string;
  ready: boolean;
  reasons: string[];
  snapshot: MlbCalibratorPromotionSnapshot;
}

export interface CalibratorActivation {
  segment: string;
  artifact: MlbCalibrationArtifact;
  snapshot: MlbCalibratorPromotionSnapshot;
}

export interface CalibratorDeactivation {
  segment: string;
  reason: string;
}

export interface CalibratorPromotionPlan {
  enabled: boolean;
  activate: CalibratorActivation[];
  deactivate: CalibratorDeactivation[];
  decisions: CalibratorPromotionDecision[]; // every evaluated segment, for logging
}

/** Builds the frozen promotion-evidence snapshot from the gate result + the
 *  walk-forward metrics. Pure. */
function buildSnapshot(
  gate: ReturnType<typeof evaluateCalibratorPromotionReadiness>,
  wf: WalkForwardResult | undefined,
): MlbCalibratorPromotionSnapshot {
  return {
    usedOutOfSample: gate.usedOutOfSample,
    evaluatedBrier: gate.evaluatedBrier,
    evaluatedRawBrier: gate.evaluatedRawBrier,
    evaluatedEcePct: gate.evaluatedEcePct,
    heldOutSampleSize: wf?.validationSampleSize ?? 0,
    heldOutDistinctSlateDates: wf?.validationDistinctSlateDates ?? 0,
    forwardRoiUnits: wf?.forwardRoiUnits ?? null,
    forwardBetsPlaced: wf?.forwardBetsPlaced ?? 0,
    tierMonotonic: wf?.tierMonotonic ?? null,
    gateReasons: gate.reasons,
  };
}

/**
 * Evaluates one segment's promotion readiness against its walk-forward evidence.
 * When the walk-forward produced no held-out evidence, the gate is fed
 * outOfSample=true with null metrics ⇒ it blocks on `held_out_evidence_incomplete`
 * (fail-closed — never an in-sample pass). Pure.
 */
export function evaluateSegmentPromotion(
  segment: string,
  artifact: MlbCalibrationArtifact,
  walkForward: WalkForwardResult | undefined,
  thresholds: MlbPromotionThresholds = DEFAULT_MLB_POLICY_THRESHOLDS.promotion,
): CalibratorPromotionDecision {
  const hasEvidence = walkForward?.hasHeldOutEvidence === true;
  const gate = evaluateCalibratorPromotionReadiness(
    {
      artifact,
      // Always claim out-of-sample so a missing metric fails as
      // `held_out_evidence_incomplete`, never silently falls back to in-sample.
      outOfSample: true,
      heldOutBrier: hasEvidence ? walkForward!.heldOutCalibratedBrier : null,
      heldOutRawBrier: hasEvidence ? walkForward!.heldOutRawBrier : null,
      heldOutEcePct: hasEvidence ? walkForward!.heldOutEcePct : null,
      forwardRoiUnits: walkForward?.forwardRoiUnits ?? null,
      tierMonotonic: walkForward?.tierMonotonic ?? null,
    },
    thresholds,
  );
  return { segment, ready: gate.ready, reasons: gate.reasons, snapshot: buildSnapshot(gate, walkForward) };
}

/**
 * Produces the full activation/deactivation plan. Pure — the runner applies it.
 * When `enabled` is false the plan is empty (nothing is written to the registry).
 */
export function planCalibratorPromotions(args: {
  artifacts: Record<string, MlbCalibrationArtifact>;
  walkForward: Record<string, WalkForwardResult>;
  activeSegments: ReadonlySet<string>;
  enabled: boolean;
  thresholds?: MlbPromotionThresholds;
}): CalibratorPromotionPlan {
  const thresholds = args.thresholds ?? DEFAULT_MLB_POLICY_THRESHOLDS.promotion;
  const decisions: CalibratorPromotionDecision[] = [];
  const activate: CalibratorActivation[] = [];
  const deactivate: CalibratorDeactivation[] = [];

  if (!args.enabled) {
    // Flag off ⇒ evaluate for logging visibility but write nothing.
    for (const segment of Object.keys(args.artifacts)) {
      decisions.push(evaluateSegmentPromotion(segment, args.artifacts[segment], args.walkForward[segment], thresholds));
    }
    return { enabled: false, activate: [], deactivate: [], decisions };
  }

  for (const segment of Object.keys(args.artifacts)) {
    const decision = evaluateSegmentPromotion(segment, args.artifacts[segment], args.walkForward[segment], thresholds);
    decisions.push(decision);
    if (decision.ready) {
      activate.push({ segment, artifact: args.artifacts[segment], snapshot: decision.snapshot });
    } else if (args.activeSegments.has(segment)) {
      // Re-evaluated this run and no longer qualifies ⇒ pull it live.
      deactivate.push({ segment, reason: `no_longer_qualifies:${decision.reasons.join(",") || "unknown"}` });
    }
  }

  return { enabled: true, activate, deactivate, decisions };
}
