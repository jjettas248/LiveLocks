import type { MLBPropInput, MLBPropOutput, MLBMarket } from "./types";
import { ALL_MLB_MARKETS } from "./types";
import { calculateMLBPropEdge } from "./markets";
import {
  recordMLBDiagnostic,
  getMLBDiagnosticSummary,
  getMLBDiagnosticRecords,
  getMLBMarketReport,
  type MLBMarketReport,
} from "./diagnostics";

export interface BacktestCase {
  label: string;
  input: MLBPropInput;
  actualResult?: number;
}

export interface BacktestResult {
  label: string;
  market: MLBMarket;
  playerName: string;
  projection: number;
  bookLine: number;
  edge: number;
  calibratedProbability: number;
  calibratedProbabilityOver: number;
  calibratedProbabilityUnder: number;
  rawProbabilityOver: number;
  rawProbabilityUnder: number;
  recommendedSide: string;
  confidenceTier: string;
  mode: string;
  suppressed: boolean;
  suppressionReason: string | null;
  isExperimental: boolean;
  explanationBullets: string[];
  actualResult: number | null;
  hit: boolean | null;
  projectionError: number | null;
  projectionLog: MLBPropOutput["projectionLog"];
  warnings: string[];
}

export interface BacktestSummary {
  totalCases: number;
  settledCases: number;
  hitRate: number;
  avgProjectionError: number;
  avgEdge: number;
  suppressedCount: number;
  byMarket: Record<string, { count: number; settled: number; hits: number; avgError: number }>;
  byMode: Record<string, { count: number; settled: number; hits: number }>;
  diagnosticSnapshot: ReturnType<typeof getMLBDiagnosticSummary>;
  marketReport: MLBMarketReport[];
}

function makeEmptyProjectionLog(): MLBPropOutput["projectionLog"] {
  return {
    baseProjection: 0,
    liveFormAdjustment: 0,
    pitcherAdjustment: 0,
    pitchTypeAdjustment: 0,
    weatherParkAdjustment: 0,
    lineupAdjustment: 0,
    bullpenAdjustment: 0,
    parkHistoryAdjustment: 0,
    handednessMatchupAdjustment: 0,
    bvpHistoryAdjustment: 0,
    pocketWeaknessAdjustment: 0,
    finalCappedAdjustment: 0,
    rawProbability: 0,
    calibratedProbability: 0,
    confidenceTier: "NO_EDGE",
    modeUsed: "STANDARD",
  };
}

export function runBacktest(cases: BacktestCase[]): {
  results: BacktestResult[];
  summary: BacktestSummary;
} {
  const results: BacktestResult[] = [];

  for (const tc of cases) {
    if (!ALL_MLB_MARKETS.includes(tc.input.market)) {
      results.push({
        label: tc.label,
        market: tc.input.market,
        playerName: tc.input.playerName,
        projection: 0,
        bookLine: tc.input.bookLine,
        edge: 0,
        calibratedProbability: 50,
        calibratedProbabilityOver: 50,
        calibratedProbabilityUnder: 50,
        rawProbabilityOver: 50,
        rawProbabilityUnder: 50,
        recommendedSide: "NO_EDGE",
        confidenceTier: "NO_EDGE",
        mode: "standard",
        suppressed: true,
        suppressionReason: `Invalid market: ${tc.input.market}`,
        isExperimental: false,
        explanationBullets: [],
        actualResult: tc.actualResult ?? null,
        hit: null,
        projectionError: null,
        projectionLog: makeEmptyProjectionLog(),
        warnings: [`Invalid market: ${tc.input.market}`],
      });
      continue;
    }

    let output: MLBPropOutput;
    try {
      output = calculateMLBPropEdge(tc.input);
    } catch (err: any) {
      results.push({
        label: tc.label,
        market: tc.input.market,
        playerName: tc.input.playerName,
        projection: 0,
        bookLine: tc.input.bookLine,
        edge: 0,
        calibratedProbability: 50,
        calibratedProbabilityOver: 50,
        calibratedProbabilityUnder: 50,
        rawProbabilityOver: 50,
        rawProbabilityUnder: 50,
        recommendedSide: "NO_EDGE",
        confidenceTier: "NO_EDGE",
        mode: "standard",
        suppressed: true,
        suppressionReason: `Engine error: ${err.message}`,
        isExperimental: false,
        explanationBullets: [],
        actualResult: tc.actualResult ?? null,
        hit: null,
        projectionError: null,
        projectionLog: makeEmptyProjectionLog(),
        warnings: [err.message],
      });
      continue;
    }

    recordMLBDiagnostic(output, tc.actualResult);

    const projectionError =
      tc.actualResult !== undefined
        ? Math.abs(output.projection - tc.actualResult)
        : null;

    let hit: boolean | null = null;
    if (tc.actualResult !== undefined && output.recommendedSide !== "NO_EDGE") {
      hit =
        output.recommendedSide === "OVER"
          ? tc.actualResult > output.bookLine
          : tc.actualResult < output.bookLine;
    }

    results.push({
      label: tc.label,
      market: output.market,
      playerName: output.playerName,
      projection: output.projection,
      bookLine: output.bookLine,
      edge: output.edge,
      calibratedProbability: output.calibratedProbability,
      calibratedProbabilityOver: output.calibratedProbabilityOver,
      calibratedProbabilityUnder: output.calibratedProbabilityUnder,
      rawProbabilityOver: output.rawProbabilityOver,
      rawProbabilityUnder: output.rawProbabilityUnder,
      recommendedSide: output.recommendedSide,
      confidenceTier: output.confidenceTier,
      mode: output.mode,
      suppressed: output.suppressed,
      suppressionReason: output.suppressionReason,
      isExperimental: output.isExperimental,
      explanationBullets: output.explanationBullets,
      actualResult: tc.actualResult ?? null,
      hit,
      projectionError,
      projectionLog: output.projectionLog,
      warnings: output.warnings,
    });
  }

  const summary = buildSummary(results);
  return { results, summary };
}

