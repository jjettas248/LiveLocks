const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SGO_API_KEY  = process.env.SGO_API_KEY;
const BASE_URL = "https://api.the-odds-api.com/v4/sports/basketball_nba";

// Bookmakers to query for player props — only the six supported books
const PROP_BOOKMAKERS = "draftkings,fanduel,hardrockbet,fanatics,prizepicks,underdogfantasy";
const PROP_REGIONS = "us";

// Canonical team name lookup — The Odds API uses full city+nickname
export const TEAM_FULL_NAMES: Record<string, string> = {
  ATL: "Atlanta Hawks",
  BKN: "Brooklyn Nets",
  BOS: "Boston Celtics",
  CHA: "Charlotte Hornets",
  CHI: "Chicago Bulls",
  CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks",
  DEN: "Denver Nuggets",
  DET: "Detroit Pistons",
  GSW: "Golden State Warriors",
  HOU: "Houston Rockets",
  IND: "Indiana Pacers",
  LAC: "Los Angeles Clippers",
  LAL: "Los Angeles Lakers",
  MEM: "Memphis Grizzlies",
  MIA: "Miami Heat",
  MIL: "Milwaukee Bucks",
  MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans",
  NYK: "New York Knicks",
  OKC: "Oklahoma City Thunder",
  ORL: "Orlando Magic",
  PHI: "Philadelphia 76ers",
  PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers",
  SAC: "Sacramento Kings",
  SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors",
  UTA: "Utah Jazz",
  UTAH: "Utah Jazz",    // some DB records use UTAH instead of UTA
  WAS: "Washington Wizards",
};

interface CacheEntry {
  data: any;
  timestamp: number;
}

// A single bookmaker's line data for a player prop
export interface OddsLine {
  line: number;
  overOdds: number;
  underOdds: number;
  openLine?: number;
  lineMovement?: number;
  edgeEstimate?: number;
}

// Discriminated union for getPlayerOdds return values
export type PlayerOddsResult =
  | { isDegraded: false; quotaExhausted: false; books: Record<string, OddsLine> }
  | { isDegraded: true;  quotaExhausted: false; books: Record<string, OddsLine> }
  | { isDegraded: false; quotaExhausted: true;  books: Record<string, never> };

const cache = new Map<string, CacheEntry>();
const EVENTS_TTL = 3 * 60 * 1000;       // 3 min (shorter so fresh games appear quickly)
// NBA-specific TTLs (reduced for near-real-time line updates)
const NBA_ODDS_TTL = 2 * 60 * 1000;     // 2 min — pre-game line raw cache (NBA)
const NBA_ODDS_LIVE_TTL = 30 * 1000;    // 30 sec — in-play line raw cache for halftime freshness (NBA)
// MLB retains original longer TTLs (separate code path, out of scope for real-time changes)
const MLB_ODDS_TTL = 5 * 60 * 1000;     // 5 min — pre-game line raw cache (MLB)
const MLB_ODDS_LIVE_TTL = 90 * 1000;    // 90 sec — in-play line raw cache (MLB)

function isFresh(entry: CacheEntry | undefined, ttl: number): boolean {
  return !!entry && Date.now() - entry.timestamp < ttl;
}

