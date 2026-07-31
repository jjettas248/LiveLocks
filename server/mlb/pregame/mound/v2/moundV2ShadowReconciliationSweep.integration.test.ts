// Mound V2 shadow reconciliation sweep — BEHAVIORAL invariants (Correction
// 3). Requires a live DATABASE_URL purely because storage.ts's db.ts throws
// at import time without one (same constraint as
// moundV2ShadowGrading.integration.test.ts) — every actual storage call
// below is monkey-patched, and the box-score fetch is injected via `deps`
// (never a real network call), so this proves BEHAVIOR (dedup, rate
// limiting, never-throws, write-skip-on-failure), not just source text.
//
// Run: DATABASE_URL=postgres://... npx tsx server/mlb/pregame/mound/v2/moundV2ShadowReconciliationSweep.integration.test.ts

import {
  runMoundV2ShadowReconciliationSweep,
  gatherMoundV2ShadowGradingCoverageReport,
} from "./moundV2ShadowReconciliationSweep";
import { mlbGameCache } from "../../../dataPullService";
import { storage } from "../../../../storage";
import type { MoundV2ShadowPredictionRow } from "@shared/schema";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const originalList = storage.listMoundV2ShadowPredictions.bind(storage);
const originalGrade = storage.gradeMoundV2ShadowPrediction.bind(storage);
const originalRecordAttempt = storage.recordMoundV2ShadowReconciliationAttempt.bind(storage);
function restoreStorage() {
  (storage as any).listMoundV2ShadowPredictions = originalList;
  (storage as any).gradeMoundV2ShadowPrediction = originalGrade;
  (storage as any).recordMoundV2ShadowReconciliationAttempt = originalRecordAttempt;
}

function clearCache(gameIds: string[]) {
  for (const id of gameIds) delete mlbGameCache.gamePitchingBoxScore[id];
}

function fakeRow(over: Partial<MoundV2ShadowPredictionRow>): MoundV2ShadowPredictionRow {
  return {
    predictionId: "pred_1", snapshotId: "snap_1", gameId: "g1", gamePk: "pk1", pitcherId: "p1", pitcherName: "P",
    market: "pitcher_strikeouts", frozenLine: "6.5", frozenOverPrice: -120, frozenUnderPrice: 100,
    sportsbook: "draftkings", oddsFetchedAt: new Date(), scheduledGameTime: new Date("2026-07-30T00:00:00.000Z"), evaluationTimestamp: new Date("2026-07-29T20:00:00.000Z"),
    v1Score10: "6.9", v1Tier: "strong", setupGrade: null, v1RecommendedSide: "OVER",
    v2ExpectedValue: "0.1", v2OverProbability: "0.55", v2UnderProbability: "0.42", v2PushProbability: "0.03",
    productionModelVersion: "prod_v1", v2ModelVersion: "v2_v1", contractVersion: "mound_frozen_input_v2",
    featureHash: "abc123", dataQuality: "complete", lineupStatus: "confirmed",
    shadowLatencyMs: "2.1", shadowFailureReason: null,
    settlementStatus: "pending", finalResult: null, finalStatValue: null, voidReason: null, gradedAt: null,
    reconciliationAttemptCount: 0, lastReconciliationAttemptAt: null, lastReconciliationFailureReason: null,
    createdAt: new Date(),
    ...over,
  } as MoundV2ShadowPredictionRow;
}

// A game "old enough" that every eligibility check below passes the
// time-based gate without needing to fiddle with each row individually.
const OLD_SCHEDULE = new Date(Date.now() - 10 * 60 * 60 * 1000);

async function testNeverThrowsOnListFailure() {
  (storage as any).listMoundV2ShadowPredictions = async () => { throw new Error("db unavailable"); };
  let threw = false;
  let summary: any = null;
  try { summary = await runMoundV2ShadowReconciliationSweep(); } catch { threw = true; }
  ok(!threw, "the sweep never throws even when listing pending predictions fails");
  ok(summary && summary.candidatesConsidered === 0 && summary.graded === 0, "a listing failure returns an honest all-zero summary");
  restoreStorage();
}

