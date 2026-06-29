// Pre-Game Power Radar — v2 SHADOW shrinkage + normalization invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/math/shrinkAndNormalize.test.ts

import { shrinkRate, shrinkWeight, STABILIZATION_K } from "./shrinkRates";
import { norm01, signed, clamp01, sigmoid, logit, weightedMean } from "./normalizeStats";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// ── Shrinkage pulls small samples toward the prior ────────────────────────────
const prior = 0.033;
const observed = 0.10;
const small = shrinkRate(observed, 10, prior, STABILIZATION_K.hrPerPa); // n=10, k=170
const large = shrinkRate(observed, 2000, prior, STABILIZATION_K.hrPerPa); // n=2000
ok(Math.abs(small.value - prior) < Math.abs(small.value - observed), "small sample closer to prior");
ok(Math.abs(large.value - observed) < Math.abs(large.value - prior), "large sample closer to observed");
ok(small.value > prior && small.value < observed, "shrunk value between prior and observed");
ok(large.weight > small.weight, "larger sample → higher trust weight");

// ── Missing / zero sample → prior with weight 0 ───────────────────────────────
const none = shrinkRate(null, 100, prior, 50);
ok(none.value === prior && none.weight === 0, "missing observed → prior, weight 0");
const zero = shrinkRate(0.1, 0, prior, 50);
ok(zero.value === prior && zero.weight === 0, "zero sample → prior, weight 0");

// ── shrinkWeight monotonic in n, bounded [0,1) ────────────────────────────────
ok(shrinkWeight(0, 50) === 0, "n=0 → weight 0");
ok(shrinkWeight(50, 50) === 0.5, "n=k → weight 0.5");
ok(shrinkWeight(10, 50) < shrinkWeight(100, 50), "weight increases with n");
ok(shrinkWeight(1e9, 50) < 1, "weight strictly < 1");

// ── norm01 / signed / clamp ───────────────────────────────────────────────────
ok(norm01(5, 0, 10) === 0.5, "norm01 midpoint");
ok(norm01(-5, 0, 10) === 0, "norm01 clamps low");
ok(norm01(15, 0, 10) === 1, "norm01 clamps high");
ok(norm01(5, 5, 5) === 0.5, "norm01 degenerate range → 0.5");
ok(signed(0.40, 0.30, 0.40, 0.58) === 0, "signed at midpoint → 0");
ok(approx(signed(0.58, 0.30, 0.40, 0.58), 1), "signed at high → 1");
ok(approx(signed(0.30, 0.30, 0.40, 0.58), -1), "signed at low → -1");
ok(signed(NaN, 0, 1, 2) === 0, "signed NaN → 0");
ok(clamp01(2) === 1 && clamp01(-1) === 0, "clamp01 bounds");

// ── sigmoid/logit round-trip ──────────────────────────────────────────────────
ok(approx(sigmoid(logit(0.0335)), 0.0335, 1e-9), "sigmoid∘logit identity");
ok(sigmoid(0) === 0.5, "sigmoid(0)=0.5");

// ── weightedMean ignores nulls; reports coverage ──────────────────────────────
const wm = weightedMean([{ value: 1, weight: 2 }, { value: null, weight: 2 }, { value: 3, weight: 0 }]);
ok(approx(wm.value ?? 0, 1), "weightedMean ignores nulls (only present value)");
ok(approx(wm.coverage, 0.5), "weightedMean coverage = present/total weight");
const wmEmpty = weightedMean([{ value: null, weight: 1 }]);
ok(wmEmpty.value === null && wmEmpty.coverage === 0, "weightedMean all-null → null,0");

console.log(`\nshrinkAndNormalize.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
