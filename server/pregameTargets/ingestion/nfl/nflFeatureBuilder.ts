// PR6 — NFL ingestion: normalized weekly records → as-of feature rows (PR1 contract).
//
// Each nflverse weekly row IS one game, so features are PER-GAME counting stats. Game
// identity is the provider-native `game_id`; the weekly row is JOINED to the schedule BY
// game_id (never reconstructed from season+week+team). The schedule supplies the calendar
// anchor (gameday) and cross-checks. Honest knownAt policy: validAt = gameday, knownAt =
// fetchedAt. There is NO fabricated validAt fallback — a row that cannot be resolved to a
// real schedule date produces NO feature row (skipped with a typed reason).
//
// Fail closed per weekly row when: no matching schedule game_id; schedule season != weekly
// season; schedule week != weekly week; the weekly team/opponent materially contradicts the
// matched schedule home/away. Pure; no I/O; no line/price/EV/outcome field.

import { buildCanonicalId, canonicalGameId } from "../../../../shared/pregameTargets/canonicalEntities";
import { instantMs, isStructurallyValidFeatureRow, type AsOfFeatureRow, type FeatureState } from "../../../../shared/pregameTargets/featureStore";
import { gamedayToIso } from "./nflCsvAdapter";
import type { NflScheduleRecord, NflWeeklyStatRecord } from "./nflSourceContracts";

export const NFL_FEATURE_VERSION = "nfl_nflverse_v1";

export const NFL_PER_GAME_FEATURES = [
  { key: "nfl.player.targets_per_game", stat: "targets" as const },
  { key: "nfl.player.receptions_per_game", stat: "receptions" as const },
  { key: "nfl.player.receiving_yards_per_game", stat: "receivingYards" as const },
  { key: "nfl.player.carries_per_game", stat: "carries" as const },
  { key: "nfl.player.rushing_yards_per_game", stat: "rushingYards" as const },
];

export interface BuildNflFeatureRowsArgs {
  season: number;
  sourceId: string; // the join-provenance snapshotId (resolves weekly + schedule captures)
  weeklyRecords: readonly NflWeeklyStatRecord[];
  scheduleRecords: readonly NflScheduleRecord[];
}

export interface NflFeatureBuildResult {
  rows: AsOfFeatureRow[];
  /** Per-(player,game,feature) skips with a typed reason — never silently dropped. */
  skipped: Array<{ playerId: string; gameId: string; featureKey: string; reason: string }>;
  /** Join/normalization completeness counts (feed coverage). */
  stats: {
    weeklyRows: number;
    scheduleResolvedRows: number; // weekly rows whose game_id matched a schedule game
    unresolvedGameIds: number; // weekly rows with no matching schedule game_id
    contradictoryRows: number; // matched but season/week/team contradicted the schedule
    featureBearingPlayers: number; // distinct players that produced >=1 feature row
  };
}

function teamMatchesGame(team: string | null, opp: string | null, home: string | null, away: string | null): boolean {
  if (team === null || home === null || away === null) return false;
  const t = team.toUpperCase();
  const h = home.toUpperCase();
  const a = away.toUpperCase();
  if (t !== h && t !== a) return false; // weekly team is neither side of the matched game
  if (opp !== null) {
    const o = opp.toUpperCase();
    const expectedOpp = t === h ? a : h;
    if (o !== expectedOpp) return false; // opponent contradicts the matched game
  }
  return true;
}

export function buildNflFeatureRows(args: BuildNflFeatureRowsArgs): NflFeatureBuildResult {
  const scheduleByGameId = new Map<string, NflScheduleRecord>();
  for (const s of args.scheduleRecords) scheduleByGameId.set(s.gameId, s);

  const rows: AsOfFeatureRow[] = [];
  const skipped: Array<{ playerId: string; gameId: string; featureKey: string; reason: string }> = [];
  const featurePlayers = new Set<string>();
  let scheduleResolvedRows = 0, unresolvedGameIds = 0, contradictoryRows = 0;

  for (const rec of args.weeklyRecords) {
    const entityCanonicalId = buildCanonicalId("nfl", "player", rec.playerId);
    const knownAt = rec.timestamps.fetchedAt;
    const sched = scheduleByGameId.get(rec.gameId);
    if (sched === undefined) { unresolvedGameIds++; skipped.push({ playerId: rec.playerId, gameId: rec.gameId, featureKey: "*", reason: "unresolved_schedule_game" }); continue; }
    scheduleResolvedRows++;
    if (sched.season !== rec.season) { contradictoryRows++; skipped.push({ playerId: rec.playerId, gameId: rec.gameId, featureKey: "*", reason: "season_mismatch_vs_schedule" }); continue; }
    if (sched.week !== rec.week) { contradictoryRows++; skipped.push({ playerId: rec.playerId, gameId: rec.gameId, featureKey: "*", reason: "week_mismatch_vs_schedule" }); continue; }
    if (!teamMatchesGame(rec.teamTricode, rec.opponentTricode, sched.homeTeam, sched.awayTeam)) { contradictoryRows++; skipped.push({ playerId: rec.playerId, gameId: rec.gameId, featureKey: "*", reason: "team_contradicts_schedule" }); continue; }

    const validAt = gamedayToIso(sched.gameDate);
    const gameCanonicalId = canonicalGameId(buildCanonicalId("nfl", "game", rec.gameId));
    if (!Number.isFinite(instantMs(validAt))) { skipped.push({ playerId: rec.playerId, gameId: rec.gameId, featureKey: "*", reason: "invalid_game_date" }); continue; }
    if (!Number.isFinite(instantMs(knownAt))) { skipped.push({ playerId: rec.playerId, gameId: rec.gameId, featureKey: "*", reason: "invalid_fetched_at" }); continue; }
    if (instantMs(knownAt) < instantMs(validAt)) { skipped.push({ playerId: rec.playerId, gameId: rec.gameId, featureKey: "*", reason: "known_before_valid" }); continue; }
    if (gameCanonicalId === null) { skipped.push({ playerId: rec.playerId, gameId: rec.gameId, featureKey: "*", reason: "noncanonical_game_id" }); continue; }

    let produced = false;
    const push = (featureKey: string, state: FeatureState, value: number | null) => {
      const row: AsOfFeatureRow = {
        sport: "nfl", entityCanonicalId, entityKind: "player", featureKey, featureVersion: NFL_FEATURE_VERSION,
        season: args.season, validAt, knownAt, state, value, sourceId: args.sourceId, derivedFromGameIds: [gameCanonicalId],
      };
      if (!isStructurallyValidFeatureRow(row)) { skipped.push({ playerId: rec.playerId, gameId: rec.gameId, featureKey, reason: "structurally_invalid" }); return; }
      rows.push(row); produced = true;
    };
    for (const feat of NFL_PER_GAME_FEATURES) {
      const stat = rec[feat.stat];
      if (stat === null) push(feat.key, "missing", null);
      else if (stat === 0) push(feat.key, "observed_zero", 0);
      else push(feat.key, "observed", stat);
    }
    if (produced) featurePlayers.add(entityCanonicalId);
  }

  return {
    rows, skipped,
    stats: { weeklyRows: args.weeklyRecords.length, scheduleResolvedRows, unresolvedGameIds, contradictoryRows, featureBearingPlayers: featurePlayers.size },
  };
}
