// Mound Radar — frozen market recommendation.
//
// `moundDirection` answers a model question: is this pitcher a Follow or Fade
// relative to the engine's stable season baseline? Market side is a different
// question: is the best frozen pregame projection above or below a real posted
// sportsbook line? Never derive one from the other.

import type { MoundEvaluationSnapshot, MoundMarket } from "./types";

export type MoundMarketRecommendedSide = "OVER" | "UNDER" | "NO_EDGE" | null;

export interface FrozenMoundMarketRecommendation {
  side: MoundMarketRecommendedSide;
  projection: number | null;
  line: number | null;
  margin: number | null;
}

export function deriveFrozenMoundMarketRecommendation(
  primaryMarket: MoundMarket,
  finalPregameSnapshot: MoundEvaluationSnapshot | null,
): FrozenMoundMarketRecommendation {
  if (!finalPregameSnapshot) return { side: null, projection: null, line: null, margin: null };

  // Strikeouts is the only Mound market with a real pregame line source today.
  // The richer matchup-adjusted projection is explicitly the market-decision
  // projection; the simple season K/9 × 6 IP baseline remains untouched for
  // model calibration/Follow-Fade grading.
  if (primaryMarket === "pitcher_strikeouts") {
    const line = finalPregameSnapshot.champion.postedLine.strikeouts.line ?? null;
    const projection =
      finalPregameSnapshot.champion.predictionTimeProjections.matchupAdjustedStrikeouts ??
      finalPregameSnapshot.champion.frozenProductionBaseline.strikeouts.value ??
      null;
    if (line == null || projection == null) return { side: null, projection, line, margin: null };
    const margin = Math.round((projection - line) * 10) / 10;
    if (Math.abs(margin) < 0.5) return { side: "NO_EDGE", projection, line, margin };
    return { side: margin > 0 ? "OVER" : "UNDER", projection, line, margin };
  }

  // No pitcher-outs sportsbook line is captured today. Never cross-substitute
  // a strikeout line or invent a side.
  return { side: null, projection: null, line: null, margin: null };
}
