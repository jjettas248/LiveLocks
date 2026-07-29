// ── MLB Performance Measurement — pure math over frozen episodes ─────────
// Server-only; the client renders MlbPerformanceReport verbatim and never
// computes it (CLAUDE.md: "UI never calculates ... settlement"). Every
// function here is pure: no I/O, no Date.now(), no randomness. ROI/units use
// each episode's own captured americanOdds — never a flat -110 assumption.

import type {
  MlbRecommendationEpisode, MlbSettlementResult,
} from "@shared/mlbRecommendationEpisode";
import type {
  MlbPerformanceMetrics, MlbPerformanceReport, MlbPerformanceBreakdownRow,
  MlbPerformanceBreakdownDimension,
} from "@shared/mlbPerformanceMeasurement";

const DECIDED_RESULTS: ReadonlySet<string> = new Set(["cashed", "missed"]);
const CALIBRATION_EPSILON = 1e-6;

/** Profit in units per 1 unit staked, on a WIN, at the given American price. */
export function unitsWonPerDollarStaked(americanOdds: number): number {
  if (!Number.isFinite(americanOdds) || americanOdds === 0) {
    throw new RangeError(`Invalid American odds: ${americanOdds}`);
  }
  return americanOdds > 0 ? americanOdds / 100 : 100 / Math.abs(americanOdds);
}

/** Net units for ONE settled episode, using its own captured price. */
export function unitsForEpisode(episode: MlbRecommendationEpisode): number {
  switch (episode.settlementResult) {
    case "cashed": return unitsWonPerDollarStaked(episode.americanOdds);
    case "missed": return -1;
    case "push":
    case "void":
    case null:
    default:
      return 0;
  }
}

function officialEpisodes(episodes: readonly MlbRecommendationEpisode[]): MlbRecommendationEpisode[] {
  return episodes.filter((e) => e.isOfficial === true);
}

function clampProbability(p: number): number {
  return Math.min(1 - CALIBRATION_EPSILON, Math.max(CALIBRATION_EPSILON, p));
}

function impliedProbabilityFromAmerican(americanOdds: number): number {
  return americanOdds > 0
    ? 100 / (americanOdds + 100)
    : Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
}

export function filterEpisodesByWindow(
  episodes: readonly MlbRecommendationEpisode[],
  windowStart: string | null,
  windowEnd: string | null,
): MlbRecommendationEpisode[] {
  const startMs = windowStart ? new Date(windowStart).getTime() : -Infinity;
  const endMs = windowEnd ? new Date(windowEnd).getTime() : Infinity;
  return episodes.filter((e) => {
    const t = new Date(e.recommendationCreatedAt).getTime();
    return t >= startMs && t <= endMs;
  });
}

