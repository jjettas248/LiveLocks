import type { MLBPropInput, MLBPropOutput, MLBMarket } from "./types";
import { EXPERIMENTAL_MARKETS } from "./types";

export type MarketFamily = "batter_over" | "under" | "hr_radar";

const BATTER_OVER_MARKETS: MLBMarket[] = ["hits", "total_bases", "home_runs", "hrr", "batter_strikeouts"];

export function getMarketFamily(market: MLBMarket, side: string): MarketFamily | null {
  if (BATTER_OVER_MARKETS.includes(market) && side === "OVER") return "batter_over";
  if (side === "UNDER") return "under";
  const pitcherMarkets: MLBMarket[] = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"];
  if (pitcherMarkets.includes(market)) return "under";
  return null;
}

export type SignalConfidenceTier = "ELITE" | "STRONG" | "SOLID" | "WATCHLIST" | "NO_SIGNAL";

export interface SignalScoreBreakdown {
  probability: number;
  projection: number;
  liveContext: number;
  matchup: number;
  form: number;
  opportunity: number;
  marketReliability: number;
  priceValidation: number;
  eventBoost: number;
  total: number;
  confidenceTier: SignalConfidenceTier;
}

export type SignalTag =
  | "HOT OVER" | "COLD UNDER" | "HR WATCH" | "LIVE EDGE"
  | "STRONG MATCHUP" | "ATTACKABLE PITCHER" | "LIVE SIGNALS"
  | "HOT BATS" | "PITCHER ATTACKABLE" | "3RD INNING EDGE"
  | "5TH INNING EDGE" | "7TH INNING EDGE"
  | "STRONG CONTACT TREND" | "PITCHER FATIGUE RISING"
  | "VELOCITY DROP DETECTED" | "NEAR HR CONTACT DETECTED";

export type FeedTag = "edge_feed" | "inning_3" | "inning_5" | "inning_7" | "hr_radar" | "hr_watchlist";

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function scaleTo100(raw: number, min: number, max: number): number {
  if (max <= min) return 50;
  return clamp(((raw - min) / (max - min)) * 100, 0, 100);
}

function computeProbabilityComponent(engineProb: number): number {
  if (engineProb >= 75) return 100;
  if (engineProb >= 65) return 80;
  if (engineProb >= 60) return 65;
  if (engineProb >= 55) return 50;
  if (engineProb >= 50) return 35;
  return 20;
}

function computeProjectionComponent(projection: number, bookLine: number, market: MLBMarket, recommendedSide: string): number {
  const rawGap = projection - bookLine;
  const gap = recommendedSide === "UNDER" ? -rawGap : rawGap;
  const normalizedGap = market === "home_runs" || market === "hrr" || market === "hr_allowed"
    ? gap / 0.3
    : market === "pitcher_strikeouts" || market === "pitcher_outs"
      ? gap / 1.5
      : market === "batter_strikeouts"
        ? gap / 0.5
        : gap / 0.5;

  return clamp(50 + normalizedGap * 30, 0, 100);
}

function computeLiveContextComponent(input: MLBPropInput): number {
  let score = 50;

  if (input.inning >= 3 && input.inning <= 5) score += 10;
  else if (input.inning >= 6 && input.inning <= 7) score += 15;
  else if (input.inning >= 8) score += 5;

  if (input.pitcher.pitchCount >= 85) score += 15;
  else if (input.pitcher.pitchCount >= 60) score += 8;

  if (input.pitcher.timesThrough >= 3) score += 12;
  else if (input.pitcher.timesThrough >= 2) score += 5;

  if (input.pitcher.isPitcherCollapsing) score += 15;

  const hasContact = input.contactQuality.exitVelocity !== null;
  if (hasContact) {
    const ev = input.contactQuality.exitVelocity ?? 0;
    if (ev >= 100) score += 10;
    else if (ev >= 95) score += 5;
  }

  return clamp(score, 0, 100);
}

