// Attack Environment — pitcher × park/weather × matchup-fit interaction invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/attackEnvironment.test.ts

import {
  classifyEnvironmentDirection,
  getParkDirection,
  classifyAttackEnvironmentCohort,
  computeAttackEnvironment,
  appendAttackEnvironmentDrivers,
  ATTACK_ENVIRONMENT_THRESHOLDS,
  type AttackEnvironmentInputs,
} from "./attackEnvironment";
import type { PowerDriver } from "./types";
import type { ScoringResult } from "./scoring";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const t = ATTACK_ENVIRONMENT_THRESHOLDS;

function baseInputs(overrides: Partial<AttackEnvironmentInputs> = {}): AttackEnvironmentInputs {
  return {
    batterPowerScore: 5,
    pitcherVulnerabilityScore: 5,
    matchupFitScore: 5,
    parkDirection: "neutral",
    carryType: "neutral",
    selectedMarketScore: 5,
    ...overrides,
  };
}

// ── classifyEnvironmentDirection: mutually exclusive, mixed/unknown never lie ──
ok(classifyEnvironmentDirection("positive", "neutral") === "positive", "park-positive alone → positive");
ok(classifyEnvironmentDirection("neutral", "boost") === "positive", "carry-boost alone → positive");
ok(classifyEnvironmentDirection("negative", "neutral") === "negative", "park-negative alone → negative");
ok(classifyEnvironmentDirection("neutral", "suppress") === "negative", "carry-suppress alone → negative");
ok(classifyEnvironmentDirection("positive", "suppress") === "mixed", "hitter-friendly park + suppressive weather → mixed, not positive");
ok(classifyEnvironmentDirection("negative", "boost") === "mixed", "pitcher-friendly park + carry boost → mixed, not negative");
ok(classifyEnvironmentDirection("neutral", "unknown") === "unknown", "no data at all → unknown");
ok(classifyEnvironmentDirection("neutral", "neutral") === "neutral", "genuinely neutral both → neutral");

// ── getParkDirection reads only pw_park / pw_park_pitcher ─────────────────────
ok(getParkDirection([{ key: "pw_park", label: "x", direction: "positive" }]) === "positive", "pw_park → positive");
ok(getParkDirection([{ key: "pw_park_pitcher", label: "x", direction: "negative" }]) === "negative", "pw_park_pitcher → negative");
ok(getParkDirection([{ key: "pw_wind_out", label: "x", direction: "positive" }]) === "neutral", "unrelated driver key → neutral (not read)");
ok(getParkDirection([]) === "neutral", "no drivers → neutral");

// ── classifyAttackEnvironmentCohort: all four cohorts ─────────────────────────
ok(classifyAttackEnvironmentCohort(6.0, "positive") === "pitcher_and_environment", "favorable pitcher + positive env → pitcher_and_environment");
ok(classifyAttackEnvironmentCohort(6.0, "neutral") === "pitcher_only", "favorable pitcher + neutral env → pitcher_only");
ok(classifyAttackEnvironmentCohort(4.0, "positive") === "environment_only", "weak pitcher + positive env → environment_only");
ok(classifyAttackEnvironmentCohort(4.0, "neutral") === "neither", "weak pitcher + neutral env → neither");
ok(
  classifyAttackEnvironmentCohort(t.favorablePitcherVulnerability, "positive") === "pitcher_and_environment",
  "exact favorablePitcherVulnerability threshold is inclusive",
);

// ── computeAttackEnvironment: ELITE requires all three legs aligned ──────────
const elite = computeAttackEnvironment(baseInputs({
  batterPowerScore: t.eliteBatterPower,
  pitcherVulnerabilityScore: t.elitePitcherVulnerability,
  matchupFitScore: t.eliteMatchupFit,
  parkDirection: "positive",
}));
ok(elite.tier === "ELITE", `all three legs at ELITE threshold → ELITE (got ${elite.tier})`);

