// Mound Radar V2 (shadow) — deterministic adapters from the frozen snapshot
// into production V1's existing per-component input shapes, plus a
// read-only parity check against production's own output.
//
// ISOLATION NOTE (read before adding any import here): this file imports
// THREE of production Mound's pure, side-effect-free component scorers —
// computeWorkload, computePitcherSkill, computeOpponentKProfile. That is a
// deliberate, narrow exception to "mound/v2 never touches production
// Mound," not a violation of it. Those three functions take a plain input
// object and return a plain score object; they perform no I/O, hold no
// state, and cannot publish, settle, sort, or mutate anything. Calling them
// again from here is exactly as inert as calling Math.sqrt twice. Proving
// V2 doesn't silently diverge from V1 requires comparing against V1's REAL
// math — reimplementing that math a second time would make any "parity"
// claim meaningless (two independent implementations can drift from each
// other silently). The combiner (scoring.ts), the settlement/publication
// path (moundDirection.ts, moundOutcomeAttribution.ts, evaluationSnapshot.ts,
// moundGradedStateCarry.ts, buildMlbMoundRadar.ts, any storage.ts mound
// method) remain completely off-limits — see moundV1ParityCheck.test.ts's
// structural check for the precise, enforced boundary.

import { computeWorkload, type WorkloadInputs } from "../workload";
import { computePitcherSkill, type PitcherSkillInputs } from "../pitcherSkill";
import { computeOpponentKProfile, type OpponentKProfileInputs } from "../opponentKProfile";
import { computeBatterStrikeoutProbability } from "./batterStrikeoutProbability";
import type { FrozenMoundInput, FrozenMoundBatterInput, MoundFrozenHandedness } from "./frozenMoundShadowInput";
import type { MoundV2BatterInput, MoundV2Inputs } from "./moundV2Types";

export function toWorkloadInputsV1(frozen: FrozenMoundInput): WorkloadInputs {
  return {
    pitcherKnown: true,
    bbPer9: frozen.bbPer9,
    avgInningsPerStart: frozen.avgInningsPerStart,
    lastStartPitchCount: frozen.lastStartPitchCount,
    lastStartInningsPitched: frozen.lastStartInningsPitched,
    ipVarianceLast3: frozen.ipVarianceLast3,
    // Pitcher archetype is not part of the frozen contract (V2 does not use
    // it, and it only affects one bonus driver, never score10 itself) — a
    // known, documented, intentional gap in the adapter, not a silent one.
    archetype: null,
  };
}

export function toPitcherSkillInputsV1(frozen: FrozenMoundInput): PitcherSkillInputs {
  return {
    pitcherKnown: true,
    kPer9: frozen.kPer9,
    swStrPct: frozen.swStrPct,
    cswPct: frozen.cswPct,
    missesBatsFamily: frozen.missesBatsFamily,
  };
}

function lineupHandednessCounts(battingOrder: FrozenMoundBatterInput[]): { left: number; right: number; switchHit: number } {
  const counts = { left: 0, right: 0, switchHit: 0 };
  for (const b of battingOrder) {
    if (b.handedness === "L") counts.left++;
    else if (b.handedness === "R") counts.right++;
    else if (b.handedness === "S") counts.switchHit++;
  }
  return counts;
}

export function toOpponentKProfileInputsV1(frozen: FrozenMoundInput): OpponentKProfileInputs {
  const withRate = frozen.battingOrder.filter((b) => b.kRateVsThrowHand != null);
  const lineupBatterKRate =
    withRate.length > 0
      ? withRate.reduce((sum, b) => sum + (b.kRateVsThrowHand as number), 0) / withRate.length
      : null;
  const lineupBatterKCoverage = frozen.battingOrder.length > 0 ? withRate.length / frozen.battingOrder.length : 0;
  const lineupHighKShare =
    withRate.length > 0 ? withRate.filter((b) => (b.kRateVsThrowHand as number) >= 0.26).length / withRate.length : null;

  return {
    pitcherKnown: true,
    opposingLineupConfirmed: frozen.lineupStatus === "confirmed",
    kRateVsLHB: frozen.kRateVsLHB,
    kRateVsRHB: frozen.kRateVsRHB,
    opposingLineupHandedness: lineupHandednessCounts(frozen.battingOrder),
    lineupBatterKRate,
    lineupBatterKCoverage,
    lineupHighKShare,
  };
}

