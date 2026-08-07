// ── MLB Live Edge Stage C — walk-forward (out-of-sample) evaluation ──────────
// The promotion gate (calibratorPromotionGate.ts) refuses to pass on in-sample
// fit metrics — a calibrator can always overfit the data it was fit to. This
// module produces the HELD-OUT evidence the gate needs: it forward-chains over
// the segment's real slate history, fitting a calibrator only on slates STRICTLY
// BEFORE each validation slate and scoring it on the never-seen validation slate,
// then pools those out-of-sample predictions into honest held-out Brier / ECE /
// forward captured-price ROI / tier-monotonicity.
//
// This is the exact temporal-isolation discipline the NBA pregame walk-forward
// calibration uses (server/engines/nbaPregame/calibration/): train strictly in
// the past, evaluate strictly in the future, never split a slate across the
// boundary. Slate day = slateDateET (6am-ET rollover), so a post-midnight West-
// Coast capture is scored in the slate it belongs to.
//
// Pure and READ-ONLY over the ledger rows. Producing evidence does NOT promote
// anything — it only feeds calibratorPromotionGate.ts, which itself never
// auto-applies.

import { applyCalibrator, clamp01 } from "@shared/mlbCalibration";
import type { MlbLanePrediction } from "@shared/mlbPredictionLedger";
import { slateDateET } from "../../utils/dateUtils";
import { brierScore, expectedCalibrationErrorPct, type CalObs } from "./calibrationMath";
import { fitSegmentCalibrator, type CalibrationObservation } from "./fitCalibrator";

/** One held-out observation carrying the extra fields ROI/tier checks need. */
interface WalkForwardObs {
  p: number;                       // raw candidate probability, 0..1
  y: 0 | 1;                        // cashed = 1, missed = 0
  slateDate: string;               // ET slate day
  sideOddsAmerican: number | null; // captured American price on the candidate side
  noVigBookProbabilityPct: number | null; // captured no-vig book prob (0..100)
}

export interface WalkForwardOptions {
  builtAtMs: number;      // injected clock (deterministic/testable)
  bins?: number;          // reliability bins for each fold's fit (default 10)
  pseudoCount?: number;   // shrinkage strength (default 20)
  // Fold begins only after this many training slate dates have accumulated, so
  // the earliest calibrators are never fit on a trivial history.
  minTrainSlateDates?: number;
  // …and only when the training pool has at least this many decided obs.
  minTrainObs?: number;
  // Forward ROI bets a validation prediction only when the CALIBRATED edge over
  // the captured no-vig book prob clears this floor (mirrors what a promoted
  // calibrator would actually bet). Percentage points.
  minEdgePctPoints?: number;
  // Tier-monotonicity: minimum validation obs in a probability band for it to
  // count toward the non-decreasing-hit-rate check.
  minTierBandCount?: number;
}

const DEFAULT_BINS = 10;
const DEFAULT_PSEUDO = 20;
const DEFAULT_MIN_TRAIN_SLATES = 5;
const DEFAULT_MIN_TRAIN_OBS = 50;
const DEFAULT_MIN_EDGE_PP = 2.0;
const DEFAULT_MIN_TIER_BAND = 10;

export interface WalkForwardResult {
  segment: string;
  // True only when at least one valid forward fold produced held-out predictions.
  hasHeldOutEvidence: boolean;
  folds: number;
  validationSampleSize: number;
  validationDistinctSlateDates: number;
  heldOutRawBrier: number | null;
  heldOutCalibratedBrier: number | null;
  heldOutEcePct: number | null;      // percentage points
  // Net units from betting each validation prediction (that the calibrated model
  // would have flagged) at its captured price. null when no bet qualified /
  // odds were unavailable — an honest "unknown", never 0.
  forwardRoiUnits: number | null;
  forwardBetsPlaced: number;
  // Higher calibrated-probability bands show non-decreasing empirical hit rates
  // on held-out data. null when there aren't ≥2 qualifying bands to compare.
  tierMonotonic: boolean | null;
}

