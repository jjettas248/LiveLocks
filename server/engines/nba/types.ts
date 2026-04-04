export interface NBAPlay {
  id: string;
  playerId: string;
  playerName: string;
  team: string;
  market: string;
  line: number;
  projection: number;
  probability: number;
  edge: number;
  recommendedSide: "OVER" | "UNDER";
  confidence: "low" | "medium" | "high";
  sportsbook: string;
  derivedLine: boolean;
  gameId: string;
  createdAt: number;
  lineSource?: "sportsbook" | "inferred" | "derived";
  availableBooks?: string[];
  bestOdds?: {
    overOdds: number | null;
    underOdds: number | null;
    sportsbook: string | null;
  } | null;
  diagnostics?: NBAPlayDiagnostics;
}

export interface NBAPlayDiagnostics {
  archetype?: string;
  fragilityScore?: number;
  fragilityPenalty?: number;
  fragilityReasons?: string[];
  rawProbOver?: number;
  rawProbUnder?: number;
  finalProbOver?: number;
  finalProbUnder?: number;
  displayConfidence?: number;
  modelEdge?: number;
  minutesExpected?: number;
  minutesVariance?: number;
  marketType?: string;
  playerVolatilityScore?: number;
  calibrationTrack?: string;
  confidenceCeilingApplied?: boolean;
  ceilingReason?: string;
  engineVersion?: string;
}

export interface NBAEngineOutput {
  plays: NBAPlay[];
  engine: "NBA";
  mode: "strict" | "fallback";
  confidence: "low" | "medium" | "high";
  diagnostics: NBAEngineDiagnostics;
  timestamp: number;
}

export interface NBAEngineDiagnostics {
  totalEvaluated: number;
  totalPassed: number;
  totalFiltered: number;
  reasonsFilteredOut: string[];
  fallbackTriggered: boolean;
  confidenceBreakdown: {
    high: number;
    medium: number;
    low: number;
  };
  regressionApplied: boolean;
  edgeThresholdUsed: number;
  dataFreshness: number;
}

export interface NBAValidationRules {
  minEdge: number;
  minProbability: number;
  requireProjectionAlignment: boolean;
}

export const NBA_STRICT_RULES: NBAValidationRules = {
  minEdge: 8,
  minProbability: 55,
  requireProjectionAlignment: true,
};

export const NBA_FALLBACK_RULES: NBAValidationRules = {
  minEdge: 4,
  minProbability: 52,
  requireProjectionAlignment: true,
};
