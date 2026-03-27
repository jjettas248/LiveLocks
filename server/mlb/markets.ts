import type {
  MLBPropInput,
  MLBPropOutput,
  MLBMarket,
  MLBConfidenceTier,
  MLBRecommendedSide,
  ProjectionLog,
} from "./types";
import { MARKET_PROBABILITY_CAPS } from "./types";
import { getPlayer, getPlayerByName } from "./rosterService";
import { mlbGameCache } from "./dataPullService";

// ── Odds validation helpers ───────────────────────────────────────────────────

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function hasAtLeastOneValidOddsSide(odds: { overOdds?: unknown; underOdds?: unknown } | null | undefined): boolean {
  if (!odds) return false;
  return isFiniteNumber(odds.overOdds) || isFiniteNumber(odds.underOdds);
}

export function hasRealOdds(market: { line?: unknown; odds?: { overOdds?: unknown; underOdds?: unknown } | null }): boolean {
  if (!isFiniteNumber(market.line)) return false;
  if (!market.odds) return false;
  return hasAtLeastOneValidOddsSide(market.odds);
}

// ── Freshness gate ────────────────────────────────────────────────────────────

const FRESHNESS_WINDOW_MS = 120_000;

export function isFresh(timestamp: number | null | undefined): boolean {
  if (!isFiniteNumber(timestamp)) return false;
  return Date.now() - timestamp < FRESHNESS_WINDOW_MS;
}

export function canShowSignal(market: {
  line?: unknown;
  odds?: { overOdds?: unknown; underOdds?: unknown } | null;
  projection?: unknown;
  oddsUpdatedAt?: number | null;
  projectionUpdatedAt?: number | null;
  calibratedProbabilityOver?: number;
  calibratedProbabilityUnder?: number;
}): boolean {
  if (!isFiniteNumber(market.projection)) return false;
  if (!isFresh(market.projectionUpdatedAt)) return false;
  const prob = Math.max(
    isFiniteNumber(market.calibratedProbabilityOver) ? market.calibratedProbabilityOver : 0,
    isFiniteNumber(market.calibratedProbabilityUnder) ? market.calibratedProbabilityUnder : 0,
  );
  if (prob >= 60) return true;
  if (!hasRealOdds(market)) return false;
  if (!isFresh(market.oddsUpdatedAt)) return false;
  return true;
}
import { estimateRemainingPA } from "./paEstimator";
import { estimatePADistribution } from "./paDistribution";
import {
  baseProbability,
  applyPitcherModifier,
  applyParkModifier,
  applyBullpenModifier,
  applyWeatherModifier,
  applyXBAModifier,
  applyXSLGModifier,
} from "./hitProbabilityModel";
import { computeHitOutcomeProbability } from "./outcomeDistribution";
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
  compositeHitterScore,
  COMPOSITE_TIER1_THRESHOLD,
  COMPOSITE_TIER3_THRESHOLD,
  classifyForm,
  computeFormScore,
  computeHRQualifyingFactors,
  meetsHRQualificationGate,
  computeFullFeatureLayer,
  computeBatSpeedEngine,
  computeSpecPitcherDeterioration,
  computeSpecPitchBlendMatchup,
  computeSpecParkEnv,
  computeBadges,
  type FeatureLayer,
} from "./featureEngineering";
import { projectBaseValue } from "./projections";
import { computeRawProbability, clampProjection, clampProbability } from "./probability";
import { calibrateProbability } from "./calibration";

function computeSpecConfidenceScore(
  edge: number,
  features: FeatureLayer,
  badges: { positive: string[]; negative: string[] },
  oddsAge: number,
): number {
  const edgeStrength = Math.min(1, Math.abs(edge) / 10);

  const featureValues = [
    features.contactQuality, features.batSpeedPower, features.handednessMatchup,
    features.pitchBlendMatchup, features.hotColdForm, features.parkEnv,
    features.pitcherSuppression, features.pitcherDeterioration,
  ];
  const mean = featureValues.reduce((s, v) => s + v, 0) / featureValues.length;
  const variance = featureValues.reduce((s, v) => s + (v - mean) ** 2, 0) / featureValues.length;
  const agreementCount = featureValues.filter(v => (edge > 0 ? v > 0.55 : v < 0.45)).length;
  const signalAgreement = Math.min(1, agreementCount / featureValues.length);

  const dataFreshness = Math.max(0, 1 - oddsAge / 600_000);

  const lowVarianceProfile = Math.max(0, 1 - variance * 4);

  const badgeSupport = Math.min(1,
    (badges.positive.length * 0.15 - badges.negative.length * 0.10 + 0.3)
  );

  return (
    0.35 * edgeStrength +
    0.20 * signalAgreement +
    0.15 * dataFreshness +
    0.15 * lowVarianceProfile +
    0.15 * Math.max(0, badgeSupport)
  );
}

function determineConfidenceTier(
  edge: number,
  features?: FeatureLayer,
  badges?: { positive: string[]; negative: string[] },
  oddsAge?: number,
): MLBConfidenceTier {
  if (features && badges) {
    const score = computeSpecConfidenceScore(edge, features, badges, oddsAge ?? 0);
    if (score >= 0.70) return "ELITE";
    if (score >= 0.50) return "STRONG";
    if (score >= 0.30) return "LEAN";
    return "NO_EDGE";
  }
  const absEdge = Math.abs(edge);
  if (absEdge >= EDGE_THRESHOLDS.elite) return "ELITE";
  if (absEdge >= EDGE_THRESHOLDS.strong) return "STRONG";
  if (absEdge >= EDGE_THRESHOLDS.lean) return "LEAN";
  return "NO_EDGE";
}