/** Pitcher's own platoon K rate vs a SPECIFIC batter's handedness (switch hitters bat opposite the pitcher's throwing hand). */
function pitcherRateVsBatterHand(frozen: FrozenMoundInput, batterHand: MoundFrozenHandedness | null): number | null {
  if (batterHand === "L") return frozen.kRateVsLHB;
  if (batterHand === "R") return frozen.kRateVsRHB;
  if (batterHand === "S") {
    if (frozen.pitcherThrows === "L") return frozen.kRateVsRHB;
    if (frozen.pitcherThrows === "R") return frozen.kRateVsLHB;
    return null;
  }
  return null;
}

export function toMoundV2Inputs(
  frozen: FrozenMoundInput,
  opts: { strikeoutsLine?: number | null; outsLine?: number | null } = {},
): MoundV2Inputs {
  const batters: MoundV2BatterInput[] = frozen.battingOrder.map((b) => ({
    playerId: b.playerId,
    battingOrderSlot: b.battingOrderSlot,
    strikeoutProbability: computeBatterStrikeoutProbability(
      pitcherRateVsBatterHand(frozen, b.handedness),
      b.kRateVsThrowHand,
    ),
  }));

  // `"key" in opts` (not just `opts.key ?? ...`) so an EXPLICIT `null`
  // override (e.g. "compute the raw distribution, no line at all") is
  // honored rather than being indistinguishable from "not provided" and
  // silently falling back to the frozen snapshot's market line.
  const strikeoutsLine = "strikeoutsLine" in opts ? opts.strikeoutsLine ?? null : frozen.strikeoutsMarket.line ?? null;
  const outsLine = "outsLine" in opts ? opts.outsLine ?? null : frozen.outsMarket.line ?? null;

  return {
    pitcherId: frozen.pitcherId,
    workload: {
      avgInningsPerStart: frozen.avgInningsPerStart,
      ipVarianceLast3: frozen.ipVarianceLast3,
      lastStartPitchCount: frozen.lastStartPitchCount,
      lastStartInningsPitched: frozen.lastStartInningsPitched,
      bbPer9: frozen.bbPer9,
    },
    batters,
    strikeoutsLine,
    outsLine,
  };
}

export interface MoundV1ComponentScores {
  pitcherSkillScore: number | null;
  workloadScore: number | null;
  opponentKProfileScore: number | null;
}

export interface MoundV1ParityResult {
  matches: boolean;
  mismatches: string[];
}

const PARITY_TOLERANCE = 0.05;

/**
 * Re-invokes production V1's own pure component scorers against
 * adapter-derived inputs from the SAME frozen snapshot, and compares the
 * result to whatever production actually recorded for that candidate at
 * build time. A mismatch means the frozen snapshot's evidence has silently
 * diverged from what production actually saw — never thrown, only
 * reported, exactly like Plate's [PLATE_CHAMPION_PARITY_MISMATCH] check.
 */
export function checkMoundV1Parity(
  frozen: FrozenMoundInput,
  productionComponentScores: MoundV1ComponentScores,
): MoundV1ParityResult {
  const mismatches: string[] = [];

  const workload = computeWorkload(toWorkloadInputsV1(frozen));
  const pitcherSkill = computePitcherSkill(toPitcherSkillInputsV1(frozen));
  const opponentKProfile = computeOpponentKProfile(toOpponentKProfileInputsV1(frozen));

  if (
    productionComponentScores.workloadScore != null &&
    Math.abs(workload.score10 - productionComponentScores.workloadScore) > PARITY_TOLERANCE
  ) {
    mismatches.push(
      `workloadScore: frozen-derived ${workload.score10} vs production ${productionComponentScores.workloadScore}`,
    );
  }
  if (
    productionComponentScores.pitcherSkillScore != null &&
    Math.abs(pitcherSkill.score10 - productionComponentScores.pitcherSkillScore) > PARITY_TOLERANCE
  ) {
    mismatches.push(
      `pitcherSkillScore: frozen-derived ${pitcherSkill.score10} vs production ${productionComponentScores.pitcherSkillScore}`,
    );
  }
  if (
    productionComponentScores.opponentKProfileScore != null &&
    Math.abs(opponentKProfile.score10 - productionComponentScores.opponentKProfileScore) > PARITY_TOLERANCE
  ) {
    mismatches.push(
      `opponentKProfileScore: frozen-derived ${opponentKProfile.score10} vs production ${productionComponentScores.opponentKProfileScore}`,
    );
  }

  return { matches: mismatches.length === 0, mismatches };
}
