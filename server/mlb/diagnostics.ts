import type {
  MLBPropOutput,
  MLBMarket,
  MLBConfidenceTier,
  MLBRecommendedSide,
  ProjectionLog,
} from "./types";
import { ALL_MLB_MARKETS } from "./types";

export interface MLBDiagnosticRecord {
  timestamp: number;
  market: MLBMarket;
  playerId: string;
  playerName: string;
  gameId: string;
  projection: number;
  bookLine: number;
  rawProbabilityOver: number;
  rawProbabilityUnder: number;
  calibratedProbabilityOver: number;
  calibratedProbabilityUnder: number;
  rawProbability: number;
  calibratedProbability: number;
  edge: number;
  recommendedSide: MLBRecommendedSide;
  projectedSide: MLBRecommendedSide;
  confidenceTier: MLBConfidenceTier;
  mode: "standard" | "early_explosive";
  suppressed: boolean;
  suppressionReason: string | null;
  wouldHaveWon: boolean | null;
  isExperimental: boolean;
  projectionLog: ProjectionLog;
  modifiers: {
    liveForm: number;
    pitcher: number;
    pitchType: number;
    weatherPark: number;
    lineup: number;
    bullpen: number;
    parkHistory: number;
    handednessMatchup: number;
    bvpHistory: number;
    pocketWeakness: number;
    total: number;
  };
  finalResult: number | null;
  hit: boolean | null;
  settled?: boolean;
  projectionError?: number | null;
}

const diagnosticRecords: MLBDiagnosticRecord[] = [];
const MAX_RECORDS = 2000;

export function recordMLBDiagnostic(
  output: MLBPropOutput,
  finalResult?: number
): MLBDiagnosticRecord {
  const projectedSide: MLBRecommendedSide =
    output.calibratedProbabilityOver >= 50 ? "OVER" : "UNDER";

  const hit =
    finalResult !== undefined
      ? output.recommendedSide === "OVER"
        ? finalResult > output.bookLine
        : output.recommendedSide === "UNDER"
        ? finalResult < output.bookLine
        : null
      : null;

  let wouldHaveWon: boolean | null = null;
  if (output.suppressed && finalResult !== undefined) {
    if (projectedSide === "OVER") {
      wouldHaveWon = finalResult > output.bookLine;
    } else {
      wouldHaveWon = finalResult < output.bookLine;
    }
  }

  const settled = finalResult !== undefined;
  const projectionError = settled ? output.projection - finalResult! : null;

  const record: MLBDiagnosticRecord = {
    timestamp: Date.now(),
    market: output.market,
    playerId: output.playerId,
    playerName: output.playerName,
    gameId: output.gameId,
    projection: output.projection,
    bookLine: output.bookLine,
    rawProbabilityOver: output.rawProbabilityOver,
    rawProbabilityUnder: output.rawProbabilityUnder,
    calibratedProbabilityOver: output.calibratedProbabilityOver,
    calibratedProbabilityUnder: output.calibratedProbabilityUnder,
    rawProbability: output.rawProbability,
    calibratedProbability: output.calibratedProbability,
    edge: output.edge,
    recommendedSide: output.recommendedSide,
    projectedSide,
    confidenceTier: output.confidenceTier,
    mode: output.mode,
    suppressed: output.suppressed,
    suppressionReason: output.suppressionReason,
    wouldHaveWon,
    isExperimental: output.isExperimental,
    projectionLog: { ...output.projectionLog },
    modifiers: { ...output.modifiers },
    finalResult: finalResult ?? null,
    hit,
    settled,
    projectionError,
  };

  diagnosticRecords.push(record);
  if (diagnosticRecords.length > MAX_RECORDS) {
    diagnosticRecords.splice(0, diagnosticRecords.length - MAX_RECORDS);
  }

  console.log(
    `[MLB DIAG] ${record.playerName} | ${record.market} | proj=${record.projection} | line=${record.bookLine} | edge=${record.edge.toFixed(1)}% | side=${record.recommendedSide} | tier=${record.confidenceTier} | mode=${record.mode} | suppressed=${record.suppressed}`
  );

  return record;
}

export interface MLBMarketReport {
  market: MLBMarket;
  sampleSize: number;
  hitRate: number;
  roi: number;
  avgProjectionError: number;
  avgEdge: number;
  avgCalibratedProbability: number;
  suppressionCount: number;
  suppressionFalseNegativeRate: number;
}

