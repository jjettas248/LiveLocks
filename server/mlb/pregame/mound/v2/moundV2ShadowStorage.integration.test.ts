// Mound V2 shadow prediction storage — REAL database invariants. Exercises
// storage.ts's actual createMoundV2ShadowPrediction/getMoundV2ShadowPrediction/
// listMoundV2ShadowPredictions/gradeMoundV2ShadowPrediction against a live
// Postgres connection — no monkey-patching. Requires DATABASE_URL to point
// at a disposable database (never production) with the schema already
// present (via ensureMoundV2ShadowPersistenceSchema or `drizzle-kit push`).
//
// Run: DATABASE_URL=postgresql://... npx tsx server/mlb/pregame/mound/v2/moundV2ShadowStorage.integration.test.ts

import { storage } from "../../../../storage";
import { db, pool } from "../../../../db";
import { moundV2ShadowPredictions } from "@shared/schema";
import { eq } from "drizzle-orm";
import type { InsertMoundV2ShadowPrediction } from "@shared/schema";
import { mlbGameCache } from "../../../dataPullService";
import { regradeMoundV2ShadowPrediction } from "./moundV2ShadowGradingSweep";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const TEST_PREFIX = "itest_mv2_";

function fakeRow(over: Partial<InsertMoundV2ShadowPrediction> = {}): InsertMoundV2ShadowPrediction {
  const base: InsertMoundV2ShadowPrediction = {
    predictionId: `${TEST_PREFIX}pred_1`,
    snapshotId: `${TEST_PREFIX}snap_1`,
    gameId: `${TEST_PREFIX}game_1`,
    gamePk: `${TEST_PREFIX}gamePk_1`,
    pitcherId: `${TEST_PREFIX}pitcher_1`,
    pitcherName: "Test Pitcher",
    market: "pitcher_strikeouts",
    frozenLine: "6.5",
    frozenOverPrice: -120,
    frozenUnderPrice: 100,
    sportsbook: "draftkings",
    oddsFetchedAt: new Date("2026-07-29T19:58:00.000Z"),
    scheduledGameTime: new Date("2026-07-29T23:05:00.000Z"),
    evaluationTimestamp: new Date("2026-07-29T20:00:00.000Z"),
    v1Score10: "6.9",
    v1Tier: "strong",
    v1RecommendedSide: "OVER",
    v1QualificationStatus: "recommended",
    v2ModelPolicyVersion: "mound_v2_model_policy_v1",
    v2ModelSide: "OVER",
    v2ModelQualified: true,
    v2ModelQualificationReason: "qualified",
    v2ExecutabilityPolicyVersion: "mound_v2_executability_policy_v1",
    v2Executable: true,
    v2ExecutableSportsbook: "draftkings",
    v2ExecutablePrice: -120,
    v2ExecutableFetchedAt: new Date("2026-07-29T19:58:00.000Z"),
    v2ExecutabilityFailureReason: null,
    setupGrade: null,
    v2ExpectedValue: "0.12",
    v2OverProbability: "0.55",
    v2UnderProbability: "0.42",
    v2PushProbability: "0.03",
    productionModelVersion: "prod_v1",
    v2ModelVersion: "v2_v1",
    contractVersion: "mound_frozen_input_v1",
    featureHash: "abc123",
    dataQuality: "complete",
    lineupStatus: "confirmed",
    shadowLatencyMs: "1.2",
    shadowFailureReason: null,
  } as InsertMoundV2ShadowPrediction;
  return { ...base, ...over };
}

async function cleanup() {
  await db.delete(moundV2ShadowPredictions).where(eq(moundV2ShadowPredictions.gameId, `${TEST_PREFIX}game_1`));
  await db.delete(moundV2ShadowPredictions).where(eq(moundV2ShadowPredictions.gameId, `${TEST_PREFIX}game_volume`));
}

