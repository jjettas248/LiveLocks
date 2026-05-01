export type MLBMarket =
  | "hits"
  | "total_bases"
  | "pitcher_strikeouts"
  | "hits_allowed"
  | "walks_allowed"
  | "home_runs"
  | "hrr"
  | "pitcher_outs"
  | "batter_strikeouts"
  | "hr_allowed";

export const DISABLED_MLB_MARKETS: MLBMarket[] = [
  "batter_strikeouts",
  "hr_allowed",
  "walks_allowed",
];

export const ALL_MLB_MARKETS: MLBMarket[] = [
  "hits",
  "total_bases",
  "pitcher_strikeouts",
  "hits_allowed",
  "home_runs",
  "hrr",
  "pitcher_outs",
];

// ── Phase 5: Game-level markets (team/game totals, F5) ────────────────────────
export type MLBGameMarket =
  | "full_game_total"
  | "f5_total"
  | "team_total_home"
  | "team_total_away";

export const ALL_MLB_GAME_MARKETS: MLBGameMarket[] = [
  "full_game_total",
  "f5_total",
  "team_total_home",
  "team_total_away",
];

export interface MLBGameMarketInput {
  gameId: string;
  inning: number;
  isTopInning: boolean;
  homeScore: number;
  awayScore: number;
  homeTeam: string;
  awayTeam: string;
  pitchCount: number;
  timesThrough: number;
  starterEra: number | null;
  parkFactor: number;
  // Sportsbook lines — null if unavailable
  fullGameLine: number | null;
  f5Line: number | null;
  teamTotalHomeLine: number | null;
  teamTotalAwayLine: number | null;
  fullGameOverOdds: number | null;
  fullGameUnderOdds: number | null;
  f5OverOdds: number | null;
  f5UnderOdds: number | null;
  sportsbook: string | null;
  lineSource: "sportsbook" | "inferred" | "derived";
}

export interface MLBGameMarketOutput {
  market: MLBGameMarket;
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  bookLine: number;
  projection: number;
  edge: number;
  recommendedSide: "OVER" | "UNDER" | "NO_EDGE";
  confidenceTier: MLBConfidenceTier;
  overOdds: number | null;
  underOdds: number | null;
  sportsbook: string | null;
  lineSource: "sportsbook" | "inferred" | "derived";
  engineGeneratedAt: number;
  signalTimestamp: number;
  isDerivedLine: boolean;
}

export const USER_FACING_MLB_MARKETS: MLBMarket[] = [
  "hits",
  "total_bases",
  "pitcher_strikeouts",
  "home_runs",
];

export const CORE_MARKETS: MLBMarket[] = [
  "hits",
  "total_bases",
  "pitcher_strikeouts",
];

export const EXPERIMENTAL_MARKETS: MLBMarket[] = ["home_runs", "batter_strikeouts", "hr_allowed"];

export const EXPERIMENTAL_CONFIDENCE_CEILING: MLBConfidenceTier = "STRONG";

export const MARKET_PROBABILITY_CEILINGS: Record<"core" | "experimental", number> = {
  core: 96,
  experimental: 90,
};

export const MARKET_PROBABILITY_CAPS: Record<MLBMarket, number> = {
  hits: 96,
  total_bases: 96,
  home_runs: 90,
  hrr: 94,
  pitcher_strikeouts: 96,
  pitcher_outs: 90,
  walks_allowed: 85,
  hits_allowed: 90,
  batter_strikeouts: 90,
  hr_allowed: 80,
};

export type ProjectionSource =
  | "engine_live_context"
  | "engine_live_plus_baseline"
  | "baseline_only"
  | "fallback_static";

export type ProjectionQuality = "HIGH" | "MEDIUM" | "LOW";

export type DistributionModelMethod =
  | "hit_distribution"
  | "tb_distribution"
  | "pitcher_k_distribution"
  | "hr_distribution"
  | "negative_binomial"
  | "binomial"
  | "normal_cdf";

export const MARKET_PROJECTION_TOLERANCE: Record<MLBMarket, number> = {
  hits: 0.08,
  total_bases: 0.15,
  home_runs: 0.05,
  hrr: 0.15,
  pitcher_strikeouts: 0.30,
  pitcher_outs: 0.50,
  walks_allowed: 0.20,
  hits_allowed: 0.30,
  batter_strikeouts: 0.15,
  hr_allowed: 0.10,
};