export function getMLBMarketReport(): MLBMarketReport[] {
  return ALL_MLB_MARKETS.map((market) => {
    const marketRecords = diagnosticRecords.filter((r) => r.market === market);
    const settled = marketRecords.filter((r) => r.finalResult !== null);
    const settledUnsuppressed = settled.filter((r) => !r.suppressed);
    const hits = settledUnsuppressed.filter((r) => r.hit === true).length;
    const errors = settled.map((r) => Math.abs(r.projection - r.finalResult!));

    const hitRate =
      settledUnsuppressed.length > 0
        ? (hits / settledUnsuppressed.length) * 100
        : 0;

    const winRate = settledUnsuppressed.length > 0 ? hits / settledUnsuppressed.length : 0;
    const roi =
      settledUnsuppressed.length > 0 ? (winRate * 1.91 - 1) * 100 : 0;

    const avgProjectionError =
      errors.length > 0 ? errors.reduce((s, e) => s + e, 0) / errors.length : 0;

    const avgEdge =
      marketRecords.length > 0
        ? marketRecords.reduce((s, r) => s + Math.abs(r.edge), 0) / marketRecords.length
        : 0;

    const avgCalibratedProbability =
      marketRecords.length > 0
        ? marketRecords.reduce((s, r) => s + r.calibratedProbability, 0) / marketRecords.length
        : 0;

    const suppressionCount = marketRecords.filter((r) => r.suppressed).length;

    const suppressedSettled = settled.filter((r) => r.suppressed && r.wouldHaveWon !== null);
    const suppressedWins = suppressedSettled.filter((r) => r.wouldHaveWon === true).length;
    const suppressionFalseNegativeRate =
      suppressedSettled.length > 0
        ? (suppressedWins / suppressedSettled.length) * 100
        : 0;

    return {
      market,
      sampleSize: marketRecords.length,
      hitRate: Math.round(hitRate * 100) / 100,
      roi: Math.round(roi * 100) / 100,
      avgProjectionError: Math.round(avgProjectionError * 1000) / 1000,
      avgEdge: Math.round(avgEdge * 100) / 100,
      avgCalibratedProbability: Math.round(avgCalibratedProbability * 100) / 100,
      suppressionCount,
      suppressionFalseNegativeRate: Math.round(suppressionFalseNegativeRate * 100) / 100,
    };
  });
}

export interface ModifierContributionStat {
  modifier: string;
  avgContribution: number;
  contributionVariance: number;
  positiveContributionRate: number;
  negativeContributionRate: number;
}

const PROJECTION_LOG_MODIFIER_KEYS = [
  "liveFormAdjustment",
  "pitcherAdjustment",
  "pitchTypeAdjustment",
  "weatherParkAdjustment",
  "lineupAdjustment",
  "bullpenAdjustment",
] as const;

export function getModifierContributionSummary(): ModifierContributionStat[] {
  if (diagnosticRecords.length === 0) return [];

  return PROJECTION_LOG_MODIFIER_KEYS.map((key) => {
    const values = diagnosticRecords.map((r) => r.projectionLog[key]);
    const n = values.length;

    const avg = values.reduce((s, v) => s + v, 0) / n;
    const variance =
      values.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / n;

    const positiveCount = values.filter((v) => v > 0).length;
    const negativeCount = values.filter((v) => v < 0).length;

    return {
      modifier: key,
      avgContribution: Math.round(avg * 10000) / 10000,
      contributionVariance: Math.round(variance * 10000) / 10000,
      positiveContributionRate: Math.round((positiveCount / n) * 10000) / 100,
      negativeContributionRate: Math.round((negativeCount / n) * 10000) / 100,
    };
  });
}

export interface MLBDiagnosticSummary {
  totalRecords: number;
  suppressedCount: number;
  suppressionRate: number;
  suppressionFalseNegativeRate: number;
  projectionErrorByMarket: Record<string, { count: number; meanAbsError: number }>;
  edgeSizeDistribution: { bucket: string; count: number }[];
  liveFormBoostRate: { withBoost: number; withoutBoost: number; boostRate: number };
  earlyExplosiveStats: {
    total: number;
    settled: number;
    hits: number;
    winRate: number;
    avgEdge: number;
    avgCalibrated: number;
  };
  standardModeStats: {
    total: number;
    settled: number;
    hits: number;
    winRate: number;
    avgEdge: number;
    avgCalibrated: number;
  };
  winRateByConfidence: { tier: string; total: number; hits: number; winRate: number }[];
  roiByConfidence: { tier: string; total: number; hits: number; estimatedROI: number }[];
  modifierContributionAvg: Record<string, number>;
}

