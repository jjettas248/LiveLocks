// Mound Radar — market classification (weight 0 on score10, tagging only).
//
// Chooses pitcher_strikeouts vs pitcher_outs as the primary market by
// comparing K-market strength (pitcherSkill + opponentKProfile) against
// Outs-market strength (workload). Mirrors Plate's marketTagger.ts role, no
// shared code.

import type { MoundMarket, MoundMarketSetup } from "./types";

export interface MarketTagInputs {
  pitcherSkillScore: number;
  opponentKProfileScore: number;
  workloadScore: number;
}

export interface MarketTagResult {
  primaryMarket: MoundMarket;
  marketTags: MoundMarket[];
  marketScores: Partial<Record<MoundMarket, number>>;
  marketSetups: MoundMarketSetup[];
}

// Exactly three grades — no "Solid"/"Watch" middle ground. A pitcher's
// Ks-market or Outs-market setup is either a real Strong/Elite win
// candidate, or it's Weak. Below 7.0 is Weak, full stop.
export function marketSetupLabel(score10: number): "Elite" | "Strong" | "Weak" {
  if (score10 >= 8.5) return "Elite";
  if (score10 >= 7.0) return "Strong";
  return "Weak";
}

export function computeMarketTags(inputs: MarketTagInputs): MarketTagResult {
  const kScore = (inputs.pitcherSkillScore * 0.6 + inputs.opponentKProfileScore * 0.4);
  const outsScore = inputs.workloadScore;

  const primaryMarket: MoundMarket = kScore >= outsScore ? "pitcher_strikeouts" : "pitcher_outs";

  const marketScores: Partial<Record<MoundMarket, number>> = {
    pitcher_strikeouts: Math.round(kScore * 10) / 10,
    pitcher_outs: Math.round(outsScore * 10) / 10,
  };

  const marketSetups: MoundMarketSetup[] = [
    { market: "pitcher_strikeouts", setupScore: marketScores.pitcher_strikeouts!, setupLabel: marketSetupLabel(kScore), isPrimary: primaryMarket === "pitcher_strikeouts" },
    { market: "pitcher_outs", setupScore: marketScores.pitcher_outs!, setupLabel: marketSetupLabel(outsScore), isPrimary: primaryMarket === "pitcher_outs" },
  ];

  return {
    primaryMarket,
    marketTags: ["pitcher_strikeouts", "pitcher_outs"],
    marketScores,
    marketSetups,
  };
}