function americanProfitUnits(american: number): number | null {
  if (!Number.isFinite(american) || american === 0) return null;
  return american > 0 ? american / 100 : 100 / Math.abs(american);
}

/** Extracts walk-forward observations for a single segment's rows. Only settled
 *  cashed/missed rows contribute (push/void are non-decisions). */
export function toWalkForwardObservations(
  predictions: readonly MlbLanePrediction[],
): WalkForwardObs[] {
  const out: WalkForwardObs[] = [];
  for (const pred of predictions) {
    if (pred.status !== "settled") continue;
    if (pred.settlementResult !== "cashed" && pred.settlementResult !== "missed") continue;
    if (!Number.isFinite(pred.candidateProbabilityPct)) continue;
    out.push({
      p: clamp01(pred.candidateProbabilityPct / 100),
      y: pred.settlementResult === "cashed" ? 1 : 0,
      slateDate: slateDateET(new Date(pred.capturedAt)),
      sideOddsAmerican: Number.isFinite(pred.sideOdds as number) ? (pred.sideOdds as number) : null,
      noVigBookProbabilityPct:
        pred.noVigBookProbability != null && Number.isFinite(pred.noVigBookProbability)
          ? pred.noVigBookProbability
          : null,
    });
  }
  return out;
}

/**
 * Runs forward-chaining walk-forward evaluation for one segment's observations.
 * Fold i trains on every obs whose slate is strictly before validation slate i
 * and scores the calibrator on slate i's obs. Pooled held-out predictions give
 * the honest out-of-sample metrics. Pure.
 */
