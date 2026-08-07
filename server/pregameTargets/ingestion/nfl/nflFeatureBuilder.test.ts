// Run: npx tsx server/pregameTargets/ingestion/nfl/nflFeatureBuilder.test.ts
// PR6 — NFL feature builder: per-game counting features anchored via the schedule join
// (validAt=gameday, knownAt=fetchedAt); missing (blank/NA) vs observed_zero distinct;
// known-before-valid rejection; no-team / unresolved-anchor skipped with reasons; no
// line/price/EV/outcome key.
import { buildNflFeatureRows, buildScheduleAnchor, NFL_FEATURE_VERSION } from "./nflFeatureBuilder";
import type { NflScheduleRecord, NflWeeklyStatRecord } from "./nflSourceContracts";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const ts = (fetchedAt: string) => ({ sourceEffectiveAt: "", sourcePublishedAt: null, fetchedAt, knownAtPolicyVersion: "nfl_nflverse_knownAt_v1" });
const rec = (over: Partial<NflWeeklyStatRecord>): NflWeeklyStatRecord => ({
  playerId: "00-0036355", season: 2024, week: 1, teamTricode: "SF", position: "WR",
  targets: 10, receptions: 7, receivingYards: 110, carries: 0, rushingYards: 0, gameDateIso: null,
  timestamps: ts("2026-08-05T18:00:00Z"), ...over,
});
const sched: NflScheduleRecord[] = [
  { gameId: "2024_01_SF_KC", season: 2024, week: 1, gameDate: "2024-09-08", homeTeam: "KC", awayTeam: "SF" },
  { gameId: "2024_02_SF_LA", season: 2024, week: 2, gameDate: "2024-09-15", homeTeam: "SF", awayTeam: "LA" },
];
const anchor = buildScheduleAnchor(sched);

// ── Schedule anchor resolves a team's game (home or away) ────────────────────
{
  ok(anchor(2024, 1, "SF")?.gameId === "2024_01_SF_KC" && anchor(2024, 1, "SF")?.gamedayIso === "2024-09-08T00:00:00Z", "away team resolves its game + date");
  ok(anchor(2024, 1, "KC")?.gameId === "2024_01_SF_KC", "home team resolves the same game");
  ok(anchor(2024, 1, "DEN") === null, "a team not playing that week → null (bye/unresolved)");
  ok(anchor(2024, 3, "SF") === null, "a week with no schedule row → null");
}

// ── Per-game features: observed / observed_zero / missing distinct ───────────
{
  const { rows } = buildNflFeatureRows({ season: 2024, sourceId: "snap1", records: [rec({ receptions: null, carries: 0 })], anchor });
  const byKey = new Map(rows.map((r) => [r.featureKey, r]));
  ok(byKey.get("nfl.player.targets_per_game")?.state === "observed" && byKey.get("nfl.player.targets_per_game")?.value === 10, "targets observed = per-game value");
  ok(byKey.get("nfl.player.carries_per_game")?.state === "observed_zero" && byKey.get("nfl.player.carries_per_game")?.value === 0, "genuine 0 → observed_zero");
  ok(byKey.get("nfl.player.receptions_per_game")?.state === "missing" && byKey.get("nfl.player.receptions_per_game")?.value === null, "provider-blank stat → missing (never 0)");
  ok(rows.every((r) => r.sport === "nfl" && r.featureVersion === NFL_FEATURE_VERSION && r.entityCanonicalId === "nfl:player:00-0036355"), "rows stamped nfl + canonical player id");
  ok(rows[0].validAt === "2024-09-08T00:00:00Z" && rows[0].knownAt === "2026-08-05T18:00:00Z", "validAt=gameday, knownAt=fetchedAt (honest)");
  ok(rows[0].derivedFromGameIds?.[0]?.includes("nfl:game:2024_01_SF_KC") === true || rows[0].derivedFromGameIds?.[0] === "nfl:game:2024_01_sf_kc", "canonical game id lineage from the schedule join");
}

// ── No team / unresolved anchor / known-before-valid skipped with reasons ────
{
  const noTeam = buildNflFeatureRows({ season: 2024, sourceId: "s", records: [rec({ teamTricode: null })], anchor });
  ok(noTeam.rows.length === 0 && noTeam.skipped.some((s) => s.reason === "no_team_for_schedule_join"), "null team → skipped (no schedule join)");
  const bye = buildNflFeatureRows({ season: 2024, sourceId: "s", records: [rec({ week: 9 })], anchor });
  ok(bye.rows.length === 0 && bye.skipped.some((s) => s.reason === "unresolved_schedule_anchor"), "unresolved week → skipped");
  // knownAt (fetchedAt) BEFORE validAt (gameday) is impossible → rejected.
  const leak = buildNflFeatureRows({ season: 2024, sourceId: "s", records: [rec({ timestamps: ts("2024-09-01T00:00:00Z") })], anchor });
  ok(leak.rows.length === 0 && leak.skipped.some((s) => s.reason === "known_before_valid"), "known-before-valid rejected (leakage firewall)");
}

// ── No forbidden line/price/EV/outcome key on any row ───────────────────────
{
  const { rows } = buildNflFeatureRows({ season: 2024, sourceId: "s", records: [rec({})], anchor });
  const dump = JSON.stringify(rows).toLowerCase();
  const forbidden = ["line", "price", "odds", "edge", "\"ev\"", "payout", "sportsbook", "outcome", "settlement"];
  ok(!forbidden.some((k) => dump.includes(k.replace(/"/g, ""))) || !/"(line|price|odds|edge|ev|payout|sportsbook|outcome|settlement)"\s*:/.test(dump), "no forbidden line/price/EV/outcome key");
}

console.log(`\nnflFeatureBuilder.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
