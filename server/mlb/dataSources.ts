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
  avgBatSpeed: number | null;
  avgSwingLength: number | null;
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
let savantColumnsLogged = false;
const SAVANT_TTL = 4 * 60 * 60 * 1000; // 4 hours — season-level stats change slowly

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
  hrLHB?: number;
  hrRHB?: number;
}

const PARK_FACTORS: Record<string, ParkFactors> = {
  "Coors Field":              { overall: 1.28, hr: 1.35, hits: 1.18, runs: 1.30, isIndoors: false, hrLHB: 1.42, hrRHB: 1.30 },
  "Fenway Park":              { overall: 1.08, hr: 0.98, hits: 1.12, runs: 1.10, isIndoors: false, hrLHB: 0.88, hrRHB: 1.10 },
  "Yankee Stadium":           { overall: 1.10, hr: 1.20, hits: 1.02, runs: 1.12, isIndoors: false, hrLHB: 1.30, hrRHB: 1.12 },
  "Citizens Bank Park":       { overall: 1.07, hr: 1.15, hits: 1.04, runs: 1.08, isIndoors: false, hrLHB: 1.20, hrRHB: 1.10 },
  "Great American Ball Park": { overall: 1.10, hr: 1.22, hits: 1.03, runs: 1.12, isIndoors: false, hrLHB: 1.28, hrRHB: 1.18 },
  "Globe Life Field":         { overall: 1.02, hr: 1.08, hits: 0.98, runs: 1.03, isIndoors: true, hrLHB: 1.12, hrRHB: 1.05 },
  "Wrigley Field":            { overall: 1.05, hr: 1.10, hits: 1.03, runs: 1.06, isIndoors: false, hrLHB: 1.05, hrRHB: 1.15 },
  "Guaranteed Rate Field":    { overall: 1.04, hr: 1.12, hits: 0.99, runs: 1.05, isIndoors: false, hrLHB: 1.16, hrRHB: 1.08 },
  "Kauffman Stadium":         { overall: 1.06, hr: 1.10, hits: 1.02, runs: 1.05, isIndoors: false, hrLHB: 1.08, hrRHB: 1.12 },
  "Minute Maid Park":         { overall: 1.03, hr: 1.08, hits: 1.00, runs: 1.04, isIndoors: true, hrLHB: 1.14, hrRHB: 1.03 },
  "American Family Field":    { overall: 1.02, hr: 1.06, hits: 1.00, runs: 1.03, isIndoors: true, hrLHB: 1.08, hrRHB: 1.04 },
  "Target Field":             { overall: 1.00, hr: 1.02, hits: 0.99, runs: 1.00, isIndoors: false, hrLHB: 0.98, hrRHB: 1.06 },
  "Truist Park":              { overall: 0.99, hr: 1.04, hits: 0.97, runs: 0.99, isIndoors: false, hrLHB: 1.00, hrRHB: 1.08 },
  "Nationals Park":           { overall: 0.99, hr: 1.05, hits: 0.96, runs: 1.00, isIndoors: false, hrLHB: 1.10, hrRHB: 1.00 },
  "Busch Stadium":            { overall: 0.97, hr: 0.95, hits: 0.98, runs: 0.96, isIndoors: false, hrLHB: 0.92, hrRHB: 0.98 },
  "Angel Stadium":            { overall: 0.96, hr: 0.92, hits: 0.97, runs: 0.95, isIndoors: false, hrLHB: 0.88, hrRHB: 0.96 },
  "Comerica Park":            { overall: 0.96, hr: 0.90, hits: 0.98, runs: 0.95, isIndoors: false, hrLHB: 0.82, hrRHB: 0.96 },
  "PNC Park":                 { overall: 0.95, hr: 0.92, hits: 0.97, runs: 0.94, isIndoors: false, hrLHB: 0.86, hrRHB: 0.98 },
  "T-Mobile Park":            { overall: 0.94, hr: 0.88, hits: 0.97, runs: 0.93, isIndoors: true, hrLHB: 0.84, hrRHB: 0.92 },
  "Dodger Stadium":           { overall: 0.97, hr: 1.00, hits: 0.96, runs: 0.97, isIndoors: false, hrLHB: 0.95, hrRHB: 1.05 },
  "loanDepot park":           { overall: 0.93, hr: 0.88, hits: 0.96, runs: 0.92, isIndoors: true, hrLHB: 0.84, hrRHB: 0.92 },
  "Oracle Park":              { overall: 0.88, hr: 0.82, hits: 0.92, runs: 0.87, isIndoors: false, hrLHB: 0.72, hrRHB: 0.90 },
  "Petco Park":               { overall: 0.92, hr: 0.88, hits: 0.95, runs: 0.91, isIndoors: false, hrLHB: 0.84, hrRHB: 0.92 },
  "Chase Field":              { overall: 1.05, hr: 1.10, hits: 1.02, runs: 1.06, isIndoors: true, hrLHB: 1.14, hrRHB: 1.06 },
  "Rogers Centre":            { overall: 1.03, hr: 1.08, hits: 1.00, runs: 1.04, isIndoors: true, hrLHB: 1.12, hrRHB: 1.04 },
  "Citi Field":               { overall: 0.95, hr: 0.95, hits: 0.96, runs: 0.94, isIndoors: false, hrLHB: 0.90, hrRHB: 1.00 },
  "Progressive Field":        { overall: 0.98, hr: 0.96, hits: 0.99, runs: 0.97, isIndoors: false, hrLHB: 0.92, hrRHB: 1.00 },
  "Tropicana Field":          { overall: 0.96, hr: 0.92, hits: 0.97, runs: 0.95, isIndoors: true, hrLHB: 0.90, hrRHB: 0.94 },
  "Sutter Health Park":       { overall: 1.12, hr: 1.15, hits: 1.08, runs: 1.14, isIndoors: false, hrLHB: 1.18, hrRHB: 1.12 },
  "Oriole Park at Camden Yards": { overall: 1.04, hr: 1.12, hits: 1.00, runs: 1.05, isIndoors: false, hrLHB: 1.18, hrRHB: 1.08 },
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

export function getMarketParkFactor(venueName: string | null | undefined, market?: string, batterHand?: string | null): number {
  if (!venueName) return 1.0;
  const factors = resolveVenue(venueName);
  if (!factors) return 1.0;

  if (!market) return factors.overall;

  const m = market.toLowerCase();
  if (m === "home_runs" || m === "hr" || m === "hr_allowed") {
    if (batterHand && (m === "home_runs" || m === "hr")) {
      const hand = batterHand.toUpperCase();
      if (hand === "L" && factors.hrLHB != null) return factors.hrLHB;
      if (hand === "R" && factors.hrRHB != null) return factors.hrRHB;
    }
    return factors.hr;
  }
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
// Primary: Statcast Search CSV endpoint (same as pybaseball uses).
// Fallback: MLB Stats API season stats for batting average / slugging.

function splitCSVRow(line: string): string[] {
  const cols: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      cols.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cols.push(current.trim());
  return cols;
}

function parseSavantCSV(text: string): Array<Record<string, string>> {
  const lines = text.split("\n");
  if (lines.length < 2) return [];
  const headers = splitCSVRow(lines[0]).map((h) => h.toLowerCase().replace(/"/g, ""));
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = splitCSVRow(lines[i]);
    if (cols.length < headers.length * 0.5) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] ?? ""; });
    rows.push(row);
  }
  return rows;
}

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
    avgBatSpeed: null,
    avgSwingLength: null,
    avgFastballVelocity: null,
    avgFastballSpin: null,
    pitchMixPct: { fastball: null, breaking: null, offspeed: null },
  };

  if (!mlbPlayerId || mlbPlayerId === "undefined") return nullResult;

  const cacheKey = `savant_${mlbPlayerId}`;
  const cached = savantCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SAVANT_TTL) return cached.data;

  let xBA: number | null = null;
  let xSLG: number | null = null;
  let exitVelocity: number | null = null;
  let launchAngle: number | null = null;
  let hitDistance: number | null = null;
  let hardHitRateSeason: number | null = null;
  let barrelRateProxySeason: number | null = null;
  let avgBatSpeed: number | null = null;
  let avgSwingLength: number | null = null;
  let avgFastballVelocity: number | null = null;
  let avgFastballSpin: number | null = null;
  const pitchMixPct = { fastball: null as number | null, breaking: null as number | null, offspeed: null as number | null };

  try {
    const currentYear = new Date().getFullYear();
    const seasonStart = `${currentYear}-01-01`;
    const today = new Date().toISOString().split("T")[0];

    const batterUrl = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfPT=&hfAB=&hfGT=R%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones=&hfPull=&hfC=&hfSea=${currentYear}%7C&hfSit=&player_type=batter&hfOuts=&hfOpponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=${seasonStart}&game_date_lt=${today}&hfMo=&hfTeam=&home_road=&hfRO=&position=&hfInfield=&hfOutfield=&hfInn=&hfBBT=&hfFlag=&metric_1=&group_by=name&min_pitches=0&min_results=0&min_pa=1&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&batters_lookup%5B%5D=${mlbPlayerId}&type=details`;
    const pitcherUrl = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfPT=&hfAB=&hfGT=R%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones=&hfPull=&hfC=&hfSea=${currentYear}%7C&hfSit=&player_type=pitcher&hfOuts=&hfOpponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=${seasonStart}&game_date_lt=${today}&hfMo=&hfTeam=&home_road=&hfRO=&position=&hfInfield=&hfOutfield=&hfInn=&hfBBT=&hfFlag=&metric_1=&group_by=name&min_pitches=0&min_results=0&min_pa=1&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&pitchers_lookup%5B%5D=${mlbPlayerId}&type=details`;

    const [batterRes, pitcherRes] = await Promise.allSettled([
      fetch(batterUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; LiveLocks/1.0)" },
        signal: AbortSignal.timeout(12000),
      }),
      fetch(pitcherUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; LiveLocks/1.0)" },
        signal: AbortSignal.timeout(12000),
      }),
    ]);

    if (batterRes.status === "fulfilled" && batterRes.value.ok) {
      const text = await batterRes.value.text();
      const rows = parseSavantCSV(text);
      if (rows.length > 0) {
        if (!savantColumnsLogged) {
          savantColumnsLogged = true;
          const sampleRow = rows[0];
          const colKeys = Object.keys(sampleRow);
          console.log(`[Savant CSV] columns(${colKeys.length}): ${colKeys.slice(0, 15).join(", ")}...`);
          console.log(`[Savant CSV] sample bb_type="${sampleRow["bb_type"]}" launch_speed="${sampleRow["launch_speed"]}" launch_angle="${sampleRow["launch_angle"]}" estimated_ba="${sampleRow["estimated_ba_using_speedangle"]}"`);
        }

        const evs: number[] = [];
        const las: number[] = [];
        const dists: number[] = [];
        let hardHits = 0;
        let barrels = 0;
        let totalBIP = 0;
        let xbaSum = 0;
        let xbaCount = 0;
        let xslgSum = 0;
        let xslgCount = 0;
        let totalRows = 0;
        let bipRows = 0;
        const batSpeeds: number[] = [];
        const swingLengths: number[] = [];

        for (const row of rows) {
          totalRows++;

          const bs = safeNum(row["bat_speed"]);
          const sl = safeNum(row["swing_length"]);
          if (bs != null && bs > 40 && bs <= 100) batSpeeds.push(bs);
          if (sl != null && sl > 0 && sl <= 15) swingLengths.push(sl);

          const bbType = (row["bb_type"] ?? "").trim();
          if (!bbType) continue;
          bipRows++;

          const ev = safeNum(row["launch_speed"]);
          const la = safeNum(row["launch_angle"]);
          const dist = safeNum(row["hit_distance_sc"]);
          const rawXBA = row["estimated_ba_using_speedangle"]?.trim();
          const rawXSLG = row["estimated_slg_using_speedangle"]?.trim();
          const rowXBA = rawXBA && rawXBA !== "" ? safeNum(rawXBA) : null;
          const rowXSLG = rawXSLG && rawXSLG !== "" ? safeNum(rawXSLG) : null;

          if (ev != null && ev > 0 && ev <= 130) {
            evs.push(ev);
            totalBIP++;
            if (ev >= 95) hardHits++;
            if (ev >= 98 && la != null && la >= 20 && la <= 35) barrels++;
          }
          if (la != null && ev != null && ev > 0 && ev <= 130) las.push(la);
          if (dist != null && dist > 0 && dist <= 500) dists.push(dist);
          if (rowXBA != null && rowXBA > 0 && rowXBA <= 1.0) { xbaSum += rowXBA; xbaCount++; }
          if (rowXSLG != null && rowXSLG > 0 && rowXSLG <= 4.0) { xslgSum += rowXSLG; xslgCount++; }
        }

        if (batSpeeds.length > 0) avgBatSpeed = parseFloat((batSpeeds.reduce((a, b) => a + b, 0) / batSpeeds.length).toFixed(1));
        if (swingLengths.length > 0) avgSwingLength = parseFloat((swingLengths.reduce((a, b) => a + b, 0) / swingLengths.length).toFixed(1));

        if (evs.length > 0) exitVelocity = parseFloat((evs.reduce((a, b) => a + b, 0) / evs.length).toFixed(1));
        if (las.length > 0) launchAngle = parseFloat((las.reduce((a, b) => a + b, 0) / las.length).toFixed(1));
        if (dists.length > 0) hitDistance = parseFloat((dists.reduce((a, b) => a + b, 0) / dists.length).toFixed(0));
        if (totalBIP > 0) {
          hardHitRateSeason = parseFloat(((hardHits / totalBIP) * 100).toFixed(1));
          barrelRateProxySeason = parseFloat(((barrels / totalBIP) * 100).toFixed(1));
        }
        if (xbaCount > 0) xBA = parseFloat((xbaSum / xbaCount).toFixed(3));
        if (xslgCount > 0) xSLG = parseFloat((xslgSum / xslgCount).toFixed(3));
      }
    } else {
      console.warn("[Savant] Batter CSV fetch failed — trying MLB Stats API fallback");
      try {
        const fallbackUrl = `https://statsapi.mlb.com/api/v1/people/${mlbPlayerId}/stats?stats=season&group=hitting&season=${new Date().getFullYear()}&gameType=R`;
        const fbRes = await fetch(fallbackUrl, { signal: AbortSignal.timeout(8000) });
        if (fbRes.ok) {
          const fbData = await fbRes.json();
          const splits = fbData.stats?.[0]?.splits ?? [];
          if (splits.length > 0) {
            const s = splits[0].stat ?? {};
            xBA = safeNum(s.avg);
            xSLG = safeNum(s.slg);
          }
        }
      } catch {}
    }

    if (pitcherRes.status === "fulfilled" && pitcherRes.value.ok) {
      const text = await pitcherRes.value.text();
      const rows = parseSavantCSV(text);
      if (rows.length > 0) {
        const velos: number[] = [];
        const spins: number[] = [];
        const pitchTypeCounts: Record<string, number> = {};

        for (const row of rows) {
          const vel = safeNum(row["release_speed"]);
          const spin = safeNum(row["release_spin_rate"]);
          const pType = (row["pitch_type"] ?? "").toUpperCase();

          if (vel != null) velos.push(vel);
          if (spin != null) spins.push(spin);
          if (pType) pitchTypeCounts[pType] = (pitchTypeCounts[pType] ?? 0) + 1;
        }

        if (velos.length > 0) avgFastballVelocity = parseFloat((velos.reduce((a, b) => a + b, 0) / velos.length).toFixed(1));
        if (spins.length > 0) avgFastballSpin = parseFloat((spins.reduce((a, b) => a + b, 0) / spins.length).toFixed(0));

        const totalP = Object.values(pitchTypeCounts).reduce((a, b) => a + b, 0);
        if (totalP > 0) {
          const fbTypes = ["FF", "SI", "FC", "FT"];
          const breakingTypes = ["SL", "CU", "KC", "CS", "SV", "ST"];
          const offspeedTypes = ["CH", "FS", "SC", "KN"];
          const fbCount = fbTypes.reduce((s, t) => s + (pitchTypeCounts[t] ?? 0), 0);
          const brCount = breakingTypes.reduce((s, t) => s + (pitchTypeCounts[t] ?? 0), 0);
          const osCount = offspeedTypes.reduce((s, t) => s + (pitchTypeCounts[t] ?? 0), 0);
          pitchMixPct.fastball = parseFloat(((fbCount / totalP) * 100).toFixed(1));
          pitchMixPct.breaking = parseFloat(((brCount / totalP) * 100).toFixed(1));
          pitchMixPct.offspeed = parseFloat(((osCount / totalP) * 100).toFixed(1));
        }
      }
    } else {
      console.warn("[Savant] Pitcher CSV fetch failed");
    }

    const result: BaseballSavantData = {
      exitVelocity,
      launchAngle,
      hitDistance,
      hardHitRateSeason,
      barrelRateProxySeason,
      xBA,
      xSLG,
      avgBatSpeed,
      avgSwingLength,
      avgFastballVelocity,
      avgFastballSpin,
      pitchMixPct,
    };

    savantCache.set(cacheKey, { data: result, fetchedAt: Date.now() });

    const hasAny = [xBA, xSLG, exitVelocity, avgFastballVelocity, avgBatSpeed].some((v) => v != null);
    if (hasAny) {
      console.log(`[Savant] Player ${mlbPlayerId}: xBA=${xBA} xSLG=${xSLG} EV=${exitVelocity} batSpd=${avgBatSpeed} swgLen=${avgSwingLength} FBv=${avgFastballVelocity}`);
    }

    return result;
  } catch (err: any) {
    console.warn(`[Savant] fetchBaseballSavantData(${mlbPlayerId}) error:`, err.message);

    const stale = savantCache.get(cacheKey);
    if (stale && stale.data && (stale.data.xBA != null || stale.data.xSLG != null)) {
      console.log(`[Savant] Using stale cache for ${mlbPlayerId} (age=${Math.round((Date.now() - stale.fetchedAt) / 60000)}min)`);
      return stale.data;
    }

    const fallbackResult = { ...nullResult };
    try {
      const currentYear = new Date().getFullYear();
      const fallbackUrl = `https://statsapi.mlb.com/api/v1/people/${mlbPlayerId}/stats?stats=season&group=hitting&season=${currentYear}&gameType=R`;
      const fbRes = await fetch(fallbackUrl, { signal: AbortSignal.timeout(8000) });
      if (fbRes.ok) {
        const fbData = await fbRes.json();
        const splits = fbData.stats?.[0]?.splits ?? [];
        if (splits.length > 0) {
          const s = splits[0].stat ?? {};
          fallbackResult.xBA = safeNum(s.avg);
          fallbackResult.xSLG = safeNum(s.slg);
          if (fallbackResult.xBA != null || fallbackResult.xSLG != null) {
            savantCache.set(cacheKey, { data: fallbackResult, fetchedAt: Date.now() });
            console.log(`[Savant] MLB API fallback for ${mlbPlayerId}: BA=${fallbackResult.xBA} SLG=${fallbackResult.xSLG}`);
          }
        }
      }
    } catch {}
    return fallbackResult;
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
