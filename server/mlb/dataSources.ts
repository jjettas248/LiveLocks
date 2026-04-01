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

// Cache for Savant data (updated infrequently — season stats)
const savantCache = new Map<string, { data: BaseballSavantData; fetchedAt: number }>();
const SAVANT_TTL = 30 * 60 * 1000; // 30 min

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface ParkFactors {
  overall: number;
  hr: number;
  hits: number;
  runs: number;
  isIndoors: boolean;
}

const PARK_FACTORS: Record<string, ParkFactors> = {
  "Coors Field":              { overall: 1.28, hr: 1.35, hits: 1.18, runs: 1.30, isIndoors: false },
  "Fenway Park":              { overall: 1.08, hr: 0.98, hits: 1.12, runs: 1.10, isIndoors: false },
  "Yankee Stadium":           { overall: 1.10, hr: 1.20, hits: 1.02, runs: 1.12, isIndoors: false },
  "Citizens Bank Park":       { overall: 1.07, hr: 1.15, hits: 1.04, runs: 1.08, isIndoors: false },
  "Great American Ball Park": { overall: 1.10, hr: 1.22, hits: 1.03, runs: 1.12, isIndoors: false },
  "Globe Life Field":         { overall: 1.02, hr: 1.08, hits: 0.98, runs: 1.03, isIndoors: true },
  "Wrigley Field":            { overall: 1.05, hr: 1.10, hits: 1.03, runs: 1.06, isIndoors: false },
  "Guaranteed Rate Field":    { overall: 1.04, hr: 1.12, hits: 0.99, runs: 1.05, isIndoors: false },
  "Kauffman Stadium":         { overall: 1.06, hr: 1.10, hits: 1.02, runs: 1.05, isIndoors: false },
  "Minute Maid Park":         { overall: 1.03, hr: 1.08, hits: 1.00, runs: 1.04, isIndoors: true },
  "American Family Field":    { overall: 1.02, hr: 1.06, hits: 1.00, runs: 1.03, isIndoors: true },
  "Target Field":             { overall: 1.00, hr: 1.02, hits: 0.99, runs: 1.00, isIndoors: false },
  "Truist Park":              { overall: 0.99, hr: 1.04, hits: 0.97, runs: 0.99, isIndoors: false },
  "Nationals Park":           { overall: 0.99, hr: 1.05, hits: 0.96, runs: 1.00, isIndoors: false },
  "Busch Stadium":            { overall: 0.97, hr: 0.95, hits: 0.98, runs: 0.96, isIndoors: false },
  "Angel Stadium":            { overall: 0.96, hr: 0.92, hits: 0.97, runs: 0.95, isIndoors: false },
  "Comerica Park":            { overall: 0.96, hr: 0.90, hits: 0.98, runs: 0.95, isIndoors: false },
  "PNC Park":                 { overall: 0.95, hr: 0.92, hits: 0.97, runs: 0.94, isIndoors: false },
  "T-Mobile Park":            { overall: 0.94, hr: 0.88, hits: 0.97, runs: 0.93, isIndoors: true },
  "Dodger Stadium":           { overall: 0.97, hr: 1.00, hits: 0.96, runs: 0.97, isIndoors: false },
  "loanDepot park":           { overall: 0.93, hr: 0.88, hits: 0.96, runs: 0.92, isIndoors: true },
  "Oracle Park":              { overall: 0.88, hr: 0.82, hits: 0.92, runs: 0.87, isIndoors: false },
  "Petco Park":               { overall: 0.92, hr: 0.88, hits: 0.95, runs: 0.91, isIndoors: false },
  "Chase Field":              { overall: 1.05, hr: 1.10, hits: 1.02, runs: 1.06, isIndoors: true },
  "Rogers Centre":            { overall: 1.03, hr: 1.08, hits: 1.00, runs: 1.04, isIndoors: true },
  "Citi Field":               { overall: 0.95, hr: 0.95, hits: 0.96, runs: 0.94, isIndoors: false },
  "Progressive Field":        { overall: 0.98, hr: 0.96, hits: 0.99, runs: 0.97, isIndoors: false },
  "Tropicana Field":          { overall: 0.96, hr: 0.92, hits: 0.97, runs: 0.95, isIndoors: true },
  "Sutter Health Park":       { overall: 1.12, hr: 1.15, hits: 1.08, runs: 1.14, isIndoors: false },
  "Oriole Park at Camden Yards": { overall: 1.04, hr: 1.12, hits: 1.00, runs: 1.05, isIndoors: false },
};

const VENUE_ALIASES: Record<string, string> = {
  "Camden Yards": "Oriole Park at Camden Yards",
  "Loan Depot Park": "loanDepot park",
  "LoanDepot Park": "loanDepot park",
  "Miami Marlins Park": "loanDepot park",
  "Marlins Park": "loanDepot park",
  "Oakland Coliseum": "Sutter Health Park",
  "Oakland-Alameda County Coliseum": "Sutter Health Park",
  "RingCentral Coliseum": "Sutter Health Park",
  "SkyDome": "Rogers Centre",
  "US Cellular Field": "Guaranteed Rate Field",
  "Miller Park": "American Family Field",
  "Safeco Field": "T-Mobile Park",
  "Daikin Park": "Minute Maid Park",
  "UNIQLO Field at Dodger Stadium": "Dodger Stadium",
};

function resolveVenue(venueName: string): ParkFactors | null {
  if (PARK_FACTORS[venueName]) return PARK_FACTORS[venueName];
  const alias = VENUE_ALIASES[venueName];
  if (alias && PARK_FACTORS[alias]) return PARK_FACTORS[alias];
  const lower = venueName.toLowerCase();
  for (const [name, factors] of Object.entries(PARK_FACTORS)) {
    if (lower.includes(name.toLowerCase().split(" ")[0]) || name.toLowerCase().includes(lower.split(" ")[0])) {
      return factors;
    }
  }
  return null;
}

