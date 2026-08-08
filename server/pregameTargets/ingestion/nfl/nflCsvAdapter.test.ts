// Run: npx tsx server/pregameTargets/ingestion/nfl/nflCsvAdapter.test.ts
// PR6 — nflverse CSV adapter (authoritative schema): name-based parse, provider-native
// game_id + season_type required, requested-season ENFORCED (mixed-season fail closed),
// strict integer season/week (no silent normalization) + week range, fail-closed on
// missing/duplicate consumed header + wrong-width row + conflicting-duplicate-key;
// observed vs missing(blank/NA) vs observed_zero; blank-key dropped+surfaced; exact-dup
// collapsed. Schedule: multi-season → deterministic requested-season filter.
import { parseCsv, parseNflWeeklyStats, parseNflSchedule, gamedayToIso } from "./nflCsvAdapter";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

// Real weekly header (subset of the authoritative stats_player_week columns, order varied).
const WH = "player_id,game_id,season,week,season_type,team,opponent_team,position,targets,receptions,receiving_yards,carries,rushing_yards";
const wk = (rows: string) => `${WH}\n${rows}`;
const wargs = (raw: unknown, season = 2024) => ({ requestedSeason: season, sourceKey: "sk", rawPayload: raw, fetchedAt: "2026-08-05T18:00:00Z" });

// ── CSV parser basics ───────────────────────────────────────────────────────
{
  const p = parseCsv('a,b\r\n1,"x,y"\n');
  ok(p !== null && p!.rows[0][1] === "x,y", "embedded comma inside quotes preserved");
  ok(parseCsv("") === null, "empty → null");
}

// ── Normal weekly parse: game_id/season_type carried; observed/zero/missing ──
{
  const res = parseNflWeeklyStats(wargs(wk(
    "00-0036355,2024_01_SF_KC,2024,1,REG,SF,KC,WR,10,7,110,0,0\n" +
    "00-0036355,2024_02_SF_LA,2024,2,REG,SF,LA,WR,8,,NA,1,7",
  )));
  ok(res.ok, "normal weekly parses");
  if (res.ok) {
    ok(res.records.length === 2, "two records");
    ok(res.records[0].gameId === "2024_01_SF_KC" && res.records[0].seasonType === "REG", "provider game_id + season_type carried");
    ok(res.records[0].teamTricode === "SF" && res.records[0].opponentTricode === "KC", "team + opponent from provider columns");
    ok(res.records[0].carries === 0 && res.records[0].rushingYards === 0, "genuine 0 preserved (observed_zero)");
    ok(res.records[1].receptions === null && res.records[1].receivingYards === null, "blank + NA → null (missing), never 0");
    ok(res.diagnostics.rawRows === 2, "rawRows counted");
  }
}

// ── Requested-season ENFORCED: a mixed-season row fails closed ──────────────
{
  const mixed = parseNflWeeklyStats(wargs(wk(
    "00-0036355,2024_01_SF_KC,2024,1,REG,SF,KC,WR,10,7,110,0,0\n" +
    "00-0036355,2023_01_SF_PIT,2023,1,REG,SF,PIT,WR,9,6,90,0,0",  // wrong season
  )));
  ok(!mixed.ok && mixed.reason === "season_mismatch", "a row from another season → season_mismatch (fail closed)");
}

// ── Strict integer identity: malformed season/week + out-of-range week ──────
{
  ok(parseNflWeeklyStats(wargs(wk("00-0036355,2024_01_SF_KC,20x4,1,REG,SF,KC,WR,10,7,110,0,0"))).ok === false, "non-integer season → not ok");
  const badSeason = parseNflWeeklyStats(wargs(wk("00-0036355,2024_01_SF_KC,20x4,1,REG,SF,KC,WR,10,7,110,0,0")));
  ok(!badSeason.ok && badSeason.reason === "invalid_identifier", "non-integer season → invalid_identifier (not normalized)");
  const badWeek = parseNflWeeklyStats(wargs(wk("00-0036355,2024_01_SF_KC,2024,1.5,REG,SF,KC,WR,10,7,110,0,0")));
  ok(!badWeek.ok && badWeek.reason === "invalid_identifier", "non-integer week → invalid_identifier");
  const oobWeek = parseNflWeeklyStats(wargs(wk("00-0036355,2024_99_SF_KC,2024,99,REG,SF,KC,WR,10,7,110,0,0")));
  ok(!oobWeek.ok && oobWeek.reason === "invalid_identifier", "out-of-range week → invalid_identifier");
}

