import type {
  MLBPropInput,
  MLBPropOutput,
  MLBMarket,
  MLBConfidenceTier,
  MLBRecommendedSide,
  ProjectionLog,
} from "./types";
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
} from "./featureEngineering";
import { projectBaseValue } from "./projections";
import { computeRawProbability, clampProjection, clampProbability } from "./probability";
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

// ── Tier 1 markets (high priority, standard composite threshold) ──────────────
const TIER1_MARKETS = new Set<MLBMarket>(["hits", "total_bases", "batter_strikeouts", "pitcher_strikeouts"]);
// ── Tier 3 markets (home runs / HRR, stricter composite threshold) ────────────
const TIER3_MARKETS = new Set<MLBMarket>(["home_runs", "hrr"]);

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

function buildOutput(input: MLBPropInput): MLBPropOutput {
  const projResult = projectBaseValue(input);
  const safeProjection = clampProjection(projResult.projection);

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
  let confidenceTier = determineConfidenceTier(edge);
  let recommendedSide = determineSide(calibratedSided, confidenceTier);

  const warnings = [...projResult.warnings];

  if (isExperimental) {
    confidenceTier = capConfidenceTier(confidenceTier, EXPERIMENTAL_CONFIDENCE_CEILING);
    recommendedSide = determineSide(calibratedSided, confidenceTier);
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
  };
}

export function calculateHitsEdge(input: MLBPropInput): MLBPropOutput {
  const hitsInput = { ...input, market: "hits" as MLBMarket };

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
  let recommendedSide = determineSide(calibratedSided, confidenceTier);

  const adjustedProjection = clampProjection(expectedHits + currentHits);

  const projResult = projectBaseValue(hitsInput);
  const warnings = [...projResult.warnings];

  if (isExperimental) {
    confidenceTier = capConfidenceTier(confidenceTier, EXPERIMENTAL_CONFIDENCE_CEILING);
    recommendedSide = determineSide(calibratedSided, confidenceTier);
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

export function calculateBatterKEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "batter_strikeouts" });
}

export function calculatePitcherKEdge(input: MLBPropInput): MLBPropOutput {
  return buildOutput({ ...input, market: "pitcher_strikeouts" });
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

const MARKET_CALCULATORS: Record<MLBMarket, (input: MLBPropInput) => MLBPropOutput> = {
  hits: calculateHitsEdge,
  total_bases: calculateTBEdge,
  batter_strikeouts: calculateBatterKEdge,
  pitcher_strikeouts: calculatePitcherKEdge,
  hits_allowed: calculateHitsAllowedEdge,
  walks_allowed: calculateWalksAllowedEdge,
  home_runs: calculateHREdge,
  hrr: calculateHRREdge,
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
