// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — fit + walk-forward evaluation orchestrator (PR 2).
//
// Pure (no I/O) — wraps math/fitShadowTermWeights.ts's walkForwardFit /
// fitRegularizedTermModel / evaluateTermModel / predictTermModel (imported,
// never modified) plus this PR's own Platt calibrator into one call that a
// thin script (scripts/backtestPlateHrV2.ts) or a future PR's caller can use
// end-to-end. Given zero real captured data exists anywhere yet, this file's
// correctness is proven via synthetic fixtures with a planted relationship —
// same posture as every other file in this PR.
// ─────────────────────────────────────────────────────────────────────────────

import {
  walkForwardFit,
  fitRegularizedTermModel,
  evaluateTermModel,
  predictTermModel,
  type ShadowHrTrainingRow,
  type LogisticTermModel,
  type BinaryMetrics,
  type WalkForwardFold,
} from "../math/fitShadowTermWeights";
import { PLATE_HR_V2_SHADOW_TERM_KEYS } from "./plateHrV2ShadowTrainingRow";
import { fitPlateHrV2Calibrator, applyPlateHrV2Calibrator, type PlateHrV2CalibratorModel } from "./plateHrV2Calibrator";

export interface PlateHrV2ShadowFittingOptions {
  featureKeys?: string[];
  l2?: number;
  /** Passed through to walkForwardFit (the fitter's own defaults apply per fold — iterations/learningRate aren't tunable per fold without editing math/fitShadowTermWeights.ts). */
  minTrainRows?: number;
  testRows?: number;
  /** Size of the middle calibration slice; defaults to testRows. */
  calibrationRows?: number;
  /** Only affects the final full/term-train fit, not the per-fold walk-forward fits. */
  finalFitIterations?: number;
  finalFitLearningRate?: number;
}

export interface PlateHrV2ShadowFittingResult {
  featureKeys: string[];
  totalRows: number;
  walkForwardFolds: WalkForwardFold[];
  finalTermModel: LogisticTermModel;
  finalTermModelSampleWindow: { start: string | null; end: string | null };
  calibrator: PlateHrV2CalibratorModel;
  calibratorSampleWindow: { start: string | null; end: string | null };
  holdoutMetrics: {
    raw: BinaryMetrics;
    calibrated: BinaryMetrics;
    rows: number;
    window: { start: string | null; end: string | null };
  } | null;
}

function sortedByFrozenAt(rows: ShadowHrTrainingRow[]): ShadowHrTrainingRow[] {
  return rows
    .filter((r) => Number.isFinite(Date.parse(r.frozenAt)))
    .slice()
    .sort((a, b) => Date.parse(a.frozenAt) - Date.parse(b.frozenAt));
}

function windowOf(rows: ShadowHrTrainingRow[]): { start: string | null; end: string | null } {
  if (rows.length === 0) return { start: null, end: null };
  return { start: rows[0].frozenAt, end: rows[rows.length - 1].frozenAt };
}

/**
 * Mirrors evaluateTermModel's Brier/logLoss math, but over already-computed
 * (possibly two-stage: term-model then calibrator) probabilities rather than
 * a single LogisticTermModel + raw terms — evaluateTermModel itself can't
 * express "score with model A, then re-map with model B," so this is a
 * small, deliberate, minimal duplication of its scoring formula, not an
 * import/modification of math/.
 */
function binaryMetricsFromPredictions(predictions: Array<{ p: number; y: 0 | 1 }>): BinaryMetrics {
  if (predictions.length === 0) return { rows: 0, brier: 0, logLoss: 0, observedRate: 0, meanPrediction: 0 };
  let brier = 0;
  let logLoss = 0;
  let observed = 0;
  let predicted = 0;
  for (const { p: pRaw, y } of predictions) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, pRaw));
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    observed += y;
    predicted += p;
  }
  return {
    rows: predictions.length,
    brier: brier / predictions.length,
    logLoss: logLoss / predictions.length,
    observedRate: observed / predictions.length,
    meanPrediction: predicted / predictions.length,
  };
}