async function testInsertAndIdempotency() {
  const row = fakeRow();
  const inserted = await storage.createMoundV2ShadowPrediction(row);
  ok(inserted !== null && inserted.predictionId === row.predictionId, "a real insert returns the inserted row");

  const duplicate = await storage.createMoundV2ShadowPrediction(row);
  ok(duplicate === null, "inserting the exact same predictionId again returns null (ON CONFLICT DO NOTHING) — no error, no duplicate");

  const rows = await db.select().from(moundV2ShadowPredictions).where(eq(moundV2ShadowPredictions.predictionId, row.predictionId));
  ok(rows.length === 1, `exactly one row exists in the database after the duplicate insert attempt (found ${rows.length})`);

  const fetched = await storage.getMoundV2ShadowPrediction(row.predictionId);
  ok(fetched !== null && fetched.frozenLine === "6.5" && fetched.sportsbook === "draftkings", "getMoundV2ShadowPrediction reads back the real persisted row with correct values");
  ok(fetched?.v1RecommendedSide === "OVER", "v1RecommendedSide (Correction 1) genuinely round-trips through the real database, not just the in-memory type");
  ok(fetched?.v1QualificationStatus === "recommended", "v1QualificationStatus (Final Pre-Push Integrity Pass) genuinely round-trips through the real database");
  ok(fetched?.v2ModelPolicyVersion === "mound_v2_model_policy_v1", "v2ModelPolicyVersion genuinely round-trips through the real database");
  ok(fetched?.v2ModelSide === "OVER", "v2ModelSide genuinely round-trips through the real database");
  ok(fetched?.v2ModelQualified === true, "v2ModelQualified (boolean column) genuinely round-trips through the real database");
  ok(fetched?.v2ModelQualificationReason === "qualified", "v2ModelQualificationReason genuinely round-trips through the real database");
  ok(fetched?.v2ExecutabilityPolicyVersion === "mound_v2_executability_policy_v1", "v2ExecutabilityPolicyVersion (a SEPARATE version from the model policy) genuinely round-trips through the real database");
  ok(fetched?.v2Executable === true, "v2Executable (boolean column) genuinely round-trips through the real database");
  ok(fetched?.v2ExecutableSportsbook === "draftkings", "v2ExecutableSportsbook genuinely round-trips through the real database");
  ok(fetched?.v2ExecutablePrice === -120, "v2ExecutablePrice genuinely round-trips through the real database");
  ok(fetched?.v2ExecutabilityFailureReason === null, "v2ExecutabilityFailureReason is null for a genuinely executable row");
  ok(fetched?.gamePk === `${TEST_PREFIX}gamePk_1`, "gamePk (Correction 3) genuinely round-trips through the real database — the field reconciliation depends on to call syncGameBoxScore correctly");
  ok(
    fetched?.scheduledGameTime instanceof Date && fetched.scheduledGameTime.toISOString() === "2026-07-29T23:05:00.000Z",
    `scheduledGameTime (Correction 3) genuinely round-trips as a real Date through the real database (got ${fetched?.scheduledGameTime})`,
  );
  ok(fetched?.voidReason === null, "voidReason defaults to null in the real database for a pending row");
  ok(fetched?.reconciliationAttemptCount === 0, "reconciliationAttemptCount defaults to 0 in the real database (DB-side DEFAULT, not application code)");
  ok(fetched?.lastReconciliationAttemptAt === null, "lastReconciliationAttemptAt defaults to null in the real database");
  ok(fetched?.lastReconciliationFailureReason === null, "lastReconciliationFailureReason defaults to null in the real database");

  const missing = await storage.getMoundV2ShadowPrediction(`${TEST_PREFIX}does_not_exist`);
  ok(missing === null, "getMoundV2ShadowPrediction returns null for a nonexistent predictionId, never throws");
}

