/**
 * MLB access-control gate — REAL end-to-end HTTP verification harness.
 *
 * Mirrors server/services/liveEdgeAccess.integration.test.ts's convention:
 * boots the actual Express app (real requireMLBAccess middleware, real
 * route handlers via registerRoutes, real storage round-tripping through
 * Postgres) and issues real HTTP requests. Exists specifically to prove the
 * fix in server/utils/mlbPreviewAccess.ts behaves correctly through the
 * real stack — a unit test on the extracted pure function alone (see
 * mlbPreviewAccess.test.ts) cannot prove the full requireMLBAccess wiring
 * does the right thing for admins, subscribers, and the free-preview
 * budget together.
 *
 * Regression under test: requireMLBAccess previously returned a raw 400
 * ("Missing gameId for MLB preview access") for any gated route with no
 * gameId in req.params/req.body — including the pre-existing bare
 * /api/mlb/pregame-power-radar route, not just the 12 newly-gated routes.
 * This proves: (1) that specific 400 is gone, (2) admins/paid MLB
 * subscribers are completely unaffected (bypass before reaching that code
 * at all), and (3) the fix does NOT accidentally grant unlimited free
 * access — a free user's shared "mlb-general" daily budget is still bounded
 * by the same MLB_PREVIEW_LIMIT as any real per-game key.
 *
 * REQUIREMENTS TO RUN
 *   - A reachable Postgres instance with `drizzle-kit push` already applied.
 *
 *   DATABASE_URL=postgresql://user:pass@host:port/db \
 *     npx tsx server/mlbAccessControlGate.integration.test.ts
 *
 * Exits non-zero on any assertion failure.
 */

import express from "express";
import { createServer } from "http";
import jwt from "jsonwebtoken";
import { like } from "drizzle-orm";
import { db } from "./db";
import { users } from "@shared/schema";
import { registerRoutes } from "./routes";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to run this integration harness (see file header).");
  process.exit(1);
}

const JWT_SECRET = process.env.SESSION_SECRET || "livelocks-dev-secret";
const EMAIL_PREFIX = "mlb-access-gate-verify-";

function mintToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "10m" });
}

async function createTestUser(label: string, overrides: { isAdmin?: boolean; subscriptionTier?: string | null }) {
  const email = `${EMAIL_PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.invalid`;
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

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[integration] test server listening on ${base}`);

  await cleanupTestUsers();

  async function req(path: string, token?: string) {
    const res = await fetch(`${base}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* non-JSON response, ignore body */ }
    return { status: res.status, body };
  }

  test("1. Unauthenticated — bare gameId-less route requires auth", async () => {
    const { status } = await req("/api/mlb/pregame-power-radar");
    assertEq(status, 401, "unauthenticated request status");
  });

  test("2. Free-tier user — bare /api/mlb/pregame-power-radar (no gameId) no longer 400s", async () => {
    const free = await createTestUser("free-bare-fix", { subscriptionTier: null });
    const { status, body } = await req("/api/mlb/pregame-power-radar", free.token);
    assert(status !== 400, `expected the pre-fix 400 to be gone, got ${status}: ${JSON.stringify(body)}`);
    assertEq(status, 200, "first free preview of a gameId-less route succeeds");
    assert(body?.error !== "Missing gameId for MLB preview access", "the specific regression error string must never appear again");
  });

  test("3. Same free-tier user — repeat hit to the SAME gameId-less route is a free re-view (already unlocked)", async () => {
    const free = await createTestUser("free-bare-repeat", { subscriptionTier: null });
    const first = await req("/api/mlb/pregame-power-radar", free.token);
    assertEq(first.status, 200, "first hit succeeds");
    const second = await req("/api/mlb/pregame-power-radar", free.token);
    assertEq(second.status, 200, "second hit to the same gameId-less route is still 200 (already unlocked, not re-consumed)");
  });

  test("4. Same free-tier user — a DIFFERENT gameId-less route shares the same 'mlb-general' budget", async () => {
    const free = await createTestUser("free-shared-budget", { subscriptionTier: null });
    const first = await req("/api/mlb/pregame-power-radar", free.token); // consumes 1 of 2 (key: mlb-general)
    assertEq(first.status, 200, "first gameId-less route succeeds");
    const second = await req("/api/mlb/alerts", free.token); // same mlb-general key — already unlocked
    assertEq(second.status, 200, "a second, different gameId-less route is also 200 under the same shared key");
  });

  test("5. Free-tier user — the fix does not grant unlimited access; the shared budget still runs out at the same limit", async () => {
    const free = await createTestUser("free-exhausts-limit", { subscriptionTier: null });
    const perGame1 = await req("/api/mlb/pregame-power-radar/GATE_TEST_GAME_1", free.token); // distinct key 1/2
    assertEq(perGame1.status, 200, "first distinct per-game key succeeds");
    const perGame2 = await req("/api/mlb/pregame-power-radar/GATE_TEST_GAME_2", free.token); // distinct key 2/2
    assertEq(perGame2.status, 200, "second distinct per-game key succeeds (limit now exhausted)");
    const bareAfterLimit = await req("/api/mlb/pregame-power-radar", free.token); // 3rd distinct key: mlb-general
    assertEq(bareAfterLimit.status, 402, "a third distinct key (the shared gameId-less bucket) is correctly rejected once the daily limit is spent");
    assertEq(bareAfterLimit.body?.error, "MLB_UPGRADE_REQUIRED", "the rejection is the normal upgrade prompt, not a crash");
  });

  test("6. Valid MLB subscriber (elite) — bypasses the preview gate entirely on both route shapes", async () => {
    const elite = await createTestUser("elite-subscriber", { subscriptionTier: "elite" });
    const bare = await req("/api/mlb/pregame-power-radar", elite.token);
    assertEq(bare.status, 200, "elite subscriber on a gameId-less route");
    const withGame = await req("/api/mlb/pregame-power-radar/GATE_TEST_GAME_3", elite.token);
    assertEq(withGame.status, 200, "elite subscriber on a per-game route");
  });

  test("7. Admin — bypasses the preview gate entirely on both route shapes", async () => {
    const admin = await createTestUser("admin", { isAdmin: true });
    const bare = await req("/api/mlb/pregame-power-radar", admin.token);
    assertEq(bare.status, 200, "admin on a gameId-less route");
    const withGame = await req("/api/mlb/pregame-power-radar/GATE_TEST_GAME_4", admin.token);
    assertEq(withGame.status, 200, "admin on a per-game route");
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

  await cleanupTestUsers();
  httpServer.close();

  console.log(`\n[MLB Access Control Gate Integration] ${pass}/${pass + fail} cases passed`);
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
