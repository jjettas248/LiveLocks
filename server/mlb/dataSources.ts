// ── MLB External Data Sources ─────────────────────────────────────────────────
// Fetches data from Baseball Savant (Statcast), Ballpark Pal, and ESPN.
// All calls: try/catch with safe null-fallback returns.

import { getPitchFamily } from "./pitchTypeNormalizer";
import type { PitchMixEntry } from "./types";
import type { PitchTypeBatterSplit } from "./hr/hrOverlayTypes";

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
  // Power profile — Gaps 7–9
  flyBallPercent: number | null;    // % BIP that are fly balls (bb_type="fly_ball")
  hrFBRatio: number | null;         // home runs / fly balls (%)
  xwOBASeason: number | null;       // avg expected wOBA across all BIP this season
  xISOSeason: number | null;        // expected isolated power (xSLG − xBA)
  sweetSpotPercent: number | null;  // % BIP with launch angle 8–32°
  // Batter pull rate — % of BIP hit to the pull side (spray angle from hc_x/hc_y,
  // sign-adjusted for batter stand). Null when hit-coordinate data is unavailable.
  pullRatePercent: number | null;
  // Phase 2 — overlay aggregates from the same per-pitch CSV.
  // Batter xSLG + Whiff% by pitch family (Γ arsenal matchup; usagePct attached later).
  batterPitchSplits: PitchTypeBatterSplit[] | null;
  // % of BBE classified "topped" (launch_speed_angle == 2) — soft-gate input.
  // Null when the column/sample is unavailable.
  toppedPct: number | null;
  // Season max exit velocity (mph) — power/soft-gate input.
  maxEV: number | null;
  // Mound Radar v2 — pitcher "stuff" metrics (swinging strike / called+
  // swinging strike rate, whiff% by pitch family), from the same per-pitch
  // pitcher CSV already fetched for pitchMixPct/avgFastballVelocity above.
  // Null/empty when the pitcher CSV is unavailable or below sample floor —
  // never fabricated.
  pitcherSwStrPct: number | null;
  pitcherCswPct: number | null;
  pitcherWhiffPctByFamily: Partial<Record<"fastball" | "breaking" | "offspeed", number>>;
  pitcherMissesBatsFamily: { family: "fastball" | "breaking" | "offspeed"; whiffPct: number; usagePct: number } | null;
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

// Phase 2 overlay aggregates derived from the per-pitch Statcast CSV
// (`type=details`). Pure over already-fetched rows (no I/O) — unit-testable.
interface SavantPitchContactAgg {
  batterPitchSplits: PitchTypeBatterSplit[] | null; // xSLG + Whiff% by family
  toppedPct: number | null;
  maxEV: number | null;
}

const SAVANT_SWING_DESC = new Set([
  "hit_into_play", "foul", "swinging_strike", "swinging_strike_blocked",
  "foul_tip", "foul_bunt", "missed_bunt", "bunt_foul_tip",
]);
const SAVANT_WHIFF_DESC = new Set([
  "swinging_strike", "swinging_strike_blocked", "missed_bunt",
]);
const SAVANT_CALLED_STRIKE_DESC = new Set(["called_strike"]);

// Sample floor for season-level rate stats (SwStr%/CSW%) — below this, a
// small-sample rate is more noise than signal, so the caller should treat it
// as unavailable rather than publish a misleading number.
const MIN_PITCHES_FOR_PITCHER_RATE = 30;
// Sample floor for a per-pitch-family whiff% (mirrors the batter aggregator's
// `swings >= 10` floor above).
const MIN_SWINGS_FOR_FAMILY_WHIFF = 10;
// A pitch family only counts as "misses bats" when it's both a real part of
// the arsenal (usage floor) and genuinely elite at generating whiffs — a
// show-me pitch thrown 3% of the time with a small-sample 50% whiff% isn't
// a real driver.
const MISSES_BATS_MIN_USAGE_PCT = 15;
const MISSES_BATS_MIN_WHIFF_PCT = 30;

