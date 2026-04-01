interface DirectionalStats {
  overCount: number;
  underCount: number;
  overWins: number;
  overLosses: number;
  underWins: number;
  underLosses: number;
  overHighConfidenceCount: number;
  underHighConfidenceCount: number;
  overEdgeSum: number;
  underEdgeSum: number;
  halftimeCount: number;
  liveCount: number;
  updatedAt: number;
}

interface MarketDirectionalStats {
  overCount: number;
  underCount: number;
  overEdgeSum: number;
  underEdgeSum: number;
}

const rolling7d: DirectionalStats = {
  overCount: 0,
  underCount: 0,
  overWins: 0,
  overLosses: 0,
  underWins: 0,
  underLosses: 0,
  overHighConfidenceCount: 0,
  underHighConfidenceCount: 0,
  overEdgeSum: 0,
  underEdgeSum: 0,
  halftimeCount: 0,
  liveCount: 0,
  updatedAt: Date.now(),
};

const marketStats = new Map<string, MarketDirectionalStats>();

const HIGH_CONFIDENCE_THRESHOLD = 0.70;
const UNDER_SURFACED_THRESHOLD = 0.62;
const WIN_RATE_OUTPERFORMANCE = 0.03;
const BIAS_ALERT_THRESHOLD = 0.70;

function getOrCreateMarketStats(market: string): MarketDirectionalStats {
  let ms = marketStats.get(market);
  if (!ms) {
    ms = { overCount: 0, underCount: 0, overEdgeSum: 0, underEdgeSum: 0 };
    marketStats.set(market, ms);
  }
  return ms;
}

export function recordSurfacedSignal(
  direction: "OVER" | "UNDER",
  confidence: number,
  market?: string,
  edge?: number,
  timingContext?: "live" | "halftime"
): void {
  if (direction === "OVER") {
    rolling7d.overCount++;
    if (confidence >= HIGH_CONFIDENCE_THRESHOLD) rolling7d.overHighConfidenceCount++;
    if (edge != null) rolling7d.overEdgeSum += edge;
  } else {
    rolling7d.underCount++;
    if (confidence >= HIGH_CONFIDENCE_THRESHOLD) rolling7d.underHighConfidenceCount++;
    if (edge != null) rolling7d.underEdgeSum += edge;
  }

  if (timingContext === "halftime") rolling7d.halftimeCount++;
  else if (timingContext === "live") rolling7d.liveCount++;

  if (market) {
    const ms = getOrCreateMarketStats(market);
    if (direction === "OVER") {
      ms.overCount++;
      if (edge != null) ms.overEdgeSum += edge;
    } else {
      ms.underCount++;
      if (edge != null) ms.underEdgeSum += edge;
    }
  }

  rolling7d.updatedAt = Date.now();

  const total = rolling7d.overCount + rolling7d.underCount;
  if (total > 0 && total % 10 === 0) {
    const overRatio = rolling7d.overCount / total;
    const underRatio = rolling7d.underCount / total;
    const avgOverEdge = rolling7d.overCount > 0 ? rolling7d.overEdgeSum / rolling7d.overCount : 0;
    const avgUnderEdge = rolling7d.underCount > 0 ? rolling7d.underEdgeSum / rolling7d.underCount : 0;
    console.log(`[BIAS_TRACK] total=${total} over=${rolling7d.overCount}(${(overRatio * 100).toFixed(1)}%) under=${rolling7d.underCount}(${(underRatio * 100).toFixed(1)}%) avgOverEdge=${avgOverEdge.toFixed(1)} avgUnderEdge=${avgUnderEdge.toFixed(1)} halftime=${rolling7d.halftimeCount} live=${rolling7d.liveCount}`);

    if (total >= 20 && (overRatio > BIAS_ALERT_THRESHOLD || underRatio > BIAS_ALERT_THRESHOLD)) {
      const dominant = overRatio > underRatio ? "OVER" : "UNDER";
      console.warn(`[BIAS_ALERT] ${dominant}-heavy distribution detected: ${dominant === "OVER" ? overRatio : underRatio > 0 ? underRatio : 0} (${total} signals)`);
    }
  }
}

export function recordResult(direction: "OVER" | "UNDER", hit: boolean): void {
  if (direction === "OVER") {
    if (hit) rolling7d.overWins++; else rolling7d.overLosses++;
  } else {
    if (hit) rolling7d.underWins++; else rolling7d.underLosses++;
  }
}