function computeMatchupComponent(input: MLBPropInput): number {
  let score = 50;

  if (input.bvpHistory && input.bvpHistory.atBats >= 5) {
    const bvpAvg = input.bvpHistory.avg ?? 0;
    if (bvpAvg >= 0.350) score += 15;
    else if (bvpAvg >= 0.300) score += 10;
    else if (bvpAvg >= 0.250) score += 5;
    else if (bvpAvg < 0.200) score -= 10;
  }

  if (input.pitcher.era !== null && input.pitcher.era !== undefined) {
    if (input.pitcher.era >= 5.0) score += 10;
    else if (input.pitcher.era >= 4.0) score += 5;
    else if (input.pitcher.era <= 2.5) score -= 8;
  }

  if (input.pitcher.whip !== null && input.pitcher.whip !== undefined) {
    if (input.pitcher.whip >= 1.40) score += 8;
    else if (input.pitcher.whip <= 1.00) score -= 5;
  }

  if (input.weatherPark?.parkFactor != null) {
    const pf = input.weatherPark.parkFactor;
    if (pf >= 1.10) score += 8;
    else if (pf <= 0.90) score -= 5;
  }

  return clamp(score, 0, 100);
}

function computeFormComponent(input: MLBPropInput): number {
  let score = 50;

  if (input.rollingForm) {
    const recent = input.rollingForm.last7Avg;
    const longer = input.rollingForm.last30Avg;

    if (recent !== null && recent !== undefined) {
      if (recent >= 0.350) score += 20;
      else if (recent >= 0.300) score += 12;
      else if (recent >= 0.270) score += 5;
      else if (recent < 0.200) score -= 15;
      else if (recent < 0.230) score -= 8;
    }

    if (recent !== null && longer !== null && recent !== undefined && longer !== undefined && longer > 0) {
      const trend = (recent - longer) / longer;
      if (trend >= 0.15) score += 10;
      else if (trend <= -0.15) score -= 8;
    }
  }

  const priorABs = input.contactQuality.priorABResults ?? [];
  if (priorABs.length > 0) {
    const hits = priorABs.filter(ab => ab.outcome === "hit").length;
    const hitRate = hits / priorABs.length;
    if (hitRate >= 0.5) score += 10;
    else if (hitRate === 0 && priorABs.length >= 3) score -= 10;
  }

  return clamp(score, 0, 100);
}

function computeOpportunityComponent(input: MLBPropInput): number {
  const remaining = input.remainingPA;
  if (remaining >= 4) return 85;
  if (remaining >= 3) return 70;
  if (remaining >= 2) return 55;
  if (remaining >= 1) return 35;
  return 15;
}

function computeEventBoostComponent(input: MLBPropInput, output: MLBPropOutput): number {
  let boost = 0;

  const priorABs = input.contactQuality.priorABResults ?? [];
  const hasHR = priorABs.some(ab => ab.outcome === "home_run" || ab.outcome === "homerun");
  if (hasHR) boost += 40;

  const hasBarrel = priorABs.some(ab =>
    (ab.exitVelocity ?? 0) >= 98 && (ab.launchAngle ?? 0) >= 25 && (ab.launchAngle ?? 0) <= 35
  );
  if (hasBarrel) boost += 30;

  const ev = input.contactQuality.exitVelocity ?? 0;
  if (ev >= 100) boost += 20;
  else if (ev >= 95) boost += 10;

  const hits = priorABs.filter(ab => ab.outcome === "hit" || ab.outcome === "home_run" || ab.outcome === "homerun").length;
  if (hits >= 3) boost += 20;
  else if (hits >= 2) boost += 10;

  const tb = input.currentStatValue;
  if (input.market === "total_bases" && tb >= 4) boost += 15;

  const pa = output.pitcherAnalysis;
  if (pa) {
    if (pa.stuff >= 75 && pa.swingMiss >= 70) boost += 15;
    if (pa.fatigue >= 65) boost += 10;
  }

  return clamp(boost, 0, 100);
}

function computeFullOpportunityScore(input: MLBPropInput, gameInning: number): number {
  let opp = 0;

  const slot = input.lineup.battingOrderSlot;
  if (slot <= 2) opp += 30;
  else if (slot <= 5) opp += 20;
  else if (slot <= 7) opp += 15;
  else opp += 10;

  if (gameInning <= 3) opp += 30;
  else if (gameInning <= 5) opp += 25;
  else if (gameInning <= 7) opp += 15;
  else opp += 5;

  const remaining = input.remainingPA;
  if (remaining >= 4) opp += 25;
  else if (remaining >= 3) opp += 20;
  else if (remaining >= 2) opp += 12;
  else if (remaining >= 1) opp += 5;

  const runs = input.currentRuns ?? 0;
  if (runs >= 5) opp += 15;
  else if (runs >= 3) opp += 10;
  else if (runs >= 1) opp += 5;

  return clamp(opp, 0, 100);
}

