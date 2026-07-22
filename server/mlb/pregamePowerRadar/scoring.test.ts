// Pre-Game Power Radar — scoring + component invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/scoring.test.ts

import {
  composePregameScore,
  computeDataCoverage,
  tierFromScore,
  PUBLISH_MIN_SCORE,
  type ScoringComponents,
  type ScoringFlags,
} from "./scoring";
import { computeBatterPowerProfile } from "./batterPowerProfile";
import { computePitcherVulnerability } from "./pitcherVulnerability";
import { computeMatchupFit } from "./matchupFit";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps = 0.05) { return Math.abs(a - b) <= eps; }

const fullFlags: ScoringFlags = {
  batterPowerAvailable: true,
  pitcherProfileAvailable: true,
  confirmedLineup: true,
  parkAvailable: true,
  weatherAvailable: true,
  bvpAvailable: false,
  parkIsOnlyPositiveDriver: false,
  positiveDriverCount: 3,
  attackEnvironmentTier: "NEUTRAL",
  attackEnvironmentEliminationEligible: false,
};

// ── Tier mapping boundaries ───────────────────────────────────────────────────
ok(tierFromScore(3.9) === "track", "3.9 → track");
ok(tierFromScore(4.0) === "watch", "4.0 → watch");
ok(tierFromScore(5.9) === "watch", "5.9 → watch");
ok(tierFromScore(6.0) === "strong", "6.0 → strong");
ok(tierFromScore(7.5) === "elite", "7.5 → elite");
ok(tierFromScore(8.8) === "nuclear", "8.8 → nuclear");

// ── Data coverage formula ─────────────────────────────────────────────────────
ok(approx(computeDataCoverage(fullFlags), 0.95), "full-minus-bvp coverage = 0.95");
ok(
  computeDataCoverage({ ...fullFlags, batterPowerAvailable: false }) === 0.6,
  "no batter power → 0.60 coverage",
);

// ── Composite is 0–10 and weighted ────────────────────────────────────────────
const comps: ScoringComponents = {
  batterPowerScore: 8,
  pitcherVulnerabilityScore: 8,
  matchupFitScore: 8,
  parkWeatherScore: 8,
  lineupOpportunityScore: 8,
  nearHrRecentFormScore: 8,
  bvpModifier: 0,
};
// classifyTier's elite/nuclear branches now additionally require FAVORABLE-or-
// better Attack Environment (§3 of the plan) — a NEUTRAL read caps an otherwise-
// qualifying card at "strong". Use a FAVORABLE flag set here to exercise the
// original "all-8 → elite" case; the NEUTRAL-caps-elite behavior is asserted
// separately below.
const favorableEnvFlags: ScoringFlags = { ...fullFlags, attackEnvironmentTier: "FAVORABLE" };
const r1 = composePregameScore(comps, favorableEnvFlags);
ok(approx(r1.score10, 8.0), `all-8 components → ~8.0 (got ${r1.score10})`);
ok(r1.score10 >= 0 && r1.score10 <= 10, "score in [0,10]");
ok(r1.tier === "elite", "all-8 + FAVORABLE env → elite");
ok(!r1.suppressed, "strong all-8 not suppressed");

// ── Attack Environment gate: NEUTRAL/HOSTILE cap an otherwise-elite card ──────
const rNeutralEnv = composePregameScore(comps, fullFlags); // fullFlags.attackEnvironmentTier === "NEUTRAL"
ok(rNeutralEnv.tier === "strong", "all-8 + NEUTRAL env → capped at strong, not elite");

const rHostileEnv = composePregameScore(comps, { ...fullFlags, attackEnvironmentTier: "HOSTILE" });
ok(rHostileEnv.tier === "strong", "all-8 + HOSTILE env → capped at strong, not elite");

// ── Attack Environment gate: ELITE required for nuclear, FAVORABLE insufficient ─
const nuclearComps: ScoringComponents = { ...comps, batterPowerScore: 9.5, pitcherVulnerabilityScore: 9.5, matchupFitScore: 9.5 };
const rNuclearFavorable = composePregameScore(nuclearComps, favorableEnvFlags);
ok(rNuclearFavorable.tier !== "nuclear", "FAVORABLE env insufficient for nuclear (needs ELITE)");
const rNuclearElite = composePregameScore(nuclearComps, { ...fullFlags, attackEnvironmentTier: "ELITE" });
ok(rNuclearElite.tier === "nuclear", "ELITE env unlocks nuclear when score/gates otherwise qualify");

