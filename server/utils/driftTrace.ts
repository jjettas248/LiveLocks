// Sport-isolation drift trace.
//
// Purely additive observability — emits a single structured log line at
// signal-surfacing sites so we can prove WHY a play surfaced and which
// sport-owned (or shared) helpers produced each part of the decision.
//
// Behavior-neutral. Never throws. Never branches. Never mutates the play.
// Disable in noisy environments with DRIFT_TRACE_DISABLED=true.

export type DriftSport = "nba" | "mlb" | "ncaab";

export type DriftTraceFields = {
  // Where the engine math came from. Examples:
  //   "engines/nba/index.ts:processNBAEngine"
  //   "engines/mlb/index.ts:processMLBEngine"
  //   "route_inline:routes.ts:<lineNo>"
  engineOwner: string;

  // The route handler that emitted this play.
  // Examples: "GET /api/live-signals", "GET /api/halftime-signals", "GET /api/ncaab-signals".
  routeOwner: string;

  // Where the line came from.
  // Examples: "live_inplay" | "live_pregame" | "stale" | "derived" | "consensus" | "sgo" | "unknown"
  oddsSource: string;

  // Where the confidence tier label was decided.
  // Examples: "engine_strict" | "engine_fallback" | "route_inline" | "derived"
  confidenceSource: string;

  // Which fallback path was taken (if any).
  // Examples: "none" | "strict_fallback" | "degraded_volatile" | "consensus_only"
  fallbackPath: string;

  // Where the threshold values live (NOT what they are — the SOURCE).
  // Examples: "engines/nba/types.ts:NBA_STRICT_RULES",
  //           "engines/mlb/types.ts:MLB_STRICT_RULES",
  //           "route_inline:routes.ts:4346"
  thresholdSource: string;

  // How stale lines were handled at this site.
  // Examples: "rejected" | "accepted" | "derived" | "n/a"
  staleHandling: string;

  // Identifying play context (best-effort, all optional).
  playerName?: string;
  market?: string;
  edge?: number;
  probability?: number;
  confidenceTier?: string;
  gameId?: string;
};

const TAG: Record<DriftSport, string> = {
  nba: "NBA_DRIFT_TRACE",
  mlb: "MLB_DRIFT_TRACE",
  ncaab: "NCAAB_DRIFT_TRACE",
};

export function emitDriftTrace(sport: DriftSport, fields: DriftTraceFields): void {
  if (process.env.DRIFT_TRACE_DISABLED === "true") return;
  try {
    // Single-line JSON so log aggregators can parse without state.
    console.log(`[${TAG[sport]}] ${JSON.stringify(fields)}`);
  } catch {
    // Trace is observability only — never let a serialization edge case
    // affect the surfacing path.
  }
}
