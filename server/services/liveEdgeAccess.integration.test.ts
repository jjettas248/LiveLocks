/**
 * Live Edge — REAL end-to-end HTTP verification harness.
 *
 * Unlike liveEdgeAccess.test.ts (which exercises the extracted response-
 * builder functions directly), this boots the actual Express app — real
 * requireAuth middleware, real route handlers registered via
 * registerRoutes/registerAnalyticsRoutes, real storage.getUserById round-
 * tripping through Postgres — and issues real HTTP requests to
 * /api/top-plays and /api/mlb/edge-feed. It exists specifically to answer:
 * "does the actual wiring behave the way the isolated unit tests say it
 * should," which a source-text/unit-only pass cannot prove.
 *
 * WHY THIS EXISTS / WHAT IT DOES NOT REPLACE
 * Live odds-provider polling is intentionally disabled in this environment
 * (see PR #117), so there is no way to populate a live game with real
 * market data and browse it as a real user. This harness instead seeds
 * deterministic SYNTHETIC fixture signals directly into mlbEdgeCache — the
 * same in-memory store the orchestrator legitimately writes to — via its
 * existing internal .set() API. It does NOT add a new route, a test-only
 * endpoint, or any production bypass: every request below goes through the
 * exact same registerRoutes()/registerAnalyticsRoutes() handlers and
 * requireAuth middleware a real browser request would. The synthetic
 * signals are clearly fake (SENTINEL_* names) and only ever exist in this
 * script's own local database + in-process cache — never written to, or
 * read from, any production data. This is a substitute for the live-data
 * browser check, not a replacement for eventually running one once odds
 * polling is re-enabled (see PR #117 test plan checklist).
 *
 * REQUIREMENTS TO RUN
 *   - A reachable Postgres instance (local is fine — this creates its own
 *     test users and cleans them up after).
 *   - `drizzle-kit push` already applied to that database.
 *
 *   DATABASE_URL=postgresql://user:pass@host:port/db \
 *   SESSION_SECRET=<any value, or omit to use the same dev fallback auth.ts uses> \
 *     npx tsx server/services/liveEdgeAccess.integration.test.ts
 *
 * Exits non-zero on any assertion failure.
 */

import express from "express";
import { createServer } from "http";
import jwt from "jsonwebtoken";
import { like } from "drizzle-orm";
import { db } from "../db";
import { users } from "@shared/schema";
import { storage } from "../storage";
import { registerRoutes, registerAnalyticsRoutes } from "../routes";
import { mlbEdgeCache } from "../mlb/edgeCache";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to run this integration harness (see file header).");
  process.exit(1);
}

const JWT_SECRET = process.env.SESSION_SECRET || "livelocks-dev-secret";
const EMAIL_PREFIX = "liveedge-verify-";
const SENTINEL_GAME_ID = "SENTINEL_GAME_9001";

function mintToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "10m" });
}

async function createTestUser(label: string, overrides: { isAdmin?: boolean; subscriptionTier?: string | null }) {
  const email = `${EMAIL_PREFIX}${label}-${Date.now()}@example.invalid`;
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash: "not-a-real-hash-integration-fixture-only",
      emailVerified: true,
      isAdmin: overrides.isAdmin ?? false,
      subscriptionTier: overrides.subscriptionTier ?? null,
    })
    .returning();
  return { id: row.id, token: mintToken(row.id) };
}

async function cleanupTestUsers() {
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
}

// Two synthetic, clearly-fake qualifying signals — never real production
// data, only ever written to this script's own local mlbEdgeCache instance.
function seedFixtureSignals() {
  const now = Date.now();
  const qualifiedSignals = [
    {
      id: "sentinel_sig_1",
      gameId: SENTINEL_GAME_ID,
      playerId: "SENTINEL_PLAYER_1",
      playerName: "SENTINEL_PLAYER_NAME_ONE",
      team: "SENTINEL_TEAM",
      market: "home_runs",
      side: "OVER",
      sportsbook: "synthetic",
      line: 0.5,
      impliedProbability: 40,
      engineProbability: 78.4,
      projection: 1.1,
      evPct: 12.3,
      confidenceTier: "ELITE",
      signalTier: "elite",
      signalScore: 82,
      reasons: ["synthetic fixture — not real"],
      feedTags: [],
      signalTags: [],
      playerGlowEligible: false,
      gameCardSignalTags: [],
      recommendedSide: "OVER",
      timingContext: "Inning 3",
      thesis: "SENTINEL_THESIS_TEXT",
      updatedAt: new Date(now).toISOString(),
    },
    {
      id: "sentinel_sig_2",
      gameId: SENTINEL_GAME_ID,
      playerId: "SENTINEL_PLAYER_2",
      playerName: "SENTINEL_PLAYER_NAME_TWO",
      team: "SENTINEL_TEAM",
      market: "hits",
      side: "OVER",
      sportsbook: "synthetic",
      line: 1.5,
      impliedProbability: 45,
      engineProbability: 63.1,
      projection: 1.8,
      evPct: 5.1,
      confidenceTier: "STRONG",
      signalTier: "strong",
      signalScore: 61,
      reasons: ["synthetic fixture — not real"],
      feedTags: [],
      signalTags: [],
      playerGlowEligible: false,
      gameCardSignalTags: [],
      recommendedSide: "OVER",
      timingContext: "Pre-game",
      thesis: "SENTINEL_THESIS_TEXT_TWO",
      updatedAt: new Date(now).toISOString(),
    },
  ];
  mlbEdgeCache.set(SENTINEL_GAME_ID, {
    gameId: SENTINEL_GAME_ID,
    outputs: [],
    qualifiedSignals: qualifiedSignals as any,
    allSignals: qualifiedSignals as any,
    gameCardTags: [],
    updatedAt: now,
    createdAt: now,
  });
}

