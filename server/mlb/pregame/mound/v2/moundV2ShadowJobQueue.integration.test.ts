// Mound V2 shadow evaluation outbox — REAL database invariants (Final
// Pre-Push Integrity Pass). Exercises storage.ts's actual
// enqueueMoundV2ShadowJob/claimMoundV2ShadowJobs/completeMoundV2ShadowJob/
// failMoundV2ShadowJob/getMoundV2ShadowJobQueueStats against a live Postgres
// connection — no monkey-patching. This is the load-bearing proof that the
// FOR UPDATE SKIP LOCKED claim query is genuinely safe under concurrent
// claimers (two "worker instances" racing for the same rows).
//
// Requires DATABASE_URL to point at a disposable database (never
// production) with the schema already present (drizzle-kit push or
// ensureMoundV2ShadowJobsPersistenceSchema).
//
// Run: DATABASE_URL=postgresql://... npx tsx server/mlb/pregame/mound/v2/moundV2ShadowJobQueue.integration.test.ts

import { storage } from "../../../../storage";
import { db, pool } from "../../../../db";
import { moundV2ShadowJobs } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { InsertMoundV2ShadowJob } from "@shared/schema";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const TEST_PREFIX = "itest_mv2job_";

function fakeJob(over: Partial<InsertMoundV2ShadowJob> = {}): InsertMoundV2ShadowJob {
  const id = over.jobId ?? `${TEST_PREFIX}job_1`;
  return {
    jobId: id,
    snapshotId: over.snapshotId ?? `${TEST_PREFIX}snap_1`,
    gameId: `${TEST_PREFIX}game_1`,
    pitcherId: `${TEST_PREFIX}pitcher_1`,
    signalId: `${TEST_PREFIX}signal_1`,
    payload: { signalId: "sig1", evaluateArgs: { snapshotId: "snap_1", now: "2026-07-30T20:00:00.000Z" } } as any,
    status: "pending",
    ...over,
  };
}

async function cleanup() {
  const rows = await db.select({ jobId: moundV2ShadowJobs.jobId }).from(moundV2ShadowJobs).where(eq(moundV2ShadowJobs.gameId, `${TEST_PREFIX}game_1`));
  const ids = rows.map((r) => r.jobId);
  if (ids.length > 0) {
    await db.delete(moundV2ShadowJobs).where(inArray(moundV2ShadowJobs.jobId, ids));
  }
  await db.delete(moundV2ShadowJobs).where(eq(moundV2ShadowJobs.gameId, `${TEST_PREFIX}game_concurrent`));
}

async function testEnqueueIdempotency() {
  const job = fakeJob();
  const first = await storage.enqueueMoundV2ShadowJob(job);
  ok(first !== null && first.jobId === job.jobId, "a real enqueue returns the inserted row");
  ok(first?.status === "pending", "a freshly enqueued job starts pending");
  ok(first?.attemptCount === 0, "a freshly enqueued job starts with 0 attempts");

  const duplicate = await storage.enqueueMoundV2ShadowJob(job);
  ok(duplicate === null, "enqueuing the exact same snapshotId again returns null (ON CONFLICT DO NOTHING) — no error, no duplicate row");

  const rows = await db.select().from(moundV2ShadowJobs).where(eq(moundV2ShadowJobs.jobId, job.jobId!));
  ok(rows.length === 1, `exactly one row exists after the duplicate enqueue attempt (found ${rows.length})`);

  const fetched = await storage.getMoundV2ShadowJob(job.jobId!);
  ok(fetched !== null && fetched.snapshotId === job.snapshotId, "getMoundV2ShadowJob reads back the real persisted row");

  const missing = await storage.getMoundV2ShadowJob(`${TEST_PREFIX}does_not_exist`);
  ok(missing === null, "getMoundV2ShadowJob returns null for a nonexistent jobId, never throws");
}

