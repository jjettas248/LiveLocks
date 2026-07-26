// Plate HR Probability V2 — Platt-scaling calibrator invariants (PR 2).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2Calibrator.test.ts

import { fitPlateHrV2Calibrator, applyPlateHrV2Calibrator, type PlateHrV2CalibratorModel } from "./plateHrV2Calibrator";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function brier(rows: Array<{ p: number; y: 0 | 1 }>): number {
  return rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length;
}

// A systematically overconfident source: "high" raw scores (0.85) actually
// homer only 55% of the time; "low" raw scores (0.15) actually homer 25% of
// the time. Direction is informative, magnitude is too extreme — exactly
// what Platt scaling should fix. Deterministic (no Math.random()), not real
// data — this fixture exists to prove the calibration MATH works, same
// posture as every other synthetic-fixture test in this PR given zero real
// captured data exists yet.
function overconfidentFixture(): Array<{ rawProbability: number; homered: 0 | 1; frozenAt: string }> {
  const rows: Array<{ rawProbability: number; homered: 0 | 1; frozenAt: string }> = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ rawProbability: 0.85, homered: i % 20 < 11 ? 1 : 0, frozenAt: new Date(2026, 0, 1 + i).toISOString() }); // 11/20 = 55%
  }
  for (let i = 0; i < 60; i++) {
    rows.push({ rawProbability: 0.15, homered: i % 20 < 5 ? 1 : 0, frozenAt: new Date(2026, 1, 1 + i).toISOString() }); // 5/20 = 25%
  }
  return rows;
}

// ── 1. Fitting improves calibration on a systematically overconfident source ──
{
  const rows = overconfidentFixture();
  const model = fitPlateHrV2Calibrator(rows);
  ok(model.sufficientData === true, "120 rows clears the default minRows=50 threshold");

  const rawBrier = brier(rows.map((r) => ({ p: r.rawProbability, y: r.homered })));
  const calibratedBrier = brier(
    rows.map((r) => ({ p: applyPlateHrV2Calibrator(model, r.rawProbability).calibrated!, y: r.homered })),
  );
  ok(calibratedBrier < rawBrier, `calibrated Brier (${calibratedBrier.toFixed(4)}) improves on raw Brier (${rawBrier.toFixed(4)})`);

  // The fitted slope `a` should be well below 1 — the raw scores are too
  // extreme, so Platt scaling should compress them toward the true rates.
  ok(model.a > 0 && model.a < 1, `fitted slope a=${model.a.toFixed(3)} compresses overconfident raw scores (0 < a < 1)`);
}

// ── 2. Below minRows returns the explicit identity model ────────────────────
{
  const tinyRows = overconfidentFixture().slice(0, 10);
  const model = fitPlateHrV2Calibrator(tinyRows);
  ok(model.sufficientData === false, "10 rows (< default minRows=50) is flagged insufficient");
  ok(model.a === 1 && model.b === 0, "identity model: a=1, b=0");

  const applied = applyPlateHrV2Calibrator(model, 0.42);
  ok(Math.abs(applied.calibrated! - 0.42) < 1e-9, "identity model passes the raw probability through unchanged (within float precision)");
  ok(applied.diagnostics.method === "insufficient_data_uncalibrated", "diagnostics honestly report insufficient_data_uncalibrated, never claiming platt_scaled");
}

// ── 3. applyPlateHrV2Calibrator never throws on null/NaN/out-of-range input ─
{
  const model: PlateHrV2CalibratorModel = fitPlateHrV2Calibrator(overconfidentFixture());
  let threw = false;
  try {
    ok(applyPlateHrV2Calibrator(model, null).calibrated === null, "null input -> calibrated:null");
    ok(applyPlateHrV2Calibrator(model, undefined).calibrated === null, "undefined input -> calibrated:null");
    ok(applyPlateHrV2Calibrator(model, NaN).calibrated === null, "NaN input -> calibrated:null");
    const belowRange = applyPlateHrV2Calibrator(model, -5).calibrated!;
    ok(belowRange >= 0 && belowRange <= 1, "out-of-range negative input still produces a bounded [0,1] output");
    const aboveRange = applyPlateHrV2Calibrator(model, 10).calibrated!;
    ok(aboveRange >= 0 && aboveRange <= 1, "out-of-range >1 input still produces a bounded [0,1] output");
  } catch {
    threw = true;
  }
  ok(!threw, "applyPlateHrV2Calibrator never throws");
}

// ── 4. Determinism: identical input fits to byte-identical a/b ─────────────
{
  const rows = overconfidentFixture();
  const m1 = fitPlateHrV2Calibrator(rows);
  const m2 = fitPlateHrV2Calibrator(rows);
  ok(m1.a === m2.a && m1.b === m2.b, "fitting twice on identical input produces byte-identical a/b (no randomness anywhere in the chain)");
}

console.log(`\nplateHrV2Calibrator.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
