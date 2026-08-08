// Run: npx tsx server/pregameTargets/ingestion/nfl/nflFeatureBuilder.test.ts
// PR6 — NFL feature builder: join weekly→schedule BY provider game_id (never season+week+
// team); fail closed per row on no-match / season-mismatch / week-mismatch / team-
// contradiction; no fabricated validAt; missing vs observed_zero distinct; known-before-
// valid rejected; resolution stats reported.
import { buildNflFeatureRows, NFL_FEATURE_VERSION } from "./nflFeatureBuilder";
import type { NflScheduleRecord, NflWeeklyStatRecord } from "./nflSourceContracts";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const ts = (fetchedAt: string) => ({ sourceEffectiveAt: "", sourcePublishedAt: null, fetchedAt, knownAtPolicyVersion: "nfl_nflverse_knownAt_v1" });
const rec = (over: Partial<NflWeeklyStatRecord>): NflWeeklyStatRecord => ({
  playerId: "00-0036355", gameId: "2024_01_SF_KC", season: 2024, week: 1, seasonType: "REG",
  teamTricode: "SF", opponentTricode: "KC", position: "WR",
  targets: 10, receptions: 7, receivingYards: 110, carries: 0, rushingYards: 0, timestamps: ts("2026-08-05T18:00:00Z"), ...over,
});
const sched: NflScheduleRecord[] = [
  { gameId: "2024_01_SF_KC", season: 2024, week: 1, gameDate: "2024-09-08", homeTeam: "KC", awayTeam: "SF" },
];

// ── Join by game_id: validAt=gameday, canonical game id from provider game_id ─
{
  const { rows, stats } = buildNflFeatureRows({ season: 2024, sourceId: "join1", weeklyRecords: [rec({ receptions: null, carries: 0 })], scheduleRecords: sched });
  const byKey = new Map(rows.map((r) => [r.featureKey, r]));
  ok(byKey.get("nfl.player.targets_per_game")?.value === 10, "targets observed = per-game value");
  ok(byKey.get("nfl.player.carries_per_game")?.state === "observed_zero", "genuine 0 → observed_zero");
  ok(byKey.get("nfl.player.receptions_per_game")?.state === "missing", "blank stat → missing");
  ok(rows[0].validAt === "2024-09-08T00:00:00Z" && rows[0].knownAt === "2026-08-05T18:00:00Z", "validAt=gameday, knownAt=fetchedAt");
  ok(rows[0].derivedFromGameIds?.[0]?.replace(/_/g, "").toLowerCase().includes("nfl:game:2024") === true, "canonical game id derived from provider game_id");
  ok(rows.every((r) => r.sport === "nfl" && r.featureVersion === NFL_FEATURE_VERSION && r.sourceId === "join1"), "rows stamped nfl + join sourceId");
  ok(stats.scheduleResolvedRows === 1 && stats.unresolvedGameIds === 0 && stats.featureBearingPlayers === 1, "resolution stats");
}

// ── Fail closed: unresolved game_id, season/week mismatch, team contradiction ─
{
  const unresolved = buildNflFeatureRows({ season: 2024, sourceId: "j", weeklyRecords: [rec({ gameId: "2024_99_XX_YY" })], scheduleRecords: sched });
  ok(unresolved.rows.length === 0 && unresolved.stats.unresolvedGameIds === 1 && unresolved.skipped.some((s) => s.reason === "unresolved_schedule_game"), "no matching schedule game_id → skipped (no fabricated date)");

  const weekMismatch = buildNflFeatureRows({ season: 2024, sourceId: "j", weeklyRecords: [rec({ week: 2 })], scheduleRecords: sched });
  ok(weekMismatch.rows.length === 0 && weekMismatch.skipped.some((s) => s.reason === "week_mismatch_vs_schedule"), "weekly week != schedule week → fail closed");

  const teamContradiction = buildNflFeatureRows({ season: 2024, sourceId: "j", weeklyRecords: [rec({ teamTricode: "DEN" })], scheduleRecords: sched });
  ok(teamContradiction.rows.length === 0 && teamContradiction.stats.contradictoryRows === 1 && teamContradiction.skipped.some((s) => s.reason === "team_contradicts_schedule"), "weekly team not in matched game → fail closed");

  const oppContradiction = buildNflFeatureRows({ season: 2024, sourceId: "j", weeklyRecords: [rec({ opponentTricode: "LAR" })], scheduleRecords: sched });
  ok(oppContradiction.rows.length === 0 && oppContradiction.skipped.some((s) => s.reason === "team_contradicts_schedule"), "opponent contradicts matched game → fail closed");
}

// ── known-before-valid rejected (leakage firewall) ──────────────────────────
{
  const leak = buildNflFeatureRows({ season: 2024, sourceId: "j", weeklyRecords: [rec({ timestamps: ts("2024-09-01T00:00:00Z") })], scheduleRecords: sched });
  ok(leak.rows.length === 0 && leak.skipped.some((s) => s.reason === "known_before_valid"), "fetchedAt before gameday → rejected");
}

console.log(`\nnflFeatureBuilder.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
