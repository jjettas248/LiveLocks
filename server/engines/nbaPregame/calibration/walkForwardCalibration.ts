// PR4 — NBA Pregame Targets: walk-forward calibration + validation.
//
// Maps a raw model win-probability to a calibrated one using ONLY historical
// outcomes that were genuinely known BEFORE the projection being evaluated —
// strict as-of ordering, no future leakage. Calibration is kept per (market,
// modelVersion) so provenance is never mixed across markets or model revisions.
//
// Evidence discipline:
//   • Training set = observations with knownAt STRICTLY BEFORE asOf. A test proves
//     that injecting a future observation changes nothing.
//   • Sufficient evidence → reliability-bucket calibration, shrunk toward the raw
//     probability by a pseudo-count (sparse buckets stay near identity).
//   • Insufficient evidence (below minTotalSamples) → the DOCUMENTED FALLBACK:
//     identity (calibrated = raw), flagged `identity_insufficient_evidence`.
//   • Invalid input (non-finite/out-of-range raw prob, unparseable asOf) →
//     fail-closed identity, flagged `identity_invalid_input`.
//
// Quality is reported by market and probability bucket (predicted vs empirical,
// gap, and expected calibration error). Pure and deterministic.
//
// DATA-SOURCE NOTE: this module is the calibration ENGINE. It consumes an array
// of frozen, outcome-bearing observations passed in by the caller; it does not
// read any database. Until a historical-outcome adapter is wired (a later,
// persistence-touching PR), production callers will have no observations and the
// documented identity fallback applies — surfaced explicitly, never silently.

import { isoInstantMs } from "../../../../shared/pregameTargets/canonicalEntities";
import type { NbaMarketKey } from "../markets";

export interface CalibrationObservation {
  market: NbaMarketKey;
  modelVersion: string;
  /** Raw model P(win) for the settled side, in [0,1]. */
  rawProbability: number;
  /** Realized outcome: 1 = win, 0 = loss. Pushes are excluded upstream. */
  outcome: 0 | 1;
  /** ISO-8601 instant (with offset) the outcome became known. */
  knownAt: string;
}

export interface CalibrationConfig {
  numBuckets: number;
  /** Minimum total in-window observations before leaving the identity fallback. */
  minTotalSamples: number;
  /** Pseudo-count shrinking a bucket's empirical rate toward the raw probability. */
  priorStrength: number;
}

export const DEFAULT_CALIBRATION_CONFIG: CalibrationConfig = {
  numBuckets: 10,
  minTotalSamples: 50,
  priorStrength: 20,
};

export type CalibrationFallback = "none" | "identity_insufficient_evidence" | "identity_invalid_input";

export interface CalibratedProbability {
  market: NbaMarketKey;
  modelVersion: string;
  rawProbability: number;
  calibratedProbability: number;
  bucketIndex: number;
  bucketSamples: number;
  totalSamples: number;
  fallback: CalibrationFallback;
  asOf: string;
}

