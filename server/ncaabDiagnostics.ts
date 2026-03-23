// ── NCAAB Diagnostics Module ──────────────────────────────────────────────────
// Logging, analysis, and drift detection for settled plays.

import type { NCAABEngineOutput, NCAABMarketType, RecommendedSide } from "./ncaabEngine";

export interface SettledPlayLog {
  gameId: string;
  marketType: NCAABMarketType;
  line: number;
  finalResult: number;
  projection: number;
  projectionError: number;
  displayedSide: RecommendedSide;
  actualResultSide: "OVER" | "UNDER" | "PUSH";
  rawProbability: number;
  calibratedProbability: number;
  displayMatchedEngine: boolean;
  sideSelectionConsistent: boolean;
  engineGeneratedAt: number;
  settledAt: number;
  warnings: string[];
}

const settledPlays: SettledPlayLog[] = [];
const MAX_SETTLED = 5000;

export function logSettledPlay(
  engineOutput: NCAABEngineOutput,
  line: number,
  finalResult: number,
  displayedSide: RecommendedSide,
  displayMatchedEngine: boolean
): SettledPlayLog {
  const projectionError = engineOutput.projectedTotal !== null
    ? finalResult - engineOutput.projectedTotal
    : 0;

  const actualResultSide: "OVER" | "UNDER" | "PUSH" =
    finalResult > line ? "OVER" : finalResult < line ? "UNDER" : "PUSH";

  const sideSelectionConsistent =
    engineOutput.recommendedSide === "NO_EDGE" ||
    engineOutput.recommendedSide === actualResultSide;

  const log: SettledPlayLog = {
    gameId: engineOutput.gameId,
    marketType: engineOutput.marketType,
    line,
    finalResult,
    projection: engineOutput.projectedTotal ?? 0,
    projectionError,
    displayedSide,
    actualResultSide,
    rawProbability: engineOutput.rawOverProb ?? 0,
    calibratedProbability: engineOutput.calibratedOverProb ?? 0,
    displayMatchedEngine,
    sideSelectionConsistent,
    engineGeneratedAt: engineOutput.engineGeneratedAt,
    settledAt: Date.now(),
    warnings: engineOutput.warnings,
  };

  settledPlays.push(log);
  if (settledPlays.length > MAX_SETTLED) {
    settledPlays.splice(0, settledPlays.length - MAX_SETTLED);
  }

  console.log(`[DIAG] Settled: ${log.gameId} | market=${log.marketType} | line=${log.line} | result=${log.finalResult} | proj=${log.projection} | error=${log.projectionError.toFixed(1)} | side=${log.displayedSide} | actual=${log.actualResultSide} | consistent=${log.sideSelectionConsistent}`);

  return log;
}

export function analyzeProjectionError(): {
  count: number;
  meanError: number;
  meanAbsError: number;
  medianAbsError: number;
} {
  if (settledPlays.length === 0) return { count: 0, meanError: 0, meanAbsError: 0, medianAbsError: 0 };

  const errors = settledPlays.map(p => p.projectionError);
  const absErrors = errors.map(e => Math.abs(e));
  const sorted = [...absErrors].sort((a, b) => a - b);

  return {
    count: errors.length,
    meanError: errors.reduce((s, e) => s + e, 0) / errors.length,
    meanAbsError: absErrors.reduce((s, e) => s + e, 0) / absErrors.length,
    medianAbsError: sorted[Math.floor(sorted.length / 2)] ?? 0,
  };
}

export function analyzeCalibrationByBucket(): Array<{
  bucket: string;
  min: number;
  max: number;
  count: number;
  hits: number;
  winRate: number;
}> {
  const buckets = [
    { bucket: "50-55", min: 50, max: 55 },
    { bucket: "55-60", min: 55, max: 60 },
    { bucket: "60-65", min: 60, max: 65 },
    { bucket: "65-70", min: 65, max: 70 },
    { bucket: "70-75", min: 70, max: 75 },
    { bucket: "75-80", min: 75, max: 80 },
    { bucket: "80+", min: 80, max: 100 },
  ];

  return buckets.map(b => {
    const inBucket = settledPlays.filter(p => {
      const prob = p.calibratedProbability;
      return prob >= b.min && prob < b.max;
    });
    const hits = inBucket.filter(p => p.sideSelectionConsistent).length;
    return {
      ...b,
      count: inBucket.length,
      hits,
      winRate: inBucket.length > 0 ? (hits / inBucket.length) * 100 : 0,
    };
  });
}

