// PR6 — NFL ingestion: honest per-source/per-season coverage classification. Never
// fabricates a measured value: a live-depth claim needs a real pull (absent here →
// pending_measurement), and historical knownAt is unsupported for nflverse (no per-record
// finalize instant). A provider failure / incomplete response is a coverage GAP, never
// "complete".

import type { NflWeeklyAdapterResult } from "./nflSourceContracts";

export type NflCoverageClass = "adapter_retrievable" | "incomplete" | "pending_measurement";
export type NflKnownAtSupport = "forward_supported" | "historical_unsupported";

export interface NflSourceCoverage {
  season: number;
  coverage: NflCoverageClass;
  recordCount: number;
  knownAtSupport: NflKnownAtSupport;
  reason: string;
}

export const PENDING_MEASUREMENT_LABEL = "PENDING MEASUREMENT IN THE AUTHORIZED ENVIRONMENT";

export function classifyNflCoverage(result: NflWeeklyAdapterResult, currentSeason: number): NflSourceCoverage {
  const knownAtSupport: NflKnownAtSupport = result.season >= currentSeason ? "forward_supported" : "historical_unsupported";
  if (!result.ok) {
    return { season: result.season, coverage: "incomplete", recordCount: 0, knownAtSupport, reason: `provider_${result.reason}` };
  }
  return {
    season: result.season,
    coverage: "adapter_retrievable",
    recordCount: result.records.length,
    knownAtSupport,
    reason:
      result.season >= currentSeason
        ? `${result.records.length} rows this run; live depth ${PENDING_MEASUREMENT_LABEL}`
        : `${result.records.length} rows this run; historical knownAt unsupported; live depth ${PENDING_MEASUREMENT_LABEL}`,
  };
}
