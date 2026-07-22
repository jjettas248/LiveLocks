// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — capture-health diagnostics (PR 2).
//
// Read-only, in-memory. Uses the shared bounded ring-buffer helper
// (server/utils/ringBuffer.ts) rather than a new buffer implementation.
// Queue-side counters (written/duplicates/retried/drops/queueDepth) come
// live from hrEvaluationWriteQueue.ts's own metrics — single source of
// truth, no double-counting here.
// ─────────────────────────────────────────────────────────────────────────────

import { boundedPush, countSinceMs } from "../../utils/ringBuffer";
import { getHrEvaluationWriteQueueMetrics } from "./hrEvaluationWriteQueue";

const MAX_DIAGNOSTICS_ENTRIES = 500;

export interface HrCaptureEpochDiagnosticsEntry {
  ts: number;
  gameId: string;
  evaluationEpochId: string;
  triggerType: string;
  eligiblePopulationSize: number;
  eligibleCount: number;
  buildLatencyMs: number;
  availabilityFullCount: number;
  availabilityDegradedCount: number;
  availabilityMissingCount: number;
}

const _epochDiagnostics: HrCaptureEpochDiagnosticsEntry[] = [];

export function recordHrCaptureDiagnostics(entry: HrCaptureEpochDiagnosticsEntry): void {
  boundedPush(_epochDiagnostics, entry, MAX_DIAGNOSTICS_ENTRIES);
}

export function getHrCaptureDiagnosticsSnapshot(windowMs: number = 60 * 60 * 1000) {
  return {
    epochsRecent: _epochDiagnostics.slice(-25).reverse(),
    epochsInWindow: countSinceMs(_epochDiagnostics, windowMs),
    writeQueue: getHrEvaluationWriteQueueMetrics(),
  };
}

export function _resetHrEvalCaptureDiagnosticsForTests(): void {
  _epochDiagnostics.length = 0;
}
