// Mound Radar V2 (shadow) — V1-vs-V2 comparison statistics (Flagship
// Program Phase 2, Part 6, corrected). Pure math, no I/O.
//
// TWO EXPLICITLY SEPARATE EVALUATIONS — never blended, never mislabeled:
//
// (A) PROBABILITY-MODEL EVALUATION (computeMoundV2ProbabilityEvaluation)
//     Scores V2's own Brier/log-loss/calibration against an HONESTLY NAMED
//     probability reference — "climatology" (a constant forecast equal to
//     the sample's own empirical over/under/push rate — the standard Brier
//     Skill Score baseline) or "market_implied" (the de-vigged two-sided
//     sportsbook price, when both sides were really captured). V1 has NO
//     probability (score10 is a matchup-quality composite, never a
//     probability — CLAUDE.md §3.9), so it is NEVER a comparator here and
//     every field name/struct makes the comparator explicit — no consumer
//     of this report can mistake a climatology delta for "V2 beats V1".
//
// (B) DECISION-POLICY EVALUATION (computeMoundV2DecisionPolicyComparison)
//     Compares V1 and V2 as two competing BETTORS on the same paired
//     population, using REAL captured prices for both — never assumes
//     -110. V1's own frozen recommended side (v1RecommendedSide, captured
//     going forward per Correction 1 — this was previously and incorrectly
//     treated as permanently unavailable) selects the correspondingly
//     frozen price (frozenOverPrice/frozenUnderPrice) for real units/ROI,
//     exactly the same captured-price discipline V2 already used. Legacy
//     rows captured before v1RecommendedSide existed (contractVersion
//     predates it) are excluded from this comparison with an explicit
//     count — never silently blended in as "V1 had no recommendation",
//     which is a different, legitimate bucket of its own.
//
// "Never double-counts": every row lands in exactly one of {legacy
// incomplete, V1 had no recommendation, paired-eligible} for decision-policy
// purposes, and the funnel's counts are drawn from that same single pass.

import { unitsWonPerDollarStaked } from "../../../episodes/mlbEpisodeMeasurement";
import { americanToImpliedProbability } from "../oddsDisplay";

const CALIBRATION_EPSILON = 1e-6;

/** Contract versions captured before v1RecommendedSide existed (Correction 1) — a fixed historical list, not a moving "predates current" check, since a future contract bump needs its own explicit judgment call rather than silently reclassifying old data. */
const CONTRACT_VERSIONS_MISSING_V1_RECOMMENDED_SIDE: ReadonlySet<string> = new Set(["mound_frozen_input_v1"]);

export type MoundV2ComparisonMarket = "pitcher_strikeouts" | "pitcher_outs";
export type MoundV2ComparisonFinalResult = "over" | "under" | "push";
export type MoundV2ProbabilityComparator = "climatology" | "market_implied";

/** One graded/void/pending V2 shadow prediction, reduced to what this report needs. */
export interface MoundV2ComparisonRow {
  gameId: string;
  pitcherId: string;
  market: string;
  settlementStatus: string; // "pending" | "graded" | "void"
  finalResult: MoundV2ComparisonFinalResult | null;
  frozenOverPrice: number | null;
  frozenUnderPrice: number | null;
  v2OverProbability: number;
  v2UnderProbability: number;
  v2PushProbability: number;
  /** V1's own frozen recommended side — see Correction 1. Null means EITHER V1 genuinely had no direction OR this row predates capture; disambiguated via contractVersion, never via this field alone. */
  v1RecommendedSide: "OVER" | "UNDER" | null;
  /** Which capture-contract version produced this row — the authority for the legacy-exclusion distinction above. */
  contractVersion: string;
  v1Tier: string | null;
  v2ModelVersion: string;
  productionModelVersion: string;
}

function clampProbability(p: number): number {
  return Math.min(1 - CALIBRATION_EPSILON, Math.max(CALIBRATION_EPSILON, p));
}

/** V2's own implied pick — whichever of over/under it assigns the higher probability to. Push is never a "pick" (you can't bet a push). */
export function impliedV2Side(row: MoundV2ComparisonRow): "over" | "under" {
  return row.v2OverProbability >= row.v2UnderProbability ? "over" : "under";
}

function v2PriceForImpliedSide(row: MoundV2ComparisonRow): number | null {
  return impliedV2Side(row) === "over" ? row.frozenOverPrice : row.frozenUnderPrice;
}

