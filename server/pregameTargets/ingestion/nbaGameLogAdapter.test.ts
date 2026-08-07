// Run: npx tsx server/pregameTargets/ingestion/nbaGameLogAdapter.test.ts
// Pregame Targets PR5 — adapter: incomplete/failed responses classified (never
// fabricated), observed vs missing (null stat) vs observed-zero distinct, season
// string↔int, GAME_DATE→ISO source-effective anchor, traded-player tricodes.
import { parseNbaGameLog, nbaSeasonIntFromString, nbaSeasonStringFromInt, gameDateToIso } from "./nbaGameLogAdapter";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const HEADERS = ["GAME_ID", "GAME_DATE", "MATCHUP", "MIN", "PTS", "REB", "AST", "FG3M"];
const base = (rowSet: unknown[][]) => ({ resultSets: [{ headers: HEADERS, rowSet }] });
const args = (rawPayload: unknown, over: Partial<Parameters<typeof parseNbaGameLog>[0]> = {}) => ({
  kind: "nba_stats_playergamelog" as const, season: 2026, sourceKey: "sk", entityNativeId: "201939", rawPayload, fetchedAt: "2026-08-05T18:00:00Z", ...over,
});

// ── Season string ↔ int (SEMANTIC validation, not just structural) ──────────
{
  ok(nbaSeasonIntFromString("2025-26") === 2026, "2025-26 → 2026");
  ok(nbaSeasonIntFromString("2023-24") === 2024, "2023-24 → 2024");
  ok(nbaSeasonIntFromString("1999-00") === 2000, "1999-00 → 2000 (century rollover suffix)");
  ok(nbaSeasonIntFromString("garbage") === null, "bad season → null");
  // Structurally shaped but semantically impossible seasons are REJECTED, never
  // silently normalized to a season the caller never asked for.
  ok(nbaSeasonIntFromString("2025-99") === null, "2025-99 → null (suffix must be 26)");
  ok(nbaSeasonIntFromString("2025-25") === null, "2025-25 → null (suffix must be 26, not the start year)");
  ok(nbaSeasonIntFromString("2025-2") === null, "2025-2 → null (suffix must be two digits)");
  ok(nbaSeasonIntFromString("2024-26") === null, "2024-26 → null (suffix must be 25)");
  ok(nbaSeasonStringFromInt(2026) === "2025-26", "2026 → 2025-26");
  ok(nbaSeasonStringFromInt(2024) === "2023-24", "2024 → 2023-24");
  ok(nbaSeasonStringFromInt(2000) === "1999-00", "2000 → 1999-00 (round-trips the century rollover)");
}

// ── GAME_DATE → ISO source-effective anchor (both provider formats) ─────────
{
  ok(gameDateToIso("2024-01-15") === "2024-01-15T00:00:00Z", "ISO date form");
  ok(gameDateToIso("JAN 15, 2024") === "2024-01-15T00:00:00Z", "MON DD, YYYY form");
  ok(gameDateToIso("nonsense") === "invalid-game-date", "unparseable → invalid tag (never fabricated)");
}

// ── Normal parse: observed / observed-zero / missing distinct ───────────────
{
  const res = parseNbaGameLog(args(base([
    ["0022300500", "2024-01-15", "DEN vs. LAL", 34, 30, 8, 6, 3],   // all observed
    ["0022300480", "2024-01-13", "DEN @ BOS", 20, 0, 5, 0, null],   // PTS 0, AST 0 (observed_zero), FG3M null (missing)
  ])));
  ok(res.ok, "normal payload parses ok");
  if (res.ok) {
    ok(res.records.length === 2, "2 records");
    ok(res.records[0].points === 30 && res.records[0].threePointersMade === 3, "observed values preserved");
    ok(res.records[1].points === 0 && res.records[1].assists === 0, "genuine zero preserved (observed_zero, not null)");
    ok(res.records[1].threePointersMade === null, "provider-omitted stat is null (missing), not 0");
    ok(res.records[0].teamTricode === "DEN", "team tricode parsed from MATCHUP");
    ok(res.records[0].timestamps.sourceEffectiveAt === "2024-01-15T00:00:00Z", "source-effective = game date");
    ok(res.records[0].timestamps.sourcePublishedAt === null, "no published timestamp exposed");
    ok(res.records[0].timestamps.fetchedAt === "2026-08-05T18:00:00Z", "fetchedAt = real fetch instant");
  }
}

