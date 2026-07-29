/**
 * Lineup-released alerts (push + email channels) — validation harness.
 *
 * Plain Node.js script (no jest/vitest dependency), matching the existing
 * server/mlb/*.test.ts and server/services/liveEdgeAccess.test.ts convention.
 * Run with:
 *
 *   npx tsx server/mlb/lineupReleaseAlerts.test.ts
 *
 * Scope: what's genuinely testable without a live DB or network call —
 * the pure eligibility predicates, a source-text regression guard on the
 * two independent dedupe fingerprints, and the real no-op behavior of
 * sendLineupAlertEmail when RESEND_API_KEY is absent. A full DB-backed
 * exercise of fireLineupAlert/checkLineupReleaseAlerts end-to-end would need
 * either a live Postgres or new dependency injection this module has never
 * needed before — disproportionate for a notification feature.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isPushEligibleForLineupAlert, isEmailEligibleForLineupAlert } from "./lineupReleaseAlerts";
import { sendLineupAlertEmail } from "../email";

interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}

const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}
function assertEq<T>(actual: T, expected: T, ctx: string) {
  if (actual !== expected) {
    throw new Error(`${ctx}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Eligibility predicates — same recipient list, two independent gates
// ─────────────────────────────────────────────────────────────────────────

test("elite, verified, emailAlerts on, no push subscription → email-eligible, push-ineligible", () => {
  const u = { subscriptionTier: "elite", isAdmin: false, pushSubscription: null, emailVerified: true, emailAlerts: true };
  assertEq(isPushEligibleForLineupAlert(u), false, "push");
  assertEq(isEmailEligibleForLineupAlert(u), true, "email");
});

test("elite, push-subscribed, emailAlerts off → push-eligible, email-ineligible", () => {
  const u = { subscriptionTier: "elite", isAdmin: false, pushSubscription: "sub-json", emailVerified: true, emailAlerts: false };
  assertEq(isPushEligibleForLineupAlert(u), true, "push");
  assertEq(isEmailEligibleForLineupAlert(u), false, "email");
});

test("elite, emailAlerts on but emailVerified false → email-ineligible despite the opt-in", () => {
  const u = { subscriptionTier: "elite", isAdmin: false, pushSubscription: null, emailVerified: false, emailAlerts: true };
  assertEq(isEmailEligibleForLineupAlert(u), false, "email");
});

test('non-elite ("all" tier) user, everything else true → ineligible for both channels', () => {
  const u = { subscriptionTier: "all", isAdmin: false, pushSubscription: "sub-json", emailVerified: true, emailAlerts: true };
  assertEq(isPushEligibleForLineupAlert(u), false, "push");
  assertEq(isEmailEligibleForLineupAlert(u), false, "email");
});

test("admin (no tier) → eligible for both channels when the underlying signal is present", () => {
  const u = { subscriptionTier: null, isAdmin: true, pushSubscription: "sub-json", emailVerified: true, emailAlerts: true };
  assertEq(isPushEligibleForLineupAlert(u), true, "push");
  assertEq(isEmailEligibleForLineupAlert(u), true, "email");
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Dedupe fingerprint independence — source-text regression guard
// ─────────────────────────────────────────────────────────────────────────

test("lineupReleaseAlerts.ts uses two distinct fingerprint prefixes, each fed to its own dedupe call", () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), "server", "mlb", "lineupReleaseAlerts.ts"), "utf8");
  if (!src.includes("`lineup|${gameId}|${slateDateET()}`")) {
    throw new Error("push fingerprint template `lineup|...` not found — dedupe key may have changed");
  }
  if (!src.includes("`lineup-email|${gameId}|${slateDateET()}`")) {
    throw new Error("email fingerprint template `lineup-email|...` not found — email channel may have been collapsed onto the push fingerprint");
  }
  const recordCalls = (src.match(/recordAlertFingerprint\(/g) ?? []).length;
  const hasCalls = (src.match(/hasAlertFingerprint\(/g) ?? []).length;
  if (recordCalls < 2 || hasCalls < 2) {
    throw new Error(
      `expected at least 2 calls each to recordAlertFingerprint/hasAlertFingerprint (one per channel), found record=${recordCalls} has=${hasCalls}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 3. sendLineupAlertEmail — real no-op path when RESEND_API_KEY is absent
// ─────────────────────────────────────────────────────────────────────────

test("sendLineupAlertEmail resolves without throwing when RESEND_API_KEY is unset", async () => {
  if (process.env.RESEND_API_KEY) {
    // A real key is configured in this run environment — sending would hit
    // the network. Skip rather than false-fail or actually send an email.
    return;
  }
  await sendLineupAlertEmail("test@example.invalid", [
    { name: "Test Batter", team: "NYY", opponent: "BOS", score: "8.5" },
  ]);
});

// — runner —
async function main() {
  let pass = 0;
  let fail = 0;
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
  console.log(`\n[Lineup Release Alerts] ${pass}/${pass + fail} cases passed`);
  if (fail > 0) {
    console.error(`\nFAILURES:\n${failures.join("\n")}`);
    process.exit(1);
  }
}

main();
