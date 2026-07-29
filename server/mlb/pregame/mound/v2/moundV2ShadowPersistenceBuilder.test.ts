// Mound V2 shadow persistence row builder — invariants.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ShadowPersistenceBuilder.test.ts

import { evaluateMoundV2Shadow, MOUND_V1_MODEL_VERSION, MOUND_V2_MODEL_VERSION } from "./moundV2ShadowEvaluation";
import { buildMoundV2ShadowPredictionRows } from "./moundV2ShadowPersistenceBuilder";
import type { EvaluateMoundV2ShadowArgs } from "./moundV2ShadowEvaluation";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseArgs(overrides: Partial<EvaluateMoundV2ShadowArgs> = {}): EvaluateMoundV2ShadowArgs {
  return {
    snapshotId: "mound_v2:mlb-mound:2026-07-29:game_1:pitcher_1:build_9",
    now: new Date("2026-07-29T20:00:00.000Z"),
    frozenInputArgs: {
      gameId: "game_1",
      pitcherId: "pitcher_1",
      pitcherName: "Test Pitcher",
      opponent: "OPP",
      scheduledGameTime: "2026-07-29T23:05:00.000Z",
      lineupStatus: "confirmed",
      battingOrder: [
        { playerId: "b1", playerName: "Batter One", battingOrderSlot: 1, handedness: "L", kRateVsThrowHand: 0.27, kRateSamplePa: 200, bvpAtBats: 8, bvpStrikeouts: 2 },
        { playerId: "b2", playerName: "Batter Two", battingOrderSlot: 2, handedness: "R", kRateVsThrowHand: 0.19, kRateSamplePa: 160, bvpAtBats: 0, bvpStrikeouts: 0 },
      ],
      pitcherThrows: "R",
      kPer9: 9.8,
      priorSeasonsKPer9: [9.2, 8.9],
      swStrPct: 13.0,
      cswPct: 29.5,
      missesBatsFamily: null,
      kRateVsLHB: 0.28,
      kRateVsRHB: 0.24,
      avgInningsPerStart: 5.9,
      ipVarianceLast3: 0.8,
      lastStartPitchCount: 93,
      lastStartInningsPitched: 5.7,
      bbPer9: 2.8,
      strikeoutsMarket: { line: 6.5, overPrice: -120, underPrice: 100, sportsbook: "draftkings", fetchedAt: "2026-07-29T19:58:00.000Z" },
      outsMarket: { line: null, overPrice: null, underPrice: null, sportsbook: null, fetchedAt: null },
      dataQuality: "complete",
      productionModelVersion: MOUND_V1_MODEL_VERSION,
      v2ModelVersion: MOUND_V2_MODEL_VERSION,
    },
    productionComponentScores: { pitcherSkillScore: 7.2, workloadScore: 6.5, opponentKProfileScore: 6.8 },
    v1Score10: 6.9,
    v1Tier: "strong",
    strikeoutsLine: 6.5,
    outsLine: null,
    ...overrides,
  };
}

// ── A successful evaluation produces exactly 2 rows (one per market) ───────
{
  const result = evaluateMoundV2Shadow(baseArgs());
  const rows = buildMoundV2ShadowPredictionRows(result);
  ok(rows.length === 2, `a successful evaluation produces exactly 2 rows, one per market (got ${rows.length})`);
  ok(rows.some((r) => r.market === "pitcher_strikeouts") && rows.some((r) => r.market === "pitcher_outs"), "both markets are represented");
}

// ── predictionId is deterministic and idempotency-friendly ────────────────
{
  const result = evaluateMoundV2Shadow(baseArgs());
  const rows = buildMoundV2ShadowPredictionRows(result);
  const strikeoutsRow = rows.find((r) => r.market === "pitcher_strikeouts")!;
  ok(strikeoutsRow.predictionId === `${result.snapshotId}:pitcher_strikeouts`, "predictionId is deterministically derived from snapshotId + market");

  const secondCall = buildMoundV2ShadowPredictionRows(evaluateMoundV2Shadow(baseArgs()));
  const secondStrikeoutsRow = secondCall.find((r) => r.market === "pitcher_strikeouts")!;
  ok(secondStrikeoutsRow.predictionId === strikeoutsRow.predictionId, "re-evaluating identical inputs produces the identical predictionId (same primary key -> ON CONFLICT DO NOTHING at the storage layer)");
}

// ── Frozen fields carry through exactly, never re-derived ──────────────────
{
  const result = evaluateMoundV2Shadow(baseArgs());
  const rows = buildMoundV2ShadowPredictionRows(result);
  const strikeoutsRow = rows.find((r) => r.market === "pitcher_strikeouts")!;
  ok(strikeoutsRow.frozenLine === "6.5", `frozen strikeouts line carries through (got ${strikeoutsRow.frozenLine})`);
  ok(strikeoutsRow.frozenOverPrice === -120, "frozen over price carries through");
  ok(strikeoutsRow.sportsbook === "draftkings", "frozen sportsbook carries through");
  ok(strikeoutsRow.featureHash === result.frozen!.featureHash, "featureHash matches the frozen snapshot's own hash exactly");
  ok(strikeoutsRow.v1Score10 === "6.9" && strikeoutsRow.v1Tier === "strong", "V1's own score10/tier carry through, never recomputed");

  const outsRow = rows.find((r) => r.market === "pitcher_outs")!;
  ok(outsRow.frozenLine === null && outsRow.sportsbook === null, "outs market has no real fetch path today — honestly null, never fabricated or cross-substituted from strikeouts");
}

// ── Every row starts pending, never pre-graded ───────────────────────────────
{
  const result = evaluateMoundV2Shadow(baseArgs());
  const rows = buildMoundV2ShadowPredictionRows(result);
  for (const row of rows) {
    ok(row.settlementStatus === "pending", `${row.market} row starts settlementStatus=pending`);
    ok(row.finalResult === null && row.finalStatValue === null && row.gradedAt === null, `${row.market} row has no grading fields populated yet`);
  }
}

// ── A failed evaluation produces zero rows — nothing real to persist ───────
{
  const failedResult = evaluateMoundV2Shadow(baseArgs());
  // Simulate a failure by hand (evaluateMoundV2Shadow itself never fails on
  // well-formed input, so we construct the "failed" shape directly here).
  const asFailed = { ...failedResult, frozen: null, distribution: null };
  const rows = buildMoundV2ShadowPredictionRows(asFailed);
  ok(rows.length === 0, "a failed evaluation (no frozen snapshot / no distribution) produces zero persistable rows");
}

console.log(`\nmoundV2ShadowPersistenceBuilder.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
