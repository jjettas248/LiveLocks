// PR3 — NBA Pregame Targets: self-contained count-PMF primitives.
//
// Pure, deterministic, line-free discrete-distribution math for the blind
// projection core. Self-contained by design (the same isolation discipline as
// Mound V2's moundV2Math.ts) — never imported from another sport's engine and
// never coupled to a live engine's versioned math. No I/O, no Date.now(), no
// Math.random().
//
// DELIBERATELY ABSENT: any line-conditional function. There is no
// `computeLineProbabilities`, no OVER/UNDER/push, no expected-value-against-a-
// line, no implied probability. A betting line is never an argument to anything
// here. These helpers produce and manipulate line-free count PMFs and their
// moments ONLY; the line-decision layer (PR4) is where any line meets a PMF.
//
// A "PMF" here is a probability mass function over the non-negative integers
// 0..N-1, represented as `number[]` where `pmf[k] = P(count = k)`. A normalized
// PMF sums to 1 (within floating tolerance).

/** Absolute tolerance for "sums to 1" checks throughout the engine. */
export const PMF_SUM_TOLERANCE = 1e-9;

/** A fresh all-zero PMF of the given length (length = maxK+1 buckets, 0..maxK). */
export function zerosPmf(length: number): number[] {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(`zerosPmf: length must be a positive integer, got ${length}`);
  }
  return new Array(length).fill(0);
}

/**
 * Negative-binomial PMF for k=0..maxK, parameterized directly by mean and
 * variance. Overdispersion (variance > mean) is genuine count behavior a
 * player's per-game production exhibits; a caller passing variance <= mean gets
 * a minimally-overdispersed distribution rather than a degenerate one. Uses the
 * normalized recurrence P(0)=p^r, P(k)=P(k-1)·(1-p)·(k+r-1)/k so non-integer r
 * never overflows. Truncated at maxK and renormalized — choose maxK generously
 * (mean + several SD) so folded tail mass is negligible. THROWS on a non-finite
 * mean/variance (an impossible internal state the pure core must surface, not
 * silently normalize — see the two-layer error contract).
 */
export function negativeBinomialPmf(mean: number, variance: number, maxK: number): number[] {
  if (!Number.isFinite(mean) || !Number.isFinite(variance)) {
    throw new Error(`negativeBinomialPmf: non-finite mean=${mean} variance=${variance}`);
  }
  if (!Number.isInteger(maxK) || maxK < 0) {
    throw new Error(`negativeBinomialPmf: maxK must be a non-negative integer, got ${maxK}`);
  }
  const pmf = new Array(maxK + 1).fill(0);
  if (mean <= 0) {
    pmf[0] = 1;
    return pmf;
  }
  const safeVariance = Math.max(variance, mean * 1.001 + 1e-6);
  const p = Math.max(1e-9, Math.min(1 - 1e-9, mean / safeVariance));
  const r = (mean * mean) / (safeVariance - mean);
  pmf[0] = Math.pow(p, r);
  for (let k = 1; k <= maxK; k++) {
    pmf[k] = pmf[k - 1] * (1 - p) * ((k + r - 1) / k);
  }
  const total = pmf.reduce((a, b) => a + b, 0);
  if (total > 0) {
    for (let k = 0; k <= maxK; k++) pmf[k] /= total;
  }
  return pmf;
}

/**
 * Adds `weight · contribution[k]` into a copy of `acc[k]` for every k, growing
 * the result as needed. Does not mutate either input. The mixture-accumulation
 * primitive: mixing conditional PMFs over a shared latent grid is repeated calls
 * to this. THROWS on a non-finite weight (an invalid mixture weight).
 */
export function mixPmfInto(acc: number[], contribution: number[], weight: number): number[] {
  if (!Number.isFinite(weight)) throw new Error(`mixPmfInto: non-finite weight ${weight}`);
  const len = Math.max(acc.length, contribution.length);
  const result = new Array(len).fill(0);
  for (let k = 0; k < acc.length; k++) result[k] += acc[k];
  for (let k = 0; k < contribution.length; k++) result[k] += contribution[k] * weight;
  return result;
}