async function testClaimClaimsOnlyPendingAndStaleInProgress() {
  const pendingJob = fakeJob({ jobId: `${TEST_PREFIX}job_pending`, snapshotId: `${TEST_PREFIX}snap_pending`, status: "pending" });
  const freshInProgressJob = fakeJob({ jobId: `${TEST_PREFIX}job_fresh_inprogress`, snapshotId: `${TEST_PREFIX}snap_fresh`, status: "pending" });
  const completedJob = fakeJob({ jobId: `${TEST_PREFIX}job_completed`, snapshotId: `${TEST_PREFIX}snap_completed`, status: "pending" });

  await storage.enqueueMoundV2ShadowJob(pendingJob);
  await storage.enqueueMoundV2ShadowJob(freshInProgressJob);
  await storage.enqueueMoundV2ShadowJob(completedJob);

  // Manually claim freshInProgressJob "recently" (simulating another worker mid-flight) and mark completedJob done.
  await db.update(moundV2ShadowJobs).set({ status: "in_progress", claimedAt: new Date(), claimedBy: "other-worker" }).where(eq(moundV2ShadowJobs.jobId, freshInProgressJob.jobId!));
  await storage.completeMoundV2ShadowJob(completedJob.jobId!, new Date());

  const claimed = await storage.claimMoundV2ShadowJobs({ limit: 100, leaseMs: 5 * 60 * 1000, claimedBy: "test-worker" });
  const claimedIds = new Set(claimed.map((j) => j.jobId));
  ok(claimedIds.has(pendingJob.jobId!), "a genuinely pending job is claimed");
  ok(!claimedIds.has(freshInProgressJob.jobId!), "a job another worker claimed RECENTLY (fresh lease) is NOT claimed — no double-processing");
  ok(!claimedIds.has(completedJob.jobId!), "an already-completed job is never claimed");

  const claimedPending = claimed.find((j) => j.jobId === pendingJob.jobId);
  ok(claimedPending?.status === "in_progress", "the claim atomically transitions status to in_progress");
  ok(claimedPending?.claimedBy === "test-worker", "the claim stamps the real claimedBy identifier");
  ok(claimedPending?.claimedAt != null, "the claim stamps a real claimedAt timestamp");
}

async function testStaleLeaseIsReclaimable() {
  const staleJob = fakeJob({ jobId: `${TEST_PREFIX}job_stale`, snapshotId: `${TEST_PREFIX}snap_stale`, status: "pending" });
  await storage.enqueueMoundV2ShadowJob(staleJob);
  // Simulate a worker that claimed this job a long time ago and then crashed
  // (never completed or failed it) — claimedAt far in the past.
  const longAgo = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
  await db.update(moundV2ShadowJobs).set({ status: "in_progress", claimedAt: longAgo, claimedBy: "crashed-worker" }).where(eq(moundV2ShadowJobs.jobId, staleJob.jobId!));

  const claimed = await storage.claimMoundV2ShadowJobs({ limit: 100, leaseMs: 5 * 60 * 1000, claimedBy: "recovery-worker" }); // 5 min lease, staleJob is 1h old
  const reclaimed = claimed.find((j) => j.jobId === staleJob.jobId);
  ok(reclaimed !== undefined, "a job whose lease has expired (claimed 1h ago, 5min lease) IS reclaimable by a new worker — recovers from a crashed worker");
  ok(reclaimed?.claimedBy === "recovery-worker", "the reclaim stamps the NEW worker's identifier");
}

async function testConcurrentClaimNeverDoubleClaims() {
  const N = 20;
  const jobs = Array.from({ length: N }, (_, i) => fakeJob({
    jobId: `${TEST_PREFIX}concurrent_job_${i}`,
    snapshotId: `${TEST_PREFIX}concurrent_snap_${i}`,
    gameId: `${TEST_PREFIX}game_concurrent`,
    status: "pending",
  }));
  for (const job of jobs) await storage.enqueueMoundV2ShadowJob(job);

  // Two "worker instances" claim CONCURRENTLY (real parallel DB round trips) —
  // FOR UPDATE SKIP LOCKED must ensure no job is ever claimed by both.
  const [batchA, batchB] = await Promise.all([
    storage.claimMoundV2ShadowJobs({ limit: N, leaseMs: 5 * 60 * 1000, claimedBy: "worker-a" }),
    storage.claimMoundV2ShadowJobs({ limit: N, leaseMs: 5 * 60 * 1000, claimedBy: "worker-b" }),
  ]);
  const idsA = new Set(batchA.map((j) => j.jobId));
  const idsB = new Set(batchB.map((j) => j.jobId));
  const overlap = [...idsA].filter((id) => idsB.has(id));
  ok(overlap.length === 0, `two concurrent claimers never claim the same job — zero overlap (found ${overlap.length} overlapping: ${overlap.join(",")})`);
  ok(idsA.size + idsB.size === N, `together the two concurrent claims cover all ${N} jobs exactly once (got ${idsA.size} + ${idsB.size} = ${idsA.size + idsB.size})`);
}

async function testCompleteAndFailAreColumnScoped() {
  const job = fakeJob({ jobId: `${TEST_PREFIX}job_complete`, snapshotId: `${TEST_PREFIX}snap_complete` });
  await storage.enqueueMoundV2ShadowJob(job);
  const completedAt = new Date("2026-07-30T21:00:00.000Z");
  const completed = await storage.completeMoundV2ShadowJob(job.jobId!, completedAt);
  ok(completed?.status === "completed" && completed?.completedAt?.getTime() === completedAt.getTime(), "completeMoundV2ShadowJob stamps status=completed and the real completedAt");
  ok(completed?.payload != null, "completing a job never touches its payload");

  const missingComplete = await storage.completeMoundV2ShadowJob(`${TEST_PREFIX}does_not_exist`, new Date());
  ok(missingComplete === null, "completing a nonexistent jobId returns null, never throws");
}

