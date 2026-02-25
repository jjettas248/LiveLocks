const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = "https://api.the-odds-api.com/v4/sports/basketball_nba";

interface OddsCacheEntry {
  data: any;
  timestamp: number;
}

const oddsCache = new Map<string, OddsCacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getPlayerOdds(gameId: string) {
  if (!ODDS_API_KEY) {
    throw new Error("ODDS_API_KEY is not set");
  }

  const cacheKey = `odds_${gameId}`;
  const cached = oddsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const markets = [
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_threes",
    "player_steals",
    "player_blocks"
  ].join(",");

  const url = `${BASE_URL}/events/${gameId}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&bookmakers=draftkings,fanduel,hardrockbet&oddsFormat=american`;

  const response = await fetch(url);
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`The Odds API error: ${response.status} ${errorBody}`);
  }

  const data = await response.json();
  oddsCache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

export function formatPlayerOdds(oddsData: any, playerName: string, statType: string) {
  const result: Record<string, { line: number; overOdds: number; underOdds: number }> = {};
  
  // Map our stat types to The Odds API market names
  const marketMap: Record<string, string> = {
    "points": "player_points",
    "rebounds": "player_rebounds",
    "assists": "player_assists",
    "threes": "player_threes",
    "steals": "player_steals",
    "blocks": "player_blocks"
  };

  const marketName = marketMap[statType];
  if (!marketName || !oddsData.bookmakers) return result;

  for (const bookmaker of oddsData.bookmakers) {
    const market = bookmaker.markets?.find((m: any) => m.key === marketName);
    if (!market) continue;

    // The Odds API returns outcomes like { name: "Over", description: "Player Name", price: -110, point: 24.5 }
    const outcomes = market.outcomes?.filter((o: any) => 
      o.description.toLowerCase().includes(playerName.toLowerCase()) || 
      playerName.toLowerCase().includes(o.description.toLowerCase())
    );

    if (outcomes && outcomes.length >= 2) {
      const over = outcomes.find((o: any) => o.name === "Over");
      const under = outcomes.find((o: any) => o.name === "Under");

      if (over && under) {
        result[bookmaker.key] = {
          line: over.point,
          overOdds: over.price,
          underOdds: under.price
        };
      }
    }
  }

  return result;
}