// Pitcher "stuff" aggregates from the same per-pitch Statcast CSV used for
// avgFastballVelocity/spin/pitchMixPct above. Pure over already-fetched rows
// (no I/O) — mirrors aggregateBatterPitchAndContact's pattern for the
// pitcher side. Feeds Mound Radar's pitcherSkill.ts component (SwStr%/CSW%/
// Pitch Mix Misses Bats) — these fields were declared but always null in v1.
interface PitcherStuffAgg {
  swStrPct: number | null;
  cswPct: number | null;
  whiffPctByFamily: Partial<Record<"fastball" | "breaking" | "offspeed", number>>;
  /** The single pitch family that both anchors the arsenal AND misses bats, if any. */
  missesBatsFamily: { family: "fastball" | "breaking" | "offspeed"; whiffPct: number; usagePct: number } | null;
}

export function aggregatePitcherStuffMetrics(rows: Array<Record<string, string>>): PitcherStuffAgg {
  type Fam = "fastball" | "breaking" | "offspeed";
  const fam: Record<Fam, { pitches: number; swings: number; whiffs: number }> = {
    fastball: { pitches: 0, swings: 0, whiffs: 0 },
    breaking: { pitches: 0, swings: 0, whiffs: 0 },
    offspeed: { pitches: 0, swings: 0, whiffs: 0 },
  };
  let totalPitches = 0;
  let totalSwStr = 0;
  let totalCalledOrSwStr = 0;

  for (const row of rows) {
    const desc = (row["description"] ?? "").trim().toLowerCase();
    if (!desc) continue;
    totalPitches++;

    const isWhiff = SAVANT_WHIFF_DESC.has(desc);
    const isSwing = SAVANT_SWING_DESC.has(desc);
    if (isWhiff) totalSwStr++;
    if (isWhiff || SAVANT_CALLED_STRIKE_DESC.has(desc)) totalCalledOrSwStr++;

    const family = getPitchFamily(row["pitch_type"]);
    if (family === "other") continue;
    fam[family].pitches++;
    if (isSwing) {
      fam[family].swings++;
      if (isWhiff) fam[family].whiffs++;
    }
  }

  const swStrPct = totalPitches >= MIN_PITCHES_FOR_PITCHER_RATE ? parseFloat(((totalSwStr / totalPitches) * 100).toFixed(1)) : null;
  const cswPct = totalPitches >= MIN_PITCHES_FOR_PITCHER_RATE ? parseFloat(((totalCalledOrSwStr / totalPitches) * 100).toFixed(1)) : null;

  const families: Fam[] = ["fastball", "breaking", "offspeed"];
  const whiffPctByFamily: PitcherStuffAgg["whiffPctByFamily"] = {};
  let missesBatsFamily: PitcherStuffAgg["missesBatsFamily"] = null;
  for (const f of families) {
    const acc = fam[f];
    if (acc.swings < MIN_SWINGS_FOR_FAMILY_WHIFF) continue;
    const whiffPct = parseFloat(((acc.whiffs / acc.swings) * 100).toFixed(1));
    whiffPctByFamily[f] = whiffPct;
    const usagePct = totalPitches > 0 ? parseFloat(((acc.pitches / totalPitches) * 100).toFixed(1)) : 0;
    if (
      usagePct >= MISSES_BATS_MIN_USAGE_PCT &&
      whiffPct >= MISSES_BATS_MIN_WHIFF_PCT &&
      (!missesBatsFamily || whiffPct > missesBatsFamily.whiffPct)
    ) {
      missesBatsFamily = { family: f, whiffPct, usagePct };
    }
  }

  return { swStrPct, cswPct, whiffPctByFamily, missesBatsFamily };
}