export function getMLBDiagnosticSummary(): MLBDiagnosticSummary {
  const settled = diagnosticRecords.filter((r) => r.finalResult !== null);

  const marketGroups: Record<string, MLBDiagnosticRecord[]> = {};
  for (const r of settled) {
    if (!marketGroups[r.market]) marketGroups[r.market] = [];
    marketGroups[r.market].push(r);
  }

  const projectionErrorByMarket: Record<string, { count: number; meanAbsError: number }> = {};
  for (const [market, records] of Object.entries(marketGroups)) {
    const errors = records.map((r) => Math.abs(r.projection - r.finalResult!));
    projectionErrorByMarket[market] = {
      count: records.length,
      meanAbsError:
        errors.length > 0
          ? errors.reduce((s, e) => s + e, 0) / errors.length
          : 0,
    };
  }

  const edgeBuckets = [
    { bucket: "0-3%", min: 0, max: 3 },
    { bucket: "3-5%", min: 3, max: 5 },
    { bucket: "5-8%", min: 5, max: 8 },
    { bucket: "8-12%", min: 8, max: 12 },
    { bucket: "12%+", min: 12, max: Infinity },
  ];

  const edgeSizeDistribution = edgeBuckets.map((b) => ({
    bucket: b.bucket,
    count: diagnosticRecords.filter((r) => {
      const absEdge = Math.abs(r.edge);
      return absEdge >= b.min && absEdge < b.max;
    }).length,
  }));

  const withBoost = diagnosticRecords.filter((r) => r.modifiers.liveForm !== 0).length;
  const withoutBoost = diagnosticRecords.length - withBoost;

  const earlyExplosiveAll = diagnosticRecords.filter((r) => r.mode === "early_explosive");
  const earlyExplosiveSettled = settled.filter((r) => r.mode === "early_explosive");
  const earlyHits = earlyExplosiveSettled.filter((r) => r.hit === true).length;

  const standardAll = diagnosticRecords.filter((r) => r.mode === "standard");
  const standardSettled = settled.filter((r) => r.mode === "standard");
  const standardHits = standardSettled.filter((r) => r.hit === true).length;

  function avgField(records: MLBDiagnosticRecord[], fn: (r: MLBDiagnosticRecord) => number): number {
    if (records.length === 0) return 0;
    return records.reduce((s, r) => s + fn(r), 0) / records.length;
  }

  const tiers: MLBConfidenceTier[] = ["ELITE", "STRONG", "LEAN", "NO_EDGE"];
  const winRateByConfidence = tiers.map((tier) => {
    const inTier = settled.filter((r) => r.confidenceTier === tier);
    const hits = inTier.filter((r) => r.hit === true).length;
    return {
      tier,
      total: inTier.length,
      hits,
      winRate: inTier.length > 0 ? (hits / inTier.length) * 100 : 0,
    };
  });

  const roiByConfidence = tiers.map((tier) => {
    const inTier = settled.filter((r) => r.confidenceTier === tier);
    const hits = inTier.filter((r) => r.hit === true).length;
    const winRate = inTier.length > 0 ? hits / inTier.length : 0;
    const estimatedROI = inTier.length > 0 ? (winRate * 1.91 - 1) * 100 : 0;
    return {
      tier,
      total: inTier.length,
      hits,
      estimatedROI: Math.round(estimatedROI * 100) / 100,
    };
  });

  const modifierKeys = [
    "liveForm", "pitcher", "pitchType", "weatherPark", "lineup", "bullpen",
    "parkHistory", "handednessMatchup", "bvpHistory", "pocketWeakness", "total",
  ] as const;
  const modifierContributionAvg: Record<string, number> = {};
  for (const key of modifierKeys) {
    modifierContributionAvg[key] = avgField(diagnosticRecords, (r) => r.modifiers[key]);
  }

  const suppressedCount = diagnosticRecords.filter((r) => r.suppressed).length;

  const suppressedSettledAll = settled.filter(
    (r) => r.suppressed && r.wouldHaveWon !== null
  );
  const suppressedWinsAll = suppressedSettledAll.filter((r) => r.wouldHaveWon === true).length;
  const suppressionFalseNegativeRate =
    suppressedSettledAll.length > 0
      ? (suppressedWinsAll / suppressedSettledAll.length) * 100
      : 0;

  return {
    totalRecords: diagnosticRecords.length,
    suppressedCount,
    suppressionRate:
      diagnosticRecords.length > 0
        ? (suppressedCount / diagnosticRecords.length) * 100
        : 0,
    suppressionFalseNegativeRate: Math.round(suppressionFalseNegativeRate * 100) / 100,
    projectionErrorByMarket,
    edgeSizeDistribution,
    liveFormBoostRate: {
      withBoost,
      withoutBoost,
      boostRate:
        diagnosticRecords.length > 0
          ? (withBoost / diagnosticRecords.length) * 100
          : 0,
    },
    earlyExplosiveStats: {
      total: earlyExplosiveAll.length,
      settled: earlyExplosiveSettled.length,
      hits: earlyHits,
      winRate:
        earlyExplosiveSettled.length > 0
          ? (earlyHits / earlyExplosiveSettled.length) * 100
          : 0,
      avgEdge: avgField(earlyExplosiveAll, (r) => Math.abs(r.edge)),
      avgCalibrated: avgField(earlyExplosiveAll, (r) => r.calibratedProbability),
    },
    standardModeStats: {
      total: standardAll.length,
      settled: standardSettled.length,
      hits: standardHits,
      winRate:
        standardSettled.length > 0
          ? (standardHits / standardSettled.length) * 100
          : 0,
      avgEdge: avgField(standardAll, (r) => Math.abs(r.edge)),
      avgCalibrated: avgField(standardAll, (r) => r.calibratedProbability),
    },
    winRateByConfidence,
    roiByConfidence,
    modifierContributionAvg,
  };
}

export function getMLBDiagnosticRecords(): MLBDiagnosticRecord[] {
  return [...diagnosticRecords];
}
