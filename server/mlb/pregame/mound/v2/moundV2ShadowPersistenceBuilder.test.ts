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
      gamePk: "gamePk_1",
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
    v1RecommendedSide: "OVER",
    v1QualificationStatus: "recommended",
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
  ok(strikeoutsRow.v1RecommendedSide === "OVER", "V1's own frozen recommended side carries through, never recomputed");
  ok(strikeoutsRow.v1QualificationStatus === "recommended", "v1QualificationStatus carries through onto the persisted row");
  ok(strikeoutsRow.v2DecisionPolicyVersion === result.strikeoutsDecision?.policyVersion, "the persisted decision policy version matches the strikeouts market's own decision result, not the outs market's");
  ok(strikeoutsRow.v2DecisionSide === result.strikeoutsDecision?.side, "the persisted decision side matches the strikeouts decision exactly");
  ok(strikeoutsRow.v2Qualified === result.strikeoutsDecision?.qualified, "the persisted qualified flag matches the strikeouts decision exactly");
  ok(strikeoutsRow.v2QualificationReason === result.strikeoutsDecision?.reason, "the persisted qualification reason matches the strikeouts decision exactly");
  ok(strikeoutsRow.gamePk === "gamePk_1", "gamePk (MLB Stats API id) carries through — the only durable way a later reconciliation pass can call syncGameBoxScore for this exact game");
  ok(
    strikeoutsRow.scheduledGameTime instanceof Date && strikeoutsRow.scheduledGameTime.toISOString() === "2026-07-29T23:05:00.000Z",
    `scheduledGameTime carries through as a real Date, distinct from evaluationTimestamp (got ${strikeoutsRow.scheduledGameTime})`,
  );
  ok(
    strikeoutsRow.evaluationTimestamp.getTime() !== strikeoutsRow.scheduledGameTime!.getTime(),
    "evaluationTimestamp (build time) and scheduledGameTime (first pitch) are captured as genuinely distinct moments, never aliased",
  );

  const outsRow = rows.find((r) => r.market === "pitcher_outs")!;
  ok(outsRow.frozenLine === null && outsRow.sportsbook === null, "outs market has no real fetch path today — honestly null, never fabricated or cross-substituted from strikeouts");
  ok(outsRow.v1RecommendedSide === "OVER", "v1RecommendedSide is the same V1 decision for both markets (it's a per-pitcher call, not per-market)");
  ok(outsRow.v2DecisionPolicyVersion === result.outsDecision?.policyVersion, "the outs row's decision policy version matches the OUTS market's own decision, not strikeouts'");
  ok(outsRow.v2QualificationReason === result.outsDecision?.reason, "the outs row's qualification reason matches the OUTS market's own decision");
  // outsLine is null in this fixture -> MoundV2MarketResult's own contract
  // (moundV2Types.ts) makes over/under/push all 0 in that case -> the
  // decision policy's probability floor (0 >= 0.55 is false) is the real,
  // honest reason it never qualifies — never a fabricated recommendation
  // against a market that was never even posted.
  ok(outsRow.v2Qualified === false && outsRow.v2QualificationReason === "below_minimum_probability", `the outs market (no real posted line today) never fabricates a qualified recommendation (got qualified=${outsRow.v2Qualified} reason=${outsRow.v2QualificationReason})`);
}

// ── v1RecommendedSide null (V1 had no direction) is never fabricated ──────
{
  const result = evaluateMoundV2Shadow(baseArgs({ v1RecommendedSide: null, v1QualificationStatus: "not_recommended" }));
  const rows = buildMoundV2ShadowPredictionRows(result);
  ok(rows.every((r) => r.v1RecommendedSide === null), "when V1 had no resolved direction, every persisted row honestly carries v1RecommendedSide=null");
  ok(rows.every((r) => r.v1QualificationStatus === "not_recommended"), "every persisted row honestly carries v1QualificationStatus=not_recommended");
}

// ── A null gamePk/scheduledGameTime (unresolved at capture time) is honest, never fabricated ──
{
  const result = evaluateMoundV2Shadow(baseArgs({
    frozenInputArgs: { ...baseArgs().frozenInputArgs, gamePk: null, scheduledGameTime: null },
  }));
  const rows = buildMoundV2ShadowPredictionRows(result);
  ok(rows.every((r) => r.gamePk === null), "a genuinely unresolved gamePk persists as null, never defaulted to gameId or any other guess");
  ok(rows.every((r) => r.scheduledGameTime === null), "a genuinely unresolved scheduledGameTime persists as null");
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
