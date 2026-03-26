// ── NBA Stats Service ──────────────────────────────────────────────────────────
// Fetches usage rate, defensive matchup quality, and on/off rotation context
// from the NBA Stats API. Uses player + team stats endpoints.
// All fetches are wrapped in try/catch — failures return null (non-blocking).

const NBA_STATS_BASE = "https://stats.nba.com/stats";

const NBA_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer": "https://www.nba.com",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
};

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const PLAYER_USAGE_TTL = 4 * 60 * 60 * 1000;
const TEAM_DEF_TTL = 4 * 60 * 60 * 1000;
const ON_OFF_TTL = 6 * 60 * 60 * 1000;

const playerUsageCache = new Map<string, CacheEntry<PlayerUsageData>>();
const teamDefenseCache = new Map<string, CacheEntry<TeamDefenseMatchup>>();

let leaguePlayerStatsCache: CacheEntry<any[]> | null = null;
let leagueTeamStatsCache: CacheEntry<any[]> | null = null;
let playerOnOffCache: CacheEntry<Map<string, number>> | null = null;

export interface PlayerUsageData {
  playerId: string;
  playerName: string;
  usageRate: number | null;
  touches: number | null;
  timeOfPossession: number | null;
  catchAndShootPct: number | null;
  pullUpPct: number | null;
  onOffDiff: number | null;
  source: "nba_stats" | "fallback";
}

export interface TeamDefenseMatchup {
  teamId: string;
  teamAbbr: string;
  oppPtsPerGame: number | null;
  defRating: number | null;
  paceAllowed: number | null;
  oppPgPts: number | null;
  oppSgPts: number | null;
  oppSfPts: number | null;
  oppPfPts: number | null;
  oppCPts: number | null;
  source: "nba_stats" | "fallback";
}

