/**
 * HR Radar empirical calibration (Lane 2) — audit/harden invariants.
 *
 * Covers:
 *   - bin-edge alignment: analytics buckets are drawn from CALIBRATION_BIN_EDGES
 *     (single source of truth shared with the engine's static table).
 *   - outcome-status correctness: tiered called_hit_build/called_hit_watch ARE
 *     counted as cashed; called_miss IS the non-HR denominator; the dead
 *     "missed"/"expired" strings are ignored.
 *   - Laplace smoothing: an all-miss bin calibrates to (0+1)/(n+2), never 0.
 *
 * Run: npx tsx server/mlb/hrCalibration.test.ts
 */

import { CALIBRATION_BIN_EDGES } from "./hrConversionModel";
import { stampHrRadarOutcome, _resetHrRadarOutcomeStampsForTests } from "./hrRadarOutcomeStamp";
import { computeCalibrationBuckets } from "../analytics/hrRadarIntelligence";
import type { HrRadarOutcomeStatus } from "./hrRadarSection";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function seed(n: number, status: HrRadarOutcomeStatus, rawProb: number, tag: string): void {
  for (let i = 0; i < n; i++) {
    stampHrRadarOutcome(`cal_${tag}`, `${tag}_${i}`, status, { rawConversionProbability: rawProb });
  }
}

console.log("\n=== HR Radar Calibration — Audit/Harden Suite ===\n");

// ── Bin-edge sanity ────────────────────────────────────────────────────────
assert("edges start at 0", CALIBRATION_BIN_EDGES[0] === 0);
assert("edges end at 1", CALIBRATION_BIN_EDGES[CALIBRATION_BIN_EDGES.length - 1] === 1);
assert("edges strictly increasing", CALIBRATION_BIN_EDGES.every((e, i) => i === 0 || e > CALIBRATION_BIN_EDGES[i - 1]));
assert("edges contain the engine table boundary 0.10", CALIBRATION_BIN_EDGES.includes(0.10));
assert("edges contain the engine table boundary 0.13", CALIBRATION_BIN_EDGES.includes(0.13));

// ── Mixed bin: build-tier cashed + called_miss, Laplace = 21/42 = 0.5 ───────
_resetHrRadarOutcomeStampsForTests();
seed(20, "called_hit_build", 0.11, "mix_hit");   // cashed (was DROPPED by old filter)
seed(20, "called_miss", 0.115, "mix_miss");      // non-HR (old filter used dead "missed")
{
  const buckets = computeCalibrationBuckets();
  const b = buckets.find(x => x.min === 0.10 && x.max === 0.13);
  assert("mixed 0.10–0.13 bucket exists (≥30 samples)", !!b, `buckets=${JSON.stringify(buckets.map(x => [x.min, x.samples]))}`);
  if (b) {
    assert("mixed bucket samples=40", b.samples === 40, `samples=${b.samples}`);
    assert("Laplace calibrated = (20+1)/(40+2) = 0.5", Math.abs(b.calibrated - 0.5) < 1e-9, `calibrated=${b.calibrated}`);
  }
}

// ── All-miss bin: Laplace keeps it off zero ────────────────────────────────
_resetHrRadarOutcomeStampsForTests();
seed(40, "called_miss", 0.06, "allmiss");
{
  const buckets = computeCalibrationBuckets();
  const b = buckets.find(x => x.min === 0.05 && x.max === 0.08);
  assert("all-miss 0.05–0.08 bucket exists", !!b);
  if (b) {
    assert("Laplace prevents hard-zero calibrated", b.calibrated > 0, `calibrated=${b.calibrated}`);
    assert("all-miss calibrated = 1/42 ≈ 0.0238", Math.abs(b.calibrated - 1 / 42) < 1e-9, `calibrated=${b.calibrated}`);
  }
}

// ── Dead status strings are ignored (no poisoned denominator) ──────────────
_resetHrRadarOutcomeStampsForTests();
seed(40, "missed" as HrRadarOutcomeStatus, 0.11, "dead_missed");
seed(40, "expired" as HrRadarOutcomeStatus, 0.115, "dead_expired");
{
  const buckets = computeCalibrationBuckets();
  assert("legacy 'missed'/'expired' strings form NO bucket", buckets.length === 0, `buckets=${buckets.length}`);
}

// ── Sub-threshold sample produces no bucket (C4: floor lowered to 15) ───────
_resetHrRadarOutcomeStampsForTests();
seed(6, "called_hit", 0.11, "thin_hit");
seed(6, "called_miss", 0.115, "thin_miss");
{
  const buckets = computeCalibrationBuckets();
  assert("12 samples in a min<0.20 bin → below n≥15 floor → no bucket", buckets.length === 0, `buckets=${buckets.length}`);
}

// ── At-floor sample DOES form a bucket (C4: n≥15 now qualifies) ─────────────
_resetHrRadarOutcomeStampsForTests();
seed(8, "called_hit", 0.11, "floor_hit");
seed(8, "called_miss", 0.115, "floor_miss");
{
  const buckets = computeCalibrationBuckets();
  const b = buckets.find(x => x.min === 0.10 && x.max === 0.13);
  assert("16 samples (≥15 floor) → 0.10–0.13 bucket exists", !!b, `buckets=${buckets.length}`);
  if (b) assert("at-floor bucket samples=16", b.samples === 16, `samples=${b.samples}`);
}

// ── uncalled_hr counts as a cashed positive (C4) ───────────────────────────
_resetHrRadarOutcomeStampsForTests();
seed(15, "uncalled_hr" as HrRadarOutcomeStatus, 0.04, "uncalled");
{
  const buckets = computeCalibrationBuckets();
  const b = buckets.find(x => x.min === 0.03 && x.max === 0.05);
  assert("uncalled_hr forms a 0.03–0.05 bucket (≥15)", !!b, `buckets=${JSON.stringify(buckets.map(x => [x.min, x.samples]))}`);
  // All 15 are HR positives → Laplace (15+1)/(15+2) = 16/17.
  if (b) assert("uncalled_hr counted as cashed → calibrated = 16/17", Math.abs(b.calibrated - 16 / 17) < 1e-9, `calibrated=${b.calibrated}`);
}

_resetHrRadarOutcomeStampsForTests();
console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) { for (const f of failures) console.log(` - ${f}`); process.exit(1); }
process.exit(0);
