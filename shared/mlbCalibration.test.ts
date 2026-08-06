// MLB Stage C — calibration artifact apply invariants.
//
// Run: npx tsx shared/mlbCalibration.test.ts

import {
  applyCalibrator,
  clamp01,
  MLB_CALIBRATION_ARTIFACT_VERSION,
  type MlbCalibrationArtifact,
  type MlbCalibrationBin,
} from "./mlbCalibration";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number | null, b: number, eps = 1e-6): boolean {
  return a != null && Math.abs(a - b) < eps;
}

function artifact(bins: Array<Pick<MlbCalibrationBin, "center" | "calibratedRate">>): MlbCalibrationArtifact {
  return {
    segment: "hits",
    method: "reliability_isotonic_v1",
    bins: bins.map((b) => ({ lo: 0, hi: 1, center: b.center, count: 10, empiricalRate: b.calibratedRate, calibratedRate: b.calibratedRate })),
    fitStats: {
      sampleSize: 100, distinctSlateDates: 10, basePositiveRate: 0.5,
      rawBrier: 0.3, calibratedBrier: 0.2, rawLogLoss: 0.7, calibratedLogLoss: 0.6,
      rawEcePct: 8, calibratedEcePct: 2, inSample: true,
    },
    builtAtMs: 1,
    ledgerContractVersion: "mlb_prediction_ledger_v1",
    artifactVersion: MLB_CALIBRATION_ARTIFACT_VERSION,
  };
}

// clamp01
{
  ok(clamp01(-1) === 0 && clamp01(2) === 1 && clamp01(0.5) === 0.5 && clamp01(NaN) === 0, "clamp01 bounds + NaN");
}

// Exact centers + interpolation + flat extrapolation
{
  const a = artifact([{ center: 0.2, calibratedRate: 0.1 }, { center: 0.5, calibratedRate: 0.5 }, { center: 0.8, calibratedRate: 0.9 }]);
  ok(approx(applyCalibrator(a, 20), 10), "at center 0.2 → 10");
  ok(approx(applyCalibrator(a, 50), 50), "at center 0.5 → 50");
  ok(approx(applyCalibrator(a, 80), 90), "at center 0.8 → 90");
  ok(approx(applyCalibrator(a, 35), 30), "midway 0.2→0.5 interpolates to 30");
  ok(approx(applyCalibrator(a, 10), 10), "below first center → flat first value");
  ok(approx(applyCalibrator(a, 95), 90), "above last center → flat last value");
}

// Monotonic non-decreasing across the whole range
{
  const a = artifact([{ center: 0.2, calibratedRate: 0.1 }, { center: 0.5, calibratedRate: 0.5 }, { center: 0.8, calibratedRate: 0.9 }]);
  let prev = -1;
  let mono = true;
  for (let x = 0; x <= 100; x += 1) {
    const v = applyCalibrator(a, x)!;
    if (v < prev - 1e-9) mono = false;
    prev = v;
  }
  ok(mono, "applyCalibrator is monotonic non-decreasing in rawProbPct");
}

// Empty bins ⇒ null (no identity copy — caller keeps calibrated null)
{
  const a = artifact([]);
  ok(applyCalibrator(a, 60) === null, "no bins ⇒ null");
  ok(applyCalibrator(artifact([{ center: 0.5, calibratedRate: 0.4 }]), 90) === 40, "single bin ⇒ that value everywhere");
  ok(applyCalibrator(a, NaN) === null, "NaN input ⇒ null");
}

// Duplicate centers collapse (no divide-by-zero), keep max
{
  const a = artifact([{ center: 0.5, calibratedRate: 0.4 }, { center: 0.5, calibratedRate: 0.6 }, { center: 0.9, calibratedRate: 0.8 }]);
  const v = applyCalibrator(a, 50);
  ok(v === 60, "duplicate center collapses to max calibratedRate (0.6→60)");
}

// Output always within [0,100]
{
  const a = artifact([{ center: 0.0, calibratedRate: 0 }, { center: 1.0, calibratedRate: 1 }]);
  for (let x = -10; x <= 110; x += 7) {
    const v = applyCalibrator(a, x)!;
    if (!(v >= 0 && v <= 100)) { ok(false, `output in range for x=${x} (got ${v})`); break; }
  }
  ok(true, "output clamped within [0,100] across out-of-range inputs");
}

console.log(`\nmlbCalibration.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
