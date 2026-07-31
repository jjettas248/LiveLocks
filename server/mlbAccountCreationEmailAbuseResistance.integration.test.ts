/**
 * Account-creation email-abuse resistance — REAL end-to-end HTTP
 * verification (Final Pre-Push Integrity Pass, Section 7: "anonymous
 * identity cannot be trivially reset within intended constraints").
 *
 * requireMLBAccess's free-preview budget (2/day) is scoped to an
 * AUTHENTICATED userId — the real "reset" risk is one layer up, at ACCOUNT
 * CREATION: could a client trivially mint a fresh userId (and therefore a
 * fresh 2/day budget)? This file proves two of the real, already-shipped
 * email-side defenses in server/auth.ts's registration handler:
 *
 *   1. Disposable/throwaway email domains are rejected outright.
 *   2. Gmail's dot/plus aliasing (user.name+tag@gmail.com ==
 *      username@gmail.com) is normalized so those don't register as
 *      "different" accounts — while non-Gmail addresses are NOT
 *      over-normalized.
 *   3. Registration responses never leak internal fields.
 *
 * The THIRD defense — an IP+User-Agent fingerprint capping unverified
 * signups at 3 — is deliberately verified in a SEPARATE file
 * (mlbAccountCreationFingerprintCap.integration.test.ts), not here: the
 * real /api/auth/register route sits behind its own signupLimiter
 * (express-rate-limit, 5 requests/hour per IP — see server/auth.ts). Since
 * every request in a single test-process run shares one "IP" as far as
 * that limiter is concerned, ALL registration calls in a given file must
 * stay within 5 total or later calls get a 429 (rate-limited) instead of
 * exercising the actual logic under test. Splitting into two files, each
 * its own fresh process (a fresh in-memory rate-limiter), respects that
 * REAL limiter rather than working around or disabling it — the limiter
 * itself is a legitimate part of "anonymous identity cannot be trivially
 * reset" and this suite intentionally exercises it as-is.
 *
 * This file makes exactly 4 registration calls (well within the 5/hour cap).
 *
 * REQUIREMENTS TO RUN
 *   - A reachable Postgres instance with `drizzle-kit push` already applied.
 *
 *   DATABASE_URL=postgresql://user:pass@host:port/db \
 *     npx tsx server/mlbAccountCreationEmailAbuseResistance.integration.test.ts
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

const EMAIL_PREFIX = "mlb-email-abuse-verify-";
// A wildcard on a fixed substring, tolerant of a stray dot landing anywhere
// (test 3 deliberately constructs dotted email variants) — narrower LIKE
// patterns anchored to EMAIL_PREFIX itself would miss a row whose dot
// happened to land inside the prefix text, orphaning it across runs (and,
// since the account-creation fingerprint cap is DB-persisted, silently
// corrupting a LATER run's fingerprint-cap arithmetic).
const CLEANUP_WILDCARD = "%buse-verify%";

async function cleanupTestUsers() {
  await db.delete(users).where(or(like(users.email, CLEANUP_WILDCARD), like(users.normalizedEmail, CLEANUP_WILDCARD)));
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
  // /api/auth/register writes req.session.userId directly (server/auth.ts) —
  // needs real session middleware present. The default in-memory
  // MemoryStore is fine for this short-lived test process.
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

  async function register(email: string, opts: { userAgent?: string } = {}) {
    const res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": opts.userAgent ?? "integration-test-agent/1.0",
      },
      body: JSON.stringify({ email, password: "TestPassword123!" }),
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* ignore */ }
    return { status: res.status, body };
  }

  test("1. Disposable email domains are rejected outright", async () => {
    const { status, body } = await register(`${EMAIL_PREFIX}disposable-${Date.now()}@mailinator.com`);
    assertEq(status, 400, "a known disposable-email domain is rejected with 400");
    assert(/disposable/i.test(String(body?.error ?? "")), `the rejection reason mentions disposable emails (got: ${JSON.stringify(body)})`);
    const json = JSON.stringify(body ?? {});
    assert(!/passwordHash/i.test(json), "even a rejection response never includes passwordHash");
  });

  test("2. Gmail dot+plus aliasing normalizes to the SAME account identity, and the response is sanitized", async () => {
    const unique = `${EMAIL_PREFIX}gmailnorm${Date.now()}`;
    const canonical = await register(`${unique}@gmail.com`);
    assertEq(canonical.status, 201, "the canonical-form registration succeeds");
    const json = JSON.stringify(canonical.body ?? {});
    assert(!/passwordHash/i.test(json), "a successful registration response never includes passwordHash");
    assert(!/emailVerificationToken/i.test(json), "a successful registration response never leaks the raw email-verification token");
    assert(!/signupFingerprint/i.test(json), "a successful registration response never leaks the internal device fingerprint");

    // A dot-and-plus-mangled variant of the SAME local part — Gmail treats
    // these as the identical mailbox, and normalizeEmail() must too.
    const mangled = `${unique.split("").join(".")}+some-tag@gmail.com`;
    const duplicate = await register(mangled);
    assertEq(duplicate.status, 400, `a dotted+plus-tagged variant of an already-registered Gmail address is rejected as a duplicate account, never treated as new (got ${duplicate.status}: ${JSON.stringify(duplicate.body)})`);
  });

  test("3. Gmail normalization is domain-scoped — a non-Gmail address is NOT altered", async () => {
    const unique = `${EMAIL_PREFIX}nongmail${Date.now()}`;
    const first = await register(`${unique}@example.com`);
    assertEq(first.status, 201, "a plain non-Gmail address registers normally");

    // A DIFFERENT non-Gmail address that happens to contain a dot is a
    // genuinely different account — normalization must not over-apply
    // outside gmail.com/googlemail.com. Appended (never spliced into the
    // middle of EMAIL_PREFIX itself) so a dot never lands inside the
    // literal substring cleanupTestUsers()'s LIKE pattern matches on.
    const different = await register(`${unique}.dotted@example.com`);
    assertEq(different.status, 201, "a different (non-aliased) non-Gmail address registers as a genuinely separate account — dot-stripping is Gmail-specific, not applied universally");
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

  console.log(`\n[MLB Account Creation Email Abuse Resistance Integration] ${pass}/${pass + fail} cases passed`);
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