export function computeLiveOpportunityScore(
  signalScore: number,
  edge: number,
  opportunityScore: number,
  family?: MarketFamily
): number {
  if (family === "batter_over") {
    return (signalScore / 100) * (opportunityScore / 100);
  }
  const normalizedEdge = clamp(edge / 100, 0, 1);
  return (signalScore / 100) * normalizedEdge * (opportunityScore / 100);
}

function computeMarketReliabilityComponent(market: MLBMarket): number {
  if (market === "hits" || market === "total_bases") return 80;
  if (market === "pitcher_strikeouts" || market === "pitcher_outs") return 70;
  if (market === "hits_allowed" || market === "walks_allowed") return 55;
  if (market === "hrr") return 65;
  if (market === "home_runs" || market === "hr_allowed") return 40;
  if (market === "batter_strikeouts") return 60;
  return 50;
}

function computePriceValidationComponent(edge: number, overOdds: number | null, underOdds: number | null): number {
  let score = 50;

  if (edge >= 8) score += 25;
  else if (edge >= 5) score += 15;
  else if (edge >= 3) score += 8;
  else if (edge < 0) score -= 15;

  const hasValidOdds = (overOdds !== null && Number.isFinite(overOdds)) ||
                       (underOdds !== null && Number.isFinite(underOdds));
  if (!hasValidOdds) score -= 20;

  return clamp(score, 0, 100);
}

export function computeSignalScore(
  input: MLBPropInput,
  output: MLBPropOutput
): SignalScoreBreakdown {
  const prob = computeProbabilityComponent(output.calibratedProbability);
  const proj = computeProjectionComponent(output.projection, output.bookLine, output.market, output.recommendedSide);
  const live = computeLiveContextComponent(input);
  const matchup = computeMatchupComponent(input);
  const form = computeFormComponent(input);
  const opportunity = computeOpportunityComponent(input);
  const reliability = computeMarketReliabilityComponent(output.market);
  const price = computePriceValidationComponent(output.edge, output.overOdds, output.underOdds);
  const eventBoost = computeEventBoostComponent(input, output);

  const baseTotal = Math.round(
    0.25 * prob +
    0.18 * proj +
    0.13 * live +
    0.13 * matchup +
    0.08 * form +
    0.05 * opportunity +
    0.03 * reliability +
    0.02 * price +
    0.13 * eventBoost
  );

  const total = clamp(baseTotal, 0, 100);

  let confidenceTier: SignalConfidenceTier;
  if (total >= 85) confidenceTier = "ELITE";
  else if (total >= 70) confidenceTier = "STRONG";
  else if (total >= 55) confidenceTier = "SOLID";
  else if (total >= 40) confidenceTier = "WATCHLIST";
  else confidenceTier = "NO_SIGNAL";

  return {
    probability: Math.round(prob),
    projection: Math.round(proj),
    liveContext: Math.round(live),
    matchup: Math.round(matchup),
    form: Math.round(form),
    opportunity: Math.round(opportunity),
    marketReliability: Math.round(reliability),
    priceValidation: Math.round(price),
    eventBoost: Math.round(eventBoost),
    total,
    confidenceTier,
  };
}

export { computeFullOpportunityScore };

export function deriveSignalTags(
  input: MLBPropInput,
  output: MLBPropOutput,
  scoreBreakdown: SignalScoreBreakdown
): SignalTag[] {
  const tags: SignalTag[] = [];

  if (scoreBreakdown.confidenceTier === "ELITE" || scoreBreakdown.confidenceTier === "STRONG") {
    tags.push("LIVE EDGE");
  }

  if (output.recommendedSide === "OVER" && scoreBreakdown.form >= 65) {
    tags.push("HOT OVER");
  }

  if (output.recommendedSide === "UNDER" && scoreBreakdown.form <= 35) {
    tags.push("COLD UNDER");
  }

  if (output.market === "home_runs" && output.calibratedProbability >= 55) {
    tags.push("HR WATCH");
  }

  if (scoreBreakdown.matchup >= 70) {
    tags.push("STRONG MATCHUP");
  }

  if (input.pitcher.era !== null && input.pitcher.era !== undefined && input.pitcher.era >= 5.0) {
    tags.push("ATTACKABLE PITCHER");
  }

  const lei = input.liveInterpretation;
  if (lei && lei.tags.length > 0) {
    for (const t of lei.tags) {
      const mapped = t.toUpperCase() as SignalTag;
      if (!tags.includes(mapped)) tags.push(mapped);
    }
  }

  return tags;
}