function clamp01(p: number): number {
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

function bucketOf(p: number, numBuckets: number): number {
  const b = Math.floor(clamp01(p) * numBuckets);
  return b >= numBuckets ? numBuckets - 1 : b < 0 ? 0 : b;
}

/**
 * Walk-forward training set: observations for the SAME market + modelVersion whose
 * knownAt is STRICTLY BEFORE `asOfMs`. Malformed knownAt is dropped (never leaks).
 */
function trainingObservations(
  observations: readonly CalibrationObservation[],
  market: NbaMarketKey,
  modelVersion: string,
  asOfMs: number,
): CalibrationObservation[] {
  const out: CalibrationObservation[] = [];
  for (const o of observations) {
    if (o.market !== market || o.modelVersion !== modelVersion) continue;
    if (o.outcome !== 0 && o.outcome !== 1) continue;
    if (!Number.isFinite(o.rawProbability)) continue;
    const knownMs = isoInstantMs(o.knownAt);
    if (!Number.isFinite(knownMs)) continue; // unparseable → excluded
    if (knownMs >= asOfMs) continue; // STRICT: training must precede the projection
    out.push(o);
  }
  return out;
}

/**
 * Calibrate a raw win-probability as of `asOfIso`, using only prior outcomes for
 * the given market + modelVersion. Never throws — invalid input and insufficient
 * evidence both return a typed identity fallback.
 */
export function calibrateProbability(
  observations: readonly CalibrationObservation[],
  market: NbaMarketKey,
  modelVersion: string,
  rawProbability: number,
  asOfIso: string,
  config: CalibrationConfig = DEFAULT_CALIBRATION_CONFIG,
): CalibratedProbability {
  const asOfMs = isoInstantMs(asOfIso);
  const base = (fallback: CalibrationFallback, calibrated: number, total = 0, bucketN = 0, bucketIdx = -1): CalibratedProbability => ({
    market,
    modelVersion,
    rawProbability,
    calibratedProbability: calibrated,
    bucketIndex: bucketIdx,
    bucketSamples: bucketN,
    totalSamples: total,
    fallback,
    asOf: asOfIso,
  });

  if (!Number.isFinite(rawProbability) || rawProbability < 0 || rawProbability > 1 || !Number.isFinite(asOfMs)) {
    return base("identity_invalid_input", clamp01(rawProbability));
  }

  const train = trainingObservations(observations, market, modelVersion, asOfMs);
  if (train.length < config.minTotalSamples) {
    return base("identity_insufficient_evidence", rawProbability, train.length);
  }

  const bIdx = bucketOf(rawProbability, config.numBuckets);
  const lo = bIdx / config.numBuckets;
  const hi = (bIdx + 1) / config.numBuckets;
  let n = 0;
  let wins = 0;
  for (const o of train) {
    const p = clamp01(o.rawProbability);
    const inBucket = bIdx === config.numBuckets - 1 ? p >= lo && p <= hi : p >= lo && p < hi;
    if (inBucket) {
      n += 1;
      wins += o.outcome;
    }
  }
  // Shrink the bucket's empirical rate toward the raw probability by pseudo-count,
  // so a sparse bucket stays near identity rather than overfitting.
  const empirical = n > 0 ? wins / n : rawProbability;
  const calibrated = (n * empirical + config.priorStrength * rawProbability) / (n + config.priorStrength);

  return base("none", clamp01(calibrated), train.length, n, bIdx);
}

export interface CalibrationBucketQuality {
  bucketIndex: number;
  range: [number, number];
  count: number;
  meanPredicted: number;
  empiricalRate: number;
  gap: number;
}

export interface CalibrationQualityReport {
  market: NbaMarketKey;
  modelVersion: string;
  totalSamples: number;
  byBucket: CalibrationBucketQuality[];
  /** Σ (count/total)·|meanPredicted − empiricalRate|. */
  expectedCalibrationError: number;
  asOf: string;
}

/**
 * Reliability report (walk-forward) by probability bucket for one market +
 * modelVersion: predicted vs empirical rate, per-bucket gap, and the sample-
 * weighted expected calibration error. Uses the same strict as-of training set.
 */
export function calibrationQualityReport(
  observations: readonly CalibrationObservation[],
  market: NbaMarketKey,
  modelVersion: string,
  asOfIso: string,
  config: CalibrationConfig = DEFAULT_CALIBRATION_CONFIG,
): CalibrationQualityReport {
  const asOfMs = isoInstantMs(asOfIso);
  const train = Number.isFinite(asOfMs) ? trainingObservations(observations, market, modelVersion, asOfMs) : [];
  const byBucket: CalibrationBucketQuality[] = [];
  let ece = 0;
  const total = train.length;
  for (let b = 0; b < config.numBuckets; b++) {
    const lo = b / config.numBuckets;
    const hi = (b + 1) / config.numBuckets;
    let count = 0;
    let sumPred = 0;
    let wins = 0;
    for (const o of train) {
      const p = clamp01(o.rawProbability);
      const inBucket = b === config.numBuckets - 1 ? p >= lo && p <= hi : p >= lo && p < hi;
      if (inBucket) {
        count += 1;
        sumPred += p;
        wins += o.outcome;
      }
    }
    const meanPredicted = count > 0 ? sumPred / count : (lo + hi) / 2;
    const empiricalRate = count > 0 ? wins / count : 0;
    const gap = count > 0 ? Math.abs(meanPredicted - empiricalRate) : 0;
    if (count > 0 && total > 0) ece += (count / total) * gap;
    byBucket.push({ bucketIndex: b, range: [lo, hi], count, meanPredicted, empiricalRate, gap });
  }
  return { market, modelVersion, totalSamples: total, byBucket, expectedCalibrationError: ece, asOf: asOfIso };
}
