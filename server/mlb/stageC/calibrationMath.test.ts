// MLB Stage C — calibration math primitives invariants.
//
// Run: npx tsx server/mlb/stageC/calibrationMath.test.ts

import {
  brierScore,
  logLoss,
  reliabilityBins,
  shrinkRate,
  isotonicPav,
  expectedCalibrationErrorPct,
  basePositiveRate,
  type CalObs,
} from "./calibrationMath";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps = 1e-6): boolean { return Math.abs(a - b) < eps; }

// Brier
{
  ok(brierScore([]) === 0, "empty Brier = 0");
  ok(approx(brierScore([{ p: 1, y: 1 }]), 0), "perfect prediction Brier 0");
  ok(approx(brierScore([{ p: 0, y: 1 }]), 1), "worst prediction Brier 1");
  ok(approx(brierScore([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }]), 0.25), "0.5 predictions Brier 0.25");
}

// Log loss (clamped)
{
  ok(approx(logLoss([{ p: 0.5, y: 1 }]), Math.log(2), 1e-6), "logLoss(0.5,1)=ln2");
  ok(logLoss([{ p: 1, y: 1 }]) < 1e-9, "logLoss(1,1)≈0 (clamped, no -Infinity)");
  ok(Number.isFinite(logLoss([{ p: 0, y: 1 }])), "logLoss(0,1) finite (clamped, not Infinity)");
}

// basePositiveRate
{
  ok(approx(basePositiveRate([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }, { p: 0.5, y: 1 }]), 2 / 3), "base rate = mean y");
}

// Reliability bins
{
  const obs: CalObs[] = [
    { p: 0.05, y: 0 }, { p: 0.15, y: 0 }, // bin 0,1
    { p: 0.85, y: 1 }, { p: 0.95, y: 1 }, // bin 8,9
  ];
  const bins = reliabilityBins(obs, 10);
  ok(bins.length === 10, "k=10 bins");
  ok(bins[0].count === 1 && bins[1].count === 1 && bins[8].count === 1 && bins[9].count === 1, "obs land in correct bins");
  ok(bins[9].empiricalRate === 1 && bins[0].empiricalRate === 0, "empirical rates per bin");
  ok(approx(bins[8].meanPredicted, 0.85), "bin center = mean predicted");
  // p === 1 lands in last bin, not out of range
  const edge = reliabilityBins([{ p: 1, y: 1 }], 10);
  ok(edge[9].count === 1, "p===1 lands in the last bin");
}

// Shrinkage toward prior
{
  ok(approx(shrinkRate(5, 10, 0.5, 10), 0.5), "shrink(5/10, prior .5, m10)=0.5");
  ok(approx(shrinkRate(1, 1, 0.2, 20), (1 + 20 * 0.2) / 21), "low-count bin pulled toward prior");
  ok(approx(shrinkRate(0, 0, 0.3, 20), 0.3), "empty ⇒ prior");
}

// Isotonic PAV — fixes violations, output non-decreasing
{
  const out = isotonicPav([0.6, 0.2, 0.8], [1, 1, 1]);
  ok(approx(out[0], 0.4) && approx(out[1], 0.4) && approx(out[2], 0.8), "0.6,0.2 pooled to 0.4,0.4; 0.8 kept");
  // Weighted pooling
  const w = isotonicPav([0.9, 0.1], [3, 1]);
  ok(approx(w[0], (0.9 * 3 + 0.1 * 1) / 4) && approx(w[1], w[0]), "weighted pool mean");
  // Already-monotonic input unchanged
  const same = isotonicPav([0.1, 0.4, 0.9], [1, 1, 1]);
  ok(approx(same[0], 0.1) && approx(same[1], 0.4) && approx(same[2], 0.9), "monotonic input unchanged");
  // Output always non-decreasing
  const rand = isotonicPav([0.7, 0.3, 0.5, 0.2, 0.9, 0.1], [1, 2, 1, 3, 1, 1]);
  let mono = true;
  for (let i = 1; i < rand.length; i++) if (rand[i] < rand[i - 1] - 1e-9) mono = false;
  ok(mono, "isotonic output is always non-decreasing");
}

// ECE
{
  // Perfectly calibrated: predicted == empirical in each bin ⇒ ~0
  const cal: CalObs[] = [
    { p: 0.1, y: 0 }, { p: 0.1, y: 0 }, { p: 0.1, y: 0 }, { p: 0.1, y: 0 }, { p: 0.1, y: 0 },
    { p: 0.1, y: 0 }, { p: 0.1, y: 0 }, { p: 0.1, y: 0 }, { p: 0.1, y: 0 }, { p: 0.1, y: 1 }, // 1/10 = 0.1
  ];
  ok(expectedCalibrationErrorPct(cal, 10) < 1e-6, "well-calibrated bin ⇒ ~0 ECE");
  // Overconfident: p=0.9 but half cash ⇒ ECE ~ |0.9-0.5| = 0.4 → 40pp
  const over: CalObs[] = [];
  for (let i = 0; i < 10; i++) over.push({ p: 0.9, y: i < 5 ? 1 : 0 });
  ok(approx(expectedCalibrationErrorPct(over, 10), 40, 0.5), "overconfident ⇒ ~40pp ECE");
}

console.log(`\ncalibrationMath.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