function determineSide(
  calibratedProb: number,
  tier: MLBConfidenceTier,
  isOverFavored: boolean = true
): MLBRecommendedSide {
  if (tier === "NO_EDGE") return "NO_EDGE";
  return isOverFavored ? "OVER" : "UNDER";
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
  const cap = MARKET_PROBABILITY_CAPS[market];
  if (cap && calibratedSided > cap) return cap;
  return calibratedSided;
}

// ── Tier 1 markets (high priority, standard composite threshold) ──────────────
const TIER1_MARKETS = new Set<MLBMarket>(["hits", "total_bases", "hrr", "pitcher_strikeouts", "pitcher_outs"]);
const TIER3_MARKETS = new Set<MLBMarket>(["home_runs", "batter_strikeouts", "hr_allowed"]);

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

  // ── Composite scoring gate ────────────────────────────────────────────────
  // Tier 3 (HR, HRR) requires a higher composite threshold than Tier 1.
  // Pitcher markets are excluded from this gate (no contact quality input).
  const isPitcherMarket = market === "pitcher_strikeouts" || market === "hits_allowed" || market === "walks_allowed";
  if (!isPitcherMarket) {
    const composite = compositeHitterScore(input);
    if (TIER3_MARKETS.has(market) && composite < COMPOSITE_TIER3_THRESHOLD) {
      return {
        suppressed: true,
        reason: `${market} requires composite score ≥ ${COMPOSITE_TIER3_THRESHOLD} (got ${composite.toFixed(2)})`,
      };
    }
    if (TIER1_MARKETS.has(market) && composite < COMPOSITE_TIER1_THRESHOLD) {
      return {
        suppressed: true,
        reason: `${market} requires composite score ≥ ${COMPOSITE_TIER1_THRESHOLD} (got ${composite.toFixed(2)})`,
      };
    }
  }

  return { suppressed: false, reason: null };
}

function translateToScoutReport(input: MLBPropInput, output: Partial<MLBPropOutput>): string[] {
  const bullets: string[] = [];
  const priorABs = input.contactQuality.priorABResults;

  const hardHits = priorABs.filter((ab) => (ab.exitVelocity ?? 0) >= 100);
  if (hardHits.length > 0) {
    const bestEv = Math.max(...hardHits.map((h) => h.exitVelocity ?? 0));
    bullets.push(`${hardHits.length} Hard-Hit Ball${hardHits.length > 1 ? "s" : ""} (${Math.round(bestEv)}+ EV)`);
  } else {
    const contactTier = classifyContactQuality(input.contactQuality);
    if (contactTier === "ELITE" || contactTier === "HARD") {
      bullets.push("Quality contact today");
    }
  }

  if (input.pitcher.pitchCount >= 90) {
    bullets.push("Fatigue — High Pitch Count");
  } else if (input.pitcher.isPitcherCollapsing) {
    bullets.push("Pitcher Collapsing");
  } else if (input.pitcher.timesThrough >= 3) {
    bullets.push("Third Time Through Order");
  } else if (input.pitcher.pitchCount >= 75) {
    bullets.push("Pitcher Tiring");
  }

  const wp = input.weatherPark;
  if (!wp.isIndoors && wp.windDirection === "out" && (wp.windSpeed ?? 0) >= 8) {
    bullets.push(`Wind Out (${wp.windSpeed} mph)`);
  }
  if (!wp.isIndoors && (wp.temperature ?? 70) >= 85) {
    bullets.push("Hot Weather — Ball Carries");
  }
  if (wp.parkFactor >= 1.08) {
    bullets.push("Hitter-Friendly Park");
  }

  const era = input.pitcher.era;
  if (era !== null && era >= 4.5) {
    bullets.push("HR-Prone Pitcher");
  }

  const handedness = computeHandednessMatchupScore(input);
  if (handedness >= 0.04) {
    bullets.push("Favorable Matchup");
  }

  const bullpenScore = computeBullpenScore(input.bullpen);
  if (bullpenScore >= 0.07) {
    bullets.push("Bullpen Depleted");
  }

  const parkHistory = wp.parkHistoryFactor ?? input.parkHistoryFactor;
  if (parkHistory !== null && parkHistory !== undefined && parkHistory >= 1.08) {
    bullets.push("Crushes This Park");
  }

  const deepFlys = priorABs.filter((ab) => ab.outcome === "out" && (ab.distance ?? 0) >= 350 && (ab.launchAngle ?? 0) >= 20);
  if (deepFlys.length > 0) {
    bullets.push(`${deepFlys.length} Deep Flyout${deepFlys.length > 1 ? "s" : ""}`);
  }

  if (output.mode === "early_explosive") {
    bullets.push("Explosive Contact — 1st AB");
  }

  return bullets.slice(0, 6);
}

function buildExplanationBullets(input: MLBPropInput, output: Partial<MLBPropOutput>): string[] {
  return translateToScoutReport(input, output);
}

function americanOddsToImplied(odds: number | null | undefined): number {
  if (odds == null || !Number.isFinite(odds)) return 50;
  if (odds < 0) return (Math.abs(odds) / (Math.abs(odds) + 100)) * 100;
  if (odds > 0) return (100 / (odds + 100)) * 100;
  return 50;
}