function clearFixtureSignals() {
  mlbEdgeCache.delete(SENTINEL_GAME_ID);
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

  // Real route registration — the exact same functions server/index.ts
  // calls at boot. No cron/orchestrator/roster-sync/Stripe-init is started
  // (those are separate calls in index.ts's boot IIFE, not inside
  // registerRoutes itself), so this stays a pure route-handler harness.
  await registerRoutes(httpServer, app);
  registerAnalyticsRoutes(app);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  console.log(`[integration] test server listening on ${base}`);

  await cleanupTestUsers(); // in case a previous crashed run left rows behind
  const admin = await createTestUser("admin", { isAdmin: true });
  const paidAll = await createTestUser("pro-all", { subscriptionTier: "all" });
  const paidElite = await createTestUser("elite", { subscriptionTier: "elite" });
  const free = await createTestUser("free", { subscriptionTier: null });
  const expired = await createTestUser("expired", { subscriptionTier: null }); // mirrors revocation-by-nulling

  async function req(path: string, token?: string, extraHeaders?: Record<string, string>) {
    const res = await fetch(`${base}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extraHeaders ?? {}) },
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  const PROHIBITED_STRINGS = [
    "SENTINEL_PLAYER_NAME_ONE", "SENTINEL_PLAYER_NAME_TWO", "SENTINEL_PLAYER_1", "SENTINEL_PLAYER_2",
    "SENTINEL_TEAM", SENTINEL_GAME_ID, "SENTINEL_THESIS_TEXT",
  ];
  function assertNoProhibitedData(body: unknown, ctx: string) {
    const json = JSON.stringify(body);
    for (const s of PROHIBITED_STRINGS) {
      if (json.includes(s)) throw new Error(`${ctx}: response leaked prohibited fixture data "${s}": ${json}`);
    }
  }

  // ── Populated-feed states (fixture signals present) ──────────────────────
  test("1. Admin — /api/top-plays full, real MLB fixture signals present", async () => {
    seedFixtureSignals();
    const { status, body } = await req("/api/top-plays", admin.token);
    assertEq(status, 200, "status");
    assertEq(body.access, "full", "access");
    assert(Array.isArray(body.plays), "plays is an array");
    assert(body.plays.some((p: any) => p.playerOrTeam === "SENTINEL_PLAYER_NAME_ONE"), "admin sees the real fixture player");
    clearFixtureSignals();
  });

  test("1b. Admin — /api/mlb/edge-feed full, real MLB fixture signals present", async () => {
    seedFixtureSignals();
    const { status, body } = await req("/api/mlb/edge-feed", admin.token);
    assertEq(status, 200, "status");
    assertEq(body.access, "full", "access");
    assert(Array.isArray(body.signals) && body.signals.length === 2, "admin sees both real fixture signals");
    clearFixtureSignals();
  });

  test("2. Paid dashboard (Pro/all) — /api/top-plays full", async () => {
    seedFixtureSignals();
    const { status, body } = await req("/api/top-plays", paidAll.token);
    assertEq(status, 200, "status");
    assertEq(body.access, "full", "access");
    assert(body.plays.some((p: any) => p.playerOrTeam === "SENTINEL_PLAYER_NAME_ONE"), "Pro sees full cross-sport data");
    clearFixtureSignals();
  });

  test("3. Elite MLB — /api/mlb/edge-feed full", async () => {
    seedFixtureSignals();
    const { status, body } = await req("/api/mlb/edge-feed", paidElite.token);
    assertEq(status, 200, "status");
    assertEq(body.access, "full", "access");
    assert(body.signals.length === 2, "elite sees full MLB feed");
    clearFixtureSignals();
  });

  test("4. Pro MLB preview — /api/mlb/edge-feed preview, exact minimal shape, no leaked data", async () => {
    seedFixtureSignals();
    const { status, body } = await req("/api/mlb/edge-feed", paidAll.token);
    assertEq(status, 200, "status");
    assertEq(body.access, "preview", "Pro (all-tier) gets preview on the MLB-specific surface");
    assertEq(Object.keys(body).sort().join(","), "access,preview", "exact top-level keys");
    assertEq(Object.keys(body.preview).sort().join(","), "activeCount,cards,sports,updatedAt", "exact preview keys");
    assertEq(body.preview.activeCount, 2, "honest activeCount despite preview");
    assertNoProhibitedData(body, "Pro MLB preview");
    clearFixtureSignals();
  });

  test("4b. Pro dashboard cross-check — same user gets FULL on /api/top-plays (scope-specific, not a blanket downgrade)", async () => {
    seedFixtureSignals();
    const { body } = await req("/api/top-plays", paidAll.token);
    assertEq(body.access, "full", "Pro still full on cross-sport dashboard");
    clearFixtureSignals();
  });

  test("5. Free preview — both endpoints preview, exact minimal shape, no leaked data", async () => {
    seedFixtureSignals();
    const topPlays = await req("/api/top-plays", free.token);
    assertEq(topPlays.body.access, "preview", "free top-plays access");
    assertEq(Object.keys(topPlays.body).sort().join(","), "access,preview", "free top-plays exact keys");
    assertNoProhibitedData(topPlays.body, "free /api/top-plays");

    const edgeFeed = await req("/api/mlb/edge-feed", free.token);
    assertEq(edgeFeed.body.access, "preview", "free edge-feed access");
    assertEq(Object.keys(edgeFeed.body).sort().join(","), "access,preview", "free edge-feed exact keys");
    assertNoProhibitedData(edgeFeed.body, "free /api/mlb/edge-feed");
    clearFixtureSignals();
  });

  test("5b. Expired/canceled (revoked tier) — same as free, both endpoints preview", async () => {
    seedFixtureSignals();
    const { body } = await req("/api/top-plays", expired.token);
    assertEq(body.access, "preview", "expired user gets preview");
    clearFixtureSignals();
  });

  test("6. Admin view-as switching — free/pro_mlb/all_sports headers, both endpoints", async () => {
    seedFixtureSignals();
    const asFree = await req("/api/top-plays", admin.token, { "X-LL-Admin-View-Mode": "free" });
    assertEq(asFree.body.access, "preview", "admin view-as-free → preview on top-plays");

    const asProMlbGlobal = await req("/api/top-plays", admin.token, { "X-LL-Admin-View-Mode": "pro_mlb" });
    assertEq(asProMlbGlobal.body.access, "preview", "admin view-as-pro_mlb → preview on top-plays (no hasUnlimited)");

    const asProMlbMlb = await req("/api/mlb/edge-feed", admin.token, { "X-LL-Admin-View-Mode": "pro_mlb" });
    assertEq(asProMlbMlb.body.access, "full", "admin view-as-pro_mlb → FULL on edge-feed (has simulated hasMLB) — the flagged scope-split case");

    const asAllSports = await req("/api/mlb/edge-feed", admin.token, { "X-LL-Admin-View-Mode": "all_sports" });
    assertEq(asAllSports.body.access, "full", "admin view-as-all_sports → full on edge-feed");

    // Non-admin spoof, through the real HTTP/middleware stack.
    const spoofAttempt = await req("/api/mlb/edge-feed", free.token, { "X-LL-Admin-View-Mode": "all_sports" });
    assertEq(spoofAttempt.body.access, "preview", "non-admin sending the view-mode header is ignored end-to-end");
    clearFixtureSignals();
  });

  // ── Empty-feed state (no fixture signals at all) ──────────────────────────
  test("7. Real empty-feed state — full-access admin, no active signals, honest empty shape", async () => {
    clearFixtureSignals(); // belt-and-suspenders — should already be clear
    const topPlays = await req("/api/top-plays", admin.token);
    assertEq(topPlays.body.access, "full", "empty feed is still access:full for an entitled user");
    assertEq(Array.isArray(topPlays.body.plays) ? topPlays.body.plays.length : -1, 0, "no fabricated plays when nothing qualifies");

    const edgeFeed = await req("/api/mlb/edge-feed", admin.token);
    assertEq(edgeFeed.body.access, "full", "empty feed access");
    assertEq(edgeFeed.body.mode, "monitoring", "honest monitoring mode, not live");
    assertEq(edgeFeed.body.signals.length, 0, "no fabricated signals");
  });

  test("7b. Real empty-feed state — free preview user, honest zero activeCount", async () => {
    clearFixtureSignals();
    const { body } = await req("/api/mlb/edge-feed", free.token);
    assertEq(body.access, "preview", "free access on empty feed");
    assertEq(body.preview.activeCount, 0, "honest zero, not fabricated cards");
    assertEq(body.preview.cards.length, 0, "no locked shells when nothing is active");
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

  clearFixtureSignals();
  await cleanupTestUsers();
  httpServer.close();

  console.log(`\n[Live Edge Integration] ${pass}/${pass + fail} cases passed`);
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
