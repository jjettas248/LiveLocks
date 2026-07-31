/**
 * MLB Live Edge Trust Recovery — carried-signal READ-TIME expiration proof.
 *
 * The write-time filter (applyCarryForwardRevalidation, called from
 * liveGameOrchestrator.ts at the mlbEdgeCache write boundary) only re-runs
 * when a real baseball event triggers triggerEngine and a fresh write
 * happens. MLB Live Edge is event-driven (CLAUDE.md §3.2a-1) — pure time
 * passing between events is not itself an event, so a carried signal's
 * frozen oddsTimestamp/engineGeneratedAt could previously age past validity
 * while sitting untouched in the cache, served to every reader in the
 * meantime, with NO further write ever re-checking it.
 *
 * This harness proves that gap is closed by edgeCache.ts's
 * applyReadTimeGuards (wired into mlbEdgeCache.get()/.entries(), the single
 * choke point every MLB route reads through) — using a REAL Express app,
 * REAL requireAuth/Postgres-backed users, REAL mlbEdgeCache, REAL
 * mergeCarryForward + applyCarryForwardRevalidation, and a controlled clock
 * (global Date.now() monkey-patched for the duration of this process,
 * restored in a finally) to simulate time passing with NO intervening
 * cache write.
 *
 * Three scenarios, each isolated so only ONE mechanism can explain the
 * signal's disappearance:
 *   A. Odds-source staleness (30s live threshold) — clock advances ~10s
 *      past the threshold, comfortably under the 4-minute engine-liveness
 *      axis (isMLBEdgeEntryFresh), so ONLY the new per-signal read-time
 *      guard can explain the signal vanishing.
 *   B. Max carry age (20 min) — the signal's OWN engineGeneratedAt is
 *      already 19 minutes old AT WRITE TIME (simulating a signal carried
 *      for many prior cycles), then the clock advances only 2 more minutes
 *      (still comfortably under the 4-minute engine-liveness axis), so
 *      crossing the 20-minute total-age boundary is what hides it — not
 *      the entry-level axis, which independently remains satisfied.
 *   C. Terminal game state — the game is removed from the active registry
 *      (liveGameRegistry.ts's removeGame(), exactly what the discovery
 *      sweep calls for a game no longer live) with NO further cache write;
 *      the carried signal must not survive.
 *
 * REQUIREMENTS TO RUN
 *   DATABASE_URL=postgresql://user:pass@host:port/db \
 *     npx tsx server/mlb/carryForwardReadTimeExpiration.pg-integration.test.ts
 *
 * Exits non-zero on any assertion failure.
 */

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to run this integration harness (see file header).");
  process.exit(1);
}

import express from "express";
import { createServer } from "http";
import jwt from "jsonwebtoken";
import { like } from "drizzle-orm";
import { db } from "../db";
import { users } from "@shared/schema";
import { registerRoutes, registerAnalyticsRoutes } from "../routes";
import { mlbEdgeCache } from "./edgeCache";
import { mergeCarryForward, type CycleScope } from "./edgeCarryForward";
import { applyCarryForwardRevalidation } from "./carryForwardRevalidation";
import { registerGame, removeGame, getGame } from "./liveGameRegistry";
import type { MLBQualifiedSignal } from "./types";

const JWT_SECRET = process.env.SESSION_SECRET || "livelocks-dev-secret";
const EMAIL_PREFIX = "carryfwd-readtime-verify-";

// ── Controlled clock ────────────────────────────────────────────────────
const REAL_DATE_NOW = Date.now.bind(Date);
let clockOffsetMs = 0;
function installControlledClock() {
  Date.now = () => REAL_DATE_NOW() + clockOffsetMs;
}
function advanceClock(ms: number) {
  clockOffsetMs += ms;
}
function restoreRealClock() {
  Date.now = REAL_DATE_NOW;
}