// ── Incomplete / empty / malformed classified, never fabricated ─────────────
{
  ok(parseNbaGameLog(args({})).ok === false, "no resultSets → not ok");
  const noRs = parseNbaGameLog(args({}));
  ok(!noRs.ok && noRs.reason === "incomplete_response", "missing resultSets → incomplete_response");
  const empty = parseNbaGameLog(args(base([])));
  ok(!empty.ok && empty.reason === "empty_result", "empty rowSet → empty_result");
  const badHeaders = parseNbaGameLog(args({ resultSets: [{ headers: "nope", rowSet: [] }] }));
  ok(!badHeaders.ok && badHeaders.reason === "incomplete_response", "non-array headers → incomplete_response");
  const nullPayload = parseNbaGameLog(args(null));
  ok(!nullPayload.ok && nullPayload.reason === "malformed", "null payload → malformed");
  // A truncated/partial page (rowSet present but a row is not an array) is malformed, never "complete".
  const partial = parseNbaGameLog(args({ resultSets: [{ headers: HEADERS, rowSet: ["not-a-row"] }] }));
  ok(!partial.ok, "partial/garbage row → not ok (never reported complete)");
}

// ── Traded player: two team tricodes within one season, both retained ───────
{
  const res = parseNbaGameLog(args(base([
    ["0022300520", "2024-02-10", "BOS vs. NYK", 30, 22, 5, 5, 2],   // post-trade team
    ["0022300400", "2024-01-02", "DEN @ MIA", 28, 18, 6, 4, 1],     // pre-trade team
  ])));
  ok(res.ok, "traded-player payload parses");
  if (res.ok) {
    const tricodes = new Set(res.records.map((r) => r.teamTricode));
    ok(tricodes.has("BOS") && tricodes.has("DEN"), "both team stints retained (neither dropped nor merged)");
  }
}

// ── Headers resolved BY NAME: reordered columns parse correctly ─────────────
{
  const reordered = { resultSets: [{ headers: ["PTS", "GAME_DATE", "GAME_ID", "AST", "MIN", "REB", "FG3M", "MATCHUP"], rowSet: [[30, "2024-01-15", "0022300500", 6, 34, 8, 3, "DEN vs. LAL"]] }] };
  const res = parseNbaGameLog(args(reordered));
  ok(res.ok, "reordered headers parse ok (name-based resolution)");
  if (res.ok) ok(res.records[0].points === 30 && res.records[0].gameId === "0022300500" && res.records[0].minutes === 34, "columns read by name regardless of order");
}

// ── Missing REQUIRED header fails closed ────────────────────────────────────
{
  const noDate = { resultSets: [{ headers: ["GAME_ID", "MATCHUP", "MIN", "PTS"], rowSet: [["0022300500", "DEN vs. LAL", 34, 30]] }] };
  const res = parseNbaGameLog(args(noDate));
  ok(!res.ok && res.reason === "incomplete_response", "missing required GAME_DATE header → incomplete_response");
  const noId = { resultSets: [{ headers: ["GAME_DATE", "MIN", "PTS"], rowSet: [["2024-01-15", 34, 30]] }] };
  ok(parseNbaGameLog(args(noId)).ok === false, "missing required GAME_ID header → not ok");
}

// ── Duplicate REQUIRED header fails closed (ambiguous, not last-wins) ────────
{
  const dupId = { resultSets: [{ headers: ["GAME_ID", "GAME_ID", "GAME_DATE", "MIN", "PTS"], rowSet: [["A", "B", "2024-01-15", 34, 30]] }] };
  const res = parseNbaGameLog(args(dupId));
  ok(!res.ok && res.reason === "incomplete_response", "duplicate GAME_ID header → incomplete_response (ambiguous)");
}

// ── Unknown extra headers are ignored (read named columns per manifest) ─────
{
  const extra = { resultSets: [{ headers: [...HEADERS, "SURPRISE_COL"], rowSet: [["0022300500", "2024-01-15", "DEN vs. LAL", 34, 30, 8, 6, 3, "ignored"]] }] };
  const res = parseNbaGameLog(args(extra));
  ok(res.ok, "unknown extra header ignored (still parses)");
  if (res.ok) ok(res.records[0].points === 30, "named columns unaffected by an unknown extra header");
}

