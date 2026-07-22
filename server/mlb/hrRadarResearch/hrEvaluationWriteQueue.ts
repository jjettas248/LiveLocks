// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — bounded async batch writer (PR 2).
//
// Mirrors server/services/alertSubscriber.ts's queue/drain pattern: a
// module-level bounded array fed synchronously, a separate interval-driven
// drain that batch-writes and never blocks the caller. A write failure here
// must NEVER delay, block, or change champion decisions — enqueue is a
// synchronous in-memory push only; the actual DB write happens later, off
// the hot orchestrator tick, on its own unref'd timer.
//
// Revision-aware correction: live capture always enqueues sourceRevision: 0.
// The DB's existing unique index (evaluation_epoch_id, player_id,
// feature_version, source_revision) already carries the full correction
// semantic — a future replay/backfill PR reprocessing an epoch with
// corrected data calls this same writer with sourceRevision: N+1, which
// lands as a brand-new, fully auditable row instead of conflicting. No
// application-level revision-tracking state is needed here.
// ─────────────────────────────────────────────────────────────────────────────

import { hrRadarEvaluationSnapshots, type InsertHrRadarEvaluationSnapshot } from "@shared/schema";

const MAX_QUEUE_DEPTH = 5000;
const MAX_ATTEMPTS = 3;

interface QueuedRow {
  row: InsertHrRadarEvaluationSnapshot;
  attempts: number;
}

const _queue: QueuedRow[] = [];

interface WriteQueueMetrics {
  queued: number;
  written: number;
  duplicates: number;
  retried: number;
  droppedOverflow: number;
  droppedAfterMaxRetries: number;
}

const _metrics: WriteQueueMetrics = {
  queued: 0,
  written: 0,
  duplicates: 0,
  retried: 0,
  droppedOverflow: 0,
  droppedAfterMaxRetries: 0,
};

type InsertExecutor = (row: InsertHrRadarEvaluationSnapshot) => Promise<Array<{ snapshotId: string }>>;

// Lazily imports the real `db` binding only when actually writing (never at
// module load) — keeps this module importable in a test process with no
// DATABASE_URL, since tests always inject a fake executor and never reach
// this function.
async function defaultInsertExecutor(row: InsertHrRadarEvaluationSnapshot): Promise<Array<{ snapshotId: string }>> {
  const { db } = await import("../../db");
  return db
    .insert(hrRadarEvaluationSnapshots)
    .values(row)
    .onConflictDoNothing({
      target: [
        hrRadarEvaluationSnapshots.evaluationEpochId,
        hrRadarEvaluationSnapshots.playerId,
        hrRadarEvaluationSnapshots.featureVersion,
        hrRadarEvaluationSnapshots.sourceRevision,
      ],
    })
    .returning({ snapshotId: hrRadarEvaluationSnapshots.snapshotId });
}

// Test-only injection point (mirrors alertSubscriber.ts's setDispatchHook) —
// lets unit tests exercise overflow/retry/duplicate/correction behavior
// against a fake insert function instead of a live database. null (the
// default) means "use the real db".
let _testInsertExecutor: InsertExecutor | null = null;
export function _setHrEvaluationWriteExecutorForTests(executor: InsertExecutor | null): void {
  _testInsertExecutor = executor;
}

export function enqueueHrEvaluationSnapshot(row: InsertHrRadarEvaluationSnapshot): void {
  if (_queue.length >= MAX_QUEUE_DEPTH) {
    _metrics.droppedOverflow++;
    console.warn(`[HR_RADAR_EVAL_CAPTURE_QUEUE] overflow — dropping row snapshotId=${row.snapshotId} queueDepth=${_queue.length}`);
    return;
  }
  _queue.push({ row, attempts: 0 });
  _metrics.queued++;
}

export async function drainHrEvaluationWriteQueue(): Promise<{
  written: number;
  duplicates: number;
  failed: number;
  droppedAfterMaxRetries: number;
}> {
  if (_queue.length === 0) return { written: 0, duplicates: 0, failed: 0, droppedAfterMaxRetries: 0 };

  const batch = _queue.splice(0, _queue.length);
  let written = 0;
  let duplicates = 0;
  let failed = 0;
  let droppedAfterMaxRetries = 0;

  const insertRow = _testInsertExecutor ?? defaultInsertExecutor;

  for (const item of batch) {
    try {
      const inserted = await insertRow(item.row);

      if (inserted.length === 0) {
        duplicates++;
        _metrics.duplicates++;
      } else {
        written++;
        _metrics.written++;
      }
    } catch (err) {
      item.attempts++;
      if (item.attempts >= MAX_ATTEMPTS) {
        droppedAfterMaxRetries++;
        _metrics.droppedAfterMaxRetries++;
        failed++;
        console.warn(
          `[HR_RADAR_EVAL_CAPTURE_QUEUE] dropped after ${item.attempts} attempts snapshotId=${item.row.snapshotId} reason=${(err as Error).message}`,
        );
      } else {
        _metrics.retried++;
        _queue.push(item);
        console.warn(
          `[HR_RADAR_EVAL_CAPTURE_QUEUE] insert failed, will retry attempt=${item.attempts} snapshotId=${item.row.snapshotId} reason=${(err as Error).message}`,
        );
      }
    }
  }

  return { written, duplicates, failed, droppedAfterMaxRetries };
}

let _drainTimer: ReturnType<typeof setInterval> | null = null;
export function startHrEvaluationWriteDrainer(intervalMs: number = 5000): void {
  if (_drainTimer) return;
  _drainTimer = setInterval(() => {
    drainHrEvaluationWriteQueue().catch((e) =>
      console.warn(`[HR_RADAR_EVAL_CAPTURE_QUEUE] drain error: ${(e as Error).message}`),
    );
  }, intervalMs);
  if (typeof _drainTimer.unref === "function") _drainTimer.unref();
}

export function getHrEvaluationWriteQueueMetrics() {
  return { ..._metrics, queueDepth: _queue.length };
}

export function _resetHrEvaluationWriteQueueForTests(): void {
  _queue.length = 0;
  _metrics.queued = 0;
  _metrics.written = 0;
  _metrics.duplicates = 0;
  _metrics.retried = 0;
  _metrics.droppedOverflow = 0;
  _metrics.droppedAfterMaxRetries = 0;
  _testInsertExecutor = null;
  if (_drainTimer) {
    clearInterval(_drainTimer);
    _drainTimer = null;
  }
}
