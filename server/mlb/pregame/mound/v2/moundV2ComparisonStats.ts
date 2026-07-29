// Mound Radar V2 (shadow) — V1-vs-V2 comparison statistics (Flagship
// Program Phase 2, Part 6). Pure math, no I/O — mirrors the conventions
// already established in server/mlb/episodes/mlbEpisodeMeasurement.ts
// (clamped-probability Brier/log-loss/ECE, ROI from each row's own
// captured American odds, never a flat -110 assumption) generalized to
// V2's three-way over/under/push forecast. The DB-touching gatherer that
// assembles real MoundV2ComparisonRow/MoundV1OutcomeSummary arrays lives in
// the sibling moundV2ComparisonGatherer.ts.
//
// Central asymmetry this file makes explicit rather than papering over:
// V1's own settlement record (MoundSignal.outcomes) captures the frozen
// LINE it graded against but never captures a sportsbook PRICE — so a real,
// non-fabricated V1 ROI simply cannot be computed (doing so would require
// assuming a price, e.g. -110, which is exactly what "never assume -110"
// forbids). V1's side of every comparison is therefore win-rate-only, with
// an explicit roiNote saying why, while V2 gets a full ROI computed from
// its own genuinely captured frozenOverPrice/frozenUnderPrice (immutable
// since Part 4). This is a real, useful finding about V1's existing
// settlement schema, not a limitation of this report.
//
// "Never double-counts": the paired comparison and coverage/exclusion
// report are built from the SAME single pass over v2Rows joined against a
// v1Outcomes map keyed by gameId:pitcherId:market — every v2 row lands in
// exactly one of {no V1 match, V1 match with no real bet, paired} and the
// coverage funnel's counts are drawn from that same partition, so nothing
// can appear in more than one bucket or be silently dropped.

import { unitsWonPerDollarStaked } from "../../../episodes/mlbEpisodeMeasurement";

const CALIBRATION_EPSILON = 1e-6;

export type MoundV2ComparisonMarket = "pitcher_strikeouts" | "pitcher_outs";
export type MoundV2ComparisonFinalResult = "over" | "under" | "push";
export type MoundV1MarketOutcome = "cashed" | "missed" | "push" | "unavailable";

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
  v1Tier: string | null;
  v2ModelVersion: string;
  productionModelVersion: string;
}

/**
 * V1's own real settlement outcome for the SAME (gameId, pitcherId, market)
 * — deliberately minimal (no price field: V1 doesn't capture one). See
 * moundOutcomeAttribution.ts's deriveMoundMarketOutcome / MoundSignal's
 * outcomes.marketOutcome for what this is built from in the real gatherer.
 */
export interface MoundV1OutcomeSummary {
  gameId: string;
  pitcherId: string;
  market: string;
  marketOutcome: MoundV1MarketOutcome;
  tier: string | null;
}

