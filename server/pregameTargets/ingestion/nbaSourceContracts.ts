// PR5 — NBA ingestion: normalized source contracts + honest timestamp fields.
//
// These types sit between the raw NBA Stats response and the PR1 feature store.
// They carry the FOUR distinct timestamps the source can (and cannot) provide —
// never conflating them — plus the knownAt policy version. See
// docs/pregame-targets/PR5-source-manifest.md for the endpoint-level semantics.
//
// Blindness: no line / price / book / odds / EV / settlement / outcome field
// exists on any of these types by construction — the projection core stays blind.

export type NbaSourceKind = "nba_stats_playergamelog" | "nba_stats_teamgamelog";

/**
 * The ONLY season types PR5 ingestion accepts — the canonical supported type shared
 * by the CLI and the orchestrator so identity validation happens in ONE place. A
 * direct caller cannot smuggle an arbitrary `seasonType: string` past this.
 */
export type NbaIngestSeasonType = "Regular Season" | "Playoffs";
export const NBA_SUPPORTED_SEASON_TYPES: readonly NbaIngestSeasonType[] = ["Regular Season", "Playoffs"];
export function isNbaIngestSeasonType(s: unknown): s is NbaIngestSeasonType {
  return typeof s === "string" && (NBA_SUPPORTED_SEASON_TYPES as readonly string[]).includes(s);
}

export const NBA_KNOWN_AT_POLICY_VERSION = "nba_gamelog_knownAt_v1";

/** Provider family (source identity). */
export const NBA_SOURCE_PROVIDER = "nba_stats" as const;

/**
 * Source VERSION — the adapter's interpretation of the provider payload. Bumping
 * it (a schema/interpretation change) MUST mint distinct snapshot identities for
 * the same bytes, so two source-version interpretations of one payload can never
 * collide. It is part of the canonical sourceKey below.
 */
export const NBA_SOURCE_VERSION = "nba_stats_gamelog_v1" as const;

/**
 * Canonical, collision-proof source key. Encodes EVERY locked identity component
 * except the content hash (which is combined separately into the snapshotId):
 * sport, provider, source kind, canonical entity id, season, season type, and
 * source version. So two seasons, two entities, a player vs a team, or two source
 * versions of the same bytes each resolve to a different key (and snapshotId).
 * Canonical game identity lives inside the payload (each row's GAME_ID) and is
 * therefore carried by the content hash; feature rows additionally stamp the
 * canonical game id explicitly.
 */
export function buildNbaGameLogSourceKey(args: {
  sourceKind: NbaSourceKind;
  entityCanonicalId: string;
  season: number;
  seasonType: string;
  sourceVersion?: string;
}): string {
  return [
    `sport=nba`,
    `provider=${NBA_SOURCE_PROVIDER}`,
    `kind=${args.sourceKind}`,
    `entity=${args.entityCanonicalId}`,
    `season=${args.season}`,
    `seasonType=${args.seasonType}`,
    `sv=${args.sourceVersion ?? NBA_SOURCE_VERSION}`,
  ].join("|");
}

/** The four honestly-distinct timestamps (published is unavailable from these endpoints). */
export interface NbaSourceTimestamps {
  /** Source-effective — the game's calendar date (a validAt anchor, NOT knownAt). */
  sourceEffectiveAt: string;
  /** Source-published/updated — NULL: playergamelog/teamgamelog expose none. */
  sourcePublishedAt: string | null;
  /** Real wall-clock instant of our fetch. */
  fetchedAt: string;
  knownAtPolicyVersion: string;
}

/** One normalized game row. A stat is `null` when the provider omitted it (→ missing), never 0-for-absent. */
export interface NbaNormalizedGameRecord {
  /** Native provider GAME_ID (canonicalized downstream). */
  gameId: string;
  /** Raw GAME_DATE string as returned. */
  gameDate: string;
  /** Team tricode parsed from MATCHUP (for trade/team-change lineage), or null. */
  teamTricode: string | null;
  /** Minutes played; null when absent, 0 when a genuine DNP-with-row. */
  minutes: number | null;
  /** Per-game counting stats; null = provider omitted the field (missing), finite (incl 0) = observed. */
  points: number | null;
  rebounds: number | null;
  assists: number | null;
  threePointersMade: number | null;
  timestamps: NbaSourceTimestamps;
}

export type NbaAdapterFailureReason =
  | "empty_result" // resultSets present but zero rows
  | "incomplete_response" // missing resultSets / missing headers / rowSet not an array / a missing OR duplicated required/consumed header (ambiguous schema, never silent last-wins)
  | "conflicting_rows" // two rows share a GAME_ID but disagree on content — contradictory source data, fail closed (never fold by row order)
  | "malformed"; // structurally unusable payload

/**
 * Non-fatal diagnostics carried on a successful parse. These record what the
 * adapter deterministically *dropped* so a reduced record count is never silently
 * read as a shallower-but-complete response.
 */
export interface NbaAdapterDiagnostics {
  /** Rows with a blank/absent GAME_ID (cannot be an observation) — dropped, surfaced here. */
  blankGameIdRows: number;
  /** Byte-identical duplicate rows for the same GAME_ID collapsed (order-independent). */
  duplicateRowsCollapsed: number;
}

export type NbaAdapterResult =
  | {
      ok: true;
      kind: NbaSourceKind;
      /** Provider request key identifying WHAT was fetched (season/type/entity). */
      sourceKey: string;
      season: number;
      entityNativeId: string;
      records: NbaNormalizedGameRecord[];
      /** Deterministic drop accounting (blank ids, collapsed exact duplicates). */
      diagnostics: NbaAdapterDiagnostics;
      /** The raw payload, retained verbatim for the immutable snapshot. */
      rawPayload: unknown;
      fetchedAt: string;
    }
  | {
      ok: false;
      kind: NbaSourceKind;
      sourceKey: string;
      season: number;
      entityNativeId: string;
      reason: NbaAdapterFailureReason;
      rawPayload: unknown;
      fetchedAt: string;
    };
