// ── MLB Live Edge Trust Recovery (Phase 6) — calibration foundation report ──
// Read-only. Computes calibration-quality metrics (Brier score, log loss,
// reliability buckets, expected calibration error) for settled OFFICIAL MLB
// plays only. This module NEVER selects thresholds, NEVER adapts production
// behavior, and NEVER mutates anything — it only measures.
//
// Official vs shadow are reported SEPARATELY, never blended:
//   - Official metrics are computed from persisted_plays, which (after Phase
//     4 of this recovery) contains ONLY signals that passed
//     evaluateMlbOfficialEligibility at persistence time. Clean-official rows
//     additionally require officialEpisodeKey + oddsSourceUpdatedAt
//     provenance, excluding legacy pre-recovery rows from calibration math
//     (they may still carry fabricated/ambiguous provenance).
//   - Shadow metrics from server/mlb/shadowQualification.ts are an in-process
//     Map with no durable, date-range-queryable history. Per this recovery's
//     requirement, general historical shadow calibration is explicitly
//     reported as UNAVAILABLE rather than fabricated from that in-memory
//     store — see `shadowAvailability` below. HR Radar's own shadow/official
//     split (server/analytics/hrRadarShadowMetrics.ts,
//     hrRadarIntelligence.ts) is a separate, HR-specific system and is not a
//     substitute for general Live Edge shadow data.

import type { IStorage } from "../storage";
import type { PersistedPlay } from "@shared/schema";

export interface CalibrationRow {
  probability: number; // 0-100 scale, as stored
  hit: boolean; // true = cashed/hit, false = miss. Pushes/voids excluded upstream.
  market: string;
  side: string;
  engineVersion: string | null;
  calibrationVersion: string | null;
}

export interface CalibrationMetrics {
  sampleCount: number;
  brierScore: number | null; // 0 (perfect) to 1 (worst), null if no samples
  logLoss: number | null; // lower is better, null if no samples
  reliabilityBuckets: ReliabilityBucket[];
  expectedCalibrationError: number | null; // ECE, null if no samples
}

export interface ReliabilityBucket {
  bucketLabel: string; // e.g. "50-60%"
  bucketLow: number;
  bucketHigh: number;
  count: number;
  avgPredictedProbability: number | null;
  actualHitRate: number | null;
}

export interface GroupedCalibrationReport {
  overall: CalibrationMetrics;
  byMarket: Record<string, CalibrationMetrics>;
  bySide: Record<string, CalibrationMetrics>;
  byEngineVersion: Record<string, CalibrationMetrics>;
  byCalibrationVersion: Record<string, CalibrationMetrics>;
}

const RELIABILITY_BUCKET_WIDTH = 10; // deciles, 0-10, 10-20, ..., 90-100

function clampProb01(p: number): number {
  const p01 = p / 100;
  // Numeric guard for log() domain — never changes the reported sample's
  // classification, only avoids -Infinity in log loss for exact 0/100 inputs.
  return Math.min(0.999999, Math.max(0.000001, p01));
}

export function computeReliabilityBuckets(rows: CalibrationRow[]): ReliabilityBucket[] {
  const buckets: ReliabilityBucket[] = [];
  for (let low = 0; low < 100; low += RELIABILITY_BUCKET_WIDTH) {
    const high = low + RELIABILITY_BUCKET_WIDTH;
    const inBucket = rows.filter(r => r.probability >= low && (high === 100 ? r.probability <= high : r.probability < high));
    const count = inBucket.length;
    buckets.push({
      bucketLabel: `${low}-${high}%`,
      bucketLow: low,
      bucketHigh: high,
      count,
      avgPredictedProbability: count > 0 ? inBucket.reduce((s, r) => s + r.probability, 0) / count : null,
      actualHitRate: count > 0 ? (inBucket.filter(r => r.hit).length / count) * 100 : null,
    });
  }
  return buckets;
}