/**
 * Discrete convolution of two independent count PMFs: the distribution of X+Y
 * where X~a, Y~b are INDEPENDENT. IMPORTANT — this is only ever valid to apply
 * to CONDITIONALLY-independent components (component marginals given a fixed
 * latent state), never to mixture-collapsed marginals. Convolving separated
 * (collapsed) marginals would discard the correlation between stats; combo
 * markets must instead be summed per-latent then mixed (see the joint module),
 * which is mathematically identical to reading the combo off the full joint
 * states. THROWS on a non-finite cell.
 */
export function convolvePmf(a: number[], b: number[]): number[] {
  if (a.length === 0 || b.length === 0) return [];
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (!Number.isFinite(ai)) throw new Error(`convolvePmf: non-finite a[${i}]`);
    if (ai === 0) continue;
    for (let j = 0; j < b.length; j++) {
      out[i + j] += ai * b[j];
    }
  }
  return out;
}

/**
 * Truncates a PMF to maxLen+1 buckets, FOLDING tail mass beyond maxLen into the
 * last bucket (never silently discarding probability — "No silent caps"), then
 * renormalizes so the result sums to 1. THROWS if the PMF carries a non-finite
 * or negative mass (an impossible state to be detected, not normalized away) or
 * has zero total mass (nothing to normalize — a corrupt distribution).
 */
export function normalizePmf(pmf: number[], maxLen: number): number[] {
  if (!Number.isInteger(maxLen) || maxLen < 0) {
    throw new Error(`normalizePmf: maxLen must be a non-negative integer, got ${maxLen}`);
  }
  for (let k = 0; k < pmf.length; k++) {
    if (!Number.isFinite(pmf[k])) throw new Error(`normalizePmf: non-finite mass at ${k}`);
    if (pmf[k] < 0) throw new Error(`normalizePmf: negative mass ${pmf[k]} at ${k}`);
  }
  const truncated = pmf.slice(0, maxLen + 1);
  while (truncated.length < maxLen + 1) truncated.push(0);
  if (pmf.length > maxLen + 1) {
    let tail = 0;
    for (let k = maxLen + 1; k < pmf.length; k++) tail += pmf[k];
    truncated[maxLen] += tail;
  }
  const total = truncated.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error(`normalizePmf: zero total mass`);
  return truncated.map((p) => p / total);
}

/** True iff `pmf` is finite, non-negative everywhere, and sums to 1 within tol. */
export function isNormalized(pmf: number[], tol: number = PMF_SUM_TOLERANCE): boolean {
  let total = 0;
  for (const p of pmf) {
    if (!Number.isFinite(p) || p < 0) return false;
    total += p;
  }
  return Math.abs(total - 1) <= tol;
}

/** Mean E[k] = Σ k·pmf[k]. THROWS on a non-finite cell (impossible-state guard). */
export function meanOfPmf(pmf: number[]): number {
  let sum = 0;
  for (let k = 0; k < pmf.length; k++) {
    if (!Number.isFinite(pmf[k])) throw new Error(`meanOfPmf: non-finite mass at ${k}`);
    sum += pmf[k] * k;
  }
  return sum;
}

/**
 * Population variance E[k²] − E[k]². THROWS on a non-finite cell. Guards tiny
 * negative results from floating cancellation up to 0.
 */
export function varianceOfPmf(pmf: number[]): number {
  let m1 = 0;
  let m2 = 0;
  for (let k = 0; k < pmf.length; k++) {
    if (!Number.isFinite(pmf[k])) throw new Error(`varianceOfPmf: non-finite mass at ${k}`);
    m1 += pmf[k] * k;
    m2 += pmf[k] * k * k;
  }
  const raw = m2 - m1 * m1;
  return raw < 0 ? 0 : raw;
}