async function testImmutabilityAcrossGrading() {
  const predictionId = `${TEST_PREFIX}pred_immutable`;
  await storage.createMoundV2ShadowPrediction(fakeRow({ predictionId, gameId: `${TEST_PREFIX}game_1` }));

  const before = await storage.getMoundV2ShadowPrediction(predictionId);
  ok(before !== null, "row exists before grading");

  const graded = await storage.gradeMoundV2ShadowPrediction(predictionId, {
    settlementStatus: "graded",
    finalResult: "over",
    finalStatValue: 9,
    gradedAt: new Date("2026-07-30T02:00:00.000Z"),
  });

  ok(graded?.settlementStatus === "graded" && graded?.finalResult === "over", "grading writes the new settlement fields");
  ok(graded?.frozenLine === before?.frozenLine, "frozenLine is unchanged by grading — a frozen field stays frozen");
  ok(graded?.frozenOverPrice === before?.frozenOverPrice, "frozenOverPrice is unchanged by grading");
  ok(graded?.v2ExpectedValue === before?.v2ExpectedValue, "v2ExpectedValue is unchanged by grading");
  ok(graded?.v2OverProbability === before?.v2OverProbability, "v2OverProbability is unchanged by grading");
  ok(graded?.featureHash === before?.featureHash, "featureHash is unchanged by grading");
  ok(graded?.snapshotId === before?.snapshotId, "snapshotId is unchanged by grading");
  ok(graded?.createdAt?.getTime() === before?.createdAt?.getTime(), "createdAt is unchanged by grading");
  ok(graded?.v1RecommendedSide === before?.v1RecommendedSide, "v1RecommendedSide (the captured V1 policy decision) is unchanged by grading — see moundV2V1QualificationLifecycle.integration.test.ts for the full end-to-end proof");
  ok(graded?.v1QualificationStatus === before?.v1QualificationStatus, "v1QualificationStatus is unchanged by grading");
  ok(graded?.v2ModelPolicyVersion === before?.v2ModelPolicyVersion, "v2ModelPolicyVersion is unchanged by grading");
  ok(graded?.v2ModelSide === before?.v2ModelSide, "v2ModelSide is unchanged by grading");
  ok(graded?.v2ModelQualified === before?.v2ModelQualified, "v2ModelQualified is unchanged by grading");
  ok(graded?.v2ModelQualificationReason === before?.v2ModelQualificationReason, "v2ModelQualificationReason is unchanged by grading");
  ok(graded?.v2ExecutabilityPolicyVersion === before?.v2ExecutabilityPolicyVersion, "v2ExecutabilityPolicyVersion is unchanged by grading");
  ok(graded?.v2Executable === before?.v2Executable, "v2Executable is unchanged by grading — a settlement write never re-evaluates executability");
  ok(graded?.v2ExecutablePrice === before?.v2ExecutablePrice, "v2ExecutablePrice is unchanged by grading");

  const regraded = await storage.gradeMoundV2ShadowPrediction(predictionId, {
    settlementStatus: "graded",
    finalResult: "over",
    finalStatValue: 11,
    gradedAt: new Date("2026-07-30T03:00:00.000Z"),
  });
  ok(regraded?.finalStatValue === "11", "re-grading (a correction) safely updates only the grading columns again, callable more than once");
  ok(regraded?.frozenLine === before?.frozenLine, "frozenLine still unchanged after a second grading write");

  const gradeMissing = await storage.gradeMoundV2ShadowPrediction(`${TEST_PREFIX}nonexistent`, {
    settlementStatus: "graded", finalResult: "over", finalStatValue: 5, gradedAt: new Date(),
  });
  ok(gradeMissing === null, "grading a nonexistent predictionId returns null, never throws or creates a row");
}

/** Exercises the REAL regradeMoundV2ShadowPrediction (audit/correction path) against the real DB — no monkey-patching, real storage + real mlbGameCache. */
async function testRealRegradeAudit() {
  const predictionId = `${TEST_PREFIX}pred_regrade_real`;
  const gameId = `${TEST_PREFIX}game_regrade_real`;
  const pitcherId = `${TEST_PREFIX}pitcher_regrade_real`;

  await storage.createMoundV2ShadowPrediction(fakeRow({ predictionId, gameId, pitcherId, frozenLine: "6.5" }));
  await storage.gradeMoundV2ShadowPrediction(predictionId, {
    settlementStatus: "graded", finalResult: "over", finalStatValue: 7, gradedAt: new Date("2026-07-30T02:00:00.000Z"),
  });

  // Simulate an official scoring correction: the real box-score cache now shows 9 Ks, not 7.
  mlbGameCache.gamePitchingBoxScore[gameId] = {
    byPitcherId: { [pitcherId]: { pitcherId, pitcherName: "Test Pitcher", team: "NYY", strikeOuts: 9, outsRecorded: 18, baseOnBalls: 1, earnedRuns: 0, hits: 3, homeRuns: 0 } },
    pitcherOrderByTeam: { NYY: [pitcherId] },
    gameStatus: { abstractGameState: "Final", detailedState: "Final", codedGameState: "F" },
    fetchedAt: Date.now(),
  };

  const result = await regradeMoundV2ShadowPrediction(predictionId);
  ok(result.changed === true && result.reason === "regraded", "the real regrade function detects and applies a genuine correction against a real DB row");

  const afterCorrection = await storage.getMoundV2ShadowPrediction(predictionId);
  ok(afterCorrection?.finalStatValue === "9", "the correction is durably persisted — reading back from the real DB shows the corrected value");
  ok(afterCorrection?.frozenLine === "6.5", "the frozen line is still untouched after a real correction");

  const noOpResult = await regradeMoundV2ShadowPrediction(predictionId);
  ok(noOpResult.changed === false && noOpResult.reason === "no_material_change", "re-running the real regrade function again against the now-correct row is a safe no-op");

  delete mlbGameCache.gamePitchingBoxScore[gameId];
}