function computeExpectedCalibrationError(
  decided: readonly MlbRecommendationEpisode[],
  bucketCount = 10,
): number {
  const buckets: { sumP: number; sumY: number; n: number }[] =
    Array.from({ length: bucketCount }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  for (const e of decided) {
    const p = clampProbability(e.modelProbability);
    const y = e.settlementResult === "cashed" ? 1 : 0;
    const idx = Math.min(bucketCount - 1, Math.floor(p * bucketCount));
    buckets[idx].sumP += p;
    buckets[idx].sumY += y;
    buckets[idx].n += 1;
  }
  const total = decided.length;
  let ece = 0;
  for (const b of buckets) {
    if (b.n === 0) continue;
    ece += (b.n / total) * Math.abs(b.sumP / b.n - b.sumY / b.n);
  }
  return ece;
}

export function computeMlbPerformanceMetrics(
  episodesIn: readonly MlbRecommendationEpisode[],
  opts: { closingOddsByEpisodeId?: ReadonlyMap<string, number> } = {},
): MlbPerformanceMetrics {
  const episodes = officialEpisodes(episodesIn);
  const settled = episodes.filter((e) => e.status === "settled" && e.settlementResult !== null);
  const decided = settled.filter((e) => DECIDED_RESULTS.has(e.settlementResult as MlbSettlementResult));
  const wins = decided.filter((e) => e.settlementResult === "cashed").length;
  const losses = decided.filter((e) => e.settlementResult === "missed").length;
  const pushes = settled.filter((e) => e.settlementResult === "push").length;
  const voids = settled.filter((e) => e.settlementResult === "void").length;

  const unitsWonLost = settled.reduce((sum, e) => sum + unitsForEpisode(e), 0);
  const stakedCount = wins + losses + pushes; // void stakes nothing (DNP-style, no action)
  const winRate = (wins + losses) > 0 ? wins / (wins + losses) : null;
  const roi = stakedCount > 0 ? unitsWonLost / stakedCount : null;

  const brierScore = decided.length > 0
    ? decided.reduce((sum, e) => {
        const p = clampProbability(e.modelProbability);
        const y = e.settlementResult === "cashed" ? 1 : 0;
        return sum + (p - y) ** 2;
      }, 0) / decided.length
    : null;

  const logLoss = decided.length > 0
    ? decided.reduce((sum, e) => {
        const p = clampProbability(e.modelProbability);
        const y = e.settlementResult === "cashed" ? 1 : 0;
        return sum - (y * Math.log(p) + (1 - y) * Math.log(1 - p));
      }, 0) / decided.length
    : null;

  const calibrationError = decided.length > 0 ? computeExpectedCalibrationError(decided) : null;

  let clv: number | null = null;
  if (opts.closingOddsByEpisodeId && decided.length > 0) {
    const clvSamples: number[] = [];
    for (const e of decided) {
      const closing = opts.closingOddsByEpisodeId.get(e.episodeId);
      if (closing === undefined || !Number.isFinite(closing)) continue;
      const openImplied = impliedProbabilityFromAmerican(e.americanOdds);
      const closeImplied = impliedProbabilityFromAmerican(closing);
      // Positive CLV = the line moved in the bettor's favor after capture.
      clvSamples.push(openImplied - closeImplied);
    }
    if (clvSamples.length > 0) {
      clv = clvSamples.reduce((a, b) => a + b, 0) / clvSamples.length;
    }
  }

  return {
    sampleSize: episodes.length,
    settledCount: settled.length,
    wins, losses, pushes, voids,
    winRate,
    unitsWonLost,
    roi,
    brierScore,
    logLoss,
    calibrationError,
    coverage: episodes.length > 0 ? settled.length / episodes.length : 0,
    clv,
  };
}

function keyFor(e: MlbRecommendationEpisode, dimension: MlbPerformanceBreakdownDimension): string {
  switch (dimension) {
    case "product": return e.product;
    case "market": return e.market;
    case "side": return e.recommendedSide;
    case "setupGrade": return e.setupGrade;
    case "modelVersion": return e.modelVersion;
    case "gamePhase": return e.gamePhase ?? "pregame";
    case "dataQuality": return e.dataQuality;
  }
}

function buildBreakdown(
  episodes: readonly MlbRecommendationEpisode[],
  dimension: MlbPerformanceBreakdownDimension,
): MlbPerformanceBreakdownRow[] {
  const groups = new Map<string, MlbRecommendationEpisode[]>();
  for (const e of episodes) {
    const key = keyFor(e, dimension);
    const arr = groups.get(key);
    if (arr) arr.push(e); else groups.set(key, [e]);
  }
  return Array.from(groups.entries())
    .map(([key, rows]) => ({ dimension, key, metrics: computeMlbPerformanceMetrics(rows) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function buildMlbPerformanceReport(
  episodesIn: readonly MlbRecommendationEpisode[],
  opts: {
    windowStart?: string | null;
    windowEnd?: string | null;
    closingOddsByEpisodeId?: ReadonlyMap<string, number>;
  } = {},
): MlbPerformanceReport {
  const windowed = filterEpisodesByWindow(episodesIn, opts.windowStart ?? null, opts.windowEnd ?? null);
  const metricsOpts = { closingOddsByEpisodeId: opts.closingOddsByEpisodeId };
  return {
    windowStart: opts.windowStart ?? null,
    windowEnd: opts.windowEnd ?? null,
    overall: computeMlbPerformanceMetrics(windowed, metricsOpts),
    byProduct: buildBreakdown(windowed, "product"),
    byMarket: buildBreakdown(windowed, "market"),
    bySide: buildBreakdown(windowed, "side"),
    bySetupGrade: buildBreakdown(windowed, "setupGrade"),
    byModelVersion: buildBreakdown(windowed, "modelVersion"),
    byGamePhase: buildBreakdown(windowed, "gamePhase"),
    byDataQuality: buildBreakdown(windowed, "dataQuality"),
  };
}
