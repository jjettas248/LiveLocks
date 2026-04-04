import {
  type NBAArchetype,
  VARIANCE_MULTIPLIERS,
  MINUTES_FRAGILITY_MULTIPLIERS,
  CORRELATION_DEFAULTS,
  COMBO_VARIANCE_EXTRA,
  isVolatileArchetype,
  isImpactedArchetype,
  getSafetyCeiling,
} from "./archetypes";

const STAT_SIGMA_FLOORS: Record<string, number> = {
  points: 3.0,
  rebounds: 2.0,
  assists: 1.8,
  steals: 0.8,
  blocks: 0.8,
  threes: 1.2,
};

const COMBO_INFLATION: Record<string, number> = {
  pts_reb: 1.05,
  pts_ast: 1.08,
  reb_ast: 1.08,
  pts_reb_ast: 1.12,
};

const SINGLE_EPSILON = 0.35;
const COMBO_EPSILON = 0.60;

function phi(z: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

export type SingleStat = "points" | "rebounds" | "assists" | "steals" | "blocks" | "threes";
export type ComboStat = "pts_reb" | "pts_ast" | "reb_ast" | "pts_reb_ast";
export type MarketType = SingleStat | ComboStat;

export function isComboMarket(m: string): boolean {
  return m === "pts_reb" || m === "pts_ast" || m === "reb_ast" || m === "pts_reb_ast" || m === "stl_blk";
}

export interface StatRates {
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  threes: number;
}

export interface StatVarianceRates {
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  threes: number;
}

export interface MinutesModel {
  expected: number;
  variance: number;
}

export interface EngineInput {
  playerName: string;
  playerId: number;
  gameId: string;
  market: MarketType | string;
  line: number;
  bookOdds?: number;

  archetype: NBAArchetype;

  rateRecent: Partial<StatRates>;
  rateSeason: Partial<StatRates>;
  rateRole: Partial<StatRates>;
  recentGameCount: number;

  varianceRateRecent: Partial<StatVarianceRates>;
  varianceRateSeason: Partial<StatVarianceRates>;
  varianceRateRole: Partial<StatVarianceRates>;

  minutes: MinutesModel;

  currentStat: number;
  minutesPlayed: number;

  fragilityInputs: FragilityInputs;

  empiricalCorrelations?: Partial<{
    rho_PR: number;
    rho_PA: number;
    rho_RA: number;
  }>;
}

export interface FragilityInputs {
  normalizedMinutesVariance: number;
  roleUncertainty: number;
  lineupInstability: number;
  blowoutRisk: number;
  usageShock: number;
  lateSeasonChaos: number;
}

export interface EngineOutput {
  market: string;
  direction: "OVER" | "UNDER" | "NO_SIGNAL";
  displayConfidence: number | null;
  modelEdge: number;
  projection: number;
  line: number;

  rawProbabilityOver: number;
  rawProbabilityUnder: number;
  finalProbabilityOver: number;
  finalProbabilityUnder: number;

  mu: number;
  sigma: number;
  zScore: number;

  archetype: NBAArchetype;
  minutesExpected: number;
  minutesVariance: number;
  playerVolatilityScore: number;
  comboCovarianceEstimate: number | null;

  fragilityScore: number;
  fragilityPenalty: number;
  fragilityReasons: string[];

  familyPenaltyFactor: number;
  confidenceCeilingApplied: boolean;
  ceilingReason: string | null;
  calibrationTrack: string;

  noSignal: boolean;
  noSignalReasons: string[];
  warnings: string[];
}

function getBlendedRate(
  stat: string,
  rateRecent: Partial<StatRates>,
  rateSeason: Partial<StatRates>,
  rateRole: Partial<StatRates>,
  recentGameCount: number,
): number {
  const recent = (rateRecent as any)[stat] as number | undefined;
  const season = (rateSeason as any)[stat] as number | undefined;
  const role = (rateRole as any)[stat] as number | undefined;

  let wRecent = 0.45, wSeason = 0.35, wRole = 0.20;
  if (recentGameCount < 5) {
    const reduction = wRecent * (1 - recentGameCount / 5);
    wRecent -= reduction;
    wSeason += reduction;
  }

  let total = 0, wTotal = 0;
  if (recent != null) { total += wRecent * recent; wTotal += wRecent; }
  if (season != null) { total += wSeason * season; wTotal += wSeason; }
  if (role != null)   { total += wRole * role;     wTotal += wRole; }

  if (wTotal === 0) return 0;
  return total / wTotal * (wRecent + wSeason + wRole);
}

function getBlendedVarianceRate(
  stat: string,
  varRecent: Partial<StatVarianceRates>,
  varSeason: Partial<StatVarianceRates>,
  varRole: Partial<StatVarianceRates>,
): number {
  const recent = (varRecent as any)[stat] as number | undefined;
  const season = (varSeason as any)[stat] as number | undefined;
  const role = (varRole as any)[stat] as number | undefined;

  let total = 0, wTotal = 0;
  if (recent != null) { total += 0.50 * recent; wTotal += 0.50; }
  if (season != null) { total += 0.30 * season; wTotal += 0.30; }
  if (role != null)   { total += 0.20 * role;   wTotal += 0.20; }

  if (wTotal === 0) return 0.5;
  return total / wTotal;
}

const COMBO_COMPONENTS: Record<string, SingleStat[]> = {
  pts_reb: ["points", "rebounds"],
  pts_ast: ["points", "assists"],
  reb_ast: ["rebounds", "assists"],
  pts_reb_ast: ["points", "rebounds", "assists"],
  stl_blk: ["steals", "blocks"],
};

function computeSingleStatMeanAndVariance(
  stat: SingleStat,
  input: EngineInput,
): { mu: number; variance: number; rate: number } {
  const rate = getBlendedRate(
    stat, input.rateRecent, input.rateSeason, input.rateRole, input.recentGameCount,
  );
  const E_min = Math.max(8, input.minutes.expected);
  const mu = rate * E_min;

  const vRate = getBlendedVarianceRate(
    stat, input.varianceRateRecent, input.varianceRateSeason, input.varianceRateRole,
  );

  const sigma_min = Math.max(1.5, Math.sqrt(Math.max(input.minutes.variance, 0)));
  const sigma_min_adj = sigma_min * MINUTES_FRAGILITY_MULTIPLIERS[input.archetype];
  const Var_min = sigma_min_adj * sigma_min_adj;
  const rawVariance = E_min * vRate + (rate * rate) * Var_min;

  const archetypeMultiplier = VARIANCE_MULTIPLIERS[input.archetype];
  let adjVariance = rawVariance * archetypeMultiplier;

  const floor = STAT_SIGMA_FLOORS[stat] ?? 1.0;
  const floorVariance = floor * floor;
  if (adjVariance < floorVariance) adjVariance = floorVariance;

  return { mu, variance: adjVariance, rate };
}

function getCorrelation(
  statA: SingleStat,
  statB: SingleStat,
  archetype: NBAArchetype,
  empirical?: Partial<{ rho_PR: number; rho_PA: number; rho_RA: number }>,
): number {
  const defaults = CORRELATION_DEFAULTS[archetype];
  const key = getCorrelationKey(statA, statB);
  if (!key) return 0;
  if (empirical && (empirical as any)[key] != null) return (empirical as any)[key];
  return (defaults as any)[key] ?? 0;
}

function getCorrelationKey(a: SingleStat, b: SingleStat): string | null {
  const pair = [a, b].sort().join(",");
  const map: Record<string, string> = {
    "assists,points": "rho_PA",
    "points,rebounds": "rho_PR",
    "assists,rebounds": "rho_RA",
  };
  return map[pair] ?? null;
}

function computeComboMeanAndVariance(
  market: string,
  input: EngineInput,
): { mu: number; variance: number; covEstimate: number } {
  const components = COMBO_COMPONENTS[market];
  if (!components) return { mu: 0, variance: 0, covEstimate: 0 };

  const stats = components.map(s => computeSingleStatMeanAndVariance(s, input));
  let mu = 0;
  let variance = 0;
  let totalCov = 0;

  for (const s of stats) {
    mu += s.mu;
    variance += s.variance;
  }

  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const rho = getCorrelation(components[i], components[j], input.archetype, input.empiricalCorrelations);
      const cov = 2 * rho * Math.sqrt(stats[i].variance) * Math.sqrt(stats[j].variance);
      variance += cov;
      totalCov += cov;
    }
  }

  const extraMultiplier = COMBO_VARIANCE_EXTRA[input.archetype];
  variance *= extraMultiplier;

  const inflation = COMBO_INFLATION[market] ?? 1.0;
  variance *= inflation;

  return { mu, variance, covEstimate: totalCov };
}

