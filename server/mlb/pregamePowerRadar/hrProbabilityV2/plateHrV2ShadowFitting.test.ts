// Plate HR Probability V2 — fit + walk-forward orchestrator invariants (PR 2).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2ShadowFitting.test.ts

import { fitPlateHrV2ShadowModel } from "./plateHrV2ShadowFitting";
import { PLATE_HR_V2_SHADOW_TERM_KEYS } from "./plateHrV2ShadowTrainingRow";
import type { ShadowHrTrainingRow } from "../math/fitShadowTermWeights";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// A deterministic fixture (no Math.random()) where `batterPower` is a real,
// if imperfect, predictor of `homered`, and every other term is noise
// uncorrelated with the outcome AND with batterPower. This exists to prove
// the fitting math distinguishes signal from noise — not real data, same
// posture as every other synthetic fixture in this PR given zero real
// captured data exists yet.
function plantedSignalFixture(n: number): ShadowHrTrainingRow[] {
  const rows: ShadowHrTrainingRow[] = [];
  for (let i = 0; i < n; i++) {
    const strongSignal = i % 2 === 0;
    const homered: 0 | 1 = strongSignal ? (i % 5 < 4 ? 1 : 0) : (i % 5 < 1 ? 1 : 0); // 80% vs 20% homer rate
    const terms: Record<string, number> = { batterPower: strongSignal ? 0.8 : -0.8 };
    for (const key of PLATE_HR_V2_SHADOW_TERM_KEYS) {
      if (key === "batterPower") continue;
      // Small, deterministic, outcome-uncorrelated noise per key (different
      // modulus per key so terms aren't collinear with each other either).
      const seed = (i * (1 + key.length) + key.charCodeAt(0)) % 7;
      terms[key] = seed < 3 ? 0.1 : -0.1;
    }
    rows.push({
      frozenAt: new Date(2026, 0, 1 + i).toISOString(),
      homered,
      terms,
    });
  }
  return rows;
}

// ── 1. Planted signal: batterPower's coefficient dominates the noise terms ──
{
  const rows = plantedSignalFixture(400); // clears 250(minTrainRows) + 100(calibrationRows) + 50(testRows)
  const result = fitPlateHrV2ShadowModel(rows, { minTrainRows: 250, testRows: 50, calibrationRows: 100 });

  ok(result.totalRows === 400, "totalRows reflects the full input");
  ok(result.holdoutMetrics !== null, "400 rows clears the 3-way split threshold (250+100+50=400)");

  const batterPowerCoef = Math.abs(result.finalTermModel.coefficients.batterPower);
  const noiseCoefs = PLATE_HR_V2_SHADOW_TERM_KEYS.filter((k) => k !== "batterPower").map((k) => Math.abs(result.finalTermModel.coefficients[k]));
  const maxNoiseCoef = Math.max(...noiseCoefs);
  ok(batterPowerCoef > maxNoiseCoef, `planted signal's |coefficient| (${batterPowerCoef.toFixed(3)}) exceeds every noise term's (max ${maxNoiseCoef.toFixed(3)})`);
  ok(result.finalTermModel.coefficients.batterPower > 0, "batterPower's coefficient is positive, matching the planted positive relationship");
}

// ── 2. Calibrated holdout Brier does not make a well-specified model worse ──
{
  const rows = plantedSignalFixture(400);
  const result = fitPlateHrV2ShadowModel(rows, { minTrainRows: 250, testRows: 50, calibrationRows: 100 });
  ok(result.holdoutMetrics !== null, "holdout metrics present");
  // Calibration on an already well-specified planted-signal model should not
  // meaningfully hurt it — allow a small tolerance for calibration noise on
  // a modest sample rather than requiring strict improvement.
  ok(
    result.holdoutMetrics!.calibrated.brier <= result.holdoutMetrics!.raw.brier + 0.02,
    `calibrated holdout Brier (${result.holdoutMetrics!.calibrated.brier.toFixed(4)}) doesn't meaningfully worsen raw Brier (${result.holdoutMetrics!.raw.brier.toFixed(4)})`,
  );
}

// ── 3. Too little data -> graceful holdoutMetrics:null, still returns a fit ──
{
  const rows = plantedSignalFixture(30);
  const result = fitPlateHrV2ShadowModel(rows, { minTrainRows: 250, testRows: 50, calibrationRows: 100 });
  ok(result.holdoutMetrics === null, "30 rows can't clear a 400-row 3-way split threshold -> holdoutMetrics:null");
  ok(result.finalTermModel.trainedRows === 30, "still returns a full-sample fit on everything available");
  ok(result.calibrator !== undefined, "still returns a calibrator (in-sample best-effort)");
  ok(result.walkForwardFolds.length === 0, "30 rows can't clear the walk-forward minTrainRows either -> zero folds, not a throw");
}

// ── 4. Never throws on empty input ──────────────────────────────────────────
{
  let threw = false;
  let result: ReturnType<typeof fitPlateHrV2ShadowModel> | null = null;
  try {
    result = fitPlateHrV2ShadowModel([]);
  } catch {
    threw = true;
  }
  ok(!threw, "empty input never throws");
  ok(result?.totalRows === 0 && result?.holdoutMetrics === null, "empty input returns a zeroed, well-formed result");
}

// ── 5. Determinism: identical input fits to byte-identical results ─────────
{
  const rows = plantedSignalFixture(400);
  const r1 = fitPlateHrV2ShadowModel(rows, { minTrainRows: 250, testRows: 50, calibrationRows: 100 });
  const r2 = fitPlateHrV2ShadowModel(rows, { minTrainRows: 250, testRows: 50, calibrationRows: 100 });
  ok(
    JSON.stringify(r1.finalTermModel) === JSON.stringify(r2.finalTermModel),
    "fitting twice on identical input produces a byte-identical finalTermModel (no randomness anywhere in the chain)",
  );
  ok(JSON.stringify(r1.calibrator) === JSON.stringify(r2.calibrator), "calibrator is likewise byte-identical across repeated fits");
}

console.log(`\nplateHrV2ShadowFitting.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
