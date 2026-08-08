// PR6 — NFL ingestion: honest coverage that spans the WHOLE pipeline, not just the weekly
// parse. A weekly parse is not "usable coverage" if the schedule join then drops rows, so
// coverage separately reports parse, schedule-resolution, feature production, and
// persistence counts. Never fabricates a full-season denominator (that stays PENDING
// MEASUREMENT); never reports incomplete work as complete.

export type NflCoverageClass = "adapter_retrievable" | "incomplete" | "pending_measurement";
export type NflKnownAtSupport = "forward_supported" | "historical_unsupported";

export const PENDING_MEASUREMENT_LABEL = "PENDING MEASUREMENT IN THE AUTHORIZED ENVIRONMENT";

export interface NflSourceCoverage {
  season: number;
  coverage: NflCoverageClass;
  knownAtSupport: NflKnownAtSupport;
  /** Normalization/join completeness — every stage separately, never collapsed. */
  counts: {
    rawWeeklyRows: number; // data rows in the weekly CSV
    structurallyAcceptedWeeklyRows: number; // rows that passed the adapter (identity valid, in-season)
    scheduleRawRows: number; // data rows in the schedule CSV (pre season-filter)
    scheduleRowsForSeason: number; // schedule rows for the requested season
    scheduleResolvedRows: number; // weekly rows whose game_id matched a schedule game
    unresolvedGameIds: number; // weekly rows with no matching schedule game_id
    contradictoryRows: number; // matched but season/week/team contradicted the schedule
    featureBearingPlayers: number; // distinct players that produced >=1 feature row
    rawCapturesPersisted: number; // immutable source captures written (weekly + schedule + join)
    featureRowsPersisted: number; // feature rows written
  };
  reason: string;
}

export interface BuildNflCoverageArgs {
  season: number;
  currentSeason: number;
  coverage: NflCoverageClass;
  counts: NflSourceCoverage["counts"];
}

export function buildNflCoverage(args: BuildNflCoverageArgs): NflSourceCoverage {
  const knownAtSupport: NflKnownAtSupport = args.season >= args.currentSeason ? "forward_supported" : "historical_unsupported";
  const c = args.counts;
  const histNote = args.season >= args.currentSeason ? "" : "historical knownAt unsupported; ";
  const reason = args.coverage === "incomplete"
    ? `incomplete: ${c.structurallyAcceptedWeeklyRows} accepted / ${c.scheduleResolvedRows} schedule-resolved / ${c.unresolvedGameIds} unresolved / ${c.contradictoryRows} contradictory / ${c.featureRowsPersisted} features persisted`
    : `${c.structurallyAcceptedWeeklyRows} weekly accepted, ${c.scheduleResolvedRows} resolved, ${c.featureRowsPersisted} feature rows, ${c.featureBearingPlayers} players; ${histNote}live full-season depth ${PENDING_MEASUREMENT_LABEL}`;
  return { season: args.season, coverage: args.coverage, knownAtSupport, counts: c, reason };
}
