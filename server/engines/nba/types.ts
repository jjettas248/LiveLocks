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

// Playoff calibration recovery: route-level edge gates already cut weak
// signals (edge<3 live / edge<4 halftime). Strict rules previously stacked an
// 8-edge / 55%-probability second filter on top of route gates *and* the
// fragility + calibration + ceiling compression. That double-suppression was
// starving the high-confidence bucket in playoffs. We keep strict mode as the
// canonical actionable gate but soften it so it doesn't double-cut what the
// route layer already accepted.
export const NBA_STRICT_RULES: NBAValidationRules = {
  minEdge: 5,
  minProbability: 52,
  requireProjectionAlignment: true,
};

export const NBA_FALLBACK_RULES: NBAValidationRules = {
  minEdge: 3,
  minProbability: 51,
  requireProjectionAlignment: true,
};