// ── HOSTILE does NOT participate in eliteBlocked/downgradeReasons ────────────
// Regression: HOSTILE's own thresholds can never satisfy classifyTier's >=6.0
// pitcher-vulnerability elite gate, so wiring it into eliteBlocked would change
// nothing — assert matchupPenalty/downgradeReasons are identical whether the
// flag is NEUTRAL or HOSTILE, all else equal.
const rMatchupNeutral = composePregameScore(comps, fullFlags);
const rMatchupHostile = composePregameScore(comps, { ...fullFlags, attackEnvironmentTier: "HOSTILE", attackEnvironmentEliminationEligible: true });
ok(rMatchupNeutral.matchupPenalty === rMatchupHostile.matchupPenalty, "attackEnvironmentTier never changes matchupPenalty");
ok(
  JSON.stringify(rMatchupNeutral.downgradeReasons) === JSON.stringify(rMatchupHostile.downgradeReasons),
  "attackEnvironmentTier never changes downgradeReasons",
);

// ── HOSTILE borderline suppression — the only behavioral effect of HOSTILE ────
const borderlineComps: ScoringComponents = {
  batterPowerScore: 6.2, pitcherVulnerabilityScore: 6.2, matchupFitScore: 6.2,
  parkWeatherScore: 6.2, lineupOpportunityScore: 6.2, nearHrRecentFormScore: 6.2, bvpModifier: 0,
};
const rHostileBorderline = composePregameScore(borderlineComps, {
  ...fullFlags, attackEnvironmentTier: "HOSTILE", attackEnvironmentEliminationEligible: true,
});
ok(
  rHostileBorderline.score10 >= PUBLISH_MIN_SCORE && rHostileBorderline.score10 < 6.5,
  `borderline fixture actually lands in [6.0,6.5) (got ${rHostileBorderline.score10})`,
);
ok(
  rHostileBorderline.suppressedReasons.includes("attack_environment_hostile_borderline"),
  "HOSTILE + eliminationEligible + borderline score → suppressed",
);

const rHostileClearScore = composePregameScore(
  { ...borderlineComps, batterPowerScore: 8, pitcherVulnerabilityScore: 8, matchupFitScore: 8, parkWeatherScore: 8, lineupOpportunityScore: 8, nearHrRecentFormScore: 8 },
  { ...fullFlags, attackEnvironmentTier: "HOSTILE", attackEnvironmentEliminationEligible: true },
);
ok(
  !rHostileClearScore.suppressedReasons.includes("attack_environment_hostile_borderline"),
  "HOSTILE + eliminationEligible but score10 >= 6.5 → not suppressed by this rule",
);

const rHostileIndependentlyElite = composePregameScore(borderlineComps, {
  ...fullFlags, attackEnvironmentTier: "HOSTILE", attackEnvironmentEliminationEligible: false,
});
ok(
  !rHostileIndependentlyElite.suppressedReasons.includes("attack_environment_hostile_borderline"),
  "HOSTILE but eliminationEligible=false (independently elite) → never suppressed regardless of score",
);

// ── BvP can never push above a coverage cap ───────────────────────────────────
const cappedFlags: ScoringFlags = { ...fullFlags, pitcherProfileAvailable: false };
const rCap = composePregameScore({ ...comps, bvpModifier: 1.0 }, cappedFlags);
ok(rCap.score10 <= 5.9 + 1e-9, `pitcher-missing cap holds despite +1.0 BvP (got ${rCap.score10})`);
ok(rCap.finalScoreCap === 5.9, "finalScoreCap = 5.9 when pitcher missing");

// ── Batter power missing → cap 3.9 + suppression ──────────────────────────────
const rNoBatter = composePregameScore(comps, { ...fullFlags, batterPowerAvailable: false });
ok(rNoBatter.score10 <= 3.9 + 1e-9, "batter-missing cap 3.9");
ok(rNoBatter.suppressedReasons.includes("batter_power_missing"), "batter_power_missing reason");

// ── <2 positive drivers → suppressed ──────────────────────────────────────────
const rFewDrivers = composePregameScore(comps, { ...fullFlags, positiveDriverCount: 1 });
ok(rFewDrivers.suppressedReasons.includes("insufficient_drivers"), "insufficient_drivers reason");

// ── Below threshold with full data → suppressed (distinct from data-capped) ───
const rWeak = composePregameScore(
  { batterPowerScore: 3, pitcherVulnerabilityScore: 3, matchupFitScore: 3, parkWeatherScore: 3, lineupOpportunityScore: 3, nearHrRecentFormScore: 3, bvpModifier: 0 },
  fullFlags,
);
ok(rWeak.suppressedReasons.includes("below_threshold_after_full_data"), "below_threshold_after_full_data reason");
ok(!rWeak.suppressedReasons.includes("capped_by_data_quality"), "full-data weak is NOT capped_by_data_quality");

