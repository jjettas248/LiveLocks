// Mound Radar Component — Pitcher Skill (weight 0.28).
//
// v1 real signal: season K/9 (real, syncPitcherSeasonStats). SwStr%/CSW%/
// pitch-mix-misses-bats have no data source in the codebase today (would
// require extending the Savant per-pitch pitcher CSV fetch) — they render
// `available:false` in v1 rather than being fabricated. Follow-up work can
// wire them in without touching this component's shape.
//
// Independent from pregamePowerRadar/batterPowerProfile.ts — no shared
// weights, no shared driver logic.

import type { ComponentScore, MoundDriver } from "./types";
import { lin, weightedAvg, round1 } from "./scoreUtils";

export interface PitcherSkillInputs {
  pitcherKnown: boolean;
  kPer9: number | null;
  // Reserved for a future Savant-CSV extension — always null in v1.
  swStrPct?: number | null;
  cswPct?: number | null;
}

export function computePitcherSkill(inputs: PitcherSkillInputs): ComponentScore {
  const drivers: MoundDriver[] = [];
  const warnings: string[] = [];

  if (!inputs.pitcherKnown) {
    warnings.push("Probable starter unknown");
    return { score10: 5, available: false, drivers, warnings };
  }

  const sK = inputs.kPer9 != null ? lin(inputs.kPer9, 6.0, 12.5) : null;
  const sSwStr = inputs.swStrPct != null ? lin(inputs.swStrPct, 8, 16) : null;
  const sCsw = inputs.cswPct != null ? lin(inputs.cswPct, 26, 34) : null;

  const { score, coverage } = weightedAvg([
    { value: sK, weight: 5 },
    { value: sSwStr, weight: 3 },
    { value: sCsw, weight: 2 },
  ]);

  if (coverage === 0) {
    warnings.push("No pitcher skill data available");
    return { score10: 5, available: false, drivers, warnings };
  }

  if (sK != null && sK >= 7) {
    drivers.push({
      key: "ps_k9",
      label: "Pitcher High K%",
      direction: "positive",
      weight: Math.round(sK * 10),
      evidence: `K/9 ${round1(inputs.kPer9 ?? 0)}`,
    });
  }
  if (sSwStr != null && sSwStr >= 7) {
    drivers.push({ key: "ps_swstr", label: "Pitcher High SwStr%", direction: "positive", weight: Math.round(sSwStr * 10) });
  }
  if (sCsw != null && sCsw >= 7) {
    drivers.push({ key: "ps_csw", label: "Pitcher High CSW%", direction: "positive", weight: Math.round(sCsw * 10) });
  }
  if (sK != null && sK <= 3) {
    drivers.push({ key: "ps_low_k9", label: "Below-Average K Rate", direction: "negative", weight: 30, evidence: `K/9 ${round1(inputs.kPer9 ?? 0)}` });
  }

  return { score10: round1(score), available: true, drivers, warnings };
}
