// HR Radar research bounded write queue — overflow, retry, drop, duplicate,
// and revision-correction behavior. Uses the test-only injectable insert
// executor (mirrors alertSubscriber.ts's setDispatchHook) so this never
// touches a live database.
//
// Run: npx tsx server/mlb/hrRadarResearch/hrEvaluationWriteQueue.test.ts

import {
  enqueueHrEvaluationSnapshot,
  drainHrEvaluationWriteQueue,
  getHrEvaluationWriteQueueMetrics,
  _resetHrEvaluationWriteQueueForTests,
  _setHrEvaluationWriteExecutorForTests,
} from "./hrEvaluationWriteQueue";
import type { InsertHrRadarEvaluationSnapshot } from "@shared/schema";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

type FakeBehavior = "ok" | "conflict" | "throw";
let behaviorQueue: FakeBehavior[] = [];
function nextBehavior(): FakeBehavior {
  return behaviorQueue.shift() ?? "ok";
}

async function fakeExecutor(row: InsertHrRadarEvaluationSnapshot) {
  const behavior = nextBehavior();
  if (behavior === "throw") throw new Error("simulated insert failure");
  if (behavior === "conflict") return [];
  return [{ snapshotId: row.snapshotId }];
}

function fakeRow(overrides: Partial<InsertHrRadarEvaluationSnapshot> = {}): InsertHrRadarEvaluationSnapshot {
  return {
    snapshotId: `snap_${Math.random().toString(36).slice(2)}`,
    evaluationEpochId: "eph_test",
    sourceRevision: 0,
    sessionDate: "2026-07-01",
    gameId: "game1",
    playerId: "p1",
    playerName: "Test Player",
    team: "NYY",
    evaluationAt: new Date(),
    triggerType: "pa_complete",
    eligible: true,
    predictionTargetScope: "first_hr_of_game",
    inputContractVersion: "hr_raw_inputs_v1",
    rawInputs: {},
    featureVersion: "hr_features_v1",
    featureHash: "hash1",
    derivedFeatures: {},
    availability: {},
    featureFreshness: {},
    statsAsOf: new Date(),
    championEvaluated: false,
    championUserVisible: false,
    ...overrides,
  } as InsertHrRadarEvaluationSnapshot;
}

async function run() {
  // ── Basic write ─────────────────────────────────────────────────────────
  _resetHrEvaluationWriteQueueForTests();
  _setHrEvaluationWriteExecutorForTests(fakeExecutor);
  behaviorQueue = ["ok"];
  enqueueHrEvaluationSnapshot(fakeRow());
  const r1 = await drainHrEvaluationWriteQueue();
  ok(r1.written === 1 && r1.duplicates === 0 && r1.failed === 0, "a clean insert counts as written, not duplicate or failed");

  // ── Duplicate via onConflictDoNothing empty return ─────────────────────
  _resetHrEvaluationWriteQueueForTests();
  _setHrEvaluationWriteExecutorForTests(fakeExecutor);
  behaviorQueue = ["conflict"];
  enqueueHrEvaluationSnapshot(fakeRow());
  const r2 = await drainHrEvaluationWriteQueue();
  ok(r2.duplicates === 1 && r2.written === 0 && r2.failed === 0, "onConflictDoNothing empty return counts as a duplicate, not a failure");

  // ── Bounded retry — fails exactly MAX_ATTEMPTS times then drops ────────
  _resetHrEvaluationWriteQueueForTests();
  _setHrEvaluationWriteExecutorForTests(fakeExecutor);
  behaviorQueue = ["throw", "throw", "throw"];
  enqueueHrEvaluationSnapshot(fakeRow());
  await drainHrEvaluationWriteQueue(); // attempt 1 — fails, re-queued
  await drainHrEvaluationWriteQueue(); // attempt 2 — fails, re-queued
  const r3 = await drainHrEvaluationWriteQueue(); // attempt 3 — fails, dropped (MAX_ATTEMPTS=3)
  ok(r3.droppedAfterMaxRetries === 1, "a row that fails 3 times in a row is dropped after max attempts, not retried forever");
  const metricsAfterDrop = getHrEvaluationWriteQueueMetrics();
  ok(metricsAfterDrop.queueDepth === 0, "a row dropped after max retries is removed from the queue, not left stuck");

  // ── Recovers after a transient failure (attempts < MAX_ATTEMPTS) ───────
  _resetHrEvaluationWriteQueueForTests();
  _setHrEvaluationWriteExecutorForTests(fakeExecutor);
  behaviorQueue = ["throw", "ok"];
  enqueueHrEvaluationSnapshot(fakeRow());
  const firstDrain = await drainHrEvaluationWriteQueue();
  ok(firstDrain.failed === 0 && getHrEvaluationWriteQueueMetrics().queueDepth === 1, "a transient failure re-queues the row rather than dropping it immediately");
  const secondDrain = await drainHrEvaluationWriteQueue();
  ok(secondDrain.written === 1, "a retried row succeeds on its second attempt");

  // ── Queue overflow — bounded depth, drops and counts rather than growing ─
  _resetHrEvaluationWriteQueueForTests();
  _setHrEvaluationWriteExecutorForTests(fakeExecutor);
  behaviorQueue = [];
  const MAX_QUEUE_DEPTH = 5000;
  for (let i = 0; i < MAX_QUEUE_DEPTH + 50; i++) {
    enqueueHrEvaluationSnapshot(fakeRow());
  }
  const overflowMetrics = getHrEvaluationWriteQueueMetrics();
  ok(overflowMetrics.queueDepth === MAX_QUEUE_DEPTH, `queue never exceeds its bounded depth (got ${overflowMetrics.queueDepth})`);
  ok(overflowMetrics.droppedOverflow === 50, `overflow rows are dropped and counted, not silently lost (got ${overflowMetrics.droppedOverflow})`);

  // ── Revision-aware correction — same epoch/player/featureVersion, two
  // different sourceRevisions, both persist (no conflict). ────────────────
  _resetHrEvaluationWriteQueueForTests();
  _setHrEvaluationWriteExecutorForTests(fakeExecutor);
  behaviorQueue = ["ok", "ok"];
  enqueueHrEvaluationSnapshot(fakeRow({ sourceRevision: 0 }));
  enqueueHrEvaluationSnapshot(fakeRow({ sourceRevision: 1 }));
  const r4 = await drainHrEvaluationWriteQueue();
  ok(r4.written === 2, "two rows differing only in sourceRevision both persist — reprocessing a corrected epoch adds a new auditable row instead of conflicting");

  // ── Empty queue drains cleanly ──────────────────────────────────────────
  _resetHrEvaluationWriteQueueForTests();
  _setHrEvaluationWriteExecutorForTests(fakeExecutor);
  const emptyDrain = await drainHrEvaluationWriteQueue();
  ok(emptyDrain.written === 0 && emptyDrain.duplicates === 0 && emptyDrain.failed === 0, "draining an empty queue is a no-op");

  _resetHrEvaluationWriteQueueForTests();
  console.log(`hrEvaluationWriteQueue.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
