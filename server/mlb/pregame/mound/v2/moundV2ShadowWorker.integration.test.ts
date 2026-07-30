// Mound V2 shadow worker — BEHAVIORAL invariants (Final Pre-Push Integrity
// Pass). Requires DATABASE_URL only because storage.ts's db.ts throws at
// import time without one — every dependency below is injected, so no real
// database connection or query is ever made by these specific tests (the
// real-DB proof lives in moundV2ShadowJobQueue.integration.test.ts).
//
// Run: DATABASE_URL=postgres://... npx tsx server/mlb/pregame/mound/v2/moundV2ShadowWorker.integration.test.ts

import { runMoundV2ShadowWorkerTick, MOUND_V2_SHADOW_JOB_MAX_ATTEMPTS } from "./moundV2ShadowWorker";
import { MOUND_V1_MODEL_VERSION, MOUND_V2_MODEL_VERSION, type EvaluateMoundV2ShadowArgs, type MoundV2ShadowEvaluationResult } from "./moundV2ShadowEvaluation";
import type { MoundV2ShadowJobRow } from "@shared/schema";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseEvaluateArgs(): EvaluateMoundV2ShadowArgs {
  return {
    snapshotId: "mound_v2:test:worker:1",
    now: new Date("2026-07-30T20:00:00.000Z"),
    frozenInputArgs: {
      gameId: "game_1", gamePk: "gamePk_1", pitcherId: "pitcher_1", pitcherName: "Test Pitcher", opponent: "OPP",
      scheduledGameTime: "2026-07-30T23:05:00.000Z", lineupStatus: "confirmed",
      battingOrder: [{ playerId: "b1", playerName: "Batter One", battingOrderSlot: 1, handedness: "L", kRateVsThrowHand: 0.27, kRateSamplePa: 200, bvpAtBats: 8, bvpStrikeouts: 2 }],
      pitcherThrows: "R", kPer9: 9.8, priorSeasonsKPer9: [9.2, 8.9], swStrPct: 13.0, cswPct: 29.5, missesBatsFamily: null,
      kRateVsLHB: 0.28, kRateVsRHB: 0.24, avgInningsPerStart: 5.9, ipVarianceLast3: 0.8, lastStartPitchCount: 93, lastStartInningsPitched: 5.7, bbPer9: 2.8,
      strikeoutsMarket: { line: 6.5, overPrice: -120, underPrice: 100, sportsbook: "draftkings", fetchedAt: "2026-07-30T19:58:00.000Z" },
      outsMarket: { line: null, overPrice: null, underPrice: null, sportsbook: null, fetchedAt: null },
      dataQuality: "complete", productionModelVersion: MOUND_V1_MODEL_VERSION, v2ModelVersion: MOUND_V2_MODEL_VERSION,
    },
    productionComponentScores: { pitcherSkillScore: 7.2, workloadScore: 6.5, opponentKProfileScore: 6.8 },
    v1Score10: 6.9, v1Tier: "strong", v1RecommendedSide: "OVER", v1QualificationStatus: "recommended",
    strikeoutsLine: 6.5, outsLine: null,
  };
}

function fakeJobRow(over: Partial<MoundV2ShadowJobRow> = {}): MoundV2ShadowJobRow {
  const args = baseEvaluateArgs();
  return {
    jobId: "job_1", snapshotId: "snap_1", gameId: "g1", pitcherId: "p1", signalId: "sig1",
    payload: { signalId: "sig1", evaluateArgs: { ...args, now: args.now.toISOString() } } as any,
    status: "in_progress", enqueuedAt: new Date(), attemptCount: 0, lastAttemptedAt: null, lastFailureReason: null,
    claimedAt: new Date(), claimedBy: "test", completedAt: null, createdAt: new Date(),
    ...over,
  } as MoundV2ShadowJobRow;
}

function fakeEvalResult(over: Partial<MoundV2ShadowEvaluationResult> = {}): MoundV2ShadowEvaluationResult {
  return {
    snapshotId: "snap_1", gameId: "g1", pitcherId: "p1", evaluatedAt: "2026-07-30T20:00:00.000Z",
    frozen: {} as any, distribution: {} as any, parity: { matches: true, mismatches: [] } as any,
    v1Score10: 6.9, v1Tier: "strong", v1RecommendedSide: "OVER", v1QualificationStatus: "recommended",
    strikeoutsModelDecision: { policyVersion: "mound_v2_model_policy_v1", market: "pitcher_strikeouts", side: "OVER", modelQualified: true, qualificationReason: "qualified", qualifyingProbability: 0.6 },
    outsModelDecision: { policyVersion: "mound_v2_model_policy_v1", market: "pitcher_outs", side: null, modelQualified: false, qualificationReason: "below_minimum_probability", qualifyingProbability: null },
    strikeoutsExecutability: { policyVersion: "mound_v2_executability_policy_v1", executable: true, sportsbook: "draftkings", price: -120, fetchedAt: "2026-07-30T19:58:00.000Z", failureReason: null },
    outsExecutability: { policyVersion: "mound_v2_executability_policy_v1", executable: false, sportsbook: null, price: null, fetchedAt: null, failureReason: "not_applicable" },
    latencyMs: 0.5, failureReason: null,
    ...over,
  };
}

