// Canonical MLB signal — single source of truth used by both the live box
// score badge and the calculator result panel. The server's resolver
// (`resolveMlbPlayerMarketSignal`) returns this shape; both surfaces
// read the same fields so the same player+market+line shows the same
// numbers everywhere.

export type CanonicalSignalState = "strong" | "building" | "watch" | "monitor" | "none";
export type CanonicalSide = "OVER" | "UNDER" | "NO_EDGE";
export type CanonicalSource = "engine" | "calculator";
export type CanonicalEngineMode = "strict" | "fallback";

// Phase C: Diagnostics envelope — surfaces existing engine internals
// (featureScores, scoreBreakdown subscores, BvP/WeatherPark/Handedness
// summaries) so UI panels and analytics consumers can render explainability
// without re-running any scoring math. Every field is read-only and sourced
// from data already produced by the orchestrator.
export interface MlbSignalDiagnostics {
  // Final signal score breakdown (computeSignalScore output, 0-100 subscores)
  scoreBreakdown: {
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
  };

  // Raw 0..1 feature scores produced by markets.ts (already rounded to 3dp)
  featureScores: Record<string, number>;

  // Batter-vs-pitcher history snapshot (already on the input; surfaced verbatim)
  bvp: {
    atBats: number;
    hits: number;
    homeRuns: number;
    strikeouts: number;
    avg: number | null;
  } | null;

  // Weather/park context snapshot (subset of WeatherParkContext)
  weatherPark: {
    parkFactor: number;
    windDirection: "in" | "out" | "cross" | "calm" | null;
    windSpeed: number | null;
    isIndoors: boolean;
    parkHistoryFactor: number | null;
  } | null;

  // Handedness matchup snapshot
  handedness: {
    batterHand: "L" | "R" | "S" | null;
    pitcherThrows: "L" | "R" | null;
    pitcherVsHandednessFactor: number | null;
  } | null;

  // Engine mode rollup — "fallback" when fallbackUsed=true, otherwise "strict"
  engineMode: CanonicalEngineMode;

  // Existing tag/badge arrays surfaced for UI tooltips
  feedTags: string[];
  signalTags: string[];
  badges: string[];
  riskFlags: string[];

  // Phase D: human-readable driver lines derived from the data above
  readableDrivers: string[];
}

export interface CanonicalMlbSignal {
  gameId: string;
  playerId: string;
  playerName: string;
  team: string;
  market: string;          // canonical (post-normalize)
  line: number | null;     // engine signal book line, null if calculator-only

  recommendedSide: CanonicalSide;
  overProbability: number;   // 0-100, paired
  underProbability: number;  // 0-100, paired (sums ≈ 100 with overProbability)
  engineConfidence: number;  // 0-100 conviction (NOT a probability)
  rawProbability: number | null; // raw event prob before calibration

  signalState: CanonicalSignalState;
  drivers: string[];

  source: CanonicalSource;   // "engine" when from live cache, "calculator" when fallback
  label: string;             // human label for the source badge
  updatedAt: number;         // ms epoch

  // Phase C: optional diagnostics envelope — present on engine-sourced signals,
  // omitted on calculator estimates that don't have engine internals.
  diagnostics?: MlbSignalDiagnostics;
}

export const ENGINE_SOURCE_LABEL = "Live Engine Signal";
export const CALCULATOR_SOURCE_LABEL = "Calculator Estimate";
