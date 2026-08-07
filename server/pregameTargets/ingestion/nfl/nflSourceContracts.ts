// PR6 — NFL (nflverse) ingestion: normalized source contracts + honest timestamps.
//
// These types sit between the raw nflverse CSV and the PR1 feature store. They carry
// the honestly-distinct timestamps the source can (and cannot) provide, plus the
// knownAt policy version. See docs/pregame-targets/PR6-nfl-source-manifest.md.
//
// Blindness: no line / price / book / odds / EV / settlement / outcome field exists on
// any of these types by construction — this is a data layer, and there is no NFL
// projection/decision engine in PR6.
//
// Isolation: this module imports NO other sport engine. It shares only the PR1
// foundation + the sport-neutral rawSnapshotIdentity/storage utilities.

export type NflSourceKind = "nflverse_weekly_stats" | "nflverse_schedule";

/** Provider family (source identity). */
export const NFL_SOURCE_PROVIDER = "nflverse" as const;

/**
 * Source VERSION — the adapter's interpretation of the provider payload. Bumping it (a
 * schema/interpretation change) MUST mint distinct snapshot identities for the same
 * bytes. Part of the canonical semantic source key below.
 */
export const NFL_WEEKLY_SOURCE_VERSION = "nflverse_weekly_v1" as const;
export const NFL_SCHEDULE_SOURCE_VERSION = "nflverse_schedule_v1" as const;

export const NFL_KNOWN_AT_POLICY_VERSION = "nfl_nflverse_knownAt_v1" as const;

function sourceVersionFor(kind: NflSourceKind): string {
  return kind === "nflverse_weekly_stats" ? NFL_WEEKLY_SOURCE_VERSION : NFL_SCHEDULE_SOURCE_VERSION;
}

/**
 * Canonical, collision-proof SEMANTIC source key (stable across every observation of the
 * same request). Encodes sport, provider, source kind, canonical entity id, season, and
 * source version. Two seasons, two entities, weekly-vs-schedule, or two source versions
 * of the same bytes each resolve to a different key. NFL weekly stats have no per-team
 * split at the request level (a whole-season file), so the entity is the season-scoped
 * dataset identity for weekly stats and the season for the schedule.
 */
export function buildNflSourceKey(args: {
  sourceKind: NflSourceKind;
  entityCanonicalId: string;
  season: number;
  sourceVersion?: string;
}): string {
  return [
    `sport=nfl`,
    `provider=${NFL_SOURCE_PROVIDER}`,
    `kind=${args.sourceKind}`,
    `entity=${args.entityCanonicalId}`,
    `season=${args.season}`,
    `sv=${args.sourceVersion ?? sourceVersionFor(args.sourceKind)}`,
  ].join("|");
}

/** The honestly-distinct timestamps. `sourcePublishedAt` = the nflverse release instant
 *  IF captured, else null (explicit durable unknown). */
export interface NflSourceTimestamps {
  /** Source-effective — the game's calendar date (from the schedule join); a validAt anchor. */
  sourceEffectiveAt: string;
  /** Source-published/updated — the nflverse release instant if known, else null. */
  sourcePublishedAt: string | null;
  /** Real wall-clock instant of our fetch, captured AFTER the body was decoded. */
  fetchedAt: string;
  knownAtPolicyVersion: string;
}

/** One normalized weekly player-stat row. A stat is `null` when the provider column was
 *  blank/omitted (→ missing), never 0-for-absent. Values are per-GAME (one row = one game). */
export interface NflWeeklyStatRecord {
  /** nflverse gsis player id (canonicalized downstream), e.g. "00-0036355". */
  playerId: string;
  season: number;
  week: number;
  /** Team tricode for the week (trade/team-change lineage), or null. */
  teamTricode: string | null;
  position: string | null;
  /** Per-game counting stats; null = provider blank/omitted (missing), finite (incl 0) = observed. */
  targets: number | null;
  receptions: number | null;
  receivingYards: number | null;
  carries: number | null;
  rushingYards: number | null;
  /** Resolved game date (ISO) from the schedule join; null when unresolved. */
  gameDateIso: string | null;
  timestamps: NflSourceTimestamps;
}

/** One normalized schedule row — the temporal anchor (game date), not a feature source. */
export interface NflScheduleRecord {
  gameId: string;
  season: number;
  week: number;
  gameDate: string; // raw provider gameday string
  homeTeam: string | null;
  awayTeam: string | null;
}

export type NflAdapterFailureReason =
  | "empty_result" // header present but zero data rows
  | "incomplete_response" // missing header row / missing OR duplicate required-or-consumed column / a row with the wrong field count
  | "conflicting_rows" // two rows share a semantic key but disagree on content — fail closed
  | "malformed"; // structurally unusable payload

/** Non-fatal diagnostics on a successful parse (what was deterministically dropped). */
export interface NflAdapterDiagnostics {
  /** Rows with a blank/absent key column (cannot be an observation) — dropped, surfaced here. */
  blankKeyRows: number;
  /** Byte-identical duplicate rows collapsed (order-independent). */
  duplicateRowsCollapsed: number;
}

export type NflWeeklyAdapterResult =
  | {
      ok: true;
      kind: "nflverse_weekly_stats";
      sourceKey: string;
      season: number;
      records: NflWeeklyStatRecord[];
      diagnostics: NflAdapterDiagnostics;
      rawPayload: unknown;
      fetchedAt: string;
    }
  | {
      ok: false;
      kind: "nflverse_weekly_stats";
      sourceKey: string;
      season: number;
      reason: NflAdapterFailureReason;
      rawPayload: unknown;
      fetchedAt: string;
    };

export type NflScheduleAdapterResult =
  | { ok: true; kind: "nflverse_schedule"; sourceKey: string; season: number; records: NflScheduleRecord[]; diagnostics: NflAdapterDiagnostics; rawPayload: unknown; fetchedAt: string }
  | { ok: false; kind: "nflverse_schedule"; sourceKey: string; season: number; reason: NflAdapterFailureReason; rawPayload: unknown; fetchedAt: string };
