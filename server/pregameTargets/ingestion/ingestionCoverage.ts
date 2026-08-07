// PR5 — NBA ingestion: honest per-source / per-season coverage classification.
//
// Turns adapter results into an explicit coverage report. It NEVER fabricates a
// measured value: a live-depth claim requires a real pull (absent in sandbox →
// `pending_measurement`), and historical knownAt is `unsupported` for these
// endpoints (no publish instant). A provider failure / incomplete response is a
// coverage GAP, never reported as complete.

import type { NbaAdapterResult, NbaSourceKind } from "./nbaSourceContracts";

export type CoverageClass =
  | "verified_available" // measured present at required granularity (needs a real pull)
  | "adapter_retrievable" // adapter returned rows this run, live 3-season depth unverified
  | "incomplete" // provider failure / truncated / empty — a gap, never "complete"
  | "pending_measurement"; // not measured in this environment

export type KnownAtSupport = "forward_supported" | "historical_unsupported";

export interface SourceCoverage {
  kind: NbaSourceKind;
  season: number;
  entityNativeId: string;
  coverage: CoverageClass;
  recordCount: number;
  /** Forward as-of is supported (knownAt = fetchedAt); historical backtest is not. */
  knownAtSupport: KnownAtSupport;
  reason: string;
}

export const PENDING_MEASUREMENT_LABEL = "PENDING MEASUREMENT IN THE AUTHORIZED ENVIRONMENT";

/**
 * Classify a single adapter result. A successful parse this run is at best
 * `adapter_retrievable` (live multi-season depth/throughput remain
 * `pending_measurement`); a failure is `incomplete`. Historical knownAt is always
 * `historical_unsupported` for game-log endpoints.
 */
export function classifySourceCoverage(result: NbaAdapterResult, currentSeason: number): SourceCoverage {
  const base = {
    kind: result.kind,
    season: result.season,
    entityNativeId: result.entityNativeId,
    knownAtSupport:
      result.season >= currentSeason ? ("forward_supported" as const) : ("historical_unsupported" as const),
  };
  if (!result.ok) {
    return { ...base, coverage: "incomplete", recordCount: 0, reason: `provider_${result.reason}` };
  }
  return {
    ...base,
    coverage: "adapter_retrievable",
    recordCount: result.records.length,
    reason:
      result.season >= currentSeason
        ? `${result.records.length} rows this run; live depth ${PENDING_MEASUREMENT_LABEL}`
        : `${result.records.length} rows this run; historical knownAt unsupported; live depth ${PENDING_MEASUREMENT_LABEL}`,
  };
}

export interface CoverageReport {
  currentSeason: number;
  bySource: SourceCoverage[];
  /** True iff every requested season parsed at least one row (no incompleteness). */
  allRetrievable: boolean;
}

export function buildCoverageReport(results: readonly NbaAdapterResult[], currentSeason: number): CoverageReport {
  const bySource = results.map((r) => classifySourceCoverage(r, currentSeason));
  return { currentSeason, bySource, allRetrievable: bySource.every((s) => s.coverage === "adapter_retrievable") };
}