// Normalize a team name down to its city word(s) for fuzzy matching
function normTeam(name: string): string {
  return name.toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Check if two normalized team strings match each other
function teamsMatch(a: string, b: string): boolean {
  const na = normTeam(a);
  const nb = normTeam(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Fetch and cache the full list of NBA events from The Odds API
async function getEvents(): Promise<any[]> {
  const cacheKey = "events_list";
  const cached = cache.get(cacheKey);
  if (isFresh(cached, EVENTS_TTL)) return cached!.data;

  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY is not set");

  const res = await fetch(
    `${BASE_URL}/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Events fetch failed: ${res.status} — ${body}`);
  }
  const data = await res.json();
  cache.set(cacheKey, { data, timestamp: Date.now() });
  console.log(`[Odds] Fetched ${data.length} NBA events`);
  return data;
}

// Match a team abbreviation (or full name) to an Odds API event UUID.
// playerTeam is the team the player is on; opponentTeam is their opponent.
// We don't know which side is home/away, so we try both orderings.
export async function resolveOddsEventId(
  playerTeamInput: string,
  opponentTeamInput: string
): Promise<string | null> {
  try {
    const events = await getEvents();

    // Resolve abbreviations to full names where possible
    const playerTeam = TEAM_FULL_NAMES[playerTeamInput.toUpperCase()] ?? playerTeamInput;
    const opponentTeam = TEAM_FULL_NAMES[opponentTeamInput.toUpperCase()] ?? opponentTeamInput;

    for (const ev of events) {
      const evHome: string = ev.home_team ?? "";
      const evAway: string = ev.away_team ?? "";

      // Match regardless of home/away ordering
      const playerIsHome = teamsMatch(playerTeam, evHome) && teamsMatch(opponentTeam, evAway);
      const playerIsAway = teamsMatch(playerTeam, evAway) && teamsMatch(opponentTeam, evHome);

      if (playerIsHome || playerIsAway) {
        console.log(`[Odds] Matched event: ${ev.away_team} @ ${ev.home_team} → ${ev.id}`);
        return ev.id as string;
      }
    }

    // Fallback: try to find an event that just contains the player's team
    for (const ev of events) {
      if (
        teamsMatch(playerTeam, ev.home_team ?? "") ||
        teamsMatch(playerTeam, ev.away_team ?? "")
      ) {
        console.log(`[Odds] Fuzzy team match: ${ev.away_team} @ ${ev.home_team} → ${ev.id}`);
        return ev.id as string;
      }
    }

    console.warn(`[Odds] No event found for ${playerTeam} vs ${opponentTeam}. Available: ${
      events.map((e: any) => `${e.away_team} @ ${e.home_team}`).join(" | ")
    }`);
    return null;
  } catch (err) {
    console.error("[Odds] resolveOddsEventId error:", err);
    return null;
  }
}

// Map our stat type to the Odds API market key
// Combo and defensive markets are included so a single API call covers all prop types
const MARKET_MAP: Record<string, string> = {
  points:      "player_points",
  rebounds:    "player_rebounds",
  assists:     "player_assists",
  steals:      "player_steals",
  blocks:      "player_blocks",
  threes:      "player_threes",
  pts_reb_ast: "player_points_rebounds_assists",
  pts_reb:     "player_points_rebounds",
  pts_ast:     "player_points_assists",
  reb_ast:     "player_rebounds_assists",
  stl_blk:     "player_blocks_steals",
};

// Sentinel object returned when the Odds API quota is exhausted
const QUOTA_EXHAUSTED = { _quotaExhausted: true } as const;
// How long to suppress retry attempts after a quota error (60 min)
const QUOTA_TTL = 60 * 60 * 1000;

// ── Debug pipeline logging ────────────────────────────────────────────────────
// Gate all debug logs behind DEBUG_PIPELINE=true to keep production logs clean.
const DEBUG_PIPELINE = process.env.DEBUG_PIPELINE === "true";
function pipelineLog(sport: string, gameId: string, stage: string, payload: unknown): void {
  if (!DEBUG_PIPELINE) return;
  console.log(`[PIPELINE][${sport}][${gameId}] ${stage}:`, JSON.stringify(payload));
}
export { pipelineLog };

// ── Last-known-good raw odds cache (raw API response level) ───────────────────
// Stores most recent successful getRawOdds / getMLBRawOdds response per cache key.
// Key: cacheKey used in getRawOdds/getMLBRawOdds — Value: { data, timestamp }
const lastKnownRawOdds = new Map<string, { data: any; timestamp: number }>();

// ── Flexible MLB prop key matcher ────────────────────────────────────────────
// Bookmakers use varying key formats; avoid exact-string dependency.
export function isMLBPropKey(key: string, statType: string): boolean {
  const k = key.toLowerCase().replace(/[_\-\s]/g, "");
  const s = statType.toLowerCase().replace(/[_\-\s]/g, "");
  if (s === "hits" || s === "batterhits") return k.includes("batterhit") || k.includes("hitter") || (k.includes("hit") && !k.includes("pitcher") && !k.includes("allow") && !k.includes("home"));
  if (s === "totalbases" || s === "total_bases" || s === "batttertotalbases") return k.includes("totalbase") || k.includes("totbase");
  if (s === "batterstrikeouts" || s === "batter_strikeouts") return k.includes("batterstrikeout") || k.includes("batso") || (k.includes("strikeout") && k.includes("batter"));
  if (s === "pitcherstrikeouts" || s === "pitcher_strikeouts") return k.includes("pitcherstrikeout") || k.includes("pitso") || (k.includes("strikeout") && k.includes("pitcher"));
  if (s === "hitsallowed" || s === "hits_allowed") return k.includes("hitsallowed") || k.includes("hitallow");
  if (s === "homeruns" || s === "home_runs") return k.includes("homerun") || k.includes("homer");
  return k.includes(s);
}

// Fetch player prop odds for a single market (saves ~91% of API credits vs fetching all 11).
// Returns QUOTA_EXHAUSTED sentinel when the key is out of credits — callers must check for it.
// inPlay=true fetches live in-game lines (used for halftime plays) instead of pre-game lines.
async function getRawOdds(oddsEventId: string, marketKey: string, inPlay = false): Promise<any> {
  const cacheKey = `odds_${inPlay ? "live" : "pre"}_${oddsEventId}_${marketKey}`;
  const cached = cache.get(cacheKey);
  const ttl = inPlay ? NBA_ODDS_LIVE_TTL : NBA_ODDS_TTL;
  if (isFresh(cached, ttl)) return cached!.data;

  // Quota errors are cached separately so we don't keep hitting the API
  const quotaCacheKey = `quota_exhausted`;
  const quotaCached = cache.get(quotaCacheKey);
  if (isFresh(quotaCached, QUOTA_TTL)) {
    console.warn("[Odds API Error] Quota still exhausted — checking last-known cache");
    const lastKnown = lastKnownRawOdds.get(cacheKey);
    if (lastKnown && Date.now() - lastKnown.timestamp < LAST_KNOWN_TTL) {
      const ageSec = Math.round((Date.now() - lastKnown.timestamp) / 1000);
      console.log(`[Odds Fallback] Serving stale data for ${cacheKey} (age: ${ageSec}s)`);
      return { ...lastKnown.data, _isDegraded: true };
    }
    return QUOTA_EXHAUSTED;
  }

  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY is not set");

  const inPlayParam = inPlay ? "&in_play=true" : "";
  const bookmakers = PROP_BOOKMAKERS;
  const url = `${BASE_URL}/events/${oddsEventId}/odds?apiKey=${ODDS_API_KEY}&regions=${PROP_REGIONS}&markets=${marketKey}&bookmakers=${bookmakers}&oddsFormat=american${inPlayParam}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const body = await res.text();
    // Detect quota exhaustion specifically and cache it to avoid hammering the API
    try {
      const parsed = JSON.parse(body);
      if (parsed.error_code === "OUT_OF_USAGE_CREDITS" || res.status === 401) {
        console.warn(`[Odds API Error] Quota exhausted — caching for 60 min`);
        cache.set(quotaCacheKey, { data: QUOTA_EXHAUSTED, timestamp: Date.now() });
        const lastKnown = lastKnownRawOdds.get(cacheKey);
        if (lastKnown && Date.now() - lastKnown.timestamp < LAST_KNOWN_TTL) {
          const ageSec = Math.round((Date.now() - lastKnown.timestamp) / 1000);
          console.log(`[Odds Fallback] Quota hit — serving stale data for ${cacheKey} (age: ${ageSec}s)`);
          return { ...lastKnown.data, _isDegraded: true };
        }
        return QUOTA_EXHAUSTED;
      }
    } catch (_) {}
    throw new Error(`Odds fetch failed: ${res.status} — ${body}`);
  }
  const data = await res.json();
  lastKnownRawOdds.set(cacheKey, { data, timestamp: Date.now() });
  cache.set(cacheKey, { data, timestamp: Date.now() });

  const books = (data.bookmakers ?? []).map((b: any) => b.key).join(", ");
  console.log(`[Odds] Fetched ${inPlay ? "LIVE" : "pre-game"} ${marketKey} odds for event ${oddsEventId}: bookmakers = ${books || "none"}`);

  // Audit second-half market ingestion when fetching in-play lines
  if (inPlay) {
    const bookmakersList: any[] = Array.isArray(data.bookmakers) ? data.bookmakers : [];
    const marketKeysFound: string[] = [];
    // Track how many bookmakers actually have the requested market key present with outcomes
    let booksWithRequestedMarket = 0;
    let totalPlayerOutcomes = 0;
    // Track validation rejections: markets found but with 0 outcomes (possible period encoding mismatch)
    let booksWithMarketButNoOutcomes = 0;
    // Collect sample period encoding from outcome descriptions/keys for diagnosis
    const periodEncodingSamples: string[] = [];
    for (const bm of bookmakersList) {
      for (const market of (bm.markets ?? [])) {
        if (!marketKeysFound.includes(market.key)) marketKeysFound.push(market.key);
        const outcomes: any[] = market.outcomes ?? [];
        const outcomeCount = outcomes.length;
        totalPlayerOutcomes += outcomeCount;
        if (market.key === marketKey) {
          if (outcomeCount > 0) {
            booksWithRequestedMarket++;
            // Sample period encoding: look for period/half hints in outcome descriptions or market key
            if (periodEncodingSamples.length < 3) {
              const sample = outcomes[0];
              const periodHint = sample?.description ?? sample?.name ?? market.key;
              if (periodHint && !periodEncodingSamples.includes(String(periodHint))) {
                periodEncodingSamples.push(String(periodHint));
              }
            }
          } else {
            booksWithMarketButNoOutcomes++;
          }
        }
      }
    }
    // Determine if the 2H market is genuinely absent from source vs present but empty
    const absentFromSource = bookmakersList.length === 0;
    const marketPresentWithData = booksWithRequestedMarket > 0;
    // Diagnose period encoding: does marketKey contain a 2h/half/period suffix vs not?
    const has2hSuffix = marketKey.includes("2h") || marketKey.includes("_half") || marketKey.includes("second");
    const periodEncodingNote = has2hSuffix
      ? `Market key has explicit 2H suffix ('${marketKey}') — check if source uses different period encoding`
      : `Market key has no period suffix ('${marketKey}') — in_play=true parameter used to request live/2H-adjusted lines`;
    const source = absentFromSource ? "absent_from_source"
      : marketPresentWithData ? "present_with_outcomes"
      : booksWithMarketButNoOutcomes > 0 ? "present_but_outcomes_empty_validation_reject"
      : "present_but_market_key_not_matched";
    console.log("[SECOND_HALF_MARKET_AUDIT]", {
      eventId: oddsEventId,
      marketKey,
      inPlay: true,
      bookmakerCount: bookmakersList.length,
      marketKeysFound,
      booksWithRequestedMarket,
      booksWithMarketButNoOutcomes,
      totalPlayerOutcomes,
      periodEncodingSamples,
      periodEncodingNote,
      absent: absentFromSource,
    });
    console.log("[SECOND_HALF_MARKET_RESULT]", {
      eventId: oddsEventId,
      marketKey,
      totalMarkets: booksWithRequestedMarket + booksWithMarketButNoOutcomes,
      secondHalfMarkets: booksWithRequestedMarket,
      absenceConfirmed: absentFromSource,
      eligible2HMarketCount: booksWithRequestedMarket,
      bookmakerCount: bookmakersList.length,
      validationRejections: booksWithMarketButNoOutcomes,
      totalPlayerOutcomes,
      source,
      periodEncodingNote,
      diagnosis: absentFromSource
        ? "No bookmakers returned for in-play fetch — 2H lines unavailable from source"
        : booksWithMarketButNoOutcomes > 0 && !marketPresentWithData
        ? `Market key '${marketKey}' found in ${booksWithMarketButNoOutcomes} book(s) but 0 outcomes — validation rejection or market suspended`
        : !marketPresentWithData
        ? `Bookmakers returned but market key '${marketKey}' not found — possible key mismatch (found keys: ${marketKeysFound.slice(0, 5).join(", ")})`
        : `${booksWithRequestedMarket} book(s) have live lines for '${marketKey}'`,
    });
  }

  return data;
}

// Return raw bookmaker/market data for diagnostics — used by /api/debug/odds-raw
export async function getRawOddsForDebug(oddsEventId: string): Promise<any> {
  // Debug endpoint fetches all markets for inspection — uses combined cache key
  const markets = Object.values(MARKET_MAP).join(",");
  const cacheKey = `odds_debug_${oddsEventId}`;
  const cached = cache.get(cacheKey);
  if (isFresh(cached, NBA_ODDS_TTL)) return cached!.data;
  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY is not set");
  const url = `${BASE_URL}/events/${oddsEventId}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&bookmakers=${PROP_BOOKMAKERS}&oddsFormat=american`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) { const body = await res.text(); throw new Error(`Odds fetch failed: ${res.status} — ${body}`); }
  const data = await res.json();
  cache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

// Expose the event resolver for the debug endpoint
export async function resolveEventForDebug(teamA: string, teamB: string): Promise<string | null> {
  return resolveOddsEventId(teamA, teamB);
}

// Normalize a player name: lowercase, strip suffixes (Jr., Sr., II, III, IV)
function normPlayerName(name: string): string {
  return name.toLowerCase()
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, "")
    .replace(/[^a-z\s]/g, "")
    .trim();
}

// Opening line cache — persists within the server process lifetime.
// Key: eventId:playerNorm:statType:bookmaker — Value: first line seen
const openingLineCache = new Map<string, number>();

// Last-known-good odds cache — stores the most recent successful getPlayerOdds result per event+player+market.
// Key: "eventId|playerNorm|statType" — Value: { data: books, timestamp: ms }
// Scoped to event ID so cross-game key collisions (same player in back-to-back games) cannot occur.
// TTL: 2 minutes (same as NBA_ODDS_TTL). Used as fallback when quota is exhausted or a transient error occurs.
const lastKnownOdds = new Map<string, { data: Record<string, OddsLine>; timestamp: number }>();
const LAST_KNOWN_TTL = NBA_ODDS_TTL; // 2 minutes (NBA)

// Per-game+market throttle — tracks the last time an Odds API fetch was issued per event+market.
// Prevents rapid re-fetches for the same game+market combination within a short window.
const lastGameApiCall = new Map<string, number>();
const GAME_API_THROTTLE_MS = 10_000; // 10 seconds

// Approximate win-probability change (%) per full point of line movement, by stat type.
// Based on NBA distribution widths: points spread wider so each point matters less.
const PROB_PER_POINT: Record<string, number> = {
  points: 3.5,     // a 1-pt drop in a ~24.5 pts line ≈ 3.5 pp swing
  rebounds: 5.0,
  assists: 5.5,
  steals: 8.0,
  blocks: 8.0,
  threes: 7.0,
  pts_reb_ast: 2.0,
  pts_reb: 2.5,
  pts_ast: 2.5,
  reb_ast: 3.5,
  stl_blk: 5.0,
};

export async function getPlayerOdds(
  oddsEventId: string,
  playerName: string,
  statType: string,
  inPlay = false
): Promise<PlayerOddsResult> {
  const marketKey = MARKET_MAP[statType];
  if (!marketKey) {
    return { isDegraded: false, quotaExhausted: false, books: {} };
  }

  const normName = normPlayerName(playerName);
  const lastKnownKey = `${oddsEventId}|${normName}|${statType}`;

  const makeDegraded = (books: Record<string, OddsLine>): PlayerOddsResult =>
    ({ isDegraded: true, quotaExhausted: false, books });

  // Cache-first pre-check: if a fresh last-known entry exists within the active TTL window,
  // return it immediately as non-degraded and skip the API call.
  // Use the raw cache TTL as the window (live: 30s, pre-game: 2min) so manual refresh
  // always gets fresh data once the underlying raw cache has expired.
  const cacheFirstTTL = inPlay ? NBA_ODDS_LIVE_TTL : NBA_ODDS_TTL;
  const lkFresh = lastKnownOdds.get(lastKnownKey);
  if (lkFresh && Date.now() - lkFresh.timestamp < cacheFirstTTL) {
    console.log(`[ODDS CACHE-FIRST] Fresh cache hit for ${playerName} (${statType}) — skipping API call`);
    pipelineLog("NBA", oddsEventId, "odds:cacheHit", { player: playerName, statType, books: Object.keys(lkFresh.data) });
    return { isDegraded: false, quotaExhausted: false, books: lkFresh.data };
  }

  // Per-game+market throttle: if a fetch was already issued for this event+market
  // within the throttle window, skip the API call and serve from last-known (degraded if present).
  const throttleKey = `${oddsEventId}:${marketKey}`;
  const lastCallTs = lastGameApiCall.get(throttleKey);
  if (lastCallTs !== undefined && Date.now() - lastCallTs < GAME_API_THROTTLE_MS) {
    const lk = lastKnownOdds.get(lastKnownKey);
    if (lk) {
      console.warn(`[ODDS THROTTLE] Event ${oddsEventId} throttled for ${playerName} (${statType}) — using last-known (degraded)`);
      return makeDegraded(lk.data);
    }
    console.warn(`[ODDS THROTTLE] Event ${oddsEventId} throttled for ${playerName} (${statType}) — no last-known data, returning empty`);
    return { isDegraded: false, quotaExhausted: false, books: {} };
  }

  // Stamp the throttle timestamp at issuance time so concurrent requests for the
  // same event+market are blocked even before the first request resolves.
  lastGameApiCall.set(throttleKey, Date.now());

  let oddsData: any;
  try {
    oddsData = await getRawOdds(oddsEventId, marketKey, inPlay);
  } catch (fetchErr) {
    // Transient network error — attempt last-known fallback
    const lk = lastKnownOdds.get(lastKnownKey);
    if (lk && Date.now() - lk.timestamp < LAST_KNOWN_TTL) {
      console.warn(`[ODDS FALLBACK] Network error for ${playerName} (${statType}) — using last-known line (degraded)`);
      return makeDegraded(lk.data);
    }
    throw fetchErr;
  }

  // Quota exhaustion — try last-known cache before giving up
  if (oddsData?._quotaExhausted) {
    const lk = lastKnownOdds.get(lastKnownKey);
    if (lk && Date.now() - lk.timestamp < LAST_KNOWN_TTL) {
      console.warn(`[ODDS FALLBACK] Quota exhausted for ${playerName} (${statType}) — using last-known line (degraded)`);
      return makeDegraded(lk.data);
    }
    return { isDegraded: false, quotaExhausted: true, books: {} };
  }

  const bookmakers: any[] = Array.isArray(oddsData?.bookmakers) ? oddsData.bookmakers : [];
  if (bookmakers.length === 0) {
    pipelineLog("NBA", oddsEventId, "odds:emptyBookmakers", { player: playerName, statType, hasData: !!oddsData });
    const lk = lastKnownOdds.get(lastKnownKey);
    if (lk && Date.now() - lk.timestamp < LAST_KNOWN_TTL) {
      console.warn(`[ODDS FALLBACK] Empty/malformed bookmakers for ${playerName} (${statType}) — using last-known line (degraded)`);
      return makeDegraded(lk.data);
    }
    return { isDegraded: false, quotaExhausted: false, books: {} };
  }

  const nameParts = normName.split(" ");
  const firstName = nameParts[0];
  const lastName = nameParts[nameParts.length - 1];
  const probPerPt = PROB_PER_POINT[statType] ?? 4.0;

  const books: Record<string, OddsLine> = {};
  let foundForAnyBook = false;

  for (const bookmaker of bookmakers) {
    const market = bookmaker.markets?.find((m: any) => m.key === marketKey);
    if (!market?.outcomes) continue;

    // Find outcomes matching this player
    const playerOutcomes = market.outcomes.filter((o: any) => {
      const desc = normPlayerName(o.description ?? o.name ?? "");
      return desc === normName
        || desc.includes(normName)
        || (desc.includes(firstName) && desc.includes(lastName));
    });

    const over = playerOutcomes.find((o: any) => o.name === "Over");
    const under = playerOutcomes.find((o: any) => o.name === "Under");

    if (over && under) {
      const currentLine: number = over.point;
      const cacheKey = `${oddsEventId}:${normName}:${statType}:${bookmaker.key}`;

      // Store first-seen line as session open
      if (!openingLineCache.has(cacheKey)) {
        openingLineCache.set(cacheKey, currentLine);
      }
      const openLine = openingLineCache.get(cacheKey)!;

      // lineMovement > 0 = line rose (harder to hit Over, easier Under)
      // lineMovement < 0 = line dropped (easier to hit Over, harder Under)
      const lineMovement = parseFloat((currentLine - openLine).toFixed(1));

      // edgeEstimate: probability swing in favor of Over vs session open
      //   Negative movement = line dropped = Over bettor gained that many probability points
      //   Positive movement = line rose    = Under bettor gained
      const edgeEstimate = parseFloat((-lineMovement * probPerPt).toFixed(1));

      books[bookmaker.key] = {
        line: currentLine,
        overOdds: over.price,
        underOdds: under.price,
        openLine,
        lineMovement,
        edgeEstimate,
      };
      foundForAnyBook = true;
    }
  }

  if (!foundForAnyBook) {
    // Log available players in the market to help diagnose name mismatches
    const sampleBook = oddsData.bookmakers?.[0];
    const sampleMarket = sampleBook?.markets?.find((m: any) => m.key === marketKey);
    if (sampleMarket?.outcomes) {
      const available = Array.from(new Set(
        sampleMarket.outcomes.map((o: any) => o.description ?? o.name).filter(Boolean)
      )).slice(0, 8);
      console.warn(`[Odds] No ${statType} line found for "${playerName}" — ${available.length ? `Available: ${available.join(", ")}` : "market has no outcomes (props not posted yet)"}`);
    } else {
      console.warn(`[Odds] No ${statType} line found for "${playerName}" — market key "${marketKey}" not found in response (may not be offered by these books)`);
    }
  }

  // Write successful result to last-known-good cache so future quota/network errors
  // can fall back to this data.
  if (foundForAnyBook) {
    lastKnownOdds.set(lastKnownKey, { data: books, timestamp: Date.now() });
  }

  pipelineLog("NBA", oddsEventId, "odds:result", { player: playerName, statType, books: Object.keys(books), isDegraded: false, foundForAnyBook });
  return { isDegraded: false, quotaExhausted: false, books };
}

// Fetch game-level spread and total for a given Odds API event.
// Uses a separate API call with markets=spreads,totals so it doesn't
// inflate the player-props response size.
const GAME_LINES_TTL = 5 * 60 * 1000; // 5 min

export async function getGameLines(
  oddsEventId: string
): Promise<{ spread: number; total: number; favorite: string } | null> {
  const cacheKey = `game_lines_${oddsEventId}`;
  const cached = cache.get(cacheKey);
  if (isFresh(cached, GAME_LINES_TTL)) return cached!.data;

  if (!ODDS_API_KEY) return null;

  try {
    const url = `${BASE_URL}/events/${oddsEventId}/odds?apiKey=${ODDS_API_KEY}&regions=${PROP_REGIONS}&markets=spreads,totals&bookmakers=${PROP_BOOKMAKERS}&oddsFormat=american`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`[Odds] getGameLines ${res.status} for event ${oddsEventId}`);
      return null;
    }
    const data = await res.json();
    const bookmakers: any[] = data.bookmakers ?? [];

    let spread: number | null = null;
    let total: number | null = null;
    let favorite = "";

    // Try each bookmaker until we get both values
    for (const bk of bookmakers) {
      if (spread === null) {
        const spreadsMarket = (bk.markets ?? []).find((m: any) => m.key === "spreads");
        if (spreadsMarket?.outcomes?.length >= 2) {
          // The favorite is the outcome with a negative spread (point < 0)
          const favOutcome = spreadsMarket.outcomes.find((o: any) => o.point < 0);
          if (favOutcome) {
            spread = Math.abs(favOutcome.point as number);
            favorite = favOutcome.name as string;
          } else {
            // Pick the lower absolute spread if neither is negative (pick 'em)
            const sorted = [...spreadsMarket.outcomes].sort((a: any, b: any) => Math.abs(a.point) - Math.abs(b.point));
            spread = Math.abs(sorted[0].point as number);
            favorite = sorted[0].name as string;
          }
        }
      }
      if (total === null) {
        const totalsMarket = (bk.markets ?? []).find((m: any) => m.key === "totals");
        if (totalsMarket?.outcomes?.length >= 1) {
          const overOutcome = totalsMarket.outcomes.find((o: any) => o.name === "Over");
          if (overOutcome) total = overOutcome.point as number;
        }
      }
      if (spread !== null && total !== null) break;
    }

    if (spread === null || total === null) {
      cache.set(cacheKey, { data: null, timestamp: Date.now() });
      return null;
    }

    const result = { spread, total, favorite };
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log(`[Odds] Game lines for ${oddsEventId}: ${favorite} -${spread}, O/U ${total}`);
    return result;
  } catch (err) {
    console.warn("[Odds] getGameLines error:", err);
    return null;
  }
}

// ─── SGO NBA Player Props ─────────────────────────────────────────────────────
// Uses the SGO (sportsgameodds.com) API as a third-source fallback for player lines.
// SGO often carries props for role players that DK/FD don't post.

const SGO_NBA_EVENTS_TTL = 4 * 60 * 1000; // 4 min cache for SGO NBA events

// Stat-type → SGO odds key prefix (SGO uses {stat}-{playerSlug}-ou-{side} format)
const SGO_STAT_KEY: Record<string, string> = {
  points:      "points",
  rebounds:    "rebounds",
  assists:     "assists",
  steals:      "steals",
  blocks:      "blocks",
  threes:      "threes-made",
  pts_reb_ast: "points-rebounds-assists",
  pts_reb:     "points-rebounds",
  pts_ast:     "points-assists",
  reb_ast:     "rebounds-assists",
  stl_blk:     "steals-blocks",
};

// How long to suppress SGO retries after a rate-limit or error (10 min)
const SGO_BACKOFF_TTL = 10 * 60 * 1000;

async function getSGONBAEvents(): Promise<any[]> {
  const cacheKey = "sgo_nba_events";
  const backoffKey = "sgo_nba_backoff";
  const cached = cache.get(cacheKey);
  if (isFresh(cached, SGO_NBA_EVENTS_TTL)) return cached!.data;

  // If we hit a rate-limit recently, don't retry until backoff expires
  if (isFresh(cache.get(backoffKey), SGO_BACKOFF_TTL)) return [];

  if (!SGO_API_KEY) return [];
  try {
    const url = "https://api.sportsgameodds.com/v2/events?leagueID=NBA&oddsAvailable=true&limit=30";
    const res = await fetch(url, {
      headers: { "X-Api-Key": SGO_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[SGO NBA] ${res.status} — backing off 10 min`);
      cache.set(backoffKey, { data: true, timestamp: Date.now() });
      return [];
    }
    const data = await res.json() as any;
    const events: any[] = data.data ?? [];
    cache.set(cacheKey, { data: events, timestamp: Date.now() });
    // Log sample odds keys from first event to show what player props are available
    if (events.length > 0) {
      const sampleKeys = Object.keys(events[0].odds ?? {}).slice(0, 10);
      console.log(`[SGO NBA] ${events.length} events. Sample odds keys: ${sampleKeys.join(", ")}`);
    }
    return events;
  } catch (err) {
    console.warn("[SGO NBA] error — backing off 10 min:", err);
    cache.set(backoffKey, { data: true, timestamp: Date.now() });
    return [];
  }
}