function computeBookImplied(input: MLBPropInput, isOverFavored: boolean): number {
  if (isOverFavored && input.overOdds != null) return americanOddsToImplied(input.overOdds);
  if (!isOverFavored && input.underOdds != null) return americanOddsToImplied(input.underOdds);
  if (input.overOdds != null) return americanOddsToImplied(input.overOdds);
  if (input.underOdds != null) return americanOddsToImplied(input.underOdds);
  return 50;
}

function applyMarketFeatureWeights(
  baseProjection: number,
  features: FeatureLayer,
  market: MLBMarket,
  input: MLBPropInput
): number {
  const batSpeed = computeBatSpeedEngine(input);
  const deterioration = computeSpecPitcherDeterioration(input);

  let featureMultiplier = 1.0;

  switch (market) {
    case "hits": {
      const pregameSkill =
        0.30 * features.contactQuality +
        0.18 * features.handednessMatchup +
        0.16 * features.pitchBlendMatchup +
        0.10 * features.parkEnv +
        0.08 * features.bvp +
        0.08 * features.hotColdForm +
        0.06 * features.lineupOpportunity +
        0.04 * batSpeed.batSpeedPowerScore;
      const liveAdj =
        1 +
        0.18 * deterioration.hitsAllowed +
        0.12 * features.bullpenFactor +
        0.10 * (features.contactQuality > 0.6 ? features.contactQuality - 0.5 : 0) +
        0.06 * (features.lineupOpportunity > 0.5 ? 0.1 : 0);
      featureMultiplier = (0.5 + pregameSkill) * liveAdj;
      featureMultiplier *= (1 - 0.3 * features.pitcherSuppression);
      break;
    }
    case "total_bases": {
      const damageSkill =
        0.26 * features.contactQuality +
        0.18 * ((input.contactQuality.barrelRateProxySeason ?? 0.05) > 0.08 ? 0.7 : 0.4) +
        0.16 * batSpeed.batSpeedPowerScore +
        0.14 * features.handednessMatchup +
        0.12 * features.pitchBlendMatchup +
        0.08 * computeSpecParkEnv(input, "tb") +
        0.06 * features.hotColdForm;
      const tbBoost =
        1 +
        0.22 * deterioration.hitsAllowed +
        0.18 * deterioration.hrAllowed +
        0.10 * features.bullpenFactor;
      featureMultiplier = (0.5 + damageSkill) * tbBoost;
      featureMultiplier *= (1 - 0.25 * features.pitcherSuppression);
      break;
    }
    case "home_runs": {
      const barrel = input.contactQuality.barrelRateProxySeason ?? 0.05;
      const hrSkill =
        0.24 * Math.min(1, barrel / 0.12) +
        0.16 * features.contactQuality +
        0.14 * ((input.contactQuality.exitVelocity ?? 88) > 95 ? 0.7 : 0.35) +
        0.20 * batSpeed.batSpeedPowerScore +
        0.10 * computeSpecParkEnv(input, "hr") +
        0.06 * features.handednessMatchup +
        0.06 * features.pitchBlendMatchup +
        0.04 * features.hotColdForm;
      const liveHRAdj =
        1 +
        0.25 * deterioration.hrAllowed +
        0.12 * (deterioration.overall > 0.5 ? deterioration.overall - 0.4 : 0) +
        0.08 * (features.parkEnv > 0.6 ? 0.2 : 0);
      featureMultiplier = (0.4 + hrSkill) * liveHRAdj;
      featureMultiplier *= (1 - 0.35 * features.pitcherSuppression);
      break;
    }
    case "hrr": {
      const hrrSkill =
        0.25 * features.contactQuality +
        0.15 * features.handednessMatchup +
        0.15 * features.pitchBlendMatchup +
        0.12 * features.parkEnv +
        0.10 * batSpeed.batSpeedPowerScore +
        0.08 * features.hotColdForm +
        0.08 * features.lineupOpportunity +
        0.07 * features.bvp;
      featureMultiplier = (0.5 + hrrSkill) * (1 + 0.15 * deterioration.hitsAllowed);
      break;
    }
    case "pitcher_strikeouts": {
      const kSkill =
        0.26 * Math.min(1, (input.pitcher.kPer9 ?? 8) / 12) +
        0.20 * (input.pitcher.whip != null ? 1 - Math.min(1, input.pitcher.whip / 1.5) : 0.5) +
        0.16 * computeSpecPitchBlendMatchup(input, "whiff") +
        0.14 * (1 - features.contactQuality) +
        0.10 * features.handednessMatchup +
        0.08 * Math.min(1, (input.pitcher.kPer9 ?? 8) / 10) +
        0.06 * (1 - features.hotColdForm);
      const kDecay = 1 - 0.18 * deterioration.kDropoff - 0.08 * (input.pitcher.timesThrough >= 3 ? 0.5 : 0);
      featureMultiplier = (0.5 + kSkill) * Math.max(0.6, kDecay);
      break;
    }
    case "pitcher_outs": {
      const outsSkill =
        0.24 * (1 - Math.min(1, input.pitcher.pitchCount / 100)) +
        0.18 * (input.pitcher.managerLeashShort ? 0.3 : 0.7) +
        0.16 * features.pitcherSuppression +
        0.12 * (1 - Math.min(1, (input.pitcher.bbPer9 ?? 3) / 5)) +
        0.10 * (1 - features.contactQuality) +
        0.10 * (input.pitcher.timesThrough <= 2 ? 0.7 : 0.3) +
        0.10 * (1 - features.hotColdForm);
      featureMultiplier = (0.5 + outsSkill) * (1 - 0.3 * deterioration.outsRisk);
      break;
    }
    case "hits_allowed": {
      const oppContactThreat =
        0.24 * features.contactQuality +
        0.18 * features.handednessMatchup +
        0.16 * (features.lineupOpportunity > 0.5 ? 0.7 : 0.4) +
        0.14 * features.parkEnv +
        0.12 * features.pitchBlendMatchup +
        0.10 * features.hotColdForm +
        0.06 * features.bvp;
      const pitcherSupp = Math.max(0.3, features.pitcherSuppression);
      const hitsAllowedRisk = 1 + 0.22 * deterioration.hitsAllowed + 0.14 * deterioration.overall;
      featureMultiplier = (0.5 + oppContactThreat) / (0.5 + pitcherSupp) * hitsAllowedRisk;
      break;
    }
    case "walks_allowed": {
      const walkExposure =
        0.28 * Math.min(1, (input.pitcher.bbPer9 ?? 3) / 5) +
        0.18 * (1 - Math.min(1, (input.pitcher.kPer9 ?? 8) / 12)) +
        0.16 * (1 - features.contactQuality * 0.3) +
        0.12 * features.handednessMatchup +
        0.10 * deterioration.walksAllowed +
        0.08 * (features.hotColdForm > 0.6 ? 0.6 : 0.4) +
        0.08 * (1 - features.pitcherSuppression);
      featureMultiplier = 0.5 + walkExposure;
      break;
    }
    case "batter_strikeouts": {
      const whiffRate = input.contactQuality.hardHitRateSeason != null
        ? Math.max(0, 1 - input.contactQuality.hardHitRateSeason) : 0.5;
      const batterKExposure =
        0.28 * (1 - features.contactQuality) +
        0.18 * whiffRate +
        0.14 * computeSpecPitchBlendMatchup(input, "whiff") +
        0.12 * (1 - features.handednessMatchup) +
        0.10 * (features.hotColdForm <= 0.3 ? 0.7 : 0.35) +
        0.08 * (1 - features.bvp) +
        0.06 * (batSpeed.batSpeedZ > 1 && whiffRate > 0.5 ? 0.7 : 0.3) +
        0.04 * (1 - features.lineupOpportunity);
      const pitcherPutaway =
        0.30 * Math.min(1, (input.pitcher.kPer9 ?? 8) / 12) +
        0.22 * (input.pitcher.whip != null ? 1 - Math.min(1, input.pitcher.whip / 1.5) : 0.5) +
        0.16 * computeSpecPitchBlendMatchup(input, "whiff") +
        0.12 * features.handednessMatchup +
        0.10 * Math.min(1, (input.pitcher.kPer9 ?? 8) / 10) +
        0.10 * features.pitcherSuppression;
      featureMultiplier = (0.5 + batterKExposure) * (0.5 + pitcherPutaway);
      break;
    }
    case "hr_allowed": {
      const barrelAllowed = input.contactQuality.barrelRateProxySeason != null
        ? Math.min(1, (input.contactQuality.barrelRateProxySeason) / 0.12) : 0.5;
      const pitcherHRRisk =
        0.24 * barrelAllowed +
        0.18 * features.contactQuality +
        0.14 * computeSpecParkEnv(input, "hr") +
        0.12 * features.handednessMatchup +
        0.12 * features.pitchBlendMatchup +
        0.10 * deterioration.hrAllowed +
        0.10 * (deterioration.overall > 0.5 ? deterioration.overall - 0.3 : 0);
      featureMultiplier = 0.5 + pitcherHRRisk;
      featureMultiplier *= (1 - 0.25 * features.pitcherSuppression);
      break;
    }
    default:
      featureMultiplier = 1.0;
  }

  return baseProjection * Math.max(0.5, Math.min(2.0, featureMultiplier));
}

