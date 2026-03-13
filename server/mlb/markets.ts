import type {
  MLBPropInput,
  MLBPropOutput,
  MLBMarket,
  MLBConfidenceTier,
  MLBRecommendedSide,
  ProjectionLog,
} from "./types";
import {
  EXPERIMENTAL_MARKETS,
  CORE_MARKETS,
  EXPERIMENTAL_CONFIDENCE_CEILING,
  EDGE_THRESHOLDS,
  STANDARD_THRESHOLDS,
  SUPPRESSION_RULES,
  MARKET_PROBABILITY_CEILINGS,
  MLB_MARKET_MIN_GAP,
} from "./types";
import {
  classifyContactQuality,
  computeStrongContextScore,
  computeLiveContactQualityScore,
  computePitcherContextScore,
  computeWeatherParkScore,
  computeBullpenScore,
  computeHandednessMatchupScore,
} from "./featureEngineering";
import { projectBaseValue } from "./projections";
import { computeRawProbability } from "./probability";
import { calibrateProbability } from "./calibration";

function determineConfidenceTier(edge: number): MLBConfidenceTier {
  const absEdge = Math.abs(edge);
  if (absEdge >= EDGE_THRESHOLDS.elite) return "ELITE";
  if (absEdge >= EDGE_THRESHOLDS.strong) return "STRONG";
  if (absEdge >= EDGE_THRESHOLDS.lean) return "LEAN";
  return "NO_EDGE";
}

function determineSide(
  calibratedProb: number,
  tier: MLBConfidenceTier
): MLBRecommendedSide {
  if (tier === "NO_EDGE") return "NO_EDGE";
  return calibratedProb >= 50 ? "OVER" : "UNDER";
}

const CONFIDENCE_RANK: Record<MLBConfidenceTier, number> = {
  NO_EDGE: 0,
  LEAN: 1,
  STRONG: 2,
  ELITE: 3,
};

function capConfidenceTier(
  tier: MLBConfidenceTier,
  ceiling: MLBConfidenceTier
): MLBConfidenceTier {
  if (CONFIDENCE_RANK[tier] > CONFIDENCE_RANK[ceiling]) return ceiling;
  return tier;
}

function applyProbabilityCeiling(
  calibratedSided: number,
  market: MLBMarket
): number {
  const ceiling = EXPERIMENTAL_MARKETS.includes(market)
    ? MARKET_PROBABILITY_CEILINGS.experimental
    : MARKET_PROBABILITY_CEILINGS.core;

  if (calibratedSided > ceiling) return ceiling;
  if (calibratedSided < 100 - ceiling) return 100 - ceiling;
  return calibratedSided;
}

function checkSuppression(
  input: MLBPropInput,
  edge: number,
  market: MLBMarket,
  projection: number
): { suppressed: boolean; reason: string | null } {
  const rules = SUPPRESSION_RULES[market];
  if (!rules) return { suppressed: false, reason: null };

  const gap = Math.abs(projection - input.bookLine);
  const minGap = MLB_MARKET_MIN_GAP[market];
  if (gap < minGap) {
    return {
      suppressed: true,
      reason: `Projection gap ${gap.toFixed(3)} below required ${minGap} for ${market}`,
    };
  }

  if (Math.abs(edge) < rules.minEdge) {
    return {
      suppressed: true,
      reason: `Edge ${Math.abs(edge).toFixed(1)}% below market minimum ${rules.minEdge}% for ${market}`,
    };
  }

  if (input.completedAB < rules.minCompletedAB) {
    return {
      suppressed: true,
      reason: `${input.completedAB} AB completed, market requires ${rules.minCompletedAB}+ for ${market}`,
    };
  }

  if (rules.requireContactData) {
    const hasContactData =
      input.contactQuality.exitVelocity !== null ||
      input.contactQuality.hitDistance !== null;
    if (!hasContactData) {
      return {
        suppressed: true,
        reason: `${market} requires contact quality data (EV or distance)`,
      };
    }
  }

  return { suppressed: false, reason: null };
}

