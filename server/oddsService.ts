import { updateOddsHealth } from "./services/dataHealth";
import { writeOddsSnapshot } from "./odds/oddsCache";
import { recordApiFetch, recordApiFailure, logFetch } from "./odds/oddsDiagnostics";

const ODDS_API_KEYS = [
  process.env.ODDS_API_KEY,
  process.env.ODDS_API_KEY_2,
  process.env.ODDS_API_KEY_3,
  process.env.ODDS_API_KEY_4,
].filter(Boolean) as string[];

let activeKeyIndex = 0;
// Map keyIndex -> earliest timestamp (ms) at which the key is usable again.
// Lazy-evicted on read so we don't depend on setTimeout firing exactly. Using
// a per-key expiry (rather than a plain Set + delete-on-timer) prevents a
// short 429 cool-down (10s) from prematurely clearing a long quota/auth
// exhaustion (60min) if both events hit the same key in sequence.
const exhaustedKeys = new Map<number, number>();

function isKeyExhausted(keyIndex: number): boolean {
  const expiresAt = exhaustedKeys.get(keyIndex);
  if (expiresAt === undefined) return false;
  if (Date.now() >= expiresAt) {
    exhaustedKeys.delete(keyIndex);
    return false;
  }
  return true;
}

/** Apply an exhaustion expiry to a key, but never SHORTEN an existing one. */
function setKeyExhaustedUntil(keyIndex: number, expiresAt: number) {
  const current = exhaustedKeys.get(keyIndex);
  if (current !== undefined && current >= expiresAt) return;
  exhaustedKeys.set(keyIndex, expiresAt);
}

export function getOddsApiKey(): string | undefined {
  if (ODDS_API_KEYS.length === 0) return undefined;
  if (!isKeyExhausted(activeKeyIndex)) return ODDS_API_KEYS[activeKeyIndex];
  for (let i = 0; i < ODDS_API_KEYS.length; i++) {
    if (!isKeyExhausted(i)) {
      activeKeyIndex = i;
      console.log(`[Odds API] Rotated to key ${i + 1}/${ODDS_API_KEYS.length}`);
      return ODDS_API_KEYS[i];
    }
  }
  return ODDS_API_KEYS[activeKeyIndex];
}

function markKeyExhausted(keyIndex: number) {
  setKeyExhaustedUntil(keyIndex, Date.now() + 60 * 60 * 1000);
  console.warn(`[Odds API] Key ${keyIndex + 1}/${ODDS_API_KEYS.length} marked exhausted (60-min)`);
}

// Short cool-down for 429 EXCEEDED_FREQ_LIMIT — that's a per-second/minute
// frequency cap, not a monthly quota burn, so we only cool the key for a few
// seconds and rotate to the next one immediately. This is what fixes the
// "no_book_line" symptom that was forcing manual MLB resets: previously a
// single 429 would just throw, leaving the orchestrator with no line and the
// active key never advancing. Uses setKeyExhaustedUntil so an existing
// longer exhaustion (quota/auth) is never shortened by a transient 429.
function markKeyRateLimited(keyIndex: number, coolMs: number = 10_000) {
  setKeyExhaustedUntil(keyIndex, Date.now() + coolMs);
  console.warn(`[Odds API] Key ${keyIndex + 1}/${ODDS_API_KEYS.length} 429 frequency-limited — cooling ${Math.round(coolMs / 1000)}s, rotating`);
}

export function getOddsKeyStatus(): { totalKeys: number; activeKeyIndex: number; exhaustedKeys: number[] } {
  const now = Date.now();
  const live: number[] = [];
  exhaustedKeys.forEach((expiresAt, idx) => {
    if (expiresAt > now) live.push(idx);
    else exhaustedKeys.delete(idx);
  });
  return {
    totalKeys: ODDS_API_KEYS.length,
    activeKeyIndex,
    exhaustedKeys: live,
  };
}

const SGO_API_KEY  = process.env.SGO_API_KEY;
const BASE_URL = "https://api.the-odds-api.com/v4/sports/basketball_nba";

const PROP_BOOKMAKERS = "draftkings,fanduel,hardrockbet,prizepicks,underdogfantasy,betmgm,betrivers,espnbet,betonlineag,bovada,williamhill_us";
const PROP_BOOKMAKERS_SET = new Set(PROP_BOOKMAKERS.split(","));
const PROP_REGIONS = "us";
const BOOKMAKER_STALE_MS = 10 * 60 * 1000;

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
  | { isDegraded: false; quotaExhausted: false; books: Record<string, OddsLine>; fetchedAt: number }
  | { isDegraded: true;  quotaExhausted: false; books: Record<string, OddsLine>; fetchedAt: number }
  | { isDegraded: false; quotaExhausted: true;  books: Record<string, never>;    fetchedAt: number };

// Options for getPlayerOdds. The legacy boolean form (true/false) is preserved
// for backward compatibility — pre-game and live signals callers still pass a
// boolean. The new options form is required for halftime, which must guarantee
// fresh live 2H lines and refuse every degraded-fallback path.
export type GetPlayerOddsOptions = {
  inPlay?: boolean;
  /** Strict mode: refuse cache-first, throttle, quota, network, and empty-bookmaker fallbacks. */
  strictLive?: boolean;
  /** Maximum bookmaker last_update age (ms). Default = NBA_ODDS_LIVE_TTL when inPlay, else NBA_ODDS_TTL. */
  maxAgeMs?: number;
  allowDegraded?: boolean;
  allowCacheFirst?: boolean;
  allowThrottleFallback?: boolean;
};

const cache = new Map<string, CacheEntry>();
const EVENTS_TTL = 3 * 60 * 1000;       // 3 min (shorter so fresh games appear quickly)
// NBA-specific TTLs (reduced for near-real-time line updates)
const NBA_ODDS_TTL = 2 * 60 * 1000;     // 2 min — pre-game line raw cache (NBA)
const NBA_ODDS_LIVE_TTL = 30 * 1000;    // 30 sec — in-play line raw cache for halftime freshness (NBA)
const MLB_ODDS_TTL = 2 * 60 * 1000;     // 2 min — pre-game line raw cache (MLB, matched to NBA)
const MLB_ODDS_LIVE_TTL = 30 * 1000;    // 30 sec — in-play line raw cache (MLB, matched to NBA)

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

