import type { Sport, PollingTier, FreshnessStatus } from "./oddsConfig";

interface SportCounters {
  apiFetches: number;
  apiFailures: number;
  cacheWrites: number;
  cacheHits: number;
  cacheMisses: number;
  lkgServed: number;
  staleBlocks: number;
  expiredBlocks: number;
  lastFetchAt: number;
  lastFailureAt: number;
  lastFailureReason: string | null;
}

function emptyCounters(): SportCounters {
  return {
    apiFetches: 0,
    apiFailures: 0,
    cacheWrites: 0,
    cacheHits: 0,
    cacheMisses: 0,
    lkgServed: 0,
    staleBlocks: 0,
    expiredBlocks: 0,
    lastFetchAt: 0,
    lastFailureAt: 0,
    lastFailureReason: null,
  };
}

const counters: Record<Sport, SportCounters> = {
  mlb: emptyCounters(),
  nba: emptyCounters(),
  ncaab: emptyCounters(),
};

const tierAssignments: Record<Sport, Map<string, PollingTier>> = {
  mlb: new Map(),
  nba: new Map(),
  ncaab: new Map(),
};

export function recordApiFetch(sport: Sport): void {
  counters[sport].apiFetches++;
  counters[sport].lastFetchAt = Date.now();
}

export function recordApiFailure(sport: Sport, reason: string): void {
  counters[sport].apiFailures++;
  counters[sport].lastFailureAt = Date.now();
  counters[sport].lastFailureReason = reason;
}

export function recordCacheWrite(sport: Sport): void {
  counters[sport].cacheWrites++;
}

export function recordCacheHit(sport: Sport): void {
  counters[sport].cacheHits++;
}

export function recordCacheMiss(sport: Sport): void {
  counters[sport].cacheMisses++;
}

export function recordLkgServed(sport: Sport): void {
  counters[sport].lkgServed++;
}

export function recordStaleBlock(sport: Sport, freshness: FreshnessStatus): void {
  if (freshness === "stale") counters[sport].staleBlocks++;
  if (freshness === "expired") counters[sport].expiredBlocks++;
}

export function setTier(sport: Sport, gameId: string, tier: PollingTier): void {
  tierAssignments[sport].set(gameId, tier);
}

export function getTier(sport: Sport, gameId: string): PollingTier | undefined {
  return tierAssignments[sport].get(gameId);
}

export function clearTier(sport: Sport, gameId: string): void {
  tierAssignments[sport].delete(gameId);
}

export function getOddsHealthSnapshot() {
  const out: Record<string, any> = {};
  for (const sport of ["mlb", "nba", "ncaab"] as Sport[]) {
    const c = counters[sport];
    const totalReads = c.cacheHits + c.cacheMisses;
    out[sport] = {
      ...c,
      hitRate: totalReads > 0 ? c.cacheHits / totalReads : 0,
      creditsSavedEstimate: c.cacheHits,
      activeGames: tierAssignments[sport].size,
      tierDistribution: aggregateTiers(sport),
    };
  }
  return { generatedAt: Date.now(), sports: out };
}

function aggregateTiers(sport: Sport): Record<PollingTier, number> {
  const dist: Record<PollingTier, number> = {
    critical: 0, high: 0, normal: 0, low: 0, idle: 0,
  };
  tierAssignments[sport].forEach((tier) => {
    dist[tier] = (dist[tier] ?? 0) + 1;
  });
  return dist;
}

export function logFetch(sport: Sport, ctx: Record<string, any>): void {
  console.log(`[ODDS_FETCH] sport=${sport} ${formatCtx(ctx)}`);
}

export function logCacheWrite(sport: Sport, ctx: Record<string, any>): void {
  console.log(`[ODDS_CACHE_WRITE] sport=${sport} ${formatCtx(ctx)}`);
}

export function logCacheRead(sport: Sport, ctx: Record<string, any>): void {
  console.log(`[ODDS_CACHE_READ] sport=${sport} ${formatCtx(ctx)}`);
}

export function logStaleBlock(sport: Sport, ctx: Record<string, any>): void {
  console.warn(`[ODDS_STALE_BLOCK] sport=${sport} ${formatCtx(ctx)}`);
}

export function logFallbackUsed(sport: Sport, ctx: Record<string, any>): void {
  console.warn(`[ODDS_FALLBACK_USED] sport=${sport} ${formatCtx(ctx)}`);
}

export function logPriorityAssign(sport: Sport, ctx: Record<string, any>): void {
  console.log(`[ODDS_PRIORITY_ASSIGN] sport=${sport} ${formatCtx(ctx)}`);
}

function formatCtx(ctx: Record<string, any>): string {
  return Object.entries(ctx)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ");
}
