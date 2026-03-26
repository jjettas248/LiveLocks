// ── BartTorvik Efficiency Service ─────────────────────────────────────────────
// Fetches offensive efficiency, defensive efficiency, tempo, and luck factor
// from the BartTorvik public API for NCAAB teams.
// This module is the canonical typed interface — it implements the fetch client
// directly and exposes BartTorvikEfficiency for use by ncaabEngine.ts.

const BARTTORVIK_BASE = "https://barttorvik.com";
const BT_CACHE = new Map<string, { data: BartTorvikEfficiency; fetchedAt: number }>();
const BT_TTL = 6 * 60 * 60 * 1000; // 6h

/**
 * Fetch offensive/defensive efficiency, tempo, and luck factor for a team
 * from the BartTorvik public API.  Returns null on fetch failure or parse error.
 */
export async function fetchBartTorvikEfficiency(teamName: string): Promise<BartTorvikEfficiency | null> {
  const key = teamName.toLowerCase().trim();
  const cached = BT_CACHE.get(key);
  if (cached && Date.now() - cached.fetchedAt < BT_TTL) return cached.data;

  try {
    const url = `${BARTTORVIK_BASE}/team.php?team=${encodeURIComponent(teamName)}&json=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      console.warn(`[BartTorvik] HTTP ${res.status} for team: ${teamName}`);
      return null;
    }
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : data;
    if (!entry) return null;

    const result: BartTorvikEfficiency = {
      teamName,
      adjO: parseFloat(entry.adjoe ?? entry.adjO ?? entry.adj_o ?? 100),
      adjD: parseFloat(entry.adjde ?? entry.adjD ?? entry.adj_d ?? 100),
      tempo: parseFloat(entry.tempo ?? entry.adj_tempo ?? 68.5),
      barthag: parseFloat(entry.barthag ?? 0.5),
      efgPct: parseFloat(entry.efg ?? entry.efgPct ?? 0.5),
      tovPct: parseFloat(entry.to ?? entry.tovPct ?? 0.18),
      orbPct: parseFloat(entry.orb ?? entry.orbPct ?? 0.27),
      ftRate: parseFloat(entry.ftr ?? entry.ftRate ?? 0.33),
      rank: parseInt(entry.rank ?? entry.rk ?? 200, 10),
      source: "barttorvik",
    };

    BT_CACHE.set(key, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (err: any) {
    console.warn(`[BartTorvik] Fetch error for ${teamName}:`, err.message);
    return null;
  }
}

export interface BartTorvikEfficiency {
  teamName: string;
  adjO: number;
  adjD: number;
  tempo: number;
  barthag: number;
  efgPct: number;
  tovPct: number;
  orbPct: number;
  ftRate: number;
  rank: number;
  source: "barttorvik";
}

export function derivePossessionRate(
  homeEfficiency: BartTorvikEfficiency | null,
  awayEfficiency: BartTorvikEfficiency | null
): number {
  const AVG_TEMPO = 68.5;
  const homeTempo = homeEfficiency?.tempo ?? AVG_TEMPO;
  const awayTempo = awayEfficiency?.tempo ?? AVG_TEMPO;
  const blendedTempo = (homeTempo + awayTempo) / 2;
  return blendedTempo;
}

export function deriveExpectedTotal(
  homeEfficiency: BartTorvikEfficiency | null,
  awayEfficiency: BartTorvikEfficiency | null
): number | null {
  if (!homeEfficiency || !awayEfficiency) return null;
  const homePPP = homeEfficiency.adjO / 100;
  const awayPPP = awayEfficiency.adjO / 100;
  const possessions = derivePossessionRate(homeEfficiency, awayEfficiency);
  const homeExpected = homePPP * possessions;
  const awayExpected = awayPPP * possessions;
  return parseFloat((homeExpected + awayExpected).toFixed(1));
}

export function computeEfficiencyAdjustment(
  homeEfficiency: BartTorvikEfficiency | null,
  awayEfficiency: BartTorvikEfficiency | null,
  baseProjection: number
): number {
  const derived = deriveExpectedTotal(homeEfficiency, awayEfficiency);
  if (derived === null) return 0;
  const blendWeight = 0.25;
  return (derived - baseProjection) * blendWeight;
}

export function computeH2EfficiencyBonus(
  homeEfficiency: BartTorvikEfficiency | null,
  awayEfficiency: BartTorvikEfficiency | null
): number {
  if (!homeEfficiency || !awayEfficiency) return 0;
  const avgFTRate = (homeEfficiency.ftRate + awayEfficiency.ftRate) / 2;
  const avgFoulRate = avgFTRate;
  if (avgFoulRate >= 0.40) return 1.5;
  if (avgFoulRate >= 0.35) return 0.8;
  return 0;
}
