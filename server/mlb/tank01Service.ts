const TANK01_BASE = "https://tank01-mlb-live-in-game-real-time-statistics.p.rapidapi.com";

function getHeaders(): Record<string, string> {
  const key = process.env.TANK01_RAPIDAPI_KEY;
  if (!key) throw new Error("TANK01_RAPIDAPI_KEY not set");
  return {
    "Content-Type": "application/json",
    "x-rapidapi-host": "tank01-mlb-live-in-game-real-time-statistics.p.rapidapi.com",
    "x-rapidapi-key": key,
  };
}

export interface Tank01PlayerStats {
  playerID: string;
  longName: string;
  team: string;
  Hitting?: {
    avg?: string;
    HR?: string;
    H?: string;
    AB?: string;
    OBP?: string;
    SLG?: string;
    OPS?: string;
    BB?: string;
    SO?: string;
    RBI?: string;
    R?: string;
    TB?: string;
  };
  Pitching?: {
    ERA?: string;
    W?: string;
    L?: string;
    IP?: string;
    SO?: string;
    WHIP?: string;
    BB?: string;
    H?: string;
    HR?: string;
  };
}

export interface Tank01GameScore {
  gameID: string;
  home: string;
  away: string;
  homeResult?: string;
  awayResult?: string;
  lineScore?: Record<string, any>;
  currentInning?: string;
  currentInningHalf?: string;
  probableStartingPitchers?: {
    home?: Array<{ playerID: string; longName: string }>;
    away?: Array<{ playerID: string; longName: string }>;
  };
  playerStats?: Record<string, Tank01PlayerStats>;
}

const tank01Cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL_MS = 60_000;

async function tank01Fetch<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  const qs = new URLSearchParams(params).toString();
  const url = `${TANK01_BASE}${path}${qs ? `?${qs}` : ""}`;
  const cacheKey = url;
  const cached = tank01Cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data as T;
  }

  try {
    const res = await fetch(url, {
      headers: getHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[Tank01] ${path} returned ${res.status}`);
      return null;
    }
    const json = await res.json() as any;
    const body = json.body ?? json;
    tank01Cache.set(cacheKey, { data: body, ts: Date.now() });
    return body as T;
  } catch (err: any) {
    console.warn(`[Tank01] fetch error for ${path}:`, err.message);
    return null;
  }
}

export async function fetchTank01GameScores(gameDate: string): Promise<Tank01GameScore[]> {
  const data = await tank01Fetch<Tank01GameScore[]>("/getMLBScoresOnly", {
    gameDate,
    topPerformers: "true",
  });
  return data ?? [];
}

export interface Tank01BatterSeasonStats {
  avg: number;
  ops: number;
  slg: number;
  obp: number;
  hr: number;
  ab: number;
  hits: number;
  rbi: number;
  runs: number;
  tb: number;
  bb: number;
  so: number;
}

export async function fetchTank01PlayerStats(playerId: string): Promise<Tank01BatterSeasonStats | null> {
  const data = await tank01Fetch<any>("/getMLBPlayerInfo", {
    playerID: playerId,
    getStats: "true",
  });
  if (!data) return null;

  const hitting = data?.stats?.Hitting ?? data?.Hitting;
  if (!hitting) return null;

  return {
    avg: parseFloat(hitting.avg ?? "0") || 0,
    ops: parseFloat(hitting.OPS ?? "0") || 0,
    slg: parseFloat(hitting.SLG ?? "0") || 0,
    obp: parseFloat(hitting.OBP ?? "0") || 0,
    hr: parseInt(hitting.HR ?? "0", 10) || 0,
    ab: parseInt(hitting.AB ?? "0", 10) || 0,
    hits: parseInt(hitting.H ?? "0", 10) || 0,
    rbi: parseInt(hitting.RBI ?? "0", 10) || 0,
    runs: parseInt(hitting.R ?? "0", 10) || 0,
    tb: parseInt(hitting.TB ?? "0", 10) || 0,
    bb: parseInt(hitting.BB ?? "0", 10) || 0,
    so: parseInt(hitting.SO ?? "0", 10) || 0,
  };
}

export interface Tank01GameBoxPlayerStats {
  playerId: string;
  playerName: string;
  team: string;
  ab: number;
  hits: number;
  hr: number;
  rbi: number;
  bb: number;
  so: number;
  avg: number;
  ops: number;
}

export async function fetchTank01BoxScore(gameId: string): Promise<{
  players: Tank01GameBoxPlayerStats[];
} | null> {
  const data = await tank01Fetch<any>("/getMLBBoxScore", {
    gameID: gameId,
  });
  if (!data) return null;

  const players: Tank01GameBoxPlayerStats[] = [];
  const playerStats = data?.playerStats ?? data?.body?.playerStats;
  if (playerStats && typeof playerStats === "object") {
    for (const [pid, pdata] of Object.entries(playerStats)) {
      const p = pdata as any;
      const hitting = p?.Hitting;
      if (!hitting) continue;
      players.push({
        playerId: pid,
        playerName: p?.longName ?? p?.playerName ?? pid,
        team: p?.team ?? "",
        ab: parseInt(hitting.AB ?? "0", 10) || 0,
        hits: parseInt(hitting.H ?? "0", 10) || 0,
        hr: parseInt(hitting.HR ?? "0", 10) || 0,
        rbi: parseInt(hitting.RBI ?? "0", 10) || 0,
        bb: parseInt(hitting.BB ?? "0", 10) || 0,
        so: parseInt(hitting.SO ?? "0", 10) || 0,
        avg: parseFloat(hitting.avg ?? "0") || 0,
        ops: parseFloat(hitting.OPS ?? "0") || 0,
      });
    }
  }

  return { players };
}