// Try to get a player line from SGO for a given game + stat type.
// Returns the over line (numeric) or null if not found.
export async function getSGOPlayerLine(
  homeTeam: string,
  awayTeam: string,
  playerName: string,
  statType: string
): Promise<number | null> {
  if (!SGO_API_KEY) return null;
  const statKey = SGO_STAT_KEY[statType];
  if (!statKey) return null;

  try {
    const events = await getSGONBAEvents();

    // Match event by team name
    const homeNorm = normTeam(TEAM_FULL_NAMES[homeTeam.toUpperCase()] ?? homeTeam);
    const awayNorm = normTeam(TEAM_FULL_NAMES[awayTeam.toUpperCase()] ?? awayTeam);

    const event = events.find((ev: any) => {
      const evHome = normTeam(ev.teams?.home?.names?.long ?? "");
      const evAway = normTeam(ev.teams?.away?.names?.long ?? "");
      return (teamsMatch(homeNorm, evHome) && teamsMatch(awayNorm, evAway))
          || (teamsMatch(homeNorm, evAway) && teamsMatch(awayNorm, evHome));
    });

    if (!event) return null;

    const odds = event.odds ?? {};
    const normName = normPlayerName(playerName);
    const nameParts = normName.split(" ");
    const firstName = nameParts[0] ?? "";
    const lastName  = nameParts[nameParts.length - 1] ?? "";

    // SGO player prop keys are like: player-{firstName}-{lastName}-{statKey}-ou-over
    // Try several slug formats
    const slugFull  = `${firstName}-${lastName}`.replace(/\s+/g, "-");
    const slugLast  = lastName;

    let line: number | null = null;

    for (const [key, val] of Object.entries(odds)) {
      if (typeof val !== "object" || val == null) continue;
      const k = key.toLowerCase();
      if (!k.includes(statKey)) continue;
      if (!k.includes("ou")) continue;
      if (!k.includes("over")) continue;
      // Check if this key mentions the player by name parts
      if (!k.includes(slugFull) && !k.includes(slugLast)) continue;

      const overVal = (val as any)?.over ?? (val as any)?.point ?? (val as any)?.line;
      if (typeof overVal === "number") {
        line = overVal;
        console.log(`[SGO NBA] Found ${statType} line for "${playerName}": ${line} (key: ${key})`);
        break;
      }
    }

    // If no match found, log available player keys for this stat to aid debugging
    if (line === null) {
      const statKeys = Object.keys(odds).filter(k => k.toLowerCase().includes(statKey) && k.includes("ou-over")).slice(0, 6);
      if (statKeys.length > 0) {
        console.log(`[SGO NBA] No "${playerName}" line for ${statType}. Sample keys: ${statKeys.join(", ")}`);
      }
    }

    return line;
  } catch (err) {
    console.warn("[SGO NBA] getSGOPlayerLine error:", err);
    return null;
  }
}

