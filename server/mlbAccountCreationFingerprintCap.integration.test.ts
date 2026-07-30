/**
 * Account-creation fingerprint cap — REAL end-to-end HTTP verification
 * (Final Pre-Push Integrity Pass, Section 7: "anonymous identity cannot be
 * trivially reset within intended constraints").
 *
 * Isolated into its own file/process (see
 * mlbAccountCreationEmailAbuseResistance.integration.test.ts's header for
 * why — the real /api/auth/register route sits behind a 5-per-hour-per-IP
 * signupLimiter, and this file needs its full budget for genuine
 * fingerprint-cap calls).
 *
 * Proves server/auth.ts's registration handler's THIRD real defense: an
 * IP+User-Agent fingerprint caps UNVERIFIED signups at 3 — a 4th
 * registration attempt from the same fingerprint is rejected BEFORE a row
 * is even created, regardless of how many distinct, non-disposable emails
 * it uses. This directly answers "can a client trivially mint fresh
 * accounts to reset their preview budget?" — no, not from the same device,
 * beyond 3 unverified accounts.
 *
 * Makes exactly 5 registration calls total (4 for the capped fingerprint,
 * 1 for an isolated different fingerprint) — at the 5/hour-per-IP budget.
 *
 * REQUIREMENTS TO RUN
 *   - A reachable Postgres instance with `drizzle-kit push` already applied.
 *
 *   DATABASE_URL=postgresql://user:pass@host:port/db \
 *     npx tsx server/mlbAccountCreationFingerprintCap.integration.test.ts
 *
 * Exits non-zero on any assertion failure.
 */

import express from "express";
import session from "express-session";
import { createServer } from "http";
import { like, or } from "drizzle-orm";
import { db } from "./db";
import { users } from "@shared/schema";
import { registerRoutes } from "./routes";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to run this integration harness (see file header).");
  process.exit(1);
}

const EMAIL_PREFIX = "mlb-fp-cap-verify-";

async function cleanupTestUsers() {
  await db.delete(users).where(or(like(users.email, `${EMAIL_PREFIX}%`), like(users.normalizedEmail, `${EMAIL_PREFIX}%`)));
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
  app.use(session({ secret: "integration-test-secret", resave: false, saveUninitialized: false }));
  app.use(express.json());
  const httpServer = createServer(app);

  await registerRoutes(httpServer, app);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[integration] test server listening on ${base}`);

  await cleanupTestUsers();

  async function register(email: string, userAgent: string) {
    const res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": userAgent },
      body: JSON.stringify({ email, password: "TestPassword123!" }),
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* ignore */ }
    return { status: res.status, body };
  }

  test("1-4. IP+User-Agent fingerprint caps UNVERIFIED signups at 3 from the same device — the 4th is genuinely blocked", async () => {
    const sharedUserAgent = `shared-fingerprint-test-agent-${Date.now()}/1.0`;
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await register(`${EMAIL_PREFIX}fp${Date.now()}_${i}@example.com`, sharedUserAgent));
    }
    const succeeded = results.filter((r) => r.status === 201).length;
    assertEq(succeeded, 3, `exactly 3 of 4 registration attempts from the SAME device fingerprint (same IP+UA) succeed — the 4th is blocked regardless of using a completely distinct, non-disposable email (got ${succeeded}, statuses: ${results.map((r) => r.status).join(",")})`);
    assertEq(results[3].status, 403, "the 4th attempt from the same fingerprint is rejected with 403, not silently allowed or merely rate-limited (429 would mean a different, coincidental defense caught it instead)");
    assert(/too many accounts/i.test(String(results[3].body?.error ?? "")), `the rejection reason names the real cause — device fingerprint cap, not a generic error (got: ${JSON.stringify(results[3].body)})`);
  });

  test("5. A DIFFERENT device fingerprint is NOT affected by another device's exhausted cap", async () => {
    // Same IP as every call above (all from this test process/localhost),
    // but a genuinely DIFFERENT User-Agent -> a different fingerprint.
    const differentDevice = await register(`${EMAIL_PREFIX}different-device-${Date.now()}@example.com`, `isolated-fingerprint-test-agent-${Date.now()}/2.0`);
    assertEq(differentDevice.status, 201, "a genuinely different device fingerprint (different User-Agent, same IP) is completely unaffected by another fingerprint's exhausted 3-account cap — proving the cap is keyed on the real fingerprint, not just the IP alone");
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

  console.log(`\n[MLB Account Creation Fingerprint Cap Integration] ${pass}/${pass + fail} cases passed`);
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
