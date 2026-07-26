// Plate HR Probability V2 — fit + walk-forward orchestrator invariants (PR 2).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2ShadowFitting.test.ts

import { fitPlateHrV2ShadowModel, groupByFrozenAt, takeWholeBucketsFromEnd } from "./plateHrV2ShadowFitting";
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

// A fixture where forward capture's real behavior is modeled explicitly:
// every row within a "build" shares the exact same frozenAt (mirroring
// PregameRadar stamping every candidate in one build cycle with that
// build's own generatedAt), and builds are chronologically ordered.
function sameTimestampBuildsFixture(buildSizes: number[]): ShadowHrTrainingRow[] {
  const rows: ShadowHrTrainingRow[] = [];
  buildSizes.forEach((size, buildIndex) => {
    const frozenAt = new Date(2026, 0, 1 + buildIndex).toISOString();
    for (let i = 0; i < size; i++) {
      rows.push({ frozenAt, homered: i % 4 === 0 ? 1 : 0, terms: { batterPower: i % 2 === 0 ? 0.3 : -0.3 } });
    }
  });
  return rows;
}

// ── 6. groupByFrozenAt: correctly buckets tie-blocks ────────────────────────
{
  const rows = sameTimestampBuildsFixture([3, 1, 5]);
  const buckets = groupByFrozenAt(rows);
  ok(buckets.length === 3, "3 distinct frozenAt values produce 3 buckets");
  ok(buckets[0].length === 3 && buckets[1].length === 1 && buckets[2].length === 5, "each bucket holds exactly the rows sharing its build's timestamp");
  ok(buckets.every((b) => b.every((r) => r.frozenAt === b[0].frozenAt)), "every row in a bucket shares the same frozenAt as the bucket's first row");
}

// ── 7. takeWholeBucketsFromEnd: never splits a bucket ───────────────────────
{
  const buckets = groupByFrozenAt(sameTimestampBuildsFixture([50, 50, 50, 50, 50, 50, 50, 50, 50, 50])); // 10 builds x 50 rows
  const { taken, remainingBuckets } = takeWholeBucketsFromEnd(buckets, 60);
  ok(taken.length === 100, "a 60-row target that doesn't align with a single 50-row bucket takes 2 whole buckets (100 rows), never a partial one");
  ok(remainingBuckets.length === 8, "the other 8 buckets remain untouched");
  ok(
    new Set(taken.map((r) => r.frozenAt)).size === 2,
    "the taken rows span exactly 2 distinct frozenAt values, each fully included — no bucket is split across taken/remaining",
  );

  const { taken: exact } = takeWholeBucketsFromEnd(groupByFrozenAt(sameTimestampBuildsFixture([50, 50])), 50);
  ok(exact.length === 50, "a target that exactly matches one bucket's size takes exactly that one bucket");

  const { taken: overshoot, remainingBuckets: none } = takeWholeBucketsFromEnd(groupByFrozenAt(sameTimestampBuildsFixture([500])), 60);
  ok(overshoot.length === 500 && none.length === 0, "a single bucket larger than the whole remaining budget is still taken whole, even though it overshoots the target");
}

// ── 8. fitPlateHrV2ShadowModel end-to-end: same-frozenAt tie-blocks never
// straddle train/calibration/holdout (the actual Codex-reported regression) ──
{
  // 10 builds of 50 rows each = 500 rows, matching a slate-sized build cycle.
  const buildSizes = Array.from({ length: 10 }, () => 50);
  const rows = sameTimestampBuildsFixture(buildSizes);

  const result = fitPlateHrV2ShadowModel(rows, { minTrainRows: 250, testRows: 60, calibrationRows: 60 });
  ok(result.holdoutMetrics !== null, "500 rows across 10 builds clears the 3-way split threshold");

  // Independently recompute what the bucket-respecting split SHOULD produce
  // for this exact fixture + these exact options, and cross-check the
  // model's actual reported holdout size against it — proving the function
  // is really using bucket-respecting extraction, not silently reverting to
  // a row-count cut that happens to look similar.
  const buckets = groupByFrozenAt(rows);
  const { taken: expectedHoldout, remainingBuckets: afterHoldout } = takeWholeBucketsFromEnd(buckets, 60);
  const { taken: expectedCalibration } = takeWholeBucketsFromEnd(afterHoldout, 60);
  ok(result.holdoutMetrics!.rows === expectedHoldout.length, `holdout size (${result.holdoutMetrics!.rows}) matches the bucket-respecting expectation (${expectedHoldout.length}), not a naive 60-row cut`);

  // Structural proof: every distinct frozenAt value used for the holdout
  // window is entirely disjoint from the calibration window — a naive
  // row-count cut on this exact fixture (60 of 500) would have split
  // build #9 (the last 50-row build) across calibration and holdout.
  const holdoutFrozenAtSet = new Set(expectedHoldout.map((r) => r.frozenAt));
  const calibrationFrozenAtSet = new Set(expectedCalibration.map((r) => r.frozenAt));
  const overlap = [...holdoutFrozenAtSet].filter((t) => calibrationFrozenAtSet.has(t));
  ok(overlap.length === 0, "zero frozenAt values appear in both the holdout and calibration splits");
  ok(holdoutFrozenAtSet.size === 2, "holdout spans exactly 2 whole builds (100 rows for a 60-row target with 50-row builds), never a partial one");
  ok(
    result.holdoutMetrics!.window.start === buildSizes.map((_, i) => new Date(2026, 0, 1 + i).toISOString())[8] &&
      result.holdoutMetrics!.window.end === buildSizes.map((_, i) => new Date(2026, 0, 1 + i).toISOString())[9],
    "holdout window start/end land exactly on the 2 included builds' own timestamps, not a timestamp from build #7 (which a naive 60-row row-count cut would have partially pulled in)",
  );
}

console.log(`\nplateHrV2ShadowFitting.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