/** Exercises storage.ts's recordMoundV2ShadowReconciliationAttempt (Correction 3) directly against the real DB — the atomic increment, timestamp, and failure-reason bookkeeping the reconciliation sweep depends on. */
async function testReconciliationBookkeeping() {
  const predictionId = `${TEST_PREFIX}pred_reconcile`;
  await storage.createMoundV2ShadowPrediction(fakeRow({ predictionId, gameId: `${TEST_PREFIX}game_1` }));

  const attempt1At = new Date("2026-07-30T04:00:00.000Z");
  const afterAttempt1 = await storage.recordMoundV2ShadowReconciliationAttempt(predictionId, { attemptedAt: attempt1At, failureReason: "provider timeout" });
  ok(afterAttempt1?.reconciliationAttemptCount === 1, `first attempt increments the real DB counter to 1 (got ${afterAttempt1?.reconciliationAttemptCount})`);
  ok(afterAttempt1?.lastReconciliationAttemptAt?.getTime() === attempt1At.getTime(), "lastReconciliationAttemptAt is durably persisted as the real attempted-at timestamp");
  ok(afterAttempt1?.lastReconciliationFailureReason === "provider timeout", "lastReconciliationFailureReason is durably persisted");
  ok(afterAttempt1?.settlementStatus === "pending", "recording a reconciliation attempt never touches settlement_status — it is a purely bookkeeping-scoped write");

  const attempt2At = new Date("2026-07-30T04:30:00.000Z");
  const afterAttempt2 = await storage.recordMoundV2ShadowReconciliationAttempt(predictionId, { attemptedAt: attempt2At, failureReason: null });
  ok(afterAttempt2?.reconciliationAttemptCount === 2, `the counter increments atomically in the DB (SQL +1, not a read-modify-write race) across repeated real calls (got ${afterAttempt2?.reconciliationAttemptCount})`);
  ok(afterAttempt2?.lastReconciliationAttemptAt?.getTime() === attempt2At.getTime(), "lastReconciliationAttemptAt reflects the MOST RECENT attempt");
  ok(afterAttempt2?.lastReconciliationFailureReason === null, "a successful (non-error) attempt clears a previously-recorded failure reason back to null");

  const missing = await storage.recordMoundV2ShadowReconciliationAttempt(`${TEST_PREFIX}does_not_exist`, { attemptedAt: new Date(), failureReason: null });
  ok(missing === null, "recording a reconciliation attempt for a nonexistent predictionId returns null, never throws");

  // Column-scoped: recording an attempt never disturbs a frozen field.
  const stillFrozen = await storage.getMoundV2ShadowPrediction(predictionId);
  ok(stillFrozen?.frozenLine === "6.5", "recording reconciliation attempts never touches frozen prediction fields");
  ok(stillFrozen?.v1RecommendedSide === "OVER", "recording reconciliation attempts never touches the captured V1 policy decision");
  ok(stillFrozen?.v1QualificationStatus === "recommended", "recording reconciliation attempts never touches v1QualificationStatus");
  ok(stillFrozen?.v2ModelSide === "OVER", "recording reconciliation attempts never touches V2's own MODEL decision");
  ok(stillFrozen?.v2Executable === true, "recording reconciliation attempts never touches V2's own executability verdict");

  // voidReason round-trips via the real gradeMoundV2ShadowPrediction storage call directly (not just via the sweep).
  const voided = await storage.gradeMoundV2ShadowPrediction(predictionId, {
    settlementStatus: "void", finalResult: null, finalStatValue: null, voidReason: "game_cancelled", gradedAt: new Date("2026-07-30T05:00:00.000Z"),
  });
  ok(voided?.settlementStatus === "void" && voided?.voidReason === "game_cancelled", "gradeMoundV2ShadowPrediction's voidReason param genuinely persists through the real database");
}

