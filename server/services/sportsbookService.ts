// ── Sportsbook Aggregation Layer (Phase 1) ─────────────────────────────────────
// Fetches odds from The Odds API and normalizes them into a unified contract.
// Returns [] gracefully when ODDS_API_KEY is not configured.
// Supports: FanDuel, DraftKings, Bet365, Caesars, Hard Rock, Fanatics, PrizePicks, Underdog

export interface NormalizedOddsLine {
  marketType: "spread" | "total" | "prop";
  line: number;
  overOdds: number;
  underOdds: number;
  sportsbook: string;
  timestamp: number;
}

export const SUPPORTED_BOOKS = [
  "fanduel",
  "draftkings",
  "bet365",
  "caesars",
  "hardrockbet",
  "fanatics",
  "prizepicks",
  "underdogfantasy",
] as const;
export type SupportedBook = typeof SUPPORTED_BOOKS[number];

// Human-readable labels for each sportsbook key
export const SPORTSBOOK_DISPLAY: Record<string, string> = {
  fanduel: "FanDuel",
  draftkings: "DraftKings",
  bet365: "Bet365",
  caesars: "Caesars",
  hardrockbet: "Hard Rock",
  fanatics: "Fanatics",
  prizepicks: "PrizePicks",
  underdogfantasy: "Underdog",
};

const SPORT_ENDPOINTS: Record<string, string> = {
  nba: "basketball_nba",
  ncaab: "basketball_ncaab",
  mlb: "baseball_mlb",
};

// In-memory cache: key → { data, timestamp }
const _cache = new Map<string, { data: NormalizedOddsLine[]; timestamp: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute default

function isCacheFresh(entry: { data: NormalizedOddsLine[]; timestamp: number } | undefined, ttl = CACHE_TTL_MS): boolean {
  return !!entry && Date.now() - entry.timestamp < ttl;
}

// Normalize an American odds integer (e.g. -110, +150) to a string for display.
// Returns the raw number — callers format as needed.
function safeOdds(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return -110; // standard juice fallback
}

// Core fetch — calls The Odds API for a single event+market.
// Returns [] when the API key is absent or on any network/parsing error.
async function fetchRawLines(params: {
  sportEndpoint: string;
  eventId: string;
  marketKey: string;
  marketType: "spread" | "total" | "prop";
  inPlay?: boolean;
}): Promise<NormalizedOddsLine[]> {
  const { getOddsApiKey } = await import("../oddsService");
  const apiKey = getOddsApiKey();
  if (!apiKey) return [];

  const books = SUPPORTED_BOOKS.join(",");
  const inPlayParam = params.inPlay ? "&in_play=true" : "";
  const url =
    `https://api.the-odds-api.com/v4/sports/${params.sportEndpoint}/events/${params.eventId}/odds` +
    `?apiKey=${apiKey}&regions=us&markets=${params.marketKey}&bookmakers=${books}&oddsFormat=american${inPlayParam}`;

  const cacheKey = `sb:${params.sportEndpoint}:${params.eventId}:${params.marketKey}:${params.inPlay ? "live" : "pre"}`;
  const cached = _cache.get(cacheKey);
  const ttl = params.inPlay ? 30_000 : CACHE_TTL_MS;
  if (isCacheFresh(cached, ttl)) return cached!.data;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[SportsbookService] API error ${res.status} for ${params.marketKey}: ${body.slice(0, 120)}`);
      return [];
    }
    const data = await res.json();
    const bookmakers: any[] = Array.isArray(data.bookmakers) ? data.bookmakers : [];
    const now = Date.now();
    const lines: NormalizedOddsLine[] = [];

    for (const bm of bookmakers) {
      const key: string = bm.key ?? "";
      if (!SUPPORTED_BOOKS.includes(key as SupportedBook)) continue;
      const markets: any[] = Array.isArray(bm.markets) ? bm.markets : [];
      for (const mkt of markets) {
        if (mkt.key !== params.marketKey) continue;
        const outcomes: any[] = Array.isArray(mkt.outcomes) ? mkt.outcomes : [];
        const over = outcomes.find((o: any) => o.name === "Over");
        const under = outcomes.find((o: any) => o.name === "Under");
        if (!over || !under) continue;
        const line = typeof over.point === "number" && Number.isFinite(over.point) ? over.point : null;
        if (line === null) continue;
        lines.push({
          marketType: params.marketType,
          line,
          overOdds: safeOdds(over.price),
          underOdds: safeOdds(under.price),
          sportsbook: key,
          timestamp: now,
        });
      }
    }

    console.log(`[SportsbookService] ${params.sportEndpoint}/${params.marketKey} — ${lines.length} book lines fetched`);
    _cache.set(cacheKey, { data: lines, timestamp: now });
    return lines;
  } catch (err) {
    console.warn(`[SportsbookService] Fetch failed for ${params.marketKey}:`, err);
    return [];
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function fetchNormalizedOdds(params: {
  sport: "nba" | "ncaab" | "mlb";
  eventId: string | null;
  marketType: "spread" | "total" | "prop";
  marketKey: string;
  inPlay?: boolean;
}): Promise<NormalizedOddsLine[]> {
  if (!params.eventId) return [];
  const sportEndpoint = SPORT_ENDPOINTS[params.sport];
  if (!sportEndpoint) return [];
  return fetchRawLines({
    sportEndpoint,
    eventId: params.eventId,
    marketKey: params.marketKey,
    marketType: params.marketType,
    inPlay: params.inPlay,
  });
}

// Whether the sportsbook service is active (API key configured)
export function isSportsbookServiceActive(): boolean {
  return !!(process.env.ODDS_API_KEY || process.env.ODDS_API_KEY_2);
}

// ── Phase 12: Odds Freshness Guard ────────────────────────────────────────────
// Live odds expire after 15s; pre-game odds expire after 60s.

const LIVE_ODDS_STALE_MS = 15_000;
const PREGAME_ODDS_STALE_MS = 60_000;

export function isStale(
  line: NormalizedOddsLine,
  opts?: { isLive?: boolean; ttlMs?: number }
): boolean {
  const ttl = opts?.ttlMs ?? (opts?.isLive ? LIVE_ODDS_STALE_MS : PREGAME_ODDS_STALE_MS);
  return Date.now() - line.timestamp > ttl;
}

// Returns only lines whose timestamp is within the freshness window.
// Logs a warning when any lines are filtered out.
export function filterFreshLines(
  lines: NormalizedOddsLine[],
  opts?: { isLive?: boolean; ttlMs?: number }
): NormalizedOddsLine[] {
  const fresh = lines.filter((l) => !isStale(l, opts));
  const staleCount = lines.length - fresh.length;
  if (staleCount > 0) {
    console.warn(`[SportsbookService] Filtered ${staleCount} stale line(s) — ${fresh.length} remain`);
  }
  return fresh;
}

// Returns a bestBet object from an array of fresh lines:
// picks the sportsbook with the best over-odds as the recommended execution path.
export interface BestBet {
  sportsbook: string;
  line: number;
  overOdds: number;
  underOdds: number;
}

export function getBestBet(lines: NormalizedOddsLine[], side: "OVER" | "UNDER" = "OVER"): BestBet | null {
  const fresh = filterFreshLines(lines);
  if (fresh.length === 0) return null;
  const sorted =
    side === "OVER"
      ? [...fresh].sort((a, b) => b.overOdds - a.overOdds)
      : [...fresh].sort((a, b) => b.underOdds - a.underOdds);
  const best = sorted[0];
  return {
    sportsbook: best.sportsbook,
    line: best.line,
    overOdds: best.overOdds,
    underOdds: best.underOdds,
  };
}