// ─── MLB Odds Support ────────────────────────────────────────────────────────

const MLB_BASE_URL = "https://api.the-odds-api.com/v4/sports/baseball_mlb";

export const MLB_TEAM_FULL_NAMES: Record<string, string> = {
  ARI: "Arizona Diamondbacks",
  ATL: "Atlanta Braves",
  BAL: "Baltimore Orioles",
  BOS: "Boston Red Sox",
  CHC: "Chicago Cubs",
  CHW: "Chicago White Sox",
  CIN: "Cincinnati Reds",
  CLE: "Cleveland Guardians",
  COL: "Colorado Rockies",
  DET: "Detroit Tigers",
  HOU: "Houston Astros",
  KC: "Kansas City Royals",
  KCR: "Kansas City Royals",
  LAA: "Los Angeles Angels",
  LAD: "Los Angeles Dodgers",
  MIA: "Miami Marlins",
  MIL: "Milwaukee Brewers",
  MIN: "Minnesota Twins",
  NYM: "New York Mets",
  NYY: "New York Yankees",
  OAK: "Oakland Athletics",
  PHI: "Philadelphia Phillies",
  PIT: "Pittsburgh Pirates",
  SD: "San Diego Padres",
  SDP: "San Diego Padres",
  SF: "San Francisco Giants",
  SFG: "San Francisco Giants",
  SEA: "Seattle Mariners",
  STL: "St. Louis Cardinals",
  TB: "Tampa Bay Rays",
  TBR: "Tampa Bay Rays",
  TEX: "Texas Rangers",
  TOR: "Toronto Blue Jays",
  WSH: "Washington Nationals",
  WAS: "Washington Nationals",
};