export const MARKET_QUALIFY_FLOOR: Record<MLBMarket, number> = {
  hits: 60,
  total_bases: 60,
  home_runs: 35,
  hrr: 58,
  pitcher_strikeouts: 60,
  pitcher_outs: 60,
  walks_allowed: 58,
  hits_allowed: 58,
  batter_strikeouts: 58,
  hr_allowed: 35,
};

export type ContactQualityTier = "ELITE" | "HARD" | "MEDIUM" | "SOFT";

export type MLBConfidenceTier = "ELITE" | "STRONG" | "LEAN" | "NO_EDGE";

export type MLBRecommendedSide = "OVER" | "UNDER" | "NO_EDGE";

export interface ContactQualityMetrics {
  exitVelocity: number | null;
  launchAngle: number | null;
  hitDistance: number | null;
  hardHitRateSeason: number | null;
  barrelRateProxySeason: number | null;
  avgBatSpeed: number | null;
  avgSwingLength: number | null;
  priorABResults: ABResult[];
  xBA: number | null;
  xSLG: number | null;
  learnedHitLikelihood?: number | null;
  learnedHrLikelihood?: number | null;
  pitchTypeHrRisk?: number | null;
}

export interface ABResult {
  exitVelocity: number | null;
  launchAngle: number | null;
  distance: number | null;
  outcome: "hit" | "out" | "strikeout" | "walk" | "hbp" | "error" | "other" | "home_run" | "hr" | "homerun";
  pitchType?: string | null;
  pitchSpeed?: number | null;
}

export interface PitcherContext {
  pitchCount: number;
  timesThrough: number;
  era: number | null;
  whip: number | null;
  kPer9: number | null;
  bbPer9: number | null;
  managerLeashShort: boolean;
  isPitcherCollapsing: boolean;
  pitchMix: PitchMixEntry[];
  throws: "L" | "R" | null;
  seasonAvgVelocity?: number | null;
}

export interface PitchMixEntry {
  pitchType: string;
  percentage: number;
  avgVelocity: number | null;
  pitchName?: string | null;
}

export interface LineupContext {
  battingOrderSlot: number;
  orderTurnoverProximity: number;
  lineupSectionStrength: "strong" | "neutral" | "weak";
  hittersAheadOnBase: number;
  pocketWeakness: number | null;
}

export interface WeatherParkContext {
  parkFactor: number;
  temperature: number | null;
  windSpeed: number | null;
  windDirection: "in" | "out" | "cross" | "calm" | null;
  humidity: number | null;
  isIndoors: boolean;
  parkHistoryFactor: number | null;
  windShiftDetected?: boolean;
}

export interface BullpenContext {
  bullpenEra: number | null;
  bullpenUsageLastThreeDays: number | null;
  isTopRelieverAvailable: boolean;
}

export interface BatterVsPitcherHistory {
  atBats: number;
  hits: number;
  homeRuns: number;
  strikeouts: number;
  avg: number | null;
}

export interface HRRComponents {
  hitsRate: number;
  runsRate: number;
  rbisRate: number;
  currentHits: number;
  currentRuns: number;
  currentRBIs: number;
}

export interface MLBPropInput {
  playerId: string;
  playerName: string;
  team: string;
  opponent: string;
  gameId: string;

  market: MLBMarket;
  bookLine: number;
  overOdds?: number | null;
  underOdds?: number | null;

  seasonAvg: number;
  plateAppearances: number;
  atBats: number;
  currentStatValue: number;

  remainingPA: number;
  remainingAB: number;
  completedAB: number;
  inning: number;
  isTopInning: boolean;

  currentRuns?: number;
  leagueAvgRuns?: number;

  currentGameHR?: number;
  hardHitCount?: number;

  batterHand: "L" | "R" | "S" | null;

  pitcherThrows?: "L" | "R" | null;
  parkHistoryFactor?: number | null;
  bvpPlateAppearances?: number | null;
  bvpOpsLikeFactor?: number | null;
  pitcherVsHandednessFactor?: number | null;
  lineupPocketWeakness?: number | null;

