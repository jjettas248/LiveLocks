// Mound Radar V2 (shadow) — pure statistical primitives.
//
// Self-contained rather than imported from server/mlb/math/distributions.ts
// (the live in-game engine's goldmaster-locked math) — same isolation
// rationale as ../scoreUtils.ts's header: Mound V2 must be independently
// reasoned about, never coupled to a different product's versioning
// discipline. Poisson-binomial (heterogeneous per-trial probability) does
// not exist anywhere else in this codebase; the live engine's distributions
// module has only homogeneous-rate Poisson/negative-binomial.
//
// No I/O, no randomness, no Date.now() — every function here is a pure
// numeric transform.

/** P(exactly k successes) for k=0..n, given n independent Bernoulli trials with (possibly all different) success probabilities. Standard O(n^2) DP convolution. Always sums to 1 (each step redistributes existing mass, never creates or destroys it). */
export function poissonBinomialPmf(probs: number[]): number[] {
  let pmf: number[] = [1];
  for (const rawP of probs) {
    const p = Math.max(0, Math.min(1, rawP));
    const next = new Array(pmf.length + 1).fill(0);
    for (let k = 0; k < pmf.length; k++) {
      next[k] += pmf[k] * (1 - p);
      next[k + 1] += pmf[k] * p;
    }
    pmf = next;
  }
  return pmf;
}

/**
 * Negative-binomial PMF for k=0..maxK, parameterized directly by mean and
 * variance (variance must exceed mean for genuine overdispersion — a count
 * distribution property real pitcher workload exhibits, unlike a Poisson's
 * forced mean=variance). Uses the standard normalized recurrence
 * P(0)=p^r, P(k)=P(k-1)*(1-p)*(k+r-1)/k rather than a direct factorial/
 * binomial-coefficient formula, so non-integer r (the typical case here)
 * and larger k never overflow. Truncated at maxK and renormalized to sum to
 * 1 — choose maxK generously (mean + several standard deviations) so the
 * folded/discarded tail mass is negligible.
 */
