// ── Engine Observability Stats Accumulator ────────────────────────────────────
// In-memory stats for each engine, updated on every run.
// Exposed by /api/debug/nba, /api/debug/ncaab, /api/debug/mlb
// Phase 10: Added lineSource breakdown, sportsbookCoverage, avgLineVariance

export interface EngineRunStats {
  gamesProcessed: number;
  marketsEvaluated: number;
  signalsGenerated: number;
  signalsSkipped: number;
  rejectedSignals: number;
  rejectionReasons: string[];
  failureReasons: string[];
  totalLatencyMs: number;
  runCount: number;
  lastRunAt: number | null;
  // Phase 10 additions
  lineSources: Record<"sportsbook" | "inferred" | "derived", number>;
  sportsbookCoverageTotal: number; // sum of booksAvailable across all runs
  lineVarianceTotal: number;        // sum of lineVariance values (for avg)
  lineVarianceCount: number;        // denominator for avg
}

export function makeEngineRunStats(): EngineRunStats {
  return {
    gamesProcessed: 0,
    marketsEvaluated: 0,
    signalsGenerated: 0,
    signalsSkipped: 0,
    rejectedSignals: 0,
    rejectionReasons: [],
    failureReasons: [],
    totalLatencyMs: 0,
    runCount: 0,
    lastRunAt: null,
    lineSources: { sportsbook: 0, inferred: 0, derived: 0 },
    sportsbookCoverageTotal: 0,
    lineVarianceTotal: 0,
    lineVarianceCount: 0,
  };
}

export interface EngineDebugSummary {
  gamesProcessed: number;
  marketsEvaluated: number;
  validSignals: number;
  rejectedSignals: number;
  rejectionReasons: string[];
  failureReasons: string[];
  avgLatency: number;
  // Phase 10 additions
  lineSources: Record<"sportsbook" | "inferred" | "derived", number>;
  sportsbookCoveragePct: number;   // % of signal runs that had sportsbook data
  avgLineVariance: number;
}

const nbaStats = makeEngineRunStats();
const ncaabStats = makeEngineRunStats();
const mlbStats = makeEngineRunStats();

function getStats(sport: "nba" | "ncaab" | "mlb"): EngineRunStats {
  if (sport === "nba") return nbaStats;
  if (sport === "ncaab") return ncaabStats;
  return mlbStats;
}

export function recordEngineRun(sport: "nba" | "ncaab" | "mlb", params: {
  gamesProcessed?: number;
  marketsEvaluated?: number;
  signalsGenerated?: number;
  signalsSkipped?: number;
  rejectedSignals?: number;
  rejectionReasons?: string[];
  failureReasons?: string[];
  latencyMs?: number;
  // Phase 10 additions
  lineSource?: "sportsbook" | "inferred" | "derived";
  booksAvailable?: number;
  lineVariance?: number | null;
}): void {
  const s = getStats(sport);
  s.gamesProcessed += params.gamesProcessed ?? 0;
  s.marketsEvaluated += params.marketsEvaluated ?? 0;
  s.signalsGenerated += params.signalsGenerated ?? 0;
  s.signalsSkipped += params.signalsSkipped ?? 0;
  s.rejectedSignals += params.rejectedSignals ?? 0;
  if (params.rejectionReasons?.length) {
    for (const r of params.rejectionReasons) {
      if (!s.rejectionReasons.includes(r)) s.rejectionReasons.push(r);
    }
  }
  if (params.failureReasons?.length) {
    for (const r of params.failureReasons) {
      if (!s.failureReasons.includes(r)) s.failureReasons.push(r);
    }
  }
  if (params.latencyMs != null) s.totalLatencyMs += params.latencyMs;
  s.runCount++;
  s.lastRunAt = Date.now();

  // Phase 10: track line sources
  if (params.lineSource) {
    s.lineSources[params.lineSource] = (s.lineSources[params.lineSource] ?? 0) + 1;
  }

  // Phase 10: track sportsbook coverage
  if (params.booksAvailable != null) {
    s.sportsbookCoverageTotal += params.booksAvailable;
  }

  // Phase 10: track line variance
  if (params.lineVariance != null && Number.isFinite(params.lineVariance)) {
    s.lineVarianceTotal += params.lineVariance;
    s.lineVarianceCount++;
  }
}

export function getEngineDebugSummary(sport: "nba" | "ncaab" | "mlb"): EngineDebugSummary {
  const s = getStats(sport);
  const totalLineSourceCount = s.lineSources.sportsbook + s.lineSources.inferred + s.lineSources.derived;
  const sportsbookCoveragePct = totalLineSourceCount > 0
    ? parseFloat(((s.lineSources.sportsbook / totalLineSourceCount) * 100).toFixed(1))
    : 0;

  return {
    gamesProcessed: s.gamesProcessed,
    marketsEvaluated: s.marketsEvaluated,
    validSignals: s.signalsGenerated,
    rejectedSignals: s.rejectedSignals,
    rejectionReasons: s.rejectionReasons.slice(0, 20),
    failureReasons: s.failureReasons.slice(0, 20),
    avgLatency: s.runCount > 0 ? parseFloat((s.totalLatencyMs / s.runCount).toFixed(1)) : 0,
    lineSources: { ...s.lineSources },
    sportsbookCoveragePct,
    avgLineVariance: s.lineVarianceCount > 0
      ? parseFloat((s.lineVarianceTotal / s.lineVarianceCount).toFixed(3))
      : 0,
  };
}

export function resetEngineStats(sport: "nba" | "ncaab" | "mlb"): void {
  const s = getStats(sport);
  s.gamesProcessed = 0;
  s.marketsEvaluated = 0;
  s.signalsGenerated = 0;
  s.signalsSkipped = 0;
  s.rejectedSignals = 0;
  s.rejectionReasons = [];
  s.failureReasons = [];
  s.totalLatencyMs = 0;
  s.runCount = 0;
  s.lastRunAt = null;
  s.lineSources = { sportsbook: 0, inferred: 0, derived: 0 };
  s.sportsbookCoverageTotal = 0;
  s.lineVarianceTotal = 0;
  s.lineVarianceCount = 0;
}
