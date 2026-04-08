export interface MLBPlay {
  id: string;
  playerId: string;
  playerName: string;
  team: string | null;
  market: string;
  line: number;
  projection: number;
  probability: number;
  edge: number;
  recommendedSide: "OVER" | "UNDER";
  confidence: "developing" | "strong" | "elite";
  sportsbook: string;
  derivedLine: boolean;
  gameId: string;
  createdAt: number;
  signalScore?: number;
  confidenceTier?: string;
  currentStats?: Record<string, number> | null;
  lastABContact?: {
    exitVelo: number | null;
    launchAngle: number | null;
    batSpeed: number | null;
    distance: number | null;
    barrelPct: number | null;
    hardHitPct: number | null;
    outcome: string | null;
    perABxBA?: number | null;
    contactGrade?: string;
    hrProbability?: number;
  } | null;
  contactProfile?: MLBContactProfile;
  diagnostics?: MLBPlayDiagnostics;
}

export interface MLBContactProfile {
  avgExitVelo: number | null;
  maxExitVelo: number | null;
  avgLaunchAngle: number | null;
  barrelRate: number | null;
  hardHitRate: number | null;
  contactQuality: "elite" | "strong" | "developing" | "weak";
  gameAvgXBA?: number | null;
  gameMaxXBA?: number | null;
  gameBarrelCount?: number;
  gameContactQuality?: number;
}

export interface MLBPlayDiagnostics {
  archetype?: string;
  pitcherArchetype?: string;
  thesis?: string;
  isFlagship?: boolean;
  safetyCeilingApplied?: boolean;
  dataQuality?: string;
  signalComponents?: {
    matchup?: number;
    form?: number;
    opportunity?: number;
    contact?: number;
  };
  engineVersion?: string;
}

export interface MLBEngineOutput {
  plays: MLBPlay[];
  engine: "MLB";
  mode: "strict" | "fallback";
  confidence: "developing" | "strong" | "elite";
  contactProfile: MLBContactProfile | null;
  diagnostics: MLBEngineDiagnostics;
  timestamp: number;
}

export interface MLBEngineDiagnostics {
  totalEvaluated: number;
  totalPassed: number;
  totalFiltered: number;
  reasonsFilteredOut: string[];
  fallbackTriggered: boolean;
  confidenceBreakdown: {
    elite: number;
    strong: number;
    developing: number;
  };
  contactThresholdUsed: string;
  dataFreshness: number;
}

export interface MLBValidationRules {
  minConfidenceTier: "developing" | "strong" | "elite";
  allowDevelopingSignals: boolean;
}

export const MLB_STRICT_RULES: MLBValidationRules = {
  minConfidenceTier: "strong",
  allowDevelopingSignals: false,
};

export const MLB_FALLBACK_RULES: MLBValidationRules = {
  minConfidenceTier: "developing",
  allowDevelopingSignals: true,
};
