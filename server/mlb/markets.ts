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
import { isDeepFly } from "./statcastXBA";
import { mlbGameCache } from "./dataPullService";
import { buildHRSignal } from "./HRSignalBuilder";

const selfLearningCalibration: Record<string, { shrinkFactor: number; sampleSize: number; lastUpdated: number }> = {};
const CALIBRATION_REFRESH_MS = 30 * 60 * 1000;
const DEFAULT_SHRINK = 0.96;

export function updateSelfLearningCalibration(market: string, hitRate: number, expectedRate: number, sampleSize: number): void {
  if (sampleSize < 10) return;
  const error = hitRate - expectedRate;
  let adjustment = 1.0;
  if (Math.abs(error) > 0.05) {
    adjustment = error > 0 ? Math.min(1.04, 1 + error * 0.3) : Math.max(0.88, 1 + error * 0.3);
  }
  const newShrink = Math.max(0.85, Math.min(1.02, DEFAULT_SHRINK * adjustment));
  selfLearningCalibration[market] = { shrinkFactor: newShrink, sampleSize, lastUpdated: Date.now() };
  console.log(`[MLB SELF_LEARN] market=${market} hitRate=${(hitRate * 100).toFixed(1)}% expected=${(expectedRate * 100).toFixed(1)}% error=${(error * 100).toFixed(1)}% shrink=${newShrink.toFixed(4)} samples=${sampleSize}`);
}

export function getSelfLearningShrink(market: MLBMarket): number {
  const entry = selfLearningCalibration[market];
  if (!entry || Date.now() - entry.lastUpdated > CALIBRATION_REFRESH_MS * 3) return DEFAULT_SHRINK;
  return entry.shrinkFactor;
}

export function getSelfLearningStats(): Record<string, { shrinkFactor: number; sampleSize: number }> {
  const result: Record<string, { shrinkFactor: number; sampleSize: number }> = {};
  for (const [k, v] of Object.entries(selfLearningCalibration)) {
    result[k] = { shrinkFactor: v.shrinkFactor, sampleSize: v.sampleSize };
  }
  return result;
}

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
import { estimatePADistribution, estimateRichPADistribution, estimateRichBFDistribution } from "./paDistribution";
import {
  baseProbability,
  applyPitcherModifier,
  applyParkModifier,
  applyBullpenModifier,
  applyWeatherModifier,
  applyXBAModifier,
  applyXSLGModifier,
} from "./hitProbabilityModel";
import {
  computeHitRate,
  computeHitTypeDistribution,
  computeKRatePerBF,
  computeHRRatePerPA,
  determineProjectionSource,
  determineProjectionQuality,
  computeTrustScore,
} from "./eventRates";
import {
  computeHitCountDistribution,
  computeTBDistribution,
  computeKCountDistribution,
  computeHRDistribution,
} from "./outcomeDistribution";
import type { ProjectionSource, ProjectionQuality, DistributionModelMethod } from "./types";
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
  computePitcherAnalysisScores,
  generatePitcherSignals,
  type FeatureLayer,
} from "./featureEngineering";
import { projectBaseValue } from "./projections";
import { clampProjection, clampProbability } from "./probability";
import { computeFullModelProbability, computeModelProbability } from "./probabilityEngine";
import type { FullProbabilityResult } from "./probabilityEngine";

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

function computeBatterOverConfidence(
  features: FeatureLayer,
  lei: MLBPropInput["liveInterpretation"],
  badges: { positive: string[]; negative: string[] },
  oddsAge: number,
): MLBConfidenceTier {
  const formStrength = features.hotColdForm;

  const matchupStrength = 0.40 * features.handednessMatchup +
    0.35 * features.pitchBlendMatchup + 0.25 * (features as any).bvp;
  const safeMatchup = Number.isFinite(matchupStrength) ? matchupStrength : 0.40 * features.handednessMatchup + 0.35 * features.pitchBlendMatchup + 0.25 * 0.5;

  const parkBoost = features.parkEnv;

  let leiStrength = 0.5;
  if (lei) {
    leiStrength = Math.min(1, 0.5 +
      lei.contactScore * 3 +
      lei.nearHrScore * 3 +
      lei.momentumScore * 3 +
      lei.pitcherFatigueScore * 2 +
      lei.veloDropScore * 2
    );
  }

  const contactStrength = features.contactQuality;

  const score =
    0.25 * leiStrength +
    0.20 * safeMatchup +
    0.20 * contactStrength +
    0.15 * formStrength +
    0.10 * parkBoost +
    0.10 * Math.max(0, 1 - oddsAge / 600_000);

  if (score >= 0.72) return "ELITE";
  if (score >= 0.55) return "STRONG";
  if (score >= 0.38) return "LEAN";
  return "NO_EDGE";
}

