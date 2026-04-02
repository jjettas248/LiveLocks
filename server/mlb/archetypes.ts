import type { MLBMarket } from "./types";

export type MLBBatterArchetype =
  | "elite_contact"
  | "power_first"
  | "stable_regular"
  | "contact_specialist"
  | "platoon_hitter"
  | "hot_streak"
  | "cold_streak"
  | "limited_sample";

export type MLBPitcherArchetype =
  | "ace"
  | "quality_starter"
  | "mid_rotation"
  | "back_end"
  | "opener_bulk"
  | "volatile_arm";

export interface MLBBatterArchetypeInput {
  xBA: number | null;
  barrelRate: number | null;
  exitVelocity: number | null;
  battingOrderSlot: number;
  seasonPA: number;
  seasonOPS: number | null;
  last7OPS: number | null;
  last15OPS: number | null;
  platoonGap: number | null;
  isStarting: boolean;
}

export interface MLBPitcherArchetypeInput {
  era: number | null;
  whip: number | null;
  kPer9: number | null;
  inningsPitched: number | null;
  gamesStarted: number | null;
  avgInningsPerStart: number | null;
}

export function classifyBatterArchetype(input: MLBBatterArchetypeInput): MLBBatterArchetype {
  if (input.seasonPA < 50) return "limited_sample";

  if (input.last7OPS != null && input.seasonOPS != null && input.seasonOPS > 0) {
    const opsGap = input.last7OPS - input.seasonOPS;
    if (opsGap >= 0.200) return "hot_streak";
    if (opsGap <= -0.200) return "cold_streak";
  }

  if (input.platoonGap != null && input.platoonGap >= 0.080) return "platoon_hitter";

  const xBA = input.xBA ?? 0.250;
  const barrel = input.barrelRate ?? 0.05;
  const ev = input.exitVelocity ?? 88;

  if (xBA >= 0.300 && ev >= 90 && input.battingOrderSlot <= 3) return "elite_contact";
  if (xBA < 0.260 && barrel >= 0.15) return "power_first";
  if (barrel >= 0.12 && ev >= 91) return "power_first";
  if (xBA >= 0.290 && barrel < 0.08) return "contact_specialist";
  if (xBA >= 0.260 && xBA < 0.300) return "stable_regular";

  return "stable_regular";
}

export function classifyPitcherArchetype(input: MLBPitcherArchetypeInput): MLBPitcherArchetype {
  const avgIP = input.avgInningsPerStart ?? (
    input.inningsPitched != null && input.gamesStarted != null && input.gamesStarted > 0
      ? input.inningsPitched / input.gamesStarted
      : 5.0
  );

  if (avgIP < 4) return "opener_bulk";

  const era = input.era ?? 4.50;
  const kPer9 = input.kPer9 ?? 7.0;
  const ip = input.inningsPitched ?? 0;
  const gs = input.gamesStarted ?? 0;
  const ipPace = gs > 0 ? (ip / gs) * 32 : 0;

  if (era < 3.00 && kPer9 > 10 && ipPace >= 180) return "ace";
  if (era < 3.00 && kPer9 > 9) return "ace";
  if (era >= 3.00 && era < 3.80) return "quality_starter";
  if (era >= 3.80 && era < 4.50) return "mid_rotation";
  if (era >= 4.50) return "back_end";

  return "mid_rotation";
}

export const MLB_VARIANCE_MULTIPLIERS: Record<MLBBatterArchetype, number> = {
  elite_contact: 0.95,
  power_first: 1.10,
  stable_regular: 1.00,
  contact_specialist: 0.90,
  platoon_hitter: 1.20,
  hot_streak: 0.95,
  cold_streak: 1.25,
  limited_sample: 1.40,
};

export const MLB_PA_FRAGILITY: Record<MLBBatterArchetype, number> = {
  elite_contact: 1.00,
  power_first: 1.05,
  stable_regular: 1.00,
  contact_specialist: 1.00,
  platoon_hitter: 1.15,
  hot_streak: 1.00,
  cold_streak: 1.10,
  limited_sample: 1.30,
};

export const PITCHER_SUPPRESSION_CONFIDENCE: Record<MLBPitcherArchetype, number> = {
  ace: 1.00,
  quality_starter: 0.85,
  mid_rotation: 0.65,
  back_end: 0.45,
  opener_bulk: 0.30,
  volatile_arm: 0.50,
};

export const PITCHER_DETERIORATION_ONSET: Record<MLBPitcherArchetype, number> = {
  ace: 85,
  quality_starter: 80,
  mid_rotation: 70,
  back_end: 60,
  opener_bulk: 40,
  volatile_arm: 65,
};

export const MARKET_VOLATILITY: Record<MLBMarket, "low" | "mid" | "high"> = {
  hits: "low",
  pitcher_strikeouts: "low",
  total_bases: "mid",
  batter_strikeouts: "mid",
  pitcher_outs: "mid",
  hits_allowed: "mid",
  home_runs: "high",
  hrr: "high",
  walks_allowed: "high",
  hr_allowed: "high",
};

