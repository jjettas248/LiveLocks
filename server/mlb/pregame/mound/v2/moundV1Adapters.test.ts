// Mound V2 <-> V1 adapters and parity check — invariants.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV1Adapters.test.ts

import { computeWorkload } from "../workload";
import { computePitcherSkill } from "../pitcherSkill";
import { computeOpponentKProfile } from "../opponentKProfile";
import {
  toWorkloadInputsV1,
  toPitcherSkillInputsV1,
  toOpponentKProfileInputsV1,
  toMoundV2Inputs,
  checkMoundV1Parity,
} from "./moundV1Adapters";
import { buildFrozenMoundInput } from "./frozenMoundShadowInput";
import type { BuildFrozenMoundInputArgs } from "./frozenMoundShadowInput";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseArgs(overrides: Partial<BuildFrozenMoundInputArgs> = {}): BuildFrozenMoundInputArgs {
  return {
    snapshotId: "snap_1",
    gameId: "game_1",
    pitcherId: "pitcher_1",
    pitcherName: "Test Pitcher",
    opponent: "OPP",
    scheduledGameTime: "2026-07-29T23:05:00.000Z",
    now: new Date("2026-07-29T20:00:00.000Z"),
    lineupStatus: "confirmed",
    battingOrder: [
      { playerId: "b1", playerName: "Batter One", battingOrderSlot: 1, handedness: "L", kRateVsThrowHand: 0.28, kRateSamplePa: 200, bvpAtBats: 10, bvpStrikeouts: 3 },
      { playerId: "b2", playerName: "Batter Two", battingOrderSlot: 2, handedness: "R", kRateVsThrowHand: 0.15, kRateSamplePa: 150, bvpAtBats: 0, bvpStrikeouts: 0 },
      { playerId: "b3", playerName: "Batter Three", battingOrderSlot: 3, handedness: "S", kRateVsThrowHand: 0.22, kRateSamplePa: 180, bvpAtBats: 5, bvpStrikeouts: 1 },
    ],
    pitcherThrows: "R",
    kPer9: 10.2,
    priorSeasonsKPer9: [9.4, 9.0],
    swStrPct: 13.5,
    cswPct: 30,
    missesBatsFamily: { family: "breaking", whiffPct: 38, usagePct: 30 },
    kRateVsLHB: 0.29,
    kRateVsRHB: 0.25,
    avgInningsPerStart: 6.1,
    ipVarianceLast3: 0.7,
    lastStartPitchCount: 94,
    lastStartInningsPitched: 6,
    bbPer9: 2.6,
    strikeoutsMarket: { line: 6.5, overPrice: -125, underPrice: 105, sportsbook: "draftkings", fetchedAt: "2026-07-29T19:58:00.000Z" },
    outsMarket: { line: 17.5, overPrice: -110, underPrice: -110, sportsbook: "fanduel", fetchedAt: "2026-07-29T19:58:00.000Z" },
    dataQuality: "complete",
    productionModelVersion: "mound_v1",
    v2ModelVersion: "mound_v2_shadow_v1",
    ...overrides,
  };
}

// ── Adapters produce valid, in-range V1 component scores ────────────────────
{
  const frozen = buildFrozenMoundInput(baseArgs());
  const workload = computeWorkload(toWorkloadInputsV1(frozen));
  const pitcherSkill = computePitcherSkill(toPitcherSkillInputsV1(frozen));
  const opponentKProfile = computeOpponentKProfile(toOpponentKProfileInputsV1(frozen));

  ok(workload.available && workload.score10 >= 0 && workload.score10 <= 10, `adapter-derived workload score is valid (got ${workload.score10})`);
  ok(pitcherSkill.available && pitcherSkill.score10 >= 0 && pitcherSkill.score10 <= 10, `adapter-derived pitcher skill score is valid (got ${pitcherSkill.score10})`);
  ok(opponentKProfile.available && opponentKProfile.score10 >= 0 && opponentKProfile.score10 <= 10, `adapter-derived opponent K profile score is valid (got ${opponentKProfile.score10})`);
}

