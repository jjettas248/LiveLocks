// Mound V2 shadow runner — BEHAVIORAL proof (Correction 2) that nothing
// running inside the shadow block can ever propagate an exception into the
// caller (buildMlbMoundRadar.ts's per-pitcher loop), including cases the
// pure source-position check in moundV2ShadowWiring.test.ts cannot exercise
// (an unexpected throw from evaluate() or record() themselves).
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ShadowRunner.test.ts

import { runMoundV2ShadowForPitcher } from "./moundV2ShadowRunner";
import { MOUND_V1_MODEL_VERSION, MOUND_V2_MODEL_VERSION, type EvaluateMoundV2ShadowArgs, type MoundV2ShadowEvaluationResult } from "./moundV2ShadowEvaluation";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseEvaluateArgs(): EvaluateMoundV2ShadowArgs {
  return {
    snapshotId: "mound_v2:test:1",
    now: new Date("2026-07-30T20:00:00.000Z"),
    frozenInputArgs: {
      gameId: "game_1", pitcherId: "pitcher_1", pitcherName: "Test Pitcher", opponent: "OPP",
      scheduledGameTime: "2026-07-30T23:05:00.000Z", lineupStatus: "confirmed",
      battingOrder: [{ playerId: "b1", playerName: "Batter One", battingOrderSlot: 1, handedness: "L", kRateVsThrowHand: 0.27, kRateSamplePa: 200, bvpAtBats: 8, bvpStrikeouts: 2 }],
      pitcherThrows: "R", kPer9: 9.8, priorSeasonsKPer9: [9.2, 8.9], swStrPct: 13.0, cswPct: 29.5, missesBatsFamily: null,
      kRateVsLHB: 0.28, kRateVsRHB: 0.24, avgInningsPerStart: 5.9, ipVarianceLast3: 0.8, lastStartPitchCount: 93, lastStartInningsPitched: 5.7, bbPer9: 2.8,
      strikeoutsMarket: { line: 6.5, overPrice: -120, underPrice: 100, sportsbook: "draftkings", fetchedAt: "2026-07-30T19:58:00.000Z" },
      outsMarket: { line: null, overPrice: null, underPrice: null, sportsbook: null, fetchedAt: null },
      dataQuality: "complete", productionModelVersion: MOUND_V1_MODEL_VERSION, v2ModelVersion: MOUND_V2_MODEL_VERSION,
    },
    productionComponentScores: { pitcherSkillScore: 7.2, workloadScore: 6.5, opponentKProfileScore: 6.8 },
    v1Score10: 6.9, v1Tier: "strong", v1RecommendedSide: "OVER",
    strikeoutsLine: 6.5, outsLine: null,
  };
}

function fakeResult(over: Partial<MoundV2ShadowEvaluationResult> = {}): MoundV2ShadowEvaluationResult {
  return {
    snapshotId: "s1", gameId: "g1", pitcherId: "p1", evaluatedAt: "2026-07-30T20:00:00.000Z",
    frozen: null, distribution: null, parity: null,
    v1Score10: 6.9, v1Tier: "strong", v1RecommendedSide: "OVER",
    latencyMs: 0.5, failureReason: null,
    ...over,
  };
}

function withCapturedWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: any[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

// ── Never throws when evaluate() itself throws unexpectedly ─────────────
{
  let threw = false;
  const { result, warnings } = withCapturedWarnings(() => {
    try {
      runMoundV2ShadowForPitcher(
        { signalId: "sig1", evaluateArgs: baseEvaluateArgs() },
        { evaluate: () => { throw new Error("simulated evaluate() crash"); } },
      );
      return "no-throw";
    } catch {
      threw = true;
      return "threw";
    }
  });
  ok(!threw && result === "no-throw", "runMoundV2ShadowForPitcher never propagates an exception even when evaluate() itself throws");
  ok(warnings.some((w) => w.includes("[MOUND_V2_SHADOW_UNEXPECTED_ERROR]") && w.includes("simulated evaluate() crash")), "the unexpected error is logged with the real error message, not silently swallowed");
}

// ── Never throws when record() itself throws unexpectedly ───────────────
{
  let threw = false;
  const { result, warnings } = withCapturedWarnings(() => {
    try {
      runMoundV2ShadowForPitcher(
        { signalId: "sig2", evaluateArgs: baseEvaluateArgs() },
        { evaluate: () => fakeResult(), record: () => { throw new Error("simulated record() crash"); } },
      );
      return "no-throw";
    } catch {
      threw = true;
      return "threw";
    }
  });
  ok(!threw && result === "no-throw", "runMoundV2ShadowForPitcher never propagates an exception even when record() itself throws (a bug in the persistence path can never affect V1)");
  ok(warnings.some((w) => w.includes("[MOUND_V2_SHADOW_UNEXPECTED_ERROR]") && w.includes("simulated record() crash")), "the unexpected error from record() is logged with its real message");
}

// ── Never throws for a non-Error thrown value either ─────────────────────
{
  let threw = false;
  try {
    runMoundV2ShadowForPitcher(
      { signalId: "sig3", evaluateArgs: baseEvaluateArgs() },
      { evaluate: () => { throw "a plain string, not an Error object"; } },
    );
  } catch {
    threw = true;
  }
  ok(!threw, "runMoundV2ShadowForPitcher never propagates even a non-Error thrown value (e.g. a plain string)");
}

// ── Return value is always void — nothing for a caller to accidentally merge into V1's signal ──
{
  const returnValue = runMoundV2ShadowForPitcher(
    { signalId: "sig4", evaluateArgs: baseEvaluateArgs() },
    { evaluate: () => fakeResult(), record: () => {} },
  );
  ok(returnValue === undefined, "runMoundV2ShadowForPitcher always returns undefined — structurally nothing can flow back into the caller");
}

// ── record() is called with exactly the result evaluate() returned ──────
{
  const theResult = fakeResult({ latencyMs: 42, v1Score10: 1.23 });
  let recordedWith: MoundV2ShadowEvaluationResult | null = null;
  runMoundV2ShadowForPitcher(
    { signalId: "sig5", evaluateArgs: baseEvaluateArgs() },
    { evaluate: () => theResult, record: (r) => { recordedWith = r; } },
  );
  ok(recordedWith === theResult, "record() receives the EXACT object evaluate() returned, never a copy or a transformed value");
}

// ── A clean success (no failureReason, matching parity) logs nothing extra ──
{
  const { warnings } = withCapturedWarnings(() => {
    runMoundV2ShadowForPitcher(
      { signalId: "sig6", evaluateArgs: baseEvaluateArgs() },
      { evaluate: () => fakeResult({ failureReason: null, parity: { matches: true, mismatches: [] } }), record: () => {} },
    );
  });
  ok(warnings.length === 0, "a clean, successful evaluation logs nothing at all — no noise on the happy path");
}

// ── A failureReason is logged, distinctly from a parity mismatch ────────
{
  const { warnings } = withCapturedWarnings(() => {
    runMoundV2ShadowForPitcher(
      { signalId: "sig7", evaluateArgs: baseEvaluateArgs() },
      { evaluate: () => fakeResult({ failureReason: "some internal failure" }), record: () => {} },
    );
  });
  ok(warnings.some((w) => w.includes("[MOUND_V2_SHADOW_FAILURE]") && w.includes("sig7") && w.includes("some internal failure")), "a real failureReason is logged with the signalId and the reason");
}
{
  const { warnings } = withCapturedWarnings(() => {
    runMoundV2ShadowForPitcher(
      { signalId: "sig8", evaluateArgs: baseEvaluateArgs() },
      { evaluate: () => fakeResult({ failureReason: null, parity: { matches: false, mismatches: ["pitcherSkillScore differs"] } }), record: () => {} },
    );
  });
  ok(warnings.some((w) => w.includes("[MOUND_V2_PARITY_MISMATCH]") && w.includes("pitcherSkillScore differs")), "a parity mismatch (no failure) is logged distinctly from a hard failure");
}

// ── Default deps (no injection) exercise the REAL evaluate/record path ───
{
  let threw = false;
  try {
    runMoundV2ShadowForPitcher({ signalId: "sig9", evaluateArgs: baseEvaluateArgs() });
  } catch {
    threw = true;
  }
  ok(!threw, "calling with no injected deps at all (the real production call shape) never throws, using the genuine evaluateMoundV2Shadow/recordMoundV2ShadowEvaluation");
}

console.log(`\nmoundV2ShadowRunner.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
