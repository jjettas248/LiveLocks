// Regression test for MLB analytics market grouping.
// Run: npx tsx server/analytics/mlbMarketGroups.test.ts
//
// Locks the contract that primary MLB ROI excludes home_runs +
// batter_strikeouts, that NBA/NCAAB analytics are unchanged, and that the
// helpers never mutate persisted_plays input rows.

import {
  PRIMARY_MLB_ROI_MARKETS,
  EXCLUDED_FROM_PRIMARY_MLB_ROI,
  HR_RADAR_ANALYTICS_MARKETS,
  EXPERIMENTAL_MLB_MARKETS,
  isPrimaryMlbRoiMarket,
  isExcludedFromPrimaryMlbRoi,
  getMlbMarketAnalyticsGroup,
  filterPrimaryMlbRoiPlays,
} from "./mlbMarketGroups";

let passed = 0;
let failed = 0;
function assert(cond: any, label: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("[MLB_MARKET_GROUPS_TEST] Running…");

// ── Membership ──────────────────────────────────────────────────────────
assert(PRIMARY_MLB_ROI_MARKETS.includes("hits"), "primary includes hits");
assert(PRIMARY_MLB_ROI_MARKETS.includes("total_bases"), "primary includes total_bases");
assert(PRIMARY_MLB_ROI_MARKETS.includes("hrr"), "primary includes hrr (NOT excluded)");
assert(PRIMARY_MLB_ROI_MARKETS.includes("hits_allowed"), "primary includes hits_allowed");
assert(PRIMARY_MLB_ROI_MARKETS.includes("pitcher_outs"), "primary includes pitcher_outs");
assert(PRIMARY_MLB_ROI_MARKETS.includes("pitcher_strikeouts"), "primary includes pitcher_strikeouts (NOT excluded)");
assert(PRIMARY_MLB_ROI_MARKETS.includes("hr_allowed"), "primary includes hr_allowed");
assert(!PRIMARY_MLB_ROI_MARKETS.includes("home_runs"), "primary EXCLUDES home_runs");
assert(!PRIMARY_MLB_ROI_MARKETS.includes("batter_strikeouts"), "primary EXCLUDES batter_strikeouts");

assert(EXCLUDED_FROM_PRIMARY_MLB_ROI.includes("home_runs"), "excluded list includes home_runs");
assert(EXCLUDED_FROM_PRIMARY_MLB_ROI.includes("batter_strikeouts"), "excluded list includes batter_strikeouts");
assert(!EXCLUDED_FROM_PRIMARY_MLB_ROI.includes("pitcher_strikeouts"), "excluded list does NOT include pitcher_strikeouts");
assert(!EXCLUDED_FROM_PRIMARY_MLB_ROI.includes("hrr"), "excluded list does NOT include hrr");

assert(HR_RADAR_ANALYTICS_MARKETS.length === 1 && HR_RADAR_ANALYTICS_MARKETS[0] === "home_runs", "HR Radar lane = [home_runs]");
assert(EXPERIMENTAL_MLB_MARKETS.length === 1 && EXPERIMENTAL_MLB_MARKETS[0] === "batter_strikeouts", "Experimental lane = [batter_strikeouts]");

// ── Predicates ──────────────────────────────────────────────────────────
assert(isPrimaryMlbRoiMarket("hits"), "isPrimaryMlbRoiMarket(hits)=true");
assert(!isPrimaryMlbRoiMarket("home_runs"), "isPrimaryMlbRoiMarket(home_runs)=false");
assert(!isPrimaryMlbRoiMarket("batter_strikeouts"), "isPrimaryMlbRoiMarket(batter_strikeouts)=false");
assert(!isPrimaryMlbRoiMarket(null), "isPrimaryMlbRoiMarket(null)=false");
assert(!isPrimaryMlbRoiMarket(undefined), "isPrimaryMlbRoiMarket(undefined)=false");
assert(isExcludedFromPrimaryMlbRoi("home_runs"), "isExcludedFromPrimaryMlbRoi(home_runs)=true");
assert(isExcludedFromPrimaryMlbRoi("batter_strikeouts"), "isExcludedFromPrimaryMlbRoi(batter_strikeouts)=true");
assert(!isExcludedFromPrimaryMlbRoi("pitcher_strikeouts"), "isExcludedFromPrimaryMlbRoi(pitcher_strikeouts)=false");
assert(!isExcludedFromPrimaryMlbRoi("hrr"), "isExcludedFromPrimaryMlbRoi(hrr)=false");

// ── Group classification ────────────────────────────────────────────────
assert(getMlbMarketAnalyticsGroup("hits") === "primary_mlb_roi", "group(hits)=primary_mlb_roi");
assert(getMlbMarketAnalyticsGroup("hrr") === "primary_mlb_roi", "group(hrr)=primary_mlb_roi");
assert(getMlbMarketAnalyticsGroup("pitcher_strikeouts") === "primary_mlb_roi", "group(pitcher_strikeouts)=primary_mlb_roi");
assert(getMlbMarketAnalyticsGroup("home_runs") === "hr_radar", "group(home_runs)=hr_radar");
assert(getMlbMarketAnalyticsGroup("batter_strikeouts") === "experimental_mlb", "group(batter_strikeouts)=experimental_mlb");
assert(getMlbMarketAnalyticsGroup("unknown_new_market") === "other", "group(unknown)=other (never silently folded into headline)");
assert(getMlbMarketAnalyticsGroup(null) === "other", "group(null)=other");

// ── Filter behaviour: MLB exclusions, NBA passthrough, persisted_plays integrity ──
const fixture = [
  { id: "p1", sport: "mlb", market: "hits", result: "hit" },
  { id: "p2", sport: "mlb", market: "total_bases", result: "miss" },
  { id: "p3", sport: "mlb", market: "home_runs", result: "miss" },           // EXCLUDED
  { id: "p4", sport: "mlb", market: "batter_strikeouts", result: "hit" },     // EXCLUDED
  { id: "p5", sport: "mlb", market: "hrr", result: "hit" },
  { id: "p6", sport: "mlb", market: "pitcher_strikeouts", result: "miss" },
  { id: "p7", sport: "nba", market: "points", result: "hit" },                // not MLB → passthrough
  { id: "p8", sport: "nba", market: "rebounds", result: "miss" },             // not MLB → passthrough
  { id: "p9", sport: "ncaab", market: "spread", result: "hit" },              // not MLB → passthrough
  { id: "p10", sport: "mlb", market: "hits_allowed", result: "push" },
];
const fixtureSnapshot = JSON.stringify(fixture);
const filtered = filterPrimaryMlbRoiPlays(fixture);
const filteredIds = filtered.map((p) => p.id).sort();

assert(!filteredIds.includes("p3"), "MLB primary excludes p3 (home_runs)");
assert(!filteredIds.includes("p4"), "MLB primary excludes p4 (batter_strikeouts)");
assert(filteredIds.includes("p1") && filteredIds.includes("p2") && filteredIds.includes("p5") && filteredIds.includes("p6") && filteredIds.includes("p10"), "MLB primary keeps hits/total_bases/hrr/pitcher_strikeouts/hits_allowed");
assert(filteredIds.includes("p7") && filteredIds.includes("p8"), "NBA rows pass through unchanged");
assert(filteredIds.includes("p9"), "NCAAB rows pass through unchanged");
assert(filtered.length === fixture.length - 2, "exactly 2 rows removed (the two excluded MLB markets)");
assert(JSON.stringify(fixture) === fixtureSnapshot, "input array NOT mutated (persisted_plays integrity)");

// ── Lists are immutable (frozen) — guard against accidental in-place edits ──
let didThrow = false;
try { (PRIMARY_MLB_ROI_MARKETS as any).push("home_runs"); } catch { didThrow = true; }
assert(didThrow || !PRIMARY_MLB_ROI_MARKETS.includes("home_runs"), "PRIMARY_MLB_ROI_MARKETS is frozen");
didThrow = false;
try { (EXCLUDED_FROM_PRIMARY_MLB_ROI as any).push("hrr"); } catch { didThrow = true; }
assert(didThrow || !EXCLUDED_FROM_PRIMARY_MLB_ROI.includes("hrr"), "EXCLUDED_FROM_PRIMARY_MLB_ROI is frozen");

console.log(`\n[MLB_MARKET_GROUPS_TEST] passed=${passed} failed=${failed}`);
if (failed > 0) {
  console.error("[MLB_MARKET_GROUPS_TEST] FAILED");
  process.exit(1);
}
console.log("[MLB_MARKET_GROUPS_TEST] OK");