const CALIBRATION_SHRINKAGE: Record<string, number> = {
  "elite_contact+low": 0.94,
  "elite_contact+mid": 0.90,
  "elite_contact+high": 0.82,
  "power_first+low": 0.88,
  "power_first+mid": 0.90,
  "power_first+high": 0.85,
  "stable_regular+low": 0.92,
  "stable_regular+mid": 0.88,
  "stable_regular+high": 0.80,
  "contact_specialist+low": 0.94,
  "contact_specialist+mid": 0.85,
  "contact_specialist+high": 0.70,
  "platoon_hitter+low": 0.86,
  "platoon_hitter+mid": 0.82,
  "platoon_hitter+high": 0.72,
  "hot_streak+low": 0.92,
  "hot_streak+mid": 0.88,
  "hot_streak+high": 0.80,
  "cold_streak+low": 0.84,
  "cold_streak+mid": 0.80,
  "cold_streak+high": 0.72,
  "limited_sample+low": 0.78,
  "limited_sample+mid": 0.74,
  "limited_sample+high": 0.68,
};

const PITCHER_CALIBRATION_SHRINKAGE: Record<string, number> = {
  "ace+low": 0.94,
  "ace+mid": 0.90,
  "ace+high": 0.85,
  "quality_starter+low": 0.90,
  "quality_starter+mid": 0.86,
  "quality_starter+high": 0.80,
  "mid_rotation+low": 0.86,
  "mid_rotation+mid": 0.82,
  "mid_rotation+high": 0.76,
  "back_end+low": 0.80,
  "back_end+mid": 0.76,
  "back_end+high": 0.70,
  "opener_bulk+low": 0.74,
  "opener_bulk+mid": 0.70,
  "opener_bulk+high": 0.65,
  "volatile_arm+low": 0.78,
  "volatile_arm+mid": 0.74,
  "volatile_arm+high": 0.68,
};

export function getCalibrationShrinkage(
  archetype: MLBBatterArchetype | MLBPitcherArchetype,
  market: MLBMarket,
  isPitcherMarket: boolean
): number {
  const volatility = MARKET_VOLATILITY[market] ?? "mid";
  const key = `${archetype}+${volatility}`;
  if (isPitcherMarket) {
    return PITCHER_CALIBRATION_SHRINKAGE[key] ?? 0.82;
  }
  return CALIBRATION_SHRINKAGE[key] ?? 0.88;
}

const MLB_SAFETY_CEILINGS: Record<string, number> = {
  "elite_contact+hits": 96,
  "elite_contact+total_bases": 94,
  "elite_contact+home_runs": 80,
  "elite_contact+hrr": 92,
  "elite_contact+batter_strikeouts": 88,
  "power_first+hits": 90,
  "power_first+total_bases": 94,
  "power_first+home_runs": 82,
  "power_first+hrr": 92,
  "power_first+batter_strikeouts": 85,
  "stable_regular+hits": 92,
  "stable_regular+total_bases": 90,
  "stable_regular+home_runs": 78,
  "stable_regular+hrr": 88,
  "stable_regular+batter_strikeouts": 85,
  "contact_specialist+hits": 96,
  "contact_specialist+total_bases": 88,
  "contact_specialist+home_runs": 65,
  "contact_specialist+hrr": 85,
  "contact_specialist+batter_strikeouts": 90,
  "platoon_hitter+hits": 90,
  "platoon_hitter+total_bases": 88,
  "platoon_hitter+home_runs": 75,
  "platoon_hitter+hrr": 85,
  "platoon_hitter+batter_strikeouts": 85,
  "platoon_hitter_wrong+hits": 75,
  "platoon_hitter_wrong+home_runs": 60,
  "platoon_hitter_wrong+total_bases": 72,
  "platoon_hitter_wrong+hrr": 70,
  "hot_streak+hits": 94,
  "hot_streak+total_bases": 92,
  "hot_streak+home_runs": 82,
  "hot_streak+hrr": 90,
  "hot_streak+batter_strikeouts": 85,
  "cold_streak+hits": 85,
  "cold_streak+total_bases": 82,
  "cold_streak+home_runs": 72,
  "cold_streak+hrr": 80,
  "cold_streak+batter_strikeouts": 88,
  "limited_sample+hits": 80,
  "limited_sample+total_bases": 78,
  "limited_sample+home_runs": 65,
  "limited_sample+hrr": 75,
  "limited_sample+batter_strikeouts": 78,
  "ace+pitcher_strikeouts": 96,
  "ace+pitcher_outs": 90,
  "ace+hits_allowed": 92,
  "ace+walks_allowed": 88,
  "ace+hr_allowed": 82,
  "quality_starter+pitcher_strikeouts": 92,
  "quality_starter+pitcher_outs": 88,
  "quality_starter+hits_allowed": 88,
  "quality_starter+walks_allowed": 85,
  "quality_starter+hr_allowed": 78,
  "mid_rotation+pitcher_strikeouts": 88,
  "mid_rotation+pitcher_outs": 85,
  "mid_rotation+hits_allowed": 85,
  "mid_rotation+walks_allowed": 82,
  "mid_rotation+hr_allowed": 75,
  "back_end+pitcher_strikeouts": 82,
  "back_end+pitcher_outs": 80,
  "back_end+hits_allowed": 80,
  "back_end+walks_allowed": 78,
  "back_end+hr_allowed": 70,
  "opener_bulk+pitcher_strikeouts": 75,
  "opener_bulk+pitcher_outs": 72,
  "opener_bulk+hits_allowed": 75,
  "opener_bulk+walks_allowed": 72,
  "opener_bulk+hr_allowed": 65,
  "volatile_arm+pitcher_strikeouts": 80,
  "volatile_arm+pitcher_outs": 78,
  "volatile_arm+hits_allowed": 78,
  "volatile_arm+walks_allowed": 75,
  "volatile_arm+hr_allowed": 70,
};