export function deriveFeedTags(
  input: MLBPropInput,
  output: MLBPropOutput,
  scoreBreakdown: SignalScoreBreakdown
): FeedTag[] {
  const tags: FeedTag[] = [];

  if (scoreBreakdown.confidenceTier !== "NO_SIGNAL" && scoreBreakdown.confidenceTier !== "WATCHLIST") {
    tags.push("edge_feed");
  }

  if (input.inning >= 2 && input.inning <= 4) tags.push("inning_3");
  if (input.inning >= 4 && input.inning <= 6) tags.push("inning_5");
  if (input.inning >= 6 && input.inning <= 8) tags.push("inning_7");

  if (output.market === "home_runs") {
    if (output.calibratedProbability >= 55 || scoreBreakdown.total >= 55) {
      tags.push("hr_radar");
    } else if (scoreBreakdown.liveContext >= 60 || scoreBreakdown.matchup >= 60) {
      tags.push("hr_watchlist");
    }
  } else if (output.market === "hrr") {
    tags.push("edge_feed");
  }

  return tags;
}

export function deriveGameCardTags(
  signals: Array<{ signalTags: SignalTag[]; market: MLBMarket; recommendedSide: string; signalScore: number }>
): SignalTag[] {
  const gameTags: SignalTag[] = [];

  if (signals.length > 0) {
    gameTags.push("LIVE SIGNALS");
  }

  const hotCount = signals.filter(s => s.signalTags.includes("HOT OVER")).length;
  if (hotCount >= 2) gameTags.push("HOT BATS");

  const attackable = signals.some(s => s.signalTags.includes("ATTACKABLE PITCHER"));
  if (attackable) gameTags.push("PITCHER ATTACKABLE");

  const hrWatch = signals.some(s => s.signalTags.includes("HR WATCH"));
  if (hrWatch) gameTags.push("HR WATCH");

  const inning3 = signals.some(s => s.signalTags.includes("3RD INNING EDGE" as SignalTag));
  if (inning3) gameTags.push("3RD INNING EDGE");

  return gameTags;
}

export type PitcherSignalType = "DOMINANT" | "K_STREAK" | "COMMAND_LOCKED" | "VELOCITY_DROP" | "FATIGUE_RISK" | "HARD_CONTACT";

export function derivePitcherSignals(
  input: MLBPropInput,
  output: MLBPropOutput
): PitcherSignalType[] {
  const sigs: PitcherSignalType[] = [];
  const pa = output.pitcherAnalysis;
  if (!pa) return sigs;

  if (pa.stuff >= 75 && pa.command >= 65 && pa.swingMiss >= 70) {
    sigs.push("DOMINANT");
  }
  if (pa.swingMiss >= 75) {
    sigs.push("K_STREAK");
  }
  if (pa.command >= 75 && pa.fatigue <= 30) {
    sigs.push("COMMAND_LOCKED");
  }
  if (pa.fatigue >= 65) {
    sigs.push("FATIGUE_RISK");
  }
  if (pa.contactSuppression <= 30) {
    sigs.push("HARD_CONTACT");
  }

  const pitcher = input.pitcher;
  if (pitcher.pitchCount >= 80 && pa.stuff < 50) {
    if (!sigs.includes("VELOCITY_DROP")) sigs.push("VELOCITY_DROP");
  }

  return sigs;
}

function computeLEIComponent(input: MLBPropInput): number {
  const lei = input.liveInterpretation;
  if (!lei) return 50;
  const contactPart = Math.min(100, (lei.contactScore / 0.20) * 100);
  const nearHrPart = Math.min(100, (lei.nearHrScore / 0.15) * 100);
  const momentumPart = Math.min(100, (lei.momentumScore / 0.10) * 100);
  const fatiguePart = Math.min(100, (lei.pitcherFatigueScore / 0.15) * 100);
  const veloDropPart = Math.min(100, (lei.veloDropScore / 0.10) * 100);
  return clamp(
    0.30 * contactPart + 0.20 * nearHrPart + 0.20 * momentumPart + 0.20 * fatiguePart + 0.10 * veloDropPart,
    0, 100
  );
}

