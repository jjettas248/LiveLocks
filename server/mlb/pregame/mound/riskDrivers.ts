// Mound Radar — Warning drivers assembly.
//
// Assembles the negative/caution driver chips + the numeric risk penalty
// subtracted from moundScore10. Mirrors how Plate folds scoring.warningTags
// into negative drivers inline in buildPregamePowerRadar.ts, but Mound's
// driver list is larger so it gets its own small pure module.
//
// Lineup Power Risk and Opponent Contact Risk require opponent-lineup
// aggregation that has no data source in v1 — omitted rather than fabricated.

import type { MoundDriver } from "./types";
import { round1 } from "./scoreUtils";
import type { MLBPitcherArchetype } from "../../archetypes";

export interface RiskDriverInputs {
  archetype: MLBPitcherArchetype | null;
  bbPer9: number | null;
  lastStartPitchCount: number | null;
  avgInningsPerStart: number | null;
  isIndoors: boolean;
  windMph: number | null;
  windDirection: "in" | "out" | "cross" | "calm" | null;
  opposingLineupConfirmed: boolean;
}

export interface RiskDriverResult {
  drivers: MoundDriver[];
  warnings: string[];
  riskPenalty: number;
}

const RISK_PENALTY_CAP = 2.5;

export function computeRiskDrivers(inputs: RiskDriverInputs): RiskDriverResult {
  const drivers: MoundDriver[] = [];
  const warnings: string[] = [];
  let penalty = 0;

  if (inputs.archetype === "volatile_arm") {
    drivers.push({ key: "risk_volatile", label: "Volatile Arm Warning", direction: "negative", weight: 70 });
    warnings.push("Volatile Arm Warning");
    penalty += 0.6;
  }
  if (inputs.archetype === "opener_bulk") {
    drivers.push({ key: "risk_opener", label: "Opener/Bulk Risk", direction: "negative", weight: 60 });
    warnings.push("Opener/Bulk Risk");
    penalty += 0.5;
  }
  if (inputs.bbPer9 != null && inputs.bbPer9 >= 4.0) {
    drivers.push({ key: "risk_walk", label: "Walk Risk", direction: "negative", weight: 50, evidence: `BB/9 ${round1(inputs.bbPer9)}` });
    warnings.push("Walk Risk");
    penalty += 0.4;
  }
  if (inputs.lastStartPitchCount != null && inputs.lastStartPitchCount >= 100) {
    drivers.push({ key: "risk_pitch_count", label: "Pitch Count Risk", direction: "negative", weight: 40, evidence: `${inputs.lastStartPitchCount} pitches last start` });
    warnings.push("Pitch Count Risk");
    penalty += 0.3;
  }
  if (inputs.avgInningsPerStart != null && inputs.avgInningsPerStart < 5.0) {
    drivers.push({ key: "risk_short_leash", label: "Short Leash Risk", direction: "negative", weight: 40, evidence: `${round1(inputs.avgInningsPerStart)} IP/start avg` });
    warnings.push("Short Leash Risk");
    penalty += 0.3;
  }
  if (!inputs.isIndoors && inputs.windMph != null && inputs.windMph >= 15 && inputs.windDirection === "out") {
    drivers.push({ key: "risk_weather", label: "Weather Risk", direction: "negative", weight: 40, evidence: `${inputs.windMph}mph wind out` });
    warnings.push("Weather Risk");
    penalty += 0.3;
  }
  if (!inputs.opposingLineupConfirmed) {
    drivers.push({ key: "risk_unconfirmed_lineup", label: "Unconfirmed Lineup Warning", direction: "negative", weight: 30 });
    warnings.push("Unconfirmed Lineup Warning");
    penalty += 0.2;
  }

  return { drivers, warnings, riskPenalty: round1(Math.min(penalty, RISK_PENALTY_CAP)) };
}
