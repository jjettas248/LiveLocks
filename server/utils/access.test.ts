// Run: npx tsx server/utils/access.test.ts
// PR6 — NFL entitlement mapping (gated OFF by default). Proves adding the mapping
// does NOT change hasNBA/hasNCAAB/hasMLB/hasUnlimited for any tier, that hasNFL stays
// false operationally until the fail-closed flag is enabled, that the admin bypass is
// unchanged, and that (when enabled) only the mapped tier ("elite") grants NFL.
import { resolveAccess, isNflEntitlementEnabled, tierMapsToNfl, NFL_ENTITLEMENT_ENABLED_ENV } from "./access";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const saved = process.env[NFL_ENTITLEMENT_ENABLED_ENV];
const setFlag = (v: string | undefined) => { if (v === undefined) delete process.env[NFL_ENTITLEMENT_ENABLED_ENV]; else process.env[NFL_ENTITLEMENT_ENABLED_ENV] = v; };

// ── Flag parser is fail-closed ──────────────────────────────────────────────
{
  ok(isNflEntitlementEnabled({}) === false, "unset → disabled (fail-closed)");
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: "true" }) === true, "'true' → enabled");
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: " ON " }) === true, "trims + case-insensitive");
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: "maybe" }) === false, "non-affirmative → disabled");
}

// ── Pure mapping: NFL is an All-Sports (elite) sport ────────────────────────
{
  ok(tierMapsToNfl("elite") === true, "elite maps to NFL");
  ok(tierMapsToNfl("all") === false, "all (Pro) does not map to NFL");
  ok(tierMapsToNfl("") === false, "no tier does not map to NFL");
}

// ── DEFAULT (flag off): hasNFL false for every real tier; others unchanged ──
{
  setFlag(undefined);
  const elite = resolveAccess("elite", false);
  ok(elite.hasNFL === false, "flag off: elite has NO operational NFL");
  ok(elite.hasNBA && elite.hasNCAAB && elite.hasMLB && elite.hasUnlimited, "elite keeps NBA/NCAAB/MLB/unlimited unchanged");
  const all = resolveAccess("all", false);
  ok(all.hasNFL === false && all.hasNBA && all.hasNCAAB && !all.hasMLB, "flag off: 'all' unchanged (NBA/NCAAB, no MLB, no NFL)");
  const none = resolveAccess("free", false);
  ok(!none.hasNFL && !none.hasNBA && !none.hasMLB, "flag off: no-tier has nothing");
  // Legacy alias normalization still works and still grants no NFL.
  ok(resolveAccess("all_sports", false).hasMLB === true && resolveAccess("all_sports", false).hasNFL === false, "legacy 'all_sports' → elite (MLB yes, NFL still gated off)");
}

// ── Admin bypass unchanged (always true, independent of the flag) ───────────
{
  setFlag(undefined);
  const admin = resolveAccess("free", true);
  ok(admin.hasNFL === true && admin.hasNBA && admin.hasMLB && admin.hasUnlimited, "admin bypass grants NFL regardless of flag");
}

// ── Flag ON: only the mapped tier ("elite") gains NFL; nothing else moves ───
{
  setFlag("true");
  const elite = resolveAccess("elite", false);
  ok(elite.hasNFL === true, "flag on: elite gains NFL");
  ok(elite.hasNBA && elite.hasNCAAB && elite.hasMLB && elite.hasUnlimited, "flag on: elite's other flags unchanged");
  const all = resolveAccess("all", false);
  ok(all.hasNFL === false, "flag on: 'all' (Pro) still no NFL (only elite maps)");
  ok(all.hasNBA && all.hasNCAAB && !all.hasMLB, "flag on: 'all' other flags unchanged");
  ok(resolveAccess("free", false).hasNFL === false, "flag on: no-tier still no NFL");
}

setFlag(saved); // restore

console.log(`\naccess.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
