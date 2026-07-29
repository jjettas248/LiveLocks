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
  stepJointStrikeoutOutsPmf,
  computeJointStrikeoutOutsPmf,
  marginalizeJointPmf,
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

// ── Joint (strikeouts, outs) process: structural coherence ─────────────────
{
  const probs = [0.25, 0.3, 0.15, 0.28, 0.2];
  const joint = computeJointStrikeoutOutsPmf(probs, 0.6);
  ok(joint.length === probs.length + 1, `joint table side length is n+1 (got ${joint.length})`);

  let total = 0;
  let sawPositiveMass = false;
  for (let s = 0; s < joint.length; s++) {
    for (let o = 0; o < joint[s].length; o++) {
      total += joint[s][o];
      if (joint[s][o] > 0) {
        sawPositiveMass = true;
        ok(s <= o, `every cell with positive mass satisfies strikeouts <= outs (s=${s}, o=${o}, p=${joint[s][o]})`);
      }
    }
  }
  ok(sawPositiveMass, "the joint table has real probability mass somewhere");
  ok(approx(total, 1, 1e-9), `the full joint table sums to 1 (got ${total})`);
}
{
  // outs can never exceed the number of trials (batters faced) processed.
  const probs = [0.2, 0.2, 0.2];
  const joint = computeJointStrikeoutOutsPmf(probs, 0.9);
  for (let s = 0; s < joint.length; s++) {
    for (let o = 0; o < joint[s].length; o++) {
      if (o > probs.length && joint[s][o] > 0) {
        ok(false, `outs=${o} exceeds the ${probs.length} trials processed but has positive mass ${joint[s][o]}`);
      }
    }
  }
  ok(true, "no cell assigns mass to an outs count exceeding the number of batters faced");
}
{
  // Zero non-strikeout-out rate: every non-K PA is on-base, so outs == strikeouts exactly.
  const probs = [0.3, 0.4, 0.2];
  const joint = computeJointStrikeoutOutsPmf(probs, 0);
  for (let s = 0; s < joint.length; s++) {
    for (let o = 0; o < joint[s].length; o++) {
      if (joint[s][o] > 1e-12) {
        ok(s === o, `with nonStrikeoutOutRate=0, every strikeout IS the only source of outs, so s must equal o (got s=${s}, o=${o})`);
      }
    }
  }
}
{
  // Building incrementally (stepJointStrikeoutOutsPmf repeatedly) matches the batch helper.
  const probs = [0.22, 0.31, 0.18];
  const batch = computeJointStrikeoutOutsPmf(probs, 0.55);
  let incremental: number[][] = [[1]];
  for (const p of probs) incremental = stepJointStrikeoutOutsPmf(incremental, p, 0.55);
  ok(JSON.stringify(batch) === JSON.stringify(incremental), "computeJointStrikeoutOutsPmf and repeated stepJointStrikeoutOutsPmf calls agree exactly");
}
{
  const probs = [0.25, 0.3, 0.15, 0.28];
  const joint = computeJointStrikeoutOutsPmf(probs, 0.6);
  const strikeoutMarginal = marginalizeJointPmf(joint, "strikeouts");
  const outsMarginal = marginalizeJointPmf(joint, "outs");
  ok(approx(sum(strikeoutMarginal), 1, 1e-9), "strikeouts marginal sums to 1");
  ok(approx(sum(outsMarginal), 1, 1e-9), "outs marginal sums to 1");
  ok(expectedValueOfPmf(strikeoutMarginal) <= expectedValueOfPmf(outsMarginal) + 1e-9,
    `expected strikeouts (${expectedValueOfPmf(strikeoutMarginal).toFixed(4)}) never exceeds expected outs (${expectedValueOfPmf(outsMarginal).toFixed(4)}) in aggregate`);
}

console.log(`\nmoundV2Math.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