export function getMarketParkFactor(venueName: string | null | undefined, market?: string): number {
  if (!venueName) return 1.0;
  const factors = resolveVenue(venueName);
  if (!factors) return 1.0;

  if (!market) return factors.overall;

  const m = market.toLowerCase();
  if (m === "home_runs" || m === "hr" || m === "hr_allowed") return factors.hr;
  if (m === "hits" || m === "hits_allowed") return factors.hits;
  if (m === "hrr") return (factors.hits + factors.runs + factors.hr) / 3;
  if (m === "total_bases") return (factors.hits + factors.hr) / 2;
  return factors.overall;
}

export function getVenueParkFactors(venueName: string | null | undefined): ParkFactors | null {
  if (!venueName) return null;
  return resolveVenue(venueName);
}

export function isVenueIndoors(venueName: string | null | undefined): boolean {
  if (!venueName) return false;
  const factors = resolveVenue(venueName);
  return factors?.isIndoors ?? false;
}

export async function fetchBallparkPalData(
  _gameId: string,
  venueName?: string | null
): Promise<BallparkPalData> {
  const pf = venueName ? getMarketParkFactor(venueName) : 1.0;
  const indoor = isVenueIndoors(venueName);
  return {
    parkFactor: pf,
    temperature: null,
    windSpeed: null,
    windDirection: null,
    humidity: null,
    isIndoors: indoor,
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

// ── Stadium Coordinates (for Open-Meteo weather pre-hydration) ────────────────
export const STADIUM_COORDS: Record<string, { lat: number; lon: number; orientation: number }> = {
  "Coors Field":              { lat: 39.7559, lon: -104.9942, orientation: 20 },
  "Fenway Park":              { lat: 42.3467, lon: -71.0972, orientation: 68 },
  "Yankee Stadium":           { lat: 40.8296, lon: -73.9262, orientation: 52 },
  "Citizens Bank Park":       { lat: 39.9061, lon: -75.1665, orientation: 45 },
  "Great American Ball Park": { lat: 39.0974, lon: -84.5082, orientation: 10 },
  "Globe Life Field":         { lat: 32.7473, lon: -97.0845, orientation: 18 },
  "Wrigley Field":            { lat: 41.9484, lon: -87.6553, orientation: 30 },
  "Guaranteed Rate Field":    { lat: 41.8299, lon: -87.6338, orientation: 20 },
  "Kauffman Stadium":         { lat: 39.0517, lon: -94.4803, orientation: 10 },
  "Minute Maid Park":         { lat: 29.7573, lon: -95.3555, orientation: 20 },
  "American Family Field":    { lat: 43.0280, lon: -87.9712, orientation: 50 },
  "Target Field":             { lat: 44.9817, lon: -93.2778, orientation: 30 },
  "Truist Park":              { lat: 33.8907, lon: -84.4677, orientation: 10 },
  "Nationals Park":           { lat: 38.8730, lon: -77.0074, orientation: 40 },
  "Busch Stadium":            { lat: 38.6226, lon: -90.1928, orientation: 15 },
  "Angel Stadium":            { lat: 33.8003, lon: -117.8827, orientation: 30 },
  "Comerica Park":            { lat: 42.3390, lon: -83.0485, orientation: 30 },
  "PNC Park":                 { lat: 40.4469, lon: -80.0057, orientation: 25 },
  "T-Mobile Park":            { lat: 47.5914, lon: -122.3325, orientation: 5 },
  "Dodger Stadium":           { lat: 34.0739, lon: -118.2400, orientation: 22 },
  "loanDepot park":           { lat: 25.7781, lon: -80.2196, orientation: 20 },
  "Oracle Park":              { lat: 37.7786, lon: -122.3893, orientation: 30 },
  "Petco Park":               { lat: 32.7076, lon: -117.1570, orientation: 20 },
  "Chase Field":              { lat: 33.4455, lon: -112.0667, orientation: 15 },
  "Rogers Centre":            { lat: 43.6414, lon: -79.3894, orientation: 45 },
  "Citi Field":               { lat: 40.7571, lon: -73.8458, orientation: 50 },
  "Progressive Field":        { lat: 41.4962, lon: -81.6852, orientation: 20 },
  "Tropicana Field":          { lat: 27.7682, lon: -82.6534, orientation: 40 },
  "Sutter Health Park":       { lat: 38.5805, lon: -121.5009, orientation: 25 },
  "Oriole Park at Camden Yards": { lat: 39.2838, lon: -76.6216, orientation: 30 },
};

export function getStadiumCoords(venueName: string | null | undefined): { lat: number; lon: number; orientation: number } | null {
  if (!venueName) return null;
  if (STADIUM_COORDS[venueName]) return STADIUM_COORDS[venueName];
  const alias = VENUE_ALIASES[venueName];
  if (alias && STADIUM_COORDS[alias]) return STADIUM_COORDS[alias];
  const lower = venueName.toLowerCase();
  for (const [name, coords] of Object.entries(STADIUM_COORDS)) {
    if (lower.includes(name.toLowerCase().split(" ")[0]) || name.toLowerCase().includes(lower.split(" ")[0])) {
      return coords;
    }
  }
  return null;
}

export function windDirectionRelativeToField(
  windDegrees: number,
  fieldOrientation: number
): "in" | "out" | "cross" | "calm" {
  const relative = ((windDegrees - fieldOrientation) % 360 + 360) % 360;
  if (relative >= 150 && relative <= 210) return "out";
  if (relative >= 330 || relative <= 30) return "in";
  return "cross";
}