async function fetchNBAStats(endpoint: string, params: Record<string, string>): Promise<any | null> {
  const qs = new URLSearchParams(params).toString();
  const url = `${NBA_STATS_BASE}/${endpoint}?${qs}`;
  try {
    const res = await fetch(url, {
      headers: NBA_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[NBAStats] HTTP ${res.status} for ${endpoint}`);
      return null;
    }
    return await res.json();
  } catch (err: any) {
    console.warn(`[NBAStats] ${endpoint} fetch error:`, err.message);
    return null;
  }
}

function rowsToObjects(resultSet: any): Record<string, any>[] {
  const headers: string[] = resultSet?.headers ?? [];
  const rows: any[][] = resultSet?.rowSet ?? [];
  return rows.map((row) => {
    const obj: Record<string, any> = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

async function ensureLeaguePlayerStats(): Promise<any[]> {
  if (leaguePlayerStatsCache && Date.now() - leaguePlayerStatsCache.fetchedAt < PLAYER_USAGE_TTL) {
    return leaguePlayerStatsCache.data;
  }
  const season = getCurrentSeason();
  const data = await fetchNBAStats("leaguedashplayerstats", {
    Season: season,
    SeasonType: "Regular Season",
    PerMode: "PerGame",
    MeasureType: "Usage",
  });
  if (!data) return leaguePlayerStatsCache?.data ?? [];
  const rows = rowsToObjects(data.resultSets?.[0]);
  leaguePlayerStatsCache = { data: rows, fetchedAt: Date.now() };
  console.log(`[NBAStats] Loaded ${rows.length} player usage stats`);
  return rows;
}

async function ensureLeagueTeamStats(): Promise<any[]> {
  if (leagueTeamStatsCache && Date.now() - leagueTeamStatsCache.fetchedAt < TEAM_DEF_TTL) {
    return leagueTeamStatsCache.data;
  }
  const season = getCurrentSeason();
  const data = await fetchNBAStats("leaguedashteamstats", {
    Season: season,
    SeasonType: "Regular Season",
    PerMode: "PerGame",
    MeasureType: "Defense",
  });
  if (!data) return leagueTeamStatsCache?.data ?? [];
  const rows = rowsToObjects(data.resultSets?.[0]);
  leagueTeamStatsCache = { data: rows, fetchedAt: Date.now() };
  console.log(`[NBAStats] Loaded ${rows.length} team defense stats`);
  return rows;
}

function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String(year + 1).slice(2)}`;
}

/**
 * Fetch on/off rotation context from leaguedashplayeronoffdetails.
 * Returns a map of PLAYER_ID → onOffDiff (on-court NET_RATING - off-court NET_RATING).
 * Higher positive values = player is significantly more effective on court.
 */
async function ensurePlayerOnOffStats(): Promise<Map<string, number>> {
  if (playerOnOffCache && Date.now() - playerOnOffCache.fetchedAt < ON_OFF_TTL) {
    return playerOnOffCache.data;
  }
  const season = getCurrentSeason();
  const [onData, offData] = await Promise.all([
    fetchNBAStats("leaguedashplayeronoffdetails", {
      Season: season,
      SeasonType: "Regular Season",
      MeasureType: "Advanced",
      PerMode: "PerGame",
      PlusMinus: "N",
      PaceAdjust: "N",
      Rank: "N",
      OnOrOff: "On",
    }),
    fetchNBAStats("leaguedashplayeronoffdetails", {
      Season: season,
      SeasonType: "Regular Season",
      MeasureType: "Advanced",
      PerMode: "PerGame",
      PlusMinus: "N",
      PaceAdjust: "N",
      Rank: "N",
      OnOrOff: "Off",
    }),
  ]);

  const onRows: Record<string, any>[] = onData ? rowsToObjects(onData.resultSets?.[0]) : [];
  const offRows: Record<string, any>[] = offData ? rowsToObjects(offData.resultSets?.[0]) : [];

  // Build OFF net rating lookup by player id
  const offByPlayerId = new Map<string, number>();
  for (const row of offRows) {
    const pid = String(row.PLAYER_ID ?? "");
    const nr = row.NET_RATING != null ? parseFloat(row.NET_RATING) : null;
    if (pid && nr != null && Number.isFinite(nr)) offByPlayerId.set(pid, nr);
  }

  // Compute on/off differential per player
  const onOffMap = new Map<string, number>();
  for (const row of onRows) {
    const pid = String(row.PLAYER_ID ?? "");
    const onNR = row.NET_RATING != null ? parseFloat(row.NET_RATING) : null;
    if (!pid || onNR == null || !Number.isFinite(onNR)) continue;
    const offNR = offByPlayerId.get(pid);
    if (offNR == null) continue;
    onOffMap.set(pid, onNR - offNR);
  }

  playerOnOffCache = { data: onOffMap, fetchedAt: Date.now() };
  console.log(`[NBAStats] Loaded on/off rotation context for ${onOffMap.size} players`);
  return onOffMap;
}

export async function getPlayerUsage(playerName: string, playerId?: string): Promise<PlayerUsageData> {
  const cacheKey = playerId ?? playerName.toLowerCase();
  const cached = playerUsageCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PLAYER_USAGE_TTL) return cached.data;

  const fallback: PlayerUsageData = {
    playerId: playerId ?? "",
    playerName,
    usageRate: null,
    touches: null,
    timeOfPossession: null,
    catchAndShootPct: null,
    pullUpPct: null,
    onOffDiff: null,
    source: "fallback",
  };

  try {
    // Fetch usage stats and on/off rotation context in parallel
    const [rows, onOffMap] = await Promise.all([
      ensureLeaguePlayerStats(),
      ensurePlayerOnOffStats().catch(() => new Map<string, number>()),
    ]);
    const normName = playerName.toLowerCase().replace(/[^a-z\s]/g, "");
    const match = rows.find((r) => {
      const rName = String(r.PLAYER_NAME ?? "").toLowerCase().replace(/[^a-z\s]/g, "");
      return rName === normName || (playerId && String(r.PLAYER_ID) === playerId);
    });

    if (!match) {
      console.warn(`[NBAStats] No usage data for player: ${playerName}`);
      playerUsageCache.set(cacheKey, { data: fallback, fetchedAt: Date.now() });
      return fallback;
    }

    const resolvedId = String(match.PLAYER_ID ?? playerId ?? "");
    const onOffDiff = onOffMap.get(resolvedId) ?? null;

    const result: PlayerUsageData = {
      playerId: resolvedId,
      playerName: String(match.PLAYER_NAME ?? playerName),
      usageRate: match.USG_PCT != null ? parseFloat(match.USG_PCT) : null,
      touches: match.TOUCHES != null ? parseFloat(match.TOUCHES) : null,
      timeOfPossession: match.TIME_OF_POSS != null ? parseFloat(match.TIME_OF_POSS) : null,
      catchAndShootPct: match.CATCH_SHOOT_PTS != null ? parseFloat(match.CATCH_SHOOT_PTS) : null,
      pullUpPct: match.PULL_UP_PTS != null ? parseFloat(match.PULL_UP_PTS) : null,
      onOffDiff,
      source: "nba_stats",
    };

    playerUsageCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (err: any) {
    console.warn(`[NBAStats] getPlayerUsage error:`, err.message);
    return fallback;
  }
}

export async function getTeamDefenseMatchup(teamAbbr: string): Promise<TeamDefenseMatchup> {
  const cacheKey = teamAbbr.toUpperCase();
  const cached = teamDefenseCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TEAM_DEF_TTL) return cached.data;

  const fallback: TeamDefenseMatchup = {
    teamId: "",
    teamAbbr,
    oppPtsPerGame: null,
    defRating: null,
    paceAllowed: null,
    oppPgPts: null,
    oppSgPts: null,
    oppSfPts: null,
    oppPfPts: null,
    oppCPts: null,
    source: "fallback",
  };

  try {
    const rows = await ensureLeagueTeamStats();
    const norm = teamAbbr.toUpperCase();
    const match = rows.find((r) => {
      const abbr = String(r.TEAM_ABBREVIATION ?? "").toUpperCase();
      return abbr === norm;
    });

    if (!match) {
      console.warn(`[NBAStats] No defense data for team: ${teamAbbr}`);
      teamDefenseCache.set(cacheKey, { data: fallback, fetchedAt: Date.now() });
      return fallback;
    }

    const result: TeamDefenseMatchup = {
      teamId: String(match.TEAM_ID ?? ""),
      teamAbbr,
      oppPtsPerGame: match.OPP_PTS != null ? parseFloat(match.OPP_PTS) : null,
      defRating: match.DEF_RATING != null ? parseFloat(match.DEF_RATING) : null,
      paceAllowed: match.PACE != null ? parseFloat(match.PACE) : null,
      oppPgPts: match.OPP_PTS_PG != null ? parseFloat(match.OPP_PTS_PG) : null,
      oppSgPts: match.OPP_PTS_SG != null ? parseFloat(match.OPP_PTS_SG) : null,
      oppSfPts: match.OPP_PTS_SF != null ? parseFloat(match.OPP_PTS_SF) : null,
      oppPfPts: match.OPP_PTS_PF != null ? parseFloat(match.OPP_PTS_PF) : null,
      oppCPts: match.OPP_PTS_C != null ? parseFloat(match.OPP_PTS_C) : null,
      source: "nba_stats",
    };

    teamDefenseCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (err: any) {
    console.warn(`[NBAStats] getTeamDefenseMatchup error:`, err.message);
    return fallback;
  }
}

/**
 * Compute usage adjustment multiplier for projection scaling.
 * Blends season usage rate with on/off rotation context:
 * - usageRate: percentage of plays involving this player while on court (baseline 22%)
 * - onOffDiff: on-court NET_RATING minus off-court NET_RATING; positive = player makes team better
 *   capped to ±20 pts to prevent extreme outliers from dominating
 */
export function computeUsageAdjustment(usage: PlayerUsageData, baselineUsage = 22): number {
  let modifier = 1.0;

  if (usage.usageRate != null) {
    const usageDelta = (usage.usageRate - baselineUsage) / baselineUsage;
    modifier += usageDelta * 0.5;
  }

  if (usage.onOffDiff != null && Number.isFinite(usage.onOffDiff)) {
    // Scale: every +10 pts of on/off diff = +2% projection boost; clamp contribution to ±4%
    const cappedDiff = Math.max(-20, Math.min(20, usage.onOffDiff));
    modifier += cappedDiff * 0.002;
  }

  return Math.max(0.80, Math.min(1.25, modifier));
}

export function computeDefenseMultiplier(defense: TeamDefenseMatchup, position?: string): number {
  if (defense.defRating == null) return 1.0;
  const leagueAvgDefRating = 112.5;
  const delta = (defense.defRating - leagueAvgDefRating) / leagueAvgDefRating;
  return Math.max(0.85, Math.min(1.20, 1.0 + delta * 0.4));
}

export function clearNBAStatsCache(): void {
  playerUsageCache.clear();
  teamDefenseCache.clear();
  leaguePlayerStatsCache = null;
  leagueTeamStatsCache = null;
  playerOnOffCache = null;
  console.log("[NBAStats] Cache cleared");
}
