// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: probability calibration (DEFERRED / identity)
//
// IMPORTANT: empirical calibration against historical HR outcomes is a DEFERRED
// FUTURE PHASE (it requires a historical outcome join / backtest, which is
// explicitly out of scope for this task). This function is therefore an
// INTENTIONAL IDENTITY pass-through that only enforces the [0,1] bound. It does
// NOT fit, rescale, or shift the probability against any realized data.
//
// It exists so the pipeline has a stable seam: when a fitted calibrator (e.g.
// isotonic / Platt) is built in a future phase, it drops in HERE without changing
// any caller. Until then, `method` is reported as "identity_uncalibrated" so no
// downstream consumer mistakes the output for a calibrated probability.
// ─────────────────────────────────────────────────────────────────────────────

import { clamp01 } from "./normalizeStats";

export interface CalibrationResult {
  calibrated: number | null;
  diagnostics: {
    method: "identity_uncalibrated";
    note: string;
    input: number | null;
  };
}

export function calibratePregameHrProbability(p: number | null | undefined): CalibrationResult {
  const note =
    "Uncalibrated passthrough — empirical calibration deferred to a future phase " +
    "that requires a historical outcome backtest.";
  if (p == null || !Number.isFinite(p)) {
    return { calibrated: null, diagnostics: { method: "identity_uncalibrated", note, input: null } };
  }
  const calibrated = clamp01(p);
  return {
    calibrated,
    diagnostics: { method: "identity_uncalibrated", note, input: p },
  };
}