export function aggregateBatterPitchAndContact(
  rows: Array<Record<string, string>>,
): SavantPitchContactAgg {
  type Fam = "fastball" | "breaking" | "offspeed";
  type Acc = { swings: number; whiffs: number; xslgSum: number; xslgN: number };
  const fam: Record<Fam, Acc> = {
    fastball: { swings: 0, whiffs: 0, xslgSum: 0, xslgN: 0 },
    breaking: { swings: 0, whiffs: 0, xslgSum: 0, xslgN: 0 },
    offspeed: { swings: 0, whiffs: 0, xslgSum: 0, xslgN: 0 },
  };
  let maxEV: number | null = null;
  let toppedCount = 0;
  let lsaClassifiedBIP = 0;

  for (const row of rows) {
    const family = getPitchFamily(row["pitch_type"]);
    const desc = (row["description"] ?? "").trim().toLowerCase();
    // Whiff% needs ALL pitches (not just balls in play).
    if (family !== "other" && SAVANT_SWING_DESC.has(desc)) {
      fam[family].swings++;
      if (SAVANT_WHIFF_DESC.has(desc)) fam[family].whiffs++;
    }

    const ev = safeNum(row["launch_speed"]);
    if (ev != null && ev > 0 && ev <= 130 && (maxEV == null || ev > maxEV)) maxEV = ev;

    const bbType = (row["bb_type"] ?? "").trim();
    if (!bbType) continue; // BBE-only aggregates below

    if (family !== "other") {
      const xslg = safeNum(row["estimated_slg_using_speedangle"]);
      if (xslg != null && xslg >= 0 && xslg <= 4.0) {
        fam[family].xslgSum += xslg;
        fam[family].xslgN++;
      }
    }

    // launch_speed_angle: 1=weak 2=topped 3=under 4=flare/burner 5=solid 6=barrel.
    const lsa = safeNum(row["launch_speed_angle"]);
    if (lsa != null) {
      lsaClassifiedBIP++;
      if (lsa === 2) toppedCount++;
    }
  }

  const families: Fam[] = ["fastball", "breaking", "offspeed"];
  const splits: PitchTypeBatterSplit[] = families
    .map((f) => ({
      pitchType: f,
      xSLG: fam[f].xslgN > 0 ? parseFloat((fam[f].xslgSum / fam[f].xslgN).toFixed(3)) : null,
      whiffPct: fam[f].swings >= 10 ? parseFloat(((fam[f].whiffs / fam[f].swings) * 100).toFixed(1)) : null,
    }))
    .filter((s) => s.xSLG != null || s.whiffPct != null);

  return {
    batterPitchSplits: splits.length > 0 ? splits : null,
    toppedPct: lsaClassifiedBIP >= 20 ? parseFloat(((toppedCount / lsaClassifiedBIP) * 100).toFixed(1)) : null,
    maxEV,
  };
}

