// Mound Radar Component — Pitcher Skill (weight 0.28).
//
// v2: SwStr%/CSW%/Pitch Mix Misses Bats are now real, sourced from
// aggregatePitcherStuffMetrics() (server/mlb/dataSources.ts) over the same
// per-pitch Savant CSV already fetched for pitchMixPct/avgFastballVelocity —
// no new external integration, just a new aggregation over existing rows.
// Season K/9 remains the other real signal (syncPitcherSeasonStats). Each
// input independently degrades to unavailable (never fabricated) below its
// own sample floor — see aggregatePitcherStuffMetrics's MIN_* constants.
//
// Independent from pregamePowerRadar/batterPowerProfile.ts — no shared
// weights, no shared driver logic.

import type { ComponentScore, MoundDriver } from "./types";
import { lin, weightedAvg, round1 } from "./scoreUtils";

export interface PitcherSkillInputs {
  pitcherKnown: boolean;
  kPer9: number | null;
  swStrPct: number | null;
  cswPct: number | null;
  /** The single pitch family that both anchors the arsenal AND misses bats, if any. */
  missesBatsFamily: { family: "fastball" | "breaking" | "offspeed"; whiffPct: number; usagePct: number } | null;
}

const PITCH_FAMILY_LABEL: Record<"fastball" | "breaking" | "offspeed", string> = {
  fastball: "Fastball",
  breaking: "Breaking Ball",
  offspeed: "Offspeed",
};

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
    drivers.push({
      key: "ps_swstr",
      label: "Pitcher High SwStr%",
      direction: "positive",
      weight: Math.round(sSwStr * 10),
      evidence: `SwStr% ${round1(inputs.swStrPct ?? 0)}`,
    });
  }
  if (sCsw != null && sCsw >= 7) {
    drivers.push({
      key: "ps_csw",
      label: "Pitcher High CSW%",
      direction: "positive",
      weight: Math.round(sCsw * 10),
      evidence: `CSW% ${round1(inputs.cswPct ?? 0)}`,
    });
  }
  // Distinct from SwStr%/CSW% (season-wide rates) — this flags a SPECIFIC
  // pitch in the arsenal that's both heavily used and elite at missing bats,
  // which SwStr%/CSW% alone don't surface (a pitcher can have a mediocre
  // overall SwStr% while still having one true wipeout pitch).
  if (inputs.missesBatsFamily) {
    const { family, whiffPct, usagePct } = inputs.missesBatsFamily;
    drivers.push({
      key: "ps_misses_bats",
      label: "Pitch Mix Misses Bats",
      direction: "positive",
      weight: Math.round(whiffPct * 2),
      evidence: `${PITCH_FAMILY_LABEL[family]} — ${round1(whiffPct)}% whiff on ${round1(usagePct)}% usage`,
    });
  }
  if (sK != null && sK <= 3) {
    drivers.push({ key: "ps_low_k9", label: "Below-Average K Rate", direction: "negative", weight: 30, evidence: `K/9 ${round1(inputs.kPer9 ?? 0)}` });
  }

  return { score10: round1(score), available: true, drivers, warnings };
}
