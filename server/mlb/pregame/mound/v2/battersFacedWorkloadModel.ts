// Mound Radar V2 (shadow) — batters-faced workload distribution.
//
// Produces ONLY the batters-faced marginal now. Outs recorded is no longer
// an independently-parameterized negative binomial (that allowed incoherent
// joint states, e.g. an outs realization inconsistent with the same start's
// batters-faced realization) — it is derived, per plate appearance, from
// this SAME batters-faced distribution via the joint strikeout/outs process
// in moundV2Math.ts, driven from moundV2Engine.ts. See that engine's header
// for why outs and strikeouts must come from one coherent process rather
// than two independent ones.
//
// No per-pitcher batting-average/OBP-against data source exists anywhere in
// this codebase (confirmed against pitcherSkill.ts/workload.ts's own input
// sets) — LEAGUE_AVG_BATTERS_PER_INNING and LEAGUE_NON_K_OUT_RATE stay
// single documented league constants rather than fabricated precise
// per-pitcher figures, exactly the same discipline matchupAdjustedKs.ts
// already applies to its own "no K-specific park factor exists" nudge.

import { negativeBinomialPmf } from "./moundV2Math";
import { clamp } from "../scoreUtils";
import type { MoundV2WorkloadInputs } from "./moundV2Types";

const LEAGUE_AVG_BATTERS_PER_INNING = 4.3;
const DEFAULT_AVG_INNINGS = 5.2;
const DEFAULT_INNINGS_STD = 1.5;
const MIN_INNINGS_STD = 0.5;
const MAX_BATTERS_FACED_SUPPORT = 42;

// Modern-era league-average rates: K% ~22.5%, non-K plate appearances end in
// an out (groundout/flyout/lineout/etc., as opposed to a hit/walk/HBP) about
// 61% of the time (derived from ~27 outs recorded across ~38.7 team PAs per
// game, net of the strikeout share — see this module's PR notes). A single
// documented league constant, not a fabricated per-pitcher batted-ball rate.
const LEAGUE_NON_K_OUT_RATE = 0.61;
const LEAGUE_AVG_BB_PER_9 = 3.1;

export interface WorkloadDistributions {
  battersFacedPmf: number[];
  expectedBattersFaced: number;
  /** Per-PA probability that a NON-strikeout plate appearance still results in an out — feeds the joint strikeout/outs process in moundV2Engine.ts. Adjusted (bounded) by the pitcher's own walk rate: a more walk-prone pitcher's non-strikeout PAs skew somewhat more toward walks than balls in play. */
  nonStrikeoutOutRate: number;
  /** False when the pitcher's own avgInningsPerStart is unavailable — DEFAULT_AVG_INNINGS is used as a neutral fallback rather than fabricating a confident number. */
  dataAvailable: boolean;
}

function nonStrikeoutOutRateForPitcher(bbPer9: number | null): number {
  if (bbPer9 == null) return LEAGUE_NON_K_OUT_RATE;
  const delta = (LEAGUE_AVG_BB_PER_9 - bbPer9) * 0.02;
  return clamp(LEAGUE_NON_K_OUT_RATE + delta, 0.45, 0.7);
}

export function computeWorkloadDistributions(inputs: MoundV2WorkloadInputs): WorkloadDistributions {
  const dataAvailable = inputs.avgInningsPerStart != null;
  const avgInnings = inputs.avgInningsPerStart ?? DEFAULT_AVG_INNINGS;

  const inningsStd =
    inputs.ipVarianceLast3 != null
      ? Math.max(Math.sqrt(inputs.ipVarianceLast3), MIN_INNINGS_STD)
      : DEFAULT_INNINGS_STD;

  // Pitch-count efficiency and walk rate both nudge expected workload DOWN
  // when elevated (a quicker hook) — the same two real signals workload.ts's
  // score10 component already reads, applied here as a bounded multiplicative
  // adjustment to the workload mean rather than a new fabricated input.
  const pitchesPerInning =
    inputs.lastStartPitchCount != null && inputs.lastStartInningsPitched != null && inputs.lastStartInningsPitched > 0
      ? inputs.lastStartPitchCount / inputs.lastStartInningsPitched
      : null;
  const efficiencyAdjustment = pitchesPerInning != null ? clamp(1 - (pitchesPerInning - 16) * 0.012, 0.88, 1.05) : 1;
  const walkAdjustment = inputs.bbPer9 != null ? clamp(1 - (inputs.bbPer9 - 3.0) * 0.02, 0.88, 1.05) : 1;

  const adjustedAvgInnings = Math.max(0.1, avgInnings * efficiencyAdjustment * walkAdjustment);

  const expectedBattersFaced = adjustedAvgInnings * LEAGUE_AVG_BATTERS_PER_INNING;
  const battersFacedVariance = (inningsStd * LEAGUE_AVG_BATTERS_PER_INNING) ** 2;
  const maxBattersFaced = Math.min(MAX_BATTERS_FACED_SUPPORT, Math.ceil(expectedBattersFaced + 8 * Math.sqrt(battersFacedVariance)) + 3);
  const battersFacedPmf = negativeBinomialPmf(expectedBattersFaced, battersFacedVariance, maxBattersFaced);

  return {
    battersFacedPmf,
    expectedBattersFaced,
    nonStrikeoutOutRate: nonStrikeoutOutRateForPitcher(inputs.bbPer9),
    dataAvailable,
  };
}