function mintToken(userId: number): string {
  // Long-lived relative to the small clock advances used in these
  // scenarios (max ~2 minutes) — comfortable margin, never the thing under
  // test.
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30m" });
}

async function createAdminUser() {
  const email = `${EMAIL_PREFIX}admin-${REAL_DATE_NOW()}@example.invalid`;
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "not-a-real-hash-integration-fixture-only", emailVerified: true, isAdmin: true })
    .returning();
  return { id: row.id, token: mintToken(row.id) };
}

async function cleanupTestUsers() {
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
}

function baseSignal(overrides: Partial<MLBQualifiedSignal>): MLBQualifiedSignal {
  const now = Date.now();
  return {
    id: overrides.id ?? "sig",
    gameId: overrides.gameId ?? "g1",
    playerId: overrides.playerId ?? "p1",
    playerName: overrides.playerName ?? "READTIME_TEST_PLAYER",
    team: "NYY",
    market: "total_bases",
    side: "OVER",
    sportsbook: "draftkings",
    line: 1.5,
    impliedProbability: null,
    engineProbability: 62,
    projection: 2.1,
    evPct: 5,
    confidenceTier: "STRONG",
    signalTier: "strong",
    signalScore: 70,
    reasons: ["synthetic fixture — not real"],
    feedTags: [],
    signalTags: [],
    playerGlowEligible: false,
    gameCardSignalTags: [],
    formIndicator: "steady" as any,
    isExperimental: false,
    engineGeneratedAt: now,
    badges: [],
    riskFlags: [],
    drivers: {},
    timestamps: {
      engineGeneratedAt: new Date(now).toISOString(),
      oddsUpdatedAt: new Date(now).toISOString(),
      gameStateUpdatedAt: new Date(now).toISOString(),
    },
    fallbackUsed: false,
    actionable: true,
    alreadyHit: false,
    stale: false,
    watchlist: false,
    overOdds: -120,
    underOdds: 105,
    oddsTimestamp: now,
    pitcherName: "READTIME_PITCHER",
    pitcherHand: "R",
    pitcherPitchCount: 40,
    pitcherTimesThrough: 1,
    homeScore: 0,
    awayScore: 0,
    inning: 3,
    isTopInning: true,
    currentStat: 0,
    completedAB: 1,
    bookImplied: null,
    priorABResults: [],
    currentStatKnown: true,
    ...overrides,
  } as MLBQualifiedSignal;
}

/**
 * Runs the EXACT real production sequence
 * (mergeCarryForward → applyCarryForwardRevalidation → mlbEdgeCache.set)
 * that liveGameOrchestrator.ts's triggerEngine runs at its cache-write
 * boundary, including the carriedSignalIds stamp the read-time guard reads.
 */
function writeCarriedSignalToCache(gameId: string, carriedSignal: MLBQualifiedSignal, freshSignal: MLBQualifiedSignal | null) {
  const now = Date.now();
  const prior = { outputs: [], qualifiedSignals: [carriedSignal], allSignals: [carriedSignal] };
  const fresh = freshSignal
    ? { outputs: [], qualifiedSignals: [freshSignal], allSignals: [freshSignal] }
    : { outputs: [], qualifiedSignals: [], allSignals: [] };
  const scope: CycleScope = { markets: new Set(["home_runs"]), playerIds: "all" };

  const merged = mergeCarryForward({ gameId, prior, fresh, scope, nowMs: now, maxCarryAgeMs: 20 * 60 * 1000, isResolved: () => false });
  const revalidated = applyCarryForwardRevalidation(merged, () => ({
    nowMs: now,
    maxCarryAgeMs: 20 * 60 * 1000,
    oddsFreshnessThresholdMs: 30 * 1000,
    currentPitcherId: null,
    currentPitcherName: "READTIME_PITCHER",
    currentOffenseTeam: "NYY",
    gameIsTerminal: false,
    isResolved: false,
  }));

  mlbEdgeCache.set(gameId, {
    gameId,
    outputs: [],
    qualifiedSignals: revalidated.qualifiedSignals,
    allSignals: revalidated.allSignals,
    gameCardTags: [],
    updatedAt: now,
    createdAt: now,
    carriedSignalIds: revalidated.survivingCarriedIds,
  });

  return revalidated;
}

