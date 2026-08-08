// PR6 — NFL (nflverse) ingestion: normalized source contracts + honest timestamps.
//
// Authoritative sources (frozen — see docs/pregame-targets/PR6-nfl-source-manifest.md):
//   • Weekly player stats (feature source): nflverse/nflverse-data release `stats_player`,
//     asset `stats_player_week_{season}.csv` (CSV). Exposes player_id, game_id, season,
//     week, season_type, team, opponent_team + stat fields.
//   • Schedules (temporal anchor): nflverse/nfldata `data/games.csv` (multi-season CSV).
//     Exposes game_id, season, week, gameday, home_team, away_team.
//
// Provider-native `game_id` is the canonical game identity — never reconstructed from
// (season, week, team). The schedule supplies only calendar metadata (gameday) and
// cross-checks; the join is BY game_id.
//
// Blindness: no line / price / book / odds / EV / settlement / outcome field. Isolation:
// imports NO other sport engine.

export type NflSourceKind = "nflverse_weekly_stats" | "nflverse_schedule" | "nfl_weekly_schedule_join";

export const NFL_SOURCE_PROVIDER = "nflverse" as const;
export const NFL_WEEKLY_SOURCE_VERSION = "nflverse_stats_player_week_v1" as const;
export const NFL_SCHEDULE_SOURCE_VERSION = "nflverse_nfldata_games_v1" as const;
export const NFL_JOIN_SOURCE_VERSION = "nfl_weekly_schedule_join_v1" as const;
export const NFL_KNOWN_AT_POLICY_VERSION = "nfl_nflverse_knownAt_v1" as const;

/** Explicitly supported NFL week range (regular season 1–18 since 2021 + playoffs to 22). */
export const NFL_MIN_WEEK = 1;
export const NFL_MAX_WEEK = 22;

function sourceVersionFor(kind: NflSourceKind): string {
  if (kind === "nflverse_weekly_stats") return NFL_WEEKLY_SOURCE_VERSION;
  if (kind === "nflverse_schedule") return NFL_SCHEDULE_SOURCE_VERSION;
  return NFL_JOIN_SOURCE_VERSION;
}

/**
 * Canonical SEMANTIC source key (stable across every observation of the same request):
 * sport | provider | kind | canonical entity | season | source version. Distinct kinds
 * (weekly / schedule / join) and seasons resolve to distinct keys → independent head
 * chains.
 */
export function buildNflSourceKey(args: { sourceKind: NflSourceKind; entityCanonicalId: string; season: number; sourceVersion?: string }): string {
  return [
    `sport=nfl`,
    `provider=${NFL_SOURCE_PROVIDER}`,
    `kind=${args.sourceKind}`,
    `entity=${args.entityCanonicalId}`,
    `season=${args.season}`,
    `sv=${args.sourceVersion ?? sourceVersionFor(args.sourceKind)}`,
  ].join("|");
}

export interface NflSourceTimestamps {
  /** Source-effective — the game's calendar date (schedule gameday); a validAt anchor. */
  sourceEffectiveAt: string;
  /** Source-published/updated — the release/commit instant if captured, else null. */
  sourcePublishedAt: string | null;
  /** Real wall-clock instant of our fetch, captured AFTER the body was decoded. */
  fetchedAt: string;
  knownAtPolicyVersion: string;
}

/** One normalized weekly player-stat row. `game_id` is the provider-native game identity.
 *  A stat is `null` when the provider column was blank/NA (→ missing), never 0-for-absent. */
export interface NflWeeklyStatRecord {
  playerId: string;
  gameId: string; // provider-native (e.g. "2024_01_SF_KC") — canonical game identity
  season: number;
  week: number;
  seasonType: string; // REG / POST (provider `season_type`)
  teamTricode: string | null; // provider `team`
  opponentTricode: string | null; // provider `opponent_team`
  position: string | null;
  targets: number | null;
  receptions: number | null;
  receivingYards: number | null;
  carries: number | null;
  rushingYards: number | null;
  timestamps: NflSourceTimestamps;
}

/** One normalized schedule row — the temporal anchor + cross-check, not a feature source. */
export interface NflScheduleRecord {
  gameId: string;
  season: number;
  week: number;
  gameDate: string; // raw provider gameday
  homeTeam: string | null;
  awayTeam: string | null;
}

export type NflAdapterFailureReason =
  | "empty_result" // header present but zero data rows (or, post-filter, zero rows for the requested season)
  | "incomplete_response" // missing header / missing OR duplicate required-or-consumed column / wrong-width row
  | "conflicting_rows" // two rows share a key but disagree — fail closed
  | "season_mismatch" // a row's season != the requested season (mixed-season content)
  | "invalid_identifier" // malformed integer season/week, or out-of-range week
  | "malformed"; // structurally unusable payload

export interface NflAdapterDiagnostics {
  rawRows: number; // total data rows in the CSV (excl. header)
  blankKeyRows: number; // dropped: blank required key
  duplicateRowsCollapsed: number; // byte-identical duplicate keys collapsed
  seasonFilteredRows: number; // schedule rows dropped by the requested-season filter
}

export type NflWeeklyAdapterResult =
  | { ok: true; kind: "nflverse_weekly_stats"; sourceKey: string; season: number; records: NflWeeklyStatRecord[]; diagnostics: NflAdapterDiagnostics; rawPayload: unknown; fetchedAt: string }
  | { ok: false; kind: "nflverse_weekly_stats"; sourceKey: string; season: number; reason: NflAdapterFailureReason; rawPayload: unknown; fetchedAt: string };

export type NflScheduleAdapterResult =
  | { ok: true; kind: "nflverse_schedule"; sourceKey: string; season: number; records: NflScheduleRecord[]; diagnostics: NflAdapterDiagnostics; rawPayload: unknown; fetchedAt: string }
  | { ok: false; kind: "nflverse_schedule"; sourceKey: string; season: number; reason: NflAdapterFailureReason; rawPayload: unknown; fetchedAt: string };
