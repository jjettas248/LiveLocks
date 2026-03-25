// ── NCAAB Engine — Single Source of Truth ─────────────────────────────────────
// All projection, probability, pick direction, and display output logic lives here.
// The client renders ONLY from NCAABEngineOutput. No client-side recomputation.

// ── Typed Input Contract ──────────────────────────────────────────────────────
export interface NCAABGameInput {
  gameId: string;
  sport: "ncaab";
  league: "NCAAB";

  homeTeam: string;
  awayTeam: string;
  homeTeamAbbr: string;
  awayTeamAbbr: string;

  homeScore: number;
  awayScore: number;
  period: number;
  half: number;
  clock: string;
  isHalftime: boolean;
  secondsRemainingInHalf: number;
  status: string;

  liveTotalLine: number | null;
  liveSpreadLine: number | null;
  liveSpreadFavorite: string;
  h1TotalLine: number | null;
  h1SpreadLine: number | null;
  h1Favorite: string;
  h2TotalLine: number | null;
  h2SpreadLine: number | null;
  h2Favorite: string;

  homeGameTotalLine: number | null;
  awayGameTotalLine: number | null;
  home1HTotalLine: number | null;
  away1HTotalLine: number | null;

  h1HomeScore: number;
  h1AwayScore: number;
  h2HomeScore: number;
  h2AwayScore: number;

  scoringByPeriod: Record<string, number[]>;
  teamStats: Record<string, any>;

  projTotalBonus: number;
  volatilityBonus: number;
  desperation3s: boolean;
  intentionalFouling: boolean;

  // Per-market American odds — required by G7; null means unavailable
  overOddsAmerican: number | null;
  spreadOddsAmerican: number | null;
  h1OverOddsAmerican: number | null;
  h1SpreadOddsAmerican: number | null;
  h2OverOddsAmerican: number | null;
  h2SpreadOddsAmerican: number | null;
  h1TotalOverOdds: number | null;
  h1TotalUnderOdds: number | null;
  h1SpreadHomeOdds: number | null;
  h1SpreadAwayOdds: number | null;

  sourceTimestamps?: Record<string, number>;

  liveTotalSource?: "book" | "derived";

  // Optional sportsbook line movement / public betting data
  openSpread?: number | null;
  closingSpread?: number | null;
  liveSpread?: number | null;
  openTotal?: number | null;
  closingTotal?: number | null;
  liveTotal?: number | null;
  publicSpreadPct?: number | null;
  publicTotalPct?: number | null;
}

// ── Market Types ──────────────────────────────────────────────────────────────
export type NCAABMarketType =
  | "full_game_total"
  | "h1_total"
  | "h2_total"
  | "spread"
  | "h1_spread"
  | "h2_spread"
  | "team_total_home"
  | "team_total_away"
  | "h1_team_total_home"
  | "h1_team_total_away"
  | "h2_team_total_home"
  | "h2_team_total_away";

export type RecommendedSide = "OVER" | "UNDER" | "COVER" | "FADE" | "NO_EDGE";
export type MarketSide = "OVER" | "UNDER" | "HOME" | "AWAY" | null;

// ── Confidence Tiers ──────────────────────────────────────────────────────────
export type ConfidenceTier = "HIGH" | "MEDIUM" | "LOW" | "NO_EDGE";
export type MarketConfidenceTier = "ELITE" | "STRONG" | "VALUE" | "NONE";

// ── Canonical Market Keys (6 core markets) ───────────────────────────────────
export type NCAABMarketKey =
  | "full_total"
  | "full_spread"
  | "h1_total"
  | "h1_spread"
  | "h2_total"
  | "h2_spread";

export const ALL_MARKET_KEYS: NCAABMarketKey[] = [
  "full_total", "full_spread", "h1_total", "h1_spread", "h2_total", "h2_spread",
];

// ── Canonical Market Object ──────────────────────────────────────────────────
export interface NCAABMarket {
  available: boolean;
  marketKey: NCAABMarketKey;
  label: string;
  sportsbook: string | null;
  bookLine: number | null;
  projection: number | null;
  modelProb: number | null;
  bookImpliedProb: number | null;
  edge: number | null;
  side: MarketSide;
  confidenceTier: MarketConfidenceTier;
  clvEdge?: number | null;
  publicBetPct?: number | null;
  publicInflation?: boolean | null;
  fadeRecommended?: boolean | null;
  adjustedEdgeScore?: number | null;
}

export type NCAABMarkets = Record<NCAABMarketKey, NCAABMarket>;

export interface NCAABDebugMarketEntry {
  marketKey: NCAABMarketKey;
  projection: number | null;
  bookLine: number | null;
  modelProb: number | null;
  bookImpliedProb: number | null;
  edge: number | null;
  confidenceTier: MarketConfidenceTier;
  clvEdge: number | null;
  publicBetPct: number | null;
  publicInflation: boolean | null;
}

// ── Projection Result ─────────────────────────────────────────────────────────
export interface NCAABProjectionResult {
  baseProjection: number;
  paceAdjustment: number;
  halfBlend: number;
  possessionAdjustment: number;
  marginAdjustment: number;
  finalProjectedTotal: number;
  finalProjectedSpread: number;
  finalProjectedTeamTotalA: number;
  finalProjectedTeamTotalB: number;
  proj1HTeamTotalHome: number | null;
  proj1HTeamTotalAway: number | null;
  proj2HTeamTotalHome: number | null;
  proj2HTeamTotalAway: number | null;
  proj1HTotal: number | null;
  proj2HTotal: number | null;
}

// ── Probability Result ────────────────────────────────────────────────────────
export interface NCAABProbabilityResult {
  rawOverProb: number;
  rawUnderProb: number;
  rawSpreadProb: number;
  raw1HProb: number | null;
  raw2HProb: number | null;
  calibratedOverProb: number;
  calibratedUnderProb: number;
  calibratedSpreadProb: number;
  calibrated1HProb: number | null;
  calibrated2HProb: number | null;
}

// ── Canonical Market Keys (Phase B) ──────────────────────────────────────────
export type NCAABCanonicalMarketKey =
  | "full_total"
  | "full_spread"
  | "h1_total"
  | "h1_spread"
  | "h2_total"
  | "h2_spread";

// ── Per-Market Verdict ────────────────────────────────────────────────────────
export interface NCAABMarketVerdict {
  market: NCAABMarketType;
  projection: number | null;
  line: number | null;
  overProb: number | null;
  underProb: number | null;
  side: RecommendedSide;
  confidenceTier: ConfidenceTier;
  edge: number | null;
}

// ── Engine Output Contract ────────────────────────────────────────────────────
export interface NCAABEngineOutput {
  gameId: string;
  sport: "ncaab";
  marketType: NCAABMarketType;

  projectedTotal: number | null;
  projected1HTotal: number | null;
  projected2HTotal: number | null;
  projectedSpread: number | null;
  projectedTeamTotalHome: number | null;
  projectedTeamTotalAway: number | null;

