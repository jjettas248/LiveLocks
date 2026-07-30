// Mound V2 shadow — WORKER evaluation latency benchmark (Final Pre-Push
// Integrity Pass; supersedes Correction 2's framing). Measures
// evaluateMoundV2Shadow's OWN synchronous CPU cost in isolation, using a
// realistic 9-batter confirmed lineup.
//
// IMPORTANT CONTEXT CHANGE: this number is NO LONGER the cost of anything in
// buildMlbMoundRadar.ts's publication-critical path. As of this pass,
// evaluateMoundV2Shadow runs exclusively inside moundV2ShadowWorker.ts's own
// independent tick, reached only via the durable outbox
// (moundV2ShadowJobQueue.ts) — the build loop's ONLY synchronous obligation
// is one bounded INSERT (see moundV2ShadowJobQueue.integration.test.ts for
// THAT latency, and moundV2ShadowNeverWaits.test.ts for the actual
// behavioral proof that V1 publication does not wait for this cost, however
// large it becomes). This benchmark is retained as a WORKER-side regression
// guard (so a future algorithmic blow-up in moundV2Math.ts is caught here,
// where it can only ever slow down the worker's own throughput, never V1)
// and to size worker batch/interval tuning — NOT as justification for
// keeping evaluation inline (it no longer is inline).
//
// Measured result (this machine, N=500, 9-batter lineup): mean ~0.6ms,
// p95 ~0.9ms, max ~1.6ms per pitcher (unchanged in magnitude by the
// decision-policy addition — applyMoundV2DecisionPolicy is O(1) arithmetic
// per market, negligible next to the O(n^2)-or-better DP in moundV2Math.ts).
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ShadowLatency.test.ts

import { performance } from "node:perf_hooks";
import { evaluateMoundV2Shadow, MOUND_V1_MODEL_VERSION, MOUND_V2_MODEL_VERSION } from "./moundV2ShadowEvaluation";
import type { EvaluateMoundV2ShadowArgs } from "./moundV2ShadowEvaluation";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function nineBatterLineup() {
  return Array.from({ length: 9 }, (_, i) => ({
    playerId: `batter_${i}`,
    playerName: `Batter ${i}`,
    battingOrderSlot: i + 1,
    handedness: (i % 3 === 0 ? "L" : i % 3 === 1 ? "R" : "S") as "L" | "R" | "S",
    kRateVsThrowHand: 0.18 + (i % 5) * 0.02,
    kRateSamplePa: 180 + i * 10,
    bvpAtBats: i % 2 === 0 ? 6 + i : 0,
    bvpStrikeouts: i % 2 === 0 ? Math.floor(i / 3) : 0,
  }));
}

function buildArgs(i: number): EvaluateMoundV2ShadowArgs {
  return {
    snapshotId: `mound_v2:mlb-mound:2026-07-30:game_${i}:pitcher_${i}:build_bench`,
    now: new Date("2026-07-30T20:00:00.000Z"),
    frozenInputArgs: {
      gameId: `game_${i}`, gamePk: `gamePk_${i}`, pitcherId: `pitcher_${i}`, pitcherName: `Pitcher ${i}`, opponent: "OPP",
      scheduledGameTime: "2026-07-30T23:05:00.000Z", lineupStatus: "confirmed",
      battingOrder: nineBatterLineup(),
      pitcherThrows: i % 2 === 0 ? "R" : "L", kPer9: 8.5 + (i % 7) * 0.3, priorSeasonsKPer9: [8.2, 8.9],
      swStrPct: 11.5 + (i % 4), cswPct: 28 + (i % 5), missesBatsFamily: null,
      kRateVsLHB: 0.25, kRateVsRHB: 0.23, avgInningsPerStart: 5.7, ipVarianceLast3: 0.9,
      lastStartPitchCount: 92, lastStartInningsPitched: 5.6, bbPer9: 3.0,
      strikeoutsMarket: { line: 6.5, overPrice: -120, underPrice: 100, sportsbook: "draftkings", fetchedAt: "2026-07-30T19:58:00.000Z" },
      outsMarket: { line: null, overPrice: null, underPrice: null, sportsbook: null, fetchedAt: null },
      dataQuality: "complete", productionModelVersion: MOUND_V1_MODEL_VERSION, v2ModelVersion: MOUND_V2_MODEL_VERSION,
    },
    productionComponentScores: { pitcherSkillScore: 7.0, workloadScore: 6.4, opponentKProfileScore: 6.7 },
    v1Score10: 6.8, v1Tier: "strong", v1RecommendedSide: "OVER", v1QualificationStatus: "recommended",
    strikeoutsLine: 6.5, outsLine: null,
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// Generous headroom over the measured ~0.9ms p95 / ~1.6ms max on this
// machine — this is a regression guard against a future algorithmic
// blow-up (e.g. an unbounded workload state space) inside the WORKER, not a
// tight performance SLA and not a justification for staying inline (the
// worker is already fully decoupled from V1 regardless of this number).
const MATERIALITY_THRESHOLD_MS = 25;
const WARMUP = 50;
const N = 500;

for (let i = 0; i < WARMUP; i++) evaluateMoundV2Shadow(buildArgs(i));

const samples: number[] = [];
let anyFailure = false;
for (let i = 0; i < N; i++) {
  const start = performance.now();
  const result = evaluateMoundV2Shadow(buildArgs(i));
  samples.push(performance.now() - start);
  if (result.failureReason) anyFailure = true;
}

samples.sort((a, b) => a - b);
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
const p50 = percentile(samples, 50);
const p95 = percentile(samples, 95);
const p99 = percentile(samples, 99);
const max = samples[samples.length - 1];

ok(!anyFailure, "every benchmark evaluation succeeds (no failureReason) — this is measuring the happy path's real cost, not an error path's");
ok(p95 < MATERIALITY_THRESHOLD_MS, `p95 latency (${p95.toFixed(3)}ms) stays well under the materiality threshold (${MATERIALITY_THRESHOLD_MS}ms) — the worker can process a batch quickly; this is NOT why V1 doesn't wait (see moundV2ShadowNeverWaits.test.ts for that proof)`);
ok(max < MATERIALITY_THRESHOLD_MS * 2, `max latency (${max.toFixed(3)}ms) has no wild outlier tail`);

console.log(`  evaluateMoundV2Shadow (WORKER-side) latency (N=${N}, 9-batter lineup): mean=${mean.toFixed(4)}ms p50=${p50.toFixed(4)}ms p95=${p95.toFixed(4)}ms p99=${p99.toFixed(4)}ms max=${max.toFixed(4)}ms`);
console.log(`  Projected worker-side sequential CPU time per batch: ~${(mean * 15).toFixed(2)}ms (15 jobs) to ~${(mean * 30).toFixed(2)}ms (30 jobs) — entirely off V1's timeline`);

console.log(`\nmoundV2ShadowLatency.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