function buildOutput(input: MLBPropInput): MLBPropOutput {
  const features = computeFullFeatureLayer(input);
  const projResult = projectBaseValue(input);
  const featureAdjustedProjection = applyMarketFeatureWeights(
    projResult.projection, features, input.market, input
  );
  const safeProjection = clampProjection(featureAdjustedProjection);

  const { overProb, underProb } = computeRawProbability(
    safeProjection,
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
    calibratedOver = 50 + (calibratedOver - 50) * 0.90;
    calibratedUnder = 50 + (calibratedUnder - 50) * 0.90;
    calibratedOver = Math.round(calibratedOver * 100) / 100;
    calibratedUnder = Math.round(calibratedUnder * 100) / 100;
  }

  const calibratedSidedRaw = overProb >= underProb ? calibratedOver : calibratedUnder;
  const calibratedSided = applyProbabilityCeiling(calibratedSidedRaw, input.market);
  const calibratedOpposite = Math.round((100 - calibratedSided) * 100) / 100;

  const calibratedProbabilityOver = clampProbability(overProb >= underProb ? calibratedSided : calibratedOpposite);
  const calibratedProbabilityUnder = clampProbability(overProb >= underProb ? calibratedOpposite : calibratedSided);

  const calibratedDominant = Math.max(calibratedProbabilityOver, calibratedProbabilityUnder);

  const isOverFavored = overProb >= underProb;
  const bookImplied = computeBookImplied(input, isOverFavored);
  const edge = calibratedSided - bookImplied;
  const badgeResult = computeBadges(input, features);
  const oddsAge = input.oddsUpdatedAt ? Date.now() - input.oddsUpdatedAt : 0;
  let confidenceTier = determineConfidenceTier(edge, features, badgeResult, oddsAge);
  let recommendedSide = determineSide(calibratedSided, confidenceTier, isOverFavored);

  const warnings = [...projResult.warnings];

  if (isExperimental) {
    confidenceTier = capConfidenceTier(confidenceTier, EXPERIMENTAL_CONFIDENCE_CEILING);
    recommendedSide = determineSide(calibratedSided, confidenceTier, isOverFavored);
    warnings.push(`${input.market} is experimental — confidence capped at ${EXPERIMENTAL_CONFIDENCE_CEILING}`);
  }

  const suppression = checkSuppression(input, edge, input.market, safeProjection);

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

  const form = classifyForm(input);
  const fScore = computeFormScore(input);
  const evPct = Math.round((calibratedDominant / 100 - 0.5) * 100 * 10) / 10;
  const ctxScore = computeStrongContextScore(input);

  let matchupTag: string | null = null;
  if (input.pitcher.timesThrough >= 3) matchupTag = "vs 3rd Time Through";
  else if (input.pitcher.pitchCount >= 80) matchupTag = "vs Fatigue";
  else if (input.pitcher.isPitcherCollapsing) matchupTag = "vs Collapsing Pitcher";
  else if (input.pitcher.era !== null && input.pitcher.era >= 4.5) matchupTag = `vs ${input.pitcher.throws ?? ""}HP (${input.pitcher.era.toFixed(1)} ERA)`;
  else if (input.pitcher.throws) matchupTag = `vs ${input.pitcher.throws}HP`;

  const hrFactors = (input.market === "home_runs" || input.market === "hrr")
    ? (() => { const f = computeHRQualifyingFactors(input); return { count: f.count, labels: f.labels }; })()
    : undefined;

  const featureScores: Record<string, number> = {
    contactQuality: Math.round(features.contactQuality * 1000) / 1000,
    batSpeedPower: Math.round(features.batSpeedPower * 1000) / 1000,
    handednessMatchup: Math.round(features.handednessMatchup * 1000) / 1000,
    pitchBlendMatchup: Math.round(features.pitchBlendMatchup * 1000) / 1000,
    hotColdForm: Math.round(features.hotColdForm * 1000) / 1000,
    parkEnv: Math.round(features.parkEnv * 1000) / 1000,
    bvp: Math.round(features.bvp * 1000) / 1000,
    lineupOpportunity: Math.round(features.lineupOpportunity * 1000) / 1000,
    bullpenFactor: Math.round(features.bullpenFactor * 1000) / 1000,
    pitcherSuppression: Math.round(features.pitcherSuppression * 1000) / 1000,
    pitcherDeterioration: Math.round(features.pitcherDeterioration * 1000) / 1000,
  };

  const nowTs = Date.now();
  return {
    market: input.market,
    playerId: input.playerId,
    playerName: input.playerName,
    gameId: input.gameId,
    projection: safeProjection,
    bookLine: input.bookLine,
    overOdds: input.overOdds ?? null,
    underOdds: input.underOdds ?? null,
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
    expectedHits: null,
    remainingPA: input.remainingPA ?? null,
    adjustedHitRate: null,
    bookImplied: Math.round(bookImplied * 100) / 100,
    isExperimental,
    suppressed: suppression.suppressed,
    suppressionReason: suppression.reason,
    explanationBullets,
    warnings,
    engineGeneratedAt: nowTs,
    oddsUpdatedAt: nowTs,
    projectionUpdatedAt: nowTs,
    sportsbook: null,
    isDerivedLine: false,
    signalTimestamp: nowTs,
    formIndicator: form,
    formScore: Math.round(fScore * 100) / 100,
    evPct,
    hrFactors,
    contextScore: Math.round(ctxScore * 100) / 100,
    matchupTag,
    featureScores,
    computedBadges: badgeResult.positive,
    computedRiskFlags: badgeResult.negative,
  };
}

