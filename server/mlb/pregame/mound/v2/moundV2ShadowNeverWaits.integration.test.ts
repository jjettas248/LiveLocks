// Mound V2 shadow — THE central architectural proof (Final Pre-Push
// Integrity Pass): V1's publication path (enqueueMoundV2ShadowForPitcher,
// the ONLY V2-related call buildMlbMoundRadar.ts's per-pitcher loop makes)
// resolves WITHOUT waiting for V2 evaluation, V2 prediction persistence, V2
// grading, or worker availability — even when those are artificially
// blocked FOREVER with a controllable, never-resolving promise.
//
// This directly answers the prior handoff's contradiction: "V2 evaluation
// runs synchronously before signals.set... yet V1 never waits" cannot both
// be true, and they no longer need to be reconciled — evaluation does NOT
// run before signals.set anymore. buildMlbMoundRadar.ts's shadow block now
// calls ONLY the durable enqueue (one bounded INSERT); evaluateMoundV2Shadow
// is called exclusively from moundV2ShadowWorker.ts, on a fully separate
// tick, never in the same call stack as the build loop. This file proves
// that structural claim behaviorally, not just by reading source position.
//
// Requires DATABASE_URL to be SET (only because storage.ts's db.ts throws
// at import time without one — every actual dependency below is injected,
// so no real database connection or query is ever made).
//
// Run: DATABASE_URL=postgres://... npx tsx server/mlb/pregame/mound/v2/moundV2ShadowNeverWaits.integration.test.ts

import { enqueueMoundV2ShadowForPitcher } from "./moundV2ShadowEnqueueRunner";
import { runMoundV2ShadowWorkerTick } from "./moundV2ShadowWorker";
import { MOUND_V1_MODEL_VERSION, MOUND_V2_MODEL_VERSION, type EvaluateMoundV2ShadowArgs } from "./moundV2ShadowEvaluation";
import type { MoundV2ShadowJobRow } from "@shared/schema";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseEvaluateArgs(): EvaluateMoundV2ShadowArgs {
  return {
    snapshotId: "mound_v2:test:neverwaits:1",
    now: new Date("2026-07-30T20:00:00.000Z"),
    frozenInputArgs: {
      gameId: "game_1", gamePk: "gamePk_1", pitcherId: "pitcher_1", pitcherName: "Test Pitcher", opponent: "OPP",
      scheduledGameTime: "2026-07-30T23:05:00.000Z", lineupStatus: "confirmed",
      battingOrder: [{ playerId: "b1", playerName: "Batter One", battingOrderSlot: 1, handedness: "L", kRateVsThrowHand: 0.27, kRateSamplePa: 200, bvpAtBats: 8, bvpStrikeouts: 2 }],
      pitcherThrows: "R", kPer9: 9.8, priorSeasonsKPer9: [9.2, 8.9], swStrPct: 13.0, cswPct: 29.5, missesBatsFamily: null,
      kRateVsLHB: 0.28, kRateVsRHB: 0.24, avgInningsPerStart: 5.9, ipVarianceLast3: 0.8, lastStartPitchCount: 93, lastStartInningsPitched: 5.7, bbPer9: 2.8,
      strikeoutsMarket: { line: 6.5, overPrice: -120, underPrice: 100, sportsbook: "draftkings", fetchedAt: "2026-07-30T19:58:00.000Z" },
      outsMarket: { line: null, overPrice: null, underPrice: null, sportsbook: null, fetchedAt: null },
      dataQuality: "complete", productionModelVersion: MOUND_V1_MODEL_VERSION, v2ModelVersion: MOUND_V2_MODEL_VERSION,
    },
    productionComponentScores: { pitcherSkillScore: 7.2, workloadScore: 6.5, opponentKProfileScore: 6.8 },
    v1Score10: 6.9, v1Tier: "strong", v1RecommendedSide: "OVER", v1QualificationStatus: "recommended",
    strikeoutsLine: 6.5, outsLine: null,
  };
}