export function computeExpectedCalibrationError(rows: CalibrationRow[], buckets?: ReliabilityBucket[]): number | null {
  if (rows.length === 0) return null;
  const b = buckets ?? computeReliabilityBuckets(rows);
  let ece = 0;
  for (const bucket of b) {
    if (bucket.count === 0 || bucket.avgPredictedProbability == null || bucket.actualHitRate == null) continue;
    const weight = bucket.count / rows.length;
    ece += weight * Math.abs(bucket.avgPredictedProbability - bucket.actualHitRate);
  }
  return Math.round(ece * 100) / 100;
}

export function computeCalibrationMetrics(rows: CalibrationRow[]): CalibrationMetrics {
  if (rows.length === 0) {
    return { sampleCount: 0, brierScore: null, logLoss: null, reliabilityBuckets: computeReliabilityBuckets([]), expectedCalibrationError: null };
  }
  let brierSum = 0;
  let logLossSum = 0;
  for (const r of rows) {
    const p = clampProb01(r.probability);
    const y = r.hit ? 1 : 0;
    brierSum += (p - y) ** 2;
    logLossSum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  const buckets = computeReliabilityBuckets(rows);
  return {
    sampleCount: rows.length,
    brierScore: Math.round((brierSum / rows.length) * 10000) / 10000,
    logLoss: Math.round((logLossSum / rows.length) * 10000) / 10000,
    reliabilityBuckets: buckets,
    expectedCalibrationError: computeExpectedCalibrationError(rows, buckets),
  };
}

function groupBy<T, K extends string>(rows: T[], keyFn: (row: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const row of rows) {
    const key = keyFn(row);
    (out[key] ??= []).push(row);
  }
  return out;
}

export function buildGroupedCalibrationReport(rows: CalibrationRow[]): GroupedCalibrationReport {
  const byMarketGroups = groupBy(rows, r => r.market);
  const bySideGroups = groupBy(rows, r => r.side);
  const byEngineVersionGroups = groupBy(rows, r => r.engineVersion ?? "unknown");
  const byCalibrationVersionGroups = groupBy(rows, r => r.calibrationVersion ?? "unknown");

  return {
    overall: computeCalibrationMetrics(rows),
    byMarket: Object.fromEntries(Object.entries(byMarketGroups).map(([k, v]) => [k, computeCalibrationMetrics(v)])),
    bySide: Object.fromEntries(Object.entries(bySideGroups).map(([k, v]) => [k, computeCalibrationMetrics(v)])),
    byEngineVersion: Object.fromEntries(Object.entries(byEngineVersionGroups).map(([k, v]) => [k, computeCalibrationMetrics(v)])),
    byCalibrationVersion: Object.fromEntries(Object.entries(byCalibrationVersionGroups).map(([k, v]) => [k, computeCalibrationMetrics(v)])),
  };
}

/**
 * Converts a settled PersistedPlay row into a CalibrationRow, or null if the
 * row should be excluded from CLEAN calibration math:
 *   - not MLB
 *   - not settled (result null) or a push/void (excluded, not a binary hit/miss)
 *   - missing officialEpisodeKey (legacy pre-recovery row — provenance not
 *     guaranteed immutable/clean)
 *   - missing oddsSourceUpdatedAt (no real sportsbook provenance captured)
 *   - non-finite/out-of-range probability
 */
export function toCleanCalibrationRow(play: PersistedPlay): CalibrationRow | null {
  if (play.sport !== "mlb") return null;
  if (play.result !== "hit" && play.result !== "miss") return null;
  if (!play.officialEpisodeKey) return null;
  if (!play.oddsSourceUpdatedAt) return null;

  const probability = Number(play.prob);
  if (!Number.isFinite(probability) || probability < 0 || probability > 100) return null;

  return {
    probability,
    hit: play.result === "hit",
    market: play.market,
    side: play.direction,
    engineVersion: play.engineVersion ?? null,
    calibrationVersion: play.calibrationVersion ?? null,
  };
}

export interface ShadowAvailability {
  available: false;
  reason: string;
}

export const SHADOW_CALIBRATION_UNAVAILABLE: ShadowAvailability = {
  available: false,
  reason:
    "General MLB Live Edge shadow calibration is not durably stored. " +
    "server/mlb/shadowQualification.ts is an in-process Map with no " +
    "date-range-queryable history, so historical shadow metrics cannot be " +
    "computed without risk of undercounting/fabrication. HR Radar's shadow " +
    "metrics (server/analytics/hrRadarShadowMetrics.ts) cover HR-specific " +
    "outcomes only and are not a substitute for general Live Edge shadow data.",
};

export interface CalibrationCoverageMetadata {
  requestedFromDate: string | null;
  requestedToDate: string | null;
  rowsScanned: number;
  eligibleRows: number;
  excludedLegacyRows: number; // no officialEpisodeKey (pre-recovery row)
  excludedMissingProvenanceRows: number; // no real oddsSourceUpdatedAt
  excludedPushOrVoidRows: number;
  unresolvedRows: number; // result IS NULL — not yet settled
  complete: boolean; // true when this call retrieved every matching row, no cap applied
}

export interface MlbLiveEdgeCalibrationReport {
  official: GroupedCalibrationReport;
  officialRowsExcludedLegacyOrUnprovenanced: number;
  coverage: CalibrationCoverageMetadata;
  shadow: ShadowAvailability;
}

function classifyExclusion(play: PersistedPlay): "unresolved" | "push_or_void" | "legacy" | "missing_provenance" | "eligible" {
  if (play.result == null) return "unresolved";
  if (play.result !== "hit" && play.result !== "miss") return "push_or_void";
  if (!play.officialEpisodeKey) return "legacy";
  if (!play.oddsSourceUpdatedAt) return "missing_provenance";
  return "eligible";
}

/**
 * Gathers MLB plays for a date range via storage.getPlaysInRange() — an
 * UNBOUNDED query (no row cap, unlike storage.getPlays()'s 500-row limit)
 * that already exists in this codebase for exactly this purpose (see
 * getGradedPlaysForCalibration's identical pattern for other calibration
 * surfaces). `coverage.complete` is always true here because this call
 * retrieves every row matching the date range in a single unbounded query —
 * there is no page/cursor to exhaust. If the caller narrows the range (or
 * omits it, defaulting to "all time"), that choice is echoed back in
 * `requestedFromDate`/`requestedToDate` rather than hidden.
 */
export async function gatherMlbLiveEdgeCalibrationReport(
  storage: Pick<IStorage, "getPlaysInRange">,
  opts: { fromDate?: string; toDate?: string } = {}
): Promise<MlbLiveEdgeCalibrationReport> {
  const plays = await storage.getPlaysInRange({
    sport: "mlb",
    startDate: opts.fromDate,
    endDate: opts.toDate,
  });

  const cleanRows: CalibrationRow[] = [];
  let excludedLegacyRows = 0;
  let excludedMissingProvenanceRows = 0;
  let excludedPushOrVoidRows = 0;
  let unresolvedRows = 0;

  for (const play of plays) {
    const kind = classifyExclusion(play);
    switch (kind) {
      case "unresolved": unresolvedRows++; continue;
      case "push_or_void": excludedPushOrVoidRows++; continue;
      case "legacy": excludedLegacyRows++; continue;
      case "missing_provenance": excludedMissingProvenanceRows++; continue;
      case "eligible": {
        const row = toCleanCalibrationRow(play);
        if (row) cleanRows.push(row);
        continue;
      }
    }
  }

  const coverage: CalibrationCoverageMetadata = {
    requestedFromDate: opts.fromDate ?? null,
    requestedToDate: opts.toDate ?? null,
    rowsScanned: plays.length,
    eligibleRows: cleanRows.length,
    excludedLegacyRows,
    excludedMissingProvenanceRows,
    excludedPushOrVoidRows,
    unresolvedRows,
    complete: true,
  };

  return {
    official: buildGroupedCalibrationReport(cleanRows),
    officialRowsExcludedLegacyOrUnprovenanced: excludedLegacyRows + excludedMissingProvenanceRows,
    coverage,
    shadow: SHADOW_CALIBRATION_UNAVAILABLE,
  };
}