async function testSkipsIneligibleRows() {
  const tooSoonSchedule = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h ago, under the 5h window
  (storage as any).listMoundV2ShadowPredictions = async () => [
    fakeRow({ predictionId: "too_soon", gameId: "g_soon", gamePk: "pk_soon", scheduledGameTime: tooSoonSchedule }),
  ];
  let fetchCalled = false;
  let attemptRecorded = false;
  (storage as any).recordMoundV2ShadowReconciliationAttempt = async () => { attemptRecorded = true; return null; };
  const summary = await runMoundV2ShadowReconciliationSweep({ fetchBoxScore: async () => { fetchCalled = true; } });
  ok(summary.eligible === 0 && summary.skippedIneligible === 1, `a row scheduled only 1h ago is skipped as ineligible (got eligible=${summary.eligible} skipped=${summary.skippedIneligible})`);
  ok(!fetchCalled, "an ineligible (too-soon) row never triggers a box-score fetch");
  ok(!attemptRecorded, "an ineligible (too-soon) row never even records a reconciliation attempt — it was never examined that closely");
  restoreStorage();
}

async function testNoGamePkRowsNeverFetchButRecordAttempt() {
  (storage as any).listMoundV2ShadowPredictions = async () => [
    fakeRow({ predictionId: "no_pk", gameId: "g_no_pk", gamePk: null, scheduledGameTime: OLD_SCHEDULE }),
  ];
  let fetchCalled = false;
  let recordedArgs: any = null;
  (storage as any).recordMoundV2ShadowReconciliationAttempt = async (id: string, attempt: any) => { recordedArgs = { id, attempt }; return null; };
  const summary = await runMoundV2ShadowReconciliationSweep({ fetchBoxScore: async () => { fetchCalled = true; } });
  ok(summary.skippedNoGamePk === 1, `a row with no gamePk is counted distinctly (got ${summary.skippedNoGamePk})`);
  ok(!fetchCalled, "a row with no resolvable gamePk NEVER triggers a network call — there is nothing valid to fetch");
  ok(recordedArgs?.id === "no_pk" && recordedArgs.attempt.failureReason === "gamePk_unresolved_at_capture", "the missing-gamePk case is recorded with an honest, specific reason — never silently ignored, never fabricated as a provider failure");
  restoreStorage();
}

async function testMultipleRowsSameGameShareOneFetch() {
  (storage as any).listMoundV2ShadowPredictions = async () => [
    fakeRow({ predictionId: "row_a", gameId: "g_shared", gamePk: "pk_shared", market: "pitcher_strikeouts", scheduledGameTime: OLD_SCHEDULE }),
    fakeRow({ predictionId: "row_b", gameId: "g_shared", gamePk: "pk_shared", market: "pitcher_outs", scheduledGameTime: OLD_SCHEDULE }),
  ];
  let fetchCallCount = 0;
  const fetchedArgs: Array<[string, string]> = [];
  (storage as any).recordMoundV2ShadowReconciliationAttempt = async () => null;
  const summary = await runMoundV2ShadowReconciliationSweep({
    fetchBoxScore: async (gamePk: string, gameId: string) => { fetchCallCount++; fetchedArgs.push([gamePk, gameId]); },
  });
  ok(fetchCallCount === 1, `two pending rows for the SAME game share exactly ONE box-score fetch, not two (got ${fetchCallCount})`);
  ok(fetchedArgs[0][0] === "pk_shared" && fetchedArgs[0][1] === "g_shared", "the single fetch is called with the real gamePk (for the URL) and gameId (for the cache key) — not conflated");
  ok(summary.gamesConsidered === 1, "gamesConsidered reflects distinct games, not distinct rows");
  restoreStorage();
}