export function calculateHitsEdge(input: MLBPropInput): MLBPropOutput {
  const hitsInput = { ...input, market: "hits" as MLBMarket };

  const features = computeFullFeatureLayer(hitsInput);
  const batSpeed = computeBatSpeedEngine(hitsInput);
  const deterioration = computeSpecPitcherDeterioration(hitsInput);

  const currentHits = hitsInput.currentStatValue ?? 0;
  const playerAB = hitsInput.atBats > 0 ? hitsInput.atBats : hitsInput.completedAB;

  let adjustedRate = baseProbability(currentHits, playerAB);

  const pitcherKRate = hitsInput.pitcher.kPer9 != null ? hitsInput.pitcher.kPer9 / 9 : 0.22;
  const pitcherBABIP = 0.296;
  adjustedRate = applyPitcherModifier(adjustedRate, pitcherKRate, pitcherBABIP);
  adjustedRate = applyParkModifier(adjustedRate, hitsInput.weatherPark.parkFactor);
  adjustedRate = applyBullpenModifier(adjustedRate, hitsInput.bullpen.bullpenEra);
  adjustedRate = applyXBAModifier(adjustedRate, hitsInput.contactQuality.xBA, playerAB);

  const windOut = hitsInput.weatherPark.windDirection === "out";
  const temperature = hitsInput.weatherPark.temperature ?? 70;
  adjustedRate = applyWeatherModifier(adjustedRate, windOut, temperature);

  const featureAdj =
    1 +
    0.12 * (features.contactQuality - 0.5) +
    0.08 * (features.handednessMatchup - 0.5) +
    0.06 * (features.pitchBlendMatchup - 0.5) +
    0.05 * (features.hotColdForm - 0.5) +
    0.04 * (features.bvp - 0.5) +
    0.03 * (batSpeed.batSpeedPowerScore - 0.5) +
    0.06 * deterioration.hitsAllowed +
    0.04 * features.bullpenFactor -
    0.08 * features.pitcherSuppression;
  adjustedRate *= Math.max(0.7, Math.min(1.3, featureAdj));

  const paDist = estimatePADistribution(
    hitsInput.inning,
    hitsInput.lineup.battingOrderSlot,
    hitsInput.currentRuns ?? 4.5,
    hitsInput.leagueAvgRuns ?? 4.5
  );

  const expectedHits = paDist[1] * adjustedRate + paDist[2] * 2 * adjustedRate + paDist[3] * 3 * adjustedRate;
  const rpa = (1 * paDist[1]) + (2 * paDist[2]) + (3 * paDist[3]);

  const neededHits = Math.max(0, Math.ceil(hitsInput.bookLine) - currentHits);

  let rawProbabilityOver: number;
  let rawProbabilityUnder: number;

  if (neededHits === 0) {
    rawProbabilityOver = clampProbability(100);
    rawProbabilityUnder = clampProbability(0);
  } else {
    let weightedProb = 0;
    for (const [paCountStr, paProb] of Object.entries(paDist)) {
      const paCount = Number(paCountStr);
      weightedProb += computeHitOutcomeProbability(paCount, adjustedRate, neededHits) * paProb;
    }
    rawProbabilityOver = Math.round(clampProbability(weightedProb) * 100) / 100;
    rawProbabilityUnder = Math.round(clampProbability(100 - weightedProb) * 100) / 100;
  }

  let calibratedOver = calibrateProbability(rawProbabilityOver);
  let calibratedUnder = calibrateProbability(rawProbabilityUnder);

  const isExperimental = EXPERIMENTAL_MARKETS.includes("hits" as MLBMarket);

  if (isExperimental) {
    calibratedOver = 50 + (calibratedOver - 50) * 0.90;
    calibratedUnder = 50 + (calibratedUnder - 50) * 0.90;
    calibratedOver = Math.round(calibratedOver * 100) / 100;
    calibratedUnder = Math.round(calibratedUnder * 100) / 100;
  }

  const calibratedSidedRaw = rawProbabilityOver >= rawProbabilityUnder ? calibratedOver : calibratedUnder;
  const calibratedSided = applyProbabilityCeiling(calibratedSidedRaw, "hits");
  const calibratedOpposite = Math.round((100 - calibratedSided) * 100) / 100;

  const calibratedProbabilityOver = clampProbability(rawProbabilityOver >= rawProbabilityUnder ? calibratedSided : calibratedOpposite);
  const calibratedProbabilityUnder = clampProbability(rawProbabilityOver >= rawProbabilityUnder ? calibratedOpposite : calibratedSided);
  const calibratedDominant = Math.max(calibratedProbabilityOver, calibratedProbabilityUnder);
  const dominantRawProb = Math.max(rawProbabilityOver, rawProbabilityUnder);

  const isOverFavored = rawProbabilityOver >= rawProbabilityUnder;
  const bookImplied = computeBookImplied(hitsInput, isOverFavored);
  const edge = calibratedSided - bookImplied;
  let confidenceTier = determineConfidenceTier(edge);
  let recommendedSide = determineSide(calibratedSided, confidenceTier, isOverFavored);

  const adjustedProjection = clampProjection(expectedHits + currentHits);

  const projResult = projectBaseValue(hitsInput);
  const warnings = [...projResult.warnings];

  if (isExperimental) {
    confidenceTier = capConfidenceTier(confidenceTier, EXPERIMENTAL_CONFIDENCE_CEILING);
    recommendedSide = determineSide(calibratedSided, confidenceTier, isOverFavored);
    warnings.push(`hits is experimental — confidence capped at ${EXPERIMENTAL_CONFIDENCE_CEILING}`);
  }

  const suppression = checkSuppression(hitsInput, edge, "hits", adjustedProjection);
  const finalEdge = suppression.suppressed ? 0 : Math.round(edge * 100) / 100;

  if (suppression.suppressed) {
    confidenceTier = "NO_EDGE";
    recommendedSide = "NO_EDGE";
  }

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

  const explanationBullets = buildExplanationBullets(hitsInput, partialOutput);

  return {
    market: "hits",
    playerId: hitsInput.playerId,
    playerName: hitsInput.playerName,
    gameId: hitsInput.gameId,
    projection: parseFloat(adjustedProjection.toFixed(3)),
    bookLine: hitsInput.bookLine,
    overOdds: hitsInput.overOdds ?? null,
    underOdds: hitsInput.underOdds ?? null,
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
    completedAB: hitsInput.completedAB,
    twoABRuleSatisfied: projResult.twoABRuleSatisfied,
    expectedHits: parseFloat(expectedHits.toFixed(2)),
    remainingPA: rpa,
    adjustedHitRate: parseFloat(adjustedRate.toFixed(4)),
    bookImplied: Math.round(bookImplied * 100) / 100,
    paDistribution: paDist,
    isExperimental,
    suppressed: suppression.suppressed,
    suppressionReason: suppression.reason,
    explanationBullets,
    warnings,
    engineGeneratedAt: Date.now(),
    oddsUpdatedAt: Date.now(),
    projectionUpdatedAt: Date.now(),
    sportsbook: null,
    isDerivedLine: false,
    signalTimestamp: Date.now(),
    formIndicator: classifyForm(hitsInput),
    formScore: Math.round(computeFormScore(hitsInput) * 100) / 100,
    evPct: Math.round((calibratedDominant / 100 - 0.5) * 100 * 10) / 10,
    contextScore: Math.round(computeStrongContextScore(hitsInput) * 100) / 100,
    matchupTag: hitsInput.pitcher.timesThrough >= 3 ? "vs 3rd Time Through" : hitsInput.pitcher.pitchCount >= 80 ? "vs Fatigue" : hitsInput.pitcher.throws ? `vs ${hitsInput.pitcher.throws}HP` : null,
    featureScores: {
      contactQuality: Math.round(features.contactQuality * 1000) / 1000,
      batSpeedPower: Math.round(features.batSpeedPower * 1000) / 1000,
      handednessMatchup: Math.round(features.handednessMatchup * 1000) / 1000,
      pitchBlendMatchup: Math.round(features.pitchBlendMatchup * 1000) / 1000,
      hotColdForm: Math.round(features.hotColdForm * 1000) / 1000,
      parkEnv: Math.round(features.parkEnv * 1000) / 1000,
      bvp: Math.round(features.bvp * 1000) / 1000,
      lineupOpportunity: Math.round(features.lineupOpportunity * 1000) / 1000,
      bullpenFactor: Math.round(features.bullpenFactor * 1000) / 1000,
      pitcherSuppression: Math.round(features.pitcherSuppression * 1000) / 1000,
      pitcherDeterioration: Math.round(features.pitcherDeterioration * 1000) / 1000,
    },
    computedBadges: computeBadges(hitsInput, features).positive,
    computedRiskFlags: computeBadges(hitsInput, features).negative,
  };
}