// Attach the pitcher's per-family usage% to a batter's pitch-type splits so the
// Γ arsenal engine can weight damage by what the pitcher actually throws today.
// Pure; no-op (returns input) when the pitch mix is unavailable.
export function mergePitchUsage(
  splits: PitchTypeBatterSplit[] | null | undefined,
  pitchMix: PitchMixEntry[] | null | undefined,
): PitchTypeBatterSplit[] | null {
  if (!splits || splits.length === 0) return splits ?? null;
  if (!pitchMix || pitchMix.length === 0) return splits;
  const usage: Record<string, number> = { fastball: 0, breaking: 0, offspeed: 0 };
  for (const p of pitchMix) {
    const f = getPitchFamily(p.pitchType);
    if (f === "other") continue;
    usage[f] += safeNum(p.percentage) ?? 0;
  }
  return splits.map((s) => ({ ...s, usagePct: usage[s.pitchType] || null }));
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

// Canonical list of every MLB venue the engine ships a park profile for. Used by
// the shared park/wind fit module (and its regression test) to guarantee full
// venue coverage. Alternate/temporary venues resolve through VENUE_ALIASES /
// resolveVenue() and so do not need their own entry here.
export function getKnownVenueNames(): string[] {
  return Object.keys(PARK_FACTORS);
}

export function isVenueIndoors(venueName: string | null | undefined): boolean {
  if (!venueName) return false;
  const factors = resolveVenue(venueName);
  return factors?.isIndoors ?? false;
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
    flyBallPercent: null,
    hrFBRatio: null,
    xwOBASeason: null,
    xISOSeason: null,
    sweetSpotPercent: null,
    pullRatePercent: null,
    batterPitchSplits: null,
    toppedPct: null,
    maxEV: null,
    pitcherSwStrPct: null,
    pitcherCswPct: null,
    pitcherWhiffPctByFamily: {},
    pitcherMissesBatsFamily: null,
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
  // Power profile accumulators (Gaps 7–9)
  let flyBallPercent: number | null = null;
  let hrFBRatio: number | null = null;
  let xwOBASeason: number | null = null;
  let xISOSeason: number | null = null;
  let sweetSpotPercent: number | null = null;
  let pullRatePercent: number | null = null;
  let batterPitchSplits: PitchTypeBatterSplit[] | null = null;
  let toppedPct: number | null = null;
  let maxEV: number | null = null;
  let pitcherSwStrPct: number | null = null;
  let pitcherCswPct: number | null = null;
  let pitcherWhiffPctByFamily: BaseballSavantData["pitcherWhiffPctByFamily"] = {};
  let pitcherMissesBatsFamily: BaseballSavantData["pitcherMissesBatsFamily"] = null;

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
        // Power profile counters (Gaps 7–9)
        let flyBallBIP = 0;
        let hrAmongFlyBalls = 0;
        let xwobaSum = 0;
        let xwobaCount = 0;
        let sweetSpotBIP = 0;
        // Pull-rate accumulators — spray angle from hit coordinates (hc_x/hc_y),
        // sign-adjusted by batter stand. Pull = >=15° to the batter's pull side.
        let pulledBIP = 0;
        let sprayClassifiedBIP = 0;

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

          // Power profile parsing
          if (bbType === "fly_ball") {
            flyBallBIP++;
            if ((row["events"]?.trim() ?? "") === "home_run") hrAmongFlyBalls++;
          }
          const rawXWOBA = row["estimated_woba_using_speedangle"]?.trim();
          const rowXWOBA = rawXWOBA && rawXWOBA !== "" ? safeNum(rawXWOBA) : null;
          if (rowXWOBA != null && rowXWOBA >= 0 && rowXWOBA <= 2.0) { xwobaSum += rowXWOBA; xwobaCount++; }
          if (la != null && ev != null && ev > 0 && la >= 8 && la <= 32) sweetSpotBIP++;

          // Pull classification from hit coordinates. Spray angle convention:
          //   phi = atan2(hc_x - 125.42, 198.27 - hc_y)  (deg); + = toward RF/1B.
          // Pull side is RF for LHB and LF for RHB, so flip sign for RHB.
          const hcx = safeNum(row["hc_x"]);
          const hcy = safeNum(row["hc_y"]);
          const stand = (row["stand"] ?? "").trim().toUpperCase();
          if (hcx != null && hcy != null && (stand === "L" || stand === "R")) {
            const denom = 198.27 - hcy;
            if (denom !== 0) {
              const phi = (Math.atan2(hcx - 125.42, denom) * 180) / Math.PI;
              const pullAngle = stand === "L" ? phi : -phi;
              if (Number.isFinite(pullAngle)) {
                sprayClassifiedBIP++;
                if (pullAngle >= 15) pulledBIP++;
              }
            }
          }
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

        // Power profile derivations (Gaps 7–9)
        if (totalBIP > 0) flyBallPercent = parseFloat(((flyBallBIP / totalBIP) * 100).toFixed(1));
        if (flyBallBIP > 0) hrFBRatio = parseFloat(((hrAmongFlyBalls / flyBallBIP) * 100).toFixed(1));
        if (xwobaCount > 0) xwOBASeason = parseFloat((xwobaSum / xwobaCount).toFixed(3));
        if (totalBIP > 0) sweetSpotPercent = parseFloat(((sweetSpotBIP / totalBIP) * 100).toFixed(1));
        // Require a minimum spray sample so the rate is stable before it's used.
        if (sprayClassifiedBIP >= 20) pullRatePercent = parseFloat(((pulledBIP / sprayClassifiedBIP) * 100).toFixed(1));
        if (xSLG != null && xBA != null) xISOSeason = parseFloat((xSLG - xBA).toFixed(3));

        // Phase 2 — pitch-family splits + quality-of-contact from the same rows.
        const agg = aggregateBatterPitchAndContact(rows);
        batterPitchSplits = agg.batterPitchSplits;
        toppedPct = agg.toppedPct;
        maxEV = agg.maxEV;
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

        // v2 — pitcher "stuff" metrics (SwStr%/CSW%/whiff-by-family), same
        // rows, no extra fetch. See aggregatePitcherStuffMetrics for the
        // sample-floor/threshold discipline.
        const stuff = aggregatePitcherStuffMetrics(rows);
        pitcherSwStrPct = stuff.swStrPct;
        pitcherCswPct = stuff.cswPct;
        pitcherWhiffPctByFamily = stuff.whiffPctByFamily;
        pitcherMissesBatsFamily = stuff.missesBatsFamily;
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
      flyBallPercent,
      hrFBRatio,
      xwOBASeason,
      xISOSeason,
      sweetSpotPercent,
      pullRatePercent,
      batterPitchSplits,
      toppedPct,
      maxEV,
      pitcherSwStrPct,
      pitcherCswPct,
      pitcherWhiffPctByFamily,
      pitcherMissesBatsFamily,
    };

    savantCache.set(cacheKey, { data: result, fetchedAt: Date.now() });

    const hasAny = [xBA, xSLG, exitVelocity, avgFastballVelocity, avgBatSpeed].some((v) => v != null);
    if (hasAny) {
      console.log(`[Savant] Player ${mlbPlayerId}: xBA=${xBA} xSLG=${xSLG} xwOBA=${xwOBASeason} xISO=${xISOSeason} FB%=${flyBallPercent} HR/FB=${hrFBRatio} SS%=${sweetSpotPercent} EV=${exitVelocity} batSpd=${avgBatSpeed}`);
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

const SAVANT_GAME_CACHE = new Map<string, { fetchedAt: number; data: SavantGamePitchData[] }>();
const SAVANT_GAME_TTL = 90_000;

interface SavantGamePitchData {
  batterId: string;
  pitcherId: string;
  batterName: string;
  pitcherName: string;
  exitVelocity: number | null;
  launchAngle: number | null;
  hitDistance: number | null;
  xBA: number | null;
  xWOBA: number | null;
  bbType: string | null;
  pitchType: string | null;
  releaseSpeed: number | null;
  releaseSpin: number | null;
  events: string | null;
  description: string | null;
  inning: number | null;
}

export async function fetchSavantGameFeed(gamePk: string): Promise<SavantGamePitchData[]> {
  const cacheKey = `savant_game_${gamePk}`;
  const cached = SAVANT_GAME_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SAVANT_GAME_TTL) return cached.data;

  const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfGT=R%7C&game_pk=${gamePk}&player_type=batter&group_by=name&sort_col=pitches&sort_order=desc&min_pitches=0&min_results=0&min_abs=0&type=details`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LiveLocks/1.0)" },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn(`[Savant GameFeed] game_pk=${gamePk} HTTP ${res.status}`);
      return cached?.data ?? [];
    }

    const text = await res.text();
    if (!text || text.length < 50) {
      console.log(`[Savant GameFeed] game_pk=${gamePk} — empty/too short response`);
      return cached?.data ?? [];
    }

    const rows = parseSavantCSV(text);
    const results: SavantGamePitchData[] = [];

    for (const row of rows) {
      const ev = parseFloat(row["launch_speed"]);
      const la = parseFloat(row["launch_angle"]);
      const dist = parseFloat(row["hit_distance_sc"]);
      const xba = parseFloat(row["estimated_ba_using_speedangle"]);
      const xwoba = parseFloat(row["estimated_woba_using_speedangle"]);
      const speed = parseFloat(row["release_speed"]);
      const spin = parseFloat(row["release_spin_rate"]);
      const inn = parseInt(row["inning"]);

      results.push({
        batterId: row["batter"] ?? "",
        pitcherId: row["pitcher"] ?? "",
        batterName: row["player_name"] ?? "",
        pitcherName: "",
        exitVelocity: Number.isFinite(ev) ? ev : null,
        launchAngle: Number.isFinite(la) ? la : null,
        hitDistance: Number.isFinite(dist) ? dist : null,
        xBA: Number.isFinite(xba) ? xba : null,
        xWOBA: Number.isFinite(xwoba) ? xwoba : null,
        bbType: row["bb_type"] || null,
        pitchType: row["pitch_type"] || null,
        releaseSpeed: Number.isFinite(speed) ? speed : null,
        releaseSpin: Number.isFinite(spin) ? spin : null,
        events: row["events"] || null,
        description: row["description"] || null,
        inning: Number.isFinite(inn) ? inn : null,
      });
    }

    console.log(`[Savant GameFeed] game_pk=${gamePk} — ${results.length} pitch rows, ${results.filter(r => r.xBA != null).length} with xBA`);
    SAVANT_GAME_CACHE.set(cacheKey, { fetchedAt: Date.now(), data: results });
    return results;
  } catch (err: any) {
    console.warn(`[Savant GameFeed] game_pk=${gamePk} fetch error: ${err.message}`);
    return cached?.data ?? [];
  }
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
