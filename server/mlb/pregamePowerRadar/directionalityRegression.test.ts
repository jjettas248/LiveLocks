// Pre-Game Power Radar — evidence-gating + BvP regression.
// Run: npx tsx server/mlb/pregamePowerRadar/directionalityRegression.test.ts
//
// Guards the evidence/classification bug where "Elite Setup" was assigned from
// batter power + handedness/park alone, with no pitcher-specific validation and
// no use of bearish BvP history. There is NO pitcher allowed-by-batting-order-
// slot feed wired into the build, so this suite does NOT assert any order-split
// behavior — only the production gate (batter power + handedness + BvP).

import { computeMatchupFit } from "./matchupFit";
import { composePregameScore, classifyTier, type ScoringComponents, type ScoringFlags } from "./scoring";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
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
// [1] BvP direction with sample-size shrinkage (Colson Montgomery vs Bibee)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] BvP direction + shrinkage");

const colsonBvp = computeMatchupFit({
  batterHand: "L", pitcherThrows: "R", batterOpsVsHand: 0.85, batterXslgVsDominantFamily: null,
  pullRatePct: 55, parkFavorsPull: true,
  bvpPlateAppearances: 7, bvpHr: 0, bvpHits: 0, bvpAtBats: 7, bvpStrikeouts: 4, bvpOps: 0.125,
});
ok(colsonBvp.bvpAvailable && colsonBvp.bvpDirection === "negative", `Colson 0-for-7, 4 K → negative BvP (got ${colsonBvp.bvpDirection})`);
ok(colsonBvp.bvpModifier < 0 && colsonBvp.bvpModifier >= -0.3, `small-sample BvP penalty is modest, not a hard veto (got ${colsonBvp.bvpModifier})`);

// <5 AB → informational only (no modifier).
const tinyBvp = computeMatchupFit({
  batterHand: "L", pitcherThrows: "R", batterOpsVsHand: 0.85, batterXslgVsDominantFamily: null,
  pullRatePct: 55, parkFavorsPull: true,
  bvpPlateAppearances: 3, bvpHr: 0, bvpHits: 0, bvpAtBats: 3, bvpStrikeouts: 2, bvpOps: 0.0,
});
ok(!tinyBvp.bvpAvailable && tinyBvp.bvpModifier === 0, "<5 AB BvP → informational only, no modifier");

// Strong positive BvP with a real sample reads positive.
const goodBvp = computeMatchupFit({
  batterHand: "L", pitcherThrows: "R", batterOpsVsHand: 0.9, batterXslgVsDominantFamily: null,
  pullRatePct: 55, parkFavorsPull: true,
  bvpPlateAppearances: 30, bvpHr: 4, bvpHits: 12, bvpAtBats: 28, bvpStrikeouts: 3, bvpOps: 1.2,
});
ok(goodBvp.bvpDirection === "positive" && goodBvp.bvpModifier > 0, `4 HR / 12 H in 28 AB → positive BvP (got ${goodBvp.bvpDirection})`);

// ─────────────────────────────────────────────────────────────────────────────
// [2] Evidence gate — batter power alone must NOT mint "Elite Setup"
// ─────────────────────────────────────────────────────────────────────────────
console.log("[2] Evidence gate (Elite requires pitcher evidence too)");

// Elite raw power, neutral/weak pitcher matchup, no positive context → power_watch.
const powerOnly = composePregameScore(
  { batterPowerScore: 9.0, pitcherVulnerabilityScore: 4.5, matchupFitScore: 6, parkWeatherScore: 7, lineupOpportunityScore: 6, bvpModifier: 0 },
  baseFlags,
);
ok(powerOnly.tier === "power_watch", `elite power + weak pitcher (4.5) → power_watch, not elite (got ${powerOnly.tier})`);
ok(powerOnly.warningTags.includes("Batter Power Only"), "power-only carries 'Batter Power Only' tag");

// ─────────────────────────────────────────────────────────────────────────────
// [3] Colson Montgomery vs Bibee — bearish BvP blocks a clean Elite Setup
// ─────────────────────────────────────────────────────────────────────────────
console.log("[3] Colson #5 vs Bibee is not a clean Elite Setup");

// Even if Bibee yields to LHB on the season (handedness vuln genuinely positive),
// the bearish small-sample BvP must prevent a CLEAN elite label.
const colsonComps: ScoringComponents = {
  batterPowerScore: 8.9,
  pitcherVulnerabilityScore: 7.5, // handedness-only: Bibee yields HR to LHB
  matchupFitScore: 8.0,
  parkWeatherScore: 6.7,
  lineupOpportunityScore: 5.0,
  bvpModifier: colsonBvp.bvpModifier,
};
const colsonScoring = composePregameScore(colsonComps, { ...baseFlags, bvpDirection: colsonBvp.bvpDirection });
ok(colsonScoring.tier !== "elite" && colsonScoring.tier !== "nuclear", `Colson is NOT a clean elite (got ${colsonScoring.tier})`);
ok(colsonScoring.warningTags.includes("Poor BvP History"), "Colson surfaces 'Poor BvP History'");
ok(colsonScoring.warningTags.includes("Matchup Downgrade"), "Colson surfaces 'Matchup Downgrade'");
ok(colsonScoring.matchupPenalty > 0, `visible matchup penalty applied (got ${colsonScoring.matchupPenalty})`);

// If the same hitter's handedness pitcher evidence is also weak → power_watch.
const colsonWeakHand = composePregameScore(
  { ...colsonComps, pitcherVulnerabilityScore: 5.0 },
  { ...baseFlags, bvpDirection: colsonBvp.bvpDirection },
);
ok(colsonWeakHand.tier === "power_watch", `weak handedness + bearish BvP → power_watch (got ${colsonWeakHand.tier})`);

// ─────────────────────────────────────────────────────────────────────────────
// [4] Positive control + classifyTier unit guards
// ─────────────────────────────────────────────────────────────────────────────
console.log("[4] Positive control + classifyTier units");

const eliteSetup = composePregameScore(
  { batterPowerScore: 8.0, pitcherVulnerabilityScore: 8.0, matchupFitScore: 7.5, parkWeatherScore: 7.5, lineupOpportunityScore: 8.0, bvpModifier: 0 },
  { ...baseFlags, bvpDirection: "neutral" },
);
ok(eliteSetup.tier === "elite" || eliteSetup.tier === "nuclear", `strong batter + vulnerable pitcher + no neg BvP → elite (got ${eliteSetup.tier})`);
ok(eliteSetup.warningTags.length === 0, "clean elite setup has no downgrade warnings");

ok(classifyTier(7.6, 8.6, 4.0, false) === "power_watch", "classifyTier: high power + weak pitcher → power_watch");
ok(classifyTier(7.6, 8.0, 7.0, false) === "elite", "classifyTier: strong both, no neg → elite");
ok(classifyTier(7.6, 8.0, 7.0, true) === "strong", "classifyTier: negative matchup caps elite → strong");

console.log(`\ndirectionalityRegression.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