function buildExplanationBullets(input: MLBPropInput, output: Partial<MLBPropOutput>): string[] {
  const bullets: string[] = [];

  const ev = input.contactQuality.exitVelocity;
  const la = input.contactQuality.launchAngle;
  const contactTier = classifyContactQuality(input.contactQuality);

  if (ev !== null && la !== null && (contactTier === "ELITE" || contactTier === "HARD")) {
    bullets.push(`${contactTier === "ELITE" ? "Elite" : "Hard"} contact quality today (${ev} mph EV / ${la}° launch angle)`);
  } else {
    bullets.push(`Contact quality: ${contactTier.toLowerCase()} (EV ${ev ?? "N/A"} mph)`);
  }

  const pitcherScore = computePitcherContextScore(input.pitcher);
  if (input.pitcher.pitchCount >= 90) {
    bullets.push(`Starter at high pitch count (${input.pitcher.pitchCount}) — fatigue risk elevated`);
  } else if (input.pitcher.isPitcherCollapsing) {
    bullets.push("Pitcher currently collapsing — elevated edge for hitter-friendly markets");
  } else if (pitcherScore > 0.08) {
    bullets.push("Pitch count and times-through-order suggest starter fatigue risk");
  } else {
    bullets.push(`Pitcher context: ${input.pitcher.pitchCount} pitches, ${input.pitcher.timesThrough}x through order`);
  }

  const lineupSlot = input.lineup.battingOrderSlot;
  const pocketWeakness = input.lineup.pocketWeakness;
  if (pocketWeakness !== null && pocketWeakness >= 0.6) {
    bullets.push("Lineup pocket vulnerability detected around this batting slot");
  } else if (lineupSlot <= 3 && input.lineup.lineupSectionStrength === "strong") {
    bullets.push(`Top-${lineupSlot} slot in a strong lineup section — high PA opportunity`);
  } else {
    bullets.push(`Batting ${lineupSlot} in a ${input.lineup.lineupSectionStrength} lineup section`);
  }

  const wp = input.weatherPark;
  if (!wp.isIndoors) {
    const windNote = wp.windDirection === "out" && (wp.windSpeed ?? 0) >= 10;
    const tempNote = (wp.temperature ?? 70) >= 85;
    const parkNote = wp.parkFactor >= 1.05;
    if (windNote || tempNote || parkNote) {
      const factors: string[] = [];
      if (windNote) factors.push(`wind out at ${wp.windSpeed} mph`);
      if (tempNote) factors.push(`${wp.temperature}°F`);
      if (parkNote) factors.push(`park factor ${wp.parkFactor.toFixed(2)}`);
      bullets.push(`Weather and park conditions favor extra-base production (${factors.join(", ")})`);
    } else {
      bullets.push(`Park factor ${wp.parkFactor.toFixed(2)} — neutral conditions`);
    }
  } else {
    bullets.push("Indoor venue — weather factors not applicable");
  }

  const bullpenScore = computeBullpenScore(input.bullpen);
  if (bullpenScore >= 0.07) {
    bullets.push("Bullpen downgrade expected — high usage and/or depleted relievers");
  }

  const handedness = computeHandednessMatchupScore(input);
  const pitcherThrowsDisplay = input.pitcherThrows ?? input.pitcher.throws ?? "?";
  if (handedness >= 0.06) {
    bullets.push(`Favorable handedness matchup (${input.batterHand} batter vs. ${pitcherThrowsDisplay} pitcher)`);
  } else if (handedness <= -0.03) {
    bullets.push(`Handedness mismatch reduces edge (${input.batterHand} batter vs. ${pitcherThrowsDisplay} pitcher)`);
  }

  if (output.mode === "early_explosive") {
    bullets.push("Early explosive-contact mode active — elite exit velocity and ideal launch angle in first AB");
  }

  return bullets.slice(0, 5);
}

