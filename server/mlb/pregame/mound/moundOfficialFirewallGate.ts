// Mound Radar — Phase 1 official-firewall measurement gatherer (Flagship
// Program Phase 2, Part 8). Storage-touching, read-only, gated behind
// isMoundOfficialFirewallMeasurementEnabled() (default OFF). This is a
// DIAGNOSTIC surface only — it never suppresses, blocks, or mutates
// anything Mound actually publishes; see moundOfficialFirewallMeasurement.ts
// for the pure evaluation logic and its module header for the audit finding.

import { storage } from "../../../storage";
import type { MlbMoundRadarSignalRow } from "@shared/schema";
import type { MoundSignal } from "./types";
import { summarizeMoundOfficialFirewallMeasurement, type MoundOfficialFirewallMeasurementSummary } from "./moundOfficialFirewallMeasurement";
import { isMoundOfficialFirewallMeasurementEnabled } from "./moundOfficialFirewallGateFlags";

/** Pure calendar-string arithmetic over two GIVEN date strings — mirrors moundV2ComparisonGatherer.ts's enumerateEtDates. */
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

/**
 * Reconstructs enough of a MoundSignal shape from a persisted row for the
 * firewall measurement to read — diagnostics/outcomes are stored wholesale
 * as jsonb (see storage.ts's upsertMlbMoundRadarSignal), so the nested
 * postedLine/predictionTimeProjections/frozenProductionBaseline paths
 * moundOfficialFirewallMeasurement.ts reads survive the round-trip intact.
 */
function toMoundSignalForMeasurement(row: MlbMoundRadarSignalRow): MoundSignal {
  return {
    signalId: row.signalId,
    gameStatus: row.gameStatus,
    moundDirection: row.moundDirection as MoundSignal["moundDirection"],
    diagnostics: row.diagnostics as MoundSignal["diagnostics"],
    projectedStrikeouts: null,
    matchupAdjustedStrikeouts: null,
  } as unknown as MoundSignal;
}

export interface MoundOfficialFirewallGateResult {
  measurementEnabled: boolean;
  windowStart: string;
  windowEnd: string;
  summary: MoundOfficialFirewallMeasurementSummary | null;
}

/**
 * The gate: with the flag off, returns measurementEnabled:false and a null
 * summary — no signals are fetched or evaluated at all. With the flag on,
 * fetches every real signal for the ET date range and runs the measurement.
 * Either way, this function only ever produces a read-only diagnostic
 * payload; nothing here writes to storage or affects Mound's own publication.
 */
export async function gatherMoundOfficialFirewallMeasurement(opts: {
  windowStart: string;
  windowEnd: string;
}): Promise<MoundOfficialFirewallGateResult> {
  if (!isMoundOfficialFirewallMeasurementEnabled()) {
    return { measurementEnabled: false, windowStart: opts.windowStart, windowEnd: opts.windowEnd, summary: null };
  }

  const etDates = enumerateEtDates(opts.windowStart, opts.windowEnd);
  const signalArrays = await Promise.all(etDates.map((d) => storage.getMlbMoundRadarSignalsByDate(d)));
  const signals = signalArrays.flat().map(toMoundSignalForMeasurement);

  return {
    measurementEnabled: true,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    summary: summarizeMoundOfficialFirewallMeasurement(signals, new Date()),
  };
}
