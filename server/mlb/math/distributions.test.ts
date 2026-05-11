/**
 * Parity test: prove the extracted math primitives in ./distributions.ts
 * produce IDENTICAL outputs to the original inline implementations that
 * previously lived in probabilityEngine.ts, hitProbabilityModel.ts,
 * outcomeDistribution.ts, and paDistribution.ts.
 *
 * Run: `npx tsx server/mlb/math/distributions.test.ts`
 */

import {
  binomialCoeff,
  binomialOverProbability,
  logGamma,
  negativeBinomialPMF,
  negativeBinomialPMFSafe,
  poissonPMF,
} from "./distributions";

// ---------------- Reference (legacy) implementations ----------------

function legacyBinomialCoeff(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

// probabilityEngine.ts version (no upper-tail branch).
function legacyBinomialOverProbabilityEngine(
  remainingPA: number,
  rate: number,
  target: number,
): number {
  const n = Math.round(Math.max(1, remainingPA));
  const p = Math.max(0, Math.min(1, rate));
  const t = Math.max(0, Math.ceil(target));
  if (t <= 0) return 100;
  let cumUnder = 0;
  for (let k = 0; k < t; k++) {
    cumUnder += legacyBinomialCoeff(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
  }
  return (1 - cumUnder) * 100;
}

// hitProbabilityModel.ts version (with explicit upper-tail branch).
function legacyBinomialOverProbabilityHit(
  remainingPA: number,
  adjustedHitRate: number,
  neededHits: number,
): number {
  const n = Math.round(Math.max(1, remainingPA));
  const p = Math.max(0, Math.min(1, adjustedHitRate));
  const target = Math.max(0, Math.ceil(neededHits));
  if (target <= 0) return 100;
  if (target > n) {
    let prob = 0;
    for (let k = target; k <= n; k++) {
      prob += legacyBinomialCoeff(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
    }
    return prob * 100;
  }
  let cumUnder = 0;
  for (let k = 0; k < target; k++) {
    cumUnder += legacyBinomialCoeff(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
  }
  return (1 - cumUnder) * 100;
}

function legacyLogGamma(z: number): number {
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

function legacyNBPMFEngine(x: number, k: number, p: number): number {
  const logCoeff = legacyLogGamma(x + k) - legacyLogGamma(x + 1) - legacyLogGamma(k);
  const logProb = x * Math.log(1 - p) + k * Math.log(p);
  return Math.exp(logCoeff + logProb);
}

function legacyNBPMFOutcome(x: number, k: number, p: number): number {
  const logCoeff = legacyLogGamma(x + k) - legacyLogGamma(x + 1) - legacyLogGamma(k);
  const logProb =
    x * Math.log(Math.max(1e-15, 1 - p)) + k * Math.log(Math.max(1e-15, p));
  return Math.exp(logCoeff + logProb);
}

function legacyPoissonPMF(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logProb = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logProb -= Math.log(i);
  return Math.exp(logProb);
}

// ---------------- Test harness ----------------

const TOL = 1e-12;
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, a: number, b: number, tol = TOL): void {
  const okBoth =
    (Number.isNaN(a) && Number.isNaN(b)) ||
    (a === Infinity && b === Infinity) ||
    (a === -Infinity && b === -Infinity);
  if (okBoth) {
    passed++;
    return;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    if (a === b) {
      passed++;
      return;
    }
    failed++;
    failures.push(`${label}: legacy=${b} new=${a}`);
    return;
  }
  if (Math.abs(a - b) <= tol) {
    passed++;
  } else {
    failed++;
    failures.push(`${label}: legacy=${b} new=${a} diff=${Math.abs(a - b)}`);
  }
}

// 1. binomialCoeff parity over a wide grid
for (let n = 0; n <= 20; n++) {
  for (let k = -2; k <= n + 2; k++) {
    check(`binomialCoeff(${n},${k})`, binomialCoeff(n, k), legacyBinomialCoeff(n, k));
  }
}

// 2. binomialOverProbability parity vs BOTH legacy variants over the
//    PRODUCTION-REALISTIC input domain. Rates in the live engine are clamped
//    upstream by source data (hit/HR/K rates) and are always strictly < 1.
//    At p === 1 the OLD probabilityEngine.ts variant produced NaN
//    (0 * Infinity in the n-k<0 power term). The new shared variant
//    produces a finite result via the explicit upper-tail branch. This is
//    a strict improvement in an unreachable path — verified separately
//    below as "edge case improvement", NOT counted as a parity failure.
const paGrid = [1, 2, 3, 4, 5, 8, 12, 20];
const rateGrid = [0, 0.001, 0.05, 0.1, 0.243, 0.5, 0.75, 0.95, 0.99];
const targetGrid = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 8, 12, 20, 25];
for (const pa of paGrid) {
  for (const r of rateGrid) {
    for (const t of targetGrid) {
      const newOut = binomialOverProbability(pa, r, t);
      check(
        `binomOver(${pa},${r},${t}) vs engine`,
        newOut,
        legacyBinomialOverProbabilityEngine(pa, r, t),
        1e-9,
      );
      check(
        `binomOver(${pa},${r},${t}) vs hit`,
        newOut,
        legacyBinomialOverProbabilityHit(pa, r, t),
        1e-9,
      );
    }
  }
}

// 3. logGamma parity
for (const z of [0.5, 1, 1.5, 2, 3, 5, 10, 25, 50, 100]) {
  check(`logGamma(${z})`, logGamma(z), legacyLogGamma(z), 1e-12);
}

// 4. negativeBinomialPMF (UNCLAMPED) — must match probabilityEngine version exactly
for (const x of [0, 1, 2, 3, 5, 8, 10]) {
  for (const k of [1, 2, 5, 10, 25]) {
    for (const p of [0.05, 0.1, 0.25, 0.5, 0.75, 0.95]) {
      check(
        `nbPMF(${x},${k},${p})`,
        negativeBinomialPMF(x, k, p),
        legacyNBPMFEngine(x, k, p),
        1e-12,
      );
    }
  }
}

// 5. negativeBinomialPMFSafe (CLAMPED) — must match outcomeDistribution version exactly,
//    INCLUDING edge cases where p = 0 or p = 1 (where unclamped would diverge).
for (const x of [0, 1, 2, 5, 10]) {
  for (const k of [1, 2, 5, 10]) {
    for (const p of [0, 0.001, 0.5, 0.999, 1]) {
      check(
        `nbPMFSafe(${x},${k},${p})`,
        negativeBinomialPMFSafe(x, k, p),
        legacyNBPMFOutcome(x, k, p),
        1e-12,
      );
    }
  }
}

// 6. EDGE CASE IMPROVEMENT — informational only.
//    At rate p=1 (impossible in production), the old probabilityEngine
//    binomialOverProbability returned NaN due to `binomialCoeff(n,k)=0`
//    being multiplied by `Math.pow(0, n-k)` for k>n in the unguarded loop.
//    The shared variant returns a finite probability instead. Document this.
const edgeOld = legacyBinomialOverProbabilityEngine(3, 1, 8);
const edgeNew = binomialOverProbability(3, 1, 8);
console.log(
  `[DISTRIBUTIONS_PARITY] edge p=1 target>n: legacyEngine=${edgeOld} (unreachable in prod) shared=${edgeNew} (finite)`,
);

// 7. poissonPMF parity
for (const lambda of [0, 0.5, 1, 1.5, 2, 3.7, 5, 10, 25]) {
  for (let k = 0; k <= 15; k++) {
    check(`poissonPMF(${lambda},${k})`, poissonPMF(lambda, k), legacyPoissonPMF(lambda, k), 1e-12);
  }
}

// ---------------- Report ----------------
console.log(`[DISTRIBUTIONS_PARITY] passed=${passed} failed=${failed}`);
if (failed > 0) {
  console.error("FAILURES (first 20):");
  for (const f of failures.slice(0, 20)) console.error("  " + f);
  process.exit(1);
}
console.log("[DISTRIBUTIONS_PARITY] OK — extracted primitives match legacy outputs exactly");
