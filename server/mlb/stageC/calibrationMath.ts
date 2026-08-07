// ── MLB Live Edge Stage C — pure calibration math primitives ─────────────────
// Reliability binning, shrinkage-to-prior, weighted isotonic regression
// (pool-adjacent-violators), and the standard probability-quality metrics
// (Brier, log loss, expected calibration error). All generic over a set of
// {p, y} observations (p = predicted probability 0..1, y = outcome 0|1) so the
// exact same functions score both the raw and the calibrated predictions, and
// can later score a held-out set unchanged. Pure, no I/O.

import { clamp01 } from "@shared/mlbCalibration";

export interface CalObs {
  p: number; // predicted probability, 0..1
  y: 0 | 1;  // realized outcome (cashed = 1, missed = 0)
}

const LOG_EPS = 1e-15;

/** Mean Brier score: mean((p - y)^2). Empty ⇒ 0. */
export function brierScore(obs: readonly CalObs[]): number {
  if (obs.length === 0) return 0;
  let s = 0;
  for (const o of obs) {
    const p = clamp01(o.p);
    s += (p - o.y) * (p - o.y);
  }
  return s / obs.length;
}

/** Mean log loss with probability clamping. Empty ⇒ 0. */
export function logLoss(obs: readonly CalObs[]): number {
  if (obs.length === 0) return 0;
  let s = 0;
  for (const o of obs) {
    const p = Math.min(1 - LOG_EPS, Math.max(LOG_EPS, clamp01(o.p)));
    s += o.y === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / obs.length;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  count: number;
  positives: number;      // Σ y in the bin
  meanPredicted: number;  // mean p in the bin (bin center), 0..1
  empiricalRate: number;  // positives / count, 0..1 (0 when empty)
}

/**
 * Equal-width reliability bins over [0,1] by predicted probability. `k` bins;
 * the last bin is closed on the right so p === 1 lands in it. Empty bins are
 * returned too (count 0) so callers can decide whether to keep them.
 */
export function reliabilityBins(obs: readonly CalObs[], k: number): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  const width = 1 / k;
  for (let i = 0; i < k; i++) {
    bins.push({ lo: i * width, hi: (i + 1) * width, count: 0, positives: 0, meanPredicted: 0, empiricalRate: 0 });
  }
  let sumP = new Array<number>(k).fill(0);
  for (const o of obs) {
    const p = clamp01(o.p);
    let idx = Math.floor(p / width);
    if (idx >= k) idx = k - 1; // p === 1
    if (idx < 0) idx = 0;
    bins[idx].count++;
    bins[idx].positives += o.y;
    sumP[idx] += p;
  }
  for (let i = 0; i < k; i++) {
    if (bins[i].count > 0) {
      bins[i].meanPredicted = sumP[i] / bins[i].count;
      bins[i].empiricalRate = bins[i].positives / bins[i].count;
    } else {
      bins[i].meanPredicted = (bins[i].lo + bins[i].hi) / 2;
      bins[i].empiricalRate = 0;
    }
  }
  return bins;
}

/**
 * Shrinks an empirical rate toward a prior with `pseudoCount` pseudo-observations:
 * (positives + pseudoCount·prior) / (count + pseudoCount). Stabilizes low-count
 * bins so a 1-of-1 bin does not become a 100% calibrated rate.
 */
export function shrinkRate(positives: number, count: number, prior: number, pseudoCount: number): number {
  const denom = count + pseudoCount;
  if (denom <= 0) return clamp01(prior);
  return clamp01((positives + pseudoCount * prior) / denom);
}

/**
 * Weighted isotonic regression (pool-adjacent-violators). Returns a
 * non-decreasing fit of `values` (aligned by index) minimizing weighted squared
 * error. `values` are assumed ordered by their x-coordinate (bin center)
 * ascending. Zero-weight entries are honored (contribute nothing to a pool's
 * mean). Pure.
 */
export function isotonicPav(values: readonly number[], weights: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  interface Block { sum: number; wsum: number; start: number; end: number; mean: number }
  const blocks: Block[] = [];
  for (let i = 0; i < n; i++) {
    const w = Math.max(0, weights[i] ?? 0);
    const block: Block = { sum: values[i] * w, wsum: w, start: i, end: i, mean: values[i] };
    block.mean = block.wsum > 0 ? block.sum / block.wsum : values[i];
    blocks.push(block);
    // Merge while the previous block's mean exceeds this one's (violates order).
    while (blocks.length > 1 && blocks[blocks.length - 2].mean > blocks[blocks.length - 1].mean + 1e-15) {
      const last = blocks.pop()!;
      const prev = blocks.pop()!;
      const merged: Block = {
        sum: prev.sum + last.sum,
        wsum: prev.wsum + last.wsum,
        start: prev.start,
        end: last.end,
        mean: 0,
      };
      merged.mean = merged.wsum > 0 ? merged.sum / merged.wsum : (prev.mean + last.mean) / 2;
      blocks.push(merged);
    }
  }
  const out = new Array<number>(n).fill(0);
  for (const b of blocks) {
    for (let i = b.start; i <= b.end; i++) out[i] = b.mean;
  }
  return out;
}

/**
 * Expected calibration error (percentage points): Σ (n_i/N)·|meanPredicted_i −
 * empiricalRate_i| over non-empty bins, ×100. Lower is better-calibrated.
 */
export function expectedCalibrationErrorPct(obs: readonly CalObs[], k: number): number {
  if (obs.length === 0) return 0;
  const bins = reliabilityBins(obs, k);
  const n = obs.length;
  let ece = 0;
  for (const b of bins) {
    if (b.count === 0) continue;
    ece += (b.count / n) * Math.abs(b.meanPredicted - b.empiricalRate);
  }
  return Math.round(ece * 100 * 100) / 100;
}

/** Mean of y (base positive rate), 0..1. Empty ⇒ 0. */
export function basePositiveRate(obs: readonly CalObs[]): number {
  if (obs.length === 0) return 0;
  let s = 0;
  for (const o of obs) s += o.y;
  return s / obs.length;
}
