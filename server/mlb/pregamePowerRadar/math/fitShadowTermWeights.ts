// Pre-Game Power Radar — v2 SHADOW coefficient fitting.
//
// The production Plate score remains unchanged. This research utility fits
// multipliers over the v2 model's already-bounded component log-odds terms,
// replacing hand-tuned term strength only after walk-forward evidence exists.
//
// IMPORTANT: callers must pass prediction-time/frozen features only. The fitter
// sorts chronologically and never shuffles future rows into the training window.

export interface ShadowHrTrainingRow {
  /** ISO timestamp of the frozen pregame observation. */
  frozenAt: string;
  /** Binary in-game HR outcome for the batter. */
  homered: 0 | 1;
  /** Bounded v2 component terms, e.g. batterPower, pitcherVulnerability, pitchType. */
  terms: Record<string, number | null | undefined>;
}

export interface LogisticTermModel {
  featureKeys: string[];
  intercept: number;
  coefficients: Record<string, number>;
  l2: number;
  trainedRows: number;
}

export interface BinaryMetrics {
  rows: number;
  brier: number;
  logLoss: number;
  observedRate: number;
  meanPrediction: number;
}

export interface WalkForwardFold {
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  model: LogisticTermModel;
  metrics: BinaryMetrics;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-25, Math.min(25, x))));
}

function finite(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function predictTermModel(model: LogisticTermModel, terms: Record<string, number | null | undefined>): number {
  let z = model.intercept;
  for (const key of model.featureKeys) z += (model.coefficients[key] ?? 0) * finite(terms[key]);
  return sigmoid(z);
}

/**
 * L2-regularized logistic regression over bounded v2 term values. Gradient
 * descent is intentionally simple/deterministic so model artifacts are easy to
 * audit and reproduce without a second ML runtime.
 */
export function fitRegularizedTermModel(
  rows: ShadowHrTrainingRow[],
  featureKeys: string[],
  options: { l2?: number; iterations?: number; learningRate?: number } = {},
): LogisticTermModel {
  const ordered = rows
    .filter((r) => Number.isFinite(Date.parse(r.frozenAt)))
    .slice()
    .sort((a, b) => Date.parse(a.frozenAt) - Date.parse(b.frozenAt));
  const n = ordered.length;
  if (n === 0) {
    return { featureKeys: featureKeys.slice(), intercept: 0, coefficients: Object.fromEntries(featureKeys.map((k) => [k, 0])), l2: options.l2 ?? 0.1, trainedRows: 0 };
  }

  const l2 = options.l2 ?? 0.1;
  const iterations = options.iterations ?? 900;
  const learningRate = options.learningRate ?? 0.06;
  const baseRate = Math.min(0.999, Math.max(0.001, ordered.reduce((s, r) => s + r.homered, 0) / n));
  let intercept = Math.log(baseRate / (1 - baseRate));
  const coef: Record<string, number> = Object.fromEntries(featureKeys.map((k) => [k, 0]));

  for (let iter = 0; iter < iterations; iter++) {
    let gradIntercept = 0;
    const grad: Record<string, number> = Object.fromEntries(featureKeys.map((k) => [k, 0]));

    for (const row of ordered) {
      let z = intercept;
      for (const key of featureKeys) z += coef[key] * finite(row.terms[key]);
      const err = sigmoid(z) - row.homered;
      gradIntercept += err;
      for (const key of featureKeys) grad[key] += err * finite(row.terms[key]);
    }

    intercept -= learningRate * (gradIntercept / n);
    for (const key of featureKeys) {
      const regularizedGradient = grad[key] / n + l2 * coef[key];
      coef[key] -= learningRate * regularizedGradient;
      // Guard against a pathological tiny sample exploding a coefficient.
      coef[key] = Math.max(-4, Math.min(4, coef[key]));
    }
  }

  return { featureKeys: featureKeys.slice(), intercept, coefficients: coef, l2, trainedRows: n };
}

export function evaluateTermModel(model: LogisticTermModel, rows: ShadowHrTrainingRow[]): BinaryMetrics {
  if (rows.length === 0) return { rows: 0, brier: 0, logLoss: 0, observedRate: 0, meanPrediction: 0 };
  let brier = 0;
  let logLoss = 0;
  let observed = 0;
  let predicted = 0;
  for (const row of rows) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, predictTermModel(model, row.terms)));
    const y = row.homered;
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    observed += y;
    predicted += p;
  }
  return {
    rows: rows.length,
    brier: brier / rows.length,
    logLoss: logLoss / rows.length,
    observedRate: observed / rows.length,
    meanPrediction: predicted / rows.length,
  };
}

/**
 * Expanding-window walk-forward evaluation. `minTrainRows` must be available
 * before the first test fold; every test row occurs strictly after its training
 * set. This is the promotion-grade shape for future historical snapshot data.
 */
export function walkForwardFit(
  rows: ShadowHrTrainingRow[],
  featureKeys: string[],
  options: { minTrainRows?: number; testRows?: number; l2?: number } = {},
): WalkForwardFold[] {
  const ordered = rows
    .filter((r) => Number.isFinite(Date.parse(r.frozenAt)))
    .slice()
    .sort((a, b) => Date.parse(a.frozenAt) - Date.parse(b.frozenAt));
  const minTrainRows = Math.max(20, options.minTrainRows ?? 300);
  const testRows = Math.max(10, options.testRows ?? 100);
  const folds: WalkForwardFold[] = [];

  for (let split = minTrainRows; split < ordered.length; split += testRows) {
    const train = ordered.slice(0, split);
    const test = ordered.slice(split, Math.min(ordered.length, split + testRows));
    if (test.length === 0) break;
    const model = fitRegularizedTermModel(train, featureKeys, { l2: options.l2 });
    folds.push({
      trainStart: train[0].frozenAt,
      trainEnd: train[train.length - 1].frozenAt,
      testStart: test[0].frozenAt,
      testEnd: test[test.length - 1].frozenAt,
      model,
      metrics: evaluateTermModel(model, test),
    });
  }
  return folds;
}
