// Run: npx tsx server/engines/nbaPregame/math/pmf.test.ts
// Pregame Targets PR3 — PMF primitives: NB PMF, mixture, convolution, tail-fold
// normalization, moments; determinism; NO line-conditional function exists.
import {
  zerosPmf,
  negativeBinomialPmf,
  mixPmfInto,
  convolvePmf,
  normalizePmf,
  isNormalized,
  meanOfPmf,
  varianceOfPmf,
  PMF_SUM_TOLERANCE,
} from "./pmf";
import * as pmfModule from "./pmf";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ── NO line-conditional export exists in the primitives module ──────────────
{
  const names = Object.keys(pmfModule);
  const forbidden = ["computeLineProbabilities", "lineProbabilities", "overUnder", "pWin", "pPush", "pLose", "expectedValue", "impliedProbability"];
  ok(!names.some((n) => forbidden.includes(n)), "no line-conditional / EV export in pmf primitives");
}

// ── negativeBinomialPmf: normalized, correct mean, overdispersed variance ───
{
  const pmf = negativeBinomialPmf(20, 40, 120);
  ok(isNormalized(pmf), "NB PMF is normalized");
  ok(approx(meanOfPmf(pmf), 20, 0.05), "NB mean ≈ requested mean");
  ok(varianceOfPmf(pmf) > 20, "NB variance overdispersed (> mean)");
  // Degenerate variance <= mean is lifted to minimal overdispersion, still valid.
  const pmf2 = negativeBinomialPmf(10, 5, 80);
  ok(isNormalized(pmf2), "NB with variance<=mean still normalized");
  ok(varianceOfPmf(pmf2) >= meanOfPmf(pmf2) - 1e-6, "NB variance>=mean after safety lift");
  // mean <= 0 → point mass at 0.
  const pmf0 = negativeBinomialPmf(0, 1, 10);
  ok(pmf0[0] === 1 && approx(meanOfPmf(pmf0), 0), "NB mean 0 → point mass at 0");
}

// ── Determinism: identical inputs → byte-identical output ───────────────────
{
  const a = negativeBinomialPmf(18.3, 33.1, 100);
  const b = negativeBinomialPmf(18.3, 33.1, 100);
  ok(JSON.stringify(a) === JSON.stringify(b), "NB PMF deterministic");
}

// ── negativeBinomialPmf throws on non-finite params (impossible state) ──────
{
  ok(throws(() => negativeBinomialPmf(NaN, 10, 20)), "NB throws on NaN mean");
  ok(throws(() => negativeBinomialPmf(10, Infinity, 20)), "NB throws on Infinite variance");
  ok(throws(() => negativeBinomialPmf(10, 20, -1)), "NB throws on negative maxK");
}

// ── mixPmfInto: mixture accumulation ────────────────────────────────────────
{
  const acc = zerosPmf(4);
  const c1 = [0.5, 0.5, 0, 0];
  const c2 = [0, 0, 0.5, 0.5];
  let m = mixPmfInto(acc, c1, 0.4);
  m = mixPmfInto(m, c2, 0.6);
  ok(approx(m.reduce((a, b) => a + b, 0), 1), "mixture of weights 0.4+0.6 sums to 1");
  ok(approx(m[0], 0.2) && approx(m[3], 0.3), "mixture cells combine correctly");
  ok(throws(() => mixPmfInto(acc, c1, NaN)), "mixPmfInto throws on non-finite weight");
}

// ── convolvePmf: sum of two independent counts ──────────────────────────────
{
  // X ~ {0:0.5, 1:0.5}, Y ~ {0:0.5,1:0.5} → X+Y ~ {0:.25,1:.5,2:.25}
  const conv = convolvePmf([0.5, 0.5], [0.5, 0.5]);
  ok(conv.length === 3, "convolution length = la+lb-1");
  ok(approx(conv[0], 0.25) && approx(conv[1], 0.5) && approx(conv[2], 0.25), "convolution mass correct");
  // Mean of a sum of independents = sum of means.
  const x = negativeBinomialPmf(6, 10, 60);
  const y = negativeBinomialPmf(4, 7, 60);
  const sum = convolvePmf(x, y);
  ok(approx(meanOfPmf(sum), meanOfPmf(x) + meanOfPmf(y), 1e-6), "conv mean = sum of means");
  // Variance of a sum of INDEPENDENTS = sum of variances (no covariance here).
  ok(approx(varianceOfPmf(sum), varianceOfPmf(x) + varianceOfPmf(y), 1e-6), "conv variance = sum of variances (independent)");
  ok(throws(() => convolvePmf([0.5, NaN], [1])), "convolvePmf throws on non-finite cell");
}

// ── normalizePmf: tail-fold (no silent drop) + renormalize ──────────────────
{
  // Mass beyond maxLen folds into the last bucket rather than vanishing.
  const raw = [0.1, 0.2, 0.3, 0.4]; // sums to 1
  const folded = normalizePmf(raw, 2); // keep 0..2, fold bucket 3 into 2
  ok(folded.length === 3, "normalizePmf truncates to maxLen+1 buckets");
  ok(approx(folded.reduce((a, b) => a + b, 0), 1), "normalized sums to 1");
  ok(approx(folded[2], 0.7), "tail mass folded into last bucket (0.3+0.4)");
  // Short PMF is zero-padded up to maxLen+1.
  const padded = normalizePmf([1], 3);
  ok(padded.length === 4 && padded[0] === 1, "short PMF zero-padded");
  // Detects corruption instead of normalizing it away.
  ok(throws(() => normalizePmf([0.5, NaN], 2)), "normalizePmf throws on non-finite mass");
  ok(throws(() => normalizePmf([0.5, -0.1], 2)), "normalizePmf throws on negative mass");
  ok(throws(() => normalizePmf([0, 0, 0], 2)), "normalizePmf throws on zero total mass");
}

// ── isNormalized / moments ──────────────────────────────────────────────────
{
  ok(isNormalized([0.25, 0.5, 0.25]), "isNormalized true for valid PMF");
  ok(!isNormalized([0.5, 0.6]), "isNormalized false when sum != 1");
  ok(!isNormalized([0.5, -0.1, 0.6]), "isNormalized false on negative mass");
  ok(!isNormalized([0.5, NaN]), "isNormalized false on non-finite mass");
  ok(Math.abs(PMF_SUM_TOLERANCE) < 1e-6, "tolerance is tight");
  ok(throws(() => meanOfPmf([0.5, NaN])), "meanOfPmf throws on non-finite mass");
  ok(throws(() => varianceOfPmf([NaN])), "varianceOfPmf throws on non-finite mass");
  // Known variance: fair die-ish {0,1,2} uniform → mean 1, var 2/3.
  const uni = [1 / 3, 1 / 3, 1 / 3];
  ok(approx(meanOfPmf(uni), 1), "uniform {0,1,2} mean = 1");
  ok(approx(varianceOfPmf(uni), 2 / 3, 1e-9), "uniform {0,1,2} variance = 2/3");
}

console.log(`\npmf.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