function keyOf(gameId: string, pitcherId: string, market: string): string {
  return `${gameId}:${pitcherId}:${market}`;
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

function trueClassProbability(row: MoundV2ComparisonRow): number | null {
  if (row.finalResult === "over") return row.v2OverProbability;
  if (row.finalResult === "under") return row.v2UnderProbability;
  if (row.finalResult === "push") return row.v2PushProbability;
  return null;
}

/** Multi-class (3-way) Brier score — reduces to the familiar binary formula when push probability is ~0. */
function computeV2Brier(gradedWithLine: readonly MoundV2ComparisonRow[]): number | null {
  if (gradedWithLine.length === 0) return null;
  const sum = gradedWithLine.reduce((acc, row) => {
    const yOver = row.finalResult === "over" ? 1 : 0;
    const yUnder = row.finalResult === "under" ? 1 : 0;
    const yPush = row.finalResult === "push" ? 1 : 0;
    return acc + (row.v2OverProbability - yOver) ** 2 + (row.v2UnderProbability - yUnder) ** 2 + (row.v2PushProbability - yPush) ** 2;
  }, 0);
  return sum / gradedWithLine.length;
}

/** Multi-class log loss: -log(probability assigned to whatever actually happened). */
function computeV2LogLoss(gradedWithLine: readonly MoundV2ComparisonRow[]): number | null {
  if (gradedWithLine.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const row of gradedWithLine) {
    const p = trueClassProbability(row);
    if (p == null) continue;
    sum += -Math.log(clampProbability(p));
    n++;
  }
  return n > 0 ? sum / n : null;
}

/** Top-label expected calibration error: bucket by V2's own highest-confidence class, compare stated confidence to that class's actual hit rate. */
function computeV2CalibrationError(gradedWithLine: readonly MoundV2ComparisonRow[], bucketCount = 10): number | null {
  if (gradedWithLine.length === 0) return null;
  const buckets = Array.from({ length: bucketCount }, () => ({ sumConf: 0, sumCorrect: 0, n: 0 }));
  for (const row of gradedWithLine) {
    const candidates: Array<[MoundV2ComparisonFinalResult, number]> = [
      ["over", row.v2OverProbability],
      ["under", row.v2UnderProbability],
      ["push", row.v2PushProbability],
    ];
    const [topClass, topProbRaw] = candidates.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
    const conf = clampProbability(topProbRaw);
    const correct = topClass === row.finalResult ? 1 : 0;
    const idx = Math.min(bucketCount - 1, Math.floor(conf * bucketCount));
    buckets[idx].sumConf += conf;
    buckets[idx].sumCorrect += correct;
    buckets[idx].n += 1;
  }
  const total = gradedWithLine.length;
  let ece = 0;
  for (const b of buckets) {
    if (b.n === 0) continue;
    ece += (b.n / total) * Math.abs(b.sumConf / b.n - b.sumCorrect / b.n);
  }
  return ece;
}

export interface MoundV2OwnMetrics {
  sampleSize: number;
  gradedCount: number;
  voidCount: number;
  pendingCount: number;
  coverage: number;
  gradedWithLineCount: number;
  gradedNoLineCount: number;
  brierScore: number | null;
  logLoss: number | null;
  calibrationError: number | null;
  winRate: number | null;
  roi: number | null;
  roiSampleSize: number;
  unitsWonLost: number | null;
}

/** V2's own metrics — fully self-contained (needs no V1 data at all). */
export function computeMoundV2OwnMetrics(rows: readonly MoundV2ComparisonRow[]): MoundV2OwnMetrics {
  const sampleSize = rows.length;
  const graded = rows.filter((r) => r.settlementStatus === "graded");
  const voided = rows.filter((r) => r.settlementStatus === "void");
  const pending = rows.filter((r) => r.settlementStatus === "pending");
  const gradedWithLine = graded.filter((r) => r.finalResult != null);
  const gradedNoLine = graded.filter((r) => r.finalResult == null);

  const decided = gradedWithLine.filter((r) => r.finalResult !== "push");
  const wins = decided.filter((r) => impliedV2Side(r) === r.finalResult).length;
  const winRate = decided.length > 0 ? wins / decided.length : null;

  const unitsList = gradedWithLine.map(v2UnitsForRow).filter((u): u is number => u != null);
  const unitsWonLost = unitsList.length > 0 ? unitsList.reduce((a, b) => a + b, 0) : null;
  const roi = unitsList.length > 0 ? unitsList.reduce((a, b) => a + b, 0) / unitsList.length : null;

  return {
    sampleSize,
    gradedCount: graded.length,
    voidCount: voided.length,
    pendingCount: pending.length,
    coverage: sampleSize > 0 ? graded.length / sampleSize : 0,
    gradedWithLineCount: gradedWithLine.length,
    gradedNoLineCount: gradedNoLine.length,
    brierScore: computeV2Brier(gradedWithLine),
    logLoss: computeV2LogLoss(gradedWithLine),
    calibrationError: computeV2CalibrationError(gradedWithLine),
    winRate,
    roi,
    roiSampleSize: unitsList.length,
    unitsWonLost,
  };
}

export interface MoundV1Metrics {
  sampleSize: number;
  cashed: number;
  missed: number;
  push: number;
  unavailable: number;
  winRate: number | null;
  roiNote: string;
}

const V1_ROI_NOTE =
  "not computable — V1's settlement record (MoundSignal.outcomes) captures the frozen line it graded against but never a sportsbook price, and assuming one (e.g. -110) is not permitted";

/** V1's own metrics from its real settlement record — win-rate only; see V1_ROI_NOTE for why ROI is absent rather than fabricated. */
export function computeMoundV1Metrics(outcomes: readonly MoundV1OutcomeSummary[]): MoundV1Metrics {
  const sampleSize = outcomes.length;
  const cashed = outcomes.filter((o) => o.marketOutcome === "cashed").length;
  const missed = outcomes.filter((o) => o.marketOutcome === "missed").length;
  const push = outcomes.filter((o) => o.marketOutcome === "push").length;
  const unavailable = outcomes.filter((o) => o.marketOutcome === "unavailable").length;
  const decided = cashed + missed;
  return {
    sampleSize, cashed, missed, push, unavailable,
    winRate: decided > 0 ? cashed / decided : null,
    roiNote: V1_ROI_NOTE,
  };
}

export interface MoundV2PairedComparison {
  pairedN: number;
  v1WinRate: number | null;
  v2WinRate: number | null;
  winRateDelta: number | null;
  v2Roi: number | null;
  v1RoiNote: string;
}

interface PairedEntry {
  v2: MoundV2ComparisonRow;
  v1: MoundV1OutcomeSummary;
}

/** The single join every paired/coverage computation shares — a v2 row pairs with V1 only when V2 graded a real line AND V1 recorded a real (non-"unavailable") bet for the same key. */
function pairRows(
  v2Rows: readonly MoundV2ComparisonRow[],
  v1Outcomes: readonly MoundV1OutcomeSummary[],
): PairedEntry[] {
  const v1ByKey = new Map(v1Outcomes.map((o) => [keyOf(o.gameId, o.pitcherId, o.market), o]));
  const paired: PairedEntry[] = [];
  for (const row of v2Rows) {
    if (row.settlementStatus !== "graded" || row.finalResult == null) continue;
    const v1 = v1ByKey.get(keyOf(row.gameId, row.pitcherId, row.market));
    if (!v1 || v1.marketOutcome === "unavailable") continue;
    paired.push({ v2: row, v1 });
  }
  return paired;
}

/** Both-models-valid comparison, computed ONLY over the paired subset (never blended with V2-only or V1-only rows). */
export function computeMoundV2PairedComparison(
  v2Rows: readonly MoundV2ComparisonRow[],
  v1Outcomes: readonly MoundV1OutcomeSummary[],
): MoundV2PairedComparison {
  const paired = pairRows(v2Rows, v1Outcomes);

  const v1Decided = paired.filter((p) => p.v1.marketOutcome === "cashed" || p.v1.marketOutcome === "missed");
  const v1WinRate = v1Decided.length > 0
    ? v1Decided.filter((p) => p.v1.marketOutcome === "cashed").length / v1Decided.length
    : null;

  const v2Decided = paired.filter((p) => p.v2.finalResult !== "push");
  const v2Wins = v2Decided.filter((p) => impliedV2Side(p.v2) === p.v2.finalResult).length;
  const v2WinRate = v2Decided.length > 0 ? v2Wins / v2Decided.length : null;

  const v2UnitsList = paired.map((p) => v2UnitsForRow(p.v2)).filter((u): u is number => u != null);
  const v2Roi = v2UnitsList.length > 0 ? v2UnitsList.reduce((a, b) => a + b, 0) / v2UnitsList.length : null;

  return {
    pairedN: paired.length,
    v1WinRate,
    v2WinRate,
    winRateDelta: v1WinRate != null && v2WinRate != null ? v2WinRate - v1WinRate : null,
    v2Roi,
    v1RoiNote: V1_ROI_NOTE,
  };
}

export interface MoundV2CoverageReport {
  totalV2InWindow: number;
  v2Graded: number;
  v2Void: number;
  v2Pending: number;
  v2GradedWithLine: number;
  v2GradedNoLine: number;
  v2WithV1Match: number;
  v2WithNoV1Match: number;
  v1MatchedWithRealBet: number;
  v1MatchedUnavailableBet: number;
  pairedN: number;
}

/** Explicit funnel — every v2Row lands in exactly one of {no V1 match, V1 match / unavailable bet, V1 match / real bet}, so nothing is silently dropped or double-counted. */
export function computeMoundV2CoverageReport(
  v2Rows: readonly MoundV2ComparisonRow[],
  v1Outcomes: readonly MoundV1OutcomeSummary[],
): MoundV2CoverageReport {
  const v1ByKey = new Map(v1Outcomes.map((o) => [keyOf(o.gameId, o.pitcherId, o.market), o]));
  const gradedRows = v2Rows.filter((r) => r.settlementStatus === "graded");

  let v2WithV1Match = 0;
  let v2WithNoV1Match = 0;
  let v1MatchedWithRealBet = 0;
  let v1MatchedUnavailableBet = 0;

  for (const row of v2Rows) {
    const v1 = v1ByKey.get(keyOf(row.gameId, row.pitcherId, row.market));
    if (!v1) {
      v2WithNoV1Match++;
      continue;
    }
    v2WithV1Match++;
    if (v1.marketOutcome === "unavailable") v1MatchedUnavailableBet++;
    else v1MatchedWithRealBet++;
  }

  return {
    totalV2InWindow: v2Rows.length,
    v2Graded: gradedRows.length,
    v2Void: v2Rows.filter((r) => r.settlementStatus === "void").length,
    v2Pending: v2Rows.filter((r) => r.settlementStatus === "pending").length,
    v2GradedWithLine: gradedRows.filter((r) => r.finalResult != null).length,
    v2GradedNoLine: gradedRows.filter((r) => r.finalResult == null).length,
    v2WithV1Match,
    v2WithNoV1Match,
    v1MatchedWithRealBet,
    v1MatchedUnavailableBet,
    pairedN: pairRows(v2Rows, v1Outcomes).length,
  };
}

export interface MoundV2ComparisonBreakdownRow {
  dimension: "market" | "tier";
  key: string;
  v2: MoundV2OwnMetrics;
  v1: MoundV1Metrics;
  paired: MoundV2PairedComparison;
}

function groupKey(dimension: "market" | "tier", market: string, tier: string | null): string {
  return dimension === "market" ? market : (tier ?? "unknown");
}

function buildBreakdown(
  v2Rows: readonly MoundV2ComparisonRow[],
  v1Outcomes: readonly MoundV1OutcomeSummary[],
  dimension: "market" | "tier",
): MoundV2ComparisonBreakdownRow[] {
  const v2Groups = new Map<string, MoundV2ComparisonRow[]>();
  for (const row of v2Rows) {
    const key = groupKey(dimension, row.market, row.v1Tier);
    const arr = v2Groups.get(key);
    if (arr) arr.push(row); else v2Groups.set(key, [row]);
  }
  const v1Groups = new Map<string, MoundV1OutcomeSummary[]>();
  for (const o of v1Outcomes) {
    const key = groupKey(dimension, o.market, o.tier);
    const arr = v1Groups.get(key);
    if (arr) arr.push(o); else v1Groups.set(key, [o]);
  }
  const keys = new Set<string>([...Array.from(v2Groups.keys()), ...Array.from(v1Groups.keys())]);
  return Array.from(keys).sort().map((key) => {
    const v2Subset = v2Groups.get(key) ?? [];
    const v1Subset = v1Groups.get(key) ?? [];
    return {
      dimension,
      key,
      v2: computeMoundV2OwnMetrics(v2Subset),
      v1: computeMoundV1Metrics(v1Subset),
      paired: computeMoundV2PairedComparison(v2Subset, v1Subset),
    };
  });
}

export interface MoundV2ComparisonReport {
  windowStart: string | null;
  windowEnd: string | null;
  v2ModelVersions: string[];
  productionModelVersions: string[];
  overallV2: MoundV2OwnMetrics;
  overallV1: MoundV1Metrics;
  overallPaired: MoundV2PairedComparison;
  coverage: MoundV2CoverageReport;
  byMarket: MoundV2ComparisonBreakdownRow[];
  byTier: MoundV2ComparisonBreakdownRow[];
}

/**
 * Top-level report builder. windowStart/windowEnd are metadata only (what
 * window the caller declares it queried for) — unlike
 * mlbEpisodeMeasurement.ts's in-memory filterEpisodesByWindow, Mound V2's
 * storage.listMoundV2ShadowPredictions already supports server-side
 * fromEvaluationTimestamp/toEvaluationTimestamp filtering (Part 4), so the
 * window is expected to already be applied by the caller/gatherer before
 * rows reach this function, not re-filtered here.
 */
export function buildMoundV2ComparisonReport(
  v2Rows: readonly MoundV2ComparisonRow[],
  v1Outcomes: readonly MoundV1OutcomeSummary[],
  opts: { windowStart?: string | null; windowEnd?: string | null } = {},
): MoundV2ComparisonReport {
  return {
    windowStart: opts.windowStart ?? null,
    windowEnd: opts.windowEnd ?? null,
    v2ModelVersions: Array.from(new Set(v2Rows.map((r) => r.v2ModelVersion))).sort(),
    productionModelVersions: Array.from(new Set(v2Rows.map((r) => r.productionModelVersion))).sort(),
    overallV2: computeMoundV2OwnMetrics(v2Rows),
    overallV1: computeMoundV1Metrics(v1Outcomes),
    overallPaired: computeMoundV2PairedComparison(v2Rows, v1Outcomes),
    coverage: computeMoundV2CoverageReport(v2Rows, v1Outcomes),
    byMarket: buildBreakdown(v2Rows, v1Outcomes, "market"),
    byTier: buildBreakdown(v2Rows, v1Outcomes, "tier"),
  };
}
