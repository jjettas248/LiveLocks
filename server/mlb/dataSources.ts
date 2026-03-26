// ── MLB External Data Sources ─────────────────────────────────────────────────
// Fetches data from Baseball Savant (Statcast), Ballpark Pal, and ESPN.
// All calls: try/catch with safe null-fallback returns.

export interface BallparkPalData {
  parkFactor: number;
  temperature: number | null;
  windSpeed: number | null;
  windDirection: "in" | "out" | "cross" | "calm" | null;
  humidity: number | null;
  isIndoors: boolean;
}

export interface BaseballSavantData {
  exitVelocity: number | null;
  launchAngle: number | null;
  hitDistance: number | null;
  hardHitRateSeason: number | null;
  barrelRateProxySeason: number | null;
  xBA: number | null;
  xSLG: number | null;
  avgFastballVelocity: number | null;
  avgFastballSpin: number | null;
  pitchMixPct: {
    fastball: number | null;
    breaking: number | null;
    offspeed: number | null;
  };
}

export interface MLBComData {
  battingOrderSlot: number;
  pitchCount: number;
  timesThrough: number;
  inning: number;
  isTopInning: boolean;
  currentHits: number;
  currentTotalBases: number;
  currentStrikeouts: number;
  currentHomeRuns: number;
  plateAppearances: number;
  atBats: number;
}

export interface ESPNMLBData {
  gameStatus: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  inning: number;
  isTopInning: boolean;
  playerStats: Record<string, any>;
}

// Cache for Savant data (updated infrequently — season stats)
const savantCache = new Map<string, { data: BaseballSavantData; fetchedAt: number }>();
const SAVANT_TTL = 30 * 60 * 1000; // 30 min

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchBallparkPalData(
  _gameId: string
): Promise<BallparkPalData> {
  return {
    parkFactor: 1.0,
    temperature: null,
    windSpeed: null,
    windDirection: null,
    humidity: null,
    isIndoors: false,
  };
}

// ── Baseball Savant Statcast Data ─────────────────────────────────────────────
// For batters: xBA, xSLG, exit velo, hard hit %, barrel %
// For pitchers: pitch mix %, avg fastball velocity/spin
// Uses Baseball Savant CSV endpoint (public, no auth required).
// CSV columns include: player_id, exit_velocity_avg, launch_angle_avg,
// hit_distance_sc, hard_hit_percent, barrel_batted_rate, xba, xslg, etc.