const MLB_MARKET_MAP: Record<string, string> = {
  hits: "batter_hits",
  total_bases: "batter_total_bases",
  batter_strikeouts: "batter_strikeouts",
  batter_k: "batter_strikeouts",
  home_runs: "batter_home_runs",
  hrr: "",
  pitcher_strikeouts: "pitcher_strikeouts",
  pitcher_k: "pitcher_strikeouts",
  walks_allowed: "pitcher_walks",
  hits_allowed: "pitcher_hits_allowed",
};

async function getMLBEvents(): Promise<any[]> {
  const cacheKey = "mlb_events_list";
  const cached = cache.get(cacheKey);
  if (isFresh(cached, EVENTS_TTL)) return cached!.data;
  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY is not set");

  const res = await fetch(
    `${MLB_BASE_URL}/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MLB events fetch failed: ${res.status} — ${body}`);
  }
  const data = await res.json();
  cache.set(cacheKey, { data, timestamp: Date.now() });
  console.log(`[Odds] Fetched ${data.length} MLB events`);
  return data;
}

export async function resolveMLBOddsEventId(
  playerTeamInput: string,
  opponentTeamInput: string
): Promise<string | null> {
  try {
    const events = await getMLBEvents();
    const playerTeam = MLB_TEAM_FULL_NAMES[playerTeamInput.toUpperCase()] ?? playerTeamInput;
    const opponentTeam = MLB_TEAM_FULL_NAMES[opponentTeamInput.toUpperCase()] ?? opponentTeamInput;

    for (const ev of events) {
      const evHome: string = ev.home_team ?? "";
      const evAway: string = ev.away_team ?? "";
      const playerIsHome = teamsMatch(playerTeam, evHome) && teamsMatch(opponentTeam, evAway);
      const playerIsAway = teamsMatch(playerTeam, evAway) && teamsMatch(opponentTeam, evHome);
      if (playerIsHome || playerIsAway) {
        console.log(`[Odds MLB] Matched event: ${ev.away_team} @ ${ev.home_team} → ${ev.id}`);
        return ev.id as string;
      }
    }

    for (const ev of events) {
      if (teamsMatch(playerTeam, ev.home_team ?? "") || teamsMatch(playerTeam, ev.away_team ?? "")) {
        console.log(`[Odds MLB] Fuzzy team match: ${ev.away_team} @ ${ev.home_team} → ${ev.id}`);
        return ev.id as string;
      }
    }

    console.warn(`[Odds MLB] No event found for ${playerTeam} vs ${opponentTeam}`);
    return null;
  } catch (err) {
    console.error("[Odds MLB] resolveMLBOddsEventId error:", err);
    return null;
  }
}