export function getMLBSafetyCeiling(
  archetype: MLBBatterArchetype | MLBPitcherArchetype,
  market: MLBMarket
): number {
  const key = `${archetype}+${market}`;
  return MLB_SAFETY_CEILINGS[key] ?? 75;
}

export function generateThesis(
  batterArchetype: MLBBatterArchetype | null,
  pitcherArchetype: MLBPitcherArchetype | null,
  market: MLBMarket,
  side: "OVER" | "UNDER",
  triggers: string[],
  parkFactor: number,
  bvpAvg: number | null,
  formIndicator: string | null,
  pitchCount: number,
  timesThrough: number,
  windDirection: string | null
): string {
  const parts: string[] = [];

  if (batterArchetype) {
    if (batterArchetype === "limited_sample") {
      const mktContext: Record<string, string> = {
        hits: "projecting hit upside",
        total_bases: "projecting base production",
        home_runs: "targeting HR potential",
        batter_strikeouts: "modeling K exposure",
        hrr: "projecting H+R+RBI combo",
      };
      const sideContext = side === "UNDER" ? "suppression lean" : (mktContext[market] ?? "early-season model lean");
      parts.push(sideContext);
    } else {
      const archetypeLabel: Record<string, string> = {
        elite_contact: "Elite contact profile",
        power_first: "Power-first bat",
        stable_regular: "Consistent regular starter",
        contact_specialist: "Contact specialist",
        platoon_hitter: "Platoon matchup edge",
        hot_streak: "Hot streak active",
        cold_streak: "Cold streak drag",
      };
      if (archetypeLabel[batterArchetype]) parts.push(archetypeLabel[batterArchetype]);
    }
  }

  if (pitcherArchetype) {
    const pitcherLabel: Partial<Record<MLBPitcherArchetype, string>> = {
      ace: "facing ace-caliber arm",
      back_end: "favorable pitcher matchup",
      opener_bulk: "bullpen game — volatile",
      volatile_arm: "inconsistent pitcher",
    };
    if (pitcherLabel[pitcherArchetype]) parts.push(pitcherLabel[pitcherArchetype]);
  }

  if (bvpAvg != null && bvpAvg >= 0.300) {
    parts.push(`strong BvP history (.${Math.round(bvpAvg * 1000)})`);
  }

  if (formIndicator === "HOT" || formIndicator === "WARM") {
    parts.push("riding hot form");
  } else if (formIndicator === "COLD" || formIndicator === "ICE") {
    parts.push("cold form limits upside");
  }

  if (pitchCount >= 85) {
    parts.push(`pitcher fatigued at ${pitchCount} pitches`);
  } else if (timesThrough >= 3) {
    parts.push("third time through order");
  }

  if (parkFactor >= 1.08) {
    parts.push("hitter-friendly park");
  } else if (parkFactor <= 0.92) {
    parts.push("pitcher-friendly park");
  }

  if (windDirection === "out") {
    parts.push("wind out to center");
  } else if (windDirection === "in") {
    parts.push("wind blowing in");
  }

  if (parts.length === 0) {
    parts.push("Model projection based on current game state");
  }

  return parts.join(" + ");
}

export const BATTER_ARCHETYPE_LABELS: Record<MLBBatterArchetype, string> = {
  elite_contact: "ELITE CONTACT",
  power_first: "POWER",
  stable_regular: "REGULAR",
  contact_specialist: "CONTACT",
  platoon_hitter: "PLATOON",
  hot_streak: "HOT",
  cold_streak: "COLD",
  limited_sample: "LIMITED",
};

export const PITCHER_ARCHETYPE_LABELS: Record<MLBPitcherArchetype, string> = {
  ace: "ACE",
  quality_starter: "QS",
  mid_rotation: "MID",
  back_end: "BACK END",
  opener_bulk: "OPENER",
  volatile_arm: "VOLATILE",
};