// Fetch and cache the full list of NBA events from The Odds API.
// Rotates across all configured keys on 401 (DEACTIVATED_KEY / auth) and 429
// (frequency-limit) so a single dead key can't blank the entire UI when other
// keys are healthy. Mirrors the rotation behavior of the prop-fetch path.
async function getEvents(): Promise<any[]> {
  const cacheKey = "events_list";
  const cached = cache.get(cacheKey);
  if (isFresh(cached, EVENTS_TTL)) return cached!.data;

  if (ODDS_API_KEYS.length === 0) throw new Error("ODDS_API_KEY is not set");

  let lastErr: string = "no_keys";
  const maxAttempts = ODDS_API_KEYS.length;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const apiKey = getOddsApiKey();
    if (!apiKey) { lastErr = "no_active_key"; break; }
    const usedKeyIndex = activeKeyIndex;
    try {
      const res = await fetch(
        `${BASE_URL}/events?apiKey=${apiKey}&dateFormat=iso`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const data = await res.json();
        cache.set(cacheKey, { data, timestamp: Date.now() });
        console.log(`[Odds] Fetched ${data.length} NBA events (key ${usedKeyIndex + 1}/${ODDS_API_KEYS.length})`);
        return data;
      }
      const body = await res.text();
      lastErr = `${res.status} — ${body.slice(0, 200)}`;
      if (res.status === 401) {
        console.warn(`[Odds API] events: key ${usedKeyIndex + 1} got 401 — cooling 60min and rotating`);
        markKeyExhausted(usedKeyIndex);
        continue;
      }
      if (res.status === 429) {
        markKeyRateLimited(usedKeyIndex);
        continue;
      }
      throw new Error(`Events fetch failed: ${lastErr}`);
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
      if (attempt === maxAttempts - 1) throw err;
    }
  }
  throw new Error(`Events fetch failed: all ${ODDS_API_KEYS.length} keys returned errors (${lastErr})`);
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
  if (s === "pitcherouts" || s === "pitcher_outs") return k.includes("pitcherout") || k.includes("pitouts") || (k.includes("outs") && k.includes("pitcher")) || k.includes("recording") || k.includes("totalouts");
  if (s === "hrr" || s === "hitsrunsrbis" || s === "hits_runs_rbis") return k.includes("hitsrunsrbi") || k.includes("hrr") || (k.includes("hit") && k.includes("run") && k.includes("rbi"));
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

  const triedKeys = new Set<number>();
  const maxAttempts = ODDS_API_KEYS.length;
  let sawQuotaExhaustion = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const apiKey = getOddsApiKey();
    if (!apiKey) throw new Error("ODDS_API_KEY is not set");
    const usedKeyIndex = activeKeyIndex;

    if (triedKeys.has(usedKeyIndex)) break;
    triedKeys.add(usedKeyIndex);

    const quotaCacheKey = `quota_exhausted_${usedKeyIndex}`;
    const quotaCached = cache.get(quotaCacheKey);
    if (isFresh(quotaCached, QUOTA_TTL)) {
      sawQuotaExhaustion = true;
      markKeyExhausted(usedKeyIndex);
      continue;
    }

    const inPlayParam = inPlay ? "&in_play=true" : "";
    const bookmakers = PROP_BOOKMAKERS;
    const url = `${BASE_URL}/events/${oddsEventId}/odds?apiKey=${apiKey}&regions=${PROP_REGIONS}&markets=${marketKey}&bookmakers=${bookmakers}&oddsFormat=american${inPlayParam}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const body = await res.text();
      try {
        const parsed = JSON.parse(body);
        if (parsed.error_code === "OUT_OF_USAGE_CREDITS") {
          const remaining = res.headers.get("x-requests-remaining");
          console.warn(`[Odds API Error] Key ${usedKeyIndex + 1} quota CONFIRMED exhausted (error_code=OUT_OF_USAGE_CREDITS, remaining=${remaining})`);
          updateOddsHealth({ success: false, error: "quota_exhausted", keyIndex: usedKeyIndex, requestsRemaining: 0 });
          cache.set(quotaCacheKey, { data: QUOTA_EXHAUSTED, timestamp: Date.now() });
          markKeyExhausted(usedKeyIndex);
          sawQuotaExhaustion = true;
          continue;
        }
        if (res.status === 401) {
          console.warn(`[Odds API Error] Key ${usedKeyIndex + 1} got 401 (auth error, NOT marking as exhausted): ${parsed.message ?? body.slice(0, 200)}`);
          updateOddsHealth({ success: false, error: `auth_error_401`, keyIndex: usedKeyIndex });
          markKeyExhausted(usedKeyIndex);
          continue;
        }
        if (res.status === 429 || parsed.error_code === "EXCEEDED_FREQ_LIMIT") {
          updateOddsHealth({ success: false, error: "rate_limited_429", keyIndex: usedKeyIndex });
          markKeyRateLimited(usedKeyIndex);
          continue;
        }
      } catch (_) {
        if (res.status === 429) {
          updateOddsHealth({ success: false, error: "rate_limited_429", keyIndex: usedKeyIndex });
          markKeyRateLimited(usedKeyIndex);
          continue;
        }
      }
      updateOddsHealth({ success: false, error: `fetch_failed_${res.status}`, keyIndex: usedKeyIndex });
      throw new Error(`Odds fetch failed: ${res.status} — ${body}`);
    }
    const data = await res.json();
    lastKnownRawOdds.set(cacheKey, { data, timestamp: Date.now() });
    cache.set(cacheKey, { data, timestamp: Date.now() });

    const requestsRemaining = res.headers.get("x-requests-remaining");
    if (requestsRemaining != null) {
      const rem = parseInt(requestsRemaining);
      if (rem < 1000) console.warn(`[Odds API] Key ${usedKeyIndex + 1} low credits: ${rem} remaining`);
    }
    updateOddsHealth({
      success: true,
      requestsRemaining: requestsRemaining ? parseInt(requestsRemaining) : undefined,
      keyIndex: usedKeyIndex,
    });

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

  const lastKnown = lastKnownRawOdds.get(cacheKey);
  if (sawQuotaExhaustion) {
    console.warn("[Odds API] All keys quota-exhausted — checking last-known cache");
    if (lastKnown && Date.now() - lastKnown.timestamp < LAST_KNOWN_TTL) {
      const ageSec = Math.round((Date.now() - lastKnown.timestamp) / 1000);
      console.log(`[Odds Fallback] Serving stale data for ${cacheKey} (age: ${ageSec}s)`);
      return { ...lastKnown.data, _isDegraded: true };
    }
    return QUOTA_EXHAUSTED;
  }
  console.warn("[Odds API] All keys failed (auth/network) — serving stale if available");
  if (lastKnown && Date.now() - lastKnown.timestamp < LAST_KNOWN_TTL) {
    return { ...lastKnown.data, _isDegraded: true };
  }
  throw new Error(`Odds fetch failed: all ${ODDS_API_KEYS.length} keys returned errors`);
}

export async function preWarmOddsCache(
  oddsEventId: string,
  statTypes: string[],
  inPlay = false
): Promise<void> {
  const uniqueMarketKeys = Array.from(new Set(
    statTypes.map(st => MARKET_MAP[st]).filter(Boolean)
  ));
  const results = await Promise.allSettled(
    uniqueMarketKeys.map(mk => getRawOdds(oddsEventId, mk, inPlay))
  );
  const fetched = results.filter(r => r.status === "fulfilled").length;
  const failed = results.filter(r => r.status === "rejected").length;
  console.log(`[ODDS PRE-WARM] eventId=${oddsEventId} inPlay=${inPlay} markets=${uniqueMarketKeys.length} fetched=${fetched} failed=${failed}`);
}

// Return raw bookmaker/market data for diagnostics — used by /api/debug/odds-raw
export async function getRawOddsForDebug(oddsEventId: string): Promise<any> {
  // Debug endpoint fetches all markets for inspection — uses combined cache key
  const markets = Object.values(MARKET_MAP).join(",");
  const cacheKey = `odds_debug_${oddsEventId}`;
  const cached = cache.get(cacheKey);
  if (isFresh(cached, NBA_ODDS_TTL)) return cached!.data;
  const dApiKey = getOddsApiKey();
  if (!dApiKey) throw new Error("ODDS_API_KEY is not set");
  const url = `${BASE_URL}/events/${oddsEventId}/odds?apiKey=${dApiKey}&regions=us&markets=${markets}&bookmakers=${PROP_BOOKMAKERS}&oddsFormat=american`;
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
  // NFD-decompose then strip combining diacritics so accented characters fold
  // to their ASCII equivalents (e.g. "Rodríguez" → "rodriguez") BEFORE the
  // ASCII-only filter runs. Without this, the í/é/ñ/etc. were being deleted
  // entirely, producing un-matchable names like "rodrguez" that never lined
  // up against the Odds API's typically-unaccented outcome descriptions.
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
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
const LAST_KNOWN_TTL = NBA_ODDS_LIVE_TTL; // 30 sec — NBA needs freshest lines for 2H plays

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
  optionsOrInPlay: boolean | GetPlayerOddsOptions = false
): Promise<PlayerOddsResult> {
  // Normalize legacy boolean → options object. Defaults preserve previous
  // behavior for every existing caller (cache-first allowed, degraded allowed,
  // throttle fallback allowed). Halftime callers pass an options object with
  // strictLive=true to refuse every fallback path.
  const options = typeof optionsOrInPlay === "boolean"
    ? {
        inPlay: optionsOrInPlay,
        strictLive: false,
        maxAgeMs: optionsOrInPlay ? NBA_ODDS_LIVE_TTL : NBA_ODDS_TTL,
        allowDegraded: true,
        allowCacheFirst: true,
        allowThrottleFallback: true,
      }
    : {
        inPlay: optionsOrInPlay.inPlay ?? false,
        strictLive: optionsOrInPlay.strictLive ?? false,
        maxAgeMs: optionsOrInPlay.maxAgeMs ?? ((optionsOrInPlay.inPlay ?? false) ? NBA_ODDS_LIVE_TTL : NBA_ODDS_TTL),
        allowDegraded: optionsOrInPlay.allowDegraded ?? !(optionsOrInPlay.strictLive ?? false),
        allowCacheFirst: optionsOrInPlay.allowCacheFirst ?? !(optionsOrInPlay.strictLive ?? false),
        allowThrottleFallback: optionsOrInPlay.allowThrottleFallback ?? !(optionsOrInPlay.strictLive ?? false),
      };
  const inPlay = options.inPlay;
  const strict = options.strictLive;

  const marketKey = MARKET_MAP[statType];
  if (!marketKey) {
    return { isDegraded: false, quotaExhausted: false, books: {}, fetchedAt: 0 };
  }

  const normName = normPlayerName(playerName);
  const lastKnownKey = `${oddsEventId}|${normName}|${statType}`;

  // emptyResult is the canonical response when strict mode rejects a fallback
  // path. Returning isDegraded=false with an empty books map signals "no fresh
  // live line available — caller must skip" without poisoning the response with
  // a stale degraded payload.
  const emptyResult = (): PlayerOddsResult =>
    ({ isDegraded: false, quotaExhausted: false, books: {}, fetchedAt: Date.now() });

  const makeDegraded = (books: Record<string, OddsLine>, fetchedAt: number): PlayerOddsResult => {
    if (strict || options.allowDegraded === false) {
      return emptyResult();
    }
    return { isDegraded: true, quotaExhausted: false, books, fetchedAt };
  };

  // Cache-first pre-check: if a fresh last-known entry exists within the active TTL window,
  // return it immediately as non-degraded and skip the API call.
  // Use the raw cache TTL as the window (live: 30s, pre-game: 2min) so manual refresh
  // always gets fresh data once the underlying raw cache has expired.
  // Strict mode: skip cache-first entirely — halftime requires a verified live fetch.
  if (options.allowCacheFirst && !strict) {
    const cacheFirstTTL = inPlay ? NBA_ODDS_LIVE_TTL : NBA_ODDS_TTL;
    const lkFresh = lastKnownOdds.get(lastKnownKey);
    if (lkFresh && Date.now() - lkFresh.timestamp < cacheFirstTTL) {
      console.log(`[ODDS CACHE-FIRST] Fresh cache hit for ${playerName} (${statType}) — skipping API call`);
      pipelineLog("NBA", oddsEventId, "odds:cacheHit", { player: playerName, statType, books: Object.keys(lkFresh.data) });
      return { isDegraded: false, quotaExhausted: false, books: lkFresh.data, fetchedAt: lkFresh.timestamp };
    }
  }

  // Per-game+market throttle: if a fetch was already issued for this event+market
  // within the throttle window, check last-known first; if absent, fall through to
  // getRawOdds (which has its own cache) and extract data for this player from the
  // cached response. Never return empty when cached data exists.
  // Strict mode: refuse to return last-known degraded data on throttle hit.
  const throttleKey = `${oddsEventId}:${marketKey}`;
  const lastCallTs = lastGameApiCall.get(throttleKey);
  if (lastCallTs !== undefined && Date.now() - lastCallTs < GAME_API_THROTTLE_MS) {
    if (options.allowThrottleFallback && !strict) {
      const lk = lastKnownOdds.get(lastKnownKey);
      if (lk) {
        return makeDegraded(lk.data, lk.timestamp);
      }
    }
    // strict mode falls through to getRawOdds (which itself respects its raw
    // cache); strict bookmaker filter below will still drop any stale entry.
  } else {
    // Stamp the throttle timestamp at issuance time so concurrent requests for the
    // same event+market are blocked even before the first request resolves.
    lastGameApiCall.set(throttleKey, Date.now());
  }

  let oddsData: any;
  try {
    oddsData = await getRawOdds(oddsEventId, marketKey, inPlay);
  } catch (fetchErr) {
    // Transient network error — attempt last-known fallback (skipped in strict)
    if (!strict && options.allowDegraded !== false) {
      const lk = lastKnownOdds.get(lastKnownKey);
      if (lk && Date.now() - lk.timestamp < LAST_KNOWN_TTL) {
        console.warn(`[ODDS FALLBACK] Network error for ${playerName} (${statType}) — using last-known line (degraded)`);
        return makeDegraded(lk.data, lk.timestamp);
      }
      throw fetchErr;
    }
    if (strict) {
      console.warn(`[ODDS STRICT] Network error for ${playerName} (${statType}) — refusing degraded fallback`);
      return emptyResult();
    }
    throw fetchErr;
  }

  // Quota exhaustion — try last-known cache before giving up (skipped in strict)
  if (oddsData?._quotaExhausted) {
    if (!strict && options.allowDegraded !== false) {
      const lk = lastKnownOdds.get(lastKnownKey);
      if (lk && Date.now() - lk.timestamp < LAST_KNOWN_TTL) {
        console.warn(`[ODDS FALLBACK] Quota exhausted for ${playerName} (${statType}) — using last-known line (degraded)`);
        return makeDegraded(lk.data, lk.timestamp);
      }
    } else if (strict) {
      console.warn(`[ODDS STRICT] Quota exhausted for ${playerName} (${statType}) — refusing degraded fallback`);
    }
    return { isDegraded: false, quotaExhausted: true, books: {}, fetchedAt: 0 };
  }

  const bookmakers: any[] = Array.isArray(oddsData?.bookmakers) ? oddsData.bookmakers : [];
  if (bookmakers.length === 0) {
    pipelineLog("NBA", oddsEventId, "odds:emptyBookmakers", { player: playerName, statType, hasData: !!oddsData });
    if (!strict && options.allowDegraded !== false) {
      const lk = lastKnownOdds.get(lastKnownKey);
      if (lk && Date.now() - lk.timestamp < LAST_KNOWN_TTL) {
        console.warn(`[ODDS FALLBACK] Empty/malformed bookmakers for ${playerName} (${statType}) — using last-known line (degraded)`);
        return makeDegraded(lk.data, lk.timestamp);
      }
    }
    return { isDegraded: false, quotaExhausted: false, books: {}, fetchedAt: Date.now() };
  }

  const nameParts = normName.split(" ");
  const firstName = nameParts[0];
  const lastName = nameParts[nameParts.length - 1];
  const probPerPt = PROB_PER_POINT[statType] ?? 4.0;

  const books: Record<string, OddsLine> = {};
  let foundForAnyBook = false;
  // Strict-mode soft-stale tracking: when every bookmaker fails the fresh
  // (<= maxAgeMs) gate but at least one is within the soft window
  // (<= maxAgeMs * 3, capped at 15 min), we accept those books and flag the
  // entire result as degraded so downstream tier reduction can downgrade
  // confidence. This keeps the halftime pipeline from going completely dark
  // during the 5-10 min window when books frequently suspend or slow-refresh
  // player props around the half. Diagnostic counters drive a per-call
  // [NBA_HT_BOOKMAKER_FILTER] summary log.
  let strictDegradedFromSoftStale = false;
  // Soft-stale ceiling raised 15min → 25min (2026-05-02) so playoff books that
  // suspend player props for 8-20min through the halftime intermission still
  // surface as soft-stale (degraded) rather than hard-rejected. The route's
  // HT_HARD_STALE_LINE_MS gate now also caps at 25min, so this aligns the two
  // layers. Soft-stale lines still trigger role-aware confidence demotion
  // downstream, so the trust loss is preserved.
  const SOFT_STALE_CAP_MS = strict ? Math.min(25 * 60 * 1000, options.maxAgeMs * 3) : 0;
  const filterCounters = {
    bookmakersTotal: bookmakers.length,
    notInAllowList: 0,
    noLastUpdate: 0,
    freshAccepted: 0,
    softStaleAccepted: 0,
    hardStaleRejected: 0,
    missingMarket: 0,
    missingPlayer: 0,
    missingOverUnder: 0,
    // Usable-line freshness (only incremented when over+under are both
    // present, i.e. the book actually contributed a line to `books`):
    usableFresh: 0,
    usableSoftStale: 0,
  };
  const softStaleSamples: Array<{ key: string; ageMs: number }> = [];
  const hardStaleSamples: Array<{ key: string; ageMs: number }> = [];

  const now = Date.now();
  for (const bookmaker of bookmakers) {
    const bKey: string = bookmaker.key ?? "";
    if (!PROP_BOOKMAKERS_SET.has(bKey)) {
      filterCounters.notInAllowList++;
      continue;
    }
    // Locate the requested market early so we can use market.last_update as
    // a fallback freshness signal. Recent Odds API responses have moved the
    // freshness timestamp from `bookmaker.last_update` (often null) onto
    // `market.last_update`. Reading only the bookmaker field caused strict
    // halftime mode to reject every book as `noLastUpdate` — emptying the
    // 2H pipeline while live lines were actually fresh.
    const market = bookmaker.markets?.find((m: any) => m.key === marketKey);
    if (!market?.outcomes) {
      if (strict) filterCounters.missingMarket++;
      continue;
    }
    const bmLastUpdate = bookmaker.last_update ? new Date(bookmaker.last_update).getTime() : 0;
    const mkLastUpdate = market.last_update ? new Date(market.last_update).getTime() : 0;
    const lastUpdate = bmLastUpdate || mkLastUpdate;
    let bookIsSoftStale = false;
    if (strict) {
      // Strict halftime mode (Phase 9 — soft-stale acceptance):
      //   • lastUpdate within maxAgeMs           → fresh, accept normally
      //   • lastUpdate within SOFT_STALE_CAP_MS  → accept but flag degraded
      //   • lastUpdate older OR missing          → hard-reject
      // Books frequently slow-refresh props around the half; refusing every
      // line >5 min produces the empty-2H-pipeline failure mode we saw on
      // 2026-04-30 DEN@MIN. Tier reduction downstream (route soft-stale gate
      // + engine confidence floor) handles the trust loss.
      if (!lastUpdate) {
        filterCounters.noLastUpdate++;
        continue;
      }
      const ageMs = now - lastUpdate;
      if (ageMs > options.maxAgeMs) {
        if (ageMs <= SOFT_STALE_CAP_MS) {
          bookIsSoftStale = true;
          filterCounters.softStaleAccepted++;
          if (softStaleSamples.length < 5) softStaleSamples.push({ key: bKey, ageMs });
        } else {
          filterCounters.hardStaleRejected++;
          if (hardStaleSamples.length < 5) hardStaleSamples.push({ key: bKey, ageMs });
          continue;
        }
      } else {
        filterCounters.freshAccepted++;
      }
    } else {
      if (lastUpdate > 0 && now - lastUpdate > BOOKMAKER_STALE_MS) continue;
    }

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
      // Track USABLE-line freshness for degraded classification (architect
      // fix): pre-validation freshAccepted counts books that passed the
      // staleness gate but may have lacked the market/outcomes; we need to
      // know whether any FRESH book actually contributed a usable line. If
      // not, and a soft-stale book did, the result must be degraded.
      if (strict) {
        if (bookIsSoftStale) {
          strictDegradedFromSoftStale = true;
          filterCounters.usableSoftStale++;
        } else {
          filterCounters.usableFresh++;
        }
      }
    } else if (strict) {
      if (playerOutcomes.length === 0) filterCounters.missingPlayer++;
      else filterCounters.missingOverUnder++;
    }
  }

  // Strict-mode per-call filter summary — emit only when in strict mode so
  // we don't add noise to pre-game / live-signals fetches. Always logs (even
  // on success) so we can see the bookmaker mix during halftime cycles.
  if (strict) {
    console.log("[NBA_HT_BOOKMAKER_FILTER]", JSON.stringify({
      eventId: oddsEventId,
      player: playerName,
      statType,
      marketKey,
      maxAgeMs: options.maxAgeMs,
      softStaleCapMs: SOFT_STALE_CAP_MS,
      ...filterCounters,
      booksAccepted: Object.keys(books).length,
      degradedFromSoftStale: strictDegradedFromSoftStale,
      softStaleSamples,
      hardStaleSamples,
    }));
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
    const cacheBooks: Record<string, { line: number; overOdds: number | null; underOdds: number | null }> = {};
    for (const k of Object.keys(books)) {
      cacheBooks[k] = { line: books[k].line, overOdds: books[k].overOdds ?? null, underOdds: books[k].underOdds ?? null };
    }
    writeOddsSnapshot({
      sport: "nba",
      eventId: oddsEventId,
      market: statType,
      player: playerName,
      books: cacheBooks,
      isLive: inPlay,
      source: "api",
    });
    recordApiFetch("nba");
    logFetch("nba", { eventId: oddsEventId, market: statType, player: playerName, books: Object.keys(books).length, isLive: inPlay });
  }

  const freshFetchedAt = Date.now();
  // Strict-mode soft-stale: if every USABLE book (one that actually
  // contributed an over+under line) was inside the soft-stale window, surface
  // as degraded so the route can tier-reduce confidence. Architect-fix: use
  // usableFresh — a fresh book that lacked the market/outcomes does NOT
  // count as a fresh contributor and must not block the degraded flag.
  const isDegradedResult = strict && foundForAnyBook && strictDegradedFromSoftStale && filterCounters.usableFresh === 0;
  pipelineLog("NBA", oddsEventId, "odds:result", { player: playerName, statType, books: Object.keys(books), isDegraded: isDegradedResult, foundForAnyBook });
  if (isDegradedResult) {
    return { isDegraded: true, quotaExhausted: false, books, fetchedAt: freshFetchedAt };
  }
  return { isDegraded: false, quotaExhausted: false, books, fetchedAt: freshFetchedAt };
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

  const glApiKey = getOddsApiKey();
  if (!glApiKey) return null;

  try {
    const url = `${BASE_URL}/events/${oddsEventId}/odds?apiKey=${glApiKey}&regions=${PROP_REGIONS}&markets=spreads,totals&bookmakers=${PROP_BOOKMAKERS}&oddsFormat=american`;
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

    const slugFull  = `${firstName}-${lastName}`.replace(/\s+/g, "-");
    const slugFullUs = `${firstName}_${lastName}`.replace(/\s+/g, "_");
    const slugLast  = lastName;

    let line: number | null = null;

    for (const [key, val] of Object.entries(odds)) {
      if (typeof val !== "object" || val == null) continue;
      const k = key.toLowerCase();
      if (!k.includes(statKey)) continue;
      if (!k.includes("ou")) continue;
      if (!k.includes("over")) continue;
      if (!k.includes(slugFull) && !k.includes(slugFullUs) && !k.includes(slugLast)) continue;

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
  home_runs: "batter_home_runs",
  hr: "batter_home_runs",
  batter_strikeouts: "batter_strikeouts",
  hrr: "batter_hits_runs_rbis",
  pitcher_strikeouts: "pitcher_strikeouts",
  pitcher_k: "pitcher_strikeouts",
  pitcher_outs: "pitcher_outs",
  walks_allowed: "pitcher_walks",
  hits_allowed: "pitcher_hits_allowed",
};

async function getMLBEvents(): Promise<any[]> {
  const cacheKey = "mlb_events_list";
  const cached = cache.get(cacheKey);
  if (isFresh(cached, EVENTS_TTL)) return cached!.data;
  if (ODDS_API_KEYS.length === 0) throw new Error("ODDS_API_KEY is not set");

  let lastErr: string = "no_keys";
  const maxAttempts = ODDS_API_KEYS.length;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const mlbEvKey = getOddsApiKey();
    if (!mlbEvKey) { lastErr = "no_active_key"; break; }
    const usedKeyIndex = activeKeyIndex;
    try {
      const res = await fetch(
        `${MLB_BASE_URL}/events?apiKey=${mlbEvKey}&dateFormat=iso`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const data = await res.json();
        cache.set(cacheKey, { data, timestamp: Date.now() });
        console.log(`[Odds] Fetched ${data.length} MLB events (key ${usedKeyIndex + 1}/${ODDS_API_KEYS.length})`);
        return data;
      }
      const body = await res.text();
      lastErr = `${res.status} — ${body.slice(0, 200)}`;
      if (res.status === 401) {
        console.warn(`[MLB Odds] events: key ${usedKeyIndex + 1} got 401 — cooling 60min and rotating`);
        markKeyExhausted(usedKeyIndex);
        continue;
      }
      if (res.status === 429) {
        markKeyRateLimited(usedKeyIndex);
        continue;
      }
      throw new Error(`MLB events fetch failed: ${lastErr}`);
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
      if (attempt === maxAttempts - 1) throw err;
    }
  }
  throw new Error(`MLB events fetch failed: all ${ODDS_API_KEYS.length} keys returned errors (${lastErr})`);
}

function matchMLBEventId(events: any[], playerTeamInput: string, opponentTeamInput: string): string | null {
  const playerTeam = MLB_TEAM_FULL_NAMES[playerTeamInput.toUpperCase()] ?? playerTeamInput;
  const opponentTeam = MLB_TEAM_FULL_NAMES[opponentTeamInput.toUpperCase()] ?? opponentTeamInput;

  for (const ev of events) {
    const evHome: string = ev.home_team ?? "";
    const evAway: string = ev.away_team ?? "";
    const playerIsHome = teamsMatch(playerTeam, evHome) && teamsMatch(opponentTeam, evAway);
    const playerIsAway = teamsMatch(playerTeam, evAway) && teamsMatch(opponentTeam, evHome);
    if (playerIsHome || playerIsAway) return ev.id as string;
  }

  for (const ev of events) {
    if (teamsMatch(playerTeam, ev.home_team ?? "") || teamsMatch(playerTeam, ev.away_team ?? "")) {
      return ev.id as string;
    }
  }

  return null;
}

export async function resolveMLBOddsEventId(
  playerTeamInput: string,
  opponentTeamInput: string
): Promise<string | null> {
  try {
    const events = await getMLBEvents();
    const id = matchMLBEventId(events, playerTeamInput, opponentTeamInput);
    if (id) {
      console.log(`[Odds MLB] Matched event: ${playerTeamInput} vs ${opponentTeamInput} → ${id}`);
    } else {
      console.warn(`[Odds MLB] No event found for ${playerTeamInput} vs ${opponentTeamInput}`);
    }
    return id;
  } catch (err) {
    console.error("[Odds MLB] resolveMLBOddsEventId error:", err);
    return null;
  }
}

/**
 * Cache-only variant — resolves an odds-provider event id from the already-fetched
 * MLB events list WITHOUT ever triggering a live API call. Returns null (rather
 * than fetching) when the events cache is empty or stale. For presentation-only
 * read paths (e.g. Pre-Game Power Radar odds display) that must never add API
 * latency/quota cost to a request.
 */
export function resolveMLBOddsEventIdFromCache(
  playerTeamInput: string,
  opponentTeamInput: string
): string | null {
  const cached = cache.get("mlb_events_list");
  if (!isFresh(cached, EVENTS_TTL)) return null;
  try {
    return matchMLBEventId(cached!.data, playerTeamInput, opponentTeamInput);
  } catch {
    return null;
  }
}

async function getMLBRawOdds(oddsEventId: string, marketKey: string, inPlay = false): Promise<any> {
  const cacheKey = `mlb_odds_${inPlay ? "live" : "pre"}_${oddsEventId}_${marketKey}`;
  const cached = cache.get(cacheKey);
  const ttl = inPlay ? MLB_ODDS_LIVE_TTL : MLB_ODDS_TTL;
  if (isFresh(cached, ttl)) return cached!.data;

  const triedKeys = new Set<number>();
  const maxAttempts = ODDS_API_KEYS.length;
  let sawQuotaExhaustion = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const mlbApiKey = getOddsApiKey();
    if (!mlbApiKey) throw new Error("ODDS_API_KEY is not set");
    const usedKeyIndex = activeKeyIndex;

    if (triedKeys.has(usedKeyIndex)) break;
    triedKeys.add(usedKeyIndex);

    const quotaCacheKey = `quota_exhausted_${usedKeyIndex}`;
    const quotaCached = cache.get(quotaCacheKey);
    if (isFresh(quotaCached, QUOTA_TTL)) {
      sawQuotaExhaustion = true;
      markKeyExhausted(usedKeyIndex);
      continue;
    }

    const inPlayParam = inPlay ? "&in_play=true" : "";
    const url = `${MLB_BASE_URL}/events/${oddsEventId}/odds?apiKey=${mlbApiKey}&regions=${PROP_REGIONS}&markets=${marketKey}&bookmakers=${PROP_BOOKMAKERS}&oddsFormat=american${inPlayParam}`;

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
        if (parsed.error_code === "OUT_OF_USAGE_CREDITS") {
          const remaining = res.headers.get("x-requests-remaining");
          console.warn(`[MLB Odds] Key ${usedKeyIndex + 1} quota CONFIRMED exhausted (error_code=OUT_OF_USAGE_CREDITS, remaining=${remaining})`);
          updateOddsHealth({ success: false, error: "quota_exhausted", keyIndex: usedKeyIndex, requestsRemaining: 0 });
          cache.set(quotaCacheKey, { data: QUOTA_EXHAUSTED, timestamp: Date.now() });
          markKeyExhausted(usedKeyIndex);
          sawQuotaExhaustion = true;
          continue;
        }
        if (res.status === 401) {
          console.warn(`[MLB Odds] Key ${usedKeyIndex + 1} got 401 (auth error, NOT marking as exhausted): ${parsed.message ?? body.slice(0, 200)}`);
          updateOddsHealth({ success: false, error: `auth_error_401`, keyIndex: usedKeyIndex });
          markKeyExhausted(usedKeyIndex);
          continue;
        }
        if (res.status === 429 || parsed.error_code === "EXCEEDED_FREQ_LIMIT") {
          updateOddsHealth({ success: false, error: "rate_limited_429", keyIndex: usedKeyIndex });
          markKeyRateLimited(usedKeyIndex);
          continue;
        }
      } catch (_) {
        if (res.status === 429) {
          updateOddsHealth({ success: false, error: "rate_limited_429", keyIndex: usedKeyIndex });
          markKeyRateLimited(usedKeyIndex);
          continue;
        }
      }
      updateOddsHealth({ success: false, error: `fetch_failed_${res.status}`, keyIndex: usedKeyIndex });
      throw new Error(`MLB odds fetch failed: ${res.status} — ${body}`);
    }
    const data = await res.json();
    cache.set(cacheKey, { data, timestamp: Date.now() });
    lastKnownRawOdds.set(cacheKey, { data, timestamp: Date.now() });

    const requestsRemaining = res.headers.get("x-requests-remaining");
    if (requestsRemaining != null) {
      const rem = parseInt(requestsRemaining);
      if (rem < 1000) console.warn(`[MLB Odds] Key ${usedKeyIndex + 1} low credits: ${rem} remaining`);
    }

    // ── DIAGNOSTIC (throttled): log raw response shape so we can see exactly
    //    what the Odds API is returning in production for this market.
    try {
      const diagKey = `diag_raw_${cacheKey}`;
      const lastDiag = mlbDiagLastLog.get(diagKey) ?? 0;
      if (Date.now() - lastDiag > MLB_DIAG_THROTTLE_MS) {
        mlbDiagLastLog.set(diagKey, Date.now());
        const bms: any[] = Array.isArray(data?.bookmakers) ? data.bookmakers : [];
        const nowMs = Date.now();
        const ages = bms
          .map((b: any) => {
            // Recent Odds API responses move `last_update` from the bookmaker
            // onto the market — fall back so the diag doesn't print -1 for
            // books that are actually fresh.
            const bmTs = b?.last_update ? new Date(b.last_update).getTime() : 0;
            const mkts: any[] = Array.isArray(b?.markets) ? b.markets : [];
            const mkTs = mkts.reduce((mx: number, m: any) => {
              const t = m?.last_update ? new Date(m.last_update).getTime() : 0;
              return t > mx ? t : mx;
            }, 0);
            const ts = bmTs || mkTs;
            return ts ? Math.round((nowMs - ts) / 1000) : -1;
          })
          .slice(0, 5);
        const keys = bms.map((b: any) => b?.key).slice(0, 8);
        console.log(`[MLB ODDS DIAG] event=${oddsEventId} market=${marketKey} inPlay=${inPlay} key=${usedKeyIndex + 1}/${ODDS_API_KEYS.length} remaining=${requestsRemaining ?? "?"} bookmakers=${bms.length} sampleKeys=[${keys.join(",")}] sampleAgesSec=[${ages.join(",")}] staleThresholdSec=${Math.round(BOOKMAKER_STALE_MS / 1000)}`);
      }
    } catch {}

    updateOddsHealth({
      success: true,
      requestsRemaining: requestsRemaining ? parseInt(requestsRemaining) : undefined,
      keyIndex: usedKeyIndex,
    });
    
    return data;
  }

  const lastKnown = lastKnownRawOdds.get(cacheKey);
  if (sawQuotaExhaustion) {
    console.warn("[MLB Odds] All keys quota-exhausted — checking last-known raw cache");
    if (lastKnown && Date.now() - lastKnown.timestamp < MLB_LAST_KNOWN_TTL) {
      const ageSec = Math.round((Date.now() - lastKnown.timestamp) / 1000);
      console.log(`[MLB Odds Fallback] Serving stale raw data for ${cacheKey} (age: ${ageSec}s)`);
      return { ...lastKnown.data, _isDegraded: true };
    }
    return QUOTA_EXHAUSTED;
  }
  console.warn("[MLB Odds] All keys failed (auth/network) — serving stale if available");
  if (lastKnown && Date.now() - lastKnown.timestamp < MLB_LAST_KNOWN_TTL) {
    return { ...lastKnown.data, _isDegraded: true };
  }
  throw new Error(`MLB odds fetch failed: all ${ODDS_API_KEYS.length} keys returned errors`);
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
const MLB_LAST_KNOWN_TTL = 30 * 60 * 1000; // 30 min — extended fallback for quota exhaustion

// Throttle map for MLB diagnostic logs (raw response shape + filter outcome).
// Key: arbitrary string identifying the log site. Value: last-emitted ms.
const mlbDiagLastLog = new Map<string, number>();
const MLB_DIAG_THROTTLE_MS = 60 * 1000; // emit each diag line at most once per minute per key

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
  const now = Date.now();

  // Diagnostic counters — explain WHY filtered result is empty.
  let cntFilteredOutByBookmaker = 0;
  let cntStaleRejected = 0;
  let cntNoMatchingMarket = 0;
  let cntNoMatchingPlayer = 0;
  let cntNoOverUnder = 0;
  let cntAccepted = 0;
  let sampleOutcomeNames: string[] = [];

  for (const bookmaker of mlbBookmakers) {
    const bKey: string = bookmaker.key ?? "";
    if (!PROP_BOOKMAKERS_SET.has(bKey)) { cntFilteredOutByBookmaker++; continue; }

    const market = (bookmaker.markets ?? []).find(
      (m: any) => m.key === marketKey || isMLBPropKey(m.key ?? "", statType)
    );
    if (!market?.outcomes) { cntNoMatchingMarket++; continue; }

    // Recent Odds API responses move `last_update` from the bookmaker onto
    // the market — fall back so we don't accidentally treat fresh books as
    // having no timestamp (which would skip the staleness gate entirely and
    // also break diagnostics).
    const bmLastUpdate = bookmaker.last_update ? new Date(bookmaker.last_update).getTime() : 0;
    const mkLastUpdate = market.last_update ? new Date(market.last_update).getTime() : 0;
    const lastUpdate = bmLastUpdate || mkLastUpdate;
    if (lastUpdate > 0 && now - lastUpdate > BOOKMAKER_STALE_MS) {
      cntStaleRejected++;
      console.warn(`[MLB Odds] Rejecting stale row from ${bKey} (age: ${Math.round((now - lastUpdate) / 1000)}s)`);
      continue;
    }

    const playerOutcomes = market.outcomes.filter((o: any) => {
      const desc = normPlayerName(o.description ?? o.name ?? "");
      return desc === normName
        || desc.includes(normName)
        || (desc.includes(firstName) && desc.includes(lastName));
    });

    if (playerOutcomes.length === 0) {
      cntNoMatchingPlayer++;
      if (sampleOutcomeNames.length < 3 && Array.isArray(market.outcomes)) {
        for (const o of market.outcomes.slice(0, 3)) {
          const sample = o?.description ?? o?.name ?? "";
          if (sample) sampleOutcomeNames.push(String(sample));
          if (sampleOutcomeNames.length >= 3) break;
        }
      }
      continue;
    }

    const over = playerOutcomes.find((o: any) => o.name === "Over");
    const under = playerOutcomes.find((o: any) => o.name === "Under");

    if (over && under) {
      cntAccepted++;
      result[bKey] = {
        line: over.point,
        overOdds: over.price,
        underOdds: under.price,
      };
    } else {
      cntNoOverUnder++;
    }
  }

  // Emit a one-line filter-outcome diag whenever the result for this player ends
  // up empty. Throttle per (event,market,inPlay) to avoid log spam.
  if (cntAccepted === 0) {
    const diagKey = `diag_filter_${oddsEventId}_${marketKey}_${inPlay ? 1 : 0}`;
    const lastDiag = mlbDiagLastLog.get(diagKey) ?? 0;
    if (Date.now() - lastDiag > MLB_DIAG_THROTTLE_MS) {
      mlbDiagLastLog.set(diagKey, Date.now());
      console.log(`[MLB ODDS DIAG-FILTER] event=${oddsEventId} market=${marketKey} inPlay=${inPlay} player="${playerName}" normName="${normName}" totalBooks=${mlbBookmakers.length} bookmakerNotAllowed=${cntFilteredOutByBookmaker} staleRejected=${cntStaleRejected} noMatchingMarket=${cntNoMatchingMarket} noMatchingPlayer=${cntNoMatchingPlayer} noOverUnder=${cntNoOverUnder} sampleOutcomeNames=[${sampleOutcomeNames.map(s => `"${s}"`).join(",")}]`);
    }
  }

  if (Object.keys(result).filter(k => !k.startsWith("_")).length > 0) {
    lastKnownMLBOdds.set(lastKnownKey, { data: result, timestamp: Date.now() });
    const cacheBooks: Record<string, { line: number; overOdds: number | null; underOdds: number | null }> = {};
    for (const k of Object.keys(result)) {
      if (k.startsWith("_")) continue;
      const v = result[k];
      cacheBooks[k] = { line: v.line, overOdds: v.overOdds ?? null, underOdds: v.underOdds ?? null };
    }
    writeOddsSnapshot({
      sport: "mlb",
      eventId: oddsEventId,
      market: statType,
      player: playerName,
      books: cacheBooks,
      isLive: inPlay,
      source: "api",
    });
    recordApiFetch("mlb");
    logFetch("mlb", { eventId: oddsEventId, market: statType, player: playerName, books: Object.keys(cacheBooks).length, isLive: inPlay });
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

// ── Odds Normalization Layer ───────────────────────────────────────────────────
// Takes the raw per-book odds dict and produces a canonical NormalizedOdds object.
// Rejects any entry with a non-finite or missing line; handles empty dicts gracefully.

export interface NormalizedOdds {
  medianLine: number | null;
  bestOverOdds: number | null;
  bestUnderOdds: number | null;
  lineVariance: number | null;
  booksAvailable: number;
  sportsbookSources: string[];
}

const APPROVED_BOOKS = new Set([
  "draftkings", "fanduel", "hard_rock", "hardrockbet", "betmgm", "caesars",
  "betrivers", "espnbet", "betonlineag", "bovada", "williamhill_us",
  "prizepicks", "underdogfantasy",
  "DraftKings", "FanDuel", "Hard Rock", "BetMGM", "Caesars",
  "dk", "fd", "hr", "mgm",
]);

export function normalizeOdds(
  books: Record<string, { line: number; overOdds: number; underOdds: number }>
): NormalizedOdds {
  const validEntries = Object.entries(books).filter(([book, v]) => {
    return (
      v != null &&
      Number.isFinite(v.line) &&
      Number.isFinite(v.overOdds) &&
      Number.isFinite(v.underOdds) &&
      APPROVED_BOOKS.has(book)
    );
  });

  if (validEntries.length === 0) {
    return {
      medianLine: null,
      bestOverOdds: null,
      bestUnderOdds: null,
      lineVariance: null,
      booksAvailable: 0,
      sportsbookSources: [],
    };
  }

  const lines = validEntries.map(([, v]) => v.line).sort((a, b) => a - b);
  const mid = Math.floor(lines.length / 2);
  const medianLine =
    lines.length % 2 === 0
      ? parseFloat(((lines[mid - 1] + lines[mid]) / 2).toFixed(1))
      : lines[mid];

  // Best over odds = highest absolute value (most generous payout for Over)
  // In American odds: -100 is better than -110 for bettors; +100 > -100
  const bestOverOdds = validEntries.reduce<number | null>((best, [, v]) => {
    if (best === null) return v.overOdds;
    return v.overOdds > best ? v.overOdds : best;
  }, null);

  const bestUnderOdds = validEntries.reduce<number | null>((best, [, v]) => {
    if (best === null) return v.underOdds;
    return v.underOdds > best ? v.underOdds : best;
  }, null);

  const lineVariance =
    lines.length >= 2
      ? parseFloat((lines[lines.length - 1] - lines[0]).toFixed(2))
      : 0;

  const sportsbookSources = validEntries.map(([book]) => book);

  pipelineLog("ODDS", "normalize", "odds:normalized", {
    booksAvailable: validEntries.length,
    medianLine,
    lineVariance,
    bestOverOdds,
    bestUnderOdds,
    sources: sportsbookSources,
  });

  return {
    medianLine,
    bestOverOdds,
    bestUnderOdds,
    lineVariance,
    booksAvailable: validEntries.length,
    sportsbookSources,
  };
}

export function normalizeMLBOdds(
  books: Record<string, { line: number; overOdds: number; underOdds: number }>
): NormalizedOdds {
  return normalizeOdds(books);
}