async function testNoJobsClaimedIsANoOp() {
  const summary = await runMoundV2ShadowWorkerTick({ claim: async () => [] });
  ok(summary.claimed === 0 && summary.completed === 0 && summary.failed === 0 && summary.deadLettered === 0, "an empty claim produces an honest all-zero summary");
}

async function testHappyPathClaimEvaluatePersistComplete() {
  let evaluateCalledWith: any = null;
  let recordMetricsCalledWith: any = null;
  let buildRowsCalledWith: any = null;
  const createdRows: any[] = [];
  let completedJobId: string | null = null;

  const fakeResult = fakeEvalResult();
  const summary = await runMoundV2ShadowWorkerTick({
    claim: async () => [fakeJobRow({ jobId: "job_happy" })],
    evaluate: async (args) => { evaluateCalledWith = args; return fakeResult; },
    recordMetrics: (result) => { recordMetricsCalledWith = result; },
    buildRows: (result) => { buildRowsCalledWith = result; return [{ predictionId: "p1" } as any, { predictionId: "p2" } as any]; },
    createPrediction: async (row) => { createdRows.push(row); },
    completeJob: async (jobId) => { completedJobId = jobId; },
  });

  ok(summary.claimed === 1 && summary.completed === 1 && summary.failed === 0, `the happy path claims 1, completes 1, fails 0 (got ${JSON.stringify(summary)})`);
  ok(evaluateCalledWith?.snapshotId === "mound_v2:test:worker:1", "evaluate() is called with the deserialized args from the job's own payload");
  ok(evaluateCalledWith?.now instanceof Date, "the deserialized `now` is a real Date object, not a leftover ISO string — evaluateMoundV2Shadow requires a Date");
  ok(recordMetricsCalledWith === fakeResult, "recordMetrics() receives the exact result evaluate() returned");
  ok(buildRowsCalledWith === fakeResult, "buildRows() receives the exact result evaluate() returned");
  ok(createdRows.length === 2 && createdRows[0].predictionId === "p1" && createdRows[1].predictionId === "p2", "every row buildRows() returns is persisted via createPrediction");
  ok(completedJobId === "job_happy", "completeJob is called with the real jobId");
}

async function testEvaluateFailureReasonRecordsFailureNeverCompletes() {
  let failJobArgs: any = null;
  let completeCalled = false;
  const summary = await runMoundV2ShadowWorkerTick({
    claim: async () => [fakeJobRow({ jobId: "job_eval_fail" })],
    evaluate: async () => fakeEvalResult({ failureReason: "engine blew up", frozen: null, distribution: null }),
    failJob: async (args) => { failJobArgs = args; return { ...fakeJobRow(), status: "pending", attemptCount: 1 } as MoundV2ShadowJobRow; },
    completeJob: async () => { completeCalled = true; },
  });
  ok(summary.claimed === 1 && summary.failed === 1 && summary.completed === 0, `an evaluate() failureReason records a failure, never a completion (got ${JSON.stringify(summary)})`);
  ok(!completeCalled, "completeJob is never called when evaluate reports a failureReason");
  ok(failJobArgs?.jobId === "job_eval_fail" && failJobArgs?.failureReason === "engine blew up", "failJob receives the real jobId and the real failure reason from evaluate's own result");
  ok(failJobArgs?.maxAttempts === MOUND_V2_SHADOW_JOB_MAX_ATTEMPTS, "failJob is called with the worker's own declared max-attempts constant");
}

