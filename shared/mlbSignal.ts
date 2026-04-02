export interface MLBSignal {
  playerId: string;
  playerName: string;
  gameId: string;
  market: string;
  sportsbook: string | null;

  bookLine: number | null;
  projection: number | null;
  enginePct: number;
  edge: number | null;
  evPct: number | null;
  recommendedSide: string;
  signalScore: number;
  confidenceTier: string;

  awayAbbr: string | null;
  homeAbbr: string | null;
  gameStatus: string | null;
  inning: number;
  isTopInning: boolean;
  homeScore: number;
  awayScore: number;

  alreadyHit: boolean;
  actionable: boolean;
  stale: boolean;
  watchlist: boolean;
  isDegraded: boolean;
  fallbackUsed: boolean;

  overOdds: number | null;
  underOdds: number | null;
  bookImplied: number | null;
  oddsTimestamp: number | null;

  signalTags: string[];
  feedTags: string[];
  badges: string[];
  riskFlags: string[];
  playerGlowEligible: boolean;
  formIndicator: string | null;

  reasons: string[];
  explanationBullets: string[];
  drivers: Record<string, number>;

  currentStats: {
    ab?: number;
    h?: number;
    hr?: number;
    tb?: number;
    bb?: number;
    rbi?: number;
    k?: number;
    sb?: number;
    r?: number;
  } | null;
  currentStat: number;
  completedAB: number;
  lastABContact: {
    exitVelo: number | null;
    launchAngle: number | null;
    outcome: string | null;
  } | null;
  priorABResults: Array<{
    outcome: string;
    exitVelocity: number | null;
    launchAngle: number | null;
    pitchType: string | null;
    pitchSpeed: number | null;
  }>;

  pitcherName: string | null;
  pitcherHand: string | null;
  pitcherPitchCount: number | null;
  pitcherTimesThrough: number | null;
  pitchMix: Array<{
    pitchType: string;
    percentage: number;
    avgVelocity: number | null;
  }> | null;

  batterArchetype: string | null;
  pitcherArchetype: string | null;
  thesis: string | null;
  matchupTag: string | null;
  bvp: {
    atBats: number;
    hits: number;
    avg: number | null;
    homeRuns: number;
    strikeouts: number;
  } | null;

  isFlagship: boolean;
  familyPenaltyFactor: number | null;
  safetyCeilingApplied: boolean;
  dataQuality: string | null;
  signalTimestamp: number;
  hrFactors: Record<string, any> | null;
  rollingForm: Record<string, any> | null;
}
