const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = "https://api.the-odds-api.com/v4/sports/basketball_nba";

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

const cache = new Map<string, CacheEntry>();
const EVENTS_TTL = 3 * 60 * 1000;  // 3 min (shorter so fresh games appear quickly)
const ODDS_TTL = 4 * 60 * 1000;    // 4 min

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

// Fetch player prop odds for an Odds API event UUID
async function getRawOdds(oddsEventId: string): Promise<any> {
  const cacheKey = `odds_${oddsEventId}`;
  const cached = cache.get(cacheKey);
  if (isFresh(cached, ODDS_TTL)) return cached!.data;

  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY is not set");

  const markets = Object.values(MARKET_MAP).join(",");
  const url = `${BASE_URL}/events/${oddsEventId}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&bookmakers=draftkings,fanduel,hardrockbet&oddsFormat=american`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odds fetch failed: ${res.status} — ${body}`);
  }
  const data = await res.json();
  cache.set(cacheKey, { data, timestamp: Date.now() });

  const books = (data.bookmakers ?? []).map((b: any) => b.key).join(", ");
  console.log(`[Odds] Fetched odds for event ${oddsEventId}: bookmakers = ${books || "none"}`);

  // Log available markets per bookmaker for diagnostics
  for (const bk of (data.bookmakers ?? [])) {
    const mkeys = (bk.markets ?? []).map((m: any) => m.key).join(", ");
    console.log(`[Odds]   ${bk.key} markets: ${mkeys || "none"}`);
  }
  return data;
}

// Return raw bookmaker/market data for diagnostics — used by /api/debug/odds-raw
export async function getRawOddsForDebug(oddsEventId: string): Promise<any> {
  return getRawOdds(oddsEventId);
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
  statType: string
): Promise<Record<string, { line: number; overOdds: number; underOdds: number; openLine?: number; lineMovement?: number; edgeEstimate?: number }>> {
  const result: Record<string, { line: number; overOdds: number; underOdds: number; openLine?: number; lineMovement?: number; edgeEstimate?: number }> = {};

  const marketKey = MARKET_MAP[statType];
  if (!marketKey) return result;

  const oddsData = await getRawOdds(oddsEventId);
  if (!oddsData?.bookmakers) return result;

  const normName = normPlayerName(playerName);
  const nameParts = normName.split(" ");
  const firstName = nameParts[0];
  const lastName = nameParts[nameParts.length - 1];
  const probPerPt = PROB_PER_POINT[statType] ?? 4.0;

  let foundForAnyBook = false;

  for (const bookmaker of oddsData.bookmakers) {
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

      result[bookmaker.key] = {
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
      const available = [...new Set(
        sampleMarket.outcomes.map((o: any) => o.description ?? o.name).filter(Boolean)
      )].slice(0, 8);
      console.warn(`[Odds] No ${statType} line found for "${playerName}" — ${available.length ? `Available: ${available.join(", ")}` : "market has no outcomes (props not posted yet)"}`);
    } else {
      console.warn(`[Odds] No ${statType} line found for "${playerName}" — market key "${marketKey}" not found in response (may not be offered by these books)`);
    }
  }

  return result;
}

// Bust the event cache (call after a game starts or for testing)
export function bustEventsCache(): void {
  cache.delete("events_list");
}

// Expose opening line cache size for diagnostics
export function getOpeningLineCacheSize(): number {
  return openingLineCache.size;
}
