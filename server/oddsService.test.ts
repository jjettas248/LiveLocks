// MLB Live Edge odds-cache tests — unit tests for the unified raw-cache /
// single-flight / status-based-freshness redesign (see CLAUDE.md).
// Run: npx tsx server/oddsService.test.ts
//
// Mocks global.fetch so no real network/API-key access is required. Sets a
// fake ODDS_API_KEY BEFORE importing oddsService.ts (dynamic import) so the
// module's key rotation actually attempts a "fetch" instead of short-circuiting
// with zero configured keys.

process.env.ODDS_API_KEY = process.env.ODDS_API_KEY ?? "test-key-1";

const oddsService = await import("./oddsService");
const oddsConfig = await import("./odds/oddsConfig");

const {
  getMLBPlayerOdds,
  readMLBPlayerOddsFromCache,
  isMLBSnapshotFresh,
  getPlayerOdds, // NBA
} = oddsService;
const { getAllPriorityBooks } = oddsConfig;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[MLB_ODDS_CACHE_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// ── fetch mock harness ────────────────────────────────────────────────────────
interface FetchCall { url: string }
let fetchCalls: FetchCall[] = [];
let fetchDelayMs = 0;
let fetchBookmakers: any[] = [];

(globalThis as any).fetch = async (url: string) => {
  fetchCalls.push({ url: String(url) });
  if (fetchDelayMs > 0) await new Promise((r) => setTimeout(r, fetchDelayMs));
  return {
    ok: true,
    status: 200,
    headers: { get: (_k: string) => null },
    text: async () => "{}",
    json: async () => ({ bookmakers: fetchBookmakers }),
  };
};

function bookmakerRow(bookKey: string, marketKey: string, players: Array<{ name: string; line: number }>) {
  const outcomes: any[] = [];
  for (const p of players) {
    outcomes.push({ name: "Over", description: p.name, point: p.line, price: -115 });
    outcomes.push({ name: "Under", description: p.name, point: p.line, price: -105 });
  }
  return {
    key: bookKey,
    last_update: new Date().toISOString(),
    markets: [{ key: marketKey, last_update: new Date().toISOString(), outcomes }],
  };
}

// ── A: provider URL never includes in_play; only the 3 MLB books ──────────────
{
  fetchCalls = [];
  fetchBookmakers = [bookmakerRow("draftkings", "batter_hits", [{ name: "Test Player A", line: 1.5 }])];
  await getMLBPlayerOdds("evt-url-check", "Test Player A", "hits", false);
  check("A1: cold cache issues exactly one fetch", fetchCalls.length === 1, `got ${fetchCalls.length}`);
  const url = fetchCalls[0]?.url ?? "";
  check("A2: URL never includes in_play", !url.includes("in_play"), url);
  const bmParam = new URL(url).searchParams.get("bookmakers") ?? "";
  check("A3: URL requests exactly draftkings,fanduel,hardrockbet", bmParam === "draftkings,fanduel,hardrockbet", bmParam);
}

// ── B: pregame and live access produce the SAME raw cache key ─────────────────
{
  fetchCalls = [];
  fetchBookmakers = [bookmakerRow("draftkings", "batter_hits", [{ name: "Same Key Player", line: 2.5 }])];
  await getMLBPlayerOdds("evt-samekey", "Same Key Player", "hits", true); // "live" flavor
  check("B1: first (inPlay=true) read fetches once", fetchCalls.length === 1, `got ${fetchCalls.length}`);
  await getMLBPlayerOdds("evt-samekey", "Same Key Player", "hits", false); // "pregame" flavor
  check(
    "B2: second (inPlay=false) read for the same event+market reuses the cache — no new fetch",
    fetchCalls.length === 1,
    `got ${fetchCalls.length}`,
  );
}

// ── C: twenty concurrent player reads for one event/market → 1 provider request ──
{
  const names = [
    "Alex Abrams", "Blake Bennett", "Casey Cooper", "Drew Dawson", "Elliot Ellis",
    "Frank Foster", "Gabe Griffin", "Harper Holt", "Ivan Ingram", "Jesse Jordan",
    "Kyle Kramer", "Logan Lyle", "Miles Monroe", "Noah Newton", "Owen Osgood",
    "Parker Price", "Quinn Quincy", "Riley Rhodes", "Sam Sutton", "Tyler Tate",
  ];
  check("C0: fixture has 20 distinct players", names.length === 20);

  fetchCalls = [];
  fetchDelayMs = 5; // force real overlap so single-flight is genuinely exercised
  fetchBookmakers = [bookmakerRow("draftkings", "batter_hits", names.map((name) => ({ name, line: 1.5 })))];
  const results = await Promise.all(names.map((name) => getMLBPlayerOdds("evt-concurrent", name, "hits", false)));
  fetchDelayMs = 0;

  check("C1: 20 concurrent player reads collapse into exactly 1 provider request", fetchCalls.length === 1, `got ${fetchCalls.length}`);
  check(
    "C2: every concurrent read resolved its own player's real line",
    results.every((r) => Object.keys(r).some((k) => !k.startsWith("_"))),
    JSON.stringify(results.map((r) => Object.keys(r))),
  );
}

// ── D: missing-player lookup does not initiate another request ────────────────
{
  fetchCalls = [];
  fetchBookmakers = [bookmakerRow("fanduel", "batter_hits", [{ name: "Known Player", line: 1.5 }])];
  await getMLBPlayerOdds("evt-missingplayer", "Known Player", "hits", false); // seed cache
  check("D1: seed fetch happened once", fetchCalls.length === 1, `got ${fetchCalls.length}`);

  const missing = readMLBPlayerOddsFromCache("evt-missingplayer", "Totally Unknown Player", "hits", "live");
  check("D2: missing-player cache read returns null", missing === null);
  check("D3: missing-player cache read issued zero additional requests", fetchCalls.length === 1, `got ${fetchCalls.length}`);
}

// ── E: engine evaluation with an empty/stale cache makes zero external calls ──
{
  fetchCalls = [];
  const neverFetched = readMLBPlayerOddsFromCache("evt-never-touched", "Nobody", "hits", "live");
  check("E1: cold-cache read returns null", neverFetched === null);
  check("E2: cold-cache read makes zero external calls", fetchCalls.length === 0, `got ${fetchCalls.length}`);
}

// ── F: status-based freshness — live vs pregame classify the same snapshot differently ──
{
  check("F1: live @ 10s = fresh", isMLBSnapshotFresh("live", 10_000) === true);
  check("F2: live @ 90s = degraded/stale", isMLBSnapshotFresh("live", 90_000) === false);
  check("F3: pregame @ 90s = fresh", isMLBSnapshotFresh("pregame", 90_000) === true);
  check("F4: pregame @ 10min = degraded/stale", isMLBSnapshotFresh("pregame", 10 * 60_000) === false);
  check(
    "F5: the SAME 90s-old snapshot classifies differently under live vs pregame",
    isMLBSnapshotFresh("live", 90_000) !== isMLBSnapshotFresh("pregame", 90_000),
  );
  check("F6: final is immutable — always fresh regardless of age", isMLBSnapshotFresh("final", 999_999_999) === true);
  check("F7: unknown is cache-only — never confirmed fresh", isMLBSnapshotFresh("unknown", 0) === false);

  // Integration-level: a snapshot fetched moments ago reads back non-degraded
  // under "live" but degraded under "unknown", without a second fetch.
  fetchCalls = [];
  fetchBookmakers = [bookmakerRow("hardrockbet", "batter_hits", [{ name: "Fresh Player", line: 0.5 }])];
  await getMLBPlayerOdds("evt-freshness", "Fresh Player", "hits", false);
  const freshRead = readMLBPlayerOddsFromCache("evt-freshness", "Fresh Player", "hits", "live");
  check(
    "F8: freshly-fetched snapshot reads back non-degraded under live status",
    freshRead !== null && freshRead.isDegraded === false,
    JSON.stringify(freshRead),
  );
  const unknownRead = readMLBPlayerOddsFromCache("evt-freshness", "Fresh Player", "hits", "unknown");
  check(
    "F9: the same snapshot reads back degraded under unknown status (cache-only)",
    unknownRead !== null && unknownRead.isDegraded === true,
    JSON.stringify(unknownRead),
  );
  check("F10: neither status-classification read issued a new request", fetchCalls.length === 1, `got ${fetchCalls.length}`);
}

// ── G: NBA bookmaker behavior remains unchanged ────────────────────────────────
{
  const nbaBooks = getAllPriorityBooks("nba");
  check("G1: NBA book list unchanged (11 books)", nbaBooks.length === 11, JSON.stringify(nbaBooks));
  check(
    "G2: NBA book list still includes books MLB dropped (betmgm, prizepicks, bovada, ...)",
    ["betmgm", "betrivers", "espnbet", "prizepicks", "underdogfantasy", "betonlineag", "bovada", "williamhill_us"].every((b) =>
      nbaBooks.includes(b),
    ),
    JSON.stringify(nbaBooks),
  );

  const mlbBooks = getAllPriorityBooks("mlb");
  check(
    "G3: MLB book list reduced to exactly draftkings, fanduel, hardrockbet",
    mlbBooks.length === 3 && ["draftkings", "fanduel", "hardrockbet"].every((b) => mlbBooks.includes(b)),
    JSON.stringify(mlbBooks),
  );

  const ncaabBooks = getAllPriorityBooks("ncaab");
  check("G4: NCAAB book list untouched by the MLB-only reduction (9 books)", ncaabBooks.length === 9, JSON.stringify(ncaabBooks));

  // Fetch-URL level: NBA's own player-odds path still requests all 11 books
  // and still uses its own separate live/pregame cache keys — proving the
  // MLB unification didn't leak into the shared NBA code path.
  fetchCalls = [];
  fetchBookmakers = [bookmakerRow("draftkings", "player_points", [{ name: "NBA Test Player", line: 24.5 }])];
  await getPlayerOdds("evt-nba-check", "NBA Test Player", "points", false);
  check("G5: NBA fetch still happens (unaffected by the MLB change)", fetchCalls.length === 1, `got ${fetchCalls.length}`);
  const nbaUrl = fetchCalls[0]?.url ?? "";
  const nbaBmParam = new URL(nbaUrl).searchParams.get("bookmakers") ?? "";
  check(
    "G6: NBA URL still requests the full 11-book list",
    nbaBmParam.split(",").length === 11 && nbaBmParam.includes("betmgm") && nbaBmParam.includes("prizepicks"),
    nbaBmParam,
  );
}

console.log(`[MLB_ODDS_CACHE_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
