// Mound Radar V2 (shadow) — in-memory result recorder + aggregate metrics.
//
// The in-memory ring buffer (mirrors the existing diagnostics ring-buffer
// convention elsewhere in this codebase, e.g. goldmaster drift snapshots
// capped at 50 entries) plus running counters give cheap in-process
// observability. This is PURELY advisory/observability — it is never the
// durability path for a prediction. That distinction matters (Final
// Pre-Push Integrity Pass): a prior version of this file also fire-and-forget
// invoked a "persistence sink" from here, meaning a real prediction's only
// durable write was un-awaited and could be lost on a crash/restart between
// enqueue and that fire-and-forget completing. The durable write is now
// moundV2ShadowWorker.ts's own directly-awaited storage.createMoundV2ShadowPrediction
// call, driven by the durable outbox (moundV2ShadowJobQueue.ts /
// shared/schema.ts's moundV2ShadowJobs) — this module no longer has (or
// needs) any persistence responsibility at all.
//
// This module stays storage-free by design (no `storage` import) — same
// principle as buildMlbMoundRadar.ts's own "engine stays storage-free and
// unit-testable" header.

import type { MoundV2ShadowEvaluationResult } from "./moundV2ShadowEvaluation";

const MAX_RECENT_RESULTS = 200;

let recentResults: MoundV2ShadowEvaluationResult[] = [];
let totalEvaluations = 0;
let totalFailures = 0;
let totalParityMismatches = 0;
let totalLatencyMs = 0;

/** Records evaluation metrics only — never persists anything. Called from moundV2ShadowWorker.ts after evaluateMoundV2Shadow runs, purely for the in-process observability ring buffer/counters. */
export function recordMoundV2ShadowEvaluation(result: MoundV2ShadowEvaluationResult): void {
  totalEvaluations++;
  totalLatencyMs += result.latencyMs;
  if (result.failureReason) totalFailures++;
  if (result.parity && !result.parity.matches) totalParityMismatches++;

  recentResults.push(result);
  if (recentResults.length > MAX_RECENT_RESULTS) recentResults.shift();
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
}
