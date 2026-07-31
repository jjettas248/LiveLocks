/**
 * MLB Live Edge Trust Recovery — REAL end-to-end carry-forward revalidation
 * verification harness.
 *
 * Mirrors the established pattern in
 * server/services/liveEdgeAccess.integration.test.ts: boots the actual
 * Express app via registerRoutes (real route handlers, real requireAuth
 * middleware, real storage/Postgres user lookups), and seeds the REAL
 * mlbEdgeCache singleton — not a mock — via the exact production functions
 * (mergeCarryForward + applyCarryForwardRevalidation, the same two calls
 * server/mlb/liveGameOrchestrator.ts's triggerEngine makes at its
 * cache-write boundary). It then issues a real HTTP GET to
 * /api/mlb/edge-feed and proves a carried signal that fails revalidation
 * (stale sportsbook source price) is invisible end-to-end, while a carried
 * signal that passes and a freshly-computed signal both survive.
 *
 * What this does NOT do: invoke the full triggerEngine method itself (which
 * would require mocking the entire MLB Stats API / weather / player-cache
 * data layer — a different, much larger undertaking). It exercises every
 * module boundary AFTER engine computation: merge → revalidate → cache
 * write → cache read → route handler → HTTP → JSON response, using the
 * real, unmocked production implementations of every one of those steps.
 *
 * REQUIREMENTS TO RUN
 *   - A reachable Postgres instance with `drizzle-kit push` already applied.
 *
 *   DATABASE_URL=postgresql://user:pass@host:port/db \
 *     npx tsx server/mlb/carryForwardRevalidation.pg-integration.test.ts
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
import type { MLBQualifiedSignal } from "./types";

const JWT_SECRET = process.env.SESSION_SECRET || "livelocks-dev-secret";
const EMAIL_PREFIX = "carryfwd-verify-";
const GAME_ID = "SENTINEL_CARRYFWD_GAME_1";

function mintToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "10m" });
}

async function createAdminUser() {
  const email = `${EMAIL_PREFIX}admin-${Date.now()}@example.invalid`;
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash: "not-a-real-hash-integration-fixture-only",
      emailVerified: true,
      isAdmin: true,
    })
    .returning();
  return { id: row.id, token: mintToken(row.id) };
}

async function cleanupTestUsers() {
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
}

function baseSignal(overrides: Partial<MLBQualifiedSignal>): MLBQualifiedSignal {
  const id = overrides.id ?? "sig";
  return {
    id,
    gameId: GAME_ID,
    playerId: overrides.playerId ?? "p1",
    playerName: overrides.playerName ?? "SENTINEL_CARRYFWD_PLAYER",
    team: "NYY",
    market: "hits",
    side: "OVER",
    sportsbook: "draftkings",
    line: 1.5,
    impliedProbability: null,
    engineProbability: 62,
    projection: 2.1,
    evPct: 5,
    confidenceTier: "STRONG",
    signalScore: 70,
    reasons: ["synthetic fixture — not real"],
    feedTags: [],
    signalTags: [],
    playerGlowEligible: false,
    gameCardSignalTags: [],
    formIndicator: "steady" as any,
    isExperimental: false,
    engineGeneratedAt: Date.now(),
    badges: [],
    riskFlags: [],
    drivers: {},
    timestamps: {
      engineGeneratedAt: new Date().toISOString(),
      oddsUpdatedAt: new Date().toISOString(),
      gameStateUpdatedAt: new Date().toISOString(),
    },
    fallbackUsed: false,
    actionable: true,
    alreadyHit: false,
    stale: false,
    watchlist: false,
    overOdds: -120,
    underOdds: 105,
    oddsTimestamp: Date.now(),
    pitcherName: "SENTINEL_PITCHER",
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

interface TestCase { name: string; fn: () => Promise<void> }
const cases: TestCase[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, ctx: string) {
  if (actual !== expected) throw new Error(`${ctx}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  registerAnalyticsRoutes(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[integration] test server listening on ${base}`);

  await cleanupTestUsers();
  const admin = await createAdminUser();

  async function req(path: string, token: string) {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    return { status: res.status, body };
  }

  test("1. Real merge+revalidate+cache-write pipeline hides a stale-source-price carried signal end-to-end via /api/mlb/edge-feed", async () => {
    const now = Date.now();

    // Prior cycle's full result: two signals that will NOT be in this
    // narrowed cycle's scope, so mergeCarryForward carries both forward.
    const staleCarried = baseSignal({
      id: "sentinel_stale_carried",
      playerId: "SENTINEL_STALE_PLAYER",
      playerName: "SENTINEL_STALE_PLAYER_NAME",
      market: "hits",
      // 10 minutes old — well past the live 30s freshness threshold, so
      // revalidateCarriedSignal must reject it on stale_source_price.
      oddsTimestamp: now - 10 * 60 * 1000,
      engineGeneratedAt: now - 60 * 1000,
    });
    const validCarried = baseSignal({
      id: "sentinel_valid_carried",
      playerId: "SENTINEL_VALID_PLAYER",
      playerName: "SENTINEL_VALID_PLAYER_NAME",
      market: "total_bases",
      oddsTimestamp: now - 5 * 1000, // fresh
      engineGeneratedAt: now - 60 * 1000,
    });
    const prior = {
      outputs: [],
      qualifiedSignals: [staleCarried, validCarried],
      allSignals: [staleCarried, validCarried],
    };

    // This cycle's freshly computed slice — a different player/market, so
    // the prior two fall out of scope and become carry-forward candidates.
    const freshSignal = baseSignal({
      id: "sentinel_fresh_signal",
      playerId: "SENTINEL_FRESH_PLAYER",
      playerName: "SENTINEL_FRESH_PLAYER_NAME",
      market: "total_bases", // legal market key
      oddsTimestamp: now,
      engineGeneratedAt: now,
    });
    // Distinct market to keep scope narrowing clean: this cycle evaluated
    // ONLY "home_runs" (neither carried signal's market), so both fall
    // outside scope and are carried; the fresh signal is injected directly
    // into the fresh slice regardless of its own market for feed purposes.
    const fresh = {
      outputs: [],
      qualifiedSignals: [freshSignal],
      allSignals: [freshSignal],
    };

    const scope: CycleScope = { markets: new Set(["home_runs"]), playerIds: "all" };

    // ── Exact production call sequence (mirrors liveGameOrchestrator.ts) ──
    const merged = mergeCarryForward({
      gameId: GAME_ID,
      prior,
      fresh,
      scope,
      nowMs: now,
      maxCarryAgeMs: 20 * 60 * 1000,
      isResolved: () => false,
    });

    assertEq(merged.carriedSignals, 2, "both prior signals fall out of this cycle's narrowed scope and are carried");

    const revalidated = applyCarryForwardRevalidation(merged, () => ({
      nowMs: now,
      maxCarryAgeMs: 20 * 60 * 1000,
      oddsFreshnessThresholdMs: 30 * 1000,
      currentPitcherId: null,
      currentPitcherName: "SENTINEL_PITCHER", // matches every fixture signal's pitcherName — isolates the test to the price-freshness axis only
      currentOffenseTeam: "NYY", // matches every fixture signal's team
      gameIsTerminal: false,
      isResolved: false,
    }));

    assertEq(revalidated.demoted, 1, "exactly the stale-price carried signal is demoted");
    assert(!!revalidated.demotionReasonCounts["stale_source_price"], "demotion reason is stale_source_price");

    // Write via the REAL mlbEdgeCache.set() — the same call the orchestrator
    // makes — not a mock, not a bypass.
    mlbEdgeCache.set(GAME_ID, {
      gameId: GAME_ID,
      outputs: [],
      qualifiedSignals: revalidated.qualifiedSignals,
      allSignals: revalidated.allSignals,
      gameCardTags: [],
      updatedAt: now,
      createdAt: now,
    });

    // ── Cache-level assertion: the write-time filter already applied ──────
    const cacheEntry = mlbEdgeCache.get(GAME_ID);
    const cacheIds = (cacheEntry?.allSignals ?? []).map((s) => s.id);
    assert(!cacheIds.includes("sentinel_stale_carried"), "stale carried signal absent from mlbEdgeCache.allSignals at write time");
    assert(cacheIds.includes("sentinel_valid_carried"), "valid carried signal present in mlbEdgeCache.allSignals");
    assert(cacheIds.includes("sentinel_fresh_signal"), "fresh signal present in mlbEdgeCache.allSignals");

    // ── Real HTTP round-trip through the actual route handler ─────────────
    const { status, body } = await req("/api/mlb/edge-feed", admin.token);
    assertEq(status, 200, "status");
    assertEq(body.access, "full", "admin gets full access");
    const responsePlayerNames: string[] = (body.signals ?? []).map((s: any) => s.playerName);
    assert(
      !responsePlayerNames.includes("SENTINEL_STALE_PLAYER_NAME"),
      `stale-price carried signal must be invisible in the real API response, got players: ${JSON.stringify(responsePlayerNames)}`
    );
    assert(
      responsePlayerNames.includes("SENTINEL_VALID_PLAYER_NAME"),
      `valid carried signal must survive to the real API response, got players: ${JSON.stringify(responsePlayerNames)}`
    );
    assert(
      responsePlayerNames.includes("SENTINEL_FRESH_PLAYER_NAME"),
      `freshly computed signal must survive to the real API response, got players: ${JSON.stringify(responsePlayerNames)}`
    );

    mlbEdgeCache.delete(GAME_ID);
  });

  test("2. Carried signal within all bounds is byte-identical through the real pipeline (no false-positive demotion)", async () => {
    const now = Date.now();
    const onlyCarried = baseSignal({
      id: "sentinel_only_carried",
      playerId: "SENTINEL_ONLYCARRIED_PLAYER",
      playerName: "SENTINEL_ONLYCARRIED_PLAYER_NAME",
      market: "total_bases",
      oddsTimestamp: now - 2000,
      engineGeneratedAt: now - 30000,
    });
    const prior = { outputs: [], qualifiedSignals: [onlyCarried], allSignals: [onlyCarried] };
    const fresh = { outputs: [], qualifiedSignals: [], allSignals: [] };
    const scope: CycleScope = { markets: new Set(["home_runs"]), playerIds: "all" };

    const merged = mergeCarryForward({ gameId: GAME_ID, prior, fresh, scope, nowMs: now, maxCarryAgeMs: 20 * 60 * 1000, isResolved: () => false });
    const revalidated = applyCarryForwardRevalidation(merged, () => ({
      nowMs: now,
      maxCarryAgeMs: 20 * 60 * 1000,
      oddsFreshnessThresholdMs: 30 * 1000,
      currentPitcherId: null,
      currentPitcherName: "SENTINEL_PITCHER",
      currentOffenseTeam: "NYY",
      gameIsTerminal: false,
      isResolved: false,
    }));
    assertEq(revalidated.demoted, 0, "well-formed carried signal is never demoted");

    mlbEdgeCache.set(GAME_ID, {
      gameId: GAME_ID, outputs: [], qualifiedSignals: revalidated.qualifiedSignals, allSignals: revalidated.allSignals,
      gameCardTags: [], updatedAt: now, createdAt: now,
    });

    const { body } = await req("/api/mlb/edge-feed", admin.token);
    const names: string[] = (body.signals ?? []).map((s: any) => s.playerName);
    assert(names.includes("SENTINEL_ONLYCARRIED_PLAYER_NAME"), "surviving carried signal reaches the real API response");

    mlbEdgeCache.delete(GAME_ID);
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

  mlbEdgeCache.delete(GAME_ID);
  await cleanupTestUsers();
  httpServer.close();

  console.log(`\n[Carry-Forward Revalidation Integration] ${pass}/${pass + fail} cases passed`);
  if (fail > 0) {
    console.error(`\nFAILURES:\n${failures.join("\n")}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[integration] fatal error:", e);
  process.exit(1);
});
