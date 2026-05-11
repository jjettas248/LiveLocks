import type { PersistedPlay } from "@shared/schema";
import { EXCLUDED_FROM_PRIMARY_MLB_ROI } from "../analytics/mlbMarketGroups";

// ─────────────────────────────────────────────────────────────────────────────
// [PRIMARY ROI EXCLUSION v1] User-facing dashboards report a "Core Engine ROI"
// that excludes high-variance markets which the engine is not optimized for.
// The canonical exclusion list now lives in
// `server/analytics/mlbMarketGroups.ts` (single source of truth) and is
// re-exported here under its historical name for backward-compatible imports.
// ─────────────────────────────────────────────────────────────────────────────
export const EXCLUDED_FROM_PRIMARY_ROI: readonly string[] = EXCLUDED_FROM_PRIMARY_MLB_ROI;

/** Returns true if a play's market is excluded from the primary (headline) ROI. */
export function isExcludedFromPrimaryRoi(market: string | null | undefined): boolean {
  if (!market) return false;
  return EXCLUDED_FROM_PRIMARY_ROI.includes(market);
}

/** Filter plays down to those that count toward the primary (headline) ROI. */
export function filterPrimaryRoiPlays<T extends { market?: string | null }>(plays: T[]): T[] {
  return plays.filter(p => !isExcludedFromPrimaryRoi(p.market ?? null));
}

/**
 * Structured log emitted whenever a surface applies the primary-ROI filter.
 * Mirrors the [MLB_SIGNAL_TIER] / [MLB_CANONICAL_PROBABILITY] pattern so
 * downstream observability can detect drift if a surface forgets to filter.
 */
export function logRoiFilterApplied(meta: {
  surface: string;
  totalPlays: number;
  primaryPlays: number;
  excludedMarkets?: readonly string[];
}): void {
  const removed = meta.totalPlays - meta.primaryPlays;
  console.log("[ROI_FILTER_APPLIED]", {
    surface: meta.surface,
    totalPlays: meta.totalPlays,
    primaryPlays: meta.primaryPlays,
    removed,
    excludedMarkets: meta.excludedMarkets ?? EXCLUDED_FROM_PRIMARY_ROI,
  });
}

export function calculatePayout(play: PersistedPlay): number {
  const stake = play.stake ? parseFloat(String(play.stake)) : 1;
  const odds = play.odds ? parseFloat(String(play.odds)) : null;
  const result = play.result;

  if (result === "push") return 0;
  if (result !== "hit") return -stake;

  if (odds == null || !Number.isFinite(odds)) return stake * 0.9091;

  if (odds > 0) {
    return (odds / 100) * stake;
  } else {
    return (100 / Math.abs(odds)) * stake;
  }
}

export interface ROIMetrics {
  totalBets: number;
  totalProfit: number;
  totalStake: number;
  roi: number;
  hitRate: number;
  hits: number;
  misses: number;
  pushes: number;
  pending: number;
}

/**
 * Headline / dashboard ROI: excludes EXCLUDED_FROM_PRIMARY_ROI markets
 * (home_runs, batter_strikeouts). This is what users see on the public
 * proof strip, trust track record, and admin headline summary.
 */
export function getPrimaryROIMetrics(plays: PersistedPlay[]): ROIMetrics {
  return getROIMetrics(filterPrimaryRoiPlays(plays));
}

export function getROIMetrics(plays: PersistedPlay[]): ROIMetrics {
  // Phase 9.1 — "void" results (player DNP) are settled (terminal) but
  // intentionally excluded from totalBets/hits/misses/pushes/ROI/hitRate.
  // They are NOT counted as "pending" either — they're complete with no
  // financial consequence. The settled filter below already excludes void
  // since it's not in the allowed-result set.
  const settled = plays.filter(p => p.result === "hit" || p.result === "miss" || p.result === "push");
  const pending = plays.filter(p => !p.result || p.result === null).length;
  const hits = settled.filter(p => p.result === "hit").length;
  const misses = settled.filter(p => p.result === "miss").length;
  const pushes = settled.filter(p => p.result === "push").length;

  const totalStake = settled.reduce((acc, p) => acc + (p.stake ? parseFloat(String(p.stake)) : 1), 0);
  const totalProfit = settled.reduce((acc, p) => acc + calculatePayout(p), 0);
  const roi = totalStake > 0 ? (totalProfit / totalStake) * 100 : 0;
  const hitRate = settled.length > 0 ? (hits / settled.length) * 100 : 0;

  return {
    totalBets: settled.length,
    totalProfit: Math.round(totalProfit * 100) / 100,
    totalStake: Math.round(totalStake * 100) / 100,
    roi: Math.round(roi * 10) / 10,
    hitRate: Math.round(hitRate * 10) / 10,
    hits,
    misses,
    pushes,
    pending,
  };
}

export interface SegmentedROI {
  segment: string;
  metrics: ROIMetrics;
}

export function groupBySport(plays: PersistedPlay[]): SegmentedROI[] {
  const groups = new Map<string, PersistedPlay[]>();
  for (const p of plays) {
    const sport = (p.sport ?? "unknown").toUpperCase();
    if (!groups.has(sport)) groups.set(sport, []);
    groups.get(sport)!.push(p);
  }
  return Array.from(groups.entries()).map(([segment, ps]) => ({
    segment,
    metrics: getROIMetrics(ps),
  }));
}

