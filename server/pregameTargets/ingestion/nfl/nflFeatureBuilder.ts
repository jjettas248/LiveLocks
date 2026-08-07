// PR6 — NFL ingestion: normalized weekly records → as-of feature rows (PR1 contract).
//
// Each nflverse weekly row IS one game, so features are PER-GAME counting stats (targets,
// receptions, receiving yards, carries, rushing yards) — there is no minutes denominator.
// The temporal anchor (game date + canonical game id) is resolved by joining to the
// schedule on (season, week, team). Honest knownAt policy (PR6-nfl-source-manifest.md):
//   validAt = source-effective gameday;  knownAt = fetchedAt (the real instant THIS
//   pipeline observed the payload) — never the gameday, never a back-dated instant.
//
// State rules (missing vs observed_zero kept distinct):
//   stat null (blank/NA/omitted) → MISSING (never 0-for-absent)
//   stat 0                       → OBSERVED_ZERO
//   stat finite > 0              → OBSERVED (value = the per-game stat)
//
// Pure; no I/O; no line/price/EV/outcome field anywhere. Imports no other sport engine.

import { buildCanonicalId, canonicalGameId } from "../../../../shared/pregameTargets/canonicalEntities";
import { instantMs, isStructurallyValidFeatureRow, type AsOfFeatureRow, type FeatureState } from "../../../../shared/pregameTargets/featureStore";
import { gamedayToIso } from "./nflCsvAdapter";
import type { NflScheduleRecord, NflWeeklyStatRecord } from "./nflSourceContracts";

export const NFL_FEATURE_VERSION = "nfl_nflverse_v1";

/** Per-game counting features the (future) NFL projection posterior would consume. */
export const NFL_PER_GAME_FEATURES = [
  { key: "nfl.player.targets_per_game", stat: "targets" as const },
  { key: "nfl.player.receptions_per_game", stat: "receptions" as const },
  { key: "nfl.player.receiving_yards_per_game", stat: "receivingYards" as const },
  { key: "nfl.player.carries_per_game", stat: "carries" as const },
  { key: "nfl.player.rushing_yards_per_game", stat: "rushingYards" as const },
];

/** Resolved temporal anchor for a (season, week, team): the canonical game + its date. */
export interface GameAnchor { gameId: string; gamedayIso: string }
export type ScheduleAnchor = (season: number, week: number, team: string) => GameAnchor | null;

/** Build the (season|week|team)→anchor lookup from schedule records. A game maps under
 *  BOTH its home and away tricodes. Conflicting anchors for the same key are dropped
 *  (never guessed). */
export function buildScheduleAnchor(records: readonly NflScheduleRecord[]): ScheduleAnchor {
  const map = new Map<string, GameAnchor | "conflict">();
  const put = (season: number, week: number, team: string | null, anchor: GameAnchor) => {
    if (team === null) return;
    const k = `${season}|${week}|${team.toUpperCase()}`;
    const existing = map.get(k);
    if (existing === undefined) map.set(k, anchor);
    else if (existing === "conflict") return;
    else if (existing.gameId !== anchor.gameId) map.set(k, "conflict"); // two games, same team+week → ambiguous
  };
  for (const r of records) {
    const iso = gamedayToIso(r.gameDate);
    if (iso === "invalid-game-date") continue;
    const anchor: GameAnchor = { gameId: r.gameId, gamedayIso: iso };
    put(r.season, r.week, r.homeTeam, anchor);
    put(r.season, r.week, r.awayTeam, anchor);
  }
  return (season, week, team) => {
    const v = map.get(`${season}|${week}|${team.toUpperCase()}`);
    return v === undefined || v === "conflict" ? null : v;
  };
}

export interface BuildNflFeatureRowsArgs {
  season: number;
  sourceId: string; // the immutable raw snapshotId
  records: readonly NflWeeklyStatRecord[];
  anchor: ScheduleAnchor;
}

export interface NflFeatureBuildResult {
  rows: AsOfFeatureRow[];
  skipped: Array<{ playerId: string; week: number; featureKey: string; reason: string }>;
}

export function buildNflFeatureRows(args: BuildNflFeatureRowsArgs): NflFeatureBuildResult {
  const rows: AsOfFeatureRow[] = [];
  const skipped: Array<{ playerId: string; week: number; featureKey: string; reason: string }> = [];

  for (const rec of args.records) {
    const entityCanonicalId = buildCanonicalId("nfl", "player", rec.playerId);
    const knownAt = rec.timestamps.fetchedAt;

    if (rec.teamTricode === null) { skipped.push({ playerId: rec.playerId, week: rec.week, featureKey: "*", reason: "no_team_for_schedule_join" }); continue; }
    const anchor = args.anchor(rec.season, rec.week, rec.teamTricode);
    if (anchor === null) { skipped.push({ playerId: rec.playerId, week: rec.week, featureKey: "*", reason: "unresolved_schedule_anchor" }); continue; }
    const validAt = anchor.gamedayIso;
    const gameCanonicalId = canonicalGameId(buildCanonicalId("nfl", "game", anchor.gameId));

    if (!Number.isFinite(instantMs(validAt))) { skipped.push({ playerId: rec.playerId, week: rec.week, featureKey: "*", reason: "invalid_game_date" }); continue; }
    if (!Number.isFinite(instantMs(knownAt))) { skipped.push({ playerId: rec.playerId, week: rec.week, featureKey: "*", reason: "invalid_fetched_at" }); continue; }
    if (instantMs(knownAt) < instantMs(validAt)) { skipped.push({ playerId: rec.playerId, week: rec.week, featureKey: "*", reason: "known_before_valid" }); continue; }
    if (gameCanonicalId === null) { skipped.push({ playerId: rec.playerId, week: rec.week, featureKey: "*", reason: "noncanonical_game_id" }); continue; }

    const push = (featureKey: string, state: FeatureState, value: number | null) => {
      const row: AsOfFeatureRow = {
        sport: "nfl", entityCanonicalId, entityKind: "player", featureKey, featureVersion: NFL_FEATURE_VERSION,
        season: args.season, validAt, knownAt, state, value, sourceId: args.sourceId, derivedFromGameIds: [gameCanonicalId],
      };
      if (!isStructurallyValidFeatureRow(row)) { skipped.push({ playerId: rec.playerId, week: rec.week, featureKey, reason: "structurally_invalid" }); return; }
      rows.push(row);
    };

    for (const feat of NFL_PER_GAME_FEATURES) {
      const stat = rec[feat.stat];
      if (stat === null) push(feat.key, "missing", null);
      else if (stat === 0) push(feat.key, "observed_zero", 0);
      else push(feat.key, "observed", stat);
    }
  }

  return { rows, skipped };
}
