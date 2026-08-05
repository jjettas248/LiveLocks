// MLB Production Policy — invariants.
//
// Run: npx tsx server/mlb/productionPolicy.test.ts

import {
  DEFAULT_MLB_LIVE_POLICY,
  classifyInningBand,
  isInningOfficialAllowed,
  resolveMarketMode,
  resolveMarketOfficialGate,
  resolveMlbLane,
  describeMlbLivePolicy,
} from "./productionPolicy";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// Inning band classification + official-allowed
{
  ok(classifyInningBand(1) === "early", "inning 1 is early");
  ok(classifyInningBand(3) === "early", "inning 3 is early");
  ok(classifyInningBand(4) === "middle", "inning 4 is middle");
  ok(classifyInningBand(6) === "middle", "inning 6 is middle");
  ok(classifyInningBand(7) === "late", "inning 7 is late");
  ok(classifyInningBand(9) === "late", "inning 9 is late");
  ok(isInningOfficialAllowed(1) === false, "inning 1 NOT official-allowed");
  ok(isInningOfficialAllowed(3) === false, "inning 3 NOT official-allowed");
  ok(isInningOfficialAllowed(4) === true, "inning 4 official-allowed");
  ok(isInningOfficialAllowed(8) === true, "inning 8 official-allowed");
}

// Market modes — only hits is official; damaged markets shadow; disabled off
{
  ok(resolveMarketMode("hits") === "official", "hits is official");
  ok(resolveMarketMode("total_bases") === "shadow", "total_bases is shadow");
  ok(resolveMarketMode("hrr") === "shadow", "hrr is shadow");
  ok(resolveMarketMode("pitcher_outs") === "shadow", "pitcher_outs is shadow");
  ok(resolveMarketMode("hits_allowed") === "shadow", "hits_allowed is shadow");
  ok(resolveMarketMode("pitcher_strikeouts") === "shadow", "pitcher_strikeouts is shadow");
  ok(resolveMarketMode("walks_allowed") === "off", "walks_allowed is off");
  ok(resolveMarketMode("hr_allowed") === "off", "hr_allowed is off");
}

// Official gate: innings 1-3 can NEVER be official even for hits
{
  const early = resolveMarketOfficialGate("hits", 2);
  ok(early.officialAllowed === false, "hits inning 2 not official-allowed");
  ok(early.reason === "early_inning_watch_only", "reason early_inning_watch_only");

  const mid = resolveMarketOfficialGate("hits", 5);
  ok(mid.officialAllowed === true, "hits inning 5 official-allowed by matrix");
  ok(mid.reason === null, "no reason when allowed");

  const shadowMkt = resolveMarketOfficialGate("total_bases", 5);
  ok(shadowMkt.officialAllowed === false, "total_bases never official-allowed");
  ok(shadowMkt.reason === "market_shadow", "reason market_shadow");

  const offMkt = resolveMarketOfficialGate("hr_allowed", 5);
  ok(offMkt.officialAllowed === false, "off market not official-allowed");
  ok(offMkt.reason === "market_off", "reason market_off");
}

// Lane resolution
{
  ok(resolveMlbLane("hits", true) === "official", "hits + cleared gates → official");
  ok(resolveMlbLane("hits", false) === "watch", "hits + failed gates → watch (not shadow)");
  ok(resolveMlbLane("total_bases", true) === "shadow", "shadow market always shadow even if gates cleared");
  ok(resolveMlbLane("total_bases", false) === "shadow", "shadow market shadow when gates fail");
  ok(resolveMlbLane("hr_allowed", true) === "shadow", "off market → shadow lane (never official)");
}

// Boot log describes the resolved policy
{
  const desc = describeMlbLivePolicy(DEFAULT_MLB_LIVE_POLICY);
  ok(desc.includes("[MLB_PRODUCTION_POLICY]"), "boot log has tag");
  ok(desc.includes("hits=official"), "boot log shows hits=official");
  ok(desc.includes("total_bases=shadow"), "boot log shows total_bases=shadow");
}

console.log(`\nproductionPolicy.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
