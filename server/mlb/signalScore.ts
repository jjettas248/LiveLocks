import type { MLBPropInput, MLBPropOutput, MLBMarket } from "./types";
import { EXPERIMENTAL_MARKETS } from "./types";

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
  total: number;
  confidenceTier: SignalConfidenceTier;
}

export type SignalTag =
  | "HOT OVER" | "COLD UNDER" | "HR WATCH" | "LIVE EDGE"
  | "STRONG MATCHUP" | "ATTACKABLE PITCHER" | "LIVE SIGNALS"
  | "HOT BATS" | "PITCHER ATTACKABLE" | "3RD INNING EDGE"
  | "5TH INNING EDGE" | "7TH INNING EDGE";

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

  const total = Math.round(
    0.30 * prob +
    0.20 * proj +
    0.15 * live +
    0.15 * matchup +
    0.10 * form +
    0.05 * opportunity +
    0.03 * reliability +
    0.02 * price
  );

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
    total,
    confidenceTier,
  };
}

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

  if ((output.market === "home_runs" || output.market === "hrr") && output.calibratedProbability >= 55) {
    tags.push("HR WATCH");
  }

  if (scoreBreakdown.matchup >= 70) {
    tags.push("STRONG MATCHUP");
  }

  if (input.pitcher.era !== null && input.pitcher.era !== undefined && input.pitcher.era >= 5.0) {
    tags.push("ATTACKABLE PITCHER");
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

  if (output.market === "home_runs" || output.market === "hrr") {
    if (output.calibratedProbability >= 55 || scoreBreakdown.total >= 55) {
      tags.push("hr_radar");
    } else if (scoreBreakdown.liveContext >= 60 || scoreBreakdown.matchup >= 60) {
      tags.push("hr_watchlist");
    }
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
