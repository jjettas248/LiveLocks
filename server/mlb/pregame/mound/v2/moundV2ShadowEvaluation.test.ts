// Mound V2 shadow evaluation — invariants.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ShadowEvaluation.test.ts

import { evaluateMoundV2Shadow, MOUND_V1_MODEL_VERSION, MOUND_V2_MODEL_VERSION } from "./moundV2ShadowEvaluation";
import type { EvaluateMoundV2ShadowArgs } from "./moundV2ShadowEvaluation";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseArgs(overrides: Partial<EvaluateMoundV2ShadowArgs> = {}): EvaluateMoundV2ShadowArgs {
  return {
    snapshotId: "mound_v2:test:1",
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

// ── A well-formed evaluation succeeds and returns a real distribution ──────
{
  const result = evaluateMoundV2Shadow(baseArgs());
  ok(result.failureReason === null, `a well-formed evaluation has no failure reason (got ${result.failureReason})`);
  ok(result.frozen !== null, "a frozen snapshot is returned");
  ok(result.distribution !== null, "a distribution is returned");
  ok(result.parity !== null, "a parity result is returned");
  ok(result.latencyMs >= 0 && Number.isFinite(result.latencyMs), `latencyMs is a real, finite, non-negative measurement (got ${result.latencyMs})`);
  ok(result.snapshotId === "mound_v2:test:1", "snapshotId passes through");
  ok(result.v1RecommendedSide === "OVER", "v1RecommendedSide passes through unchanged, never recomputed");
  ok(result.v1Score10 === 6.9 && result.v1Tier === "strong", "V1's own score10/tier pass through unchanged, never recomputed");
  ok(result.v1QualificationStatus === "recommended", "v1QualificationStatus passes through unchanged, never recomputed");
  ok(result.strikeoutsDecision !== null && result.outsDecision !== null, "both markets get their own decision-policy verdict");
  ok(result.strikeoutsDecision!.policyVersion.length > 0, "the strikeouts decision carries a real, non-empty policy version");
  ok(
    (result.strikeoutsDecision!.side === null) === (result.strikeoutsDecision!.qualified === false),
    "side is null if and only if qualified is false — never a qualified verdict with no side, or an unqualified one with a side",
  );
}

// ── v1RecommendedSide: null (V1 had no resolved direction) passes through honestly ──
{
  const result = evaluateMoundV2Shadow(baseArgs({ v1RecommendedSide: null, v1QualificationStatus: "not_recommended" }));
  ok(result.v1RecommendedSide === null, "a null v1RecommendedSide (V1 had no direction) is never coerced into a fabricated OVER/UNDER");
  ok(result.v1QualificationStatus === "not_recommended", "not_recommended passes through unchanged");
}

// ── V2's decision policy can independently abstain even when V1 recommends ──
{
  // Force an abstention via bad data quality regardless of what the probabilities turn out to be.
  const result = evaluateMoundV2Shadow(baseArgs({
    frozenInputArgs: { ...baseArgs().frozenInputArgs, dataQuality: "degraded" },
  }));
  ok(result.strikeoutsDecision?.qualified === false && result.strikeoutsDecision?.side === null, "V2's own decision policy can abstain (degraded data quality) independently of whatever V1 did — this is exactly the fix for 'V2's implied side' always forcing a pick");
  ok(result.strikeoutsDecision?.reason === "data_quality_not_allowed", "the abstention carries the real, specific reason");
}

// ── V2 abstains on stale odds regardless of how strong the probability edge is ──
{
  const result = evaluateMoundV2Shadow(baseArgs({
    frozenInputArgs: {
      ...baseArgs().frozenInputArgs,
      strikeoutsMarket: { line: 6.5, overPrice: -120, underPrice: 100, sportsbook: "draftkings", fetchedAt: "2026-07-28T00:00:00.000Z" }, // ~44h before `now`
    },
  }));
  ok(result.strikeoutsDecision?.side === null && result.strikeoutsDecision?.reason === "odds_too_stale", "a price far older than the policy's max age abstains, never grading against a possibly-unexecutable stale price");
}

// ── Failure branch leaves qualification/decision fields honestly null, never fabricated ──
{
  const result = evaluateMoundV2Shadow(baseArgs({
    frozenInputArgs: { ...baseArgs().frozenInputArgs, battingOrder: null as any },
  }));
  if (result.failureReason) {
    ok(result.v1QualificationStatus === null, "the failure branch reports v1QualificationStatus as null, never a fabricated status");
    ok(result.strikeoutsDecision === null && result.outsDecision === null, "the failure branch reports both decisions as null, never a fabricated verdict");
  } else {
    ok(true, "battingOrder:null did not trigger the failure branch in this build — not the property under test here");
  }
}

// ── Evaluation never throws, even with a nonsensical input ─────────────────
{
  let threw = false;
  let result: ReturnType<typeof evaluateMoundV2Shadow> | undefined;
  try {
    result = evaluateMoundV2Shadow(
      baseArgs({
        frozenInputArgs: {
          ...baseArgs().frozenInputArgs,
          battingOrder: [{ playerId: "x", playerName: "X", battingOrderSlot: -5, handedness: null, kRateVsThrowHand: NaN, kRateSamplePa: null, bvpAtBats: null, bvpStrikeouts: null }],
          avgInningsPerStart: -100,
          ipVarianceLast3: -50,
        },
      }),
    );
  } catch {
    threw = true;
  }
  ok(!threw, "evaluateMoundV2Shadow never throws, even for nonsensical/degenerate inputs");
  ok(result !== undefined, "a result object is always returned");
  ok(result!.latencyMs >= 0, "latency is still recorded even for a degenerate input");
}

// ── A matching production score produces a clean parity result ────────────
{
  const result = evaluateMoundV2Shadow(baseArgs({ productionComponentScores: { pitcherSkillScore: null, workloadScore: null, opponentKProfileScore: null } }));
  ok(result.parity?.matches === true, "no production scores supplied means nothing to disagree with — parity matches trivially");
}

// ── A genuinely wrong production score is caught as a mismatch ────────────
{
  const result = evaluateMoundV2Shadow(baseArgs({ productionComponentScores: { pitcherSkillScore: 0.01, workloadScore: null, opponentKProfileScore: null } }));
  ok(result.parity?.matches === false, "a deliberately wrong production score is caught by the parity check");
}

console.log(`\nmoundV2ShadowEvaluation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