function computeFragilityScore(inputs: FragilityInputs): { score: number; reasons: string[] } {
  const score =
    0.25 * inputs.normalizedMinutesVariance +
    0.20 * inputs.roleUncertainty +
    0.20 * inputs.lineupInstability +
    0.15 * inputs.blowoutRisk +
    0.10 * inputs.usageShock +
    0.10 * inputs.lateSeasonChaos;

  const reasons: string[] = [];
  if (inputs.normalizedMinutesVariance > 0.5) reasons.push("high_minutes_variance");
  if (inputs.roleUncertainty > 0.5)           reasons.push("role_uncertain");
  if (inputs.lineupInstability > 0.5)          reasons.push("lineup_unstable");
  if (inputs.blowoutRisk > 0.5)               reasons.push("blowout_risk");
  if (inputs.usageShock > 0.3)                 reasons.push("usage_shock");
  if (inputs.lateSeasonChaos > 0.3)            reasons.push("late_season_chaos");

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

export interface CalibrationContext {
  isCombo: boolean;
  direction: "OVER" | "UNDER";
  archetype: NBAArchetype;
  underBiasCorrectionActive: boolean;
}

function calibrate(pSide: number, ctx: CalibrationContext): { calibrated: number; track: string } {
  let p = pSide;
  let track = "";

  const shrink = ctx.isCombo ? 0.78 : 0.88;
  p = 0.5 + (p - 0.5) * shrink;
  track = ctx.isCombo ? "combo_shrink_0.78" : "single_shrink_0.88";

  if (isVolatileArchetype(ctx.archetype) || isImpactedArchetype(ctx.archetype)) {
    p = 0.5 + (p - 0.5) * 0.90;
    track += "+volatile_0.90";
  }

  if (ctx.direction === "UNDER" && ctx.underBiasCorrectionActive) {
    p = 0.5 + (p - 0.5) * 0.95;
    track += "+under_correction_0.95";
  }

  return { calibrated: p, track };
}

export function computeProbability(
  input: EngineInput,
  options: {
    familyPenaltyFactor?: number;
    underBiasCorrectionActive?: boolean;
  } = {},
): EngineOutput {
  const combo = isComboMarket(input.market);
  const noSignalReasons: string[] = [];
  const warnings: string[] = [];

  let mu: number, variance: number, covEstimate: number | null = null;

  if (combo) {
    const result = computeComboMeanAndVariance(input.market, input);
    mu = result.mu;
    variance = result.variance;
    covEstimate = result.covEstimate;
  } else {
    const result = computeSingleStatMeanAndVariance(input.market as SingleStat, input);
    mu = result.mu;
    variance = result.variance;
  }

  const projection = input.currentStat + mu;
  const sigma = Math.sqrt(Math.max(variance, 0.01));

  const epsilon = combo ? COMBO_EPSILON : SINGLE_EPSILON;
  const separation = Math.abs(mu + input.currentStat - input.line);

  const threshold = input.line + 0.5;
  const totalMu = input.currentStat + mu;
  const z = (totalMu - threshold) / sigma;

  const P_over_raw = phi(z);
  const P_under_raw = 1 - P_over_raw;

  let rawSide: "OVER" | "UNDER" | "NO_SIGNAL";
  let P_side_raw: number;

  if (totalMu > input.line && separation >= epsilon) {
    rawSide = "OVER";
    P_side_raw = P_over_raw;
  } else if (totalMu < input.line && separation >= epsilon) {
    rawSide = "UNDER";
    P_side_raw = P_under_raw;
  } else {
    rawSide = "NO_SIGNAL";
    P_side_raw = Math.max(P_over_raw, P_under_raw);
    noSignalReasons.push("insufficient_separation");
  }

  const modelEdgeRaw = P_side_raw - 0.50;
  if (modelEdgeRaw < 0.04 && rawSide !== "NO_SIGNAL") {
    noSignalReasons.push("model_edge_below_0.04");
  }

  const { score: fragilityScore, reasons: fragilityReasons } = computeFragilityScore(input.fragilityInputs);
  const fragilityPenalty = 0.45 * fragilityScore;
  const P_side_fragile = 0.5 + (P_side_raw - 0.5) * (1 - fragilityPenalty);

  const familyPenaltyFactor = options.familyPenaltyFactor ?? 1.0;
  const P_side_family = 0.5 + (P_side_fragile - 0.5) * familyPenaltyFactor;

  let P_side_directional = P_side_family;
  const underBiasActive = options.underBiasCorrectionActive ?? false;
  if (rawSide === "UNDER" && underBiasActive) {
    P_side_directional = 0.5 + (P_side_family - 0.5) * 0.92;
  }

  const calCtx: CalibrationContext = {
    isCombo: combo,
    direction: rawSide === "NO_SIGNAL" ? "UNDER" : rawSide,
    archetype: input.archetype,
    underBiasCorrectionActive: underBiasActive,
  };
  const { calibrated: P_side_calibrated, track: calibrationTrack } = calibrate(P_side_directional, calCtx);

  const ceiling = getSafetyCeiling(input.archetype, combo);
  let P_side_final = P_side_calibrated;
  let confidenceCeilingApplied = false;
  let ceilingReason: string | null = null;

  if (P_side_final > ceiling) {
    P_side_final = ceiling;
    confidenceCeilingApplied = true;
    ceilingReason = `${input.archetype}_${combo ? "combo" : "single"}_cap_${ceiling}`;
  }

  let finalProbabilityOver: number, finalProbabilityUnder: number;
  if (rawSide === "OVER") {
    finalProbabilityOver = P_side_final;
    finalProbabilityUnder = 1 - P_side_final;
  } else {
    finalProbabilityUnder = P_side_final;
    finalProbabilityOver = 1 - P_side_final;
  }

  let direction: "OVER" | "UNDER" | "NO_SIGNAL" = rawSide;
  let displayConfidence: number | null = null;

  if (direction !== "NO_SIGNAL") {
    displayConfidence = P_side_final;
    const finalEdge = P_side_final - 0.50;

    if (displayConfidence < 0.58) noSignalReasons.push("display_confidence_below_0.58");
    if (finalEdge < 0.04) noSignalReasons.push("final_edge_below_0.04");
  }

  if (rawSide === "OVER" && projection <= input.line) {
    warnings.push("direction_projection_mismatch");
    noSignalReasons.push("projection_mismatch");
  }
  if (rawSide === "UNDER" && projection >= input.line) {
    warnings.push("direction_projection_mismatch");
    noSignalReasons.push("projection_mismatch");
  }

  if (!Number.isFinite(P_side_final)) {
    noSignalReasons.push("non_finite_probability");
  }

  const noSignal = noSignalReasons.length > 0;
  if (noSignal) {
    direction = "NO_SIGNAL";
    displayConfidence = null;
  }

  const modelEdge = P_side_final - 0.50;

  const playerVolatilityScore = fragilityScore;

  return {
    market: input.market,
    direction,
    displayConfidence,
    modelEdge,
    projection,
    line: input.line,

    rawProbabilityOver: round4(P_over_raw),
    rawProbabilityUnder: round4(P_under_raw),
    finalProbabilityOver: round4(finalProbabilityOver),
    finalProbabilityUnder: round4(finalProbabilityUnder),

    mu: round2(totalMu),
    sigma: round2(sigma),
    zScore: round3(z),

    archetype: input.archetype,
    minutesExpected: round1(input.minutes.expected),
    minutesVariance: round2(input.minutes.variance),
    playerVolatilityScore: round3(playerVolatilityScore),
    comboCovarianceEstimate: covEstimate != null ? round3(covEstimate) : null,

    fragilityScore: round3(fragilityScore),
    fragilityPenalty: round3(fragilityPenalty),
    fragilityReasons,

    familyPenaltyFactor,
    confidenceCeilingApplied,
    ceilingReason,
    calibrationTrack,

    noSignal,
    noSignalReasons,
    warnings,
  };
}

export function getEngineConstants() {
  return {
    SINGLE_EPSILON,
    COMBO_EPSILON,
    STAT_SIGMA_FLOORS: { ...STAT_SIGMA_FLOORS },
    COMBO_INFLATION: { ...COMBO_INFLATION },
    CALIBRATION_SINGLE: 0.88,
    CALIBRATION_COMBO: 0.78,
    VOLATILE_SHRINKAGE: 0.90,
    UNDER_BIAS_PRE_CAL: 0.92,
    UNDER_BIAS_IN_CAL: 0.95,
    FRAGILITY_MAX_PENALTY: 0.45,
    MIN_DISPLAY_CONFIDENCE: 0.58,
    MIN_MODEL_EDGE: 0.04,
    FRAGILITY_WEIGHTS: {
      normalizedMinutesVariance: 0.25,
      roleUncertainty: 0.20,
      lineupInstability: 0.20,
      blowoutRisk: 0.15,
      usageShock: 0.10,
      lateSeasonChaos: 0.10,
    },
  };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
