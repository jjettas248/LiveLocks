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
import { lin, weightedAvg, round1 } from "./scoreUtils";

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

  const comp = inputs.opposingLineupHandedness;
  let platoonKRate: number | null = null;
  if (comp && inputs.opposingLineupConfirmed && (inputs.kRateVsLHB != null || inputs.kRateVsRHB != null)) {
    const total = comp.left + comp.right + comp.switchHit;
    if (total > 0) {
      // Switch hitters bat opposite the pitcher's throwing hand in aggregate —
      // approximate with a 50/50 split across the two known rates when both exist.
      const lWeight = comp.left + comp.switchHit / 2;
      const rWeight = comp.right + comp.switchHit / 2;
      const lRate = inputs.kRateVsLHB;
      const rRate = inputs.kRateVsRHB;
      if (lRate != null && rRate != null) {
        platoonKRate = (lRate * lWeight + rRate * rWeight) / total;
      } else {
        platoonKRate = lRate ?? rRate;
      }
    }
  }

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