/**
 * Fit a term model + calibrator from historical training rows and report
 * walk-forward + (when enough data exists) true held-out metrics. Never
 * throws — with too little data for a real three-way chronological split, it
 * still returns a full-sample fit (holdoutMetrics: null) rather than
 * refusing, matching fitRegularizedTermModel's own "never throws on empty
 * input" discipline.
 */
export function fitPlateHrV2ShadowModel(
  rows: ShadowHrTrainingRow[],
  options: PlateHrV2ShadowFittingOptions = {},
): PlateHrV2ShadowFittingResult {
  const featureKeys = options.featureKeys ?? PLATE_HR_V2_SHADOW_TERM_KEYS.slice();
  const sorted = sortedByFrozenAt(rows);
  const l2 = options.l2;
  const minTrainRows = Math.max(20, options.minTrainRows ?? 300);
  const testRowsCount = Math.max(10, options.testRows ?? 100);
  const calibrationRowsCount = Math.max(10, options.calibrationRows ?? testRowsCount);

  const walkForwardFolds = walkForwardFit(sorted, featureKeys, {
    minTrainRows: options.minTrainRows,
    testRows: options.testRows,
    l2,
  });

  const finalFitOptions = { l2, iterations: options.finalFitIterations, learningRate: options.finalFitLearningRate };
  const n = sorted.length;

  if (n < minTrainRows + calibrationRowsCount + testRowsCount) {
    // Not enough data for a real three-way split — fit on everything
    // available and calibrate in-sample (honest best-effort; the resulting
    // calibrator is not out-of-sample validated, which is exactly why
    // holdoutMetrics stays null rather than reporting a misleadingly-clean
    // in-sample number as if it were held out).
    const finalTermModel = fitRegularizedTermModel(sorted, featureKeys, finalFitOptions);
    const calibratorInputRows = sorted.map((r) => ({
      rawProbability: predictTermModel(finalTermModel, r.terms),
      homered: r.homered,
      frozenAt: r.frozenAt,
    }));
    const calibrator = fitPlateHrV2Calibrator(calibratorInputRows, { l2 });
    const window = windowOf(sorted);
    return {
      featureKeys,
      totalRows: n,
      walkForwardFolds,
      finalTermModel,
      finalTermModelSampleWindow: window,
      calibrator,
      calibratorSampleWindow: window,
      holdoutMetrics: null,
    };
  }

  const termTrainRows = sorted.slice(0, n - calibrationRowsCount - testRowsCount);
  const calibrationSourceRows = sorted.slice(n - calibrationRowsCount - testRowsCount, n - testRowsCount);
  const holdoutRows = sorted.slice(n - testRowsCount);

  const finalTermModel = fitRegularizedTermModel(termTrainRows, featureKeys, finalFitOptions);

  const calibratorInputRows = calibrationSourceRows.map((r) => ({
    rawProbability: predictTermModel(finalTermModel, r.terms),
    homered: r.homered,
    frozenAt: r.frozenAt,
  }));
  const calibrator = fitPlateHrV2Calibrator(calibratorInputRows, { l2 });

  const rawMetrics = evaluateTermModel(finalTermModel, holdoutRows);
  const calibratedPredictions = holdoutRows.map((r) => {
    const rawP = predictTermModel(finalTermModel, r.terms);
    const calibratedP = applyPlateHrV2Calibrator(calibrator, rawP).calibrated ?? rawP;
    return { p: calibratedP, y: r.homered };
  });
  const calibratedMetrics = binaryMetricsFromPredictions(calibratedPredictions);

  return {
    featureKeys,
    totalRows: n,
    walkForwardFolds,
    finalTermModel,
    finalTermModelSampleWindow: windowOf(termTrainRows),
    calibrator,
    calibratorSampleWindow: windowOf(calibrationSourceRows),
    holdoutMetrics: {
      raw: rawMetrics,
      calibrated: calibratedMetrics,
      rows: holdoutRows.length,
      window: windowOf(holdoutRows),
    },
  };
}
