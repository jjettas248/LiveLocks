// Mound V2 shadow grading — sweep/regrade orchestration invariants.
// Requires a live DATABASE_URL (storage.ts's db.ts throws without one at
// import time) — same constraint as the analogous V1 test,
// moundGradingFinalization.test.ts. Monkey-patches storage methods and
// mutates mlbGameCache directly, mirroring that file's exact convention.
// Pure decision-logic tests that don't need storage live in the sibling
// moundV2ShadowGrading.test.ts, which runs without a database.
//
// Run: DATABASE_URL=postgres://... npx tsx server/mlb/pregame/mound/v2/moundV2ShadowGrading.integration.test.ts

import {
  runMoundV2ShadowGradingSweep,
  regradeMoundV2ShadowPrediction,
} from "./moundV2ShadowGradingSweep";
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
const originalGet = storage.getMoundV2ShadowPrediction.bind(storage);
function restoreStorage() {
  (storage as any).listMoundV2ShadowPredictions = originalList;
  (storage as any).gradeMoundV2ShadowPrediction = originalGrade;
  (storage as any).getMoundV2ShadowPrediction = originalGet;
}

function fakeRow(over: Partial<MoundV2ShadowPredictionRow>): MoundV2ShadowPredictionRow {
  return {
    predictionId: "pred_1", snapshotId: "snap_1", gameId: "g1", pitcherId: "p1", pitcherName: "P",
    market: "pitcher_strikeouts", frozenLine: "6.5", frozenOverPrice: -120, frozenUnderPrice: 100,
    sportsbook: "draftkings", oddsFetchedAt: new Date(), evaluationTimestamp: new Date(),
    v1Score10: "6.9", v1Tier: "strong", setupGrade: null,
    v2ExpectedValue: "0.1", v2OverProbability: "0.55", v2UnderProbability: "0.42", v2PushProbability: "0.03",
    productionModelVersion: "prod_v1", v2ModelVersion: "v2_v1", contractVersion: "mound_frozen_input_v1",
    featureHash: "abc123", dataQuality: "complete", lineupStatus: "confirmed",
    shadowLatencyMs: "2.1", shadowFailureReason: null,
    settlementStatus: "pending", finalResult: null, finalStatValue: null, gradedAt: null,
    createdAt: new Date(),
    ...over,
  } as MoundV2ShadowPredictionRow;
}