function determineConfidenceTier(
  edge: number,
  features?: FeatureLayer,
  badges?: { positive: string[]; negative: string[] },
  oddsAge?: number,
  market?: MLBMarket,
  side?: string,
  lei?: MLBPropInput["liveInterpretation"],
): MLBConfidenceTier {
  const isBatterOver = market && side === "OVER" &&
    ["hits", "total_bases", "home_runs", "hrr", "batter_strikeouts"].includes(market);

  if (isBatterOver && features && badges) {
    return computeBatterOverConfidence(features, lei, badges, oddsAge ?? 0);
  }

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

const BATTER_OVER_SIDE_MARKETS: MLBMarket[] = ["hits", "total_bases", "home_runs", "hrr", "batter_strikeouts"];
// Positive-skew markets: HR/HRR have raw P(over) ≈ 15-30% even for hot batters
// (because a single AB satisfies OVER), so we always emit OVER and let the
// existing HR_VS_ELITE_PITCHER bypass + 40% floor in qualifySignal route
// borderline candidates into Pre-AB Watch. HR UNDER is unplayable juice.
const BATTER_OVER_POSITIVE_SKEW: MLBMarket[] = ["home_runs", "hrr"];

function determineSide(
  calibratedProb: number,
  tier: MLBConfidenceTier,
  isOverFavored: boolean = true,
  market?: MLBMarket,
): MLBRecommendedSide {
  if (market && BATTER_OVER_SIDE_MARKETS.includes(market)) {
    // Phase B diagnosis: previously returned "OVER" unconditionally for ALL
    // batter_over markets. For HR/HRR (positive-skew, single-event payoff)
    // that's correct — raw P(over) is naturally low and the qualifier's
    // HR_VS_ELITE_PITCHER bypass routes survivors to Pre-AB Watch. But for
    // hits/total_bases/batter_strikeouts the OVER probability mass is near
    // 50% on actually-playable signals, so emitting OVER when the math
    // says UNDER is favored just produces 40% floor noise (35/36 reject
    // rate observed). Drop those cleanly to NO_EDGE rather than flagging
    // a contradiction the firewall has to passthrough. Floor unchanged;
    // HR/HRR pipeline unchanged.
    if (BATTER_OVER_POSITIVE_SKEW.includes(market)) {
      return "OVER";
    }
    if (tier === "NO_EDGE") return "NO_EDGE";
    return isOverFavored ? "OVER" : "NO_EDGE";
  }
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

function calibrateDistributionProb(rawProb: number, market?: MLBMarket): number {
  const shifted = rawProb - 50;
  const shrink = market ? getSelfLearningShrink(market) : DEFAULT_SHRINK;
  let calibrated = 50 + shifted * shrink;
  calibrated = Math.min(96, Math.max(5, calibrated));
  if (market) {
    calibrated = applyProbabilityCeiling(calibrated, market);
  }
  return Math.round(calibrated * 100) / 100;
}


// ── Tier 1 markets (high priority, standard composite threshold) ──────────────
const TIER1_MARKETS = new Set<MLBMarket>(["hits", "total_bases", "hrr", "pitcher_strikeouts", "pitcher_outs"]);
const TIER3_MARKETS = new Set<MLBMarket>(["home_runs", "batter_strikeouts", "hr_allowed"]);

function checkSuppression(
  input: MLBPropInput,
  edge: number,
  market: MLBMarket,
  projection: number,
  side?: string
): { suppressed: boolean; reason: string | null } {
  const rules = SUPPRESSION_RULES[market];
  if (!rules) return { suppressed: false, reason: null };

  const isBatterOver = side === "OVER" &&
    ["hits", "total_bases", "home_runs", "hrr", "batter_strikeouts"].includes(market);

  const gap = Math.abs(projection - input.bookLine);
  const minGap = MLB_MARKET_MIN_GAP[market];
  const effectiveMinGap = isBatterOver ? minGap * 0.5 : minGap;
  if (gap < effectiveMinGap) {
    return {
      suppressed: true,
      reason: `Projection gap ${gap.toFixed(3)} below required ${effectiveMinGap.toFixed(3)} for ${market}`,
    };
  }

  if (!isBatterOver && Math.abs(edge) < rules.minEdge) {
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

  if (isBatterOver) {
    return { suppressed: false, reason: null };
  }

  const isPitcherMarket = market === "pitcher_strikeouts" || market === "pitcher_outs" || market === "hits_allowed" || market === "walks_allowed" || market === "hr_allowed";
  if (!isPitcherMarket) {
    const composite = compositeHitterScore(input);
    const hasContactData = input.contactQuality.exitVelocity !== null || input.contactQuality.hardHitRateSeason !== null;
    const degradedMultiplier = hasContactData ? 1.0 : 0.5;
    const tier3Gate = COMPOSITE_TIER3_THRESHOLD * degradedMultiplier;
    const tier1Gate = COMPOSITE_TIER1_THRESHOLD * degradedMultiplier;
    if (TIER3_MARKETS.has(market) && composite < tier3Gate) {
      return {
        suppressed: true,
        reason: `${market} requires composite score ≥ ${tier3Gate.toFixed(2)} (got ${composite.toFixed(2)})`,
      };
    }
    if (TIER1_MARKETS.has(market) && composite < tier1Gate) {
      return {
        suppressed: true,
        reason: `${market} requires composite score ≥ ${tier1Gate.toFixed(2)} (got ${composite.toFixed(2)})`,
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

  const deepFlys = priorABs.filter((ab) => ab.outcome === "out" && isDeepFly(ab.launchAngle ?? null, ab.distance ?? null));
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
        0.08 * features.lineupOpportunity +
        0.02 * batSpeed.batSpeedPowerScore;
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
        0.14 * batSpeed.batSpeedPowerScore +
        0.16 * features.handednessMatchup +
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
        0.18 * batSpeed.batSpeedPowerScore +
        0.12 * computeSpecParkEnv(input, "hr") +
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

      const chaseRate = input.contactQuality.hardHitRateSeason != null ? Math.max(0, 1 - input.contactQuality.hardHitRateSeason) : 0.5;
      const aggressionRisk = batSpeed.batSpeedZ * whiffRate * chaseRate;
      const adjustedKExposure = batterKExposure * (1 + 0.08 * aggressionRisk);
      if (batSpeed.batSpeedZ > 1 && whiffRate > 0.5) {
        featureMultiplier *= 1.05;
      }
      const pitcherPutaway =
        0.30 * Math.min(1, (input.pitcher.kPer9 ?? 8) / 12) +
        0.22 * (input.pitcher.whip != null ? 1 - Math.min(1, input.pitcher.whip / 1.5) : 0.5) +
        0.16 * computeSpecPitchBlendMatchup(input, "whiff") +
        0.12 * features.handednessMatchup +
        0.10 * Math.min(1, (input.pitcher.kPer9 ?? 8) / 10) +
        0.10 * features.pitcherSuppression;
      featureMultiplier = (0.5 + adjustedKExposure) * (0.5 + pitcherPutaway);
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

interface DistributionParams {
  adjustedRate?: number;
  remainingPA?: number;
  currentStatValue?: number;
  paDistribution?: Record<number, number>;
}

function buildOutput(input: MLBPropInput, distParams?: DistributionParams): MLBPropOutput {
  const features = computeFullFeatureLayer(input);
  const projResult = projectBaseValue(input);
  const featureAdjustedProjection = applyMarketFeatureWeights(
    projResult.projection, features, input.market, input
  );
  const safeProjection = clampProjection(featureAdjustedProjection);

  const isExperimental = EXPERIMENTAL_MARKETS.includes(input.market);

  const probResult: FullProbabilityResult = computeFullModelProbability(
    {
      projection: safeProjection,
      threshold: input.bookLine,
      market: input.market,
      // [MLB Phase 1.5] Forwarded for diagnostic logging only — does not
      // affect probability math.
      playerName: input.playerName,
      ...(distParams?.adjustedRate != null ? { adjustedRate: distParams.adjustedRate } : {}),
      ...(distParams?.remainingPA != null ? { remainingPA: distParams.remainingPA } : {}),
      ...(distParams?.currentStatValue != null ? { currentStatValue: distParams.currentStatValue } : {}),
      ...(distParams?.paDistribution ? { paDistribution: distParams.paDistribution } : {}),
      // [MLB Phase 3B] HRR wrapper — pass batter contactQuality from the
      // feature layer. The wrapper compresses HRR > 82 unless contactScore
      // >= 0.65 justifies the high probability.
      ...(input.market === "hrr" ? { hrrJustification: { contactScore: features.contactQuality } } : {}),
      // [MLB Phase 3B] hits_allowed wrapper — pass pitcher pitch count, TTO,
      // and the opponent contact-quality (which is the contact-allowed proxy
      // for the pitcher side of the matchup).
      ...(input.market === "hits_allowed" ? {
        pitcherFatigue: {
          pitchCount: input.pitcher?.pitchCount,
          timesThrough: input.pitcher?.timesThrough,
          contactAllowedScore: features.contactQuality,
        }
      } : {}),
    },
    null,
    input.market,
    false,
    isExperimental
  );

  const rawProbabilityOver = probResult.rawOverProbability;
  const rawProbabilityUnder = probResult.rawUnderProbability;
  const dominantRawProb = probResult.dominantRawProbability;
  let calibratedProbabilityOver = probResult.calibratedOverProbability;
  const calibratedProbabilityUnder = probResult.calibratedUnderProbability;
  const calibratedDominant = probResult.dominantCalibratedProbability;
  const isOverFavored = probResult.isOverFavored;

  const BATTER_MARKETS: string[] = ["hits", "total_bases", "home_runs", "hrr", "batter_strikeouts"];
  if (BATTER_MARKETS.includes(input.market) && input.liveInterpretation?.confidenceBoost) {
    const boost = input.liveInterpretation.confidenceBoost;
    const boostPts = boost * 100;
    const capped = Math.min(boostPts, 8);
    // Respect engine ceiling: probabilityEngine.applyModelSafetyCeiling owns the
    // absolute cap. The live confidence boost may not push us above the same
    // market ceiling the engine already used.
    const engineCeiling = MARKET_PROBABILITY_CAPS[input.market] ?? 95;
    calibratedProbabilityOver = Math.min(engineCeiling, calibratedProbabilityOver + capped);
  }

  const isBatterOverCalc = BATTER_MARKETS.includes(input.market);
  const calibratedSided = isBatterOverCalc
    ? calibratedProbabilityOver
    : (isOverFavored ? calibratedProbabilityOver : calibratedProbabilityUnder);

  const bookImplied = computeBookImplied(input, isBatterOverCalc ? true : isOverFavored);
  const edge = calibratedSided - bookImplied;
  const badgeResult = computeBadges(input, features);
  const oddsAge = input.oddsUpdatedAt ? Date.now() - input.oddsUpdatedAt : 0;
  const isOverForTier = BATTER_MARKETS.includes(input.market) ? "OVER" : (isOverFavored ? "OVER" : "UNDER");
  let confidenceTier = determineConfidenceTier(edge, features, badgeResult, oddsAge, input.market, isOverForTier, input.liveInterpretation);
  let recommendedSide = determineSide(calibratedSided, confidenceTier, isOverFavored, input.market);

  const warnings = [...projResult.warnings];

  if (isExperimental) {
    confidenceTier = capConfidenceTier(confidenceTier, EXPERIMENTAL_CONFIDENCE_CEILING);
    recommendedSide = determineSide(calibratedSided, confidenceTier, isOverFavored, input.market);
    warnings.push(`${input.market} is experimental — confidence capped at ${EXPERIMENTAL_CONFIDENCE_CEILING}`);
  }

  const suppression = checkSuppression(input, edge, input.market, safeProjection, isOverForTier);

  const isBatterOverPassthrough = BATTER_OVER_SIDE_MARKETS.includes(input.market);
  if (suppression.suppressed && !isBatterOverPassthrough) {
    confidenceTier = "NO_EDGE";
    recommendedSide = "NO_EDGE";
  }

  const finalEdge = (suppression.suppressed && !isBatterOverPassthrough) ? 0 : Math.round(edge * 100) / 100;

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

  const isPitcherMkt = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"].includes(input.market);
  const pitcherAnalysisResult = isPitcherMkt ? computePitcherAnalysisScores(input) : undefined;
  const pitcherSignalsResult = isPitcherMkt && pitcherAnalysisResult ? generatePitcherSignals(input, pitcherAnalysisResult) : undefined;

  const projSource = determineProjectionSource(input);
  const projQuality = determineProjectionQuality(projSource, input);
  const trustScore = computeTrustScore(projQuality, projSource, projResult.fallbackUsed);

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
    safetyCeilingApplied: probResult.ceilingApplied,
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
    pitcherAnalysis: pitcherAnalysisResult ? {
      stuff: Math.round(pitcherAnalysisResult.stuff * 100),
      command: Math.round(pitcherAnalysisResult.command * 100),
      swingMiss: Math.round(pitcherAnalysisResult.swingMiss * 100),
      fatigue: Math.round(pitcherAnalysisResult.fatigue * 100),
      contactSuppression: Math.round(pitcherAnalysisResult.contactSuppression * 100),
      matchup: Math.round(pitcherAnalysisResult.matchup * 100),
      context: Math.round(pitcherAnalysisResult.context * 100),
    } : undefined,
    pitcherSignals: pitcherSignalsResult,
    computedBadges: badgeResult.positive,
    computedRiskFlags: badgeResult.negative,
    fallbackUsed: projResult.fallbackUsed,
    projectionSource: projSource,
    projectionQuality: projQuality,
    projectionTrustScore: trustScore,
    modelMethod: probResult.method as DistributionModelMethod,
  };
}

export function calculateHitsEdge(input: MLBPropInput): MLBPropOutput {
  const hitsInput = { ...input, market: "hits" as MLBMarket };

  const features = computeFullFeatureLayer(hitsInput);
  const currentHits = hitsInput.currentStatValue ?? 0;

  const adjustedRate = computeHitRate(hitsInput);

  const paDist = estimateRichPADistribution(
    hitsInput.inning,
    hitsInput.lineup.battingOrderSlot,
    hitsInput.currentRuns ?? 4.5,
    hitsInput.leagueAvgRuns ?? 4.5,
    hitsInput.isTopInning
  );

  const distResult = computeHitCountDistribution(paDist, adjustedRate, currentHits, hitsInput.bookLine);

  const rawOverProb = distResult.overProbability;
  const rawUnderProb = distResult.underProbability;
  const isOverFavored = rawOverProb >= rawUnderProb;
  const dominantRaw = Math.max(rawOverProb, rawUnderProb);

  const projSource = determineProjectionSource(hitsInput);
  const projQuality = determineProjectionQuality(projSource, hitsInput);
  const projResult = projectBaseValue(hitsInput);
  const trustScore = computeTrustScore(projQuality, projSource, projResult.fallbackUsed);

  const calibratedOver = calibrateDistributionProb(rawOverProb, "hits");
  const calibratedUnder = calibrateDistributionProb(rawUnderProb, "hits");
  const calibratedDominant = Math.max(calibratedOver, calibratedUnder);
  const calibratedSided = calibratedOver;

  const bookImplied = computeBookImplied(hitsInput, true);
  const edge = calibratedSided - bookImplied;
  const badgeResult = computeBadges(hitsInput, features);
  const oddsAge = hitsInput.oddsUpdatedAt ? Date.now() - hitsInput.oddsUpdatedAt : 0;
  let confidenceTier = determineConfidenceTier(edge, features, badgeResult, oddsAge, "hits", "OVER", hitsInput.liveInterpretation);
  let recommendedSide = determineSide(calibratedSided, confidenceTier, isOverFavored, "hits");

  const warnings = [...projResult.warnings];
  const adjustedProjection = clampProjection(distResult.expectedHits);

  const suppression = checkSuppression(hitsInput, edge, "hits", adjustedProjection, "OVER");
  const hitsIsBatterOver = true;
  const finalEdge = (suppression.suppressed && !hitsIsBatterOver) ? 0 : Math.round(edge * 100) / 100;
  if (suppression.suppressed && !hitsIsBatterOver) {
    confidenceTier = "NO_EDGE";
    recommendedSide = "NO_EDGE";
  }

  if (projQuality === "LOW" && confidenceTier === "ELITE") {
    confidenceTier = "STRONG";
    warnings.push("TRUST_GATE: LOW quality cannot surface ELITE");
  }

  const completeProjectionLog: ProjectionLog = {
    ...projResult.projectionLog,
    rawProbability: Math.round(dominantRaw * 100) / 100,
    calibratedProbability: Math.round(calibratedDominant * 100) / 100,
    confidenceTier,
    modeUsed: projResult.mode === "early_explosive" ? "EARLY_EXPLOSIVE" : "STANDARD",
  };

  const explanationBullets = buildExplanationBullets(hitsInput, { mode: projResult.mode, isExperimental: false });

  const rpa = Object.entries(paDist).reduce((s, [k, v]) => s + Number(k) * v, 0);
  const legacyPaDist = estimatePADistribution(
    hitsInput.inning, hitsInput.lineup.battingOrderSlot,
    hitsInput.currentRuns ?? 4.5, hitsInput.leagueAvgRuns ?? 4.5
  );

  const nowTs = Date.now();
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
    rawProbabilityOver: Math.round(rawOverProb * 100) / 100,
    rawProbabilityUnder: Math.round(rawUnderProb * 100) / 100,
    calibratedProbabilityOver: Math.round(calibratedOver * 100) / 100,
    calibratedProbabilityUnder: Math.round(calibratedUnder * 100) / 100,
    rawProbability: Math.round(dominantRaw * 100) / 100,
    calibratedProbability: Math.round(calibratedDominant * 100) / 100,
    edge: finalEdge,
    recommendedSide,
    confidenceTier,
    safetyCeilingApplied: false,
    mode: projResult.mode,
    completedAB: hitsInput.completedAB,
    twoABRuleSatisfied: projResult.twoABRuleSatisfied,
    expectedHits: parseFloat((distResult.expectedHits - currentHits).toFixed(2)),
    remainingPA: rpa,
    adjustedHitRate: parseFloat(adjustedRate.toFixed(4)),
    bookImplied: Math.round(bookImplied * 100) / 100,
    paDistribution: legacyPaDist,
    isExperimental: false,
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
    computedBadges: badgeResult.positive,
    computedRiskFlags: badgeResult.negative,
    fallbackUsed: projResult.fallbackUsed,
    projectionSource: projSource,
    projectionQuality: projQuality,
    projectionTrustScore: trustScore,
    modelMethod: "hit_distribution",
    variance: Math.round(distResult.variance * 1000) / 1000,
  };
}

export function calculateTBEdge(input: MLBPropInput): MLBPropOutput {
  const tbInput = { ...input, market: "total_bases" as MLBMarket };
  const features = computeFullFeatureLayer(tbInput);
  const currentTB = tbInput.currentStatValue ?? 0;

  const hitRate = computeHitRate(tbInput);
  const hitTypeSplits = computeHitTypeDistribution(tbInput);

  const paDist = estimateRichPADistribution(
    tbInput.inning,
    tbInput.lineup.battingOrderSlot,
    tbInput.currentRuns ?? 4.5,
    tbInput.leagueAvgRuns ?? 4.5,
    tbInput.isTopInning
  );

  const distResult = computeTBDistribution(paDist, hitRate, hitTypeSplits, currentTB, tbInput.bookLine);

  const rawOverProb = distResult.overProbability;
  const rawUnderProb = distResult.underProbability;
  const isOverFavored = rawOverProb >= rawUnderProb;
  const dominantRaw = Math.max(rawOverProb, rawUnderProb);

  const projSource = determineProjectionSource(tbInput);
  const projQuality = determineProjectionQuality(projSource, tbInput);
  const projResult = projectBaseValue(tbInput);
  const trustScore = computeTrustScore(projQuality, projSource, projResult.fallbackUsed);

  const calibratedOver = calibrateDistributionProb(rawOverProb, "total_bases");
  const calibratedUnder = calibrateDistributionProb(rawUnderProb, "total_bases");
  const calibratedDominant = Math.max(calibratedOver, calibratedUnder);
  const calibratedSided = calibratedOver;

  const bookImplied = computeBookImplied(tbInput, true);
  const edge = calibratedSided - bookImplied;
  const badgeResult = computeBadges(tbInput, features);
  const oddsAge = tbInput.oddsUpdatedAt ? Date.now() - tbInput.oddsUpdatedAt : 0;
  let confidenceTier = determineConfidenceTier(edge, features, badgeResult, oddsAge, "total_bases", "OVER", tbInput.liveInterpretation);
  let recommendedSide = determineSide(calibratedSided, confidenceTier, isOverFavored, "total_bases");

  const warnings = [...projResult.warnings];
  const adjustedProjection = clampProjection(distResult.expectedTB);

  const suppression = checkSuppression(tbInput, edge, "total_bases", adjustedProjection, "OVER");
  const tbIsBatterOver = true;
  const finalEdge = (suppression.suppressed && !tbIsBatterOver) ? 0 : Math.round(edge * 100) / 100;
  if (suppression.suppressed && !tbIsBatterOver) {
    confidenceTier = "NO_EDGE";
    recommendedSide = "NO_EDGE";
  }

  if (projQuality === "LOW" && confidenceTier === "ELITE") {
    confidenceTier = "STRONG";
    warnings.push("TRUST_GATE: LOW quality cannot surface ELITE");
  }

  const completeProjectionLog: ProjectionLog = {
    ...projResult.projectionLog,
    rawProbability: Math.round(dominantRaw * 100) / 100,
    calibratedProbability: Math.round(calibratedDominant * 100) / 100,
    confidenceTier,
    modeUsed: projResult.mode === "early_explosive" ? "EARLY_EXPLOSIVE" : "STANDARD",
  };

  const explanationBullets = buildExplanationBullets(tbInput, { mode: projResult.mode, isExperimental: false });
  const rpa = Object.entries(paDist).reduce((s, [k, v]) => s + Number(k) * v, 0);

  const nowTs = Date.now();
  return {
    market: "total_bases",
    playerId: tbInput.playerId,
    playerName: tbInput.playerName,
    gameId: tbInput.gameId,
    projection: parseFloat(adjustedProjection.toFixed(3)),
    bookLine: tbInput.bookLine,
    overOdds: tbInput.overOdds ?? null,
    underOdds: tbInput.underOdds ?? null,
    modifiers: projResult.modifiers,
    projectionLog: completeProjectionLog,
    rawProbabilityOver: Math.round(rawOverProb * 100) / 100,
    rawProbabilityUnder: Math.round(rawUnderProb * 100) / 100,
    calibratedProbabilityOver: Math.round(calibratedOver * 100) / 100,
    calibratedProbabilityUnder: Math.round(calibratedUnder * 100) / 100,
    rawProbability: Math.round(dominantRaw * 100) / 100,
    calibratedProbability: Math.round(calibratedDominant * 100) / 100,
    edge: finalEdge,
    recommendedSide,
    confidenceTier,
    safetyCeilingApplied: false,
    mode: projResult.mode,
    completedAB: tbInput.completedAB,
    twoABRuleSatisfied: projResult.twoABRuleSatisfied,
    expectedHits: parseFloat((distResult.expectedTB - currentTB).toFixed(2)),
    remainingPA: rpa,
    adjustedHitRate: parseFloat(hitRate.toFixed(4)),
    bookImplied: Math.round(bookImplied * 100) / 100,
    isExperimental: false,
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
    formIndicator: classifyForm(tbInput),
    formScore: Math.round(computeFormScore(tbInput) * 100) / 100,
    evPct: Math.round((calibratedDominant / 100 - 0.5) * 100 * 10) / 10,
    contextScore: Math.round(computeStrongContextScore(tbInput) * 100) / 100,
    matchupTag: tbInput.pitcher.timesThrough >= 3 ? "vs 3rd Time Through" : tbInput.pitcher.pitchCount >= 80 ? "vs Fatigue" : tbInput.pitcher.throws ? `vs ${tbInput.pitcher.throws}HP` : null,
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
    computedBadges: badgeResult.positive,
    computedRiskFlags: badgeResult.negative,
    fallbackUsed: projResult.fallbackUsed,
    projectionSource: projSource,
    projectionQuality: projQuality,
    projectionTrustScore: trustScore,
    modelMethod: "tb_distribution",
    variance: Math.round(distResult.variance * 1000) / 1000,
  };
}

export function calculatePitcherKEdge(input: MLBPropInput): MLBPropOutput {
  const kInput = { ...input, market: "pitcher_strikeouts" as MLBMarket };
  const features = computeFullFeatureLayer(kInput);
  const currentK = kInput.currentStatValue ?? 0;

  const kRatePerBF = computeKRatePerBF(kInput);

  const bfDist = estimateRichBFDistribution(
    kInput.inning,
    kInput.pitcher.pitchCount,
    kInput.pitcher.kPer9 ?? 8.5,
    kInput.pitcher.timesThrough,
    kInput.pitcher.managerLeashShort
  );

  const distResult = computeKCountDistribution(bfDist, kRatePerBF, currentK, kInput.bookLine);

  const rawOverProb = distResult.overProbability;
  const rawUnderProb = distResult.underProbability;
  const isOverFavored = rawOverProb >= rawUnderProb;
  const dominantRaw = Math.max(rawOverProb, rawUnderProb);

  const projSource = determineProjectionSource(kInput);
  const projQuality = determineProjectionQuality(projSource, kInput);
  const projResult = projectBaseValue(kInput);
  const trustScore = computeTrustScore(projQuality, projSource, projResult.fallbackUsed);

  const calibratedOver = calibrateDistributionProb(rawOverProb, "pitcher_strikeouts");
  const calibratedUnder = calibrateDistributionProb(rawUnderProb, "pitcher_strikeouts");
  const calibratedDominant = Math.max(calibratedOver, calibratedUnder);
  const calibratedSided = isOverFavored ? calibratedOver : calibratedUnder;

  const bookImplied = computeBookImplied(kInput, isOverFavored);
  const edge = calibratedSided - bookImplied;
  const badgeResult = computeBadges(kInput, features);
  const oddsAge = kInput.oddsUpdatedAt ? Date.now() - kInput.oddsUpdatedAt : 0;
  let confidenceTier = determineConfidenceTier(edge, features, badgeResult, oddsAge, "pitcher_strikeouts", isOverFavored ? "OVER" : "UNDER", kInput.liveInterpretation);
  let recommendedSide = determineSide(calibratedSided, confidenceTier, isOverFavored, "pitcher_strikeouts");

  const warnings = [...projResult.warnings];
  const adjustedProjection = clampProjection(distResult.expectedK);

  const suppression = checkSuppression(kInput, edge, "pitcher_strikeouts", adjustedProjection, isOverFavored ? "OVER" : "UNDER");
  const finalEdge = suppression.suppressed ? 0 : Math.round(edge * 100) / 100;
  if (suppression.suppressed) {
    confidenceTier = "NO_EDGE";
    recommendedSide = "NO_EDGE" as MLBRecommendedSide;
  }

  if (projQuality === "LOW" && confidenceTier === "ELITE") {
    confidenceTier = "STRONG";
    warnings.push("TRUST_GATE: LOW quality cannot surface ELITE");
  }

  const completeProjectionLog: ProjectionLog = {
    ...projResult.projectionLog,
    rawProbability: Math.round(dominantRaw * 100) / 100,
    calibratedProbability: Math.round(calibratedDominant * 100) / 100,
    confidenceTier,
    modeUsed: projResult.mode === "early_explosive" ? "EARLY_EXPLOSIVE" : "STANDARD",
  };

  const explanationBullets = buildExplanationBullets(kInput, { mode: projResult.mode, isExperimental: false });
  const meanBF = Object.entries(bfDist).reduce((s, [k, v]) => s + Number(k) * v, 0);

  const nowTs = Date.now();
  return {
    market: "pitcher_strikeouts",
    playerId: kInput.playerId,
    playerName: kInput.playerName,
    gameId: kInput.gameId,
    projection: parseFloat(adjustedProjection.toFixed(3)),
    bookLine: kInput.bookLine,
    overOdds: kInput.overOdds ?? null,
    underOdds: kInput.underOdds ?? null,
    modifiers: projResult.modifiers,
    projectionLog: completeProjectionLog,
    rawProbabilityOver: Math.round(rawOverProb * 100) / 100,
    rawProbabilityUnder: Math.round(rawUnderProb * 100) / 100,
    calibratedProbabilityOver: Math.round(calibratedOver * 100) / 100,
    calibratedProbabilityUnder: Math.round(calibratedUnder * 100) / 100,
    rawProbability: Math.round(dominantRaw * 100) / 100,
    calibratedProbability: Math.round(calibratedDominant * 100) / 100,
    edge: finalEdge,
    recommendedSide,
    confidenceTier,
    safetyCeilingApplied: false,
    mode: projResult.mode,
    completedAB: kInput.completedAB,
    twoABRuleSatisfied: projResult.twoABRuleSatisfied,
    expectedHits: parseFloat((distResult.expectedK - currentK).toFixed(2)),
    remainingPA: meanBF,
    adjustedHitRate: parseFloat(kRatePerBF.toFixed(4)),
    bookImplied: Math.round(bookImplied * 100) / 100,
    isExperimental: false,
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
    formIndicator: classifyForm(kInput),
    formScore: Math.round(computeFormScore(kInput) * 100) / 100,
    evPct: Math.round((calibratedDominant / 100 - 0.5) * 100 * 10) / 10,
    contextScore: Math.round(computeStrongContextScore(kInput) * 100) / 100,
    matchupTag: kInput.pitcher.timesThrough >= 3 ? "vs 3rd Time Through" : kInput.pitcher.pitchCount >= 80 ? "vs Fatigue" : kInput.pitcher.throws ? `vs ${kInput.pitcher.throws}HP` : null,
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
    pitcherAnalysis: (() => {
      const pa = computePitcherAnalysisScores(kInput);
      return {
        stuff: Math.round(pa.stuff * 100),
        command: Math.round(pa.command * 100),
        swingMiss: Math.round(pa.swingMiss * 100),
        fatigue: Math.round(pa.fatigue * 100),
        contactSuppression: Math.round(pa.contactSuppression * 100),
        matchup: Math.round(pa.matchup * 100),
        context: Math.round(pa.context * 100),
      };
    })(),
    pitcherSignals: (() => {
      const pa = computePitcherAnalysisScores(kInput);
      return generatePitcherSignals(kInput, pa);
    })(),
    computedBadges: badgeResult.positive,
    computedRiskFlags: badgeResult.negative,
    fallbackUsed: projResult.fallbackUsed,
    projectionSource: projSource,
    projectionQuality: projQuality,
    projectionTrustScore: trustScore,
    modelMethod: "pitcher_k_distribution",
    variance: Math.round(distResult.variance * 1000) / 1000,
  };
}

export function calculatePitcherOutsEdge(input: MLBPropInput): MLBPropOutput {
  const outsPerBatter = 0.65;
  const remainingBatters = Math.max(1, (input.remainingPA ?? 18));

  return buildOutput({ ...input, market: "pitcher_outs" }, {
    adjustedRate: outsPerBatter,
    remainingPA: remainingBatters,
    currentStatValue: input.currentStatValue ?? 0,
  });
}

export function calculateHitsAllowedEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "hits_allowed" });
}

export function calculateWalksAllowedEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "walks_allowed" });
}