function computeParkWeatherComponent(input: MLBPropInput): number {
  let score = 50;
  if (input.weatherPark?.parkFactor != null) {
    const pf = input.weatherPark.parkFactor;
    if (pf >= 1.15) score += 20;
    else if (pf >= 1.10) score += 15;
    else if (pf >= 1.05) score += 8;
    else if (pf <= 0.90) score -= 15;
    else if (pf <= 0.95) score -= 8;
  }
  if (!input.weatherPark?.isIndoors) {
    if (input.weatherPark?.windDirection === "out" && (input.weatherPark?.windSpeed ?? 0) >= 8) score += 10;
    else if (input.weatherPark?.windDirection === "in" && (input.weatherPark?.windSpeed ?? 0) >= 8) score -= 10;
    const temp = input.weatherPark?.temperature ?? 70;
    if (temp >= 85) score += 5;
    else if (temp <= 50) score -= 8;
  }
  return clamp(score, 0, 100);
}

export function scoreBatterOverSignal(
  input: MLBPropInput,
  output: MLBPropOutput
): SignalScoreBreakdown {
  const form = computeFormComponent(input);
  const matchup = computeMatchupComponent(input);
  const parkWeather = computeParkWeatherComponent(input);
  const lei = computeLEIComponent(input);
  const opportunity = computeOpportunityComponent(input);
  const eventBoost = computeEventBoostComponent(input, output);
  const prob = computeProbabilityComponent(output.calibratedProbability);
  const proj = computeProjectionComponent(output.projection, output.bookLine, output.market, output.recommendedSide);

  const baseTotal = Math.round(
    0.15 * form +
    0.20 * matchup +
    0.10 * parkWeather +
    0.25 * lei +
    0.10 * opportunity +
    0.10 * eventBoost +
    0.05 * prob +
    0.05 * proj
  );

  const total = clamp(baseTotal, 0, 100);

  let confidenceTier: SignalConfidenceTier;
  if (total >= 80) confidenceTier = "ELITE";
  else if (total >= 68) confidenceTier = "STRONG";
  else if (total >= 55) confidenceTier = "SOLID";
  else if (total >= 42) confidenceTier = "WATCHLIST";
  else confidenceTier = "NO_SIGNAL";

  return {
    probability: Math.round(prob),
    projection: Math.round(proj),
    liveContext: Math.round(lei),
    matchup: Math.round(matchup),
    form: Math.round(form),
    opportunity: Math.round(opportunity),
    marketReliability: Math.round(parkWeather),
    priceValidation: 50,
    eventBoost: Math.round(eventBoost),
    total,
    confidenceTier,
  };
}

export function scoreUnderSignal(
  input: MLBPropInput,
  output: MLBPropOutput
): SignalScoreBreakdown {
  const prob = computeProbabilityComponent(output.calibratedProbability);
  const proj = computeProjectionComponent(output.projection, output.bookLine, output.market, output.recommendedSide);
  const matchup = computeMatchupComponent(input);
  const live = computeLiveContextComponent(input);
  const form = computeFormComponent(input);
  const opportunity = computeOpportunityComponent(input);
  const price = computePriceValidationComponent(output.edge, output.overOdds, output.underOdds);
  const eventBoost = computeEventBoostComponent(input, output);

  const pitcherSupp = computeLiveContextComponent(input);

  const baseTotal = Math.round(
    0.22 * prob +
    0.18 * proj +
    0.15 * matchup +
    0.15 * pitcherSupp +
    0.12 * live +
    0.08 * form +
    0.05 * opportunity +
    0.05 * price
  );

  const total = clamp(baseTotal, 0, 100);

  let confidenceTier: SignalConfidenceTier;
  if (total >= 85) confidenceTier = "ELITE";
  else if (total >= 70) confidenceTier = "STRONG";
  else if (total >= 55) confidenceTier = "SOLID";
  else if (total >= 40) confidenceTier = "WATCHLIST";
  else confidenceTier = "NO_SIGNAL";

  return {
    probability: Math.round(prob),
    projection: Math.round(proj),
    liveContext: Math.round(live),
    matchup: Math.round(matchup),
    form: Math.round(form),
    opportunity: Math.round(opportunity),
    marketReliability: 50,
    priceValidation: Math.round(price),
    eventBoost: Math.round(eventBoost),
    total,
    confidenceTier,
  };
}