async function testSweep() {
  delete mlbGameCache.gamePitchingBoxScore.g1;
  delete mlbGameCache.gamePitchingBoxScore.g2;
  delete mlbGameCache.gamePitchingBoxScore.g3;

  const rows: MoundV2ShadowPredictionRow[] = [
    fakeRow({ predictionId: "pred_final_grade", gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts", frozenLine: "6.5" }),
    fakeRow({ predictionId: "pred_cancelled", gameId: "g2", pitcherId: "p2", market: "pitcher_strikeouts", frozenLine: "5.5" }),
    fakeRow({ predictionId: "pred_still_live", gameId: "g3", pitcherId: "p3", market: "pitcher_strikeouts", frozenLine: "7.5" }),
  ];

  mlbGameCache.gamePitchingBoxScore.g1 = {
    byPitcherId: { p1: { pitcherId: "p1", pitcherName: "P1", team: "NYY", strikeOuts: 9, outsRecorded: 18, baseOnBalls: 1, earnedRuns: 0, hits: 3, homeRuns: 0 } },
    pitcherOrderByTeam: { NYY: ["p1"] },
    gameStatus: { abstractGameState: "Final", detailedState: "Final", codedGameState: "F" },
    fetchedAt: Date.now(),
  };
  mlbGameCache.gamePitchingBoxScore.g2 = {
    byPitcherId: {},
    pitcherOrderByTeam: {},
    gameStatus: { abstractGameState: "Final", detailedState: "Cancelled", codedGameState: "C" },
    fetchedAt: Date.now(),
  };
  mlbGameCache.gamePitchingBoxScore.g3 = {
    byPitcherId: { p3: { pitcherId: "p3", pitcherName: "P3", team: "BOS", strikeOuts: 4, outsRecorded: 10, baseOnBalls: 2, earnedRuns: 1, hits: 4, homeRuns: 0 } },
    pitcherOrderByTeam: { BOS: ["p3"] },
    gameStatus: { abstractGameState: "Live", detailedState: "In Progress", codedGameState: "I" },
    fetchedAt: Date.now(),
  };

  let listArgs: any = null;
  const gradeCalls: Array<{ predictionId: string; grading: any }> = [];
  (storage as any).listMoundV2ShadowPredictions = async (filter: any) => { listArgs = filter; return rows; };
  (storage as any).gradeMoundV2ShadowPrediction = async (predictionId: string, grading: any) => {
    gradeCalls.push({ predictionId, grading });
    return null;
  };

  const summary = await runMoundV2ShadowGradingSweep();

  ok(listArgs?.settlementStatus === "pending", "sweep lists ONLY settlementStatus=pending rows — idempotent by construction, never re-lists graded/void rows");
  ok(summary.graded === 1 && summary.voided === 1 && summary.held === 1 && summary.errors === 0, `sweep summary reflects each row's real outcome exactly once (got ${JSON.stringify(summary)})`);
  ok(gradeCalls.length === 2, `only the grade+void rows trigger a storage write, the held row does not (got ${gradeCalls.length} calls)`);

  const finalCall = gradeCalls.find((c) => c.predictionId === "pred_final_grade");
  ok(finalCall?.grading.settlementStatus === "graded" && finalCall?.grading.finalStatValue === 9 && finalCall?.grading.finalResult === "over", "final+gradeable row is written as graded with the real box-score strikeout total (9) vs its own frozen line (6.5) = over");

  const cancelledCall = gradeCalls.find((c) => c.predictionId === "pred_cancelled");
  ok(cancelledCall?.grading.settlementStatus === "void" && cancelledCall?.grading.finalResult === null && cancelledCall?.grading.finalStatValue === null, "cancelled-game row is written as void with no fabricated result/stat");

  const stillLiveCall = gradeCalls.find((c) => c.predictionId === "pred_still_live");
  ok(stillLiveCall === undefined, "still-live, not-yet-pulled row is never written at all — stays pending in the DB");

  // ── Never throws: list failure ──
  (storage as any).listMoundV2ShadowPredictions = async () => { throw new Error("db unavailable"); };
  let threw = false;
  let summary2: any = null;
  try { summary2 = await runMoundV2ShadowGradingSweep(); } catch { threw = true; }
  ok(!threw, "sweep never throws even when listing pending predictions fails");
  ok(summary2 && summary2.graded === 0 && summary2.voided === 0 && summary2.held === 0, "a listing failure returns an honest all-zero summary, not a partial/fabricated one");

  // ── Never throws: one row's grade call fails, others still process ──
  (storage as any).listMoundV2ShadowPredictions = async () => [
    fakeRow({ predictionId: "pred_a", gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts", frozenLine: "6.5" }),
    fakeRow({ predictionId: "pred_b", gameId: "g1", pitcherId: "p1", market: "pitcher_outs", frozenLine: null }),
  ];
  let gradeCallCount = 0;
  (storage as any).gradeMoundV2ShadowPrediction = async (predictionId: string) => {
    gradeCallCount++;
    if (predictionId === "pred_a") throw new Error("transient write failure");
    return null;
  };
  let threw2 = false;
  let summary3: any = null;
  try { summary3 = await runMoundV2ShadowGradingSweep(); } catch { threw2 = true; }
  ok(!threw2, "sweep never throws even when one row's grading write fails");
  ok(gradeCallCount === 2, "a failed row does not stop the sweep from attempting the remaining rows");
  ok(summary3 && summary3.errors === 1 && summary3.graded === 1, "the failed row is counted as an error while the other row still grades successfully");

  restoreStorage();
  delete mlbGameCache.gamePitchingBoxScore.g1;
  delete mlbGameCache.gamePitchingBoxScore.g2;
  delete mlbGameCache.gamePitchingBoxScore.g3;
}

async function testRegrade() {
  delete mlbGameCache.gamePitchingBoxScore.g1;

  (storage as any).getMoundV2ShadowPrediction = async () => null;
  const notFound = await regradeMoundV2ShadowPrediction("missing");
  ok(notFound.changed === false && notFound.reason === "not_found", "regrading a nonexistent predictionId -> not_found, no crash");

  (storage as any).getMoundV2ShadowPrediction = async () => fakeRow({ predictionId: "p_pending", settlementStatus: "pending" });
  const stillPending = await regradeMoundV2ShadowPrediction("p_pending");
  ok(stillPending.changed === false && stillPending.reason === "not_yet_graded", "regrading a still-pending row is refused — that is the sweep's job, not a correction");

  mlbGameCache.gamePitchingBoxScore.g1 = {
    byPitcherId: { p1: { pitcherId: "p1", pitcherName: "P", team: "NYY", strikeOuts: 9, outsRecorded: 18, baseOnBalls: 1, earnedRuns: 0, hits: 3, homeRuns: 0 } },
    pitcherOrderByTeam: { NYY: ["p1"] },
    gameStatus: { abstractGameState: "Final", detailedState: "Final", codedGameState: "F" },
    fetchedAt: Date.now(),
  };

  // Already graded correctly (9 Ks recorded before, still 9 Ks now) -> no material change.
  (storage as any).getMoundV2ShadowPrediction = async () => fakeRow({
    predictionId: "p_correct", gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts",
    frozenLine: "6.5", settlementStatus: "graded", finalResult: "over", finalStatValue: "9",
  });
  let regradeWriteCalled = false;
  (storage as any).gradeMoundV2ShadowPrediction = async () => { regradeWriteCalled = true; return null; };
  const unchanged = await regradeMoundV2ShadowPrediction("p_correct");
  ok(unchanged.changed === false && unchanged.reason === "no_material_change", "re-deriving an already-correct grade reports no_material_change");
  ok(!regradeWriteCalled, "no_material_change never issues a storage write");

  // Simulate an official correction: originally graded 7 Ks, box score now (corrected) shows 9.
  (storage as any).getMoundV2ShadowPrediction = async () => fakeRow({
    predictionId: "p_corrected", gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts",
    frozenLine: "6.5", settlementStatus: "graded", finalResult: "over", finalStatValue: "7",
  });
  let correctionGrading: any = null;
  (storage as any).gradeMoundV2ShadowPrediction = async (_id: string, grading: any) => { correctionGrading = grading; return null; };
  const originalWarn = console.warn;
  let auditLogged = false;
  console.warn = (...args: any[]) => { if (String(args[0]).includes("[MOUND_V2_SHADOW_REGRADE]")) auditLogged = true; };
  const corrected = await regradeMoundV2ShadowPrediction("p_corrected");
  console.warn = originalWarn;
  ok(corrected.changed === true && corrected.reason === "regraded", "a real official-stat correction (7 -> 9 Ks) is detected and applied");
  ok(correctionGrading?.finalStatValue === 9 && correctionGrading?.settlementStatus === "graded", "the correction writes the NEW true final value, not the stale one");
  ok(auditLogged, "a correction emits a [MOUND_V2_SHADOW_REGRADE] audit line");

  // Cache now can't even confirm the pitcher pitched (simulating a data gap) -> never retract to pending.
  delete mlbGameCache.gamePitchingBoxScore.g1;
  (storage as any).getMoundV2ShadowPrediction = async () => fakeRow({
    predictionId: "p_gap", gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts",
    frozenLine: "6.5", settlementStatus: "graded", finalResult: "over", finalStatValue: "9",
  });
  let gapWriteCalled = false;
  (storage as any).gradeMoundV2ShadowPrediction = async () => { gapWriteCalled = true; return null; };
  const gap = await regradeMoundV2ShadowPrediction("p_gap");
  ok(gap.changed === false && gap.reason === "hold_would_not_regrade", "a cache gap that can only produce 'hold' never retracts an existing grade");
  ok(!gapWriteCalled, "hold_would_not_regrade never writes — the stored grade is left exactly as-is");

  restoreStorage();
  delete mlbGameCache.gamePitchingBoxScore.g1;
}

async function main() {
  await testSweep();
  await testRegrade();
  console.log(`\nmoundV2ShadowGrading.integration.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  restoreStorage();
  console.error(e);
  process.exit(1);
});