export function groupByMarket(plays: PersistedPlay[]): SegmentedROI[] {
  const groups = new Map<string, PersistedPlay[]>();
  for (const p of plays) {
    const market = p.market ?? "unknown";
    if (!groups.has(market)) groups.set(market, []);
    groups.get(market)!.push(p);
  }
  return Array.from(groups.entries())
    .map(([segment, ps]) => ({ segment, metrics: getROIMetrics(ps) }))
    .sort((a, b) => b.metrics.totalBets - a.metrics.totalBets);
}

/**
 * Segmented per-market ROI breakdown that explicitly flags which markets are
 * excluded from the primary (headline) ROI. This is the data the admin /
 * internal dashboard renders to break down "where is the ROI coming from".
 */
export interface MarketROIBreakdownRow {
  market: string;
  excludedFromPrimary: boolean;
  metrics: ROIMetrics;
}
export function getRoiByMarket(plays: PersistedPlay[]): MarketROIBreakdownRow[] {
  return groupByMarket(plays).map((row) => ({
    market: row.segment,
    excludedFromPrimary: isExcludedFromPrimaryRoi(row.segment),
    metrics: row.metrics,
  }));
}

export function groupByProbBucket(plays: PersistedPlay[]): SegmentedROI[] {
  const buckets: Record<string, PersistedPlay[]> = {
    "70+": [],
    "60-69": [],
    "50-59": [],
    "<50": [],
  };
  for (const p of plays) {
    const prob = p.prob ? parseFloat(String(p.prob)) : 0;
    if (prob >= 70) buckets["70+"].push(p);
    else if (prob >= 60) buckets["60-69"].push(p);
    else if (prob >= 50) buckets["50-59"].push(p);
    else buckets["<50"].push(p);
  }
  return Object.entries(buckets)
    .filter(([, ps]) => ps.length > 0)
    .map(([segment, ps]) => ({ segment, metrics: getROIMetrics(ps) }));
}

export function groupBySignalScoreBucket(plays: PersistedPlay[]): SegmentedROI[] {
  const buckets: Record<string, PersistedPlay[]> = {
    "80+": [],
    "70-79": [],
    "60-69": [],
    "<60": [],
  };
  for (const p of plays) {
    const score = p.signalScore ? parseFloat(String(p.signalScore)) : 0;
    if (score >= 80) buckets["80+"].push(p);
    else if (score >= 70) buckets["70-79"].push(p);
    else if (score >= 60) buckets["60-69"].push(p);
    else buckets["<60"].push(p);
  }
  return Object.entries(buckets)
    .filter(([, ps]) => ps.length > 0)
    .map(([segment, ps]) => ({ segment, metrics: getROIMetrics(ps) }));
}

export function groupByDirection(plays: PersistedPlay[]): SegmentedROI[] {
  const groups = new Map<string, PersistedPlay[]>();
  for (const p of plays) {
    const dir = (p.direction ?? "unknown").toUpperCase();
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(p);
  }
  return Array.from(groups.entries()).map(([segment, ps]) => ({
    segment,
    metrics: getROIMetrics(ps),
  }));
}

export function groupByTiming(plays: PersistedPlay[]): SegmentedROI[] {
  const buckets: Record<string, PersistedPlay[]> = {
    "Inning 1-3": [],
    "Inning 4-6": [],
    "Inning 7+": [],
    "No Inning Data": [],
  };
  for (const p of plays) {
    if (p.sport !== "mlb") continue;
    const inn = p.inning;
    if (inn == null) buckets["No Inning Data"].push(p);
    else if (inn <= 3) buckets["Inning 1-3"].push(p);
    else if (inn <= 6) buckets["Inning 4-6"].push(p);
    else buckets["Inning 7+"].push(p);
  }
  return Object.entries(buckets)
    .filter(([, ps]) => ps.length > 0)
    .map(([segment, ps]) => ({ segment, metrics: getROIMetrics(ps) }));
}

export interface FullROIReport {
  global: ROIMetrics;
  /**
   * [PRIMARY ROI EXCLUSION v1] Headline ROI block — excludes home_runs and
   * batter_strikeouts so the admin can see the user-facing "Core Engine ROI"
   * side-by-side with the full all-markets ROI in `global`.
   */
  primary: ROIMetrics;
  excludedFromPrimary: readonly string[];
  bySport: SegmentedROI[];
  byMarket: SegmentedROI[];
  byMarketBreakdown: MarketROIBreakdownRow[];
  byProbBucket: SegmentedROI[];
  bySignalScore: SegmentedROI[];
  byDirection: SegmentedROI[];
  byTiming: SegmentedROI[];
}

export function buildFullROIReport(plays: PersistedPlay[]): FullROIReport {
  return {
    global: getROIMetrics(plays),
    primary: getPrimaryROIMetrics(plays),
    excludedFromPrimary: EXCLUDED_FROM_PRIMARY_ROI,
    bySport: groupBySport(plays),
    byMarket: groupByMarket(plays),
    byMarketBreakdown: getRoiByMarket(plays),
    byProbBucket: groupByProbBucket(plays),
    bySignalScore: groupBySignalScoreBucket(plays),
    byDirection: groupByDirection(plays),
    byTiming: groupByTiming(plays),
  };
}