async function getMLBRawOdds(oddsEventId: string, marketKey: string, inPlay = false): Promise<any> {
  const cacheKey = `mlb_odds_${inPlay ? "live" : "pre"}_${oddsEventId}_${marketKey}`;
  const cached = cache.get(cacheKey);
  const ttl = inPlay ? MLB_ODDS_LIVE_TTL : MLB_ODDS_TTL;
  if (isFresh(cached, ttl)) return cached!.data;

  const quotaCacheKey = `quota_exhausted`;
  const quotaCached = cache.get(quotaCacheKey);
  if (isFresh(quotaCached, QUOTA_TTL)) {
    console.warn("[MLB Odds] Quota still exhausted — checking last-known raw cache");
    const lastKnown = lastKnownRawOdds.get(cacheKey);
    if (lastKnown && Date.now() - lastKnown.timestamp < MLB_LAST_KNOWN_TTL) {
      const ageSec = Math.round((Date.now() - lastKnown.timestamp) / 1000);
      console.log(`[MLB Odds Fallback] Serving stale raw data for ${cacheKey} (age: ${ageSec}s)`);
      return { ...lastKnown.data, _isDegraded: true };
    }
    return QUOTA_EXHAUSTED;
  }

  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY is not set");

  const inPlayParam = inPlay ? "&in_play=true" : "";
  const bookmakers = "draftkings,fanduel,hardrockbet";
  const url = `${MLB_BASE_URL}/events/${oddsEventId}/odds?apiKey=${ODDS_API_KEY}&regions=${PROP_REGIONS}&markets=${marketKey}&bookmakers=${bookmakers}&oddsFormat=american${inPlayParam}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (fetchErr) {
    console.warn(`[MLB Odds] Network error — checking last-known raw cache for ${cacheKey}`);
    const lastKnown = lastKnownRawOdds.get(cacheKey);
    if (lastKnown && Date.now() - lastKnown.timestamp < MLB_LAST_KNOWN_TTL) {
      const ageSec = Math.round((Date.now() - lastKnown.timestamp) / 1000);
      console.log(`[MLB Odds Fallback] Network error — stale data for ${cacheKey} (age: ${ageSec}s)`);
      return { ...lastKnown.data, _isDegraded: true };
    }
    throw fetchErr;
  }

  if (!res.ok) {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body);
      if (parsed.error_code === "OUT_OF_USAGE_CREDITS" || res.status === 401) {
        console.warn(`[MLB Odds] Quota exhausted — caching for 60 min`);
        cache.set(quotaCacheKey, { data: QUOTA_EXHAUSTED, timestamp: Date.now() });
        const lastKnown = lastKnownRawOdds.get(cacheKey);
        if (lastKnown && Date.now() - lastKnown.timestamp < MLB_LAST_KNOWN_TTL) {
          const ageSec = Math.round((Date.now() - lastKnown.timestamp) / 1000);
          console.log(`[MLB Odds Fallback] Quota hit — stale data for ${cacheKey} (age: ${ageSec}s)`);
          return { ...lastKnown.data, _isDegraded: true };
        }
        return QUOTA_EXHAUSTED;
      }
    } catch (_) {}
    throw new Error(`MLB odds fetch failed: ${res.status} — ${body}`);
  }
  const data = await res.json();
  cache.set(cacheKey, { data, timestamp: Date.now() });
  lastKnownRawOdds.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

type MLBOddsResult = Record<string, { line: number; overOdds: number; underOdds: number }> & { _quotaExhausted?: boolean; _isDegraded?: boolean };

/** Create a degraded copy of an MLBOddsResult (stale-cache path). Uses Object.assign
 *  rather than spread to avoid TypeScript index-signature conflict with the boolean flag. */
function makeDegradedMLBResult(data: MLBOddsResult): MLBOddsResult {
  const copy: MLBOddsResult = Object.assign({}, data);
  copy._isDegraded = true;
  return copy;
}

// Last-known-good MLB player odds cache (normalized level)
// Key: "oddsEventId|playerNorm|statType" — mirrors the NBA lastKnownOdds pattern
const lastKnownMLBOdds = new Map<string, { data: MLBOddsResult; timestamp: number }>();
const MLB_LAST_KNOWN_TTL = MLB_ODDS_TTL; // 5 minutes (MLB)

export async function getMLBPlayerOdds(
  oddsEventId: string,
  playerName: string,
  statType: string,
  inPlay = false
): Promise<MLBOddsResult> {
  const normName = normPlayerName(playerName);
  const lastKnownKey = `${oddsEventId}|${normName}|${statType}`;

  const marketKey = MLB_MARKET_MAP[statType];
  if (!marketKey) return {};

  let oddsData: any;
  try {
    oddsData = await getMLBRawOdds(oddsEventId, marketKey, inPlay);
  } catch (fetchErr) {
    const lk = lastKnownMLBOdds.get(lastKnownKey);
    if (lk && Date.now() - lk.timestamp < MLB_LAST_KNOWN_TTL) {
      console.warn(`[MLB Odds Fallback] Network error for ${playerName} (${statType}) — using last-known (degraded)`);
      return makeDegradedMLBResult(lk.data);
    }
    throw fetchErr;
  }

  if (oddsData?._quotaExhausted) {
    const lk = lastKnownMLBOdds.get(lastKnownKey);
    if (lk && Date.now() - lk.timestamp < MLB_LAST_KNOWN_TTL) {
      console.warn(`[MLB Odds Fallback] Quota exhausted for ${playerName} (${statType}) — using last-known (degraded)`);
      return makeDegradedMLBResult(lk.data);
    }
    const exhausted: MLBOddsResult = {};
    exhausted._quotaExhausted = true;
    return exhausted;
  }

  // _isDegraded set by getMLBRawOdds when serving raw stale data
  const isDegradedRaw = !!(oddsData?._isDegraded);

  const mlbBookmakers: any[] = Array.isArray(oddsData?.bookmakers) ? oddsData.bookmakers : [];
  if (mlbBookmakers.length === 0) {
    const lk = lastKnownMLBOdds.get(lastKnownKey);
    if (lk && Date.now() - lk.timestamp < MLB_LAST_KNOWN_TTL) {
      console.warn(`[MLB Odds Fallback] Empty/malformed bookmakers for ${playerName} (${statType}) — using last-known (degraded)`);
      return makeDegradedMLBResult(lk.data);
    }
    return {};
  }

  const nameParts = normName.split(" ");
  const firstName = nameParts[0];
  const lastName = nameParts[nameParts.length - 1];

  const result: MLBOddsResult = {};

  for (const bookmaker of mlbBookmakers) {
    // Use flexible key matching instead of exact equality
    const market = (bookmaker.markets ?? []).find(
      (m: any) => m.key === marketKey || isMLBPropKey(m.key ?? "", statType)
    );
    if (!market?.outcomes) continue;

    const playerOutcomes = market.outcomes.filter((o: any) => {
      const desc = normPlayerName(o.description ?? o.name ?? "");
      return desc === normName
        || desc.includes(normName)
        || (desc.includes(firstName) && desc.includes(lastName));
    });

    const over = playerOutcomes.find((o: any) => o.name === "Over");
    const under = playerOutcomes.find((o: any) => o.name === "Under");

    if (over && under) {
      result[bookmaker.key] = {
        line: over.point,
        overOdds: over.price,
        underOdds: under.price,
      };
    }
  }

  if (Object.keys(result).filter(k => !k.startsWith("_")).length > 0) {
    lastKnownMLBOdds.set(lastKnownKey, { data: result, timestamp: Date.now() });
  }

  if (isDegradedRaw) result._isDegraded = true;
  return result;
}

// Bust the event cache (call after a game starts or for testing)
export function bustEventsCache(): void {
  cache.delete("events_list");
  cache.delete("sgo_nba_events");
  cache.delete("mlb_events_list");
}

// Expose opening line cache size for diagnostics
export function getOpeningLineCacheSize(): number {
  return openingLineCache.size;
}