export function calculateTBEdge(input: MLBPropInput): MLBPropOutput {
  const output = buildOutput({ ...input, market: "total_bases" });

  let tbRate = input.atBats > 0 ? (input.currentStatValue ?? 0) / input.atBats : 0.40;
  tbRate = applyParkModifier(tbRate, input.weatherPark.parkFactor);
  const windOut = input.weatherPark.windDirection === "out";
  const temperature = input.weatherPark.temperature ?? 70;
  tbRate = applyWeatherModifier(tbRate, windOut, temperature);
  tbRate = applyXSLGModifier(tbRate, input.contactQuality.xSLG, input.atBats);

  const rpa = input.remainingPA ?? 2;
  output.expectedHits = parseFloat((tbRate * rpa).toFixed(2));
  output.remainingPA = rpa;

  return output;
}

export function calculatePitcherKEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "pitcher_strikeouts" });
}

export function calculatePitcherOutsEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "pitcher_outs" });
}

export function calculateHitsAllowedEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "hits_allowed" });
}

export function calculateWalksAllowedEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "walks_allowed" });
}

export function calculateHREdge(input: MLBPropInput): MLBPropOutput {
  const output = buildOutput({ ...input, market: "home_runs" });

  const { factors: hrFactors } = meetsHRQualificationGate(input);
  output.hrFactors = { count: hrFactors.count, labels: hrFactors.labels };

  return output;
}