export function analyzeDisplayMismatchRate(): {
  total: number;
  mismatches: number;
  rate: number;
} {
  const total = settledPlays.length;
  const mismatches = settledPlays.filter(p => !p.displayMatchedEngine).length;
  return {
    total,
    mismatches,
    rate: total > 0 ? (mismatches / total) * 100 : 0,
  };
}

export function analyzeWrongSideRate(): {
  total: number;
  wrongSide: number;
  rate: number;
  noEdge: number;
} {
  const withSide = settledPlays.filter(p => p.displayedSide !== "NO_EDGE");
  const wrongSide = withSide.filter(p => !p.sideSelectionConsistent && p.actualResultSide !== "PUSH").length;
  return {
    total: withSide.length,
    wrongSide,
    rate: withSide.length > 0 ? (wrongSide / withSide.length) * 100 : 0,
    noEdge: settledPlays.filter(p => p.displayedSide === "NO_EDGE").length,
  };
}

export function detectDrift(): {
  hasDrift: boolean;
  driftType: string | null;
  details: string;
} {
  if (settledPlays.length < 10) {
    return { hasDrift: false, driftType: null, details: "Insufficient data" };
  }

  const recent = settledPlays.slice(-20);
  const mismatchRate = recent.filter(p => !p.displayMatchedEngine).length / recent.length;
  if (mismatchRate > 0.2) {
    return {
      hasDrift: true,
      driftType: "display_mismatch",
      details: `${(mismatchRate * 100).toFixed(0)}% of recent plays have display/engine mismatch`,
    };
  }

  const wrongSideRate = recent.filter(p => p.displayedSide !== "NO_EDGE" && !p.sideSelectionConsistent && p.actualResultSide !== "PUSH").length / recent.length;
  if (wrongSideRate > 0.6) {
    return {
      hasDrift: true,
      driftType: "wrong_side",
      details: `${(wrongSideRate * 100).toFixed(0)}% wrong side rate in last 20 plays`,
    };
  }

  const projErrors = recent.map(p => Math.abs(p.projectionError));
  const avgError = projErrors.reduce((s, e) => s + e, 0) / projErrors.length;
  if (avgError > 20) {
    return {
      hasDrift: true,
      driftType: "projection_error",
      details: `Mean absolute projection error = ${avgError.toFixed(1)} (threshold: 20)`,
    };
  }

  return { hasDrift: false, driftType: null, details: "No drift detected" };
}

export function analyzeEdgeRealization(): {
  edgePlays: number;
  edgeHits: number;
  edgeWinRate: number;
  avgEdge: number;
} {
  const edgePlays = settledPlays.filter(p => p.displayedSide !== "NO_EDGE");
  const edgeHits = edgePlays.filter(p => p.sideSelectionConsistent && p.actualResultSide !== "PUSH").length;
  const edges = edgePlays.map(p => Math.abs(p.calibratedProbability - 50));

  return {
    edgePlays: edgePlays.length,
    edgeHits,
    edgeWinRate: edgePlays.length > 0 ? (edgeHits / edgePlays.length) * 100 : 0,
    avgEdge: edges.length > 0 ? edges.reduce((s, e) => s + e, 0) / edges.length : 0,
  };
}

export function getSettledPlays(): SettledPlayLog[] {
  return [...settledPlays];
}

export function getDiagnosticsSummary(): {
  projectionError: ReturnType<typeof analyzeProjectionError>;
  calibration: ReturnType<typeof analyzeCalibrationByBucket>;
  displayMismatch: ReturnType<typeof analyzeDisplayMismatchRate>;
  wrongSide: ReturnType<typeof analyzeWrongSideRate>;
  drift: ReturnType<typeof detectDrift>;
  edgeRealization: ReturnType<typeof analyzeEdgeRealization>;
} {
  return {
    projectionError: analyzeProjectionError(),
    calibration: analyzeCalibrationByBucket(),
    displayMismatch: analyzeDisplayMismatchRate(),
    wrongSide: analyzeWrongSideRate(),
    drift: detectDrift(),
    edgeRealization: analyzeEdgeRealization(),
  };
}
