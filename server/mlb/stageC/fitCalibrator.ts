// ── MLB Live Edge Stage C — fit a calibrator from the Stage B ledger ─────────
// Reads SETTLED all-lane predictions (cashed/missed only — push and void are
// excluded, exactly like a hit-rate denominator), groups them by segment, and
// fits a reliability-isotonic calibration artifact per segment with honest
// IN-SAMPLE raw-vs-calibrated metrics. Pure and READ-ONLY over the ledger rows
// (it takes an array; it never queries or mutates the store). Producing an
// artifact does NOT promote it — see calibratorPromotionGate.ts.

import {
  MLB_CALIBRATION_ARTIFACT_VERSION,
  applyCalibrator,
  clamp01,
  type MlbCalibrationArtifact,
  type MlbCalibrationBin,
} from "@shared/mlbCalibration";
import {
  MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
  type MlbLanePrediction,
} from "@shared/mlbPredictionLedger";
import { toEtDateKey } from "../../utils/dateUtils";
import {
  brierScore,
  logLoss,
  expectedCalibrationErrorPct,
  basePositiveRate,
  reliabilityBins,
  shrinkRate,
  isotonicPav,
  type CalObs,
} from "./calibrationMath";

export interface CalibrationObservation {
  segment: string;
  p: number;         // predicted probability 0..1 (candidate side)
  y: 0 | 1;          // cashed = 1, missed = 0
  slateDate: string; // ET calendar date key of capture
}

export interface FitCalibratorOptions {
  bins?: number;         // reliability bins (default 10)
  pseudoCount?: number;  // shrinkage strength toward the base rate (default 20)
  builtAtMs: number;     // injected clock (deterministic/testable)
  /** Segment key for a prediction. Default: market. Pass a lane-split key to
   *  calibrate per (market, lane). */
  segmentKey?: (p: MlbLanePrediction) => string;
}

const DEFAULT_BINS = 10;
const DEFAULT_PSEUDO_COUNT = 20;

function defaultSegmentKey(p: MlbLanePrediction): string {
  return p.market;
}

/**
 * Extracts calibration observations from ledger rows. Only settled cashed/missed
 * rows contribute; captured (unsettled), push, and void rows are excluded — a
 * push is a non-decision and a void is excluded-through-no-fault.
 */
export function toCalibrationObservations(
  predictions: readonly MlbLanePrediction[],
  segmentKey: (p: MlbLanePrediction) => string = defaultSegmentKey,
): CalibrationObservation[] {
  const out: CalibrationObservation[] = [];
  for (const pred of predictions) {
    if (pred.status !== "settled") continue;
    if (pred.settlementResult !== "cashed" && pred.settlementResult !== "missed") continue;
    if (!Number.isFinite(pred.candidateProbabilityPct)) continue;
    out.push({
      segment: segmentKey(pred),
      p: clamp01(pred.candidateProbabilityPct / 100),
      y: pred.settlementResult === "cashed" ? 1 : 0,
      slateDate: toEtDateKey(pred.capturedAt),
    });
  }
  return out;
}

/**
 * Fits one segment's calibration artifact from its observations. Returns null
 * when there is nothing to fit (no decided observations / no non-empty bin).
 */
export function fitSegmentCalibrator(
  segment: string,
  observations: readonly CalibrationObservation[],
  opts: FitCalibratorOptions,
): MlbCalibrationArtifact | null {
  if (observations.length === 0) return null;
  const k = opts.bins ?? DEFAULT_BINS;
  const pseudo = opts.pseudoCount ?? DEFAULT_PSEUDO_COUNT;

  const calObs: CalObs[] = observations.map((o) => ({ p: o.p, y: o.y }));
  const prior = basePositiveRate(calObs);
  const allBins = reliabilityBins(calObs, k);
  const nonEmpty = allBins.filter((b) => b.count > 0);
  if (nonEmpty.length === 0) return null;

  // Shrink each bin's empirical rate toward the base rate, then enforce
  // monotonicity across bin centers (weighted isotonic).
  const shrunk = nonEmpty.map((b) => shrinkRate(b.positives, b.count, prior, pseudo));
  const weights = nonEmpty.map((b) => b.count);
  const calibratedRates = isotonicPav(shrunk, weights);

  const bins: MlbCalibrationBin[] = nonEmpty.map((b, i) => ({
    lo: b.lo,
    hi: b.hi,
    center: b.meanPredicted,
    count: b.count,
    empiricalRate: b.empiricalRate,
    calibratedRate: clamp01(calibratedRates[i]),
  }));

  // Build the artifact WITH bins first so applyCalibrator can score the fit set.
  const artifact: MlbCalibrationArtifact = {
    segment,
    method: "reliability_isotonic_v1",
    bins,
    fitStats: {
      sampleSize: 0, distinctSlateDates: 0, basePositiveRate: prior,
      rawBrier: 0, calibratedBrier: 0, rawLogLoss: 0, calibratedLogLoss: 0,
      rawEcePct: 0, calibratedEcePct: 0, inSample: true,
    },
    builtAtMs: opts.builtAtMs,
    ledgerContractVersion: MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
    artifactVersion: MLB_CALIBRATION_ARTIFACT_VERSION,
  };

  const calibratedObs: CalObs[] = calObs.map((o) => {
    const cal = applyCalibrator(artifact, o.p * 100);
    return { p: cal != null ? clamp01(cal / 100) : o.p, y: o.y };
  });

  const distinctSlateDates = new Set(observations.map((o) => o.slateDate)).size;

  artifact.fitStats = {
    sampleSize: observations.length,
    distinctSlateDates,
    basePositiveRate: prior,
    rawBrier: brierScore(calObs),
    calibratedBrier: brierScore(calibratedObs),
    rawLogLoss: logLoss(calObs),
    calibratedLogLoss: logLoss(calibratedObs),
    rawEcePct: expectedCalibrationErrorPct(calObs, k),
    calibratedEcePct: expectedCalibrationErrorPct(calibratedObs, k),
    inSample: true,
  };

  return artifact;
}

/**
 * Fits a calibration artifact for every segment present in the ledger rows.
 * Returns a map keyed by segment (only segments that produced an artifact).
 */
export function fitCalibratorsFromLedger(
  predictions: readonly MlbLanePrediction[],
  opts: FitCalibratorOptions,
): Record<string, MlbCalibrationArtifact> {
  const segmentKey = opts.segmentKey ?? defaultSegmentKey;
  const obs = toCalibrationObservations(predictions, segmentKey);
  const bySegment = new Map<string, CalibrationObservation[]>();
  for (const o of obs) {
    const arr = bySegment.get(o.segment) ?? [];
    arr.push(o);
    bySegment.set(o.segment, arr);
  }
  const out: Record<string, MlbCalibrationArtifact> = {};
  for (const [segment, segObs] of Array.from(bySegment.entries())) {
    const artifact = fitSegmentCalibrator(segment, segObs, opts);
    if (artifact) out[segment] = artifact;
  }
  return out;
}
