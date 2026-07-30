// Mound Radar V2 (shadow) — evaluation worker (Final Pre-Push Integrity
// Pass). Storage-touching; runs on its own periodic tick (wired in
// server/index.ts), NEVER called from buildMlbMoundRadar.ts's per-pitcher
// build loop. This is where the actual V2 evaluation (computeMoundV2Distribution,
// checkMoundV1Parity, decision-policy application) and its durable
// persistence happen — fully decoupled from V1's publication timeline.
//
// Claim -> evaluate -> persist -> complete/fail. A crash between any two of
// these steps loses nothing: an unclaimed job stays pending; a claimed-but-
// not-completed job's lease expires and becomes reclaimable
// (storage.claimMoundV2ShadowJobs); prediction rows are themselves
// idempotent (ON CONFLICT DO NOTHING on predictionId), so even a job
// re-processed after a crash mid-persist never double-writes.
//
// Every real dependency is injectable (see MoundV2ShadowWorkerDeps) so
// behavior — including "V1's enqueue path never waits on this worker's
// evaluate step, even if that step is artificially blocked forever" — can
// be proven with real behavioral tests (injected hanging/throwing
// functions), not just source-position assertions. See
// moundV2ShadowNeverWaits.test.ts for that specific proof.

import { storage } from "../../../../storage";
import { deserializeMoundV2ShadowJobPayload } from "./moundV2ShadowJobQueue";
import { evaluateMoundV2Shadow, type MoundV2ShadowEvaluationResult } from "./moundV2ShadowEvaluation";
import { recordMoundV2ShadowEvaluation } from "./moundV2ShadowStore";
import { buildMoundV2ShadowPredictionRows } from "./moundV2ShadowPersistenceBuilder";
import type { MoundV2ShadowJobRow, InsertMoundV2ShadowPrediction } from "@shared/schema";

/** A claimed-but-abandoned job (worker crashed mid-processing) becomes reclaimable after this long — long enough that a healthy worker tick (which processes a bounded batch quickly) would never legitimately still be "in progress". */
export const MOUND_V2_SHADOW_JOB_LEASE_MS = 5 * 60 * 1000;
/** Beyond this many failures, a job is dead-lettered — never auto-retried again, but reported (getMoundV2ShadowJobQueueStats) so a human can investigate. */
export const MOUND_V2_SHADOW_JOB_MAX_ATTEMPTS = 5;
/** Bounds worst-case work per tick — never an unbounded claim. */
export const MOUND_V2_SHADOW_JOB_BATCH_SIZE = 25;

export interface MoundV2ShadowWorkerTickSummary {
  claimed: number;
  completed: number;
  failed: number;
  deadLettered: number;
}

export interface MoundV2ShadowWorkerDeps {
  /** Opaque instance identifier for observability only — the real mutual exclusion is the atomic claim UPDATE, not this string. */
  workerInstanceId?: string;
  claim?: (args: { limit: number; leaseMs: number; claimedBy: string }) => Promise<MoundV2ShadowJobRow[]>;
  /** Injectable specifically so a test can artificially block/hang V2 evaluation with a controllable promise. */
  evaluate?: typeof evaluateMoundV2Shadow;
  recordMetrics?: (result: MoundV2ShadowEvaluationResult) => void;
  buildRows?: (result: MoundV2ShadowEvaluationResult) => InsertMoundV2ShadowPrediction[];
  createPrediction?: (row: InsertMoundV2ShadowPrediction) => Promise<unknown>;
  completeJob?: (jobId: string, completedAt: Date) => Promise<unknown>;
  failJob?: (args: { jobId: string; attemptedAt: Date; failureReason: string; maxAttempts: number }) => Promise<MoundV2ShadowJobRow | null>;
}

interface ResolvedDeps {
  claim: NonNullable<MoundV2ShadowWorkerDeps["claim"]>;
  evaluate: NonNullable<MoundV2ShadowWorkerDeps["evaluate"]>;
  recordMetrics: NonNullable<MoundV2ShadowWorkerDeps["recordMetrics"]>;
  buildRows: NonNullable<MoundV2ShadowWorkerDeps["buildRows"]>;
  createPrediction: NonNullable<MoundV2ShadowWorkerDeps["createPrediction"]>;
  completeJob: NonNullable<MoundV2ShadowWorkerDeps["completeJob"]>;
  failJob: NonNullable<MoundV2ShadowWorkerDeps["failJob"]>;
}

