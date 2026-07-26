// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — Platt-scaling calibrator (PR 2).
//
// A real, fitted calibrator — deliberately its OWN type, never
// math/calibratePregameHrProbability.ts's CalibrationResult. That type's
// diagnostics.method is the single string literal "identity_uncalibrated"
// (not a union), so a real calibrator's "platt_scaled" literally cannot
// satisfy it — reusing the type isn't an option, and that file itself is
// never edited (it's the permanent designed placeholder; replacing it is
// explicitly documented in its own code as a "future phase," and this new
// file alongside it IS that future phase, not a rewrite of the placeholder).
//
// Platt scaling is mathematically a 1-feature logistic regression:
// calibrated = sigmoid(a * logit(rawProbability) + b). Rather than a second
// gradient-descent implementation, this reuses fitRegularizedTermModel from
// math/fitShadowTermWeights.ts as a library with one synthetic feature — the
// same "import math/'s tested functions" discipline the whole PR1->PR2
// lineage follows — and the free L2 shrinkage is a genuine improvement over
// naive Platt scaling on small calibration sets (shrinks toward "trust the
// raw score less" when data is thin, rather than overfitting).
// ─────────────────────────────────────────────────────────────────────────────

import { fitRegularizedTermModel, type ShadowHrTrainingRow } from "../math/fitShadowTermWeights";
import { sigmoid, logit, clamp01 } from "../math/normalizeStats";

export interface PlateHrV2CalibrationResult {
  calibrated: number | null;
  diagnostics: {
    method: "platt_scaled" | "insufficient_data_uncalibrated";
    note: string;
    input: number | null;
    a: number | null;
    b: number | null;
  };
}

export interface PlateHrV2CalibratorModel {
  a: number;
  b: number;
  trainedRows: number;
  l2: number;
  sufficientData: boolean;
}

const CALIBRATION_FEATURE_KEY = "logitRaw";
const DEFAULT_MIN_ROWS = 50;
const DEFAULT_L2 = 0.05; // lighter than fitShadowTermWeights.ts's own 0.1 default — a single, well-conditioned feature needs less shrinkage than a 10-term model.

/**
 * Fit a Platt-scaling calibrator. Below `minRows` (default 50), returns an
 * explicit identity model (a:1, b:0 — sigmoid(1*logit(p)+0) === p) rather
 * than fitting on too little data, and flags sufficientData:false so
 * applyPlateHrV2Calibrator never reports a fit that didn't happen.
 */
export function fitPlateHrV2Calibrator(
  rows: Array<{ rawProbability: number; homered: 0 | 1; frozenAt: string }>,
  options: { l2?: number; iterations?: number; learningRate?: number; minRows?: number } = {},
): PlateHrV2CalibratorModel {
  const l2 = options.l2 ?? DEFAULT_L2;
  const minRows = options.minRows ?? DEFAULT_MIN_ROWS;

  if (rows.length < minRows) {
    return { a: 1, b: 0, trainedRows: rows.length, l2, sufficientData: false };
  }

  const trainingRows: ShadowHrTrainingRow[] = rows.map((r) => ({
    frozenAt: r.frozenAt,
    homered: r.homered,
    terms: { [CALIBRATION_FEATURE_KEY]: logit(clamp01(r.rawProbability)) },
  }));

  const fitted = fitRegularizedTermModel(trainingRows, [CALIBRATION_FEATURE_KEY], {
    l2,
    iterations: options.iterations,
    learningRate: options.learningRate,
  });

  return {
    a: fitted.coefficients[CALIBRATION_FEATURE_KEY],
    b: fitted.intercept,
    trainedRows: fitted.trainedRows,
    l2,
    sufficientData: true,
  };
}

/** Pure, total — never throws on null/NaN/out-of-range input. */
export function applyPlateHrV2Calibrator(
  model: PlateHrV2CalibratorModel,
  rawProbability: number | null | undefined,
): PlateHrV2CalibrationResult {
  const method: PlateHrV2CalibrationResult["diagnostics"]["method"] =
    model.sufficientData ? "platt_scaled" : "insufficient_data_uncalibrated";
  const note = model.sufficientData
    ? `Platt-scaled (a=${model.a.toFixed(3)}, b=${model.b.toFixed(3)}, trainedRows=${model.trainedRows})`
    : `Insufficient calibration data (trainedRows=${model.trainedRows}) — identity passthrough, not a real fit`;

  if (rawProbability == null || !Number.isFinite(rawProbability)) {
    return { calibrated: null, diagnostics: { method, note, input: null, a: model.a, b: model.b } };
  }

  const p = clamp01(rawProbability);
  const calibrated = clamp01(sigmoid(model.a * logit(p) + model.b));
  return { calibrated, diagnostics: { method, note, input: rawProbability, a: model.a, b: model.b } };
}
