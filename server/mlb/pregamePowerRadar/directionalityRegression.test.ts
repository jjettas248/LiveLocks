// Pre-Game Power Radar — pitcher-matchup DIRECTIONALITY regression.
// Run: npx tsx server/mlb/pregamePowerRadar/directionalityRegression.test.ts
//
// Guards the orientation bug where pitcher SUPPRESSION was read as hitter
// OPPORTUNITY, and batter power alone produced an "Elite Setup" label.
// Fixtures use the real Tanner Bibee batting-order splits + Colson Montgomery BvP.

import { computePitcherOrderSplit } from "./pitcherOrderSplit";
import { computeMatchupFit } from "./matchupFit";
import { composePregameScore, classifyTier, type ScoringComponents, type ScoringFlags } from "./scoring";
import { round1 } from "./scoreUtils";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// Replicates the builder's handedness × order-split combine.
function combinePitcherVuln(handedness: number, handednessAvail: boolean, orderScore: number, orderAvail: boolean): number {
  if (handednessAvail && orderAvail) return round1((handedness * 2 + orderScore * 3) / 5);
  if (orderAvail) return orderScore;
  return handedness;
}

const baseFlags: ScoringFlags = {
  batterPowerAvailable: true,
  pitcherProfileAvailable: true,
  confirmedLineup: true,
  parkAvailable: true,
  weatherAvailable: true,
  bvpAvailable: false,
  parkIsOnlyPositiveDriver: false,
  positiveDriverCount: 4,
};

// ─────────────────────────────────────────────────────────────────────────────
// [1] Pitcher batting-order split orientation (Tanner Bibee)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] Pitcher batting-order split orientation");

const bibee1 = computePitcherOrderSplit({ slot: 1, atBats: 44, hr: 5, ops: 1.061, slg: 0.727, obp: 0.333, avg: 0.273, strikeouts: null });
ok(bibee1.available && bibee1.direction === "vulnerable" && bibee1.score10 >= 6, `#1 (1.061 OPS, 5 HR) → vulnerable (got ${bibee1.score10}/${bibee1.direction})`);

const bibee2 = computePitcherOrderSplit({ slot: 2, atBats: 39, hr: 3, ops: 1.015, slg: 0.615, obp: 0.4, avg: 0.333, strikeouts: null });
ok(bibee2.available && bibee2.direction === "vulnerable" && bibee2.score10 >= 6, `#2 (1.015 OPS, 3 HR) → vulnerable (got ${bibee2.score10}/${bibee2.direction})`);

const bibee5 = computePitcherOrderSplit({ slot: 5, atBats: 35, hr: 0, ops: 0.314, slg: 0.114, obp: 0.2, avg: 0.114, strikeouts: null });
ok(bibee5.available && bibee5.direction === "suppressive" && bibee5.score10 <= 4, `#5 (.314 OPS, 0 HR) → suppressive (got ${bibee5.score10}/${bibee5.direction})`);

ok(bibee1.score10 > bibee5.score10, "vulnerable slot scores ABOVE suppressed slot (not inverted)");

// Absent feed never penalizes.
const orderAbsent = computePitcherOrderSplit({ slot: 5, atBats: null, hr: null, ops: null, slg: null, obp: null, avg: null, strikeouts: null });
ok(!orderAbsent.available && orderAbsent.direction === "unknown" && orderAbsent.score10 === 5, "absent split → unavailable, neutral 5, unknown");

// High strikeouts vs a slot SUPPRESS vulnerability (pitcher strength).
const kHeavy = computePitcherOrderSplit({ slot: 3, atBats: 40, hr: 1, ops: 0.78, slg: 0.45, obp: 0.33, avg: 0.25, strikeouts: 20 });
const kLight = computePitcherOrderSplit({ slot: 3, atBats: 40, hr: 1, ops: 0.78, slg: 0.45, obp: 0.33, avg: 0.25, strikeouts: 2 });
ok(kHeavy.score10 < kLight.score10, `high-K slot is less vulnerable than low-K slot (got ${kHeavy.score10} < ${kLight.score10})`);

// ─────────────────────────────────────────────────────────────────────────────
// [2] BvP direction with sample-size shrinkage (Colson Montgomery vs Bibee)
// ─────────────────────────────────────────────────────────────────────────────
console.log("[2] BvP direction + shrinkage");

const colsonBvp = computeMatchupFit({
  batterHand: "L", pitcherThrows: "R", batterOpsVsHand: 0.85, batterXslgVsDominantFamily: null,
  pullRatePct: 55, parkFavorsPull: true,
  bvpPlateAppearances: 7, bvpHr: 0, bvpHits: 0, bvpAtBats: 7, bvpStrikeouts: 4, bvpOps: 0.125,
});
ok(colsonBvp.bvpAvailable && colsonBvp.bvpDirection === "negative", `Colson 0-for-7, 4 K → negative BvP (got ${colsonBvp.bvpDirection})`);
ok(colsonBvp.bvpModifier < 0 && colsonBvp.bvpModifier >= -0.3, `small-sample BvP penalty is modest (got ${colsonBvp.bvpModifier})`);

