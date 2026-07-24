// Mound Radar — opponent hitter strikeout propensity.
//
// Mission-critical counterpart to the pitcher's own handedness K splits. Fetches
// each confirmed opposing hitter's season strikeout rate against the starter's
// throwing hand, shrinks thin split samples toward the league prior, then
// aggregates the lineup with a small batting-order opportunity weight.
//
// This is DATA ONLY. Scoring remains in opponentKProfile.ts. The cache is
// process-local and long-lived because season handedness splits move slowly.

export interface OpponentLineupKProfile {
  lineupKRate: number | null;
  rawLineupKRate: number | null;
  coverage: number;
  hittersAvailable: number;
  hittersRequested: number;
  highKShare: number | null;
  totalSplitPa: number;
}

interface BatterKHandSplits {
  kRateVsLHP: number | null;
  kRateVsRHP: number | null;
  paVsLHP: number;
  paVsRHP: number;
}

export interface OpponentLineupKEntry {
  playerId: string;
  battingOrderSlot: number | null;
}

const LEAGUE_K_RATE = 0.223;
const SPLIT_PRIOR_PA = 80;
const MIN_SPLIT_PA = 10;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { data: BatterKHandSplits; fetchedAt: number }>();

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function shrinkRate(raw: number, pa: number): number {
  const w = pa / (pa + SPLIT_PRIOR_PA);
  return LEAGUE_K_RATE + (raw - LEAGUE_K_RATE) * w;
}

function splitPa(stat: any): number {
  const direct = safeNum(stat?.plateAppearances);
  if (direct != null && direct >= 0) return direct;
  const ab = safeNum(stat?.atBats) ?? 0;
  const bb = safeNum(stat?.baseOnBalls) ?? 0;
  const hbp = safeNum(stat?.hitByPitch) ?? 0;
  const sf = safeNum(stat?.sacFlies) ?? 0;
  return ab + bb + hbp + sf;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": "LiveLocks/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchBatterKHandSplits(playerId: string): Promise<BatterKHandSplits | null> {
  if (!playerId) return null;
  const cached = cache.get(playerId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  try {
    const season = new Date().getFullYear();
    const url = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=statSplits&sitCodes=vl,vr&group=hitting&season=${season}&gameType=R`;
    const data = await fetchJson(url);
    const result: BatterKHandSplits = {
      kRateVsLHP: null,
      kRateVsRHP: null,
      paVsLHP: 0,
      paVsRHP: 0,
    };

    for (const split of data?.stats?.[0]?.splits ?? []) {
      const code = String(split?.split?.code ?? "").toLowerCase();
      const description = String(split?.split?.description ?? "").toLowerCase();
      const stat = split?.stat ?? {};
      const pa = splitPa(stat);
      const strikeouts = safeNum(stat?.strikeOuts);
      const raw = pa >= MIN_SPLIT_PA && strikeouts != null ? clamp01(strikeouts / pa) : null;
      const shrunk = raw != null ? shrinkRate(raw, pa) : null;
      const isLeft = code === "vl" || description.includes("left");
      const isRight = code === "vr" || description.includes("right");
      if (isLeft) {
        result.paVsLHP = pa;
        result.kRateVsLHP = shrunk;
      } else if (isRight) {
        result.paVsRHP = pa;
        result.kRateVsRHP = shrunk;
      }
    }

    cache.set(playerId, { data: result, fetchedAt: Date.now() });
    return result;
  } catch {
    return null;
  }
}

function orderWeight(slot: number | null): number {
  // Top-order hitters are modestly more likely to face the starter one extra
  // time. Keep the adjustment deliberately narrow so lineup talent, not slot,
  // remains the dominant signal.
  if (slot == null || slot < 1 || slot > 9) return 1;
  return [1.10, 1.08, 1.06, 1.04, 1.01, 0.99, 0.96, 0.94, 0.92][slot - 1];
}

function resolveVsHand(splits: BatterKHandSplits, pitcherThrows: "L" | "R" | null): { rate: number | null; pa: number } {
  if (pitcherThrows === "L") return { rate: splits.kRateVsLHP, pa: splits.paVsLHP };
  if (pitcherThrows === "R") return { rate: splits.kRateVsRHP, pa: splits.paVsRHP };

  const parts = [
    { rate: splits.kRateVsLHP, pa: splits.paVsLHP },
    { rate: splits.kRateVsRHP, pa: splits.paVsRHP },
  ].filter((p): p is { rate: number; pa: number } => p.rate != null && p.pa > 0);
  if (parts.length === 0) return { rate: null, pa: 0 };
  const totalPa = parts.reduce((sum, p) => sum + p.pa, 0);
  return {
    rate: parts.reduce((sum, p) => sum + p.rate * p.pa, 0) / totalPa,
    pa: totalPa,
  };
}

export async function fetchOpponentLineupKProfile(
  lineup: OpponentLineupKEntry[],
  pitcherThrows: "L" | "R" | null,
): Promise<OpponentLineupKProfile> {
  const hittersRequested = lineup.length;
  if (hittersRequested === 0) {
    return { lineupKRate: null, rawLineupKRate: null, coverage: 0, hittersAvailable: 0, hittersRequested: 0, highKShare: null, totalSplitPa: 0 };
  }

  const rows = await Promise.all(
    lineup.map(async (entry) => {
      const splits = await fetchBatterKHandSplits(entry.playerId);
      if (!splits) return null;
      const resolved = resolveVsHand(splits, pitcherThrows);
      if (resolved.rate == null || resolved.pa <= 0) return null;
      return { ...resolved, weight: orderWeight(entry.battingOrderSlot) };
    }),
  );

  const available = rows.filter((r): r is NonNullable<typeof r> => r != null);
  if (available.length === 0) {
    return { lineupKRate: null, rawLineupKRate: null, coverage: 0, hittersAvailable: 0, hittersRequested, highKShare: null, totalSplitPa: 0 };
  }

  const weightSum = available.reduce((sum, r) => sum + r.weight, 0);
  const lineupKRate = available.reduce((sum, r) => sum + r.rate * r.weight, 0) / weightSum;
  // The fetched rates are already shrinkage-adjusted. `rawLineupKRate` is kept
  // as a named diagnostic seam for future raw-vs-shrunk capture; today it is the
  // same lineup aggregate rather than fabricating an unshrunk value we did not
  // retain per row.
  const rawLineupKRate = lineupKRate;
  const highKShare = available.filter((r) => r.rate >= 0.26).length / available.length;

  return {
    lineupKRate: clamp01(lineupKRate),
    rawLineupKRate: clamp01(rawLineupKRate),
    coverage: available.length / hittersRequested,
    hittersAvailable: available.length,
    hittersRequested,
    highKShare,
    totalSplitPa: available.reduce((sum, r) => sum + r.pa, 0),
  };
}
