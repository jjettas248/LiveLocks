// ── MLB Live Edge Stage B — capture service (hot-path adapter) ───────────────
// The thin, NEVER-THROW, fire-and-forget adapter the orchestrator calls once per
// game tick, right after autoPersistMLBSignals. It stamps the real version
// provenance, builds the frozen all-lane capture rows (pure builder), and appends
// them to the private Stage B ledger. It can NEVER affect the tick, persistence,
// ROI, or any public surface — every failure is swallowed with a diagnostic.
//
// Capture is event-driven (the orchestrator only recomputes signals on real
// baseball state changes — see CLAUDE.md §3.2a-1), so one fresh emission per
// signal per meaningful event is captured; duplicate predictionIds (a retried
// identical capture) are a no-op at the storage layer (onConflictDoNothing).

import type { MLBQualifiedSignal } from "../types";
import type { MlbLanePrediction } from "@shared/mlbPredictionLedger";
import { buildStageBCapturePredictions } from "./predictionLedgerCapture";
import { MLB_FINALIZATION_VERSION } from "../mlbSignalFinalizer";
import { MLB_PRODUCTION_LANE_VERSION } from "../mlbProductionLane";
import { MLB_GOLDMASTER_VERSION } from "../goldmasterGuard";

export interface StageBCaptureServiceDeps {
  appendMlbLanePredictions(predictions: MlbLanePrediction[]): Promise<number>;
  now?: () => number;
}

// Session counters + rate-limited logging (no per-tick log spam — mirrors the
// [MLB_POLLING_METRICS] discipline of ≤1 aggregate log per interval).
let capturedTotalSession = 0;
let lastLogAtMs = 0;
const LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Captures the fresh all-lane signal set for one game tick into the Stage B
 * ledger. NEVER throws and NEVER rejects — the whole body is guarded so the
 * caller can `void` it without a `.catch`. Returns the number of rows inserted
 * (0 on any skip/failure) for callers/tests that care.
 */
export async function captureAllLanesToStageB(
  gameId: string,
  signals: readonly MLBQualifiedSignal[],
  deps: StageBCaptureServiceDeps,
): Promise<number> {
  try {
    const capturedAtMs = (deps.now ?? Date.now)();
    const rows = buildStageBCapturePredictions(signals, {
      gameId,
      capturedAtMs,
      finalizerVersion: MLB_FINALIZATION_VERSION,
      laneVersion: MLB_PRODUCTION_LANE_VERSION,
      goldmasterVersion: MLB_GOLDMASTER_VERSION,
      // captureEnabled omitted ⇒ builder uses MLB_PREDICTION_CAPTURE_ENABLED_DEFAULT.
    });
    if (rows.length === 0) return 0;

    const inserted = await deps.appendMlbLanePredictions(rows);
    capturedTotalSession += inserted;

    if (capturedAtMs - lastLogAtMs >= LOG_INTERVAL_MS) {
      lastLogAtMs = capturedAtMs;
      console.log(
        `[MLB_STAGE_B_CAPTURE] gameId=${gameId} builtLanes=${rows.length} inserted=${inserted} totalSession=${capturedTotalSession}`,
      );
    }
    return inserted;
  } catch (err) {
    // Research measurement only — must never break the live tick.
    console.warn(`[MLB_STAGE_B_CAPTURE_ERROR] gameId=${gameId} ${(err as Error)?.message ?? err}`);
    return 0;
  }
}

/** Test-only: reset the module-level session counters. */
export function __resetStageBCaptureCountersForTest(): void {
  capturedTotalSession = 0;
  lastLogAtMs = 0;
}
