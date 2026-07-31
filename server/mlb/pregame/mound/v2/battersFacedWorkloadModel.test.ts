// Mound V2 batters-faced workload distribution — invariants.
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

// ── battersFacedPmf is a valid probability distribution ─────────────────────
{
  const dist = computeWorkloadDistributions(baseInputs());
  ok(approx(sum(dist.battersFacedPmf), 1, 1e-6), `battersFacedPmf sums to 1 (got ${sum(dist.battersFacedPmf)})`);
  ok(dist.dataAvailable === true, "dataAvailable is true when avgInningsPerStart is real");
  ok(dist.expectedBattersFaced > 0, "expected batters faced is positive for a normal 6-inning starter");
  ok(dist.nonStrikeoutOutRate > 0 && dist.nonStrikeoutOutRate < 1, "nonStrikeoutOutRate is a valid probability");
}

// ── Missing avgInningsPerStart degrades to a neutral fallback, not a crash ──
{
  const dist = computeWorkloadDistributions(baseInputs({ avgInningsPerStart: null }));
  ok(dist.dataAvailable === false, "dataAvailable is false when avgInningsPerStart is missing");
  ok(approx(sum(dist.battersFacedPmf), 1, 1e-6), "battersFacedPmf still sums to 1 using the neutral fallback mean");
  ok(dist.expectedBattersFaced > 0, "expectedBattersFaced is still a sane positive number, not NaN or 0");
}

// ── Low expected batters faced (short-outing profile) still produces a sane distribution ──
{
  const shortOuting = computeWorkloadDistributions(baseInputs({ avgInningsPerStart: 1.5, ipVarianceLast3: 0.3 }));
  ok(shortOuting.expectedBattersFaced < 15, `a 1.5-inning-average pitcher has a low expected batters faced (got ${shortOuting.expectedBattersFaced.toFixed(2)})`);
  ok(approx(sum(shortOuting.battersFacedPmf), 1, 1e-6), "a short-outing profile's battersFacedPmf still sums to 1");
  ok(shortOuting.battersFacedPmf.every((p) => Number.isFinite(p) && p >= 0), "a short-outing profile's battersFacedPmf has no NaN/negative entries");
}

// ── Pitch-count / pull-risk adjustment: an inefficient, walk-prone pitcher projects a lower expected workload than an efficient one, all else equal ──
{
  const efficient = computeWorkloadDistributions(baseInputs({ lastStartPitchCount: 85, lastStartInningsPitched: 7, bbPer9: 2.0 }));
  const inefficient = computeWorkloadDistributions(baseInputs({ lastStartPitchCount: 110, lastStartInningsPitched: 5, bbPer9: 5.0 }));
  ok(
    inefficient.expectedBattersFaced < efficient.expectedBattersFaced,
    `a high-pitch-count, high-walk-rate profile (${inefficient.expectedBattersFaced.toFixed(2)} BF) projects fewer expected batters faced than an efficient, low-walk profile (${efficient.expectedBattersFaced.toFixed(2)} BF), holding avgInningsPerStart constant`,
  );
}

// ── A more walk-prone pitcher's non-strikeout PAs skew toward on-base, not out ──
{
  const lowWalk = computeWorkloadDistributions(baseInputs({ bbPer9: 1.5 }));
  const highWalk = computeWorkloadDistributions(baseInputs({ bbPer9: 6.0 }));
  ok(
    highWalk.nonStrikeoutOutRate < lowWalk.nonStrikeoutOutRate,
    `a high-BB/9 pitcher (${highWalk.nonStrikeoutOutRate.toFixed(3)}) has a lower non-strikeout-out rate than a low-BB/9 pitcher (${lowWalk.nonStrikeoutOutRate.toFixed(3)})`,
  );
  ok(highWalk.nonStrikeoutOutRate >= 0.45 && lowWalk.nonStrikeoutOutRate <= 0.7, "the walk-rate adjustment to non-strikeout-out rate stays within its documented bounds");
}

console.log(`\nbattersFacedWorkloadModel.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