/** Net units for ONE graded-with-line row, using V2's OWN captured price on its own implied side. Null when no real price was ever captured for that side. */
export function v2UnitsForRow(row: MoundV2ComparisonRow): number | null {
  if (row.finalResult == null) return null;
  if (row.finalResult === "push") return 0;
  const price = v2PriceForImpliedSide(row);
  if (price == null || !Number.isFinite(price)) return null;
  return impliedV2Side(row) === row.finalResult ? unitsWonPerDollarStaked(price) : -1;
}

// ─────────────────────────────────────────────────────────────────────────
// (A) PROBABILITY-MODEL EVALUATION — V2 vs an explicitly named comparator
// ─────────────────────────────────────────────────────────────────────────

function trueClassProbabilities(row: MoundV2ComparisonRow): { over: number; under: number; push: number } {
  return {
    over: row.finalResult === "over" ? 1 : 0,
    under: row.finalResult === "under" ? 1 : 0,
    push: row.finalResult === "push" ? 1 : 0,
  };
}

/** Multi-class (3-way) Brier score for a set of (forecastProbs, trueClass) pairs — reduces to the familiar binary formula when push probability is ~0. */
function computeBrier(rows: readonly MoundV2ComparisonRow[], probsOf: (r: MoundV2ComparisonRow) => { over: number; under: number; push: number }): number | null {
  if (rows.length === 0) return null;
  const sum = rows.reduce((acc, row) => {
    const p = probsOf(row);
    const y = trueClassProbabilities(row);
    return acc + (p.over - y.over) ** 2 + (p.under - y.under) ** 2 + (p.push - y.push) ** 2;
  }, 0);
  return sum / rows.length;
}

/** Multi-class log loss: -log(probability assigned to whatever actually happened). */
function computeLogLoss(rows: readonly MoundV2ComparisonRow[], probsOf: (r: MoundV2ComparisonRow) => { over: number; under: number; push: number }): number | null {
  if (rows.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    const p = probsOf(row);
    const trueP = row.finalResult === "over" ? p.over : row.finalResult === "under" ? p.under : row.finalResult === "push" ? p.push : null;
    if (trueP == null) continue;
    sum += -Math.log(clampProbability(trueP));
    n++;
  }
  return n > 0 ? sum / n : null;
}

export interface MoundV2CalibrationBucket {
  bucketMin: number;
  bucketMax: number;
  n: number;
  avgConfidence: number;
  avgAccuracy: number;
}

/** Top-label expected calibration error + the per-bucket breakdown with sample sizes (never just the summary number — a bucket with n=2 is not evidence the way a bucket with n=200 is). */
function computeCalibrationErrorAndBuckets(
  rows: readonly MoundV2ComparisonRow[],
  probsOf: (r: MoundV2ComparisonRow) => { over: number; under: number; push: number },
  bucketCount = 10,
): { calibrationError: number | null; buckets: MoundV2CalibrationBucket[] } {
  if (rows.length === 0) return { calibrationError: null, buckets: [] };
  const buckets = Array.from({ length: bucketCount }, () => ({ sumConf: 0, sumCorrect: 0, n: 0 }));
  for (const row of rows) {
    const p = probsOf(row);
    const candidates: Array<[MoundV2ComparisonFinalResult, number]> = [["over", p.over], ["under", p.under], ["push", p.push]];
    const [topClass, topProbRaw] = candidates.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
    const conf = clampProbability(topProbRaw);
    const correct = topClass === row.finalResult ? 1 : 0;
    const idx = Math.min(bucketCount - 1, Math.floor(conf * bucketCount));
    buckets[idx].sumConf += conf;
    buckets[idx].sumCorrect += correct;
    buckets[idx].n += 1;
  }
  const total = rows.length;
  let ece = 0;
  const bucketRows: MoundV2CalibrationBucket[] = [];
  buckets.forEach((b, idx) => {
    if (b.n === 0) return;
    ece += (b.n / total) * Math.abs(b.sumConf / b.n - b.sumCorrect / b.n);
    bucketRows.push({
      bucketMin: idx / bucketCount,
      bucketMax: (idx + 1) / bucketCount,
      n: b.n,
      avgConfidence: b.sumConf / b.n,
      avgAccuracy: b.sumCorrect / b.n,
    });
  });
  return { calibrationError: ece, buckets: bucketRows };
}