// ── Missing required (game_id) + duplicate consumed header fail closed ──────
{
  const noGid = "player_id,season,week,season_type,team,targets\n00-0036355,2024,1,REG,SF,10";
  const r1 = parseNflWeeklyStats(wargs(noGid));
  ok(!r1.ok && r1.reason === "incomplete_response", "missing required game_id → incomplete_response");
  const dup = `player_id,game_id,season,week,season_type,team,targets,targets\n00-0036355,2024_01_SF_KC,2024,1,REG,SF,10,9`;
  ok(parseNflWeeklyStats(wargs(dup)).ok === false, "duplicate consumed 'targets' header → not ok");
}

// ── Wrong-width row + conflicting/exact-dup by (player_id, game_id) ──────────
{
  const short = parseNflWeeklyStats(wargs(wk("00-0036355,2024_01_SF_KC,2024,1,REG,SF,KC,WR,10")));
  ok(!short.ok && short.reason === "incomplete_response", "wrong-width row → incomplete_response");
  const conflict = parseNflWeeklyStats(wargs(wk(
    "00-0036355,2024_01_SF_KC,2024,1,REG,SF,KC,WR,10,7,110,0,0\n" +
    "00-0036355,2024_01_SF_KC,2024,1,REG,SF,KC,WR,12,7,110,0,0",  // same player+game, diff targets
  )));
  ok(!conflict.ok && conflict.reason === "conflicting_rows", "conflicting duplicate (player,game) → conflicting_rows");
  const exactDup = parseNflWeeklyStats(wargs(wk(
    "00-0036355,2024_01_SF_KC,2024,1,REG,SF,KC,WR,10,7,110,0,0\n" +
    "00-0036355,2024_01_SF_KC,2024,1,REG,SF,KC,WR,10,7,110,0,0",
  )));
  ok(exactDup.ok && exactDup.records.length === 1 && exactDup.diagnostics.duplicateRowsCollapsed === 1, "exact-dup collapsed + surfaced");
}

// ── Blank key dropped + surfaced; empty/malformed ───────────────────────────
{
  const blank = parseNflWeeklyStats(wargs(wk(
    "00-0036355,2024_01_SF_KC,2024,1,REG,SF,KC,WR,10,7,110,0,0\n" +
    ",2024_01_SF_KC,2024,1,REG,SF,KC,WR,3,2,20,0,0",  // blank player_id
  )));
  ok(blank.ok && blank.records.length === 1 && blank.diagnostics.blankKeyRows === 1, "blank player_id dropped + surfaced");
  ok(parseNflWeeklyStats(wargs(WH)).ok === false, "header only → not ok (empty_result)");
  ok(!parseNflWeeklyStats(wargs(null)).ok, "null → malformed");
}

// ── Schedule: multi-season file, deterministic requested-season filter ──────
{
  const SH = "game_id,season,game_type,week,gameday,home_team,away_team";
  const sched = `${SH}\n` +
    "2024_01_SF_KC,2024,REG,1,2024-09-08,KC,SF\n" +
    "2023_01_SF_PIT,2023,REG,1,2023-09-10,PIT,SF";  // other season → filtered out
  const res = parseNflSchedule({ requestedSeason: 2024, sourceKey: "sk", rawPayload: sched, fetchedAt: "x" });
  ok(res.ok, "multi-season schedule parses");
  if (res.ok) {
    ok(res.records.length === 1 && res.records[0].gameId === "2024_01_SF_KC", "only the requested season retained");
    ok(res.diagnostics.seasonFilteredRows === 1, "off-season rows counted as filtered (not accepted)");
  }
  const none = parseNflSchedule({ requestedSeason: 2099, sourceKey: "sk", rawPayload: sched, fetchedAt: "x" });
  ok(!none.ok && none.reason === "empty_result", "requested season with no schedule rows → empty_result (fail closed)");
  ok(gamedayToIso("2024-09-08") === "2024-09-08T00:00:00Z" && gamedayToIso("x") === "invalid-game-date", "gameday→ISO / invalid tag");
}

console.log(`\nnflCsvAdapter.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
