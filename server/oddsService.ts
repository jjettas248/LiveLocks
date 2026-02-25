const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = "https://api.the-odds-api.com/v4/sports/basketball_nba";

interface CacheEntry {
  data: any;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const EVENTS_TTL = 10 * 60 * 1000; // 10 min
const ODDS_TTL = 5 * 60 * 1000;    // 5 min

function isFresh(entry: CacheEntry | undefined, ttl: number): boolean {
  return !!entry && Date.now() - entry.timestamp < ttl;
}

// Fetch and cache the full list of NBA events from The Odds API
async function getEvents(): Promise<any[]> {
  const cacheKey = "events_list";
  const cached = cache.get(cacheKey);
  if (isFresh(cached, EVENTS_TTL)) return cached!.data;

  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY is not set");

  const res = await fetch(`${BASE_URL}/events?apiKey=${ODDS_API_KEY}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Events fetch failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  cache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

// Normalise team names for fuzzy matching (handle common abbreviations/aliases)
function normTeam(name: string): string {
  return name.toLowerCase()
    .replace("golden state warriors", "golden state")
    .replace("oklahoma city thunder", "oklahoma city")
    .replace("san antonio spurs", "san antonio")
    .replace("los angeles lakers", "los angeles lakers")
    .replace("los angeles clippers", "los angeles clippers")
    .replace(/\s+/g, " ")
    .trim();
}

// Match an ESPN game (home/away team full names or abbreviations) to an Odds API event UUID
export async function resolveOddsEventId(
  homeTeam: string,
  awayTeam: string
): Promise<string | null> {
  try {
    const events = await getEvents();
    const home = normTeam(homeTeam);
    const away = normTeam(awayTeam);

    for (const ev of events) {
      const evHome = normTeam(ev.home_team ?? "");
      const evAway = normTeam(ev.away_team ?? "");
      if (evHome.includes(home) || home.includes(evHome)) {
        if (evAway.includes(away) || away.includes(evAway)) {
          return ev.id as string;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Fetch player prop odds for an Odds API event UUID
async function getRawOdds(oddsEventId: string): Promise<any> {
  const cacheKey = `odds_${oddsEventId}`;
  const cached = cache.get(cacheKey);
  if (isFresh(cached, ODDS_TTL)) return cached!.data;

  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY is not set");

  const markets = [
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_steals",
    "player_blocks",
  ].join(",");

  const url = `${BASE_URL}/events/${oddsEventId}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&bookmakers=draftkings,fanduel,hardrockbet&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odds fetch failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  cache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

// Map our stat type to the Odds API market key
const MARKET_MAP: Record<string, string> = {
  points: "player_points",
  rebounds: "player_rebounds",
  assists: "player_assists",
  steals: "player_steals",
  blocks: "player_blocks",
};

export async function getPlayerOdds(
  oddsEventId: string,
  playerName: string,
  statType: string
): Promise<Record<string, { line: number; overOdds: number; underOdds: number }>> {
  const result: Record<string, { line: number; overOdds: number; underOdds: number }> = {};

  const marketKey = MARKET_MAP[statType];
  if (!marketKey) return result; // combo props not in Odds API player markets

  const oddsData = await getRawOdds(oddsEventId);
  if (!oddsData?.bookmakers) return result;

  const nameLower = playerName.toLowerCase();

  for (const bookmaker of oddsData.bookmakers) {
    const market = bookmaker.markets?.find((m: any) => m.key === marketKey);
    if (!market?.outcomes) continue;

    // Match player by description (Odds API uses full names in description field)
    const playerOutcomes = market.outcomes.filter((o: any) => {
      const desc = (o.description ?? "").toLowerCase();
      // Try last name match or full name containment
      const parts = nameLower.split(" ");
      const lastName = parts[parts.length - 1];
      return desc.includes(nameLower) || desc.includes(lastName);
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

  return result;
}