export function calculateHREdge(input: MLBPropInput): MLBPropOutput {
  const hrInput = { ...input, market: "home_runs" as MLBMarket };
  const features = computeFullFeatureLayer(hrInput);
  const currentHR = hrInput.currentStatValue ?? 0;

  const hrBuild = buildHRSignal(hrInput);
  const hrRatePerPA = computeHRRatePerPA(hrInput);

  const paDist = estimateRichPADistribution(
    hrInput.inning,
    hrInput.lineup.battingOrderSlot,
    hrInput.currentRuns ?? 4.5,
    hrInput.leagueAvgRuns ?? 4.5,
    hrInput.isTopInning
  );

  const distResult = computeHRDistribution(paDist, hrRatePerPA, currentHR, hrInput.bookLine);

  const rawOverProb = distResult.overProbability;
  const rawUnderProb = distResult.underProbability;
  const isOverFavored = rawOverProb >= rawUnderProb;
  const dominantRaw = Math.max(rawOverProb, rawUnderProb);

  const projSource = determineProjectionSource(hrInput);
  const projQuality = determineProjectionQuality(projSource, hrInput);
  const projResult = projectBaseValue(hrInput);
  const trustScore = computeTrustScore(projQuality, projSource, projResult.fallbackUsed);

  const calibratedOver = calibrateDistributionProb(rawOverProb, "home_runs");
  const calibratedUnder = calibrateDistributionProb(rawUnderProb, "home_runs");
  const calibratedDominant = Math.max(calibratedOver, calibratedUnder);
  const calibratedSided = calibratedOver;

  const bookImplied = computeBookImplied(hrInput, true);
  const rawEdge = calibratedSided - bookImplied;
  const edge = rawEdge + hrBuild.boost;
  const badgeResult = computeBadges(hrInput, features);
  const oddsAge = hrInput.oddsUpdatedAt ? Date.now() - hrInput.oddsUpdatedAt : 0;
  let confidenceTier = determineConfidenceTier(edge, features, badgeResult, oddsAge, "home_runs", "OVER", hrInput.liveInterpretation);
  let recommendedSide = determineSide(calibratedSided, confidenceTier, isOverFavored, "home_runs");

  const warnings = [...projResult.warnings];
  const adjustedProjection = clampProjection(distResult.expectedHR);

  const suppression = checkSuppression(hrInput, edge, "home_runs", adjustedProjection, "OVER");
  const hrIsBatterOver = true;
  const finalEdge = (suppression.suppressed && !hrIsBatterOver) ? 0 : Math.round(edge * 100) / 100;
  if (suppression.suppressed && !hrIsBatterOver) {
    confidenceTier = "NO_EDGE";
    recommendedSide = "NO_EDGE";
  }

  if (projQuality === "LOW" && confidenceTier === "ELITE") {
    confidenceTier = "STRONG";
    warnings.push("TRUST_GATE: LOW quality cannot surface ELITE");
  }

  const completeProjectionLog: ProjectionLog = {
    ...projResult.projectionLog,
    rawProbability: Math.round(dominantRaw * 100) / 100,
    calibratedProbability: Math.round(calibratedDominant * 100) / 100,
    confidenceTier,
    modeUsed: projResult.mode === "early_explosive" ? "EARLY_EXPLOSIVE" : "STANDARD",
  };

  const explanationBullets = buildExplanationBullets(hrInput, { mode: projResult.mode, isExperimental: false });
  const rpa = Object.entries(paDist).reduce((s, [k, v]) => s + Number(k) * v, 0);

  const { factors: hrFactors } = meetsHRQualificationGate(hrInput);

  const nowTs = Date.now();
  return {
    market: "home_runs",
    playerId: hrInput.playerId,
    playerName: hrInput.playerName,
    gameId: hrInput.gameId,
    projection: parseFloat(adjustedProjection.toFixed(3)),
    bookLine: hrInput.bookLine,
    overOdds: hrInput.overOdds ?? null,
    underOdds: hrInput.underOdds ?? null,
    modifiers: projResult.modifiers,
    projectionLog: completeProjectionLog,
    rawProbabilityOver: Math.round(rawOverProb * 100) / 100,
    rawProbabilityUnder: Math.round(rawUnderProb * 100) / 100,
    calibratedProbabilityOver: Math.round(calibratedOver * 100) / 100,
    calibratedProbabilityUnder: Math.round(calibratedUnder * 100) / 100,
    rawProbability: Math.round(dominantRaw * 100) / 100,
    calibratedProbability: Math.round(calibratedDominant * 100) / 100,
    edge: finalEdge,
    recommendedSide,
    confidenceTier,
    safetyCeilingApplied: false,
    mode: projResult.mode,
    completedAB: hrInput.completedAB,
    twoABRuleSatisfied: projResult.twoABRuleSatisfied,
    expectedHits: parseFloat((distResult.expectedHR - currentHR).toFixed(2)),
    remainingPA: rpa,
    adjustedHitRate: parseFloat(hrRatePerPA.toFixed(4)),
    bookImplied: Math.round(bookImplied * 100) / 100,
    isExperimental: false,
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
    formIndicator: classifyForm(hrInput),
    formScore: Math.round(computeFormScore(hrInput) * 100) / 100,
    evPct: Math.round((calibratedDominant / 100 - 0.5) * 100 * 10) / 10,
    hrFactors: { count: hrFactors.count, labels: hrFactors.labels, build: hrBuild.factors, preHrDangerScore: hrBuild.preHrDangerScore, dangerFlags: hrBuild.dangerFlags },
    hrBuildScore: hrBuild.score,
    hrIntensity: hrBuild.intensity,
    contextScore: Math.round(computeStrongContextScore(hrInput) * 100) / 100,
    matchupTag: hrInput.pitcher.timesThrough >= 3 ? "vs 3rd Time Through" : hrInput.pitcher.pitchCount >= 80 ? "vs Fatigue" : hrInput.pitcher.throws ? `vs ${hrInput.pitcher.throws}HP` : null,
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
    computedBadges: badgeResult.positive,
    computedRiskFlags: badgeResult.negative,
    fallbackUsed: projResult.fallbackUsed,
    projectionSource: projSource,
    projectionQuality: projQuality,
    projectionTrustScore: trustScore,
    modelMethod: "hr_distribution",
    variance: Math.round(distResult.variance * 1000) / 1000,
  };
}

