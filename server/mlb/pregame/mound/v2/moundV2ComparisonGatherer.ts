// Mound Radar V2 (shadow) — comparison report gatherer (Flagship Program
// Phase 2, Part 6). Storage-touching; assembles real
// MoundV2ComparisonRow/MoundV1OutcomeSummary arrays for the pure engine in
// the sibling moundV2ComparisonStats.ts. Admin-only, read-only — this file
// never writes anything.

import { storage } from "../../../../storage";
import type { MoundSignal } from "../types";
import type { MlbMoundRadarSignalRow, MoundV2ShadowPredictionRow } from "@shared/schema";
import {
  buildMoundV2ComparisonReport,
  type MoundV2ComparisonRow,
  type MoundV2ComparisonFinalResult,
  type MoundV1OutcomeSummary,
  type MoundV2ComparisonReport,
} from "./moundV2ComparisonStats";

/**
 * Every ET calendar-date string from startDate to endDate inclusive. Pure
 * calendar-string arithmetic over two GIVEN date strings (never derives
 * "today" from wall-clock time), so this doesn't fall under the
 * todayET()-only rule that governs slate/window logic from an instant.
 */
function enumerateEtDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return dates;
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function toComparisonRow(row: MoundV2ShadowPredictionRow): MoundV2ComparisonRow {
  return {
    gameId: row.gameId,
    pitcherId: row.pitcherId,
    market: row.market,
    settlementStatus: row.settlementStatus,
    finalResult: (row.finalResult as MoundV2ComparisonFinalResult | null) ?? null,
    frozenOverPrice: row.frozenOverPrice ?? null,
    frozenUnderPrice: row.frozenUnderPrice ?? null,
    v2OverProbability: Number(row.v2OverProbability),
    v2UnderProbability: Number(row.v2UnderProbability),
    v2PushProbability: Number(row.v2PushProbability),
    v1Tier: row.v1Tier ?? null,
    v2ModelVersion: row.v2ModelVersion,
    productionModelVersion: row.productionModelVersion,
  };
}

function toV1OutcomeSummary(signal: MlbMoundRadarSignalRow): MoundV1OutcomeSummary {
  const outcomes = (signal.outcomes as MoundSignal["outcomes"]) ?? null;
  return {
    gameId: signal.gameId,
    pitcherId: signal.pitcherId,
    market: signal.primaryMarket,
    marketOutcome: outcomes?.marketOutcome ?? "unavailable",
    tier: signal.tier ?? null,
  };
}

export interface GatherMoundV2ComparisonOpts {
  /** ET slate date, "YYYY-MM-DD", inclusive. */
  windowStart: string;
  /** ET slate date, "YYYY-MM-DD", inclusive. */
  windowEnd: string;
}

/**
 * Assembles the real V2 shadow predictions + real V1 settlement outcomes
 * for the declared window and hands them to the pure comparison engine.
 * V2's window is applied server-side via listMoundV2ShadowPredictions'
 * evaluationTimestamp filter (UTC day boundaries — a coarse reporting
 * window, not per-game settlement, so ET-precision at the edges isn't
 * required). V1's window walks each ET slate date in range via
 * getMlbMoundRadarSignalsByDate, mirroring how V1's own sessionDate
 * column is keyed.
 */
export async function gatherMoundV2ComparisonReport(
  opts: GatherMoundV2ComparisonOpts,
): Promise<MoundV2ComparisonReport> {
  const fromEvaluationTimestamp = new Date(`${opts.windowStart}T00:00:00.000Z`);
  const toEvaluationTimestamp = new Date(`${opts.windowEnd}T23:59:59.999Z`);

  const v2Rows = await storage.listMoundV2ShadowPredictions({
    fromEvaluationTimestamp,
    toEvaluationTimestamp,
    limit: 5000,
  });

  const etDates = enumerateEtDates(opts.windowStart, opts.windowEnd);
  const v1SignalArrays = await Promise.all(etDates.map((d) => storage.getMlbMoundRadarSignalsByDate(d)));
  const v1Outcomes = v1SignalArrays.flat().map(toV1OutcomeSummary);

  return buildMoundV2ComparisonReport(
    v2Rows.map(toComparisonRow),
    v1Outcomes,
    { windowStart: opts.windowStart, windowEnd: opts.windowEnd },
  );
}
