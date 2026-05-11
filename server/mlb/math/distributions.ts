/**
 * Shared MLB probability/distribution primitives.
 *
 * EXTRACTED — DO NOT MUTATE FORMULAS WITHOUT REGRESSION REVIEW.
 *
 * This module consolidates math primitives that were previously duplicated
 * across server/mlb/probabilityEngine.ts, server/mlb/hitProbabilityModel.ts,
 * server/mlb/outcomeDistribution.ts, and server/mlb/paDistribution.ts.
 *
 * Every function here preserves the EXACT numeric behavior of its prior
 * inline implementation. Two NB variants are intentionally exposed
 * (unclamped vs safe-clamped) because the prior call sites used different
 * log-domain guards and those guards must not change.
 */

export function binomialCoeff(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/**
 * Probability of >= target successes in n=remainingPA Bernoulli trials with
 * success rate `rate`. Returns a value in [0, 100].
 *
 * Includes an explicit upper-tail branch when target > n (matches the prior
 * hitProbabilityModel.ts implementation). The probabilityEngine.ts version
 * lacked the explicit branch but was mathematically equivalent because
 * binomialCoeff(n, k>n) = 0 forces the same result.
 */
export function binomialOverProbability(
  remainingPA: number,
  rate: number,
  target: number,
): number {
  const n = Math.round(Math.max(1, remainingPA));
  const p = Math.max(0, Math.min(1, rate));
  const t = Math.max(0, Math.ceil(target));

  if (t <= 0) return 100;
  if (t > n) {
    let prob = 0;
    for (let k = t; k <= n; k++) {
      prob += binomialCoeff(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
    }
    return prob * 100;
  }

  let cumUnder = 0;
  for (let k = 0; k < t; k++) {
    cumUnder += binomialCoeff(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
  }
  return (1 - cumUnder) * 100;
}

export function logGamma(z: number): number {
  if (z <= 0) return Infinity;
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953,
  ];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += c[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/**
 * Negative binomial PMF — UNCLAMPED variant.
 * Matches the prior probabilityEngine.ts implementation exactly:
 *   log args are not protected against log(0). Caller must guard NaN/-Inf.
 */
export function negativeBinomialPMF(x: number, k: number, p: number): number {
  const logCoeff = logGamma(x + k) - logGamma(x + 1) - logGamma(k);
  const logProb = x * Math.log(1 - p) + k * Math.log(p);
  return Math.exp(logCoeff + logProb);
}

/**
 * Negative binomial PMF — SAFE-CLAMPED variant.
 * Matches the prior outcomeDistribution.ts implementation exactly:
 *   log args clamped to >= 1e-15 to avoid log(0) = -Infinity.
 */
export function negativeBinomialPMFSafe(x: number, k: number, p: number): number {
  const logCoeff = logGamma(x + k) - logGamma(x + 1) - logGamma(k);
  const logProb =
    x * Math.log(Math.max(1e-15, 1 - p)) + k * Math.log(Math.max(1e-15, p));
  return Math.exp(logCoeff + logProb);
}

export function poissonPMF(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logProb = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logProb -= Math.log(i);
  return Math.exp(logProb);
}
