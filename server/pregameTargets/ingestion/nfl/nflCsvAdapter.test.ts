// Run: npx tsx server/pregameTargets/ingestion/nfl/nflCsvAdapter.test.ts
// PR6 — nflverse CSV adapter: name-based (order-independent) parse, fail-closed on
// missing/duplicate consumed headers, wrong-width rows, conflicting duplicate keys;
// observed vs missing (blank/NA) vs observed_zero distinct; blank key dropped + surfaced;
// exact-dup rows collapsed. Plus schedule parse + gameday→ISO anchor.
import { parseCsv, parseNflWeeklyStats, parseNflSchedule, gamedayToIso } from "./nflCsvAdapter";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const WH = "player_id,season,week,recent_team,team,position,targets,receptions,receiving_yards,carries,rushing_yards";
const wk = (rows: string) => `${WH}\n${rows}`;
const wargs = (raw: unknown) => ({ season: 2024, sourceKey: "sk", rawPayload: raw, fetchedAt: "2026-08-05T18:00:00Z" });

// ── CSV parser: quotes, embedded commas, escaped quotes, CRLF ────────────────
{
  const p = parseCsv('a,b,c\r\n1,"x,y",3\r\n4,"he said ""hi""",6\n');
  ok(p !== null && p.headers.join("|") === "a|b|c", "header row parsed");
  ok(p!.rows[0].join("|") === "1|x,y|3", "embedded comma inside quotes preserved");
  ok(p!.rows[1][1] === 'he said "hi"', "escaped double-quote unescaped");
  ok(parseCsv("") === null && parseCsv(null) === null, "empty/non-string → null");
}

// ── Normal weekly parse: observed / observed_zero / missing distinct ─────────
{
  const res = parseNflWeeklyStats(wargs(wk(
    "00-0036355,2024,1,SF,SF,WR,10,7,110,0,0\n" +      // observed incl. genuine zeros (carries 0, rushing 0)
    "00-0036355,2024,2,SF,SF,WR,8,,NA,1,7",             // receptions blank → missing, receiving_yards NA → missing
  )));
  ok(res.ok, "normal weekly payload parses");
  if (res.ok) {
    ok(res.records.length === 2, "two records");
    ok(res.records[0].targets === 10 && res.records[0].receivingYards === 110, "observed values preserved");
    ok(res.records[0].carries === 0 && res.records[0].rushingYards === 0, "genuine 0 preserved (observed_zero, not null)");
    ok(res.records[1].receptions === null && res.records[1].receivingYards === null, "blank + NA → null (missing), never 0");
    ok(res.records[0].teamTricode === "SF" && res.records[0].position === "WR", "team + position parsed");
    ok(res.records[0].timestamps.fetchedAt === "2026-08-05T18:00:00Z" && res.records[0].timestamps.sourcePublishedAt === null, "timestamps carried");
  }
}

// ── Reordered columns resolve BY NAME ───────────────────────────────────────
{
  const reordered = "week,player_id,targets,season,recent_team,receptions,receiving_yards,position,carries,rushing_yards,team\n" +
    "3,00-0036355,9,2024,SF,6,80,WR,2,15,SF";
  const res = parseNflWeeklyStats(wargs(reordered));
  ok(res.ok, "reordered headers parse");
  if (res.ok) ok(res.records[0].targets === 9 && res.records[0].week === 3 && res.records[0].playerId === "00-0036355", "columns read by name regardless of order");
}

// ── Missing required header + duplicate consumed header fail closed ──────────
{
  const noWeek = "player_id,season,recent_team,targets\n00-0036355,2024,SF,5";
  const r1 = parseNflWeeklyStats(wargs(noWeek));
  ok(!r1.ok && r1.reason === "incomplete_response", "missing required 'week' → incomplete_response");
  const dupTargets = `player_id,season,week,targets,targets\n00-0036355,2024,1,5,9`;
  const r2 = parseNflWeeklyStats(wargs(dupTargets));
  ok(!r2.ok && r2.reason === "incomplete_response", "duplicate consumed 'targets' header → incomplete_response");
}

