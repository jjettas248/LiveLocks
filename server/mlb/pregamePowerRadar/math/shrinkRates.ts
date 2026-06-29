// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW shrinkage helpers
//
// Empirical-Bayes-style shrinkage toward a prior (typically league average) by
// sample size. Pure, no I/O. Small samples are pulled hard toward the prior;
// large samples stay close to the observed rate.
//
// NOTE: the stabilization constants `k` below are documented DEFAULT PRIORS
// (informed by public stabilization-point literature, e.g. barrel rate ~50 BBE,
// HR/PA ~170 PA). They are NOT fitted to historical outcomes — fitting is a
// deferred future phase.
// ─────────────────────────────────────────────────────────────────────────────

import { clamp } from "./normalizeStats";

/**
 * Shrink an observed rate toward a prior using a beta-binomial-style weight.
 *
 *   shrunk = (n * observed + k * prior) / (n + k)
 *
 * `k` is the stabilization constant (the sample size at which observed and prior
 * are weighted equally). Larger `k` → more shrinkage. When `n` or `observed` is
 * missing, returns the prior with weight 0.
 */
export function shrinkRate(
  observed: number | null | undefined,
  sample: number | null | undefined,
  prior: number,
  k: number,
): { value: number; weight: number; sample: number } {
  const n = Number.isFinite(sample as number) ? Math.max(0, sample as number) : 0;
  if (observed == null || !Number.isFinite(observed) || n <= 0 || k <= 0) {
    return { value: prior, weight: 0, sample: n };
  }
  const weight = n / (n + k); // [0,1): fraction of trust placed in the observation
  const value = (n * observed + k * prior) / (n + k);
  return { value, weight, sample: n };
}

/**
 * Convenience: the shrinkage weight n/(n+k) alone, in [0,1). Used to scale a
 * feature's log-odds contribution by how trustworthy its sample is.
 */
export function shrinkWeight(
  sample: number | null | undefined,
  k: number,
): number {
  const n = Number.isFinite(sample as number) ? Math.max(0, sample as number) : 0;
  if (n <= 0 || k <= 0) return 0;
  return clamp(n / (n + k), 0, 1);
}

/** Documented default stabilization points (sample sizes), by stat family. */
export const STABILIZATION_K = {
  hrPerPa: 170, // HR/PA stabilizes slowly
  barrelRate: 50, // barrels/BBE
  hardHitRate: 50,
  flyBallRate: 80,
  pullRate: 80,
  xStats: 60, // xSLG / xwOBAcon
  pitchTypeSplit: 40, // batter damage vs a pitch family (BBE)
  pitcherHrPer9: 60, // batters-faced-equivalent for pitcher splits
  pitcherBatted: 50,
  batTracking: 40, // competitive swings
} as const;