export async function fetchBaseballSavantData(
  mlbPlayerId: string,
  _gameId: string
): Promise<BaseballSavantData> {
  const nullResult: BaseballSavantData = {
    exitVelocity: null,
    launchAngle: null,
    hitDistance: null,
    hardHitRateSeason: null,
    barrelRateProxySeason: null,
    xBA: null,
    xSLG: null,
    avgFastballVelocity: null,
    avgFastballSpin: null,
    pitchMixPct: { fastball: null, breaking: null, offspeed: null },
  };

  if (!mlbPlayerId || mlbPlayerId === "undefined") return nullResult;

  const cacheKey = `savant_${mlbPlayerId}`;
  const cached = savantCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SAVANT_TTL) return cached.data;

  try {
    const currentYear = new Date().getFullYear();
    const batterUrl =
      `https://baseballsavant.mlb.com/percentile-rankings?type=batter&year=${currentYear}&position=&team=&csv=true`;
    const pitcherUrl =
      `https://baseballsavant.mlb.com/percentile-rankings?type=pitcher&year=${currentYear}&position=&team=&csv=true`;

    // Fetch batter Statcast data
    const [batterRes, pitcherRes] = await Promise.allSettled([
      fetch(batterUrl, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(10000),
      }),
      fetch(pitcherUrl, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(10000),
      }),
    ]);

    let xBA: number | null = null;
    let xSLG: number | null = null;
    let exitVelocity: number | null = null;
    let launchAngle: number | null = null;
    let hitDistance: number | null = null;
    let hardHitRateSeason: number | null = null;
    let barrelRateProxySeason: number | null = null;
    let avgFastballVelocity: number | null = null;
    let avgFastballSpin: number | null = null;
    const pitchMixPct = { fastball: null as number | null, breaking: null as number | null, offspeed: null as number | null };

    if (batterRes.status === "fulfilled" && batterRes.value.ok) {
      const text = await batterRes.value.text();
      const lines = text.split("\n");
      if (lines.length >= 2) {
        const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/"/g, ""));
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",").map((c) => c.trim().replace(/"/g, ""));
          if (!cols[0]) continue;
          const playerIdCol = headers.indexOf("player_id") >= 0 ? headers.indexOf("player_id") : 0;
          if (String(cols[playerIdCol]) !== String(mlbPlayerId)) continue;

          const get = (key: string) => {
            const idx = headers.indexOf(key);
            return idx >= 0 ? safeNum(cols[idx]) : null;
          };

          // Only use raw decimal columns — percentile fallbacks (xba_percentile, xslg_percentile)
          // are on a 0-100 scale and would cause scale mismatch in applyXBAModifier/applyXSLGModifier
          // which compare against league averages in decimal form (0.243, 0.400).
          const rawXBA = get("xba");
          const rawXSLG = get("xslg");
          xBA = rawXBA != null && rawXBA <= 2.0 ? rawXBA : null;
          xSLG = rawXSLG != null && rawXSLG <= 4.0 ? rawXSLG : null;
          exitVelocity = get("exit_velocity_avg") ?? get("avg_ev");
          launchAngle = get("launch_angle_avg");
          hitDistance = get("hit_distance_sc");
          hardHitRateSeason = get("hard_hit_percent");
          barrelRateProxySeason = get("barrel_batted_rate");
          break;
        }
      }
    } else {
      console.warn("[Savant] Batter data fetch failed", batterRes.status === "rejected" ? batterRes.reason : "HTTP error");
    }

    if (pitcherRes.status === "fulfilled" && pitcherRes.value.ok) {
      const text = await pitcherRes.value.text();
      const lines = text.split("\n");
      if (lines.length >= 2) {
        const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/"/g, ""));
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",").map((c) => c.trim().replace(/"/g, ""));
          if (!cols[0]) continue;
          const playerIdCol = headers.indexOf("player_id") >= 0 ? headers.indexOf("player_id") : 0;
          if (String(cols[playerIdCol]) !== String(mlbPlayerId)) continue;

          const get = (key: string) => {
            const idx = headers.indexOf(key);
            return idx >= 0 ? safeNum(cols[idx]) : null;
          };

          avgFastballVelocity = get("fastball_avg_speed") ?? get("ff_avg_speed");
          avgFastballSpin = get("fastball_avg_spin") ?? get("ff_avg_spin");
          const ffPct = get("ff_percent") ?? get("fastball_percent");
          const slPct = get("sl_percent") ?? get("slider_percent");
          const cuPct = get("cu_percent") ?? get("curveball_percent");
          const chPct = get("ch_percent") ?? get("changeup_percent");
          if (ffPct != null) {
            pitchMixPct.fastball = ffPct;
            pitchMixPct.breaking = (slPct ?? 0) + (cuPct ?? 0);
            pitchMixPct.offspeed = chPct ?? null;
          }
          break;
        }
      }
    } else {
      console.warn("[Savant] Pitcher data fetch failed", pitcherRes.status === "rejected" ? pitcherRes.reason : "HTTP error");
    }

    const result: BaseballSavantData = {
      exitVelocity,
      launchAngle,
      hitDistance,
      hardHitRateSeason,
      barrelRateProxySeason,
      xBA,
      xSLG,
      avgFastballVelocity,
      avgFastballSpin,
      pitchMixPct,
    };

    savantCache.set(cacheKey, { data: result, fetchedAt: Date.now() });

    const hasAny = [xBA, xSLG, exitVelocity, avgFastballVelocity].some((v) => v != null);
    if (hasAny) {
      console.log(`[Savant] Player ${mlbPlayerId}: xBA=${xBA} xSLG=${xSLG} EV=${exitVelocity} FBv=${avgFastballVelocity}`);
    }

    return result;
  } catch (err: any) {
    console.warn(`[Savant] fetchBaseballSavantData(${mlbPlayerId}) error:`, err.message);
    return nullResult;
  }
}

export async function fetchMLBComData(
  _playerId: string,
  _gameId: string
): Promise<MLBComData> {
  return {
    battingOrderSlot: 5,
    pitchCount: 0,
    timesThrough: 1,
    inning: 1,
    isTopInning: true,
    currentHits: 0,
    currentTotalBases: 0,
    currentStrikeouts: 0,
    currentHomeRuns: 0,
    plateAppearances: 0,
    atBats: 0,
  };
}

export async function fetchESPNMLBData(
  _gameId: string
): Promise<ESPNMLBData> {
  return {
    gameStatus: "In Progress",
    homeTeam: "",
    awayTeam: "",
    homeScore: 0,
    awayScore: 0,
    inning: 1,
    isTopInning: true,
    playerStats: {},
  };
}