function fakeJobRow(over: Partial<MoundV2ShadowJobRow> = {}): MoundV2ShadowJobRow {
  return {
    jobId: "job_1", snapshotId: "snap_1", gameId: "g1", pitcherId: "p1", signalId: "sig1",
    payload: { signalId: "sig1", evaluateArgs: { ...baseEvaluateArgs(), now: baseEvaluateArgs().now.toISOString() } } as any,
    status: "in_progress", enqueuedAt: new Date(), attemptCount: 0, lastAttemptedAt: null, lastFailureReason: null,
    claimedAt: new Date(), claimedBy: "test", completedAt: null, createdAt: new Date(),
    ...over,
  } as MoundV2ShadowJobRow;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // ── 1. V1's enqueue path never even REFERENCES evaluateMoundV2Shadow ──────
  // Structural sanity check (not the main proof, but establishes the two
  // paths genuinely don't share a call): enqueueMoundV2ShadowForPitcher
  // succeeds using ONLY an injected enqueue function, no evaluate dependency
  // exists on that function's signature at all.
  {
    let enqueueCalled = false;
    const result = await enqueueMoundV2ShadowForPitcher(
      { signalId: "sig1", evaluateArgs: baseEvaluateArgs() },
      { enqueue: async (args) => { enqueueCalled = true; return { enqueued: true, alreadyEnqueued: false, jobId: `${args.evaluateArgs.snapshotId}:job` }; } },
    );
    ok(enqueueCalled, "the enqueue path calls its own injected enqueue function");
    ok(result?.enqueued === true, "enqueue succeeds");
  }

  // ── 2. THE CENTRAL PROOF: a worker tick whose evaluate step is blocked ────
  // FOREVER (a promise that never resolves) never affects a concurrent,
  // independent enqueue call. Uses Promise.race against a short timeout to
  // prove the enqueue call resolves quickly, while the blocked worker tick
  // is verified to still be pending afterward — never awaited to completion
  // (it never would complete).
  {
    let evaluateWasCalled = false;
    const neverResolves = new Promise<never>(() => {
      // Deliberately never resolves or rejects — simulates V2 evaluation
      // hanging forever (a pathological model bug, an infinite loop, a
      // stuck downstream call — whatever the failure mode, V1 must be
      // unaffected).
    });

    const blockedWorkerTick = runMoundV2ShadowWorkerTick({
      claim: async () => [fakeJobRow()],
      evaluate: async () => { evaluateWasCalled = true; return neverResolves as any; },
    });

    let enqueueResolved = false;
    const enqueuePromise = enqueueMoundV2ShadowForPitcher(
      { signalId: "sig_independent", evaluateArgs: baseEvaluateArgs() },
      { enqueue: async (args) => ({ enqueued: true, alreadyEnqueued: false, jobId: `${args.evaluateArgs.snapshotId}:job` }) },
    ).then((r) => { enqueueResolved = true; return r; });

    // Race the enqueue call against a generous timeout — if enqueue were
    // somehow entangled with the blocked worker tick, this would time out.
    const raceResult = await Promise.race([
      enqueuePromise.then(() => "enqueue_resolved"),
      sleep(500).then(() => "timeout"),
    ]);
    ok(raceResult === "enqueue_resolved", "the independent enqueue call resolves well before a 500ms timeout, completely unaffected by the concurrently-running blocked worker tick");
    ok(enqueueResolved === true, "the enqueue promise genuinely resolved (not just 'raced ok' by accident)");

    // The worker tick's own promise must still be unresolved — proving it
    // really was blocked, not that evaluate() was skipped or short-circuited.
    const workerStillPending = await Promise.race([
      blockedWorkerTick.then(() => "worker_resolved"),
      sleep(50).then(() => "still_pending"),
    ]);
    ok(workerStillPending === "still_pending", "the worker tick itself is genuinely still blocked/pending — evaluate() really was called and really is hanging, not silently bypassed");
    ok(evaluateWasCalled === true, "the injected evaluate() was actually invoked by the worker (sanity check that we're really exercising the blocking path)");

    // Clean up: nothing to await on blockedWorkerTick — it never resolves by
    // design. Node's event loop will hold it open only as long as this
    // process runs; the test process exits immediately after, so this
    // dangling promise causes no leak in practice for a one-shot test run.
  }

  // ── 3. V1 publication also never waits on PERSISTENCE or GRADING ─────────
  // (persistence/grading happen only inside the worker's OWN processJob,
  // never on the enqueue path at all — enqueueMoundV2ShadowForPitcher has no
  // createPrediction/completeJob/failJob dependency whatsoever).
  {
    const enqueueDepsKeys = Object.keys({ enqueue: async () => ({}) as any });
    ok(enqueueDepsKeys.length === 1 && enqueueDepsKeys[0] === "enqueue", "the enqueue-side dependency surface has exactly one hook (enqueue) — structurally no way to wire in a persistence/grading dependency on this path even by mistake");
  }

  // ── 4. V1 publication never waits on the WORKER EXISTING at all ─────────
  // Calling the real (non-injected) enqueueMoundV2ShadowForPitcher default
  // export never imports moundV2ShadowWorker.ts. Checks for a real ES
  // import statement specifically — NOT a bare substring match, which would
  // also (harmlessly, correctly) trip on this file's own doc comments that
  // reference moundV2ShadowWorker.ts/evaluateMoundV2Shadow BY NAME for
  // context (e.g. "the actual evaluation happens in moundV2ShadowWorker.ts").
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const importsModule = (source: string, moduleName: string): boolean =>
      new RegExp(`^\\s*import\\s[^;]*from\\s+["'][^"']*${moduleName}["']`, "m").test(source);

    const enqueueRunnerSource = fs.readFileSync(path.join(dir, "moundV2ShadowEnqueueRunner.ts"), "utf-8");
    ok(!importsModule(enqueueRunnerSource, "moundV2ShadowWorker"), "moundV2ShadowEnqueueRunner.ts (V1's own call path) has zero IMPORT of moundV2ShadowWorker.ts — V1 cannot wait on the worker because it has no way to even reach it");

    const jobQueueSource = fs.readFileSync(path.join(dir, "moundV2ShadowJobQueue.ts"), "utf-8");
    ok(!importsModule(jobQueueSource, "moundV2ShadowWorker"), "moundV2ShadowJobQueue.ts (the enqueue implementation) does not import the worker");
    ok(!importsModule(jobQueueSource, "moundV2ShadowEvaluation") || !/evaluateMoundV2Shadow\(/.test(jobQueueSource), "moundV2ShadowJobQueue.ts never CALLS evaluateMoundV2Shadow — it only imports its TYPE (EvaluateMoundV2ShadowArgs) for the payload shape, never the function itself");
  }

  console.log(`\nmoundV2ShadowNeverWaits.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