/** Average distance of V2's own top-class probability from an uninformative 1/3 — how decisive V2's forecasts are, independent of whether they're right. Not compared against any baseline (sharpness has no "delta" — it's a property of the forecaster alone). */
function computeSharpness(rows: readonly MoundV2ComparisonRow[]): number | null {
  if (rows.length === 0) return null;
  const sum = rows.reduce((acc, row) => {
    const top = Math.max(row.v2OverProbability, row.v2UnderProbability, row.v2PushProbability);
    return acc + (top - 1 / 3);
  }, 0);
  return sum / rows.length;
}

function v2Probs(row: MoundV2ComparisonRow) {
  return { over: row.v2OverProbability, under: row.v2UnderProbability, push: row.v2PushProbability };
}

function climatologyRate(rows: readonly MoundV2ComparisonRow[]): { over: number; under: number; push: number } {
  const n = rows.length;
  if (n === 0) return { over: 1 / 3, under: 1 / 3, push: 1 / 3 };
  return {
    over: rows.filter((r) => r.finalResult === "over").length / n,
    under: rows.filter((r) => r.finalResult === "under").length / n,
    push: rows.filter((r) => r.finalResult === "push").length / n,
  };
}

/** De-vigged two-sided market-implied probability — proportional (multiplicative) de-vig, the standard simplest method. Null when either side's real price is missing (never fabricated, never falls back to a single-sided raw-implied number, which would still carry the vig). */
function marketImpliedProbs(row: MoundV2ComparisonRow): { over: number; under: number; push: number } | null {
  if (row.frozenOverPrice == null || row.frozenUnderPrice == null) return null;
  if (!Number.isFinite(row.frozenOverPrice) || !Number.isFinite(row.frozenUnderPrice)) return null;
  const rawOver = americanToImpliedProbability(row.frozenOverPrice);
  const rawUnder = americanToImpliedProbability(row.frozenUnderPrice);
  const total = rawOver + rawUnder;
  if (!(total > 0)) return null;
  // Market-implied is a genuinely 2-outcome forecast (a standard American
  // over/under price does not encode a push probability at all) — pushProb
  // stays 0 by construction. Rows that actually settle "push" are excluded
  // from this specific comparator upstream (see the exported builder) since
  // scoring a 2-outcome forecast against a 3rd, structurally-unpriced
  // outcome would be a category error, not honest measurement.
  return { over: rawOver / total, under: rawUnder / total, push: 0 };
}

export interface MoundV2ProbabilityEvaluation {
  comparator: MoundV2ProbabilityComparator;
  sampleSize: number;
  v2BrierScore: number | null;
  v2LogLoss: number | null;
  v2CalibrationError: number | null;
  v2CalibrationBuckets: MoundV2CalibrationBucket[];
  v2Sharpness: number | null;
  comparatorBrierScore: number | null;
  comparatorLogLoss: number | null;
  comparatorCalibrationError: number | null;
  /** V2 minus comparator. Negative/zero = V2 at least as good. Never labeled or usable as a "V2 vs V1" number — see the module header. */
  brierDelta: number | null;
  logLossDelta: number | null;
  calibrationErrorDelta: number | null;
}

/**
 * Probability-model evaluation against an EXPLICITLY NAMED, non-V1
 * comparator. `rows` should already be filtered to graded-with-a-real-line
 * (finalResult != null) — computeMoundV2OwnMetrics's gradedWithLine subset,
 * or equivalent.
 */
