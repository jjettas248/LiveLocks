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

export const NBA_KNOWN_AT_POLICY_VERSION = "nba_gamelog_knownAt_v1";

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
  | "incomplete_response" // missing resultSets / missing headers / rowSet not an array
  | "malformed"; // structurally unusable payload

export type NbaAdapterResult =
  | {
      ok: true;
      kind: NbaSourceKind;
      /** Provider request key identifying WHAT was fetched (season/type/entity). */
      sourceKey: string;
      season: number;
      entityNativeId: string;
      records: NbaNormalizedGameRecord[];
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
