// Mound Radar Component — Workload (weight 0.22).
//
// Feeds the "pitcher_outs" market. v1 real signals: season BB/9 (walk risk),
// season avg-innings-per-start (leash), last-start pitch count (efficiency
// proxy), last-3-start IP variance (stability) — all from dataPullService.ts
// extensions (syncPitcherSeasonStats.gamesStarted, fetchPitcherRecentStarts).
//
// Ground Ball Efficiency has no GB% data source anywhere in the codebase
// today — omitted from v1 rather than fabricated.

import type { ComponentScore, MoundDriver } from "./types";
import { lin, weightedAvg, round1 } from "./scoreUtils";
import type { MLBPitcherArchetype } from "../../archetypes";

export interface WorkloadInputs {
  pitcherKnown: boolean;
  bbPer9: number | null;
  avgInningsPerStart: number | null;
  lastStartPitchCount: number | null;
  ipVarianceLast3: number | null;
  archetype: MLBPitcherArchetype | null;
}

export function computeWorkload(inputs: WorkloadInputs): ComponentScore {
  const drivers: MoundDriver[] = [];
  const warnings: string[] = [];

  if (!inputs.pitcherKnown) {
    warnings.push("Probable starter unknown");
    return { score10: 5, available: false, drivers, warnings };
  }

  const sWalk = inputs.bbPer9 != null ? lin(inputs.bbPer9, 4.5, 1.5) : null;
  const sLeash = inputs.avgInningsPerStart != null ? lin(inputs.avgInningsPerStart, 4.5, 7.0) : null;

  const pitchesPerInning =
    inputs.lastStartPitchCount != null && inputs.avgInningsPerStart != null && inputs.avgInningsPerStart > 0
      ? inputs.lastStartPitchCount / inputs.avgInningsPerStart
      : null;
  const sEfficiency = pitchesPerInning != null ? lin(pitchesPerInning, 18, 13) : null;
  const sStability = inputs.ipVarianceLast3 != null ? lin(inputs.ipVarianceLast3, 2.5, 0.3) : null;

  const { score, coverage } = weightedAvg([
    { value: sWalk, weight: 3 },
    { value: sLeash, weight: 3 },
    { value: sEfficiency, weight: 2 },
    { value: sStability, weight: 2 },
  ]);

  if (coverage === 0) {
    warnings.push("No pitcher workload data available");
    return { score10: 5, available: false, drivers, warnings };
  }

  if (sLeash != null && sLeash >= 7) {
    drivers.push({
      key: "wl_leash",
      label: "Long Leash",
      direction: "positive",
      weight: Math.round(sLeash * 10),
      evidence: inputs.avgInningsPerStart != null ? `${round1(inputs.avgInningsPerStart)} IP/start avg` : undefined,
    });
  }
  if (sWalk != null && sWalk >= 7) {
    drivers.push({
      key: "wl_walk",
      label: "Low Walk Risk",
      direction: "positive",
      weight: Math.round(sWalk * 10),
      evidence: `BB/9 ${round1(inputs.bbPer9 ?? 0)}`,
    });
  }
  if (sEfficiency != null && sEfficiency >= 7) {
    drivers.push({ key: "wl_efficient", label: "Efficient Pitch Profile", direction: "positive", weight: Math.round(sEfficiency * 10) });
  }
  if (sStability != null && sStability >= 7) {
    drivers.push({ key: "wl_stability", label: "Recent IP Stability", direction: "positive", weight: Math.round(sStability * 10) });
  }
  if ((inputs.archetype === "ace" || inputs.archetype === "quality_starter") && sLeash != null && sLeash >= 6) {
    drivers.push({ key: "wl_trust", label: "Manager Trust/Starter Workload", direction: "positive", weight: 50 });
  }

  return { score10: round1(score), available: true, drivers, warnings };
}