// Dropping any single leg must prevent ELITE (not batter power + one other leg).
ok(
  computeAttackEnvironment(baseInputs({
    batterPowerScore: t.eliteBatterPower, pitcherVulnerabilityScore: 4.0, matchupFitScore: t.eliteMatchupFit, parkDirection: "positive",
  })).tier !== "ELITE",
  "weak pitcher vulnerability alone blocks ELITE despite batter power + matchup + park",
);
ok(
  computeAttackEnvironment(baseInputs({
    batterPowerScore: t.eliteBatterPower, pitcherVulnerabilityScore: t.elitePitcherVulnerability, matchupFitScore: 4.0, parkDirection: "positive",
  })).tier !== "ELITE",
  "weak matchup fit alone blocks ELITE despite batter power + pitcher + park",
);
ok(
  computeAttackEnvironment(baseInputs({
    batterPowerScore: t.eliteBatterPower, pitcherVulnerabilityScore: t.elitePitcherVulnerability, matchupFitScore: t.eliteMatchupFit, parkDirection: "neutral",
  })).tier !== "ELITE",
  "neutral environment alone blocks ELITE despite batter power + pitcher + matchup",
);

// ── FAVORABLE: two-of-three aligned, not full ELITE bar ───────────────────────
const favorable = computeAttackEnvironment(baseInputs({
  batterPowerScore: 5, pitcherVulnerabilityScore: t.favorablePitcherVulnerability,
  matchupFitScore: t.favorableMatchupFit, parkDirection: "positive", selectedMarketScore: t.favorableMarketScore,
}));
ok(favorable.tier === "FAVORABLE", `favorable-threshold fixture → FAVORABLE (got ${favorable.tier})`);

// ── NEUTRAL is the default/no-op — emits no driver (checked below) ───────────
const neutral = computeAttackEnvironment(baseInputs());
ok(neutral.tier === "NEUTRAL", "all-neutral inputs → NEUTRAL");

// ── HOSTILE: pitcher + matchup + environment only — NOT batter power ─────────
const hostileWeakBatter = computeAttackEnvironment(baseInputs({
  batterPowerScore: 3, pitcherVulnerabilityScore: t.hostilePitcherVulnerability - 0.1,
  matchupFitScore: t.hostileMatchupFit - 0.1, parkDirection: "negative",
}));
ok(hostileWeakBatter.tier === "HOSTILE", `weak batter + hostile legs → HOSTILE (got ${hostileWeakBatter.tier})`);

// The key regression: HOSTILE must be reachable with batterPowerScore >= 8.0
// (independently elite) — it must NOT have a batter-power condition baked in,
// since that's what made the elimination override dead code in an earlier draft.
const hostileElite = computeAttackEnvironment(baseInputs({
  batterPowerScore: 9.0, pitcherVulnerabilityScore: t.hostilePitcherVulnerability - 0.1,
  matchupFitScore: t.hostileMatchupFit - 0.1, parkDirection: "negative",
}));
ok(hostileElite.tier === "HOSTILE", `HOSTILE reachable even with elite batter power (got ${hostileElite.tier})`);
ok(hostileElite.independentlyElite === true, "independentlyElite true at batterPowerScore=9.0");
ok(hostileElite.eliminationEligible === false, "HOSTILE + independentlyElite → eliminationEligible false");
ok(hostileWeakBatter.eliminationEligible === true, "HOSTILE + NOT independentlyElite → eliminationEligible true");

// mixed/unknown environment never produces HOSTILE or ELITE.
ok(
  computeAttackEnvironment(baseInputs({
    pitcherVulnerabilityScore: 2, matchupFitScore: 2, parkDirection: "positive", carryType: "suppress",
  })).tier === "NEUTRAL",
  "mixed park/weather (positive park + suppressive weather) → NEUTRAL, not HOSTILE",
);
ok(
  computeAttackEnvironment(baseInputs({
    batterPowerScore: 9, pitcherVulnerabilityScore: 9, matchupFitScore: 9, parkDirection: "negative", carryType: "boost",
  })).tier === "NEUTRAL",
  "mixed park/weather (negative park + carry boost) → NEUTRAL, not ELITE",
);

// ── appendAttackEnvironmentDrivers: materiality gate ──────────────────────────
function mkScoring(tier: ScoringResult["tier"], suppressedReasons: string[] = []): Pick<ScoringResult, "tier" | "suppressedReasons"> {
  return { tier, suppressedReasons };
}