  contactQuality: ContactQualityMetrics;
  pitcher: PitcherContext;
  lineup: LineupContext;
  weatherPark: WeatherParkContext;
  bullpen: BullpenContext;

  oddsUpdatedAt?: number | null;
  bvpHistory?: BatterVsPitcherHistory;
  hrrComponents?: HRRComponents;

  rollingForm?: {
    last7Avg: number | null;
    last15Avg: number | null;
    last30Avg: number | null;
    last7Ops: number | null;
    last15Ops: number | null;
  };

  hrTrend?: {
    abSinceLastHR: number | null;
    hrRateLast7: number | null;
    hrRateLast15: number | null;
    hrRateLast30: number | null;
    seasonTotalHR: number;
    seasonTotalAB: number;
  };

  hotHitterBoost?: number;
  bvpHrBoost?: number;

  liveInterpretation?: {
    contactScore: number;
    nearHrScore: number;
    momentumScore: number;
    pitcherFatigueScore: number;
    veloDropScore: number;
    confidenceBoost: number;
    tags: string[];
  };
}

export interface ModifierBreakdown {
  liveForm: number;
  pitcher: number;
  pitchType: number;
  weatherPark: number;
  lineup: number;
  bullpen: number;
  parkHistory: number;
  handednessMatchup: number;
  bvpHistory: number;
  pocketWeakness: number;
  liveEvent: number;
  total: number;
}

export interface ProjectionLog {
  baseProjection: number;
  liveFormAdjustment: number;
  pitcherAdjustment: number;
  pitchTypeAdjustment: number;
  weatherParkAdjustment: number;
  lineupAdjustment: number;
  bullpenAdjustment: number;
  parkHistoryAdjustment: number;
  handednessMatchupAdjustment: number;
  bvpHistoryAdjustment: number;
  pocketWeaknessAdjustment: number;
  liveEventAdjustment: number;
  finalCappedAdjustment: number;
  rawProbability: number;
  calibratedProbability: number;
  confidenceTier: MLBConfidenceTier;
  modeUsed: "STANDARD" | "EARLY_EXPLOSIVE";
}

export interface MLBPropOutput {
  market: MLBMarket;
  playerId: string;
  playerName: string;
  gameId: string;

  projection: number;
  bookLine: number;
  overOdds: number | null;
  underOdds: number | null;
  modifiers: ModifierBreakdown;
  projectionLog: ProjectionLog;

  rawProbabilityOver: number;
  rawProbabilityUnder: number;
  calibratedProbabilityOver: number;
  calibratedProbabilityUnder: number;
  rawProbability: number;
  calibratedProbability: number;
  edge: number;

  recommendedSide: MLBRecommendedSide;
  confidenceTier: MLBConfidenceTier;

  safetyCeilingApplied?: boolean;

  mode: "standard" | "early_explosive";
  completedAB: number;
  twoABRuleSatisfied: boolean;

  expectedHits: number | null;
  remainingPA: number | null;
  adjustedHitRate: number | null;
  bookImplied: number | null;
  paDistribution?: { 1: number; 2: number; 3: number };

  isExperimental: boolean;
  suppressed: boolean;
  suppressionReason: string | null;
  explanationBullets: string[];
  warnings: string[];
  engineGeneratedAt: number;
  oddsUpdatedAt: number;
  projectionUpdatedAt: number;
  sportsbook: string | null;
  isDerivedLine: boolean;
  signalTimestamp: number;
  formIndicator: FormIndicator;
  formScore: number;
  evPct: number;
  hrFactors?: { count: number; labels: string[]; build?: Record<string, any>; preHrDangerScore?: number; dangerFlags?: string[] };
  hrBuildScore?: number;
  hrIntensity?: "weak" | "watch" | "strong" | "imminent";
  contextScore: number;
  matchupTag: string | null;
  featureScores?: Record<string, number>;
  pitcherAnalysis?: {
    stuff: number;
    command: number;
    swingMiss: number;
    fatigue: number;
    contactSuppression: number;
    matchup: number;
    context: number;
  };
  pitcherSignals?: string[];
  computedBadges?: string[];
  computedRiskFlags?: string[];
  fallbackUsed?: boolean;

