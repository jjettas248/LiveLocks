// Canonical MLB signal — single source of truth used by both the live box
// score badge and the calculator result panel. The server's resolver
// (`resolveMlbPlayerMarketSignal`) returns this shape; both surfaces
// read the same fields so the same player+market+line shows the same
// numbers everywhere.

export type CanonicalSignalState = "strong" | "building" | "watch" | "monitor" | "none";
export type CanonicalSide = "OVER" | "UNDER" | "NO_EDGE";
export type CanonicalSource = "engine" | "calculator";

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
}

export const ENGINE_SOURCE_LABEL = "Live Engine Signal";
export const CALCULATOR_SOURCE_LABEL = "Calculator Estimate";
