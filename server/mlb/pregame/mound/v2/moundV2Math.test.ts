// Mound V2 statistical primitives — invariants.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2Math.test.ts

import {
  poissonBinomialPmf,
  negativeBinomialPmf,
  mixPmfInto,
  normalizePmf,
  computeLineProbabilities,
  expectedValueOfPmf,
} from "./moundV2Math";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}
function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

// ── poissonBinomialPmf ──────────────────────────────────────────────────────
{
  const pmf = poissonBinomialPmf([0.5, 0.5]);
  // Two fair coins: P(0)=0.25, P(1)=0.5, P(2)=0.25
  ok(approx(pmf[0], 0.25) && approx(pmf[1], 0.5) && approx(pmf[2], 0.25), `two p=0.5 trials gives binomial(2,0.5): [${pmf.map((p) => p.toFixed(4))}]`);
  ok(approx(sum(pmf), 1), "poissonBinomialPmf always sums to 1 (homogeneous case)");
}
{
  // Heterogeneous case, hand-verified: p1=0.2, p2=0.7.
  // P(0)=(0.8)(0.3)=0.24, P(1)=(0.2)(0.3)+(0.8)(0.7)=0.06+0.56=0.62, P(2)=(0.2)(0.7)=0.14
  const pmf = poissonBinomialPmf([0.2, 0.7]);
  ok(approx(pmf[0], 0.24), `heterogeneous P(0)=0.24 (got ${pmf[0]})`);
  ok(approx(pmf[1], 0.62), `heterogeneous P(1)=0.62 (got ${pmf[1]})`);
  ok(approx(pmf[2], 0.14), `heterogeneous P(2)=0.14 (got ${pmf[2]})`);
  ok(approx(sum(pmf), 1), "heterogeneous PMF sums to 1");
}
{
  const pmf = poissonBinomialPmf([]);
  ok(pmf.length === 1 && approx(pmf[0], 1), "zero trials yields P(0 successes)=1 with no other mass");
}
{
  const probs = Array.from({ length: 30 }, () => 0.223);
  const pmf = poissonBinomialPmf(probs);
  ok(approx(sum(pmf), 1, 1e-6), "a large (30-trial) heterogeneous-capable PMF still sums to 1");
  ok(approx(expectedValueOfPmf(pmf), 30 * 0.223, 1e-6), "expected value matches n*p for the homogeneous-probability case");
}

// ── negativeBinomialPmf ──────────────────────────────────────────────────────
{
  const mean = 18; // e.g. expected outs
  const variance = 30; // overdispersed vs a Poisson(18) which would have variance=18
  const pmf = negativeBinomialPmf(mean, variance, 60);
  ok(approx(sum(pmf), 1, 1e-6), `negative-binomial PMF sums to 1 (got ${sum(pmf)})`);
  ok(approx(expectedValueOfPmf(pmf), mean, 0.05), `negative-binomial expected value is close to the target mean ${mean} (got ${expectedValueOfPmf(pmf)})`);
  ok(pmf.every((p) => p >= 0), "every probability is non-negative");
}
{
  const pmf = negativeBinomialPmf(0, 5, 10);
  ok(approx(pmf[0], 1) && pmf.slice(1).every((p) => p === 0), "mean<=0 degenerates cleanly to P(0)=1");
}
{
  // variance <= mean (degenerate/invalid input) must not throw or produce NaNs.
  const pmf = negativeBinomialPmf(10, 10, 40);
  ok(pmf.every((p) => Number.isFinite(p) && p >= 0), "variance==mean does not produce NaN/negative probabilities (safe fallback variance is used)");
  ok(approx(sum(pmf), 1, 1e-6), "variance==mean case still sums to 1");
}

// ── mixPmfInto / normalizePmf ─────────────────────────────────────────────
{
  let acc = [0];
  acc = mixPmfInto(acc, [0.5, 0.5], 0.4);
  acc = mixPmfInto(acc, [0.2, 0.3, 0.5], 0.6);
  // 0.4*[0.5,0.5,0] + 0.6*[0.2,0.3,0.5] = [0.2,0.2,0] + [0.12,0.18,0.3] = [0.32,0.38,0.3]
  ok(approx(acc[0], 0.32) && approx(acc[1], 0.38) && approx(acc[2], 0.3), `mixPmfInto weighted-sums correctly: [${acc.map((p) => p.toFixed(4))}]`);
  ok(approx(sum(acc), 1), "a mixture of two PMFs whose weights sum to 1 itself sums to 1");
}
{
  const wide = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
  const truncated = normalizePmf(wide, 4);
  ok(truncated.length === 5, "normalizePmf truncates to maxLen+1 buckets");
  ok(approx(sum(truncated), 1, 1e-9), "normalizePmf folds tail mass into the last bucket rather than discarding it, still summing to 1");
  ok(approx(truncated[4], 0.6, 1e-9), `tail mass (indices 4-9, each 0.1) folds into bucket 4: expected 0.6, got ${truncated[4]}`);
}

// ── computeLineProbabilities ───────────────────────────────────────────────
{
  // Uniform-ish PMF over 0..10 for clean hand-verification.
  const pmf = new Array(11).fill(1 / 11);
  const half = computeLineProbabilities(pmf, 5.5);
  ok(approx(half.push, 0), "a half-integer line has zero push probability");
  ok(approx(half.over + half.under + half.push, 1, 1e-9), "over+under+push sums to the PMF's total mass for a half line");
  ok(approx(half.over, 5 / 11, 1e-9) && approx(half.under, 6 / 11, 1e-9), `half line 5.5 splits into over=5/11 (6..10), under=6/11 (0..5): got over=${half.over}, under=${half.under}`);

  const int = computeLineProbabilities(pmf, 5);
  ok(int.push > 0, "an integer line has nonzero push probability when the PMF has mass at exactly that value");
  ok(approx(int.push, 1 / 11, 1e-9), `integer line push mass equals P(X=5)=1/11 (got ${int.push})`);
  ok(approx(int.over + int.under + int.push, 1, 1e-9), "over+under+push sums to the PMF's total mass for an integer line");
}

console.log(`\nmoundV2Math.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