async function testSuccessfulFetchThenGraded() {
  clearCache(["g_grade"]);
  mlbGameCache.gamePitchingBoxScore["g_grade"] = {
    byPitcherId: { p1: { pitcherId: "p1", pitcherName: "P1", team: "NYY", strikeOuts: 9, outsRecorded: 18, baseOnBalls: 1, earnedRuns: 0, hits: 3, homeRuns: 0 } },
    pitcherOrderByTeam: { NYY: ["p1"] },
    gameStatus: { abstractGameState: "Final", detailedState: "Final", codedGameState: "F" },
    fetchedAt: Date.now(),
  };
  (storage as any).listMoundV2ShadowPredictions = async () => [
    fakeRow({ predictionId: "will_grade", gameId: "g_grade", gamePk: "pk_grade", pitcherId: "p1", frozenLine: "6.5", scheduledGameTime: OLD_SCHEDULE }),
  ];
  let gradeArgs: any = null;
  (storage as any).gradeMoundV2ShadowPrediction = async (id: string, grading: any) => { gradeArgs = { id, grading }; return null; };
  const summary = await runMoundV2ShadowReconciliationSweep({ fetchBoxScore: async () => { /* simulates a real fetch populating the cache — already done above */ } });
  ok(summary.graded === 1, `a resolvable final game grades the row (got graded=${summary.graded})`);
  ok(gradeArgs?.id === "will_grade" && gradeArgs.grading.settlementStatus === "graded" && gradeArgs.grading.finalStatValue === 9 && gradeArgs.grading.finalResult === "over", "the graded write carries the real final stat value and result derived from the (now-fetched) box score");
  restoreStorage();
  clearCache(["g_grade"]);
}

async function testSuccessfulFetchThenVoided() {
  clearCache(["g_void"]);
  mlbGameCache.gamePitchingBoxScore["g_void"] = {
    byPitcherId: {}, pitcherOrderByTeam: {},
    gameStatus: { abstractGameState: "Final", detailedState: "Cancelled", codedGameState: "C" },
    fetchedAt: Date.now(),
  };
  (storage as any).listMoundV2ShadowPredictions = async () => [
    fakeRow({ predictionId: "will_void", gameId: "g_void", gamePk: "pk_void", pitcherId: "p1", scheduledGameTime: OLD_SCHEDULE }),
  ];
  let gradeArgs: any = null;
  (storage as any).gradeMoundV2ShadowPrediction = async (id: string, grading: any) => { gradeArgs = { id, grading }; return null; };
  const summary = await runMoundV2ShadowReconciliationSweep({ fetchBoxScore: async () => {} });
  ok(summary.voided === 1, `a cancelled game voids the row (got voided=${summary.voided})`);
  ok(gradeArgs?.grading.settlementStatus === "void" && gradeArgs.grading.voidReason === "game_cancelled", "the void write carries the real, specific void reason — never generic");
  restoreStorage();
  clearCache(["g_void"]);
}

async function testSuccessfulFetchStillHold() {
  clearCache(["g_hold"]);
  mlbGameCache.gamePitchingBoxScore["g_hold"] = {
    byPitcherId: { p1: { pitcherId: "p1", pitcherName: "P1", team: "BOS", strikeOuts: 3, outsRecorded: 8, baseOnBalls: 0, earnedRuns: 1, hits: 2, homeRuns: 0 } },
    pitcherOrderByTeam: { BOS: ["p1"] }, // p1 is last in order -> not pulled
    gameStatus: { abstractGameState: "Live", detailedState: "In Progress", codedGameState: "I" },
    fetchedAt: Date.now(),
  };
  (storage as any).listMoundV2ShadowPredictions = async () => [
    fakeRow({ predictionId: "still_pending", gameId: "g_hold", gamePk: "pk_hold", pitcherId: "p1", scheduledGameTime: OLD_SCHEDULE }),
  ];
  let attemptArgs: any = null;
  let gradeCalled = false;
  (storage as any).recordMoundV2ShadowReconciliationAttempt = async (id: string, attempt: any) => { attemptArgs = { id, attempt }; return null; };
  (storage as any).gradeMoundV2ShadowPrediction = async () => { gradeCalled = true; return null; };
  const summary = await runMoundV2ShadowReconciliationSweep({ fetchBoxScore: async () => {} });
  ok(summary.stillPending === 1 && !gradeCalled, `a game still genuinely in progress is re-checked but NOT graded (got stillPending=${summary.stillPending}, gradeCalled=${gradeCalled})`);
  ok(attemptArgs?.id === "still_pending" && attemptArgs.attempt.failureReason === null, "a hold outcome records a successful (non-error) attempt — this was a real check, not a failure, it just isn't resolvable yet");
  restoreStorage();
  clearCache(["g_hold"]);
}

