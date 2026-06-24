// Pre-Game Power Radar — matchup-evidence regression (integration).
// Run: npx tsx server/mlb/pregamePowerRadar/directionalityRegression.test.ts
//
// Two matchup layers + BvP must downgrade a strong bat with a bad pitcher/order/
// BvP context, and batter power alone must never mint "Elite Setup".

import { computePitcherOrderSplit, type PitcherOrderSplitInputs } from "./pitcherOrderSplit";
import { computeMatchupFit } from "./matchupFit";
import { composePregameScore, classifyTier, type ScoringComponents, type ScoringFlags } from "./scoring";
import { round1 } from "./scoreUtils";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function combineVuln(h: number, hAvail: boolean, o: number, oAvail: boolean): number {
  if (hAvail && oAvail) return round1((h * 2 + o * 3) / 5);
  if (oAvail) return o;
  return h;
}

const NIL = { r: null, doubles: null, triples: null, rbi: null, bb: null, hbp: null, so: null, sb: null, cs: null };
function pRow(p: Partial<PitcherOrderSplitInputs>): PitcherOrderSplitInputs {
  return { slot: null, ab: null, h: null, hr: null, avg: null, obp: null, slg: null, ops: null, ...NIL, ...p } as PitcherOrderSplitInputs;
}

const baseFlags: ScoringFlags = {
  batterPowerAvailable: true, pitcherProfileAvailable: true, confirmedLineup: true,
  parkAvailable: true, weatherAvailable: true, bvpAvailable: false,
  parkIsOnlyPositiveDriver: false, positiveDriverCount: 4,
};

// ─────────────────────────────────────────────────────────────────────────────
// [1] BvP zero-production rule (Colson Montgomery vs Bibee)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] BvP zero-production + shrinkage");
const colsonBvp = computeMatchupFit({
  batterHand: "L", pitcherThrows: "R", batterOpsVsHand: 0.85, batterXslgVsDominantFamily: null,
  pullRatePct: 55, parkFavorsPull: true,
  bvpPlateAppearances: 8, bvpHr: 0, bvpHits: 0, bvpAtBats: 7, bvpStrikeouts: 4, bvpOps: 0.125, bvpAvg: 0.0,
});
ok(colsonBvp.bvpDirection === "negative", `0-for-7, 4 K → negative BvP (got ${colsonBvp.bvpDirection})`);
ok(colsonBvp.bvpZeroProduction && colsonBvp.zeroProductionFlags.length >= 2, `zero-production flagged (${colsonBvp.zeroProductionFlags.join("/")})`);
ok(colsonBvp.bvpModifier < 0 && colsonBvp.bvpModifier >= -0.4, `small-sample penalty modest, not a hard veto (got ${colsonBvp.bvpModifier})`);

// 0 HR ALONE (with hits + decent OPS) must NOT read negative.
const zeroHrOnly = computeMatchupFit({
  batterHand: "L", pitcherThrows: "R", batterOpsVsHand: 0.85, batterXslgVsDominantFamily: null,
  pullRatePct: 50, parkFavorsPull: false,
  bvpPlateAppearances: 9, bvpHr: 0, bvpHits: 3, bvpAtBats: 9, bvpStrikeouts: 1, bvpOps: 0.78, bvpAvg: 0.333,
});
ok(zeroHrOnly.bvpDirection !== "negative" && !zeroHrOnly.bvpZeroProduction, `0 HR alone (with hits) is not negative (got ${zeroHrOnly.bvpDirection})`);

// ─────────────────────────────────────────────────────────────────────────────
// [2] Pitcher slot suppression downgrades a #5 hitter (Bibee #5)
// ─────────────────────────────────────────────────────────────────────────────
console.log("[2] Pitcher slot suppression (Colson #5 vs Bibee)");
const bibee5 = computePitcherOrderSplit(pRow({ slot: 5, ab: 35, h: 4, hr: 0, avg: 0.114, obp: 0.2, slg: 0.114, ops: 0.314, so: 11 }));
ok(bibee5.direction === "suppressive", `Bibee #5 → suppressive (got ${bibee5.score10})`);

const combinedPv = combineVuln(8.0, true, bibee5.score10, true); // handedness vulnerable, but #5 suppressed
ok(combinedPv < 5.5, `#5 suppression pulls combined pitcher vuln below neutral (got ${combinedPv})`);

const colson = composePregameScore(
  { batterPowerScore: 8.6, pitcherVulnerabilityScore: combinedPv, matchupFitScore: 6.5, parkWeatherScore: 5.5, lineupOpportunityScore: 5.0, bvpModifier: colsonBvp.bvpModifier },
  { ...baseFlags, bvpDirection: colsonBvp.bvpDirection, bvpZeroProduction: colsonBvp.bvpZeroProduction, pitcherOrderSplitDirection: bibee5.direction, batterOrderSplitDirection: "neutral" },
);
ok(colson.tier === "power_watch", `Colson #5 vs Bibee → power_watch, not elite (got ${colson.tier})`);
ok(colson.warningTags.includes("Pitcher Slot Suppression"), "warns Pitcher Slot Suppression");
ok(colson.warningTags.includes("Poor BvP History"), "warns Poor BvP History");
ok(colson.downgradeReasons.includes("pitcher_slot_suppression") && colson.downgradeReasons.includes("bvp_zero_production"), "downgradeReasons capture both layers");

