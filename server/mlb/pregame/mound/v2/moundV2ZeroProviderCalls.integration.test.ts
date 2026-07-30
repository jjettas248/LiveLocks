// Mound V2 shadow — INSTRUMENTED zero-provider-call proof (Final Pre-Push
// Integrity Pass). Per the explicit requirement: "Do not use a structural
// 'function appears in one file' test as proof of zero provider calls" —
// this file does NOT grep source text. It monkey-patches the actual network
// primitive (globalThis.fetch — the bare Node 18+ built-in every real
// provider call in this codebase uses; see server/oddsService.ts's,
// server/mlb/dataPullService.ts's, and the MLB Stats API/Savant/ESPN
// fetchers, none of which import node-fetch or any other HTTP client) with
// a COUNTING SPY, runs the REAL end-to-end enqueue -> claim -> evaluate ->
// persist -> complete cycle (the actual production functions, not
// injected/fake ones, and a REAL database), and asserts the call count is
// exactly 0 for the entire cycle.
//
// This is deliberately the STRONGEST possible instrumentation point: a spy
// on globalThis.fetch catches ANY outbound HTTP call from ANYWHERE in the
// real call graph the enqueue+worker path actually executes (Odds API,
// MLB Stats API, Savant, ESPN, or anything else) — not just one function
// this file's author happened to think of. A real provider call, if one
// ever crept in, would be counted here regardless of which module made it.
//
// Requires DATABASE_URL to point at a disposable database (schema already
// present via ensureMoundV2ShadowPersistenceSchema/ensureMoundV2ShadowJobsPersistenceSchema).
//
// Run: DATABASE_URL=postgresql://... npx tsx server/mlb/pregame/mound/v2/moundV2ZeroProviderCalls.integration.test.ts

import { storage } from "../../../../storage";
import { db, pool } from "../../../../db";
import { moundV2ShadowPredictions, moundV2ShadowJobs } from "@shared/schema";
import { eq } from "drizzle-orm";
import { enqueueMoundV2ShadowForPitcher } from "./moundV2ShadowEnqueueRunner";
import { runMoundV2ShadowWorkerTick } from "./moundV2ShadowWorker";
import { MOUND_V1_MODEL_VERSION, MOUND_V2_MODEL_VERSION } from "./moundV2ShadowEvaluation";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const TEST_PREFIX = "itest_mv2_zerocalls_";

// ── Install the counting spy on the real network primitive ────────────────
const realFetch = globalThis.fetch;
let fetchCallCount = 0;
const fetchCallLog: string[] = [];
function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === "object" && "url" in input) return String((input as { url: unknown }).url);
  return String(input);
}
(globalThis as any).fetch = async (...args: Parameters<typeof fetch>) => {
  fetchCallCount++;
  fetchCallLog.push(urlOf(args[0]));
  // Fail loudly rather than actually attempting a real network call from
  // inside a test — any call reaching this spy is ALREADY the failure this
  // test exists to catch; there is no legitimate reason for one to occur.
  throw new Error(`[TEST SPY] unexpected real network call to: ${urlOf(args[0])}`);
};

function resetSpy() {
  fetchCallCount = 0;
  fetchCallLog.length = 0;
}

function nineBatterLineup() {
  return Array.from({ length: 9 }, (_, i) => ({
    playerId: `${TEST_PREFIX}batter_${i}`,
    playerName: `Batter ${i}`,
    battingOrderSlot: i + 1,
    handedness: (i % 2 === 0 ? "L" : "R") as "L" | "R",
    kRateVsThrowHand: 0.22,
    kRateSamplePa: 200,
    bvpAtBats: 0,
    bvpStrikeouts: 0,
  }));
}

async function cleanup() {
  await db.delete(moundV2ShadowPredictions).where(eq(moundV2ShadowPredictions.gameId, `${TEST_PREFIX}game_1`));
  await db.delete(moundV2ShadowJobs).where(eq(moundV2ShadowJobs.gameId, `${TEST_PREFIX}game_1`));
}