async function testFetchFailureRecordsFailureNeverGrades() {
  clearCache(["g_fail"]);
  (storage as any).listMoundV2ShadowPredictions = async () => [
    fakeRow({ predictionId: "row1", gameId: "g_fail", gamePk: "pk_fail", scheduledGameTime: OLD_SCHEDULE }),
    fakeRow({ predictionId: "row2", gameId: "g_fail", gamePk: "pk_fail", market: "pitcher_outs", scheduledGameTime: OLD_SCHEDULE }),
  ];
  const recordedAttempts: any[] = [];
  let gradeCalled = false;
  (storage as any).recordMoundV2ShadowReconciliationAttempt = async (id: string, attempt: any) => { recordedAttempts.push({ id, attempt }); return null; };
  (storage as any).gradeMoundV2ShadowPrediction = async () => { gradeCalled = true; return null; };
  const summary = await runMoundV2ShadowReconciliationSweep({ fetchBoxScore: async () => { throw new Error("MLB Stats API 503"); } });
  ok(summary.providerFailures === 2 && !gradeCalled, `a failed fetch records BOTH rows for that game as provider failures and never grades anything (got providerFailures=${summary.providerFailures}, gradeCalled=${gradeCalled})`);
  ok(recordedAttempts.every((a) => a.attempt.failureReason === "MLB Stats API 503"), "every row sharing the failed game gets the REAL error message, not a generic one");
  restoreStorage();
}

async function testRateLimitingTruncatesToMaxGamesPerSweep() {
  const rows = Array.from({ length: 15 }, (_, i) =>
    fakeRow({ predictionId: `many_${i}`, gameId: `g_many_${i}`, gamePk: `pk_many_${i}`, scheduledGameTime: OLD_SCHEDULE }),
  );
  (storage as any).listMoundV2ShadowPredictions = async () => rows;
  (storage as any).recordMoundV2ShadowReconciliationAttempt = async () => null;
  let fetchCallCount = 0;
  const summary = await runMoundV2ShadowReconciliationSweep({ fetchBoxScore: async () => { fetchCallCount++; } });
  ok(summary.gamesConsidered === 15, `all 15 distinct eligible games are counted as considered (got ${summary.gamesConsidered})`);
  ok(summary.gamesReconciledThisTick === 10, `only MAX_GAMES_PER_SWEEP=10 are actually reconciled this tick (got ${summary.gamesReconciledThisTick})`);
  ok(summary.gamesTruncatedThisTick === 5, `the remaining 5 are honestly reported as truncated, never silently dropped (got ${summary.gamesTruncatedThisTick})`);
  ok(fetchCallCount === 10, `exactly 10 real fetch calls happen — the cap is enforced on ACTUAL network calls, not just the summary math (got ${fetchCallCount})`);
  restoreStorage();
}

async function testWholeSweepSingleFlight() {
  let listCallCount = 0;
  let resolveList: (() => void) | null = null;
  const listGate = new Promise<void>((resolve) => { resolveList = resolve; });
  (storage as any).listMoundV2ShadowPredictions = async () => {
    listCallCount++;
    await listGate;
    return [];
  };
  const first = runMoundV2ShadowReconciliationSweep();
  const second = runMoundV2ShadowReconciliationSweep();
  resolveList!();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  ok(listCallCount === 1, `two concurrent sweep calls result in exactly ONE real list call — true single-flight for the whole sweep (got ${listCallCount})`);
  ok(firstResult === secondResult, "the second concurrent call resolves to the EXACT SAME summary object as the first, not a separately-computed one");
  restoreStorage();

  // After the in-flight sweep completes, a NEW call must run again (not permanently stuck sharing one stale promise).
  (storage as any).listMoundV2ShadowPredictions = async () => { listCallCount++; return []; };
  await runMoundV2ShadowReconciliationSweep();
  ok(listCallCount === 2, "once the prior sweep has completed, the NEXT call runs a fresh sweep (single-flight is per-in-flight-run, not permanent)");
  restoreStorage();
}

