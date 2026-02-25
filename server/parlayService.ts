import { ParlayPickInput, ParlayResult, CorrelationNote } from "@shared/schema";

export function calculateParlay(picks: ParlayPickInput[]): ParlayResult {
  if (picks.length === 0) {
    return {
      picks: [],
      combinedProbability: 0,
      correlationAdjustedProbability: 0,
      impliedAmericanOdds: 0,
      correlations: [],
    };
  }

  let combinedProbability = 1;
  let correlationMultiplier = 1;
  const correlations: CorrelationNote[] = [];

  // 1. Calculate base combined probability (assuming independence)
  picks.forEach((pick) => {
    combinedProbability *= pick.probability / 100;
  });

  // 2. Correlation Engine
  // Compare every pair of picks
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const p1 = picks[i];
      const p2 = picks[j];

      // Multi-game picks are independent (no adjustment)
      if (p1.gameId && p2.gameId && p1.gameId !== p2.gameId) {
        continue;
      }

      // Same Game Correlations
      if (p1.gameId && p2.gameId && p1.gameId === p2.gameId) {
        // Same Team
        if (p1.playerTeam === p2.playerTeam) {
          // One player assists + teammate points -> positive correlation
          const isP1Assist = p1.statType === "assists";
          const isP2Points = p2.statType === "points";
          const isP2Assist = p2.statType === "assists";
          const isP1Points = p1.statType === "points";

          if ((isP1Assist && isP2Points) || (isP2Assist && isP1Points)) {
            const multiplier = 1.08;
            correlationMultiplier *= multiplier;
            correlations.push({
              pick1: `${p1.playerName} (${p1.statType})`,
              pick2: `${p2.playerName} (${p2.statType})`,
              type: "positive",
              multiplier,
              explanation: "Assists + Points correlation: Teammates scoring often results from shared assists.",
            });
          }
          // Same team, both points/combos -> negative correlation (competing usage)
          else if (
            (p1.statType === "points" || p1.statType.includes("_")) &&
            (p2.statType === "points" || p2.statType.includes("_"))
          ) {
            const multiplier = 0.92;
            correlationMultiplier *= multiplier;
            correlations.push({
              pick1: `${p1.playerName} (${p1.statType})`,
              pick2: `${p2.playerName} (${p2.statType})`,
              type: "negative",
              multiplier,
              explanation: "Usage Competition: Teammates on the same team compete for shot attempts.",
            });
          }
        } 
        // Different Teams (Same Game)
        else {
          // Slight positive correlation (pace environment shared)
          const multiplier = 1.04;
          correlationMultiplier *= multiplier;
          correlations.push({
            pick1: `${p1.playerName} (${p1.statType})`,
            pick2: `${p2.playerName} (${p2.statType})`,
            type: "positive",
            multiplier,
            explanation: "Game Environment: High-paced games benefit scoring for both teams.",
          });
        }
      }
    }
  }

  const correlationAdjustedProbability = Math.max(0.001, Math.min(0.999, combinedProbability * correlationMultiplier));

  // American odds from combined probability: odds = if p>0.5: -p/(1-p)*100 else (1-p)/p*100
  let impliedAmericanOdds: number;
  const p = correlationAdjustedProbability;
  if (p > 0.5) {
    impliedAmericanOdds = Math.round((-p / (1 - p)) * 100);
  } else {
    impliedAmericanOdds = Math.round(((1 - p) / p) * 100);
  }

  return {
    picks,
    combinedProbability: Math.round(combinedProbability * 1000) / 10,
    correlationAdjustedProbability: Math.round(correlationAdjustedProbability * 1000) / 10,
    impliedAmericanOdds,
    correlations,
  };
}