async function main() {
  await cleanup();

  try {
    // ── Phase 1: the enqueue path (what buildMlbMoundRadar.ts's per-pitcher
    // loop actually calls) makes zero network calls ─────────────────────
    resetSpy();
    const pitcherId = `${TEST_PREFIX}pitcher_1`;
    const snapshotId = `mound_v2:${TEST_PREFIX}:build1`;
    const enqueueResult = await enqueueMoundV2ShadowForPitcher({
      signalId: `${TEST_PREFIX}signal_1`,
      evaluateArgs: {
        snapshotId,
        now: new Date("2026-07-30T20:00:00.000Z"),
        frozenInputArgs: {
          gameId: `${TEST_PREFIX}game_1`, gamePk: `${TEST_PREFIX}gamePk_1`, pitcherId, pitcherName: "Test Pitcher", opponent: "OPP",
          scheduledGameTime: "2026-07-30T23:05:00.000Z", lineupStatus: "confirmed",
          battingOrder: nineBatterLineup(),
          pitcherThrows: "R", kPer9: 9.8, priorSeasonsKPer9: [9.2, 8.9], swStrPct: 13.0, cswPct: 29.5, missesBatsFamily: null,
          kRateVsLHB: 0.28, kRateVsRHB: 0.24, avgInningsPerStart: 5.9, ipVarianceLast3: 0.8,
          lastStartPitchCount: 93, lastStartInningsPitched: 5.7, bbPer9: 2.8,
          strikeoutsMarket: { line: 6.5, overPrice: -120, underPrice: 100, sportsbook: "draftkings", fetchedAt: "2026-07-30T19:58:00.000Z" },
          outsMarket: { line: null, overPrice: null, underPrice: null, sportsbook: null, fetchedAt: null },
          dataQuality: "complete", productionModelVersion: MOUND_V1_MODEL_VERSION, v2ModelVersion: MOUND_V2_MODEL_VERSION,
        },
        productionComponentScores: { pitcherSkillScore: 7.2, workloadScore: 6.5, opponentKProfileScore: 6.8 },
        v1Score10: 6.9, v1Tier: "strong", v1RecommendedSide: "OVER", v1QualificationStatus: "recommended",
        strikeoutsLine: 6.5, outsLine: null,
      },
    });
    ok(enqueueResult?.enqueued === true, "sanity: the real enqueue call succeeds");
    ok(fetchCallCount === 0, `the enqueue path (durable outbox INSERT) makes ZERO network calls (got ${fetchCallCount}: ${fetchCallLog.join(", ")})`);

    // ── Phase 2: the worker tick (claim -> evaluate -> persist -> complete,
    // using the REAL, non-injected production functions throughout) also
    // makes zero network calls ───────────────────────────────────────────
    resetSpy();
    const summary = await runMoundV2ShadowWorkerTick({ workerInstanceId: "zero-provider-calls-test" });
    ok(summary.claimed >= 1, `sanity: the worker tick actually claimed the job just enqueued (claimed=${summary.claimed})`);
    ok(summary.completed >= 1 || summary.failed >= 1, "sanity: the claimed job was actually processed (completed or failed), not silently dropped");
    ok(fetchCallCount === 0, `the REAL worker tick — claim, evaluateMoundV2Shadow (computeMoundV2Distribution, checkMoundV1Parity, applyMoundV2ModelPolicy, applyMoundV2Executability), buildMoundV2ShadowPredictionRows, storage.createMoundV2ShadowPrediction, storage.completeMoundV2ShadowJob — makes ZERO network calls end to end (got ${fetchCallCount}: ${fetchCallLog.join(", ")})`);

    // ── Phase 3: even a SECOND worker tick (covering the reclaim/retry path
    // when nothing is pending) makes zero network calls ──────────────────
    resetSpy();
    await runMoundV2ShadowWorkerTick({ workerInstanceId: "zero-provider-calls-test-2" });
    ok(fetchCallCount === 0, `a worker tick with nothing left to claim also makes zero network calls (got ${fetchCallCount})`);
  } finally {
    (globalThis as any).fetch = realFetch;
  }

  await cleanup();
  await pool.end();
  console.log(`\nmoundV2ZeroProviderCalls.integration.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  (globalThis as any).fetch = realFetch;
  console.error(e);
  try { await cleanup(); await pool.end(); } catch {}
  process.exit(1);
});
