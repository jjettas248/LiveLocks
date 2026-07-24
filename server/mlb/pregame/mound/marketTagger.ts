// Mound Radar — market classification (weight 0 on score10, tagging only).
//
// Chooses pitcher_strikeouts vs pitcher_outs as the primary market by
// comparing K-market strength (pitcherSkill + opponentKProfile) against
// Outs-market strength (workload). Mirrors Plate's marketTagger.ts role, no
// shared code.
//
// Also stamps kStuffScore/kStuffLabel (pure pitcher skill) and the historical
// `platoonKFit*` fields, whose user-facing label remains "K Matchup". The K
// matchup now includes BOTH pitcher handedness K tendency and the confirmed
// opposing hitters' K propensity vs the starter's throwing hand, so it must no
// longer claim a weak read is specifically a "poor handedness fit".

import type { MoundMarket, MoundMarketSetup } from "./types";
import { round1 } from "./scoreUtils";

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
  kStuffScore: number;
  kStuffLabel: "Elite" | "Strong" | "Solid" | "Weak";
  platoonKFitScore: number;
  platoonKFitLabel: "Elite" | "Strong" | "Solid" | "Weak";
  /** Legacy field retained for payload compatibility. Null because K Matchup is no longer a handedness-only read. */
  platoonKFitReason?: "poor handedness fit" | null;
}

export function marketSetupLabel(score10: number): "Elite" | "Strong" | "Solid" | "Weak" {
  if (score10 >= 8.5) return "Elite";
  if (score10 >= 7.5) return "Strong";
  if (score10 >= 5.5) return "Solid";
  return "Weak";
}

// Distinct from marketSetupLabel's boundaries. The opponent K-profile score is
// centered below 5 at a league-average matchup, so an ordinary matchup belongs
// in Solid rather than being flattened into the same Weak bucket as a true
// contact-heavy suppression matchup.
export function platoonKFitLabel(score10: number): "Elite" | "Strong" | "Solid" | "Weak" {
  if (score10 >= 8.0) return "Elite";
  if (score10 >= 6.5) return "Strong";
  if (score10 > 3.0) return "Solid";
  return "Weak";
}

export function computeMarketTags(inputs: MarketTagInputs): MarketTagResult {
  const kScore = inputs.pitcherSkillScore * 0.6 + inputs.opponentKProfileScore * 0.4;
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

  const kStuffScore = round1(inputs.pitcherSkillScore);
  const kStuffLabel = marketSetupLabel(inputs.pitcherSkillScore);

  const platoonKFitScore = round1(inputs.opponentKProfileScore);
  const platoonKFitLabelValue = platoonKFitLabel(inputs.opponentKProfileScore);

  return {
    primaryMarket,
    marketTags: ["pitcher_strikeouts", "pitcher_outs"],
    marketScores,
    marketSetups,
    kStuffScore,
    kStuffLabel,
    platoonKFitScore,
    platoonKFitLabel: platoonKFitLabelValue,
    platoonKFitReason: null,
  };
}