// ELITE tag only when it actually unlocked elite/nuclear.
{
  const drivers: PowerDriver[] = [];
  appendAttackEnvironmentDrivers(drivers, elite, mkScoring("strong"), "home_runs");
  ok(drivers.length === 0, "ELITE read that did NOT unlock elite/nuclear emits no driver");
}
{
  const drivers: PowerDriver[] = [];
  appendAttackEnvironmentDrivers(drivers, elite, mkScoring("elite"), "home_runs");
  ok(drivers.length === 1 && drivers[0].key === "atkenv_power_env" && drivers[0].label === "Power Environment", "ELITE + unlocked elite + HR market → Power Environment");
}
{
  const drivers: PowerDriver[] = [];
  appendAttackEnvironmentDrivers(drivers, elite, mkScoring("nuclear"), "total_bases");
  ok(drivers.length === 1 && drivers[0].key === "atkenv_extra_base_env" && drivers[0].label === "Extra-Base Environment", "ELITE + unlocked nuclear + TB market → Extra-Base Environment");
}

// FAVORABLE tag distinguishes park-driven from carry-only, using parkDirection
// (not `direction`, which is always "positive" whenever FAVORABLE fires).
{
  const favorableParkDriven = computeAttackEnvironment(baseInputs({
    pitcherVulnerabilityScore: t.favorablePitcherVulnerability, matchupFitScore: t.favorableMatchupFit,
    parkDirection: "positive", carryType: "neutral", selectedMarketScore: t.favorableMarketScore,
  }));
  const drivers: PowerDriver[] = [];
  appendAttackEnvironmentDrivers(drivers, favorableParkDriven, mkScoring("elite"), "home_runs");
  ok(drivers.length === 1 && drivers[0].key === "atkenv_weak_pitcher_park" && drivers[0].label === "Weak Pitcher • Hitter's Park", "FAVORABLE + park-driven + unlocked elite → Hitter's Park tag");
}
{
  const favorableCarryOnly = computeAttackEnvironment(baseInputs({
    pitcherVulnerabilityScore: t.favorablePitcherVulnerability, matchupFitScore: t.favorableMatchupFit,
    parkDirection: "neutral", carryType: "boost", selectedMarketScore: t.favorableMarketScore,
  }));
  const drivers: PowerDriver[] = [];
  appendAttackEnvironmentDrivers(drivers, favorableCarryOnly, mkScoring("elite"), "home_runs");
  ok(drivers.length === 1 && drivers[0].key === "atkenv_weak_pitcher_carry" && drivers[0].label === "Weak Pitcher • Carry Boost", "FAVORABLE + carry-only (park neutral) → Carry Boost tag, not Hitter's Park");
}
{
  // FAVORABLE but did NOT unlock elite (card stayed strong) — no tag at all.
  const favorableParkDriven = computeAttackEnvironment(baseInputs({
    pitcherVulnerabilityScore: t.favorablePitcherVulnerability, matchupFitScore: t.favorableMatchupFit,
    parkDirection: "positive", selectedMarketScore: t.favorableMarketScore,
  }));
  const drivers: PowerDriver[] = [];
  appendAttackEnvironmentDrivers(drivers, favorableParkDriven, mkScoring("strong"), "home_runs");
  ok(drivers.length === 0, "FAVORABLE that did NOT unlock elite emits no driver (materiality check)");
}

// HOSTILE tag fires ONLY when suppressedReasons actually contains the reason.
{
  const drivers: PowerDriver[] = [];
  appendAttackEnvironmentDrivers(drivers, hostileWeakBatter, mkScoring("watch", ["attack_environment_hostile_borderline"]), "home_runs");
  ok(drivers.length === 1 && drivers[0].key === "atkenv_hostile" && drivers[0].label === "Hostile Attack Environment", "HOSTILE + actual suppression → Hostile Attack Environment tag");
}
{
  const drivers: PowerDriver[] = [];
  appendAttackEnvironmentDrivers(drivers, hostileWeakBatter, mkScoring("watch", []), "home_runs");
  ok(drivers.length === 0, "HOSTILE without the suppression reason present emits no driver (e.g. independently-elite override applied upstream)");
}
{
  const drivers: PowerDriver[] = [];
  appendAttackEnvironmentDrivers(drivers, hostileElite, mkScoring("elite", []), "home_runs");
  ok(drivers.length === 0, "HOSTILE + independentlyElite (never suppressed) emits no driver");
}

// NEUTRAL never emits anything regardless of scoring outcome.
{
  const drivers: PowerDriver[] = [];
  appendAttackEnvironmentDrivers(drivers, neutral, mkScoring("elite", []), "home_runs");
  ok(drivers.length === 0, "NEUTRAL tier never emits a driver");
}

console.log(`\nattackEnvironment.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
