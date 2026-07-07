// Mound Radar Component — Opponent K Profile (weight 0.20).
//
// v1 real signal: Platoon K Advantage, derived from the pitcher's own
// strikeout rate split by opposing-batter handedness (fetchPitcherHandednessSplits'
// kRateVsLHB/kRateVsRHB extension) weighted by the confirmed opposing lineup's
// L/R/S composition (roster data — generic, not hitter scoring).
//
// Opponent High K%, Opponent Chase/Whiff Weakness, Lineup K Density, and
// Bottom-Third K Pocket all require a per-batter season K%/plate-discipline
// aggregate that has no data source anywhere in the codebase today — they
// render `available:false` in v1 rather than being fabricated.

import type { ComponentScore, MoundDriver } from "./types";
import { lin, weightedAvg, round1, weightedPlatoonKRate } from "./scoreUtils";

export interface OpponentKProfileInputs {
  pitcherKnown: boolean;
  opposingLineupConfirmed: boolean;
  kRateVsLHB: number | null;
  kRateVsRHB: number | null;
  /** Confirmed opposing lineup handedness composition (from roster reads). */
  opposingLineupHandedness: { left: number; right: number; switchHit: number } | null;
}

export function computeOpponentKProfile(inputs: OpponentKProfileInputs): ComponentScore {
  const drivers: MoundDriver[] = [];
  const warnings: string[] = [];

  if (!inputs.pitcherKnown) {
    warnings.push("Probable starter unknown");
    return { score10: 5, available: false, drivers, warnings };
  }

  const platoonKRate = inputs.opposingLineupConfirmed
    ? weightedPlatoonKRate(inputs.kRateVsLHB, inputs.kRateVsRHB, inputs.opposingLineupHandedness)
    : null;

  const sPlatoon = platoonKRate != null ? lin(platoonKRate, 0.18, 0.32) : null;

  const { score, coverage } = weightedAvg([{ value: sPlatoon, weight: 1 }]);

  if (coverage === 0) {
    warnings.push("No opponent K-profile data available");
    return { score10: 5, available: false, drivers, warnings };
  }

  if (sPlatoon != null && sPlatoon >= 7) {
    drivers.push({
      key: "okp_platoon",
      label: "Platoon K Advantage",
      direction: "positive",
      weight: Math.round(sPlatoon * 10),
      evidence: `Lineup-weighted K rate ${round1((platoonKRate ?? 0) * 100)}%`,
    });
  }

  return { score10: round1(score), available: true, drivers, warnings };
}