interface TestCase { name: string; fn: () => Promise<void> }
const cases: TestCase[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, ctx: string) {
  if (actual !== expected) throw new Error(`${ctx}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  installControlledClock();

  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  registerAnalyticsRoutes(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  await cleanupTestUsers();
  const admin = await createAdminUser();

  async function req(path: string) {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${admin.token}` } });
    const body = await res.json();
    return { status: res.status, body };
  }

  // ── Scenario A: odds-source staleness expires read-time, no new write ──
  test("A. Carried signal with initially-fresh odds becomes invisible once the CONTROLLED CLOCK crosses the 30s live threshold, with zero intervening cache writes", async () => {
    const gameId = "READTIME_GAME_A";
    // In production, applyCarryForwardRevalidation only ever runs inside
    // triggerEngine for an already-registered game — registering here
    // matches that real precondition (an unregistered game is correctly
    // treated as terminal by the read-time guard's scope check; see
    // scenario D for that behavior tested directly).
    registerGame({ gameId, homeTeam: "NYY", awayTeam: "BOS", startTime: new Date().toISOString() });
    const carried = baseSignal({
      id: "readtime_a_carried",
      gameId,
      playerId: "READTIME_A_PLAYER",
      playerName: "READTIME_A_PLAYER_NAME",
      oddsTimestamp: Date.now(), // fresh at write time
    });

    const revalidated = writeCarriedSignalToCache(gameId, carried, null);
    assertEq(revalidated.demoted, 0, "signal must survive the initial write-time pass (it starts fresh)");
    assert(revalidated.survivingCarriedIds.includes(carried.id), "signal must be tracked as carried for the read-time guard");

    // Step 3 — confirm initially visible.
    const before = await req("/api/mlb/edge-feed");
    const namesBefore: string[] = (before.body.signals ?? []).map((s: any) => s.playerName);
    assert(namesBefore.includes("READTIME_A_PLAYER_NAME"), `signal must be visible immediately after write, got: ${JSON.stringify(namesBefore)}`);

    // Step 4 — advance the clock past the 30s odds-freshness threshold.
    // NO cache write happens in between — this is the entire point.
    advanceClock(45 * 1000);

    // Sanity: the ENTRY-level engine-liveness axis (4 min) must NOT be what
    // explains this — 45s is nowhere close to 4 minutes, isolating the
    // read-time guard as the only possible cause.
    const entryStillTrackedByEngineLiveness = 45 * 1000 < 4 * 60 * 1000;
    assert(entryStillTrackedByEngineLiveness, "test construction sanity: 45s must stay well under the 4-minute engine-liveness axis");

    // Step 5 — issue another real GET, no write happened.
    const after = await req("/api/mlb/edge-feed");
    const namesAfter: string[] = (after.body.signals ?? []).map((s: any) => s.playerName);

    // Step 6 — confirm no longer visible.
    assert(!namesAfter.includes("READTIME_A_PLAYER_NAME"), `stale-odds carried signal must be invisible after the clock advance with no new write, got: ${JSON.stringify(namesAfter)}`);

    // Direct cache-level proof (not just the API's shaping) — the raw cache
    // read itself no longer contains the expired signal.
    const cacheEntry = mlbEdgeCache.get(gameId);
    const cacheIds = (cacheEntry?.allSignals ?? []).map((s) => s.id);
    assert(!cacheIds.includes("readtime_a_carried"), "mlbEdgeCache.get() itself must exclude the expired carried signal, not just the route's shaping");

    mlbEdgeCache.delete(gameId);
  });

  // ── Scenario B: max-carry-age expires read-time, isolated from axis A ──
  test("B. Carried signal whose total age crosses the 20-minute boundary becomes invisible via the read-time guard alone (entry-level engine-liveness axis independently still satisfied)", async () => {
    const gameId = "READTIME_GAME_B";
    registerGame({ gameId, homeTeam: "NYY", awayTeam: "BOS", startTime: new Date().toISOString() });
    const writeTime = Date.now();
    const carried = baseSignal({
      id: "readtime_b_carried",
      gameId,
      playerId: "READTIME_B_PLAYER",
      playerName: "READTIME_B_PLAYER_NAME",
      // Already 19 minutes old AT WRITE TIME — simulates a signal that has
      // survived many prior carry-forward cycles — but still under the
      // 20-minute write-time bound, so it legitimately survives this write.
      engineGeneratedAt: writeTime - 19 * 60 * 1000,
      oddsTimestamp: writeTime, // odds freshness is NOT the axis under test here
    });
    // A fresh sibling in the SAME entry/write, used below to prove the
    // entry itself is not dropped wholesale — only the expired signal.
    const freshSibling = baseSignal({ id: "readtime_b_fresh_sibling", gameId, playerId: "READTIME_B_SIBLING", playerName: "READTIME_B_SIBLING_NAME", market: "hits" });

    const revalidated = writeCarriedSignalToCache(gameId, carried, freshSibling);
    assertEq(revalidated.demoted, 0, "19-minute-old signal must still survive the write-time pass (under the 20-minute bound)");

    const before = await req("/api/mlb/edge-feed");
    const namesBefore: string[] = (before.body.signals ?? []).map((s: any) => s.playerName);
    assert(namesBefore.includes("READTIME_B_PLAYER_NAME"), "signal must be visible immediately after write");
    assert(namesBefore.includes("READTIME_B_SIBLING_NAME"), "fresh sibling must be visible immediately after write");

    // Advance the clock by only 2 more minutes: total signal age becomes
    // 21 minutes (past the 20-minute bound), while the ENTRY's updatedAt is
    // only 2 minutes old — the 4-minute engine-liveness axis independently
    // stays satisfied, isolating the max-carry-age guard as the sole cause.
    // NO further cache write happens.
    advanceClock(2 * 60 * 1000);
    const entryAgeMs = 2 * 60 * 1000;
    assert(entryAgeMs < 4 * 60 * 1000, "test construction sanity: entry must stay under the 4-minute engine-liveness axis");
    const totalSignalAgeMs = Date.now() - (writeTime - 19 * 60 * 1000);
    assert(totalSignalAgeMs > 20 * 60 * 1000, "test construction sanity: total signal age must exceed the 20-minute max-carry-age bound");

    const after = await req("/api/mlb/edge-feed");
    const namesAfter: string[] = (after.body.signals ?? []).map((s: any) => s.playerName);
    assert(!namesAfter.includes("READTIME_B_PLAYER_NAME"), `signal past the 20-minute total-age boundary must be invisible, got: ${JSON.stringify(namesAfter)}`);
    // Proves the ENTRY itself is still alive/fresh (axis A independently
    // satisfied) — the whole entry was not dropped, only the expired signal.
    assert(namesAfter.includes("READTIME_B_SIBLING_NAME"), "a fresh sibling signal in the same entry must remain visible — proves the entry-level axis did not drop the whole entry");

    mlbEdgeCache.delete(gameId);
  });

  // ── Scenario C: terminal game state expires read-time, no new write ────
  test("C. Carried signal for a game removed from the active registry becomes invisible with zero intervening cache writes", async () => {
    const gameId = "READTIME_GAME_C";
    registerGame({ gameId, homeTeam: "NYY", awayTeam: "BOS", startTime: new Date().toISOString() });
    assert(getGame(gameId) !== undefined, "test setup: game must be registered as active");

    const carried = baseSignal({
      id: "readtime_c_carried",
      gameId,
      playerId: "READTIME_C_PLAYER",
      playerName: "READTIME_C_PLAYER_NAME",
    });
    writeCarriedSignalToCache(gameId, carried, null);

    const before = await req("/api/mlb/edge-feed");
    const namesBefore: string[] = (before.body.signals ?? []).map((s: any) => s.playerName);
    assert(namesBefore.includes("READTIME_C_PLAYER_NAME"), "signal must be visible while the game is still active");

    // Simulate the game going final — exactly what the discovery sweep
    // calls (liveGameOrchestrator.ts) for a game no longer in the day's
    // active set. NO further cache write happens.
    removeGame(gameId);
    assert(getGame(gameId) === undefined, "test setup: game must now be absent from the active registry");

    const after = await req("/api/mlb/edge-feed");
    const namesAfter: string[] = (after.body.signals ?? []).map((s: any) => s.playerName);
    assert(!namesAfter.includes("READTIME_C_PLAYER_NAME"), `carried signal for a terminal/deregistered game must be invisible, got: ${JSON.stringify(namesAfter)}`);

    mlbEdgeCache.delete(gameId);
  });

  // ── Non-carried entries are completely unaffected (regression guard) ───
  test("D. A cache entry with no carriedSignalIds (e.g. an unregistered synthetic fixture game) is completely unaffected by the read-time guard", async () => {
    const gameId = "READTIME_GAME_D_UNREGISTERED";
    const fresh = baseSignal({ id: "readtime_d_fresh", gameId, playerId: "READTIME_D_PLAYER", playerName: "READTIME_D_PLAYER_NAME" });
    // Direct set — no carriedSignalIds field at all, matching the
    // established synthetic-fixture convention used elsewhere in this repo
    // (server/services/liveEdgeAccess.integration.test.ts), and this game
    // is NEVER registered via registerGame().
    mlbEdgeCache.set(gameId, {
      gameId, outputs: [], qualifiedSignals: [fresh], allSignals: [fresh],
      gameCardTags: [], updatedAt: Date.now(), createdAt: Date.now(),
    });
    advanceClock(5 * 60 * 1000); // well past both the 30s and 4-minute axes
    const { body } = await req("/api/mlb/edge-feed");
    const names: string[] = (body.signals ?? []).map((s: any) => s.playerName);
    // The entry-level engine-liveness axis (4 min) DOES still apply here —
    // this proves the NEW guard specifically doesn't fire an ADDITIONAL,
    // unregistered-game-shaped false positive; it's a no-op for entries
    // that never populate carriedSignalIds. (The 5-minute jump exercises
    // the pre-existing, unrelated axis-A path — expected to drop this
    // entry on its own, same as before this change.)
    assert(!names.includes("READTIME_D_PLAYER_NAME"), "sanity: axis A still drops a 5-minute-quiet entry, unrelated to this change");
    mlbEdgeCache.delete(gameId);
  });

  let pass = 0, fail = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try {
      await c.fn();
      pass++;
      console.log(`  ✓ ${c.name}`);
    } catch (e: any) {
      fail++;
      failures.push(`  ✗ ${c.name}\n      ${e.message}`);
      console.log(`  ✗ ${c.name}`);
      console.log(`      ${e.message}`);
    }
  }

  restoreRealClock();
  ["READTIME_GAME_A", "READTIME_GAME_B", "READTIME_GAME_C", "READTIME_GAME_D_UNREGISTERED"].forEach((g) => mlbEdgeCache.delete(g));
  ["READTIME_GAME_A", "READTIME_GAME_B", "READTIME_GAME_C"].forEach((g) => removeGame(g));
  await cleanupTestUsers();
  httpServer.close();

  console.log(`\n[Carry-Forward Read-Time Expiration Integration] ${pass}/${pass + fail} cases passed`);
  if (fail > 0) {
    console.error(`\nFAILURES:\n${failures.join("\n")}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  restoreRealClock();
  console.error("[integration] fatal error:", e);
  process.exit(1);
});
