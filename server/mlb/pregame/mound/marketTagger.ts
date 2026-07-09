// Mound Radar — market classification (weight 0 on score10, tagging only).
//
// Chooses pitcher_strikeouts vs pitcher_outs as the primary market by
// comparing K-market strength (pitcherSkill + opponentKProfile) against
// Outs-market strength (workload). Mirrors Plate's marketTagger.ts role, no
// shared code.
//
// Also stamps kStuffScore/kStuffLabel (pure pitcher skill) and
// platoonKFitScore/platoonKFitLabel (pure platoon-matchup fit) so the UI can
// show each independently instead of only the blended kScore — a pitcher can
// have elite skill and only an average matchup, and the old single blended
// badge collapsed that into a single misleading "Weak" grade. See
// buildMlbMoundRadar.ts and MoundPowerRadar.tsx for how these are surfaced.

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
  platoonKFitReason?: "poor handedness fit" | null;
}

// Four grades — Elite/Strong/Solid/Weak. "Solid" is the full middle band
// (5.5-7.49) so an ordinary-but-real setup (e.g. 6.8) doesn't flatten to the
// same "Weak" as a genuinely poor one (e.g. 2.0).
export function marketSetupLabel(score10: number): "Elite" | "Strong" | "Solid" | "Weak" {
  if (score10 >= 8.5) return "Elite";
  if (score10 >= 7.5) return "Strong";
  if (score10 >= 5.5) return "Solid";
  return "Weak";
}

// Distinct from marketSetupLabel's boundaries — opponentKProfileScore's lin()
// scale (opponentKProfile.ts) places true league-average platoon performance
// well below the scale midpoint (~2.9-4.2/10, see scoring.ts's own comment),
// so applying marketSetupLabel's 8.5/7.5/5.5 boundaries verbatim would
// flatten nearly every ordinary matchup to "Weak" — recreating the exact
// flattening bug this split exists to fix. An ordinary/league-average
// matchup (and the flat-5 unconfirmed-lineup default) must land in "Solid",
// the neutral case, not "Weak".
export function platoonKFitLabel(score10: number): "Elite" | "Strong" | "Solid" | "Weak" {
  if (score10 >= 8.0) return "Elite";
  if (score10 >= 6.5) return "Strong";
  if (score10 > 3.0) return "Solid";
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

  const kStuffScore = round1(inputs.pitcherSkillScore);
  const kStuffLabel = marketSetupLabel(inputs.pitcherSkillScore);

  const platoonKFitScore = round1(inputs.opponentKProfileScore);
  const platoonKFitLabelValue = platoonKFitLabel(inputs.opponentKProfileScore);
  const platoonKFitReason: "poor handedness fit" | null = platoonKFitLabelValue === "Weak" ? "poor handedness fit" : null;

  return {
    primaryMarket,
    marketTags: ["pitcher_strikeouts", "pitcher_outs"],
    marketScores,
    marketSetups,
    kStuffScore,
    kStuffLabel,
    platoonKFitScore,
    platoonKFitLabel: platoonKFitLabelValue,
    platoonKFitReason,
  };
}
