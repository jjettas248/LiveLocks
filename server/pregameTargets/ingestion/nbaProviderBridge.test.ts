// Run: npx tsx server/pregameTargets/ingestion/nbaProviderBridge.test.ts
// Pregame Targets PR5 — RAW provider → adapter bridge (the path the runner actually
// takes). Proves the corrected contract end-to-end WITHOUT the transformed
// getPlayerGameLogs()/PlayerGameLogRow path:
//   • fetchRawNbaPlayerGameLog requests the EXACT season + season type (identity ==
//     request); regular-season data can never be stored under a playoff key.
//   • the verbatim provider payload reaches the adapter, so a genuine missing MIN/PTS
//     survives as null (never coerced to 0), a real 0 stays 0, an omitted header is
//     missing, and a duplicate consumed header fails closed.
//   • parseSeasonType rejects any unsupported season type (the runner exits 2).
import { fetchRawNbaPlayerGameLog } from "../../services/nbaStatsService";
import { parseNbaGameLog } from "./nbaGameLogAdapter";
import { buildNbaGameLogSourceKey } from "./nbaSourceContracts";
import { parseSeasonType } from "../../scripts/nbaPregameBackfill";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const realFetch = globalThis.fetch;
async function withCapturedFetch<T>(response: { okStatus?: boolean; json: unknown; throwTransport?: boolean }, fn: () => Promise<T>): Promise<{ result: T; url: string | null }> {
  let url: string | null = null;
  globalThis.fetch = (async (input: unknown) => {
    url = String(input);
    if (response.throwTransport) throw new Error("network down");
    return {
      ok: response.okStatus ?? true,
      status: response.okStatus === false ? 500 : 200,
      json: async () => response.json,
    } as Response;
  }) as typeof globalThis.fetch;
  try {
    const result = await fn();
    return { result, url };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const H = ["GAME_ID", "GAME_DATE", "MATCHUP", "MIN", "PTS", "REB", "AST", "FG3M"];
const providerBody = (rowSet: unknown[][], headers: string[] = H) => ({ resultSets: [{ name: "PlayerGameLog", headers, rowSet }] });

// ── seasonType parity: the request carries the EXACT season + season type ────
{
  const { result, url } = await withCapturedFetch(
    { json: providerBody([["0022400500", "2025-01-15", "DEN vs. LAL", 34, 30, 8, 6, 3]]) },
    () => fetchRawNbaPlayerGameLog({ playerId: "201939", season: "2024-25", seasonType: "Playoffs" }),
  );
  ok(result.ok, "raw fetch ok on a 200 provider response");
  ok(url !== null && /SeasonType=Playoffs/.test(url!), "request sends SeasonType=Playoffs");
  ok(url !== null && /Season=2024-25/.test(url!), "request sends the exact season 2024-25");
  ok(url !== null && /PlayerID=201939/.test(url!), "request sends the requested PlayerID");
  // Identity == request: the key a Playoffs pull stores under says Playoffs, and a
  // Regular Season key for the same bytes is a DIFFERENT identity.
  const playoffKey = buildNbaGameLogSourceKey({ sourceKind: "nba_stats_playergamelog", entityCanonicalId: "nba:player:201939", season: 2025, seasonType: "Playoffs" });
  const regularKey = buildNbaGameLogSourceKey({ sourceKind: "nba_stats_playergamelog", entityCanonicalId: "nba:player:201939", season: 2025, seasonType: "Regular Season" });
  ok(playoffKey.includes("seasonType=Playoffs"), "playoff source key records Playoffs");
  ok(playoffKey !== regularKey, "playoff and regular-season keys are distinct identities (no cross-storage)");
}

// ── Transport / HTTP / JSON failures are typed, not silent empties ──────────
{
  const transport = await withCapturedFetch({ json: null, throwTransport: true }, () => fetchRawNbaPlayerGameLog({ playerId: "1", season: "2024-25", seasonType: "Regular Season" }));
  ok(!transport.result.ok && transport.result.ok === false && (transport.result as { reason: string }).reason === "transport_failure", "transport error → transport_failure");
  const http = await withCapturedFetch({ okStatus: false, json: null }, () => fetchRawNbaPlayerGameLog({ playerId: "1", season: "2024-25", seasonType: "Regular Season" }));
  ok(!http.result.ok && (http.result as { reason: string }).reason === "http_failure", "non-200 → http_failure");
}

// ── Missing vs zero survive the REAL bridge (raw provider JSON → adapter) ────
{
  // A provider row with a genuine null MIN and null PTS, a real 0 REB, and (no FG3M
  // column value present but header present → null too). This is the verbatim
  // provider shape — NOT pre-coerced PlayerGameLogRow.
  const { result } = await withCapturedFetch(
    { json: providerBody([["0022400500", "2025-01-15", "DEN vs. LAL", null, null, 0, 4, null]]) },
    () => fetchRawNbaPlayerGameLog({ playerId: "201939", season: "2024-25", seasonType: "Regular Season" }),
  );
  ok(result.ok, "bridge fetch ok");
  if (result.ok) {
    const parsed = parseNbaGameLog({ kind: "nba_stats_playergamelog", season: 2025, sourceKey: "sk", entityNativeId: "201939", rawPayload: result.rawPayload, fetchedAt: result.fetchedAt });
    ok(parsed.ok, "verbatim provider payload parses");
    if (parsed.ok) {
      ok(parsed.records[0].minutes === null, "provider MIN:null → minutes null (NOT coerced to 0)");
      ok(parsed.records[0].points === null, "provider PTS:null → points null (NOT coerced to 0)");
      ok(parsed.records[0].rebounds === 0, "provider REB:0 → rebounds 0 (a real zero stays zero)");
      ok(parsed.records[0].threePointersMade === null, "provider FG3M:null → threePointersMade null");
    }
  }
}

// ── Omitted PTS column → missing; duplicate PTS column → fail closed ────────
{
  const noPts = providerBody([["0022400500", "2025-01-15", "DEN vs. LAL", 34, 8, 6, 3]], ["GAME_ID", "GAME_DATE", "MATCHUP", "MIN", "REB", "AST", "FG3M"]);
  const { result } = await withCapturedFetch({ json: noPts }, () => fetchRawNbaPlayerGameLog({ playerId: "1", season: "2024-25", seasonType: "Regular Season" }));
  if (result.ok) {
    const parsed = parseNbaGameLog({ kind: "nba_stats_playergamelog", season: 2025, sourceKey: "sk", entityNativeId: "1", rawPayload: result.rawPayload, fetchedAt: result.fetchedAt });
    ok(parsed.ok && parsed.records[0].points === null, "omitted PTS column → points null (missing)");
  }
  const dupPts = providerBody([["0022400500", "2025-01-15", "DEN vs. LAL", 34, 30, 99, 8, 6, 3]], ["GAME_ID", "GAME_DATE", "MATCHUP", "MIN", "PTS", "PTS", "REB", "AST", "FG3M"]);
  const { result: r2 } = await withCapturedFetch({ json: dupPts }, () => fetchRawNbaPlayerGameLog({ playerId: "1", season: "2024-25", seasonType: "Regular Season" }));
  if (r2.ok) {
    const parsed = parseNbaGameLog({ kind: "nba_stats_playergamelog", season: 2025, sourceKey: "sk", entityNativeId: "1", rawPayload: r2.rawPayload, fetchedAt: r2.fetchedAt });
    ok(!parsed.ok && parsed.reason === "incomplete_response", "duplicate PTS column in the live payload → incomplete_response");
  }
}

// ── parseSeasonType: only the supported enum passes (runner exit-2 gate) ─────
{
  ok(parseSeasonType("Regular Season") === "Regular Season", "'Regular Season' accepted");
  ok(parseSeasonType("Playoffs") === "Playoffs", "'Playoffs' accepted");
  ok(parseSeasonType("Preseason") === null, "'Preseason' rejected");
  ok(parseSeasonType("playoffs") === null, "case-sensitive: 'playoffs' rejected");
  ok(parseSeasonType("") === null, "empty rejected");
}

console.log(`\nnbaProviderBridge.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