export function computeMoundV2ProbabilityEvaluation(
  gradedWithLine: readonly MoundV2ComparisonRow[],
  comparator: MoundV2ProbabilityComparator,
): MoundV2ProbabilityEvaluation {
  // The population BOTH V2 and the comparator are scored over — for
  // climatology this is every graded-with-line row; for market_implied
  // it's restricted to rows with a real two-sided captured price and a
  // non-push outcome (a standard American over/under price has no push
  // probability to compare against — see marketImpliedProbs). Scoring both
  // sides over the SAME population is what makes the delta a fair
  // apples-to-apples comparison rather than two differently-scoped numbers.
  const scoredRows = comparator === "climatology"
    ? gradedWithLine
    : gradedWithLine.filter((r) => marketImpliedProbs(r) != null && r.finalResult !== "push");

  let comparatorProbsOf: (r: MoundV2ComparisonRow) => { over: number; under: number; push: number };
  if (comparator === "climatology") {
    const rate = climatologyRate(gradedWithLine);
    comparatorProbsOf = () => rate;
  } else {
    comparatorProbsOf = (r) => marketImpliedProbs(r)!;
  }

  const v2BrierScore = computeBrier(scoredRows, v2Probs);
  const v2LogLoss = computeLogLoss(scoredRows, v2Probs);
  const { calibrationError: v2CalibrationError, buckets: v2CalibrationBuckets } = computeCalibrationErrorAndBuckets(scoredRows, v2Probs);
  const v2Sharpness = computeSharpness(scoredRows);

  const comparatorBrierScore = computeBrier(scoredRows, comparatorProbsOf);
  const comparatorLogLoss = computeLogLoss(scoredRows, comparatorProbsOf);
  const { calibrationError: comparatorCalibrationError } = computeCalibrationErrorAndBuckets(scoredRows, comparatorProbsOf);

  return {
    comparator,
    sampleSize: scoredRows.length,
    v2BrierScore,
    v2LogLoss,
    v2CalibrationError,
    v2CalibrationBuckets,
    v2Sharpness,
    comparatorBrierScore,
    comparatorLogLoss,
    comparatorCalibrationError,
    brierDelta: deltaOrUnmeasurable(v2BrierScore, comparatorBrierScore),
    logLossDelta: deltaOrUnmeasurable(v2LogLoss, comparatorLogLoss),
    calibrationErrorDelta: deltaOrUnmeasurable(v2CalibrationError, comparatorCalibrationError),
  };
}

const DELTA_EPSILON = 1e-9;
function deltaOrUnmeasurable(v2Metric: number | null, comparatorMetric: number | null): number | null {
  if (v2Metric == null || comparatorMetric == null) return null;
  const raw = v2Metric - comparatorMetric;
  return Math.abs(raw) < DELTA_EPSILON ? 0 : raw;
}

// ─────────────────────────────────────────────────────────────────────────
// (B) DECISION-POLICY EVALUATION — V1 vs V2, real captured prices, paired
// ─────────────────────────────────────────────────────────────────────────

export interface MoundV2DecisionPolicyMetrics {
  eligibleSnapshots: number;
  recommendationsProduced: number;
  coverage: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number | null;
  roiEligibleCount: number;
  units: number | null;
  roi: number | null;
  avgCapturedPrice: number | null;
}

function v1PriceForSide(row: MoundV2ComparisonRow, side: "OVER" | "UNDER"): number | null {
  return side === "OVER" ? row.frozenOverPrice : row.frozenUnderPrice;
}

function v1UnitsForRow(row: MoundV2ComparisonRow): number | null {
  if (row.v1RecommendedSide == null || row.finalResult == null) return null;
  if (row.finalResult === "push") return 0;
  const price = v1PriceForSide(row, row.v1RecommendedSide);
  if (price == null || !Number.isFinite(price)) return null;
  const won = row.v1RecommendedSide.toLowerCase() === row.finalResult;
  return won ? unitsWonPerDollarStaked(price) : -1;
}

function buildV1Metrics(eligibleSnapshots: readonly MoundV2ComparisonRow[]): MoundV2DecisionPolicyMetrics {
  const withRecommendation = eligibleSnapshots.filter((r) => r.v1RecommendedSide != null);
  const decided = withRecommendation.filter((r) => r.finalResult !== "push");
  const wins = decided.filter((r) => r.v1RecommendedSide!.toLowerCase() === r.finalResult).length;
  const losses = decided.length - wins;
  const pushes = withRecommendation.filter((r) => r.finalResult === "push").length;
  const unitsList = withRecommendation.map(v1UnitsForRow).filter((u): u is number => u != null);
  const prices = withRecommendation.map((r) => v1PriceForSide(r, r.v1RecommendedSide!)).filter((p): p is number => p != null && Number.isFinite(p));

  return {
    eligibleSnapshots: eligibleSnapshots.length,
    recommendationsProduced: withRecommendation.length,
    coverage: eligibleSnapshots.length > 0 ? withRecommendation.length / eligibleSnapshots.length : 0,
    wins, losses, pushes,
    winRate: decided.length > 0 ? wins / decided.length : null,
    roiEligibleCount: unitsList.length,
    units: unitsList.length > 0 ? unitsList.reduce((a, b) => a + b, 0) : null,
    roi: unitsList.length > 0 ? unitsList.reduce((a, b) => a + b, 0) / unitsList.length : null,
    avgCapturedPrice: prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
  };
}