async function testPerRowErrorDoesNotStopSweep() {
  clearCache(["g_err"]);
  mlbGameCache.gamePitchingBoxScore["g_err"] = {
    byPitcherId: {
      p_bad: { pitcherId: "p_bad", pitcherName: "Bad", team: "NYY", strikeOuts: 5, outsRecorded: 12, baseOnBalls: 0, earnedRuns: 0, hits: 1, homeRuns: 0 },
      p_good: { pitcherId: "p_good", pitcherName: "Good", team: "NYY", strikeOuts: 7, outsRecorded: 15, baseOnBalls: 1, earnedRuns: 0, hits: 2, homeRuns: 0 },
    },
    pitcherOrderByTeam: { NYY: ["p_bad", "p_good"] },
    gameStatus: { abstractGameState: "Final", detailedState: "Final", codedGameState: "F" },
    fetchedAt: Date.now(),
  };
  (storage as any).listMoundV2ShadowPredictions = async () => [
    fakeRow({ predictionId: "bad_row", gameId: "g_err", gamePk: "pk_err", pitcherId: "p_bad", scheduledGameTime: OLD_SCHEDULE }),
    fakeRow({ predictionId: "good_row", gameId: "g_err", gamePk: "pk_err", pitcherId: "p_good", scheduledGameTime: OLD_SCHEDULE }),
  ];
  let gradeCallCount = 0;
  (storage as any).gradeMoundV2ShadowPrediction = async (id: string) => {
    gradeCallCount++;
    if (id === "bad_row") throw new Error("transient write failure");
    return null;
  };
  let threw = false;
  let summary: any = null;
  try { summary = await runMoundV2ShadowReconciliationSweep({ fetchBoxScore: async () => {} }); } catch { threw = true; }
  ok(!threw, "the sweep never throws even when one row's grading write fails");
  ok(gradeCallCount === 2, "a failed row does not stop the sweep from attempting the remaining row in the same game");
  ok(summary.errors === 1 && summary.graded === 1, "the failed row is counted as an error while the other row still grades successfully");
  restoreStorage();
  clearCache(["g_err"]);
}

async function testCoverageReportGathererDelegatesToListAndBuild() {
  const rows = [
    fakeRow({ predictionId: "cov1", settlementStatus: "pending", scheduledGameTime: OLD_SCHEDULE }),
    fakeRow({ predictionId: "cov2", settlementStatus: "graded" }),
  ];
  (storage as any).listMoundV2ShadowPredictions = async () => rows;
  const report = await gatherMoundV2ShadowGradingCoverageReport();
  ok(report.totalRows === 2 && report.pendingCount === 1, `the coverage gatherer lists real rows and produces a real report (got totalRows=${report.totalRows} pendingCount=${report.pendingCount})`);
  restoreStorage();
}

async function main() {
  await testNeverThrowsOnListFailure();
  await testSkipsIneligibleRows();
  await testNoGamePkRowsNeverFetchButRecordAttempt();
  await testMultipleRowsSameGameShareOneFetch();
  await testSuccessfulFetchThenGraded();
  await testSuccessfulFetchThenVoided();
  await testSuccessfulFetchStillHold();
  await testFetchFailureRecordsFailureNeverGrades();
  await testRateLimitingTruncatesToMaxGamesPerSweep();
  await testWholeSweepSingleFlight();
  await testPerRowErrorDoesNotStopSweep();
  await testCoverageReportGathererDelegatesToListAndBuild();
  console.log(`\nmoundV2ShadowReconciliationSweep.integration.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  restoreStorage();
  console.error(e);
  process.exit(1);
});