export function isUnderBiasCorrectionActive(): boolean {
  const total = rolling7d.overCount + rolling7d.underCount;
  if (total < 20) return false;

  const pctUnder = rolling7d.underCount / total;
  if (pctUnder <= UNDER_SURFACED_THRESHOLD) return false;

  const overTotal = rolling7d.overWins + rolling7d.overLosses;
  const underTotal = rolling7d.underWins + rolling7d.underLosses;

  const overWinRate = overTotal > 0 ? rolling7d.overWins / overTotal : 0.5;
  const underWinRate = underTotal > 0 ? rolling7d.underWins / underTotal : 0.5;

  return !(underWinRate > overWinRate + WIN_RATE_OUTPERFORMANCE);
}

export function getDirectionalSplit(): {
  overCount: number;
  underCount: number;
  overWinRate: number;
  underWinRate: number;
  overHighConfidenceCount: number;
  underHighConfidenceCount: number;
  underBiasCorrectionActive: boolean;
  pctUnderSurfaced: number;
  avgOverEdge: number;
  avgUnderEdge: number;
  halftimeCount: number;
  liveCount: number;
  marketBreakdown: Record<string, { over: number; under: number; overRatio: number; avgOverEdge: number; avgUnderEdge: number }>;
} {
  const total = rolling7d.overCount + rolling7d.underCount;
  const overTotal = rolling7d.overWins + rolling7d.overLosses;
  const underTotal = rolling7d.underWins + rolling7d.underLosses;

  const mb: Record<string, { over: number; under: number; overRatio: number; avgOverEdge: number; avgUnderEdge: number }> = {};
  for (const [market, ms] of Array.from(marketStats.entries())) {
    const mTotal = ms.overCount + ms.underCount;
    mb[market] = {
      over: ms.overCount,
      under: ms.underCount,
      overRatio: mTotal > 0 ? Math.round((ms.overCount / mTotal) * 1000) / 1000 : 0,
      avgOverEdge: ms.overCount > 0 ? Math.round((ms.overEdgeSum / ms.overCount) * 10) / 10 : 0,
      avgUnderEdge: ms.underCount > 0 ? Math.round((ms.underEdgeSum / ms.underCount) * 10) / 10 : 0,
    };
  }

  return {
    overCount: rolling7d.overCount,
    underCount: rolling7d.underCount,
    overWinRate: overTotal > 0 ? Math.round((rolling7d.overWins / overTotal) * 1000) / 1000 : 0,
    underWinRate: underTotal > 0 ? Math.round((rolling7d.underWins / underTotal) * 1000) / 1000 : 0,
    overHighConfidenceCount: rolling7d.overHighConfidenceCount,
    underHighConfidenceCount: rolling7d.underHighConfidenceCount,
    underBiasCorrectionActive: isUnderBiasCorrectionActive(),
    pctUnderSurfaced: total > 0 ? Math.round((rolling7d.underCount / total) * 1000) / 1000 : 0,
    avgOverEdge: rolling7d.overCount > 0 ? Math.round((rolling7d.overEdgeSum / rolling7d.overCount) * 10) / 10 : 0,
    avgUnderEdge: rolling7d.underCount > 0 ? Math.round((rolling7d.underEdgeSum / rolling7d.underCount) * 10) / 10 : 0,
    halftimeCount: rolling7d.halftimeCount,
    liveCount: rolling7d.liveCount,
    marketBreakdown: mb,
  };
}

export function seedFromSettledPlays(plays: Array<{
  direction: string;
  result: string | null;
  displayConfidence: number | null;
  market?: string;
  edge?: number;
}>): void {
  rolling7d.overCount = 0;
  rolling7d.underCount = 0;
  rolling7d.overWins = 0;
  rolling7d.overLosses = 0;
  rolling7d.underWins = 0;
  rolling7d.underLosses = 0;
  rolling7d.overHighConfidenceCount = 0;
  rolling7d.underHighConfidenceCount = 0;
  rolling7d.overEdgeSum = 0;
  rolling7d.underEdgeSum = 0;
  rolling7d.halftimeCount = 0;
  rolling7d.liveCount = 0;
  marketStats.clear();

  for (const p of plays) {
    const dir = p.direction?.toUpperCase();
    if (dir !== "OVER" && dir !== "UNDER") continue;

    const conf = p.displayConfidence ?? 0.5;
    recordSurfacedSignal(dir, conf, p.market, p.edge);

    if (p.result === "hit") recordResult(dir, true);
    else if (p.result === "miss") recordResult(dir, false);
  }

  rolling7d.updatedAt = Date.now();
}