export function scoreHRRadar(
  input: MLBPropInput,
  output: MLBPropOutput
): SignalScoreBreakdown {
  const lei = input.liveInterpretation;

  let nearHrScore = 50;
  if (lei) {
    nearHrScore = clamp(50 + (lei.nearHrScore / 0.15) * 50, 0, 100);
  }
  const priorABs = input.contactQuality.priorABResults ?? [];
  const hasBarrel = priorABs.some(ab =>
    (ab.exitVelocity ?? 0) >= 98 && (ab.launchAngle ?? 0) >= 25 && (ab.launchAngle ?? 0) <= 35
  );
  const hasHR = priorABs.some(ab => ab.outcome === "home_run" || ab.outcome === "homerun" || ab.outcome === "hr");
  if (hasBarrel) nearHrScore = clamp(nearHrScore + 25, 0, 100);
  if (hasHR) nearHrScore = clamp(nearHrScore + 30, 0, 100);

  let contactScore = 50;
  const ev = input.contactQuality.exitVelocity;
  if (ev != null) {
    if (ev >= 105) contactScore = 95;
    else if (ev >= 100) contactScore = 85;
    else if (ev >= 95) contactScore = 70;
    else if (ev >= 90) contactScore = 55;
    else contactScore = 35;
  }
  if (input.contactQuality.barrelRateProxySeason != null && input.contactQuality.barrelRateProxySeason >= 0.10) contactScore = clamp(contactScore + 10, 0, 100);
  if (input.contactQuality.xSLG != null && input.contactQuality.xSLG >= 0.500) contactScore = clamp(contactScore + 10, 0, 100);

  let pitcherVuln = 50;
  if (lei) {
    pitcherVuln = clamp(50 + (lei.pitcherFatigueScore / 0.15) * 30 + (lei.veloDropScore / 0.10) * 20, 0, 100);
  }
  if (input.pitcher.era != null && input.pitcher.era >= 5.0) pitcherVuln = clamp(pitcherVuln + 12, 0, 100);
  else if (input.pitcher.era != null && input.pitcher.era >= 4.0) pitcherVuln = clamp(pitcherVuln + 6, 0, 100);
  if (input.pitcher.isPitcherCollapsing) pitcherVuln = clamp(pitcherVuln + 15, 0, 100);
  if (input.pitcher.timesThrough >= 3) pitcherVuln = clamp(pitcherVuln + 10, 0, 100);

  const parkWeather = computeParkWeatherComponent(input);
  const opportunity = computeOpportunityComponent(input);

  const baseTotal = Math.round(
    0.30 * nearHrScore +
    0.25 * contactScore +
    0.20 * pitcherVuln +
    0.15 * parkWeather +
    0.10 * opportunity
  );

  const total = clamp(baseTotal, 0, 100);

  let confidenceTier: SignalConfidenceTier;
  if (total >= 80) confidenceTier = "ELITE";
  else if (total >= 65) confidenceTier = "STRONG";
  else if (total >= 50) confidenceTier = "SOLID";
  else if (total >= 35) confidenceTier = "WATCHLIST";
  else confidenceTier = "NO_SIGNAL";

  return {
    probability: Math.round(nearHrScore),
    projection: Math.round(contactScore),
    liveContext: Math.round(pitcherVuln),
    matchup: Math.round(pitcherVuln),
    form: 50,
    opportunity: Math.round(opportunity),
    marketReliability: Math.round(parkWeather),
    priceValidation: 50,
    eventBoost: Math.round(nearHrScore),
    total,
    confidenceTier,
  };
}

export function computeSignalScoreByFamily(
  input: MLBPropInput,
  output: MLBPropOutput
): SignalScoreBreakdown {
  const family = getMarketFamily(output.market, output.recommendedSide);

  if (family === "batter_over") return scoreBatterOverSignal(input, output);
  if (family === "under") return scoreUnderSignal(input, output);
  return computeSignalScore(input, output);
}

export function isPlayerGlowEligible(
  scoreBreakdown: SignalScoreBreakdown,
  signalTags: SignalTag[]
): boolean {
  const isHotOrWarm = signalTags.includes("HOT OVER") || signalTags.includes("STRONG MATCHUP");
  const hasQualifiedSignal = scoreBreakdown.confidenceTier === "ELITE" ||
    scoreBreakdown.confidenceTier === "STRONG" ||
    scoreBreakdown.confidenceTier === "SOLID";
  return isHotOrWarm && hasQualifiedSignal;
}