function buildOutput(input: MLBPropInput): MLBPropOutput {
  const projResult = projectBaseValue(input);

  const { overProb, underProb } = computeRawProbability(
    projResult.projection,
    input.bookLine,
    input.market
  );

  const rawProbabilityOver = overProb;
  const rawProbabilityUnder = underProb;

  const dominantRawProb = overProb >= underProb ? overProb : underProb;

  let calibratedOver = calibrateProbability(overProb);
  let calibratedUnder = calibrateProbability(underProb);

  const isExperimental = EXPERIMENTAL_MARKETS.includes(input.market);

  if (isExperimental) {
    calibratedOver = 50 + (calibratedOver - 50) * 0.75;
    calibratedUnder = 50 + (calibratedUnder - 50) * 0.75;
    calibratedOver = Math.round(calibratedOver * 100) / 100;
    calibratedUnder = Math.round(calibratedUnder * 100) / 100;
  }

  const calibratedSidedRaw = overProb >= underProb ? calibratedOver : calibratedUnder;
  const calibratedSided = applyProbabilityCeiling(calibratedSidedRaw, input.market);
  const calibratedOpposite = Math.round((100 - calibratedSided) * 100) / 100;

  const calibratedProbabilityOver = overProb >= underProb ? calibratedSided : calibratedOpposite;
  const calibratedProbabilityUnder = overProb >= underProb ? calibratedOpposite : calibratedSided;

  const calibratedDominant = Math.max(calibratedProbabilityOver, calibratedProbabilityUnder);

  const edge = calibratedSided - 50;
  let confidenceTier = determineConfidenceTier(edge);
  let recommendedSide = determineSide(calibratedSided, confidenceTier);

  const warnings = [...projResult.warnings];

  if (isExperimental) {
    confidenceTier = capConfidenceTier(confidenceTier, EXPERIMENTAL_CONFIDENCE_CEILING);
    recommendedSide = determineSide(calibratedSided, confidenceTier);
    warnings.push(`${input.market} is experimental — confidence capped at ${EXPERIMENTAL_CONFIDENCE_CEILING}`);
  }

  const suppression = checkSuppression(input, edge, input.market, projResult.projection);

  if (suppression.suppressed) {
    confidenceTier = "NO_EDGE";
    recommendedSide = "NO_EDGE";
  }

  const finalEdge = suppression.suppressed ? 0 : Math.round(edge * 100) / 100;

  const completeProjectionLog: ProjectionLog = {
    ...projResult.projectionLog,
    rawProbability: Math.round(dominantRawProb * 100) / 100,
    calibratedProbability: Math.round(calibratedDominant * 100) / 100,
    confidenceTier,
    modeUsed: projResult.mode === "early_explosive" ? "EARLY_EXPLOSIVE" : "STANDARD",
  };

  const partialOutput: Partial<MLBPropOutput> = {
    mode: projResult.mode,
    isExperimental,
  };

  const explanationBullets = buildExplanationBullets(input, partialOutput);

  return {
    market: input.market,
    playerId: input.playerId,
    playerName: input.playerName,
    gameId: input.gameId,
    projection: projResult.projection,
    bookLine: input.bookLine,
    modifiers: projResult.modifiers,
    projectionLog: completeProjectionLog,
    rawProbabilityOver: Math.round(rawProbabilityOver * 100) / 100,
    rawProbabilityUnder: Math.round(rawProbabilityUnder * 100) / 100,
    calibratedProbabilityOver: Math.round(calibratedProbabilityOver * 100) / 100,
    calibratedProbabilityUnder: Math.round(calibratedProbabilityUnder * 100) / 100,
    rawProbability: Math.round(dominantRawProb * 100) / 100,
    calibratedProbability: Math.round(calibratedDominant * 100) / 100,
    edge: finalEdge,
    recommendedSide,
    confidenceTier,
    mode: projResult.mode,
    completedAB: input.completedAB,
    twoABRuleSatisfied: projResult.twoABRuleSatisfied,
    isExperimental,
    suppressed: suppression.suppressed,
    suppressionReason: suppression.reason,
    explanationBullets,
    warnings,
    engineGeneratedAt: Date.now(),
  };
}

export function calculateHitsEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "hits" });
}

export function calculateTBEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "total_bases" });
}

export function calculateBatterKEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "batter_strikeouts" });
}

export function calculatePitcherKEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "pitcher_strikeouts" });
}

export function calculateHitsAllowedEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "hits_allowed" });
}

export function calculateHREdge(input: MLBPropInput): MLBPropOutput {
  const ev = input.contactQuality.exitVelocity ?? 0;
  const la = input.contactQuality.launchAngle ?? 0;
  const dist = input.contactQuality.hitDistance ?? 0;
  const weatherParkScore = computeWeatherParkScore(input.weatherPark);
  const pitcherCtxScore = computePitcherContextScore(input.pitcher);

  const meetsStrictThresholds =
    ev >= 98 &&
    la >= 10 &&
    la <= 35 &&
    dist >= 360 &&
    weatherParkScore > 0 &&
    pitcherCtxScore > -0.2;

  if (!meetsStrictThresholds) {
    const suppReason =
      `HR guardrails not met — requires EV≥98 (${ev}), LA 10-35° (${la}°), dist≥360ft (${dist}ft), weatherPark>0 (${weatherParkScore.toFixed(3)}), pitcherCtx>-0.2 (${pitcherCtxScore.toFixed(3)})`;
    const baseOutput = buildOutput({ ...input, market: "home_runs" });
    baseOutput.confidenceTier = "NO_EDGE";
    baseOutput.recommendedSide = "NO_EDGE";
    baseOutput.edge = 0;
    baseOutput.suppressed = true;
    baseOutput.suppressionReason = suppReason;
    baseOutput.projectionLog = { ...baseOutput.projectionLog, confidenceTier: "NO_EDGE" };
    baseOutput.warnings.push(suppReason);
    return baseOutput;
  }

  return buildOutput({ ...input, market: "home_runs" });
}

export function calculateHRREdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "hrr" });
}

const MARKET_CALCULATORS: Record<MLBMarket, (input: MLBPropInput) => MLBPropOutput> = {
  hits: calculateHitsEdge,
  total_bases: calculateTBEdge,
  batter_strikeouts: calculateBatterKEdge,
  pitcher_strikeouts: calculatePitcherKEdge,
  hits_allowed: calculateHitsAllowedEdge,
  home_runs: calculateHREdge,
  hrr: calculateHRREdge,
};

export function calculateMLBPropEdge(input: MLBPropInput): MLBPropOutput {
  const calculator = MARKET_CALCULATORS[input.market];
  if (!calculator) {
    throw new Error(`Unknown MLB market: ${input.market}`);
  }
  return calculator(input);
}