// <5 AB → informational only (no modifier).
const tinyBvp = computeMatchupFit({
  batterHand: "L", pitcherThrows: "R", batterOpsVsHand: 0.85, batterXslgVsDominantFamily: null,
  pullRatePct: 55, parkFavorsPull: true,
  bvpPlateAppearances: 3, bvpHr: 0, bvpHits: 0, bvpAtBats: 3, bvpStrikeouts: 2, bvpOps: 0.0,
});
ok(!tinyBvp.bvpAvailable && tinyBvp.bvpModifier === 0, "<5 AB BvP → informational only, no modifier");

// ─────────────────────────────────────────────────────────────────────────────
// [3] Tier gating — Colson Montgomery #5 vs Bibee must NOT be "Elite Setup"
// ─────────────────────────────────────────────────────────────────────────────
console.log("[3] Tier gating (Colson #5 vs Bibee)");

// Elite raw power, Bibee yields to LHB on the season (handedness vulnerable=8),
// BUT the #5 batting-order slot is suppressive and the direct BvP is bearish.
const handednessVuln = 8.0;
const combinedPv = combinePitcherVuln(handednessVuln, true, bibee5.score10, true);
ok(combinedPv < 5.5, `combined pitcher vuln pulled below neutral by #5 suppression (got ${combinedPv})`);

const colsonComps: ScoringComponents = {
  batterPowerScore: 8.6, // elite power profile (xISO/barrel/maxEV…)
  pitcherVulnerabilityScore: combinedPv,
  matchupFitScore: 6.5,
  parkWeatherScore: 5.5,
  lineupOpportunityScore: 5.0,
  bvpModifier: colsonBvp.bvpModifier,
};
const colsonScoring = composePregameScore(colsonComps, {
  ...baseFlags,
  bvpDirection: colsonBvp.bvpDirection,
  orderSplitDirection: bibee5.direction,
});
ok(colsonScoring.tier !== "elite" && colsonScoring.tier !== "nuclear", `Colson #5 is NOT elite (got ${colsonScoring.tier})`);
ok(colsonScoring.tier === "power_watch", `Colson #5 → power_watch / Batter Power Only (got ${colsonScoring.tier})`);
ok(colsonScoring.matchupPenalty > 0, `visible matchup penalty applied (got ${colsonScoring.matchupPenalty})`);
ok(colsonScoring.warningTags.includes("Pitcher Slot Suppression"), "warns Pitcher Slot Suppression");
ok(colsonScoring.warningTags.includes("Poor BvP History"), "warns Poor BvP History");
ok(colsonScoring.warningTags.includes("Batter Power Only"), "warns Batter Power Only");

// Same elite bat, but if the order-split/BvP context is ABSENT, batter power
// alone still must not mint an elite setup off a neutral pitcher matchup.
const powerOnly = composePregameScore(
  { batterPowerScore: 9.0, pitcherVulnerabilityScore: 4.5, matchupFitScore: 6, parkWeatherScore: 7, lineupOpportunityScore: 6, bvpModifier: 0 },
  baseFlags,
);
ok(powerOnly.tier === "power_watch", `elite power + weak pitcher (4.5) → power_watch, not elite (got ${powerOnly.tier})`);

// ─────────────────────────────────────────────────────────────────────────────
// [4] A #1 hitter CAN earn a vulnerability boost; positive control reaches elite
// ─────────────────────────────────────────────────────────────────────────────
console.log("[4] Vulnerable-slot boost + positive control");

const leadoffPv = combinePitcherVuln(7.0, true, bibee1.score10, true);
ok(leadoffPv >= 6.0, `#1 vulnerable slot lifts combined pitcher vuln (got ${leadoffPv})`);

const eliteSetup = composePregameScore(
  { batterPowerScore: 8.0, pitcherVulnerabilityScore: leadoffPv, matchupFitScore: 7.5, parkWeatherScore: 7.5, lineupOpportunityScore: 8.0, bvpModifier: 0 },
  { ...baseFlags, bvpDirection: "neutral", orderSplitDirection: bibee1.direction },
);
ok(eliteSetup.tier === "elite" || eliteSetup.tier === "nuclear", `strong batter + vulnerable pitcher + no neg matchup → elite (got ${eliteSetup.tier})`);
ok(eliteSetup.warningTags.length === 0, "clean elite setup has no downgrade warnings");

// classifyTier unit guards.
ok(classifyTier(7.6, 8.6, 3.0, true) === "power_watch", "classifyTier: high power + weak pitcher → power_watch");
ok(classifyTier(7.6, 8.0, 7.0, false) === "elite", "classifyTier: strong both, no neg → elite");
ok(classifyTier(7.6, 8.0, 7.0, true) === "strong", "classifyTier: negative matchup caps elite → strong");

console.log(`\ndirectionalityRegression.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
