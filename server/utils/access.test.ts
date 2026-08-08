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
  // Explicit re-audit: blank / negative / unknown affirmatives all fail closed.
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: "" }) === false, "blank string → disabled");
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: "   " }) === false, "whitespace-only → disabled");
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: "false" }) === false, "'false' → disabled");
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: "0" }) === false, "'0' → disabled");
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: "no" }) === false, "'no' → disabled");
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: "off" }) === false, "'off' → disabled");
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: "TRUE" }) === true, "'TRUE' (uppercase) → enabled");
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: "1" }) === true, "'1' → enabled");
  ok(isNflEntitlementEnabled({ [NFL_ENTITLEMENT_ENABLED_ENV]: "yes" }) === true, "'yes' → enabled");
}

// ── tierMapsToNfl: unknown / alias-normalized inputs never map ───────────────
{
  ok(tierMapsToNfl("unknown") === false, "unknown tier does not map to NFL");
  ok(tierMapsToNfl("ELITE") === false, "tierMapsToNfl is exact-match on the NORMALIZED tier (uppercase not normalized here)");
  ok(tierMapsToNfl("all_sports") === false, "raw alias does not map (normalization happens in resolveAccess, before this)");
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

// ── Strict invariance: toggling the flag moves ONLY hasNFL, nothing else ────
{
  for (const tier of ["elite", "all", "free", "all_sports", "pro_nba"]) {
    setFlag(undefined);
    const off = resolveAccess(tier, false);
    setFlag("true");
    const on = resolveAccess(tier, false);
    ok(off.hasNBA === on.hasNBA && off.hasNCAAB === on.hasNCAAB && off.hasMLB === on.hasMLB && off.hasUnlimited === on.hasUnlimited,
      `flag toggle leaves NBA/NCAAB/MLB/unlimited unchanged for "${tier}"`);
    // hasNFL only ever differs (off→on) for the mapped tier; every other tier stays false both ways.
    const normalizedIsElite = tier === "elite" || tier === "all_sports";
    ok(off.hasNFL === false, `"${tier}" hasNFL false when flag off`);
    ok(on.hasNFL === normalizedIsElite, `"${tier}" hasNFL on-flag === maps-to-elite (${normalizedIsElite})`);
  }
}

setFlag(saved); // restore

console.log(`\naccess.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