  projectionSource?: ProjectionSource;
  projectionQuality?: ProjectionQuality;
  projectionTrustScore?: number;
  modelMethod?: DistributionModelMethod;
  variance?: number;
}

export const STANDARD_THRESHOLDS = {
  minABForLiveBoost: 2,
  exitVelocity: { elite: 100, hard: 95, medium: 88 },
  launchAngle: { sweetSpotMin: 10, sweetSpotMax: 30 },
  distance: { elite: 380, hard: 340, medium: 300 },
  hardHitRate: { elite: 0.50, hard: 0.40, medium: 0.30 },
} as const;

export const EARLY_EXPLOSIVE_THRESHOLDS = {
  minAB: 1,
  exitVelocity: 105,
  launchAngle: { min: 15, max: 35 },
  distance: 400,
  strongContextScoreMin: 0.65,
  environmentScoreMin: 0.35,
} as const;

export const MODIFIER_CAPS = {
  liveForm: 0.25,
  pitcher: 0.20,
  pitchType: 0.10,
  weatherPark: 0.15,
  lineup: 0.15,
  bullpen: 0.10,
  parkHistory: 0.08,
  handednessMatchup: 0.08,
  bvpHistory: 0.10,
  pocketWeakness: 0.08,
  liveEvent: 0.15,
  totalMax: 0.50,
} as const;

export const MARKET_SIGMA: Record<MLBMarket, number> = {
  hits: 0.65,
  total_bases: 1.10,
  pitcher_strikeouts: 1.40,
  hits_allowed: 1.20,
  walks_allowed: 0.90,
  home_runs: 0.40,
  hrr: 1.50,
  pitcher_outs: 2.50,
  batter_strikeouts: 0.70,
  hr_allowed: 0.50,
};

export const EDGE_THRESHOLDS = {
  elite: 6.0,
  strong: 3.5,
  lean: 1.5,
} as const;

export const SUPPRESSION_RULES: Record<MLBMarket, { minEdge: number; minCompletedAB: number; requireContactData: boolean }> = {
  hits:               { minEdge: 0,    minCompletedAB: 0, requireContactData: false },
  total_bases:        { minEdge: 0,    minCompletedAB: 0, requireContactData: false },
  pitcher_strikeouts: { minEdge: 0,    minCompletedAB: 0, requireContactData: false },
  hits_allowed:       { minEdge: 0,    minCompletedAB: 0, requireContactData: false },
  walks_allowed:      { minEdge: 0,    minCompletedAB: 0, requireContactData: false },
  home_runs:          { minEdge: 0,    minCompletedAB: 0, requireContactData: false },
  hrr:                { minEdge: 0,    minCompletedAB: 0, requireContactData: false },
  pitcher_outs:       { minEdge: 0,    minCompletedAB: 0, requireContactData: false },
  batter_strikeouts:  { minEdge: 0,    minCompletedAB: 0, requireContactData: false },
  hr_allowed:         { minEdge: 0,    minCompletedAB: 0, requireContactData: false },
};

export type FormIndicator = "hot" | "warm" | "neutral" | "cold" | "extreme_cold";

export const FORM_THRESHOLDS = {
  hot: 0.65,
  warm: 0.40,
  cold: 0.20,
  extremeCold: 0.08,
} as const;

export const HR_MIN_QUALIFYING_FACTORS = 2;

export const MLB_MARKET_MIN_GAP: Record<MLBMarket, number> = {
  hits:               0.10,
  total_bases:        0.15,
  pitcher_strikeouts: 0.30,
  hits_allowed:       0.30,
  walks_allowed:      0.20,
  home_runs:          0.05,
  hrr:                0.20,
  pitcher_outs:       0.50,
  batter_strikeouts:  0.05,
  hr_allowed:         0.05,
};

export type SignalConfidenceTier = "ELITE" | "STRONG" | "SOLID" | "WATCHLIST" | "NO_SIGNAL";

