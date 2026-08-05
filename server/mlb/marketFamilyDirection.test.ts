// MLB market-family direction correctness — pitcher OVER is never "under".
//
// Run: npx tsx server/mlb/marketFamilyDirection.test.ts

import { getMarketFamily } from "./signalScore";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// Pitcher OVER markets get their own family — never "under"
{
  ok(getMarketFamily("pitcher_strikeouts", "OVER") === "pitcher_over", "pitcher_strikeouts OVER → pitcher_over");
  ok(getMarketFamily("pitcher_outs", "OVER") === "pitcher_over", "pitcher_outs OVER → pitcher_over");
  ok(getMarketFamily("hits_allowed", "OVER") === "pitcher_over", "hits_allowed OVER → pitcher_over");
  ok(getMarketFamily("walks_allowed", "OVER") === "pitcher_over", "walks_allowed OVER → pitcher_over");
  ok(getMarketFamily("pitcher_strikeouts", "OVER") !== "under", "pitcher OVER is NOT under (regression)");
}

// Pitcher UNDER stays in the under family
{
  ok(getMarketFamily("pitcher_strikeouts", "UNDER") === "under", "pitcher_strikeouts UNDER → under");
  ok(getMarketFamily("pitcher_outs", "UNDER") === "under", "pitcher_outs UNDER → under");
  ok(getMarketFamily("hits_allowed", "UNDER") === "under", "hits_allowed UNDER → under");
}

// Batter markets unchanged (over-oriented family regardless of side path)
{
  ok(getMarketFamily("hits", "OVER") === "batter_over", "hits OVER → batter_over");
  ok(getMarketFamily("total_bases", "OVER") === "batter_over", "total_bases OVER → batter_over");
  ok(getMarketFamily("hrr", "OVER") === "batter_over", "hrr OVER → batter_over");
}

console.log(`\nmarketFamilyDirection.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