export function negativeBinomialPmf(mean: number, variance: number, maxK: number): number[] {
  const pmf = new Array(maxK + 1).fill(0);
  if (mean <= 0) {
    pmf[0] = 1;
    return pmf;
  }
  // Guarantee variance > mean so (p, r) resolve to valid NB parameters even
  // when a caller's variance estimate is degenerate (e.g. equal to the mean).
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

/** Adds `weight * contribution[k]` into `acc[k]` for every k, growing `acc` as needed. Does not mutate either input array. */
export function mixPmfInto(acc: number[], contribution: number[], weight: number): number[] {
  const len = Math.max(acc.length, contribution.length);
  const result = new Array(len).fill(0);
  for (let k = 0; k < acc.length; k++) result[k] += acc[k];
  for (let k = 0; k < contribution.length; k++) result[k] += contribution[k] * weight;
  return result;
}

/**
 * Truncates a PMF to maxLen+1 buckets, folding any tail mass beyond maxLen
 * into the last bucket (never silently discarding probability mass — see
 * CLAUDE.md "No silent caps"), then renormalizes so the result sums to 1.
 */
export function normalizePmf(pmf: number[], maxLen: number): number[] {
  const truncated = pmf.slice(0, maxLen + 1);
  while (truncated.length < maxLen + 1) truncated.push(0);
  if (pmf.length > maxLen + 1) {
    let tail = 0;
    for (let k = maxLen + 1; k < pmf.length; k++) tail += pmf[k];
    truncated[maxLen] += tail;
  }
  const total = truncated.reduce((a, b) => a + b, 0);
  if (total <= 0) return truncated;
  return truncated.map((p) => p / total);
}

export interface LineProbabilities {
  over: number;
  under: number;
  push: number;
}

/**
 * OVER/UNDER/push probability for a discrete count PMF against a betting
 * line. An integer line (e.g. 6.0) has real push mass at exactly that count;
 * a half line (e.g. 6.5) can never push — every count is strictly above or
 * below it. `over`+`under`+`push` always equals the PMF's total mass (≈1 for
 * a properly normalized PMF).
 */
export function computeLineProbabilities(pmf: number[], line: number): LineProbabilities {
  const isIntegerLine = Number.isInteger(line);
  let over = 0;
  let under = 0;
  let push = 0;
  for (let k = 0; k < pmf.length; k++) {
    if (isIntegerLine && k === line) {
      push += pmf[k];
    } else if (k > line) {
      over += pmf[k];
    } else {
      under += pmf[k];
    }
  }
  return { over, under, push };
}

export function expectedValueOfPmf(pmf: number[]): number {
  let sum = 0;
  for (let k = 0; k < pmf.length; k++) sum += pmf[k] * k;
  return sum;
}

// ── Joint strikeouts/outs process ───────────────────────────────────────────
// A joint (not independent) model of strikeouts and total outs recorded
// across n plate appearances. Each PA has exactly three outcomes:
//   - strikeout (probability pK)               -> +1 strikeout, +1 out
//   - non-strikeout out, e.g. groundout/flyout (probability (1-pK)*pNonKOut) -> +1 out only
//   - on-base, e.g. hit/walk/HBP                (remaining probability)      -> no change
// `cells[s][o]` = P(exactly s strikeouts AND exactly o total outs) after the
// trials processed so far. Because `s` only ever increments in lockstep with
// `o` (the strikeout transition adds to both, nothing adds to s alone), the
// invariant s <= o holds for every reachable cell BY CONSTRUCTION — there is
// no way for this table to ever assign probability mass to an incoherent
// (s > o) state. The table is always square: after k trials it is
// (k+1) x (k+1), so `o` (and therefore `s`) can never exceed the number of
// trials processed — outs can never exceed batters faced either.

/** Advances a joint (strikeouts, outs) table by exactly one plate appearance. Exported standalone (in addition to the batch helper below) so an engine can snapshot the marginal after every incremental trial without rebuilding from scratch — see moundV2Engine.ts. */
export function stepJointStrikeoutOutsPmf(cells: number[][], strikeoutProb: number, nonStrikeoutOutRate: number): number[][] {
  const pK = Math.max(0, Math.min(1, strikeoutProb));
  const pNonKOut = Math.max(0, Math.min(1, (1 - pK) * nonStrikeoutOutRate));
  const pOnBase = Math.max(0, 1 - pK - pNonKOut);

  const size = cells.length;
  const next: number[][] = Array.from({ length: size + 1 }, () => new Array(size + 1).fill(0));
  for (let s = 0; s < size; s++) {
    for (let o = 0; o < size; o++) {
      const p = cells[s][o];
      if (p <= 0) continue;
      next[s][o] += p * pOnBase;
      next[s][o + 1] += p * pNonKOut;
      next[s + 1][o + 1] += p * pK;
    }
  }
  return next;
}

/** Runs the full joint process over an explicit list of per-trial strikeout probabilities (one call per trial). Prefer stepJointStrikeoutOutsPmf directly when an engine wants a marginal snapshot after every trial rather than only the final one. */
export function computeJointStrikeoutOutsPmf(strikeoutProbs: number[], nonStrikeoutOutRate: number): number[][] {
  let cells: number[][] = [[1]];
  for (const p of strikeoutProbs) {
    cells = stepJointStrikeoutOutsPmf(cells, p, nonStrikeoutOutRate);
  }
  return cells;
}

/** Sums a square joint (strikeouts, outs) table down to a single 1-D marginal PMF over one dimension. */
export function marginalizeJointPmf(cells: number[][], dimension: "strikeouts" | "outs"): number[] {
  const size = cells.length;
  const result = new Array(size).fill(0);
  if (dimension === "strikeouts") {
    for (let s = 0; s < size; s++) {
      for (let o = 0; o < size; o++) result[s] += cells[s][o];
    }
  } else {
    for (let o = 0; o < size; o++) {
      for (let s = 0; s < size; s++) result[o] += cells[s][o];
    }
  }
  return result;
}