  rawOverProb: number | null;
  rawUnderProb: number | null;
  rawSpreadProb: number | null;
  calibratedOverProb: number | null;
  calibratedUnderProb: number | null;
  calibratedSpreadProb: number | null;
  over1HProb: number | null;
  over2HProb: number | null;

  impliedBookOverProb: number | null;
  impliedBookUnderProb: number | null;

  edgePctOver: number | null;
  edgePctUnder: number | null;
  edgePctSpread: number | null;

  recommendedSide: RecommendedSide;
  confidenceTier: ConfidenceTier;
  explanationBullets: string[];
  dominantMarket: "over" | "under" | "spread";

  displayProjection: string;
  displayProbability: string;
  displayPick: string;

  marketVerdicts: NCAABMarketVerdict[];

  markets: NCAABMarkets;
  debugMarkets?: NCAABDebugMarketEntry[];

  displayOutput: NCAABDisplayOutput;

  warnings: string[];
  engineGeneratedAt: number;

  debug?: NCAABDebugPayload;
}

// ── Debug Payload ─────────────────────────────────────────────────────────────
export interface NCAABDebugPayload {
  baseProjection: number;
  paceAdjustment: number;
  halfBlend: number;
  projectedPossessionsRemaining: number | null;
  varianceEstimate: number;
  rawProbability: number;
  calibratedProbability: number;
  dynamicMultiplier: number;
  sideDecisionReason: string;
  validationWarnings: string[];
}