export function calculateHRREdge(input: MLBPropInput): MLBPropOutput {
  const hrrInput = { ...input, market: "hrr" as MLBMarket };
  const features = computeFullFeatureLayer(hrrInput);
  const currentHRR = hrrInput.currentStatValue ?? 0;

  const hitRate = computeHitRate(hrrInput);
  const rbiRate = input.atBats > 0
    ? Math.max(0.05, (input.hrrComponents?.currentRBIs ?? 0) / Math.max(1, input.atBats))
    : input.hrrComponents?.rbisRate ?? 0.12;
  const runRate = input.atBats > 0
    ? Math.max(0.05, (input.hrrComponents?.currentRuns ?? 0) / Math.max(1, input.atBats))
    : input.hrrComponents?.runsRate ?? 0.10;

  let hrrRate = hitRate + rbiRate + runRate;
  hrrRate = applyParkModifier(hrrRate, input.weatherPark.parkFactor);

  const pitcherVuln = features.pitcherSuppression < 0.3 ? 1.08 : features.pitcherSuppression > 0.7 ? 0.92 : 1.0;
  hrrRate *= pitcherVuln;

  if (features.contactQuality > 0.6) hrrRate *= 1 + 0.06 * features.contactQuality;
  if (features.hotColdForm > 0.3) hrrRate *= 1 + 0.04 * features.hotColdForm;
  if (features.lineupOpportunity > 0.5) hrrRate *= 1 + 0.03 * features.lineupOpportunity;

  hrrRate = Math.max(0.05, Math.min(1.5, hrrRate));

  const rpa = hrrInput.remainingPA ?? 2;

  return buildOutput(hrrInput, {
    adjustedRate: hrrRate,
    remainingPA: rpa,
    currentStatValue: currentHRR,
  });
}