export function runBatchInputs(inputs: MLBPropInput[]): {
  results: MLBPropOutput[];
  diagnosticsSummary: ReturnType<typeof getMLBDiagnosticSummary>;
  marketReport: MLBMarketReport[];
} {
  const results: MLBPropOutput[] = [];

  for (const input of inputs) {
    try {
      const output = calculateMLBPropEdge(input);
      recordMLBDiagnostic(output);
      results.push(output);
    } catch (err: any) {
      console.error(`[MLB backtest batch] Error for ${input.playerName}:`, err.message);
    }
  }

  return {
    results,
    diagnosticsSummary: getMLBDiagnosticSummary(),
    marketReport: getMLBMarketReport(),
  };
}

function buildSummary(results: BacktestResult[]): BacktestSummary {
  const settledResults = results.filter((r) => r.actualResult !== null);
  const hitsCount = settledResults.filter((r) => r.hit === true).length;
  const errors = settledResults
    .filter((r) => r.projectionError !== null)
    .map((r) => r.projectionError!);

  const byMarket: Record<
    string,
    { count: number; settled: number; hits: number; avgError: number }
  > = {};
  for (const r of results) {
    if (!byMarket[r.market]) {
      byMarket[r.market] = { count: 0, settled: 0, hits: 0, avgError: 0 };
    }
    byMarket[r.market].count++;
    if (r.actualResult !== null) {
      byMarket[r.market].settled++;
      if (r.hit === true) byMarket[r.market].hits++;
    }
  }
  for (const market of Object.keys(byMarket)) {
    const marketErrors = results
      .filter((r) => r.market === market && r.projectionError !== null)
      .map((r) => r.projectionError!);
    byMarket[market].avgError =
      marketErrors.length > 0
        ? marketErrors.reduce((s, e) => s + e, 0) / marketErrors.length
        : 0;
  }

  const byMode: Record<string, { count: number; settled: number; hits: number }> = {};
  for (const r of results) {
    if (!byMode[r.mode]) {
      byMode[r.mode] = { count: 0, settled: 0, hits: 0 };
    }
    byMode[r.mode].count++;
    if (r.actualResult !== null) {
      byMode[r.mode].settled++;
      if (r.hit === true) byMode[r.mode].hits++;
    }
  }

  return {
    totalCases: results.length,
    settledCases: settledResults.length,
    hitRate:
      settledResults.length > 0 ? (hitsCount / settledResults.length) * 100 : 0,
    avgProjectionError:
      errors.length > 0 ? errors.reduce((s, e) => s + e, 0) / errors.length : 0,
    avgEdge:
      results.length > 0
        ? results.reduce((s, r) => s + Math.abs(r.edge), 0) / results.length
        : 0,
    suppressedCount: results.filter((r) => r.suppressed).length,
    byMarket,
    byMode,
    diagnosticSnapshot: getMLBDiagnosticSummary(),
    marketReport: getMLBMarketReport(),
  };
}

export function getBacktestRecords(): ReturnType<typeof getMLBDiagnosticRecords> {
  return getMLBDiagnosticRecords();
}