export interface MLBQualifiedSignal {
  id: string;
  gameId: string;
  playerId: string;
  playerName: string;
  team: string;
  market: MLBMarket;
  side: MLBRecommendedSide;
  sportsbook: string | null;
  line: number;
  impliedProbability: number | null;
  engineProbability: number;
  engineProbabilityDominant?: number;
  calibratedProbabilityOver?: number;
  calibratedProbabilityUnder?: number;
  probabilitySemantics?: "recommended_side_calibrated";
  projection: number;
  evPct: number;
  confidenceTier: SignalConfidenceTier;
  signalScore: number;
  reasons: string[];
  feedTags: string[];
  signalTags: string[];
  playerGlowEligible: boolean;
  gameCardSignalTags: string[];
  formIndicator: FormIndicator;
  isExperimental: boolean;
  engineGeneratedAt: number;

  badges: string[];
  riskFlags: string[];
  drivers: Record<string, number>;
  timestamps: {
    engineGeneratedAt: string;
    oddsUpdatedAt: string;
    gameStateUpdatedAt: string;
  };

  fallbackUsed: boolean;
  actionable: boolean;
  alreadyHit: boolean;
  stale: boolean;
  watchlist: boolean;
  isEarlySignal?: boolean;
  // MLB Signals audit P2/P3 — engine state machine + decay rail for non-HR
  // markets. Owned by the orchestrator's recomputeNonHrSignalState; UI is
  // strictly a renderer of these fields. Optional because HR markets continue
  // to use the dedicated HR Radar engine state (see signalState below).
  engineState?: "BUILDING" | "ACTIVE" | "COOLING" | "CLOSED";
  engineStateChangedAt?: number;
  engineStatePeakScore?: number;
  decayFactor?: number; // 0..1 multiplier applied to the displayed signalScore

  overOdds: number | null;
  underOdds: number | null;
  oddsTimestamp: number | null;

  pitcherName: string | null;
  pitcherHand: string | null;
  pitcherPitchCount: number | null;
  pitcherTimesThrough: number | null;

  homeScore: number;
  awayScore: number;
  inning: number;
  isTopInning: boolean;

  currentStat: number;
  completedAB: number;
  bookImplied: number | null;

  priorABResults: Array<{
    outcome: string;
    exitVelocity: number | null;
    launchAngle: number | null;
    pitchType: string | null;
    pitchSpeed: number | null;
  }>;

  currentStats?: {
    ab: number;
    h: number;
    hr: number;
    tb: number;
    bb: number;
    rbi: number;
    k: number;
    sb: number;
  } | null;
  lastABContact?: {
    exitVelo: number | null;
    launchAngle: number | null;
    batSpeed: number | null;
    distance: number | null;
    barrelPct: number | null;
    hardHitPct: number | null;
    outcome: string | null;
  } | null;

  mode?: "watch" | "heating_up" | "lean" | "strong" | "elite" | "hr_watch" | "hr_heating_up" | "hr_strong" | "hr_elite" | null;
  signalStrengthScore?: number;
  marketFamily?: "batter_over" | "under" | "hr_radar" | null;
  hrRadarScore?: number;
  batterArchetype?: string | null;
  pitcherArchetype?: string | null;
  thesis?: string | null;
  triggerType?: string | null;
  familyId?: string | null;
  familyRank?: number | null;
  isFlagship?: boolean | null;
  familyPenaltyFactor?: number | null;
  safetyCeilingApplied?: boolean | null;
  varianceTier?: string | null;
  calibrationShrinkage?: number | null;
  directionalBiasAdjusted?: boolean | null;
  isDegraded?: boolean | null;
  dataQuality?: "full" | "partial" | "degraded" | null;
  pitcherAnalysis?: {
    stuff: number;
    command: number;
    swingMiss: number;
    fatigue: number;
    contactSuppression: number;
    matchup: number;
    context: number;
  } | null;
  pitcherSignals?: string[] | null;
  opportunityScore?: number;
  liveScore?: number;
  eventBoost?: number;
  bvpHistory?: BatterVsPitcherHistory;

  // Phase C: Diagnostics envelope — surfaces existing engine internals so
  // the canonical resolver can pass them through to UI consumers without
  // any recomputation. Imported as `MlbSignalDiagnostics` from the shared
  // canonical-signal module to keep the wire shape stable.
  diagnostics?: import("../../shared/mlbCanonicalSignal").MlbSignalDiagnostics;
}