// ── Wrong-width row fails closed (truncated/garbage) ────────────────────────
{
  const shortRow = wk("00-0036355,2024,1,SF,SF,WR,10,7");  // fewer cells than headers
  const res = parseNflWeeklyStats(wargs(shortRow));
  ok(!res.ok && res.reason === "incomplete_response", "wrong-width row → incomplete_response (never partial)");
}

// ── Conflicting duplicate key rows fail closed (order-independent) ───────────
{
  const conflict = parseNflWeeklyStats(wargs(wk(
    "00-0036355,2024,1,SF,SF,WR,10,7,110,0,0\n" +
    "00-0036355,2024,1,SF,SF,WR,12,7,110,0,0",  // same (player,season,week), diff targets
  )));
  ok(!conflict.ok && conflict.reason === "conflicting_rows", "conflicting duplicate key → conflicting_rows");
  const swapped = parseNflWeeklyStats(wargs(wk(
    "00-0036355,2024,1,SF,SF,WR,12,7,110,0,0\n" +
    "00-0036355,2024,1,SF,SF,WR,10,7,110,0,0",
  )));
  ok(!swapped.ok && swapped.reason === "conflicting_rows", "conflict is order-independent");
}

// ── Exact-duplicate rows collapse; blank key dropped + surfaced ─────────────
{
  const dup = parseNflWeeklyStats(wargs(wk(
    "00-0036355,2024,1,SF,SF,WR,10,7,110,0,0\n" +
    "00-0036355,2024,1,SF,SF,WR,10,7,110,0,0\n" +   // byte-identical
    "00-0000000,2024,2,KC,KC,TE,4,3,30,0,0",
  )));
  ok(dup.ok, "byte-identical duplicate parses (collapsed)");
  if (dup.ok) {
    ok(dup.records.length === 2 && dup.diagnostics.duplicateRowsCollapsed === 1, "exact-dup collapsed + surfaced");
  }
  const blank = parseNflWeeklyStats(wargs(wk(
    "00-0036355,2024,1,SF,SF,WR,10,7,110,0,0\n" +
    ",2024,1,SF,SF,WR,3,2,20,0,0",  // blank player_id
  )));
  ok(blank.ok, "a blank-key row does not fail the whole response");
  if (blank.ok) ok(blank.records.length === 1 && blank.diagnostics.blankKeyRows === 1, "blank-key row dropped + surfaced in diagnostics");
}

// ── Empty / malformed ───────────────────────────────────────────────────────
{
  ok(parseNflWeeklyStats(wargs(WH)).ok === false, "header only (no data rows) → not ok");
  const eOnly = parseNflWeeklyStats(wargs(WH));
  ok(!eOnly.ok && eOnly.reason === "empty_result", "header-only → empty_result");
  ok(!parseNflWeeklyStats(wargs(null)).ok, "null payload → not ok");
  const nullRes = parseNflWeeklyStats(wargs(null));
  ok(!nullRes.ok && nullRes.reason === "malformed", "null payload → malformed");
}

// ── Schedule parse + gameday→ISO ────────────────────────────────────────────
{
  const sched = "game_id,season,week,gameday,home_team,away_team\n2024_01_SF_KC,2024,1,2024-09-08,KC,SF";
  const res = parseNflSchedule({ season: 2024, sourceKey: "sk", rawPayload: sched, fetchedAt: "2026-08-05T18:00:00Z" });
  ok(res.ok, "schedule parses");
  if (res.ok) {
    ok(res.records[0].gameId === "2024_01_SF_KC" && res.records[0].gameDate === "2024-09-08", "schedule fields parsed");
    ok(res.records[0].homeTeam === "KC" && res.records[0].awayTeam === "SF", "home/away parsed");
  }
  ok(gamedayToIso("2024-09-08") === "2024-09-08T00:00:00Z", "gameday → ISO anchor");
  ok(gamedayToIso("nonsense") === "invalid-game-date", "unparseable gameday → invalid tag (never fabricated)");
  const noDate = parseNflSchedule({ season: 2024, sourceKey: "sk", rawPayload: "game_id,season,week,home_team\n2024_01_SF_KC,2024,1,KC", fetchedAt: "x" });
  ok(!noDate.ok && noDate.reason === "incomplete_response", "schedule missing required 'gameday' → incomplete_response");
}

console.log(`\nnflCsvAdapter.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