async function testFailIncrementsAndDeadLetters() {
  const job = fakeJob({ jobId: `${TEST_PREFIX}job_fail`, snapshotId: `${TEST_PREFIX}snap_fail` });
  await storage.enqueueMoundV2ShadowJob(job);

  const attempt1 = await storage.failMoundV2ShadowJob({ jobId: job.jobId!, attemptedAt: new Date(), failureReason: "transient error 1", maxAttempts: 3 });
  ok(attempt1?.attemptCount === 1 && attempt1?.status === "pending", `first failure increments to 1 and stays pending (not yet at max) (got count=${attempt1?.attemptCount} status=${attempt1?.status})`);
  ok(attempt1?.lastFailureReason === "transient error 1", "the real failure reason is persisted");

  const attempt2 = await storage.failMoundV2ShadowJob({ jobId: job.jobId!, attemptedAt: new Date(), failureReason: "transient error 2", maxAttempts: 3 });
  ok(attempt2?.attemptCount === 2 && attempt2?.status === "pending", "second failure increments to 2, still pending");

  const attempt3 = await storage.failMoundV2ShadowJob({ jobId: job.jobId!, attemptedAt: new Date(), failureReason: "final error", maxAttempts: 3 });
  ok(attempt3?.attemptCount === 3 && attempt3?.status === "dead_letter", `third failure (== maxAttempts) transitions to dead_letter (got count=${attempt3?.attemptCount} status=${attempt3?.status})`);

  // A dead-lettered job is NEVER claimed again by the normal claim query.
  const claimedAfterDeadLetter = await storage.claimMoundV2ShadowJobs({ limit: 100, leaseMs: 0, claimedBy: "test" });
  ok(!claimedAfterDeadLetter.some((j) => j.jobId === job.jobId), "a dead_letter job is never claimed by the routine claim query again");

  const missingFail = await storage.failMoundV2ShadowJob({ jobId: `${TEST_PREFIX}does_not_exist`, attemptedAt: new Date(), failureReason: "x", maxAttempts: 3 });
  ok(missingFail === null, "failing a nonexistent jobId returns null, never throws");
}

async function testQueueStats() {
  await cleanup();
  const pendingJob = fakeJob({ jobId: `${TEST_PREFIX}stat_pending`, snapshotId: `${TEST_PREFIX}stat_snap_pending`, enqueuedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
  const completedJob = fakeJob({ jobId: `${TEST_PREFIX}stat_completed`, snapshotId: `${TEST_PREFIX}stat_snap_completed` });
  const deadJob = fakeJob({ jobId: `${TEST_PREFIX}stat_dead`, snapshotId: `${TEST_PREFIX}stat_snap_dead` });
  const staleInProgressJob = fakeJob({ jobId: `${TEST_PREFIX}stat_stale`, snapshotId: `${TEST_PREFIX}stat_snap_stale` });

  await storage.enqueueMoundV2ShadowJob(pendingJob);
  await storage.enqueueMoundV2ShadowJob(completedJob);
  await storage.enqueueMoundV2ShadowJob(deadJob);
  await storage.enqueueMoundV2ShadowJob(staleInProgressJob);

  await storage.completeMoundV2ShadowJob(completedJob.jobId!, new Date());
  await storage.failMoundV2ShadowJob({ jobId: deadJob.jobId!, attemptedAt: new Date(), failureReason: "x", maxAttempts: 1 });
  await db.update(moundV2ShadowJobs).set({ status: "in_progress", claimedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(moundV2ShadowJobs.jobId, staleInProgressJob.jobId!));

  const stats = await storage.getMoundV2ShadowJobQueueStats(5 * 60 * 1000); // 5 min stale threshold
  ok(stats.pending >= 1, `pending count reflects at least the one pending job (got ${stats.pending})`);
  ok(stats.completed >= 1, `completed count reflects at least the one completed job (got ${stats.completed})`);
  ok(stats.deadLetter >= 1, `deadLetter count reflects at least the one dead-lettered job (got ${stats.deadLetter})`);
  ok(stats.staleInProgressCount >= 1, `staleInProgressCount reflects the 1h-old in_progress job as stale under a 5min threshold (got ${stats.staleInProgressCount})`);
  ok(stats.oldestPendingEnqueuedAt !== null, "oldestPendingEnqueuedAt is a real timestamp, not null, when pending rows exist");
}

async function main() {
  await cleanup();
  await testEnqueueIdempotency();
  await testClaimClaimsOnlyPendingAndStaleInProgress();
  await testStaleLeaseIsReclaimable();
  await testConcurrentClaimNeverDoubleClaims();
  await testCompleteAndFailAreColumnScoped();
  await testFailIncrementsAndDeadLetters();
  await testQueueStats();
  await cleanup();
  await pool.end();
  console.log(`\nmoundV2ShadowJobQueue.integration.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); await pool.end(); } catch {}
  process.exit(1);
});