function buildV2Metrics(eligibleSnapshots: readonly MoundV2ComparisonRow[]): MoundV2DecisionPolicyMetrics {
  // V2 always produces an implied side (over>=under or under>over) — it
  // never has a "no recommendation" case the way V1's track-tier signals
  // do, so recommendationsProduced === eligibleSnapshots for V2 by
  // construction. Reported explicitly rather than assumed, for symmetry
  // with V1's own metrics shape.
  const decided = eligibleSnapshots.filter((r) => r.finalResult !== "push");
  const wins = decided.filter((r) => impliedV2Side(r) === r.finalResult).length;
  const losses = decided.length - wins;
  const pushes = eligibleSnapshots.filter((r) => r.finalResult === "push").length;
  const unitsList = eligibleSnapshots.map(v2UnitsForRow).filter((u): u is number => u != null);
  const prices = eligibleSnapshots.map(v2PriceForImpliedSide).filter((p): p is number => p != null && Number.isFinite(p));

  return {
    eligibleSnapshots: eligibleSnapshots.length,
    recommendationsProduced: eligibleSnapshots.length,
    coverage: eligibleSnapshots.length > 0 ? 1 : 0,
    wins, losses, pushes,
    winRate: decided.length > 0 ? wins / decided.length : null,
    roiEligibleCount: unitsList.length,
    units: unitsList.length > 0 ? unitsList.reduce((a, b) => a + b, 0) : null,
    roi: unitsList.length > 0 ? unitsList.reduce((a, b) => a + b, 0) / unitsList.length : null,
    avgCapturedPrice: prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
  };
}

export interface MoundV2DecisionPolicyComparison {
  pairedN: number;
  legacyIncompleteDataCount: number;
  v1NoRecommendationCount: number;
  v1: MoundV2DecisionPolicyMetrics;
  v2: MoundV2DecisionPolicyMetrics;
  winRateDelta: number | null;
  roiDelta: number | null;
}

/**
 * Splits v2Rows (already restricted to graded-with-a-real-line) into the
 * three buckets the decision-policy comparison needs, in one pass:
 * legacy (predates v1RecommendedSide capture), V1-had-no-recommendation
 * (a legitimate "track" tier case, not incomplete data), and paired-eligible
 * (both V1 and V2 have a real, gradeable decision).
 */
function partitionForDecisionPolicy(gradedWithLine: readonly MoundV2ComparisonRow[]) {
  const legacy: MoundV2ComparisonRow[] = [];
  const noRecommendation: MoundV2ComparisonRow[] = [];
  const paired: MoundV2ComparisonRow[] = [];
  for (const row of gradedWithLine) {
    if (CONTRACT_VERSIONS_MISSING_V1_RECOMMENDED_SIDE.has(row.contractVersion)) {
      legacy.push(row);
    } else if (row.v1RecommendedSide == null) {
      noRecommendation.push(row);
    } else {
      paired.push(row);
    }
  }
  return { legacy, noRecommendation, paired };
}

/**
 * The core decision-policy comparison — V1 and V2 as two real bettors on
 * the same paired population, both graded from their own captured prices.
 * `gradedWithLine` should be the graded-with-a-real-line subset for the
 * scope being compared (overall, or one market/tier breakdown group).
 */