// ── Display Output ────────────────────────────────────────────────────────────
export interface NCAABDisplayOutput {
  projectedTotal: string;
  projectedSpread: string;
  overProb: string;
  underProb: string;
  spreadProb: string;
  recommendedSide: string;
  confidenceTier: string;
  edgeLabelOver: string;
  edgeLabelUnder: string;
  edgeLabelSpread: string;
  preGameConfidenceLabel: string;
  explanationBullets: string[];
  warnings: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────
const NCAAB_AVG_PACE = 3.45;
const NCAAB_H1_FRACTION = 0.47;
const NCAAB_PACE_CAP = 1.35;
const HALF_SECONDS = 1200;
const TOTAL_GAME_SECONDS = 2400;

const DEFAULT_VARIANCE = 12.0;
const CALIBRATION_CAP = 78;
const CALIBRATION_WARN_THRESHOLD = 75;

const DYNAMIC_MULT_MIN = 0.6;
const DYNAMIC_MULT_MAX = 1.4;

const EDGE_MIN_GAP = 2.0;
const EDGE_MIN_PROB = 57;

// ── Market-specific variance table (extensible) ───────────────────────────────
const MARKET_VARIANCE: Record<NCAABMarketType, number> = {
  full_game_total: 12.0,
  h1_total: 8.0,
  h2_total: 8.0,
  spread: 10.0,
  h1_spread: 8.0,
  h2_spread: 8.0,
  team_total_home: 7.0,
  team_total_away: 7.0,
  h1_team_total_home: 5.0,
  h1_team_total_away: 5.0,
  h2_team_total_home: 5.0,
  h2_team_total_away: 5.0,
};

// ── Normal CDF (Phi) — used for realistic probability distribution ────────────
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

// ── Dynamic Multiplier (clamped 0.6–1.4) ──────────────────────────────────────
export function getDynamicMultiplier(
  secsRemaining: number,
  totalSecs: number,
  period: number,
  maxPeriods: number
): { value: number; clamped: boolean; attempted: number } {
  let attempted: number;

  if (period > maxPeriods) {
    attempted = 1.4;
  } else {
    const progress = Math.min(Math.max(1 - secsRemaining / totalSecs, 0), 1);
    if (progress < 0.25) attempted = 0.6;
    else if (progress < 0.50) attempted = 0.8;
    else if (progress < 0.65) attempted = 0.9;
    else if (progress < 0.75) attempted = 1.0;
    else if (progress < 0.85) attempted = 1.1;
    else if (progress < 0.92) attempted = 1.2;
    else attempted = 1.4;
  }

  const clamped = attempted < DYNAMIC_MULT_MIN || attempted > DYNAMIC_MULT_MAX;
  const value = Math.min(Math.max(attempted, DYNAMIC_MULT_MIN), DYNAMIC_MULT_MAX);

  if (clamped) {
    console.warn(`[ENGINE] Dynamic multiplier clamped: attempted=${attempted}, clamped to ${value}`);
  }

  return { value, clamped, attempted };
}

// ── Projection Layer (Pure Function) ──────────────────────────────────────────
export function calculateNCAABProjection(input: NCAABGameInput): NCAABProjectionResult {
  const {
    homeScore, awayScore, half, isHalftime, secondsRemainingInHalf,
    h1HomeScore, h1AwayScore, h2HomeScore, h2AwayScore,
    projTotalBonus,
  } = input;

  const currentTotal = homeScore + awayScore;
  const currentMargin = homeScore - awayScore;
  const h1Total = h1HomeScore + h1AwayScore;
  const h2TotalSoFar = h2HomeScore + h2AwayScore;

  const rawPaceH1 = h1Total > 0 ? h1Total / 20 : NCAAB_AVG_PACE;
  const paceH1 = Math.min(rawPaceH1, NCAAB_AVG_PACE * NCAAB_PACE_CAP);

  let baseProjection = 0;
  let paceAdjustment = 0;
  let halfBlend = 0;
  let possessionAdjustment = 0;
  let marginAdjustment = 0;
  let finalProjectedTotal = 0;
  let finalProjectedSpread = 0;
  let proj1HTotal: number | null = null;
  let proj2HTotal: number | null = null;

  if (isHalftime) {
    baseProjection = h1Total;
    paceAdjustment = paceH1 * 20;
    halfBlend = 1.0;
    possessionAdjustment = 0;
    marginAdjustment = 0;
    finalProjectedTotal = h1Total + (paceH1 * 20) + projTotalBonus;
    finalProjectedSpread = currentMargin;
    proj2HTotal = paceH1 * 20 + projTotalBonus;

  } else if (half === 1) {
    const h1MinElapsed = (HALF_SECONDS - secondsRemainingInHalf) / 60;
    const rawPaceH1Live = h1MinElapsed > 0.5 ? currentTotal / h1MinElapsed : NCAAB_AVG_PACE;
    const blend = Math.min(1.0, h1MinElapsed / 12);
    const blendedPace = rawPaceH1Live * blend + NCAAB_AVG_PACE * (1 - blend);
    const remainH1Min = secondsRemainingInHalf / 60;

    baseProjection = currentTotal;
    paceAdjustment = blendedPace;
    halfBlend = blend;
    possessionAdjustment = 0;
    marginAdjustment = 0;

    proj1HTotal = currentTotal + blendedPace * remainH1Min;
    const projH1Full = proj1HTotal;
    finalProjectedTotal = projH1Full + (blendedPace * 20) + projTotalBonus;

    const homeShareH1 = currentTotal > 0
      ? (homeScore / currentTotal) * 0.6 + 0.5 * 0.4
      : 0.5;
    const remainingH1Scoring = blendedPace * remainH1Min;
    const proj1HHomeScore = homeScore + remainingH1Scoring * homeShareH1;
    const proj1HAwayScore = awayScore + remainingH1Scoring * (1 - homeShareH1);
    finalProjectedSpread = proj1HHomeScore - proj1HAwayScore;

    proj1HTotal = Math.round(proj1HTotal * 10) / 10;

  } else if (half === 2) {
    const h2MinElapsed = (HALF_SECONDS - secondsRemainingInHalf) / 60;
    const rawPaceH2Live = h2MinElapsed > 0 ? h2TotalSoFar / h2MinElapsed : paceH1;
    const paceH2Live = Math.min(rawPaceH2Live, NCAAB_AVG_PACE * 1.5);
    const paceH2 = paceH2Live * 0.70 + paceH1 * 0.30;
    const remainMin = secondsRemainingInHalf / 60;

    baseProjection = h1Total + h2TotalSoFar;
    paceAdjustment = paceH2;
    halfBlend = 0.70;
    possessionAdjustment = 0;
    marginAdjustment = 0;

    finalProjectedTotal = h1Total + h2TotalSoFar + (paceH2 * remainMin) + projTotalBonus;

    const h2MarginSoFar = h2HomeScore - h2AwayScore;
    const marginPerMin = h2MinElapsed > 0 ? h2MarginSoFar / h2MinElapsed : 0;
    finalProjectedSpread = currentMargin + (marginPerMin * remainMin);

    proj2HTotal = h2TotalSoFar + (paceH2 * remainMin) + projTotalBonus;
  }

  const homeShare = currentTotal > 0
    ? (homeScore / currentTotal) * 0.6 + 0.5 * 0.4
    : 0.5;
  const finalProjectedTeamTotalA = finalProjectedTotal * homeShare;
  const finalProjectedTeamTotalB = finalProjectedTotal * (1 - homeShare);
  const proj1HTeamTotalHome = proj1HTotal !== null ? proj1HTotal * homeShare : null;
  const proj1HTeamTotalAway = proj1HTotal !== null ? proj1HTotal * (1 - homeShare) : null;
  const proj2HTeamTotalHome = proj2HTotal !== null ? proj2HTotal * homeShare : null;
  const proj2HTeamTotalAway = proj2HTotal !== null ? proj2HTotal * (1 - homeShare) : null;

  return {
    baseProjection,
    paceAdjustment,
    halfBlend,
    possessionAdjustment,
    marginAdjustment,
    finalProjectedTotal,
    finalProjectedSpread,
    finalProjectedTeamTotalA,
    finalProjectedTeamTotalB,
    proj1HTotal,
    proj2HTotal,
    proj1HTeamTotalHome,
    proj1HTeamTotalAway,
    proj2HTeamTotalHome,
    proj2HTeamTotalAway,
  };
}

// ── Probability Layer ─────────────────────────────────────────────────────────
export function calculateNCAABProbabilities(
  input: NCAABGameInput,
  projection: NCAABProjectionResult
): NCAABProbabilityResult {
  const secsRemaining = input.isHalftime
    ? 1200
    : (input.half === 2 ? input.secondsRemainingInHalf : input.secondsRemainingInHalf + 1200);
  const secsElapsed = Math.max(0, TOTAL_GAME_SECONDS - secsRemaining);
  const tooEarly = secsElapsed < 60;

  const { value: dynamicMult } = getDynamicMultiplier(secsRemaining, TOTAL_GAME_SECONDS, input.period, 2);

  const effectiveFGLine = input.liveTotalLine
    ?? Math.round(projection.finalProjectedTotal * 2) / 2;
  const effective1HLine = input.h1TotalLine
    ?? (projection.proj1HTotal !== null ? Math.round(projection.proj1HTotal * 2) / 2 : null);

  const sigma = DEFAULT_VARIANCE;
  const varianceScale = dynamicMult;
  const adjustedSigma = sigma / varianceScale;

  let rawOverProb: number;
  let rawSpreadProb: number;
  let raw1HProb: number | null = null;
  let raw2HProb: number | null = null;

  if (tooEarly) {
    rawOverProb = 50;
    rawSpreadProb = 50;
    raw1HProb = input.half === 1 ? 50 : null;
  } else {
    const totalDiff = projection.finalProjectedTotal - effectiveFGLine;
    rawOverProb = normalCDF(totalDiff / adjustedSigma) * 100;

    if (input.liveSpreadLine !== null) {
      const adjustedSpread = input.liveSpreadFavorite &&
        input.liveSpreadFavorite.toLowerCase().includes(input.homeTeam.toLowerCase().split(" ").pop() ?? "")
        ? -input.liveSpreadLine
        : input.liveSpreadLine;
      const spreadDiff = projection.finalProjectedSpread - adjustedSpread;
      rawSpreadProb = normalCDF(spreadDiff / (adjustedSigma * 0.8)) * 100;
    } else {
      rawSpreadProb = 50;
    }

    if (input.half === 1 && projection.proj1HTotal !== null && effective1HLine !== null) {
      const h1Sigma = MARKET_VARIANCE.h1_total / varianceScale;
      const diff1H = projection.proj1HTotal - effective1HLine;
      raw1HProb = normalCDF(diff1H / h1Sigma) * 100;
    }

    if (projection.proj2HTotal !== null && input.h2TotalLine !== null) {
      const h2Sigma = MARKET_VARIANCE.h2_total / varianceScale;
      const diff2H = projection.proj2HTotal - input.h2TotalLine;
      raw2HProb = normalCDF(diff2H / h2Sigma) * 100;
    }
  }

  const rawUnderProb = 100 - rawOverProb;

  const calibratedOverProb = calibrateNCAABProbability(rawOverProb, "full_game_total", { secsElapsed });
  const calibratedUnderProb = calibrateNCAABProbability(rawUnderProb, "full_game_total", { secsElapsed });
  const calibratedSpreadProb = calibrateNCAABProbability(rawSpreadProb, "spread", { secsElapsed });

  let calibrated1HProb: number | null = null;
  if (raw1HProb !== null) {
    calibrated1HProb = calibrateNCAABProbability(raw1HProb, "h1_total", { secsElapsed });
  }

  let calibrated2HProb: number | null = null;
  if (raw2HProb !== null) {
    calibrated2HProb = calibrateNCAABProbability(raw2HProb, "h2_total", { secsElapsed });
  }

  return {
    rawOverProb: round1(rawOverProb),
    rawUnderProb: round1(rawUnderProb),
    rawSpreadProb: round1(rawSpreadProb),
    raw1HProb: raw1HProb !== null ? round1(raw1HProb) : null,
    raw2HProb: raw2HProb !== null ? round1(raw2HProb) : null,
    calibratedOverProb: round1(calibratedOverProb),
    calibratedUnderProb: round1(calibratedUnderProb),
    calibratedSpreadProb: round1(calibratedSpreadProb),
    calibrated1HProb: calibrated1HProb !== null ? round1(calibrated1HProb) : null,
    calibrated2HProb: calibrated2HProb !== null ? round1(calibrated2HProb) : null,
  };
}

// ── Calibration ───────────────────────────────────────────────────────────────
export function calibrateNCAABProbability(
  rawProbability: number,
  marketType: string,
  context: { secsElapsed?: number } = {}
): number {
  const { secsElapsed = 0 } = context;

  if (secsElapsed < 60) return 50;

  let calibrated = rawProbability;

  const distFrom50 = Math.abs(calibrated - 50);
  if (distFrom50 > (CALIBRATION_CAP - 50)) {
    const sign = calibrated > 50 ? 1 : -1;
    calibrated = 50 + sign * (CALIBRATION_CAP - 50);
  }

  calibrated = Math.min(Math.max(calibrated, 1), 99);

  return calibrated;
}

// ── Pick Direction Logic ──────────────────────────────────────────────────────
export function determineRecommendedSide(
  projectedValue: number,
  line: number,
  overProb: number,
  underProb: number,
  edgeThreshold: number = EDGE_MIN_GAP
): { side: RecommendedSide; reason: string; warnings: string[] } {
  const warnings: string[] = [];
  const gap = projectedValue - line;
  const absGap = Math.abs(gap);

  if (absGap < edgeThreshold) {
    return {
      side: "NO_EDGE",
      reason: `Projection gap (${absGap.toFixed(1)}) < threshold (${edgeThreshold})`,
      warnings,
    };
  }

  const projectionSays = gap > 0 ? "OVER" : "UNDER";
  const probSays = overProb > underProb ? "OVER" : "UNDER";

  if (projectionSays !== probSays) {
    warnings.push(
      `CONTRADICTION: projection says ${projectionSays} (gap=${gap.toFixed(1)}) but probability says ${probSays} (over=${overProb.toFixed(1)}%, under=${underProb.toFixed(1)}%)`
    );
    return { side: "NO_EDGE", reason: "Projection/probability contradiction", warnings };
  }

  const dominantProb = projectionSays === "OVER" ? overProb : underProb;
  if (dominantProb < EDGE_MIN_PROB) {
    return {
      side: "NO_EDGE",
      reason: `Calibrated probability (${dominantProb.toFixed(1)}%) < threshold (${EDGE_MIN_PROB}%)`,
      warnings,
    };
  }

  return {
    side: projectionSays,
    reason: `Projection gap=${gap.toFixed(1)}, probability=${dominantProb.toFixed(1)}%`,
    warnings,
  };
}

// ── Display Output Builder ────────────────────────────────────────────────────
function edgeLabel(prob: number | null, direction: string): string {
  if (prob === null) return "";
  const edge = Math.abs(prob - 50);
  if (edge < 3) return "";
  if (edge < 7) return `Slight ${direction} Lean`;
  if (edge < 12) return `Lean ${direction} EV`;
  if (edge < 18) return `Strong ${direction} EV`;
  return `Extreme ${direction} EV`;
}

function preGameConfidenceLabel(overProb: number | null): string {
  if (overProb === null) return "No Edge";
  const edge = Math.abs(overProb - 50);
  if (edge < 3) return "No Edge";
  if (edge < 7) return "Low";
  if (edge < 12) return "Moderate";
  if (edge < 18) return "High";
  return "Extreme";
}

export function buildNCAABDisplayOutput(engineOutput: NCAABEngineOutput): NCAABDisplayOutput {
  return {
    projectedTotal: engineOutput.projectedTotal !== null
      ? engineOutput.projectedTotal.toFixed(1)
      : "—",
    projectedSpread: engineOutput.projectedSpread !== null
      ? engineOutput.projectedSpread.toFixed(1)
      : "—",
    overProb: engineOutput.calibratedOverProb !== null
      ? `${engineOutput.calibratedOverProb.toFixed(1)}%`
      : "—",
    underProb: engineOutput.calibratedUnderProb !== null
      ? `${engineOutput.calibratedUnderProb.toFixed(1)}%`
      : "—",
    spreadProb: engineOutput.calibratedSpreadProb !== null
      ? `${engineOutput.calibratedSpreadProb.toFixed(1)}%`
      : "—",
    recommendedSide: engineOutput.recommendedSide,
    confidenceTier: engineOutput.confidenceTier,
    edgeLabelOver: edgeLabel(engineOutput.calibratedOverProb, "Over"),
    edgeLabelUnder: edgeLabel(engineOutput.calibratedUnderProb, "Under"),
    edgeLabelSpread: edgeLabel(engineOutput.calibratedSpreadProb, "Cover"),
    preGameConfidenceLabel: preGameConfidenceLabel(engineOutput.calibratedOverProb),
    explanationBullets: engineOutput.explanationBullets,
    warnings: engineOutput.warnings,
  };
}

// ── Display Consistency Validation ────────────────────────────────────────────
export function validateDisplayConsistency(
  input: NCAABGameInput,
  engineOutput: NCAABEngineOutput,
  displayOutput: NCAABDisplayOutput
): string[] {
  const warnings: string[] = [];

  if (engineOutput.projectedTotal !== null && engineOutput.calibratedOverProb !== null && input.liveTotalLine !== null) {
    const gap = engineOutput.projectedTotal - input.liveTotalLine;
    if (gap > EDGE_MIN_GAP && engineOutput.recommendedSide === "UNDER") {
      warnings.push(`WRONG_SIDE: projection (${engineOutput.projectedTotal.toFixed(1)}) > line (${input.liveTotalLine}) by ${gap.toFixed(1)}, but side is UNDER`);
    }
    if (gap < -EDGE_MIN_GAP && engineOutput.recommendedSide === "OVER") {
      warnings.push(`WRONG_SIDE: projection (${engineOutput.projectedTotal.toFixed(1)}) < line (${input.liveTotalLine}) by ${Math.abs(gap).toFixed(1)}, but side is OVER`);
    }
  }

  if (engineOutput.calibratedOverProb !== null && engineOutput.calibratedUnderProb !== null) {
    const sum = engineOutput.calibratedOverProb + engineOutput.calibratedUnderProb;
    if (Math.abs(sum - 100) > 1.0) {
      warnings.push(`PROB_MISMATCH: over(${engineOutput.calibratedOverProb}) + under(${engineOutput.calibratedUnderProb}) = ${sum.toFixed(1)}, expected ~100`);
    }
  }

  if (engineOutput.projectedTotal !== null) {
    const displayedProj = parseFloat(displayOutput.projectedTotal);
    if (!isNaN(displayedProj) && Math.abs(displayedProj - engineOutput.projectedTotal) > 0.15) {
      warnings.push(`ROUNDING_MISMATCH: engine projected ${engineOutput.projectedTotal.toFixed(1)}, display shows ${displayOutput.projectedTotal}`);
    }
  }

  if (engineOutput.calibratedOverProb !== null && engineOutput.calibratedOverProb > CALIBRATION_WARN_THRESHOLD) {
    warnings.push(`HIGH_PROB: calibrated over probability ${engineOutput.calibratedOverProb.toFixed(1)}% exceeds ${CALIBRATION_WARN_THRESHOLD}% threshold`);
  }
  if (engineOutput.calibratedUnderProb !== null && engineOutput.calibratedUnderProb > CALIBRATION_WARN_THRESHOLD) {
    warnings.push(`HIGH_PROB: calibrated under probability ${engineOutput.calibratedUnderProb.toFixed(1)}% exceeds ${CALIBRATION_WARN_THRESHOLD}% threshold`);
  }

  if (engineOutput.engineGeneratedAt) {
    const age = Date.now() - engineOutput.engineGeneratedAt;
    if (age > 30_000) {
      warnings.push(`STALE_ENGINE: engine output is ${(age / 1000).toFixed(0)}s old — exceeds 30s threshold`);
    }
  }

  if (input.sourceTimestamps) {
    const now = Date.now();
    const STALE_LINE_THRESHOLD = 120_000;
    for (const [source, ts] of Object.entries(input.sourceTimestamps)) {
      const lineAge = now - ts;
      if (lineAge > STALE_LINE_THRESHOLD) {
        warnings.push(`STALE_LINE: ${source} data is ${(lineAge / 1000).toFixed(0)}s old — exceeds ${STALE_LINE_THRESHOLD / 1000}s threshold`);
      }
    }
    const tsValues = Object.values(input.sourceTimestamps);
    if (tsValues.length > 1) {
      const maxSkew = Math.max(...tsValues) - Math.min(...tsValues);
      if (maxSkew > 60_000) {
        warnings.push(`ENRICHMENT_SKEW: ${(maxSkew / 1000).toFixed(0)}s skew between data sources — risk of stale enrichment overwrite`);
      }
    }
  }

  if (displayOutput.recommendedSide !== engineOutput.recommendedSide) {
    warnings.push(`DISPLAY_DIVERGENCE: display shows side '${displayOutput.recommendedSide}' but engine computed '${engineOutput.recommendedSide}'`);
  }
  if (displayOutput.confidenceTier !== engineOutput.confidenceTier) {
    warnings.push(`DISPLAY_DIVERGENCE: display shows tier '${displayOutput.confidenceTier}' but engine computed '${engineOutput.confidenceTier}'`);
  }

  if (engineOutput.marketVerdicts) {
    for (const v of engineOutput.marketVerdicts) {
      if (v.line !== null && v.projection !== null) {
        const verdictGap = v.projection - v.line;
        if (verdictGap > 0 && v.side === "UNDER") {
          warnings.push(`VERDICT_CONTRADICTION: ${v.market} projection ${v.projection} > line ${v.line} but side is UNDER`);
        }
        if (verdictGap < 0 && v.side === "OVER") {
          warnings.push(`VERDICT_CONTRADICTION: ${v.market} projection ${v.projection} < line ${v.line} but side is OVER`);
        }
      }
    }
  }

  if (warnings.length > 0) {
    console.warn(`[ENGINE VALIDATION] ${engineOutput.gameId}:`, warnings);
  }

  return warnings;
}

// ── Confidence Tier ───────────────────────────────────────────────────────────
function getConfidenceTier(prob: number, gap: number): ConfidenceTier {
  if (prob >= 70 && gap >= 5.0) return "HIGH";
  if (prob >= 62 && gap >= 3.0) return "MEDIUM";
  if (prob >= EDGE_MIN_PROB && gap >= EDGE_MIN_GAP) return "LOW";
  return "NO_EDGE";
}

// ── Market Confidence Tier (edge-based, Guardrail 6) ─────────────────────────
function getMarketConfidenceTier(edge: number | null): MarketConfidenceTier {
  if (edge === null) return "NONE";
  const absEdge = Math.abs(edge);
  if (absEdge >= 12) return "ELITE";
  if (absEdge >= 8) return "STRONG";
  if (absEdge >= 4) return "VALUE";
  return "NONE";
}

// ── Sportsbook odds validation (Guardrail 7) ─────────────────────────────────
function isValidOdds(odds: number | null | undefined): odds is number {
  if (odds == null || odds === 0) return false;
  return odds >= -2000 && odds <= 2000;
}

// ── Probability safety clamp (Guardrail 2) ───────────────────────────────────
function clampProb(p: number | null | undefined): number | null {
  if (p == null || !isFinite(p) || isNaN(p)) return null;
  return Math.min(99, Math.max(1, p));
}

// ── Unavailable market factory ───────────────────────────────────────────────
function unavailableMarket(key: NCAABMarketKey, label: string): NCAABMarket {
  return {
    available: false,
    marketKey: key,
    label,
    sportsbook: null,
    bookLine: null,
    projection: null,
    modelProb: null,
    bookImpliedProb: null,
    edge: null,
    side: null,
    confidenceTier: "NONE",
    clvEdge: null,
    publicBetPct: null,
    publicInflation: null,
    fadeRecommended: null,
    adjustedEdgeScore: null,
  };
}

function safeNum(val: number | null | undefined): number | null {
  if (val === null || val === undefined || !isFinite(val) || isNaN(val)) return null;
  return val;
}

function computeCLV(closingLine: number | null | undefined, liveLine: number | null | undefined): number | null {
  const cl = safeNum(closingLine);
  const ll = safeNum(liveLine);
  if (cl === null || ll === null) return null;
  return round1(Math.abs(ll - cl));
}

function lineMovedTowardPublic(openLine: number | null | undefined, closingLine: number | null | undefined, publicPct: number | null | undefined, isTotal: boolean): boolean | null {
  const ol = safeNum(openLine);
  const cl = safeNum(closingLine);
  const pp = safeNum(publicPct);
  if (ol === null || cl === null || pp === null) return null;
  if (isTotal) {
    if (pp > 50) {
      return cl > ol;
    } else if (pp < 50) {
      return cl < ol;
    }
  } else {
    if (pp > 50) {
      return cl < ol;
    } else if (pp < 50) {
      return cl > ol;
    }
  }
  return false;
}

// ── Market labels ────────────────────────────────────────────────────────────
const MARKET_LABELS: Record<NCAABMarketKey, string> = {
  full_total: "Full Game Total",
  full_spread: "Full Game Spread",
  h1_total: "1st Half Total",
  h1_spread: "1st Half Spread",
  h2_total: "2nd Half Total",
  h2_spread: "2nd Half Spread",
};

// ── Full Engine Pipeline ──────────────────────────────────────────────────────
export function runNCAABEngine(input: NCAABGameInput): NCAABEngineOutput {
  const now = Date.now();
  const warnings: string[] = [];
  const explanationBullets: string[] = [];

  const oddsCache = new Map<number, number>();
  function cachedAmericanToImpliedPct(odds: number): number {
    const cached = oddsCache.get(odds);
    if (cached !== undefined) return cached;
    const result = americanToImpliedPct(odds);
    oddsCache.set(odds, result);
    return result;
  }

  const projection = calculateNCAABProjection(input);
  const probabilities = calculateNCAABProbabilities(input, projection);

  const secsRemaining = input.isHalftime
    ? 1200
    : (input.half === 2 ? input.secondsRemainingInHalf : input.secondsRemainingInHalf + 1200);
  const secsElapsed = Math.max(0, TOTAL_GAME_SECONDS - secsRemaining);
  const { value: dynamicMult, clamped, attempted } = getDynamicMultiplier(secsRemaining, TOTAL_GAME_SECONDS, input.period, 2);
  if (clamped) {
    warnings.push(`Dynamic multiplier clamped: attempted=${attempted}, used=${dynamicMult}`);
  }

  const effectiveLine = input.liveTotalLine
    ?? Math.round(projection.finalProjectedTotal * 2) / 2;

  const sideResult = determineRecommendedSide(
    projection.finalProjectedTotal,
    effectiveLine,
    probabilities.calibratedOverProb,
    probabilities.calibratedUnderProb
  );
  warnings.push(...sideResult.warnings);

  const projGap = Math.abs(projection.finalProjectedTotal - effectiveLine);
  const dominantProb = sideResult.side === "OVER"
    ? probabilities.calibratedOverProb
    : sideResult.side === "UNDER"
    ? probabilities.calibratedUnderProb
    : Math.max(probabilities.calibratedOverProb, probabilities.calibratedUnderProb);

  const confidenceTier = getConfidenceTier(dominantProb, projGap);

  if (sideResult.side !== "NO_EDGE") {
    explanationBullets.push(`Projection: ${round1(projection.finalProjectedTotal)} vs line ${effectiveLine}`);
    explanationBullets.push(`Edge: ${round1(projGap)} pts, ${round1(dominantProb)}% confidence`);
  }

  const impliedBookOverProb = input.overOddsAmerican !== null
    ? cachedAmericanToImpliedPct(input.overOddsAmerican)
    : null;
  const impliedBookUnderProb = impliedBookOverProb !== null
    ? round1(100 - impliedBookOverProb)
    : null;

  const edgePctOver = impliedBookOverProb !== null
    ? round1(probabilities.calibratedOverProb - impliedBookOverProb)
    : null;
  const edgePctUnder = impliedBookUnderProb !== null
    ? round1(probabilities.calibratedUnderProb - impliedBookUnderProb)
    : null;

  const edgePctSpread = round1(probabilities.calibratedSpreadProb - 50);

  let over1HProb = probabilities.calibrated1HProb;
  const postH1Settled = (input.isHalftime || input.half === 2) && input.h1TotalLine !== null;
  if (postH1Settled && input.h1TotalLine !== null) {
    const h1Total = input.h1HomeScore + input.h1AwayScore;
    if (h1Total > 0) {
      over1HProb = h1Total > input.h1TotalLine ? 99 : h1Total < input.h1TotalLine ? 1 : 50;
    }
  }

  // Non-canonical marketVerdicts (team totals — outside the 6 canonical markets)
  const marketVerdicts: NCAABMarketVerdict[] = [];

  // H1 spread intermediate computation (used for canonical market)
  let h1SpreadComputed: { line: number; projection: number; prob: number } | null = null;
  if (
    input.h1SpreadLine !== null &&
    projection.proj1HTeamTotalHome !== null &&
    projection.proj1HTeamTotalAway !== null
  ) {
    const proj1HSpread = round1(projection.proj1HTeamTotalHome - projection.proj1HTeamTotalAway);
    const adjustedH1SpreadLine = input.h1Favorite.toLowerCase() === "home"
      ? -input.h1SpreadLine
      : input.h1SpreadLine;
    const h1SpreadSigma = MARKET_VARIANCE.h1_spread / dynamicMult;
    const rawH1SpreadProb = normalCDF((proj1HSpread - adjustedH1SpreadLine) / h1SpreadSigma) * 100;
    const calibH1SpreadOver = round1(calibrateNCAABProbability(rawH1SpreadProb, "h1_spread", { secsElapsed }));
    h1SpreadComputed = { line: adjustedH1SpreadLine, projection: proj1HSpread, prob: calibH1SpreadOver };
  }

  // team_total_home and team_total_away are not canonical markets; they are NOT added to
  // marketVerdicts here. marketVerdicts is populated solely from the canonical 6-market loop below.


  // H2 spread intermediate computation (used for canonical market)
  let h2SpreadComputed: { line: number; projection: number; prob: number } | null = null;
  if (
    input.h2SpreadLine !== null &&
    projection.proj2HTeamTotalHome !== null &&
    projection.proj2HTeamTotalAway !== null
  ) {
    const proj2HSpread = round1(projection.proj2HTeamTotalHome - projection.proj2HTeamTotalAway);
    const adjustedH2SpreadLine = input.h2Favorite.toLowerCase() === "home"
      ? -input.h2SpreadLine
      : input.h2SpreadLine;
    const h2SpreadSigma = MARKET_VARIANCE.h2_spread / dynamicMult;
    const rawH2SpreadProb = normalCDF((proj2HSpread - adjustedH2SpreadLine) / h2SpreadSigma) * 100;
    const calibH2SpreadOver = round1(calibrateNCAABProbability(rawH2SpreadProb, "h2_spread", { secsElapsed }));
    h2SpreadComputed = { line: adjustedH2SpreadLine, projection: proj2HSpread, prob: calibH2SpreadOver };
  }

  // Team-total entries are NOT pushed to marketVerdicts — only canonical 6 markets populate it

  // ── Build canonical markets object (6 keys, always present) ─────────────────
  const isPreGameOrH1 = !input.isHalftime && input.half <= 1;
  const hasHalftimeStarted = input.isHalftime || input.half >= 2;

  function buildMarket(
    key: NCAABMarketKey,
    bookLine: number | null,
    projectionVal: number | null,
    modelProbRaw: number | null,
    bookOdds: number | null | undefined,
    sportsbook: string | null,
  ): NCAABMarket {
    const label = MARKET_LABELS[key];
    if (projectionVal !== null && (!isFinite(projectionVal) || isNaN(projectionVal))) {
      return unavailableMarket(key, label);
    }
    const modelProb = clampProb(modelProbRaw);
    if (modelProb === null || bookLine === null) {
      return unavailableMarket(key, label);
    }
    // G7: odds that are 0, null, undefined, NaN, or outside [-2000, +2000] → unavailable.
    // Valid odds are required to compute bookImpliedProb and edge.
    const oddsInvalid =
      bookOdds === null ||
      bookOdds === undefined ||
      bookOdds === 0 ||
      Number.isNaN(bookOdds) ||
      Math.abs(bookOdds) > 2000;
    if (oddsInvalid) {
      return unavailableMarket(key, label);
    }
    const bookImpliedProb = round1(cachedAmericanToImpliedPct(bookOdds));
    const edge = round1(modelProb - bookImpliedProb);
    if (!isFinite(edge) || isNaN(edge)) {
      return unavailableMarket(key, label);
    }
    const isSpread = key.includes("spread");
    const side: MarketSide = isSpread
      ? (modelProb > 55 ? "HOME" : modelProb < 45 ? "AWAY" : null)
      : (modelProb > 55 ? "OVER" : modelProb < 45 ? "UNDER" : null);
    const confidenceTierVal = edge !== null ? getMarketConfidenceTier(edge) : "NONE";
    const roundedProb = round1(modelProb);
    return {
      available: true,
      marketKey: key,
      label,
      sportsbook,
      bookLine,
      projection: projectionVal !== null ? round1(projectionVal) : null,
      modelProb: roundedProb,
      bookImpliedProb,
      edge,
      side,
      confidenceTier: confidenceTierVal,
      clvEdge: null,
      publicBetPct: null,
      publicInflation: null,
      fadeRecommended: null,
      adjustedEdgeScore: null,
    };
  }

  const defaultSportsbook = "fanduel";

  // full_total: available pre-game and during live play (G1)
  const fullTotalMarket = input.liveTotalLine !== null
    ? buildMarket("full_total", input.liveTotalLine, projection.finalProjectedTotal, probabilities.calibratedOverProb, input.overOddsAmerican, defaultSportsbook)
    : unavailableMarket("full_total", MARKET_LABELS.full_total);

  // full_spread: available pre-game and during live play (G1)
  const fullSpreadMarket = input.liveSpreadLine !== null
    ? (() => {
        const adjustedLine = input.liveSpreadFavorite &&
          input.liveSpreadFavorite.toLowerCase().includes(input.homeTeam.toLowerCase().split(" ").pop() ?? "")
          ? -input.liveSpreadLine : input.liveSpreadLine;
        return buildMarket("full_spread", adjustedLine, projection.finalProjectedSpread, probabilities.calibratedSpreadProb, input.spreadOddsAmerican, defaultSportsbook);
      })()
    : unavailableMarket("full_spread", MARKET_LABELS.full_spread);

  // h1_total: available pre-game and during H1 only; unavailable once halftime begins (G1)
  const h1TotalOdds = input.h1TotalOverOdds ?? input.h1OverOddsAmerican;
  const h1TotalMarket = isPreGameOrH1 && input.h1TotalLine !== null && over1HProb !== null
    ? buildMarket("h1_total", input.h1TotalLine, projection.proj1HTotal, over1HProb, h1TotalOdds, defaultSportsbook)
    : unavailableMarket("h1_total", MARKET_LABELS.h1_total);

  const h1SpreadOdds = input.h1SpreadHomeOdds ?? input.h1SpreadOddsAmerican;
  const h1SpreadMarket = isPreGameOrH1 && h1SpreadComputed
    ? buildMarket("h1_spread", h1SpreadComputed.line, h1SpreadComputed.projection, h1SpreadComputed.prob, h1SpreadOdds, defaultSportsbook)
    : unavailableMarket("h1_spread", MARKET_LABELS.h1_spread);

  // h2_total: unavailable until halftime has started AND sportsbook H2 line exists (G1)
  const h2TotalMarket = hasHalftimeStarted && input.h2TotalLine !== null && probabilities.calibrated2HProb !== null
    ? buildMarket("h2_total", input.h2TotalLine, projection.proj2HTotal, probabilities.calibrated2HProb, input.h2OverOddsAmerican, defaultSportsbook)
    : unavailableMarket("h2_total", MARKET_LABELS.h2_total);

  // h2_spread: unavailable until halftime has started AND sportsbook H2 spread line exists (G1)
  const h2SpreadMarket = hasHalftimeStarted && h2SpreadComputed
    ? buildMarket("h2_spread", h2SpreadComputed.line, h2SpreadComputed.projection, h2SpreadComputed.prob, input.h2SpreadOddsAmerican, defaultSportsbook)
    : unavailableMarket("h2_spread", MARKET_LABELS.h2_spread);

  const markets: NCAABMarkets = {
    full_total: fullTotalMarket,
    full_spread: fullSpreadMarket,
    h1_total: h1TotalMarket,
    h1_spread: h1SpreadMarket,
    h2_total: h2TotalMarket,
    h2_spread: h2SpreadMarket,
  };

  const spreadCLV = computeCLV(input.closingSpread, input.liveSpread);
  const totalCLV = computeCLV(input.closingTotal, input.liveTotal);
  const publicInflationSpread = lineMovedTowardPublic(input.openSpread, input.closingSpread, input.publicSpreadPct, false);
  const publicInflationTotal = lineMovedTowardPublic(input.openTotal, input.closingTotal, input.publicTotalPct, true);

  function attachIntelligence(mkt: NCAABMarket, clv: number | null, pubPct: number | null | undefined, inflation: boolean | null): void {
    if (!mkt.available) return;
    const hasSportsbookData = clv !== null || inflation !== null || safeNum(pubPct ?? null) !== null;
    if (!hasSportsbookData) return;

    mkt.clvEdge = clv;
    mkt.publicBetPct = safeNum(pubPct ?? null);
    mkt.publicInflation = inflation;
    mkt.fadeRecommended = inflation === true && clv !== null && clv >= 1.0 ? true : false;

    const CLV_BONUS = 0.5;
    const INFLATION_BONUS = 1.0;
    let adjusted = mkt.edge ?? 0;
    if (clv !== null) adjusted += clv * CLV_BONUS;
    if (inflation === true) adjusted += INFLATION_BONUS;
    mkt.adjustedEdgeScore = round1(adjusted);

    if (clv !== null && clv >= 1.5 && inflation === true) {
      const tierRank: Record<MarketConfidenceTier, number> = { NONE: 0, VALUE: 1, STRONG: 2, ELITE: 3 };
      if (tierRank[mkt.confidenceTier] < tierRank["ELITE"]) {
        mkt.confidenceTier = "ELITE";
      }
    }
  }

  const spreadKeys: NCAABMarketKey[] = ["full_spread", "h1_spread", "h2_spread"];
  const totalKeys: NCAABMarketKey[] = ["full_total", "h1_total", "h2_total"];

  for (const key of spreadKeys) {
    attachIntelligence(markets[key], spreadCLV, input.publicSpreadPct, publicInflationSpread);
  }
  for (const key of totalKeys) {
    attachIntelligence(markets[key], totalCLV, input.publicTotalPct, publicInflationTotal);
  }

  const CANONICAL_VERDICT_MAP: Record<NCAABMarketKey, NCAABMarketType> = {
    full_total: "full_game_total",
    full_spread: "spread",
    h1_total: "h1_total",
    h1_spread: "h1_spread",
    h2_total: "h2_total",
    h2_spread: "h2_spread",
  };
  function marketSideToRecommended(s: MarketSide): RecommendedSide {
    if (s === "OVER" || s === "HOME") return "OVER";
    if (s === "UNDER" || s === "AWAY") return "UNDER";
    return "NO_EDGE";
  }
  for (const key of ALL_MARKET_KEYS) {
    const mkt = markets[key];
    if (!mkt.available) continue;
    const verdictMarket = CANONICAL_VERDICT_MAP[key];
    marketVerdicts.push({
      market: verdictMarket,
      projection: mkt.projection,
      line: mkt.bookLine,
      overProb: mkt.modelProb,
      underProb: mkt.modelProb !== null ? round1(100 - mkt.modelProb) : null,
      side: marketSideToRecommended(mkt.side),
      confidenceTier: mkt.confidenceTier === "ELITE" ? "HIGH" : mkt.confidenceTier === "STRONG" ? "MEDIUM" : mkt.confidenceTier === "VALUE" ? "LOW" : "NO_EDGE",
      edge: mkt.edge,
    });
  }

  // Guardrail 8: debug markets (non-production only)
  const debugMarkets: NCAABDebugMarketEntry[] | undefined =
    process.env.NODE_ENV !== "production"
      ? ALL_MARKET_KEYS.map(key => ({
          marketKey: key,
          projection: markets[key].projection,
          bookLine: markets[key].bookLine,
          modelProb: markets[key].modelProb,
          bookImpliedProb: markets[key].bookImpliedProb,
          edge: markets[key].edge,
          confidenceTier: markets[key].confidenceTier,
          clvEdge: markets[key].clvEdge ?? null,
          publicBetPct: markets[key].publicBetPct ?? null,
          publicInflation: markets[key].publicInflation ?? null,
        }))
      : undefined;

  const engineOutput: NCAABEngineOutput = {
    gameId: input.gameId,
    sport: "ncaab",
    marketType: "full_game_total",

    projectedTotal: round1(projection.finalProjectedTotal),
    projected1HTotal: projection.proj1HTotal !== null ? round1(projection.proj1HTotal) : null,
    projected2HTotal: projection.proj2HTotal !== null ? round1(projection.proj2HTotal) : null,
    projectedSpread: round1(projection.finalProjectedSpread),
    projectedTeamTotalHome: round1(projection.finalProjectedTeamTotalA),
    projectedTeamTotalAway: round1(projection.finalProjectedTeamTotalB),

    rawOverProb: probabilities.rawOverProb,
    rawUnderProb: probabilities.rawUnderProb,
    rawSpreadProb: probabilities.rawSpreadProb,
    calibratedOverProb: probabilities.calibratedOverProb,
    calibratedUnderProb: probabilities.calibratedUnderProb,
    calibratedSpreadProb: probabilities.calibratedSpreadProb,
    over1HProb,
    over2HProb: probabilities.calibrated2HProb,

    impliedBookOverProb: impliedBookOverProb !== null ? round1(impliedBookOverProb) : null,
    impliedBookUnderProb,

    edgePctOver,
    edgePctUnder,
    edgePctSpread,

    recommendedSide: sideResult.side,
    confidenceTier,
    explanationBullets,
    dominantMarket: (() => {
      const oe = Math.abs(probabilities.calibratedOverProb - 50);
      const se = Math.abs(probabilities.calibratedSpreadProb - 50);
      if (se > oe + 3) return "spread" as const;
      return probabilities.calibratedOverProb >= 50 ? "over" as const : "under" as const;
    })(),

    displayProjection: round1(projection.finalProjectedTotal).toFixed(1),
    displayProbability: `${round1(dominantProb).toFixed(1)}%`,
    displayPick: sideResult.side,

    markets,
    marketVerdicts,

    ...(debugMarkets ? { debugMarkets } : {}),

    displayOutput: null as unknown as NCAABDisplayOutput,

    warnings,
    engineGeneratedAt: now,

    debug: {
      baseProjection: projection.baseProjection,
      paceAdjustment: projection.paceAdjustment,
      halfBlend: projection.halfBlend,
      projectedPossessionsRemaining: null,
      varianceEstimate: DEFAULT_VARIANCE,
      rawProbability: probabilities.rawOverProb,
      calibratedProbability: probabilities.calibratedOverProb,
      dynamicMultiplier: dynamicMult,
      sideDecisionReason: sideResult.reason,
      validationWarnings: [],
    },
  };

  const preValidationDisplay = buildNCAABDisplayOutput(engineOutput);
  const validationWarnings = validateDisplayConsistency(input, engineOutput, preValidationDisplay);
  engineOutput.warnings.push(...validationWarnings);
  if (engineOutput.debug) {
    engineOutput.debug.validationWarnings = validationWarnings;
  }
  engineOutput.displayOutput = buildNCAABDisplayOutput(engineOutput);

  return engineOutput;
}

export function buildTopPlaysFeed(
  outputs: Array<NCAABEngineOutput & { gameId: string }>,
): NCAABMarket[] {
  const bestByKey = new Map<string, { market: NCAABMarket; absEdge: number }>();
  for (const output of outputs) {
    for (const key of ALL_MARKET_KEYS) {
      const mkt = output.markets[key];
      if (!mkt.available || mkt.edge === null) continue;
      const absEdge = Math.abs(mkt.edge);
      const dedupeKey = `${output.gameId}:${mkt.marketKey}`;
      const existing = bestByKey.get(dedupeKey);
      if (!existing || absEdge > existing.absEdge) {
        bestByKey.set(dedupeKey, { market: mkt, absEdge });
      }
    }
  }
  return Array.from(bestByKey.values())
    .sort((a, b) => b.absEdge - a.absEdge)
    .slice(0, 20)
    .map(e => e.market);
}

function computeTeamTotalProb(proj: number, line: number, secsRemaining: number): number {
  const secsElapsed = Math.max(0, TOTAL_GAME_SECONDS - secsRemaining);
  if (secsElapsed < 60) return 50;
  const diff = proj - line;
  const sigma = MARKET_VARIANCE["team_total_home"];
  const raw = normalCDF(diff / sigma) * 100;
  return calibrateNCAABProbability(raw, "team_total_home", { secsElapsed });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function americanToImpliedPct(odds: number): number {
  if (odds === 0) return 50;
  return odds < 0
    ? Math.abs(odds) / (Math.abs(odds) + 100) * 100
    : 100 / (odds + 100) * 100;
}

function isValidAmericanOdds(odds: number | null | undefined): odds is number {
  if (odds == null || odds === 0) return false;
  return odds >= -2000 && odds <= 2000;
}

function clamp1_99(v: number): number {
  return Math.max(1, Math.min(99, v));
}


// ── Exports for testing ───────────────────────────────────────────────────────
export { normalCDF, EDGE_MIN_GAP, EDGE_MIN_PROB, CALIBRATION_CAP, CALIBRATION_WARN_THRESHOLD, DEFAULT_VARIANCE };