async function testUnexpectedExceptionAnywhereIsCaughtAndRecorded() {
  let failJobArgs: any = null;
  let threw = false;
  let summary: any = null;
  try {
    summary = await runMoundV2ShadowWorkerTick({
      claim: async () => [fakeJobRow({ jobId: "job_throws" })],
      evaluate: async () => { throw new Error("unexpected synchronous throw inside evaluate"); },
      failJob: async (args) => { failJobArgs = args; return null; },
    });
  } catch {
    threw = true;
  }
  ok(!threw, "the worker tick never throws even when evaluate() itself throws unexpectedly (not just returns a failureReason)");
  ok(summary?.failed === 1, "the unexpected throw is still counted as a failure");
  ok(failJobArgs?.failureReason === "unexpected synchronous throw inside evaluate", "the real exception message is captured as the failure reason, not swallowed silently");
}

async function testDeadLetterTransitionIsReportedDistinctly() {
  const summary = await runMoundV2ShadowWorkerTick({
    claim: async () => [fakeJobRow({ jobId: "job_dead_letter" })],
    evaluate: async () => fakeEvalResult({ failureReason: "final straw" }),
    failJob: async () => ({ ...fakeJobRow(), status: "dead_letter", attemptCount: MOUND_V2_SHADOW_JOB_MAX_ATTEMPTS } as MoundV2ShadowJobRow),
  });
  ok(summary.deadLettered === 1 && summary.failed === 0, `a fail write that comes back status=dead_letter is counted as deadLettered, NOT as an ordinary failed (got ${JSON.stringify(summary)})`);
}

async function testAHealthyBatchProcessesEveryJobIndependently() {
  const completedIds: string[] = [];
  const summary = await runMoundV2ShadowWorkerTick({
    claim: async () => [fakeJobRow({ jobId: "job_a" }), fakeJobRow({ jobId: "job_b" }), fakeJobRow({ jobId: "job_c" })],
    evaluate: async () => fakeEvalResult(),
    buildRows: () => [{ predictionId: "p" } as any],
    createPrediction: async () => {},
    completeJob: async (jobId) => { completedIds.push(jobId); },
  });
  ok(summary.claimed === 3 && summary.completed === 3, `all 3 healthy jobs in the batch complete independently (got claimed=${summary.claimed} completed=${summary.completed})`);
  ok(completedIds.length === 3 && new Set(completedIds).size === 3, "completeJob was called exactly once per distinct job");
}

async function testAJobThatThrowsDuringPersistDoesNotStopOthers() {
  const completedIds: string[] = [];
  const failedIds: string[] = [];
  const summary = await runMoundV2ShadowWorkerTick({
    claim: async () => [fakeJobRow({ jobId: "job_persist_ok" }), fakeJobRow({ jobId: "job_persist_throws" }), fakeJobRow({ jobId: "job_persist_ok_2" })],
    evaluate: async () => fakeEvalResult(),
    buildRows: () => [{ predictionId: "p" } as any],
    createPrediction: async () => { /* default: succeeds */ },
    completeJob: async (jobId) => {
      if (jobId === "job_persist_throws") throw new Error("simulated DB write failure");
      completedIds.push(jobId);
    },
    failJob: async (args) => { failedIds.push(args.jobId); return null; },
  });
  ok(summary.claimed === 3, "all 3 jobs are claimed");
  ok(completedIds.includes("job_persist_ok") && completedIds.includes("job_persist_ok_2"), "the two healthy jobs complete successfully");
  ok(failedIds.includes("job_persist_throws"), "the job whose completeJob call throws is caught and recorded as a failure, not left in limbo or crashing the tick");
  ok(summary.completed === 2 && summary.failed === 1, `summary reflects exactly 2 completed + 1 failed (got ${JSON.stringify(summary)})`);
}

async function testClaimFailureReturnsHonestZeroSummary() {
  let threw = false;
  let summary: any = null;
  try {
    summary = await runMoundV2ShadowWorkerTick({ claim: async () => { throw new Error("db connection lost"); } });
  } catch {
    threw = true;
  }
  ok(!threw, "the worker tick never throws even when the claim query itself fails");
  ok(summary?.claimed === 0 && summary?.completed === 0 && summary?.failed === 0, "a claim failure returns an honest all-zero summary, never a partial/fabricated one");
}

async function main() {
  await testNoJobsClaimedIsANoOp();
  await testHappyPathClaimEvaluatePersistComplete();
  await testEvaluateFailureReasonRecordsFailureNeverCompletes();
  await testUnexpectedExceptionAnywhereIsCaughtAndRecorded();
  await testDeadLetterTransitionIsReportedDistinctly();
  await testAHealthyBatchProcessesEveryJobIndependently();
  await testAJobThatThrowsDuringPersistDoesNotStopOthers();
  await testClaimFailureReturnsHonestZeroSummary();
  console.log(`\nmoundV2ShadowWorker.integration.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