function resolveDeps(deps: MoundV2ShadowWorkerDeps): ResolvedDeps {
  return {
    claim: deps.claim ?? ((args) => storage.claimMoundV2ShadowJobs(args)),
    evaluate: deps.evaluate ?? evaluateMoundV2Shadow,
    recordMetrics: deps.recordMetrics ?? recordMoundV2ShadowEvaluation,
    buildRows: deps.buildRows ?? buildMoundV2ShadowPredictionRows,
    createPrediction: deps.createPrediction ?? ((row) => storage.createMoundV2ShadowPrediction(row)),
    completeJob: deps.completeJob ?? ((jobId, completedAt) => storage.completeMoundV2ShadowJob(jobId, completedAt)),
    failJob: deps.failJob ?? ((args) => storage.failMoundV2ShadowJob(args)),
  };
}

async function recordJobFailure(
  jobId: string,
  reason: string,
  summary: MoundV2ShadowWorkerTickSummary,
  resolved: ResolvedDeps,
): Promise<void> {
  try {
    const updated = await resolved.failJob({
      jobId,
      attemptedAt: new Date(),
      failureReason: reason,
      maxAttempts: MOUND_V2_SHADOW_JOB_MAX_ATTEMPTS,
    });
    if (updated?.status === "dead_letter") {
      summary.deadLettered++;
      console.warn(`[MOUND_V2_SHADOW_WORKER_DEAD_LETTER] ${jobId} reached max attempts (${MOUND_V2_SHADOW_JOB_MAX_ATTEMPTS}): ${reason}`);
    } else {
      summary.failed++;
    }
  } catch (err: unknown) {
    console.warn(`[MOUND_V2_SHADOW_WORKER] failed to record failure for ${jobId}:`, err instanceof Error ? err.message : err);
    summary.failed++;
  }
}

async function processJob(
  job: MoundV2ShadowJobRow,
  summary: MoundV2ShadowWorkerTickSummary,
  resolved: ResolvedDeps,
): Promise<void> {
  const { evaluateArgs } = deserializeMoundV2ShadowJobPayload(job.payload as any);
  const result = await resolved.evaluate(evaluateArgs);
  resolved.recordMetrics(result); // in-memory metrics only, best-effort, never the durability path

  if (result.failureReason) {
    await recordJobFailure(job.jobId, result.failureReason, summary, resolved);
    return;
  }

  const rows = resolved.buildRows(result);
  for (const row of rows) {
    await resolved.createPrediction(row);
  }
  await resolved.completeJob(job.jobId, new Date());
  summary.completed++;
}

/**
 * Runs one worker tick: claims a bounded batch of pending/stale-leased jobs
 * and processes each. Never throws. A single job's failure (a deserialize
 * error, an unexpected exception anywhere in evaluate/build/persist) is
 * caught and recorded via failMoundV2ShadowJob — it never stops the rest of
 * the batch from being attempted.
 */
export async function runMoundV2ShadowWorkerTick(deps: MoundV2ShadowWorkerDeps = {}): Promise<MoundV2ShadowWorkerTickSummary> {
  const resolved = resolveDeps(deps);
  const claimedBy = deps.workerInstanceId ?? `worker:${process.pid}`;
  const summary: MoundV2ShadowWorkerTickSummary = { claimed: 0, completed: 0, failed: 0, deadLettered: 0 };

  let jobs: MoundV2ShadowJobRow[];
  try {
    jobs = await resolved.claim({
      limit: MOUND_V2_SHADOW_JOB_BATCH_SIZE,
      leaseMs: MOUND_V2_SHADOW_JOB_LEASE_MS,
      claimedBy,
    });
  } catch (err: unknown) {
    console.warn("[MOUND_V2_SHADOW_WORKER] failed to claim jobs:", err instanceof Error ? err.message : err);
    return summary;
  }
  summary.claimed = jobs.length;

  for (const job of jobs) {
    try {
      await processJob(job, summary, resolved);
    } catch (err: unknown) {
      await recordJobFailure(job.jobId, err instanceof Error ? err.message : String(err), summary, resolved);
    }
  }

  return summary;
}