export function calculateBatterStrikeoutsEdge(input: MLBPropInput): MLBPropOutput {
  const pitcherKRate = input.pitcher.kPer9 != null ? input.pitcher.kPer9 / (9 * 4.3) : 0.22;
  const rpa = input.remainingPA ?? 2;

  return buildOutput({ ...input, market: "batter_strikeouts" }, {
    adjustedRate: pitcherKRate,
    remainingPA: rpa,
    currentStatValue: input.currentStatValue ?? 0,
  });
}

export function calculateHRAllowedEdge(input: MLBPropInput): MLBPropOutput {
  const hrAllowedRate = 0.035;
  const remainingBatters = Math.max(1, (input.remainingPA ?? 18));

  return buildOutput({ ...input, market: "hr_allowed" }, {
    adjustedRate: hrAllowedRate,
    remainingPA: remainingBatters,
    currentStatValue: input.currentStatValue ?? 0,
  });
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
        avgBatSpeed: playerContact.avgBatSpeed ?? resolvedInput.contactQuality.avgBatSpeed,
        avgSwingLength: playerContact.avgSwingLength ?? resolvedInput.contactQuality.avgSwingLength,
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

  console.log(`[MLB_ENGINE] ${JSON.stringify({
    player: output.playerName,
    market: output.market,
    projection: Math.round(output.projection * 1000) / 1000,
    line: output.bookLine,
    probability: Math.round(output.calibratedProbability * 100) / 100,
    edge: Math.round(output.edge * 100) / 100,
    recommendedSide: output.recommendedSide,
    confidenceTier: output.confidenceTier,
    suppressed: output.suppressed,
  })}`);

  return output;
}
