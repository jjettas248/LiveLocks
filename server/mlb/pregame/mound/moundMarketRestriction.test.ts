// Mound Radar — market restriction invariants.
//
// Encodes the hard "no allowed markets" rule: The Mound must NEVER tag
// hits_allowed / walks_allowed / hr_allowed / earned_runs. Asserts this by
// construction (the MoundMarket type + computeMarketTags() only ever produce
// pitcher_strikeouts/pitcher_outs), not by filtering after the fact.
//
// Run: npx tsx server/mlb/pregame/mound/moundMarketRestriction.test.ts

import { computeMarketTags, marketSetupLabel } from "./marketTagger";
import { MOUND_MARKETS } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const DISALLOWED_MARKETS = ["hits_allowed", "walks_allowed", "hr_allowed", "earned_runs"];
const ALLOWED_MARKETS = MOUND_MARKETS;

// ── computeMarketTags always emits exactly the two allowed markets ───────────
const cases = [
  { pitcherSkillScore: 8, opponentKProfileScore: 8, workloadScore: 4 },
  { pitcherSkillScore: 4, opponentKProfileScore: 4, workloadScore: 8 },
  { pitcherSkillScore: 5, opponentKProfileScore: 5, workloadScore: 5 },
];

for (const c of cases) {
  const result = computeMarketTags(c);
  ok(
    ALLOWED_MARKETS.includes(result.primaryMarket),
    `primaryMarket ${result.primaryMarket} is in the allowed set`,
  );
  ok(
    result.marketTags.every((m) => ALLOWED_MARKETS.includes(m)),
    `marketTags ${result.marketTags.join(",")} is a subset of the allowed set`,
  );
  ok(
    result.marketTags.length === 2 && result.marketTags.includes("pitcher_strikeouts") && result.marketTags.includes("pitcher_outs"),
    "marketTags is exactly [pitcher_strikeouts, pitcher_outs]",
  );
  for (const disallowed of DISALLOWED_MARKETS) {
    ok(
      !(result.marketTags as string[]).includes(disallowed) &&
        (result.primaryMarket as string) !== disallowed,
      `${disallowed} never appears in marketTags or primaryMarket`,
    );
  }
  for (const setup of result.marketSetups) {
    ok(ALLOWED_MARKETS.includes(setup.market), `marketSetups entry ${setup.market} is in the allowed set`);
  }
}

// ── K-market strength picks pitcher_strikeouts; workload strength picks pitcher_outs ──
const kHeavy = computeMarketTags({ pitcherSkillScore: 9, opponentKProfileScore: 9, workloadScore: 3 });
ok(kHeavy.primaryMarket === "pitcher_strikeouts", "high K-market strength → pitcher_strikeouts primary");

const outsHeavy = computeMarketTags({ pitcherSkillScore: 3, opponentKProfileScore: 3, workloadScore: 9 });
ok(outsHeavy.primaryMarket === "pitcher_outs", "high workload strength → pitcher_outs primary");

// ── marketSetupLabel is a pure classification, no I/O — exactly 3 grades ────
// (no "Solid"/"Watch" middle ground: below the Strong bar is Weak, period)
ok(marketSetupLabel(9.0) === "Elite", "9.0 → Elite");
ok(marketSetupLabel(7.5) === "Strong", "7.5 → Strong");
ok(marketSetupLabel(6.0) === "Weak", "6.0 → Weak (below the 7.0 Strong bar)");
ok(marketSetupLabel(3.0) === "Weak", "3.0 → Weak");

console.log(`\nmoundMarketRestriction.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