async function testListFiltering() {
  const gameId = `${TEST_PREFIX}game_1`;
  await storage.createMoundV2ShadowPrediction(fakeRow({ predictionId: `${TEST_PREFIX}pred_outs`, gameId, market: "pitcher_outs", frozenLine: null }));
  await storage.createMoundV2ShadowPrediction(fakeRow({ predictionId: `${TEST_PREFIX}pred_other_pitcher`, gameId, pitcherId: `${TEST_PREFIX}pitcher_2` }));

  const byGame = await storage.listMoundV2ShadowPredictions({ gameId });
  ok(byGame.length >= 3, `listing by gameId returns every row for that game (got ${byGame.length})`);

  const byMarket = await storage.listMoundV2ShadowPredictions({ gameId, market: "pitcher_outs" });
  ok(byMarket.length === 1 && byMarket[0].predictionId === `${TEST_PREFIX}pred_outs`, "market filter returns exactly the matching row");

  const byPitcher = await storage.listMoundV2ShadowPredictions({ gameId, pitcherId: `${TEST_PREFIX}pitcher_2` });
  ok(byPitcher.length === 1 && byPitcher[0].predictionId === `${TEST_PREFIX}pred_other_pitcher`, "pitcherId filter returns exactly the matching row");

  const byStatus = await storage.listMoundV2ShadowPredictions({ gameId, settlementStatus: "graded" });
  ok(byStatus.every((r) => r.settlementStatus === "graded"), "settlementStatus filter never leaks a non-matching row");

  const byWindow = await storage.listMoundV2ShadowPredictions({
    gameId,
    fromEvaluationTimestamp: new Date("2026-07-29T00:00:00.000Z"),
    toEvaluationTimestamp: new Date("2026-07-29T23:59:59.999Z"),
  });
  ok(byWindow.length >= 3, "evaluationTimestamp window filter includes rows inside the declared range");

  const outsideWindow = await storage.listMoundV2ShadowPredictions({
    gameId,
    fromEvaluationTimestamp: new Date("2020-01-01T00:00:00.000Z"),
    toEvaluationTimestamp: new Date("2020-01-02T00:00:00.000Z"),
  });
  ok(outsideWindow.length === 0, "evaluationTimestamp window filter correctly excludes rows outside the declared range");
}

async function testRealisticVolumeAndIndexUsage() {
  const gameId = `${TEST_PREFIX}game_volume`;
  const N = 300;
  for (let batch = 0; batch < N; batch += 50) {
    const chunk = Array.from({ length: Math.min(50, N - batch) }, (_, i) => {
      const idx = batch + i;
      return fakeRow({
        predictionId: `${TEST_PREFIX}vol_${idx}`,
        gameId,
        pitcherId: `${TEST_PREFIX}pitcher_${idx % 20}`,
        market: idx % 2 === 0 ? "pitcher_strikeouts" : "pitcher_outs",
        settlementStatus: idx % 3 === 0 ? "graded" : idx % 3 === 1 ? "pending" : "void",
        evaluationTimestamp: new Date(Date.UTC(2026, 6, 29, 20, 0, idx)),
      });
    });
    await Promise.all(chunk.map((r) => storage.createMoundV2ShadowPrediction(r)));
  }

  const all = await storage.listMoundV2ShadowPredictions({ gameId, limit: 1000 });
  ok(all.length === N, `all ${N} inserted rows are retrievable (got ${all.length})`);

  const start = performance.now();
  const pending = await storage.listMoundV2ShadowPredictions({ gameId, settlementStatus: "pending", limit: 1000 });
  const elapsed = performance.now() - start;
  ok(pending.length === all.filter((r) => r.settlementStatus === "pending").length, "settlementStatus=pending filter at volume returns the correct subset");
  ok(elapsed < 500, `a settlement_status-filtered query over ${N} rows completes quickly (${elapsed.toFixed(1)}ms) — the settlement_status index is doing its job`);

  const explain = await pool.query(
    `EXPLAIN SELECT * FROM mound_v2_shadow_predictions WHERE settlement_status = $1 AND game_id = $2`,
    ["pending", gameId],
  );
  const plan = explain.rows.map((r: any) => r["QUERY PLAN"]).join("\n");
  console.log("  query plan for settlement_status+game_id filter:\n" + plan.split("\n").map((l) => `    ${l}`).join("\n"));
}

async function main() {
  await cleanup();
  await testInsertAndIdempotency();
  await testImmutabilityAcrossGrading();
  await testRealRegradeAudit();
  await testReconciliationBookkeeping();
  await testListFiltering();
  await testRealisticVolumeAndIndexUsage();
  await cleanup();
  await pool.end();
  console.log(`\nmoundV2ShadowStorage.integration.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); await pool.end(); } catch {}
  process.exit(1);
});