export function computeMoundV2DecisionPolicyComparison(
  gradedWithLine: readonly MoundV2ComparisonRow[],
): MoundV2DecisionPolicyComparison {
  const { legacy, noRecommendation, paired } = partitionForDecisionPolicy(gradedWithLine);

  const v1 = buildV1Metrics(paired);
  const v2 = buildV2Metrics(paired);

  return {
    pairedN: paired.length,
    legacyIncompleteDataCount: legacy.length,
    v1NoRecommendationCount: noRecommendation.length,
    v1,
    v2,
    winRateDelta: v1.winRate != null && v2.winRate != null ? v2.winRate - v1.winRate : null,
    roiDelta: v1.roi != null && v2.roi != null ? v2.roi - v1.roi : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// V2's own standalone metrics (self-contained, unrelated to V1)
// ─────────────────────────────────────────────────────────────────────────

export interface MoundV2OwnMetrics {
  sampleSize: number;
  gradedCount: number;
  voidCount: number;
  pendingCount: number;
  coverage: number;
  gradedWithLineCount: number;
  gradedNoLineCount: number;
}

export function computeMoundV2OwnMetrics(rows: readonly MoundV2ComparisonRow[]): MoundV2OwnMetrics {
  const sampleSize = rows.length;
  const graded = rows.filter((r) => r.settlementStatus === "graded");
  const voided = rows.filter((r) => r.settlementStatus === "void");
  const pending = rows.filter((r) => r.settlementStatus === "pending");
  const gradedWithLine = graded.filter((r) => r.finalResult != null);
  const gradedNoLine = graded.filter((r) => r.finalResult == null);
  return {
    sampleSize,
    gradedCount: graded.length,
    voidCount: voided.length,
    pendingCount: pending.length,
    coverage: sampleSize > 0 ? graded.length / sampleSize : 0,
    gradedWithLineCount: gradedWithLine.length,
    gradedNoLineCount: gradedNoLine.length,
  };
}

function gradedWithLineOf(rows: readonly MoundV2ComparisonRow[]): MoundV2ComparisonRow[] {
  return rows.filter((r) => r.settlementStatus === "graded" && r.finalResult != null);
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level report
// ─────────────────────────────────────────────────────────────────────────

export interface MoundV2ComparisonBreakdownRow {
  dimension: "market" | "tier";
  key: string;
  ownMetrics: MoundV2OwnMetrics;
  probabilityEvaluation: MoundV2ProbabilityEvaluation;
  decisionPolicy: MoundV2DecisionPolicyComparison;
}

function groupKey(dimension: "market" | "tier", market: string, tier: string | null): string {
  return dimension === "market" ? market : (tier ?? "unknown");
}

function buildBreakdown(rows: readonly MoundV2ComparisonRow[], dimension: "market" | "tier"): MoundV2ComparisonBreakdownRow[] {
  const groups = new Map<string, MoundV2ComparisonRow[]>();
  for (const row of rows) {
    const key = groupKey(dimension, row.market, row.v1Tier);
    const arr = groups.get(key);
    if (arr) arr.push(row); else groups.set(key, [row]);
  }
  return Array.from(groups.keys()).sort().map((key) => {
    const subset = groups.get(key)!;
    const gwl = gradedWithLineOf(subset);
    return {
      dimension,
      key,
      ownMetrics: computeMoundV2OwnMetrics(subset),
      probabilityEvaluation: computeMoundV2ProbabilityEvaluation(gwl, "climatology"),
      decisionPolicy: computeMoundV2DecisionPolicyComparison(gwl),
    };
  });
}

export interface MoundV2ComparisonReport {
  windowStart: string | null;
  windowEnd: string | null;
  v2ModelVersions: string[];
  productionModelVersions: string[];
  ownMetrics: MoundV2OwnMetrics;
  probabilityEvaluationVsClimatology: MoundV2ProbabilityEvaluation;
  probabilityEvaluationVsMarketImplied: MoundV2ProbabilityEvaluation;
  decisionPolicy: MoundV2DecisionPolicyComparison;
  byMarket: MoundV2ComparisonBreakdownRow[];
  byTier: MoundV2ComparisonBreakdownRow[];
}

/**
 * Top-level report builder. windowStart/windowEnd are metadata only (what
 * window the caller declares it queried for) — Mound V2's storage layer
 * already supports server-side evaluationTimestamp filtering (Part 4), so
 * the window is expected to already be applied by the caller/gatherer.
 */
export function buildMoundV2ComparisonReport(
  rows: readonly MoundV2ComparisonRow[],
  opts: { windowStart?: string | null; windowEnd?: string | null } = {},
): MoundV2ComparisonReport {
  const gwl = gradedWithLineOf(rows);
  return {
    windowStart: opts.windowStart ?? null,
    windowEnd: opts.windowEnd ?? null,
    v2ModelVersions: Array.from(new Set(rows.map((r) => r.v2ModelVersion))).sort(),
    productionModelVersions: Array.from(new Set(rows.map((r) => r.productionModelVersion))).sort(),
    ownMetrics: computeMoundV2OwnMetrics(rows),
    probabilityEvaluationVsClimatology: computeMoundV2ProbabilityEvaluation(gwl, "climatology"),
    probabilityEvaluationVsMarketImplied: computeMoundV2ProbabilityEvaluation(gwl, "market_implied"),
    decisionPolicy: computeMoundV2DecisionPolicyComparison(gwl),
    byMarket: buildBreakdown(rows, "market"),
    byTier: buildBreakdown(rows, "tier"),
  };
}