export function calculateHRREdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "hrr" });
}

export function calculateBatterStrikeoutsEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "batter_strikeouts" });
}

export function calculateHRAllowedEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "hr_allowed" });
}

const MARKET_CALCULATORS: Record<MLBMarket, (input: MLBPropInput) => MLBPropOutput> = {
  hits: calculateHitsEdge,
  total_bases: calculateTBEdge,
  pitcher_strikeouts: calculatePitcherKEdge,
  pitcher_outs: calculatePitcherOutsEdge,
  hits_allowed: calculateHitsAllowedEdge,
  walks_allowed: calculateWalksAllowedEdge,
  home_runs: calculateHREdge,
  hrr: calculateHRREdge,
  batter_strikeouts: calculateBatterStrikeoutsEdge,
  hr_allowed: calculateHRAllowedEdge,
};

export function calculateMLBPropEdge(input: MLBPropInput): MLBPropOutput {
  const calculator = MARKET_CALCULATORS[input.market];
  if (!calculator) {
    throw new Error(`Unknown MLB market: ${input.market}`);
  }

  // ── Roster hydration (Edit #4) ──────────────────────────────────────────────
  // Fill missing identity/handedness fields from rosterService when available.
  // Try by playerId first, fall back to playerName lookup (useful in admin tests).
  const rosterPlayer = getPlayer(input.playerId) ?? getPlayerByName(input.playerName);
  let resolvedInput: MLBPropInput = input;
  if (rosterPlayer) {
    resolvedInput = {
      ...resolvedInput,
      batterHand: resolvedInput.batterHand ?? rosterPlayer.bats,
      team: resolvedInput.team || rosterPlayer.team,
      playerName: resolvedInput.playerName || rosterPlayer.playerName,
    };
  }

  // ── Cache integration (Correction 3: derive remainingPA/AB via estimateRemainingPA) ─
  const gameId = resolvedInput.gameId;

  // (a) Game state
  const gameState = mlbGameCache.gameState?.[gameId];
  if (gameState) {
    const orderEntry = gameState.battingOrder.find((b) => b.playerId === resolvedInput.playerId);
    const slot = orderEntry?.slot ?? resolvedInput.lineup.battingOrderSlot;
    const { remainingPA, remainingAB } = estimateRemainingPA(
      gameState.inning,
      gameState.isTopInning,
      slot,
      resolvedInput.currentRuns,
      resolvedInput.leagueAvgRuns
    );
    resolvedInput = {
      ...resolvedInput,
      inning: gameState.inning,
      isTopInning: gameState.isTopInning,
      remainingPA,
      remainingAB,
      lineup: {
        ...resolvedInput.lineup,
        battingOrderSlot: slot,
        hittersAheadOnBase: gameState.runnersOnBase.length,
      },
      pitcher: {
        ...resolvedInput.pitcher,
        pitchCount: gameState.pitchCount || resolvedInput.pitcher.pitchCount,
        timesThrough: gameState.timesThroughOrder || resolvedInput.pitcher.timesThrough,
        throws: gameState.pitcherInGame?.throws ?? resolvedInput.pitcher.throws,
      },
    };
  }

  // (b) Contact quality — per-player from cache
  const contactCache = mlbGameCache.contactData?.[gameId];
  const playerContact = contactCache?.byPlayerId?.[resolvedInput.playerId];
  if (playerContact) {
    resolvedInput = {
      ...resolvedInput,
      contactQuality: {
        exitVelocity: playerContact.exitVelocity ?? resolvedInput.contactQuality.exitVelocity,
        launchAngle: playerContact.launchAngle ?? resolvedInput.contactQuality.launchAngle,
        hitDistance: playerContact.hitDistance ?? resolvedInput.contactQuality.hitDistance,
        hardHitRateSeason:
          playerContact.hardHitPct != null
            ? playerContact.hardHitPct / 100
            : resolvedInput.contactQuality.hardHitRateSeason,
        barrelRateProxySeason:
          playerContact.barrelPct != null
            ? playerContact.barrelPct / 100
            : resolvedInput.contactQuality.barrelRateProxySeason,
        priorABResults:
          playerContact.priorABResults.length > 0
            ? (playerContact.priorABResults as MLBPropInput["contactQuality"]["priorABResults"])
            : resolvedInput.contactQuality.priorABResults,
        xBA: playerContact.xBA ?? resolvedInput.contactQuality.xBA,
        xSLG: playerContact.xSLG ?? resolvedInput.contactQuality.xSLG,
      },
    };
  }

  // (c) Pitcher context — keyed by active pitcher ID
  const pitcherCtxCache = mlbGameCache.pitcherContext?.[gameId];
  const activePitcherId = gameState?.pitcherInGame?.playerId;
  const pitcherCtx = activePitcherId ? pitcherCtxCache?.byPitcherId?.[activePitcherId] : undefined;
  if (pitcherCtx) {
    resolvedInput = {
      ...resolvedInput,
      pitcher: {
        ...resolvedInput.pitcher,
        pitchMix: pitcherCtx.pitchMix.length > 0 ? pitcherCtx.pitchMix : resolvedInput.pitcher.pitchMix,
        pitchCount: pitcherCtx.pitchCount || resolvedInput.pitcher.pitchCount,
        timesThrough: pitcherCtx.timesThroughOrder || resolvedInput.pitcher.timesThrough,
        isPitcherCollapsing: pitcherCtx.velocityDrop !== null && pitcherCtx.velocityDrop > 2,
        managerLeashShort: pitcherCtx.timesThroughOrder >= 3 && pitcherCtx.pitchCount > 80,
      },
    };
  }

  // (d) Weather
  const weatherCache = mlbGameCache.weather?.[gameId];
  if (weatherCache) {
    resolvedInput = {
      ...resolvedInput,
      weatherPark: {
        ...resolvedInput.weatherPark,
        temperature: weatherCache.temperature ?? resolvedInput.weatherPark.temperature,
        windSpeed: weatherCache.windSpeed ?? resolvedInput.weatherPark.windSpeed,
        windDirection: weatherCache.windDirection ?? resolvedInput.weatherPark.windDirection,
        humidity: weatherCache.humidity ?? resolvedInput.weatherPark.humidity,
      },
    };
  }

  // (e) Bullpen
  const bullpenCache = mlbGameCache.bullpen?.[gameId];
  if (bullpenCache) {
    resolvedInput = {
      ...resolvedInput,
      bullpen: {
        bullpenEra: bullpenCache.bullpenEra ?? resolvedInput.bullpen.bullpenEra,
        bullpenUsageLastThreeDays:
          bullpenCache.bullpenUsageLastThreeDays ?? resolvedInput.bullpen.bullpenUsageLastThreeDays,
        isTopRelieverAvailable: bullpenCache.isTopRelieverAvailable,
      },
    };
  }

  // ── Required field validation ────────────────────────────────────────────────
  const missingFields: string[] = [];
  if (!resolvedInput.playerId) missingFields.push("playerId");
  if (!resolvedInput.playerName) missingFields.push("playerName");
  if (!resolvedInput.team) missingFields.push("team");
  if (!resolvedInput.market) missingFields.push("market");
  if (resolvedInput.bookLine == null) missingFields.push("bookLine");
  const validationWarnings = missingFields.map((f) => `MISSING_FIELD:${f}`);

  const output = calculator(resolvedInput);

  if (validationWarnings.length > 0) {
    output.warnings.push(...validationWarnings);
  }

  return output;
}
