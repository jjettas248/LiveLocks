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

// ── Season string ↔ int ─────────────────────────────────────────────────────
{
  ok(nbaSeasonIntFromString("2025-26") === 2026, "2025-26 → 2026");
  ok(nbaSeasonIntFromString("2023-24") === 2024, "2023-24 → 2024");
  ok(nbaSeasonIntFromString("garbage") === null, "bad season → null");
  ok(nbaSeasonStringFromInt(2026) === "2025-26", "2026 → 2025-26");
  ok(nbaSeasonStringFromInt(2024) === "2023-24", "2024 → 2023-24");
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

console.log(`\nnbaGameLogAdapter.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