// ── Opponent K profile adapter aggregates lineup handedness correctly ──────
{
  const frozen = buildFrozenMoundInput(baseArgs());
  const inputs = toOpponentKProfileInputsV1(frozen);
  ok(inputs.opposingLineupHandedness?.left === 1 && inputs.opposingLineupHandedness?.right === 1 && inputs.opposingLineupHandedness?.switchHit === 1,
    `lineup handedness counts match the fixture (1 L, 1 R, 1 S): got ${JSON.stringify(inputs.opposingLineupHandedness)}`);
  ok(inputs.lineupBatterKCoverage === 1, "all 3 fixture batters have a real kRateVsThrowHand, so coverage is 1.0");
}

// ── Parity check: matching production scores -> no mismatches ──────────────
{
  const frozen = buildFrozenMoundInput(baseArgs());
  const workload = computeWorkload(toWorkloadInputsV1(frozen));
  const pitcherSkill = computePitcherSkill(toPitcherSkillInputsV1(frozen));
  const opponentKProfile = computeOpponentKProfile(toOpponentKProfileInputsV1(frozen));

  const result = checkMoundV1Parity(frozen, {
    workloadScore: workload.score10,
    pitcherSkillScore: pitcherSkill.score10,
    opponentKProfileScore: opponentKProfile.score10,
  });
  ok(result.matches === true, `identical production scores produce a clean parity match (mismatches: ${result.mismatches.join("; ")})`);
  ok(result.mismatches.length === 0, "no mismatches reported when everything agrees");
}

// ── Parity check: a genuinely diverged production score is caught ─────────
{
  const frozen = buildFrozenMoundInput(baseArgs());
  const result = checkMoundV1Parity(frozen, {
    workloadScore: 0.1, // deliberately wrong
    pitcherSkillScore: null,
    opponentKProfileScore: null,
  });
  ok(result.matches === false, "a genuinely diverged production score fails the parity check");
  ok(result.mismatches.some((m) => m.includes("workloadScore")), "the mismatch identifies which component diverged");
}

// ── Parity check never throws — it reports, per the Plate precedent ───────
{
  const frozen = buildFrozenMoundInput(baseArgs({ battingOrder: [] }));
  let threw = false;
  let result: ReturnType<typeof checkMoundV1Parity> | undefined;
  try {
    result = checkMoundV1Parity(frozen, { workloadScore: null, pitcherSkillScore: null, opponentKProfileScore: null });
  } catch {
    threw = true;
  }
  ok(!threw, "an empty lineup does not throw the parity check — it degrades gracefully");
  ok(result !== undefined, "a result is still returned for a degenerate lineup");
}

// ── toMoundV2Inputs: per-batter probability respects handedness, including switch hitters ──
{
  const frozen = buildFrozenMoundInput(baseArgs());
  const v2Inputs = toMoundV2Inputs(frozen);
  ok(v2Inputs.batters.length === 3, "all 3 batters carry through to the V2 inputs");
  ok(v2Inputs.batters.every((b) => b.strikeoutProbability > 0 && b.strikeoutProbability < 1), "every batter gets a valid (0,1) strikeout probability");
  ok(v2Inputs.strikeoutsLine === 6.5 && v2Inputs.outsLine === 17.5, "market lines pass through from the frozen snapshot when not overridden");

  const overridden = toMoundV2Inputs(frozen, { strikeoutsLine: 7.5, outsLine: null });
  ok(overridden.strikeoutsLine === 7.5 && overridden.outsLine === null, "explicit opts override the frozen snapshot's market lines");
}

// ── A pitcher with unknown throwing hand still degrades switch-hitter probability gracefully ──
{
  const frozen = buildFrozenMoundInput(baseArgs({ pitcherThrows: null }));
  const v2Inputs = toMoundV2Inputs(frozen);
  const switchBatter = v2Inputs.batters.find((b) => b.playerId === "b3");
  ok(!!switchBatter && switchBatter.strikeoutProbability > 0 && switchBatter.strikeoutProbability < 1,
    "an unknown pitcher throwing hand still yields a valid probability for a switch hitter (falls back to the batter's own rate)");
}

console.log(`\nmoundV1Adapters.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
