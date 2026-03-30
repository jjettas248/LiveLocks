interface DirectionalStats {
  overCount: number;
  underCount: number;
  overWins: number;
  overLosses: number;
  underWins: number;
  underLosses: number;
  overHighConfidenceCount: number;
  underHighConfidenceCount: number;
  updatedAt: number;
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
  updatedAt: Date.now(),
};

const HIGH_CONFIDENCE_THRESHOLD = 0.70;
const UNDER_SURFACED_THRESHOLD = 0.62;
const WIN_RATE_OUTPERFORMANCE = 0.03;

export function recordSurfacedSignal(direction: "OVER" | "UNDER", confidence: number): void {
  if (direction === "OVER") {
    rolling7d.overCount++;
    if (confidence >= HIGH_CONFIDENCE_THRESHOLD) rolling7d.overHighConfidenceCount++;
  } else {
    rolling7d.underCount++;
    if (confidence >= HIGH_CONFIDENCE_THRESHOLD) rolling7d.underHighConfidenceCount++;
  }
  rolling7d.updatedAt = Date.now();
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
} {
  const total = rolling7d.overCount + rolling7d.underCount;
  const overTotal = rolling7d.overWins + rolling7d.overLosses;
  const underTotal = rolling7d.underWins + rolling7d.underLosses;

  return {
    overCount: rolling7d.overCount,
    underCount: rolling7d.underCount,
    overWinRate: overTotal > 0 ? Math.round((rolling7d.overWins / overTotal) * 1000) / 1000 : 0,
    underWinRate: underTotal > 0 ? Math.round((rolling7d.underWins / underTotal) * 1000) / 1000 : 0,
    overHighConfidenceCount: rolling7d.overHighConfidenceCount,
    underHighConfidenceCount: rolling7d.underHighConfidenceCount,
    underBiasCorrectionActive: isUnderBiasCorrectionActive(),
    pctUnderSurfaced: total > 0 ? Math.round((rolling7d.underCount / total) * 1000) / 1000 : 0,
  };
}

export function seedFromSettledPlays(plays: Array<{
  direction: string;
  result: string | null;
  displayConfidence: number | null;
}>): void {
  rolling7d.overCount = 0;
  rolling7d.underCount = 0;
  rolling7d.overWins = 0;
  rolling7d.overLosses = 0;
  rolling7d.underWins = 0;
  rolling7d.underLosses = 0;
  rolling7d.overHighConfidenceCount = 0;
  rolling7d.underHighConfidenceCount = 0;

  for (const p of plays) {
    const dir = p.direction?.toUpperCase();
    if (dir !== "OVER" && dir !== "UNDER") continue;

    const conf = p.displayConfidence ?? 0.5;
    recordSurfacedSignal(dir, conf);

    if (p.result === "hit") recordResult(dir, true);
    else if (p.result === "miss") recordResult(dir, false);
  }

  rolling7d.updatedAt = Date.now();
}
