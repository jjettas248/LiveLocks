// Mound V2 workload distributions (batters faced + outs) — invariants.
//
// Run: npx tsx server/mlb/pregame/mound/v2/battersFacedWorkloadModel.test.ts

import { computeWorkloadDistributions } from "./battersFacedWorkloadModel";
import type { MoundV2WorkloadInputs } from "./moundV2Types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function baseInputs(overrides: Partial<MoundV2WorkloadInputs> = {}): MoundV2WorkloadInputs {
  return {
    avgInningsPerStart: 6.0,
    ipVarianceLast3: 1.0,
    lastStartPitchCount: 95,
    lastStartInningsPitched: 6,
    bbPer9: 3.0,
    ...overrides,
  };
}

// ── Both PMFs are valid probability distributions ───────────────────────────
{
  const dist = computeWorkloadDistributions(baseInputs());
  ok(approx(sum(dist.battersFacedPmf), 1, 1e-6), `battersFacedPmf sums to 1 (got ${sum(dist.battersFacedPmf)})`);
  ok(approx(sum(dist.outsPmf), 1, 1e-6), `outsPmf sums to 1 (got ${sum(dist.outsPmf)})`);
  ok(dist.dataAvailable === true, "dataAvailable is true when avgInningsPerStart is real");
  ok(dist.expectedOuts > 0 && dist.expectedBattersFaced > 0, "expected values are positive for a normal 6-inning starter");
}

// ── Missing avgInningsPerStart degrades to a neutral fallback, not a crash ──
{
  const dist = computeWorkloadDistributions(baseInputs({ avgInningsPerStart: null }));
  ok(dist.dataAvailable === false, "dataAvailable is false when avgInningsPerStart is missing");
  ok(approx(sum(dist.battersFacedPmf), 1, 1e-6), "battersFacedPmf still sums to 1 using the neutral fallback mean");
  ok(dist.expectedOuts > 0, "expectedOuts is still a sane positive number, not NaN or 0");
}

// ── Low expected batters faced (short-outing profile) still produces a sane distribution ──
{
  const shortOuting = computeWorkloadDistributions(baseInputs({ avgInningsPerStart: 1.5, ipVarianceLast3: 0.3 }));
  ok(shortOuting.expectedOuts < 6, `a 1.5-inning-average pitcher has expectedOuts well under a full start (got ${shortOuting.expectedOuts})`);
  ok(approx(sum(shortOuting.outsPmf), 1, 1e-6), "a short-outing profile's outsPmf still sums to 1");
  ok(shortOuting.outsPmf.every((p) => Number.isFinite(p) && p >= 0), "a short-outing profile's outsPmf has no NaN/negative entries");
}

// ── Pitch-count / pull-risk adjustment: an inefficient, walk-prone pitcher projects fewer expected outs than an efficient one, all else equal ──
{
  const efficient = computeWorkloadDistributions(baseInputs({ lastStartPitchCount: 85, lastStartInningsPitched: 7, bbPer9: 2.0 }));
  const inefficient = computeWorkloadDistributions(baseInputs({ lastStartPitchCount: 110, lastStartInningsPitched: 5, bbPer9: 5.0 }));
  ok(
    inefficient.expectedOuts < efficient.expectedOuts,
    `a high-pitch-count, high-walk-rate profile (${inefficient.expectedOuts.toFixed(2)} outs) projects fewer expected outs than an efficient, low-walk profile (${efficient.expectedOuts.toFixed(2)} outs), holding avgInningsPerStart constant`,
  );
  ok(
    inefficient.expectedBattersFaced < efficient.expectedBattersFaced,
    "the same pull-risk adjustment carries through to expected batters faced",
  );
}

console.log(`\nbattersFacedWorkloadModel.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
