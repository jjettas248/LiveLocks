// Component 5 — Lineup Opportunity (weight 0.09).
//
// Pure scorer. Batting slot is OPPORTUNITY context (plate-appearance volume,
// run environment, RBI setup) — NOT "pitcher weakness to slot" (that has no
// real data feed and is opponent-quality biased; excluded from scoring).

import type { ComponentScore, PowerDriver } from "./types";
import { lin, weightedAvg, round1 } from "./scoreUtils";

export interface LineupOpportunityInputs {
  battingOrderSlot: number | null; // 1–9
  /** Team implied run total (from odds), when available. */
  teamImpliedRuns: number | null;
  /** OBP of the hitters batting ahead, when available. */
  obpAhead: number | null;
}

export function computeLineupOpportunity(inputs: LineupOpportunityInputs): ComponentScore {
  const drivers: PowerDriver[] = [];
  const warnings: string[] = [];

  // PA volume by slot: top of order gets more PAs over a game.
  let sVolume: number | null = null;
  const slot = inputs.battingOrderSlot;
  if (slot != null && slot >= 1 && slot <= 9) {
    // 1–2 highest volume, decreasing to 9.
    sVolume = lin(10 - slot, 1, 9); // slot 1 -> 10, slot 9 -> ~1
    if (slot <= 2) drivers.push({ key: "lo_top", label: "Top-of-Order Volume", direction: "positive", weight: 60, evidence: `bats ${slot}` });
    if (slot >= 3 && slot <= 5) drivers.push({ key: "lo_rbi", label: "Run-Producing Slot", direction: "positive", weight: 50, evidence: `bats ${slot}` });
    if (slot >= 8) drivers.push({ key: "lo_bottom", label: "Bottom-of-Order Volume", direction: "negative", weight: 25, evidence: `bats ${slot}` });
  } else {
    warnings.push("Batting slot unknown");
  }

  const sRunEnv = inputs.teamImpliedRuns != null ? lin(inputs.teamImpliedRuns, 3.2, 6.0) : null;
  if (sRunEnv != null && sRunEnv >= 7) {
    drivers.push({ key: "lo_runenv", label: "High Team Run Total", direction: "positive", weight: Math.round(sRunEnv * 10), evidence: `${inputs.teamImpliedRuns} implied` });
  }
  const sObpAhead = inputs.obpAhead != null ? lin(inputs.obpAhead, 0.29, 0.37) : null;
  if (sObpAhead != null && sObpAhead >= 7) {
    drivers.push({ key: "lo_obp_ahead", label: "Traffic Ahead (High OBP)", direction: "positive", weight: Math.round(sObpAhead * 10) });
  }

  const { score, coverage } = weightedAvg([
    { value: sVolume, weight: 3 },
    { value: sRunEnv, weight: 2 },
    { value: sObpAhead, weight: 1 },
  ]);

  if (coverage === 0) {
    return { score10: 5, available: false, drivers, warnings };
  }

  return { score10: round1(score), available: true, drivers, warnings };
}