// ── Unconfirmed lineup → suppressed ───────────────────────────────────────────
const rNoLineup = composePregameScore(comps, { ...fullFlags, confirmedLineup: false });
ok(rNoLineup.suppressedReasons.includes("lineup_not_confirmed"), "lineup_not_confirmed reason");

// ── Park-only positive + no weather → cap 5.9 ─────────────────────────────────
const rParkOnly = composePregameScore(comps, { ...fullFlags, weatherAvailable: false, parkIsOnlyPositiveDriver: true });
ok(rParkOnly.score10 <= 5.9 + 1e-9, "park-only-no-weather cap 5.9");

// ── batterPowerProfile: missing core → unavailable ────────────────────────────
const bpEmpty = computeBatterPowerProfile({
  xISO: null, xSLG: null, barrelRatePct: null, hardHitRatePct: null, exitVelocity: null,
  maxEV: null, flyBallPct: null, hrFBRatioPct: null, pullRatePct: null, sweetSpotPct: null, xwOBA: null,
});
ok(!bpEmpty.available, "empty batter inputs → unavailable");

const bpElite = computeBatterPowerProfile({
  xISO: 0.26, xSLG: 0.56, barrelRatePct: 16, hardHitRatePct: 52, exitVelocity: 94,
  maxEV: 116, flyBallPct: 45, hrFBRatioPct: 25, pullRatePct: 50, sweetSpotPct: 40, xwOBA: 0.42,
});
ok(bpElite.available && bpElite.score10 >= 9, `elite batter inputs → high score (got ${bpElite.score10})`);
ok(bpElite.drivers.some((d) => d.direction === "positive"), "elite batter has positive drivers");

// ── pitcherVulnerability: unknown pitcher → unavailable, neutral 5 ─────────────
const pvUnknown = computePitcherVulnerability({
  pitcherKnown: false, batterHand: "R", pitcherThrows: null,
  hrPer9VsLHB: null, hrPer9VsRHB: null, eraVsLHB: null, eraVsRHB: null,
});
ok(!pvUnknown.available && pvUnknown.score10 === 5, "unknown pitcher → unavailable neutral 5");

const pvVuln = computePitcherVulnerability({
  pitcherKnown: true, batterHand: "R", pitcherThrows: "R",
  hrPer9VsLHB: 1.0, hrPer9VsRHB: 2.2, eraVsLHB: 3.5, eraVsRHB: 6.0,
});
ok(pvVuln.available && pvVuln.score10 >= 7, `vulnerable pitcher vs RHB → high (got ${pvVuln.score10})`);

// ── Switch hitter resolves to opposite-hand split ─────────────────────────────
const pvSwitch = computePitcherVulnerability({
  pitcherKnown: true, batterHand: "S", pitcherThrows: "L",
  hrPer9VsLHB: 0.6, hrPer9VsRHB: 2.2, eraVsLHB: 2.8, eraVsRHB: 6.0,
});
ok(pvSwitch.score10 >= 7, `switch vs LHP uses vsRHB split → high (got ${pvSwitch.score10})`);

// ── BvP modifier caps by sample size ──────────────────────────────────────────
const fitBig = computeMatchupFit({
  batterHand: "L", pitcherThrows: "R", batterOpsVsHand: 0.9, batterXslgVsDominantFamily: null,
  pullRatePct: 50, parkFavorsPull: true, bvpPlateAppearances: 40, bvpHr: 6, bvpHits: 18,
});
ok(fitBig.bvpModifier <= 1.0 && fitBig.bvpModifier > 0, `BvP 40PA cap ≤1.0 (got ${fitBig.bvpModifier})`);

const fitSmall = computeMatchupFit({
  batterHand: "L", pitcherThrows: "R", batterOpsVsHand: 0.9, batterXslgVsDominantFamily: null,
  pullRatePct: 50, parkFavorsPull: true, bvpPlateAppearances: 4, bvpHr: 2, bvpHits: 3,
});
ok(fitSmall.bvpModifier === 0, "BvP <6 PA → 0 modifier");
ok(!fitSmall.bvpAvailable, "BvP <6 PA → not available");

// ── bvpHits — additive passthrough, no-op when unavailable ────────────────────
ok(fitBig.bvpHits === 18, `BvP available → bvpHits returns input verbatim (got ${fitBig.bvpHits})`);
ok(fitSmall.bvpHits === null, "BvP <5 AB/PA → bvpHits null (unavailable)");

console.log(`\nscoring.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