// ── Duplicate CONSUMED (optional) headers fail closed — not just required ────
{
  const dupPts = { resultSets: [{ headers: ["GAME_ID", "GAME_DATE", "MIN", "PTS", "PTS"], rowSet: [["0022300500", "2024-01-15", 34, 30, 99]] }] };
  const r1 = parseNbaGameLog(args(dupPts));
  ok(!r1.ok && r1.reason === "incomplete_response", "duplicate PTS header → incomplete_response (ambiguous, no silent last-wins)");
  const dupMin = { resultSets: [{ headers: ["GAME_ID", "GAME_DATE", "MIN", "MIN", "PTS"], rowSet: [["0022300500", "2024-01-15", 34, 20, 30]] }] };
  const r2 = parseNbaGameLog(args(dupMin));
  ok(!r2.ok && r2.reason === "incomplete_response", "duplicate MIN header → incomplete_response");
  const dupReb = { resultSets: [{ headers: ["GAME_ID", "GAME_DATE", "REB", "REB", "PTS"], rowSet: [["0022300500", "2024-01-15", 8, 9, 30]] }] };
  ok(parseNbaGameLog(args(dupReb)).ok === false, "duplicate REB header → not ok");
}

// ── Conflicting duplicate GAME_ID rows fail closed (never fold by row order) ─
{
  const conflict = parseNbaGameLog(args(base([
    ["0022300500", "2024-01-15", "DEN vs. LAL", 34, 30, 8, 6, 3],
    ["0022300500", "2024-01-15", "DEN vs. LAL", 34, 33, 8, 6, 3], // same game, DIFFERENT pts
  ])));
  ok(!conflict.ok && conflict.reason === "conflicting_rows", "conflicting duplicate GAME_ID rows → conflicting_rows (fail closed)");
  // Order must not decide the outcome — swap the two rows, still fails.
  const conflictSwapped = parseNbaGameLog(args(base([
    ["0022300500", "2024-01-15", "DEN vs. LAL", 34, 33, 8, 6, 3],
    ["0022300500", "2024-01-15", "DEN vs. LAL", 34, 30, 8, 6, 3],
  ])));
  ok(!conflictSwapped.ok && conflictSwapped.reason === "conflicting_rows", "conflict is order-independent (swap still fails)");
}

// ── Exact-duplicate GAME_ID rows are collapsed deterministically ────────────
{
  const exactDup = parseNbaGameLog(args(base([
    ["0022300500", "2024-01-15", "DEN vs. LAL", 34, 30, 8, 6, 3],
    ["0022300500", "2024-01-15", "DEN vs. LAL", 34, 30, 8, 6, 3], // byte-identical
    ["0022300480", "2024-01-13", "DEN @ BOS", 20, 18, 5, 4, 1],
  ])));
  ok(exactDup.ok, "byte-identical duplicate rows parse (collapsed, not a failure)");
  if (exactDup.ok) {
    ok(exactDup.records.length === 2, "exact-duplicate row collapsed to a single observation (no double count)");
    ok(exactDup.diagnostics.duplicateRowsCollapsed === 1, "collapsed-duplicate count surfaced in diagnostics");
  }
}

// ── Blank GAME_ID rows are surfaced in diagnostics, not silently swallowed ───
{
  const withBlank = parseNbaGameLog(args(base([
    ["0022300500", "2024-01-15", "DEN vs. LAL", 34, 30, 8, 6, 3],
    ["", "2024-01-14", "DEN vs. SAC", 12, 5, 2, 1, 0], // blank game id — cannot be an observation
  ])));
  ok(withBlank.ok, "a blank-game-id row does not fail the whole response");
  if (withBlank.ok) {
    ok(withBlank.records.length === 1, "blank-game-id row dropped");
    ok(withBlank.diagnostics.blankGameIdRows === 1, "blank-game-id drop surfaced in diagnostics (depth not silently reduced)");
  }
}

console.log(`\nnbaGameLogAdapter.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