export function evaluateSegmentWalkForward(
  segment: string,
  observations: readonly WalkForwardObs[],
  opts: WalkForwardOptions,
): WalkForwardResult {
  const bins = opts.bins ?? DEFAULT_BINS;
  const pseudoCount = opts.pseudoCount ?? DEFAULT_PSEUDO;
  const minTrainSlates = opts.minTrainSlateDates ?? DEFAULT_MIN_TRAIN_SLATES;
  const minTrainObs = opts.minTrainObs ?? DEFAULT_MIN_TRAIN_OBS;
  const minEdge = opts.minEdgePctPoints ?? DEFAULT_MIN_EDGE_PP;
  const minTierBand = opts.minTierBandCount ?? DEFAULT_MIN_TIER_BAND;

  const empty: WalkForwardResult = {
    segment,
    hasHeldOutEvidence: false,
    folds: 0,
    validationSampleSize: 0,
    validationDistinctSlateDates: 0,
    heldOutRawBrier: null,
    heldOutCalibratedBrier: null,
    heldOutEcePct: null,
    forwardRoiUnits: null,
    forwardBetsPlaced: 0,
    tierMonotonic: null,
  };

  // Group by slate day and order the slates chronologically.
  const bySlate = new Map<string, WalkForwardObs[]>();
  for (const o of observations) {
    const arr = bySlate.get(o.slateDate) ?? [];
    arr.push(o);
    bySlate.set(o.slateDate, arr);
  }
  const slates = Array.from(bySlate.keys()).sort();
  if (slates.length < minTrainSlates + 1) return empty;

  // Pooled held-out predictions across all folds.
  const heldRaw: CalObs[] = [];
  const heldCal: CalObs[] = [];
  let roiUnits = 0;
  let betsPlaced = 0;
  let folds = 0;
  const validationSlates = new Set<string>();
  // Bands for tier-monotonicity keyed by calibrated-prob 5pt band floor.
  const bandAgg = new Map<number, { n: number; wins: number }>();

  for (let i = 0; i < slates.length; i++) {
    const trainSlates = slates.slice(0, i);
    if (trainSlates.length < minTrainSlates) continue;

    const trainObs: CalibrationObservation[] = [];
    for (const s of trainSlates) {
      for (const o of bySlate.get(s)!) {
        trainObs.push({ segment, p: o.p, y: o.y, slateDate: s });
      }
    }
    if (trainObs.length < minTrainObs) continue;

    const artifact = fitSegmentCalibrator(segment, trainObs, { builtAtMs: opts.builtAtMs, bins, pseudoCount });
    if (!artifact) continue;

    const valObs = bySlate.get(slates[i])!;
    let foldContributed = false;
    for (const o of valObs) {
      const calPct = applyCalibrator(artifact, o.p * 100);
      // No calibrated value ⇒ this held-out obs is uncalibrated; skip it (never
      // fall back to the raw prob and call it calibrated evidence).
      if (calPct == null) continue;
      const cal01 = clamp01(calPct / 100);
      heldRaw.push({ p: o.p, y: o.y });
      heldCal.push({ p: cal01, y: o.y });
      foldContributed = true;

      // Forward ROI: bet only when the calibrated edge over the captured no-vig
      // book clears the floor (what a promoted calibrator would actually do).
      if (o.noVigBookProbabilityPct != null && o.sideOddsAmerican != null) {
        const edge = calPct - o.noVigBookProbabilityPct;
        if (edge >= minEdge) {
          const profit = americanProfitUnits(o.sideOddsAmerican);
          if (profit != null) {
            roiUnits += o.y === 1 ? profit : -1;
            betsPlaced++;
          }
        }
      }

      // Tier-monotonicity band (5pt bands of calibrated prob).
      const bandFloor = Math.floor(calPct / 5) * 5;
      const agg = bandAgg.get(bandFloor) ?? { n: 0, wins: 0 };
      agg.n++;
      agg.wins += o.y;
      bandAgg.set(bandFloor, agg);
    }

    if (foldContributed) {
      folds++;
      validationSlates.add(slates[i]);
    }
  }

  if (heldCal.length === 0) return empty;

  // Tier-monotonicity: over qualifying bands (ascending), empirical hit rate must
  // be non-decreasing within a small tolerance. Needs ≥2 qualifying bands.
  let tierMonotonic: boolean | null = null;
  const qualifyingBands = Array.from(bandAgg.entries())
    .filter(([, v]) => v.n >= minTierBand)
    .sort((a, b) => a[0] - b[0]);
  if (qualifyingBands.length >= 2) {
    tierMonotonic = true;
    let prevRate = -Infinity;
    for (const [, v] of qualifyingBands) {
      const rate = v.wins / v.n;
      if (rate < prevRate - 0.02) { tierMonotonic = false; break; }
      prevRate = rate;
    }
  }

  return {
    segment,
    hasHeldOutEvidence: true,
    folds,
    validationSampleSize: heldCal.length,
    validationDistinctSlateDates: validationSlates.size,
    heldOutRawBrier: brierScore(heldRaw),
    heldOutCalibratedBrier: brierScore(heldCal),
    heldOutEcePct: expectedCalibrationErrorPct(heldCal, bins),
    forwardRoiUnits: betsPlaced > 0 ? Math.round(roiUnits * 1000) / 1000 : null,
    forwardBetsPlaced: betsPlaced,
    tierMonotonic,
  };
}

/**
 * Convenience: run walk-forward evaluation for every segment present in the
 * ledger rows, keyed by the same segment function the fitter uses. Returns a map
 * segment → result. Pure.
 */
export function evaluateWalkForwardFromLedger(
  predictions: readonly MlbLanePrediction[],
  segmentKey: (p: MlbLanePrediction) => string,
  opts: WalkForwardOptions,
): Record<string, WalkForwardResult> {
  const bySegment = new Map<string, MlbLanePrediction[]>();
  for (const p of predictions) {
    const seg = segmentKey(p);
    const arr = bySegment.get(seg) ?? [];
    arr.push(p);
    bySegment.set(seg, arr);
  }
  const out: Record<string, WalkForwardResult> = {};
  for (const [segment, rows] of Array.from(bySegment.entries())) {
    out[segment] = evaluateSegmentWalkForward(segment, toWalkForwardObservations(rows), opts);
  }
  return out;
}