// ─────────────────────────────────────────────────────────────────────────────
// [3] Batter weak from today's slot blocks a clean elite
// ─────────────────────────────────────────────────────────────────────────────
console.log("[3] Weak-from-slot blocks elite");
const weakSlot = composePregameScore(
  { batterPowerScore: 8.0, pitcherVulnerabilityScore: 7.0, matchupFitScore: 7.5, parkWeatherScore: 7.5, lineupOpportunityScore: 7.0, bvpModifier: 0 },
  { ...baseFlags, bvpDirection: "neutral", pitcherOrderSplitDirection: "vulnerable", batterOrderSplitDirection: "weak" },
);
ok(weakSlot.tier !== "elite" && weakSlot.tier !== "nuclear", `weak-from-slot is not a clean elite (got ${weakSlot.tier})`);
ok(weakSlot.warningTags.includes("Weak From Lineup Slot"), "warns Weak From Lineup Slot");

// ─────────────────────────────────────────────────────────────────────────────
// [4] Batter power alone → power_watch; positive control → elite
// ─────────────────────────────────────────────────────────────────────────────
console.log("[4] Power-only vs positive control");
const powerOnly = composePregameScore(
  { batterPowerScore: 9.0, pitcherVulnerabilityScore: 4.5, matchupFitScore: 6, parkWeatherScore: 7, lineupOpportunityScore: 6, bvpModifier: 0 },
  baseFlags,
);
ok(powerOnly.tier === "power_watch", `elite power + weak pitcher → power_watch (got ${powerOnly.tier})`);

const elite = composePregameScore(
  { batterPowerScore: 8.0, pitcherVulnerabilityScore: 8.2, matchupFitScore: 7.5, parkWeatherScore: 7.5, lineupOpportunityScore: 8.0, bvpModifier: 0 },
  { ...baseFlags, bvpDirection: "neutral", pitcherOrderSplitDirection: "vulnerable", batterOrderSplitDirection: "strong" },
);
ok(elite.tier === "elite" || elite.tier === "nuclear", `strong batter + vulnerable pitcher + good context → elite (got ${elite.tier})`);
ok(elite.warningTags.length === 0 && elite.downgradeReasons.length === 0, "clean elite has no warnings/downgrades");

// classifyTier units.
ok(classifyTier(7.6, 8.6, 4.0, false) === "power_watch", "classifyTier: high power + weak pitcher → power_watch");
ok(classifyTier(7.6, 8.0, 7.0, false) === "elite", "classifyTier: strong both, not blocked → elite");
ok(classifyTier(7.6, 8.0, 7.0, true) === "strong", "classifyTier: blocked matchup caps elite → strong");

// ─────────────────────────────────────────────────────────────────────────────
// [5] Production path: pitcher order-split UNAVAILABLE must not help or fake it
// ─────────────────────────────────────────────────────────────────────────────
console.log("[5] Unavailable order-split guardrails (prod path)");

// Unavailable scorer: no drivers, neutral score, "unavailable" direction.
const unavail = computePitcherOrderSplit(pRow({ slot: 5 }));
ok(!unavail.available, "G1/G2: unavailable order-split is not available");
ok(unavail.direction === "unavailable", "G4: direction is 'unavailable', not 'neutral'");
ok(unavail.drivers.length === 0, "G2/G3: unavailable order-split emits NO drivers (no positive contribution, no tag)");

// Colson in PRODUCTION today: order-split unavailable, but BvP zero-production +
// the gate still downgrade him out of a clean Elite (handedness genuinely vuln).
const colsonProd = composePregameScore(
  { batterPowerScore: 8.6, pitcherVulnerabilityScore: 7.5, matchupFitScore: 6.5, parkWeatherScore: 5.5, lineupOpportunityScore: 5.0, bvpModifier: colsonBvp.bvpModifier },
  { ...baseFlags, bvpDirection: colsonBvp.bvpDirection, bvpZeroProduction: colsonBvp.bvpZeroProduction, pitcherOrderSplitDirection: "unavailable", batterOrderSplitDirection: "neutral" },
);
ok(colsonProd.tier !== "elite" && colsonProd.tier !== "nuclear", `G6: Colson (prod, order unavailable) is NOT clean elite (got ${colsonProd.tier})`);
ok(colsonProd.downgradeReasons.includes("bvp_zero_production"), "G6: downgrade attributed to BvP zero-production");
ok(!colsonProd.warningTags.includes("Pitcher Slot Suppression"), "G3: no slot-suppression tag when order-split is unavailable");

// Batter power alone, no pitcher evidence at all (handedness + order unavailable
// ⇒ neutral 5) must NOT reach elite.
const powerNoPitcher = composePregameScore(
  { batterPowerScore: 9.5, pitcherVulnerabilityScore: 5.0, matchupFitScore: 6, parkWeatherScore: 8, lineupOpportunityScore: 7, bvpModifier: 0 },
  { ...baseFlags, pitcherOrderSplitDirection: "unavailable", batterOrderSplitDirection: "unavailable" },
);
ok(powerNoPitcher.tier === "power_watch", `G5: power alone + no pitcher evidence → power_watch (got ${powerNoPitcher.tier})`);

console.log(`\ndirectionalityRegression.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

