import type { PersistedPlay } from "@shared/schema";

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

export function getROIMetrics(plays: PersistedPlay[]): ROIMetrics {
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
  bySport: SegmentedROI[];
  byMarket: SegmentedROI[];
  byProbBucket: SegmentedROI[];
  bySignalScore: SegmentedROI[];
  byDirection: SegmentedROI[];
  byTiming: SegmentedROI[];
}

export function buildFullROIReport(plays: PersistedPlay[]): FullROIReport {
  return {
    global: getROIMetrics(plays),
    bySport: groupBySport(plays),
    byMarket: groupByMarket(plays),
    byProbBucket: groupByProbBucket(plays),
    bySignalScore: groupBySignalScoreBucket(plays),
    byDirection: groupByDirection(plays),
    byTiming: groupByTiming(plays),
  };
}
