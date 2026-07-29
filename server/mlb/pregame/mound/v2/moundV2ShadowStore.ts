// Mound Radar V2 (shadow) — in-memory result recorder + aggregate metrics,
// plus an optional durable-persistence sink.
//
// The in-memory ring buffer (mirrors the existing diagnostics ring-buffer
// convention elsewhere in this codebase, e.g. goldmaster drift snapshots
// capped at 50 entries) plus running counters give cheap in-process
// observability regardless of whether durable persistence is wired.
//
// This module stays storage-free by design (no `storage` import) — same
// principle as buildMlbMoundRadar.ts's own "engine stays storage-free and
// unit-testable" header. Durable persistence is wired in from OUTSIDE via
// setMoundV2ShadowPersistenceSink, exactly mirroring how
// moundPersistence.ts's installMoundPersistence() wires buildMlbMoundRadar's
// own setMoundBuildSink from the outside — see
// moundV2ShadowPersistenceAdapter.ts for the actual storage.ts wiring.
// The sink is always invoked fire-and-forget (never awaited by the caller,
// which is itself already inside a fire-and-forget call from the per-pitcher
// build loop) with its own .catch(), so a slow or failing database can never
// delay or affect the build loop.

import type { MoundV2ShadowEvaluationResult } from "./moundV2ShadowEvaluation";
import { buildMoundV2ShadowPredictionRows } from "./moundV2ShadowPersistenceBuilder";
import type { InsertMoundV2ShadowPrediction } from "@shared/schema";

const MAX_RECENT_RESULTS = 200;

let recentResults: MoundV2ShadowEvaluationResult[] = [];
let totalEvaluations = 0;
let totalFailures = 0;
let totalParityMismatches = 0;
let totalLatencyMs = 0;

export type MoundV2ShadowPersistenceSink = (rows: InsertMoundV2ShadowPrediction[]) => Promise<void>;
let persistenceSink: MoundV2ShadowPersistenceSink | null = null;

/** Wire durable persistence in from outside (see moundV2ShadowPersistenceAdapter.ts). Optional — with no sink registered, recording stays in-memory-only. */
export function setMoundV2ShadowPersistenceSink(sink: MoundV2ShadowPersistenceSink | null): void {
  persistenceSink = sink;
}

export function recordMoundV2ShadowEvaluation(result: MoundV2ShadowEvaluationResult): void {
  totalEvaluations++;
  totalLatencyMs += result.latencyMs;
  if (result.failureReason) totalFailures++;
  if (result.parity && !result.parity.matches) totalParityMismatches++;

  recentResults.push(result);
  if (recentResults.length > MAX_RECENT_RESULTS) recentResults.shift();

  if (persistenceSink) {
    const rows = buildMoundV2ShadowPredictionRows(result);
    if (rows.length > 0) {
      persistenceSink(rows).catch((err: unknown) => {
        console.warn(
          `[MOUND_V2_SHADOW_PERSISTENCE_FAILED] ${result.snapshotId}`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }
}

export interface MoundV2ShadowMetrics {
  totalEvaluations: number;
  totalFailures: number;
  totalParityMismatches: number;
  avgLatencyMs: number;
  recentResults: MoundV2ShadowEvaluationResult[];
}

export function getMoundV2ShadowMetrics(): MoundV2ShadowMetrics {
  return {
    totalEvaluations,
    totalFailures,
    totalParityMismatches,
    avgLatencyMs: totalEvaluations > 0 ? totalLatencyMs / totalEvaluations : 0,
    recentResults: recentResults.slice(),
  };
}

/** Test-only reset — never called from production code paths. */
export function resetMoundV2ShadowStoreForTests(): void {
  recentResults = [];
  totalEvaluations = 0;
  totalFailures = 0;
  totalParityMismatches = 0;
  totalLatencyMs = 0;
  persistenceSink = null;
}
