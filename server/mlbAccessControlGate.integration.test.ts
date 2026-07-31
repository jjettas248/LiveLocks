/**
 * MLB access-control gate — REAL end-to-end HTTP verification harness.
 *
 * Mirrors server/services/liveEdgeAccess.integration.test.ts's convention:
 * boots the actual Express app (real requireMLBAccess middleware, real
 * route handlers via registerRoutes, real storage round-tripping through
 * Postgres) and issues real HTTP requests. Exists specifically to prove the
 * fixes in server/utils/mlbPreviewAccess.ts behave correctly through the
 * real stack — a unit test on the extracted pure functions alone (see
 * mlbPreviewAccess.test.ts) cannot prove the full requireMLBAccess wiring
 * does the right thing for admins, subscribers, and the free-preview
 * budget together, or that Postgres itself serializes concurrent requests
 * correctly.
 *
 * Regression #1 (fixed prior to Correction 5): requireMLBAccess previously
 * returned a raw 400 ("Missing gameId for MLB preview access") for any
 * gated route with no gameId in req.params/req.body.
 *
 * Regression #2 (Correction 5, THIS pass): the fix for #1 fell back to one
 * single flat "mlb-general" key shared by EVERY gameId-less route. Visiting
 * any ONE of them (e.g. /api/mlb/alerts) silently unlocked every OTHER
 * gameId-less route (including /api/mlb/props — an arbitrary player/market/
 * line lookup tool with no gameId requirement at all) for the rest of the
 * day, with zero further budget consumed. This suite proves: (1) that bug
 * is gone — different gameId-less routes/resources consume independent
 * budget slots; (2) raw odds/calculation routes are denied the free-preview
 * fallback entirely, not merely rate-limited; (3) the global 2/day cap
 * still holds regardless of how many distinct keys are attempted;
 * (4) admins/paid MLB subscribers are completely unaffected; (5) concurrent
 * requests cannot exceed the daily cap (real HTTP-level race, not just a
 * unit-level argument about the underlying SQL).
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

  async function req(path: string, token?: string, opts: { method?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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

  test("4. [Correction 5] A DIFFERENT gameId-less route does NOT share the same budget slot", async () => {
    const free = await createTestUser("free-no-shared-budget", { subscriptionTier: null });
    const first = await req("/api/mlb/pregame-power-radar", free.token); // consumes credit 1/2
    assertEq(first.status, 200, "first gameId-less route succeeds");
    const second = await req("/api/mlb/alerts", free.token); // a DIFFERENT route -> must consume its OWN slot, not reuse the first's
    assertEq(second.status, 200, "a second, different gameId-less route also succeeds (it consumes credit 2/2, not a free ride)");
    // With exactly 2 total credits now spent on 2 DIFFERENT routes, a THIRD distinct gameId-less route must be rejected.
    const third = await req("/api/mlb/hr-radar", free.token);
    assertEq(third.status, 402, "a THIRD distinct gameId-less route is correctly rejected — proves the first two each consumed their own real credit instead of sharing one");
    assertEq(third.body?.error, "MLB_UPGRADE_REQUIRED", "the rejection is the normal upgrade prompt");
    // And the ORIGINAL two routes remain freely re-viewable (already unlocked, not re-charged).
    const firstAgain = await req("/api/mlb/pregame-power-radar", free.token);
    assertEq(firstAgain.status, 200, "re-visiting the FIRST already-unlocked route still works after the budget is otherwise exhausted");
    const secondAgain = await req("/api/mlb/alerts", free.token);
    assertEq(secondAgain.status, 200, "re-visiting the SECOND already-unlocked route still works too");
  });

  test("5. Free-tier user — per-game keys and gameId-less keys draw from the SAME global daily cap", async () => {
    const free = await createTestUser("free-exhausts-limit", { subscriptionTier: null });
    const perGame1 = await req("/api/mlb/pregame-power-radar/GATE_TEST_GAME_1", free.token); // distinct key 1/2
    assertEq(perGame1.status, 200, "first distinct per-game key succeeds");
    const perGame2 = await req("/api/mlb/pregame-power-radar/GATE_TEST_GAME_2", free.token); // distinct key 2/2
    assertEq(perGame2.status, 200, "second distinct per-game key succeeds (limit now exhausted)");
    const bareAfterLimit = await req("/api/mlb/pregame-power-radar", free.token); // a 3rd distinct key (route-scoped, not shared with the per-game ones)
    assertEq(bareAfterLimit.status, 402, "a third distinct key is correctly rejected once the daily limit is spent, regardless of whether it's a per-game or per-route key");
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

  test("8. [Correction 5] Raw odds/calculation routes deny free-tier access entirely — not merely rate-limited", async () => {
    const free = await createTestUser("free-denylist", { subscriptionTier: null });
    const odds = await req("/api/mlb/odds?playerName=Aaron+Judge&statType=home_runs", free.token);
    assertEq(odds.status, 402, "GET /api/mlb/odds is denied for a free user even on their very FIRST request of the day (never consumes a preview credit)");
    assertEq(odds.body?.error, "MLB_UPGRADE_REQUIRED", "the denial uses the standard upgrade-required error code");

    const propsBody = { market: "hits", line: 1.5, playerName: "Test Player", team: "NYY", opponent: "BOS" };
    const props = await req("/api/mlb/props", free.token, { method: "POST", body: propsBody });
    assertEq(props.status, 402, "POST /api/mlb/props is denied for a free user regardless of body content");

    const calc = await req("/api/mlb/calculate", free.token, { method: "POST", body: propsBody });
    assertEq(calc.status, 402, "POST /api/mlb/calculate is denied identically");

    const manual = await req("/api/mlb/calculate-manual", free.token, { method: "POST", body: { market: "hits", bookLine: 1.5 } });
    assertEq(manual.status, 402, "POST /api/mlb/calculate-manual (arbitrary manual-input calculator) is denied identically");

    // Denial must NOT consume any of the user's real preview budget — confirm
    // the 2 real credits are still both available on an ordinary route.
    const first = await req("/api/mlb/pregame-power-radar", free.token);
    assertEq(first.status, 200, "the user's first REAL preview credit is still available after 4 denied attempts on raw-lookup routes");
    const second = await req("/api/mlb/alerts", free.token);
    assertEq(second.status, 200, "the user's second REAL preview credit is also still available — denylisted routes never silently spent it");
  });

  test("9. [Correction 5] Raw odds/calculation routes remain fully reachable for paid subscribers and admins", async () => {
    const elite = await createTestUser("elite-denylist", { subscriptionTier: "elite" });
    const eliteOdds = await req("/api/mlb/odds?playerName=Aaron+Judge&statType=home_runs", elite.token);
    assert(eliteOdds.status !== 402, `an elite subscriber must never be denied on a denylisted route (got ${eliteOdds.status})`);

    const admin = await createTestUser("admin-denylist", { isAdmin: true });
    const adminProps = await req("/api/mlb/props", admin.token, { method: "POST", body: { market: "hits", line: 1.5, playerName: "X", team: "NYY", opponent: "BOS" } });
    assert(adminProps.status !== 402, `an admin must never be denied on a denylisted route (got ${adminProps.status})`);
  });

  test("10. [Correction 5] A route with a real per-resource identity scopes independently per resource", async () => {
    const free = await createTestUser("free-player-history", { subscriptionTier: null });
    const playerA = await req("/api/mlb/player-history/PLAYER_AAA", free.token);
    assertEq(playerA.status, 200, "viewing player A's history succeeds (consumes credit 1/2)");
    const playerARepeat = await req("/api/mlb/player-history/PLAYER_AAA", free.token);
    assertEq(playerARepeat.status, 200, "re-viewing the SAME player is free (already unlocked)");
    const playerB = await req("/api/mlb/player-history/PLAYER_BBB", free.token);
    assertEq(playerB.status, 200, "a DIFFERENT player consumes a genuinely new credit (2/2) rather than riding on player A's unlock");
    const playerC = await req("/api/mlb/player-history/PLAYER_CCC", free.token);
    assertEq(playerC.status, 402, "a THIRD distinct player is correctly rejected once the daily limit (2) is spent");
  });

  test("11. [Correction 5] Concurrent requests cannot exceed the daily cap (real HTTP-level race)", async () => {
    const free = await createTestUser("free-concurrent", { subscriptionTier: null });
    // Fire 10 concurrent requests for 10 DISTINCT players simultaneously —
    // if consumption were not atomic, more than 2 could slip through the
    // check-then-act window before any commit landed.
    const N = 10;
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) => req(`/api/mlb/player-history/CONCURRENT_PLAYER_${i}`, free.token)),
    );
    const succeeded = responses.filter((r) => r.status === 200).length;
    const rejected = responses.filter((r) => r.status === 402).length;
    assertEq(succeeded, 2, `exactly 2 of ${N} concurrent requests for distinct resources succeed — never more, proving atomic consumption under real concurrency (got ${succeeded})`);
    assertEq(rejected, N - 2, `the remaining ${N - 2} concurrent requests are correctly rejected, not silently allowed through`);
  });

  test("12. [Final Pre-Push Integrity Pass, Section 7] Varying irrelevant query params can change WHICH key is spent, but can never grant MORE than the real 2/day cap", async () => {
    const free = await createTestUser("free-irrelevant-params", { subscriptionTier: null });
    // A gameId-less board route hit with 5 DIFFERENT irrelevant/incidental
    // query params (the kind a frontend might attach without the route
    // itself ever reading them: analytics/tracking/cache-busting values).
    // Honest, documented behavior: because requireMLBAccess folds req.query
    // WHOLESALE into the fingerprint for gameId-less routes, each of these
    // resolves to a DIFFERENT consume key — this is NOT "identity-precise"
    // for irrelevant params. The security property under test is narrower
    // and load-bearing: no matter how many distinct-looking keys a client
    // manufactures this way, the GLOBAL per-user daily counter still caps
    // real unlocks at exactly 2 (see storage.ts's tryConsumeGamePlayToday —
    // a single, atomically-incremented counter, independent of which key is
    // being unlocked).
    const variations = [
      "/api/mlb/pregame-power-radar?utm_source=newsletter",
      "/api/mlb/pregame-power-radar?utm_source=twitter",
      "/api/mlb/pregame-power-radar?_=1690000000000",
      "/api/mlb/pregame-power-radar?ref=push-notification",
      "/api/mlb/pregame-power-radar?session=abc123",
    ];
    const responses = [];
    for (const url of variations) {
      responses.push(await req(url, free.token));
    }
    const succeeded = responses.filter((r) => r.status === 200).length;
    const rejected = responses.filter((r) => r.status === 402).length;
    assertEq(succeeded, 2, `even though all 5 requests hit the SAME logical dashboard, only the first 2 distinct-looking (irrelevant-param-varied) keys succeed (got ${succeeded}) — the global cap is not inflated by query variation`);
    assertEq(rejected, 3, `the remaining 3 differently-fingerprinted-but-functionally-identical requests are correctly rejected once the real 2-credit budget is spent (got ${rejected})`);
    assertEq(responses[4].body?.error, "MLB_UPGRADE_REQUIRED", "the rejection is the normal upgrade prompt, not a crash or a silent pass-through");

    // The bare, param-less URL is a DIFFERENT key again (no query at all) —
    // proving this isn't "the 5 variations share a key but the bare URL is
    // separate"; every one of these 6 total requests is a distinct key, and
    // the cap holds across all of them combined.
    const bare = await req("/api/mlb/pregame-power-radar", free.token);
    assertEq(bare.status, 402, "a 6th variant (no query string at all) is ALSO rejected — confirms the cap is genuinely global across every key this route's irrelevant-param sensitivity can produce, not reset per new key shape");
  });

  test("13. [Final Pre-Push Integrity Pass, Section 7] Responses never leak sensitive/internal fields", async () => {
    const free = await createTestUser("free-sanitize", { subscriptionTier: null });
    const ok200 = await req("/api/mlb/pregame-power-radar", free.token);
    assertEq(ok200.status, 200, "sanity: the successful preview response is a real 200");
    const json200 = JSON.stringify(ok200.body ?? {});
    assert(!/passwordHash/i.test(json200), "a successful preview response never includes the word passwordHash");
    assert(!/stripeCustomerId|stripeSubscriptionId/i.test(json200), "a successful preview response never leaks Stripe identifiers");
    assert(!json200.includes(free.token), "a successful preview response never echoes back the caller's own auth token");

    const deniedExhausted = await req("/api/mlb/alerts", free.token); // consumes credit 2/2
    assertEq(deniedExhausted.status, 200, "sanity: second distinct route still succeeds (2/2)");
    const denied = await req("/api/mlb/hr-radar", free.token); // 3rd distinct key -> 402
    assertEq(denied.status, 402, "sanity: third distinct key is denied");
    const deniedKeys = Object.keys(denied.body ?? {});
    assert(deniedKeys.every((k) => ["error", "message", "playsUsedToday", "limit"].includes(k)), `a 402 rejection body exposes ONLY the documented fields (error/message/playsUsedToday/limit), never internal state (got keys: ${deniedKeys.join(", ")})`);
    assert(typeof denied.body?.playsUsedToday === "number" && typeof denied.body?.limit === "number", "the numeric fields on a 402 are genuinely numbers, not leaked raw DB rows/objects");

    const other = await createTestUser("free-sanitize-other", { subscriptionTier: null });
    const otherResp = await req("/api/mlb/alerts", other.token);
    assertEq(otherResp.status, 200, "a completely different user's independent request succeeds on their own fresh budget");
    const otherJson = JSON.stringify(otherResp.body ?? {});
    assert(!otherJson.includes(String(free.id)), "one user's response never contains another user's numeric userId");
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
