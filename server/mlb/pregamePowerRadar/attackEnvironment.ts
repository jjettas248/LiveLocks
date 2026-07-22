// Attack Environment — pitcher × park/weather × matchup-fit interaction (weight 0
// on score10). Reuses already-computed component scores/drivers ONLY — never reads
// raw stats — so pitcher/park/matchup evidence that already feeds score10 through
// its own weighted component is never counted a second time here.
//
// This is a gate/tag layer, not a second scoring model:
//   • ELITE / FAVORABLE change which tier LABEL a given score10 can reach
//     (classifyTier), never the numeric score10 itself.
//   • HOSTILE's only behavioral effect is suppressing an otherwise-publishable
//     borderline (score10 in [PUBLISH_MIN_SCORE, borderlineScore)) candidate —
//     it does NOT participate in eliteBlocked/downgradeReasons, because its own
//     thresholds (pitcherVulnerabilityScore < 5.0) can never satisfy classifyTier's
//     elite/nuclear gate (pitcherVulnerabilityScore >= 6.0) in the first place.
//   • Tags are emitted only when they materially changed the outcome — see
//     appendAttackEnvironmentDrivers().
//
// Scope: power-family interaction covering Home Runs + Total Bases only (Hits/RBI
// are Phase-5, not built — PregamePowerActiveMarket makes that a compile-time
// boundary at the call sites that consume primaryMarket, not here).

import type { PowerDriver } from "./types";
import type { PregamePowerActiveMarket } from "./marketTagger";
import type { ScoringResult } from "./scoring";

export type AttackEnvironmentDirection = "positive" | "negative" | "mixed" | "neutral" | "unknown";

/**
 * Mutually exclusive park+weather read. `mixed` (e.g. a hitter-friendly park
 * coinciding with suppressive wind) and `unknown` (no data) both fold into
 * Attack Environment NEUTRAL downstream — conflicting or absent evidence must
 * never be treated as alignment in either direction.
 */
export function classifyEnvironmentDirection(
  parkDirection: "positive" | "negative" | "neutral",
  carryType: "boost" | "suppress" | "neutral" | "unknown",
): AttackEnvironmentDirection {
  if (carryType === "unknown" && parkDirection === "neutral") return "unknown";
  const hasPositive = parkDirection === "positive" || carryType === "boost";
  const hasNegative = parkDirection === "negative" || carryType === "suppress";
  if (hasPositive && hasNegative) return "mixed";
  if (hasPositive) return "positive";
  if (hasNegative) return "negative";
  return "neutral";
}

/**
 * Derived from the park component's OWN drivers only (pw_park / pw_park_pitcher) —
 * never from the broader unioned drivers array. The park component owns this
 * interpretation.
 */
export function getParkDirection(parkWeatherDrivers: PowerDriver[]): "positive" | "negative" | "neutral" {
  if (parkWeatherDrivers.some((d) => d.key === "pw_park")) return "positive";
  if (parkWeatherDrivers.some((d) => d.key === "pw_park_pitcher")) return "negative";
  return "neutral";
}

export type AttackEnvironmentTier = "ELITE" | "FAVORABLE" | "NEUTRAL" | "HOSTILE";

export type AttackEnvironmentCohort =
  | "pitcher_and_environment"
  | "pitcher_only"
  | "environment_only"
  | "neither";

export interface AttackEnvironmentInputs {
  batterPowerScore: number; // Component 1 — already feeds score10
  pitcherVulnerabilityScore: number; // Component 2 — already feeds score10
  matchupFitScore: number; // Component 3 — the actual exploit-fit signal
  parkDirection: "positive" | "negative" | "neutral"; // from getParkDirection()
  carryType: "boost" | "suppress" | "neutral" | "unknown";
  selectedMarketScore: number; // marketTagger's hrScore or tbScore for primaryMarket
  // NOTE: parkWeatherScore (the raw 0-10 component score) is deliberately NOT an
  // input — the tier logic reads only parkDirection/carryType (qualitative,
  // already-derived evidence), never the numeric score. `primaryMarket` is also
  // NOT an input — nothing in the tier logic below branches on it (only
  // selectedMarketScore, which the caller already resolved using primaryMarket).
  // The market value is still needed by callers directly (to resolve
  // selectedMarketScore and to pick HR-vs-TB tag text below).
}

export interface AttackEnvironmentResult {
  tier: AttackEnvironmentTier;
  direction: AttackEnvironmentDirection;
  /** Preserved verbatim from inputs so tag selection can tell "park-driven" apart
   *  from "weather-only" — `direction` alone can't, since FAVORABLE always implies
   *  direction === "positive". */
  parkDirection: "positive" | "negative" | "neutral";
  carryType: "boost" | "suppress" | "neutral" | "unknown";
  cohort: AttackEnvironmentCohort;
  /** batterPowerScore >= 8.0 — a DIAGNOSTIC flag only; it does not gate HOSTILE's
   *  own definition. It is the sole guard against eliminating a clearly-elite
   *  hitter (see eliminationEligible). */
  independentlyElite: boolean;
  /** HOSTILE and not independentlyElite. The only value scoring.ts consumes to
   *  decide suppression — it must never recompute the 8.0 threshold itself. */
  eliminationEligible: boolean;
}

export const ATTACK_ENVIRONMENT_THRESHOLDS = {
  eliteBatterPower: 7.0,
  independentBatterElite: 8.0,
  elitePitcherVulnerability: 6.5,
  favorablePitcherVulnerability: 5.5,
  hostilePitcherVulnerability: 5.0,
  eliteMatchupFit: 6.5,
  favorableMatchupFit: 6.0,
  hostileMatchupFit: 5.0,
  favorableMarketScore: 7.0,
  borderlineScore: 6.5,
  // NOTE: no `hostileBatterPower`. HOSTILE is defined ONLY over the three
  // interaction legs (pitcher/matchup/environment) — batter power plays no role
  // in the HOSTILE condition itself, which is what lets a genuinely elite hitter
  // (batterPowerScore >= 8.0) be diagnostically HOSTILE while still being
  // protected from elimination via `independentlyElite`/`eliminationEligible`.
} as const;

export function classifyAttackEnvironmentCohort(
  pitcherVulnerabilityScore: number,
  direction: AttackEnvironmentDirection,
): AttackEnvironmentCohort {
  const pitcherFavorable = pitcherVulnerabilityScore >= ATTACK_ENVIRONMENT_THRESHOLDS.favorablePitcherVulnerability;
  const environmentFavorable = direction === "positive";
  if (pitcherFavorable && environmentFavorable) return "pitcher_and_environment";
  if (pitcherFavorable) return "pitcher_only";
  if (environmentFavorable) return "environment_only";
  return "neither";
}

export function computeAttackEnvironment(inputs: AttackEnvironmentInputs): AttackEnvironmentResult {
  const t = ATTACK_ENVIRONMENT_THRESHOLDS;
  const direction = classifyEnvironmentDirection(inputs.parkDirection, inputs.carryType);
  const independentlyElite = inputs.batterPowerScore >= t.independentBatterElite;
  const environmentPositive = direction === "positive";
  const environmentHostile = direction === "negative";
  // mixed/neutral/unknown → neither positive nor hostile → falls through to NEUTRAL

  const elite =
    inputs.batterPowerScore >= t.eliteBatterPower &&
    inputs.pitcherVulnerabilityScore >= t.elitePitcherVulnerability &&
    inputs.matchupFitScore >= t.eliteMatchupFit &&
    environmentPositive;

  const favorable =
    !elite &&
    inputs.selectedMarketScore >= t.favorableMarketScore &&
    inputs.pitcherVulnerabilityScore >= t.favorablePitcherVulnerability &&
    inputs.matchupFitScore >= t.favorableMatchupFit &&
    environmentPositive;

  // HOSTILE is the three interaction legs only — no batter-power condition, so it
  // CAN coexist with independentlyElite. The elimination path (scoring.ts) is what
  // actually protects an elite batter, not this classification.
  const hostile =
    inputs.pitcherVulnerabilityScore < t.hostilePitcherVulnerability &&
    inputs.matchupFitScore < t.hostileMatchupFit &&
    environmentHostile;

  const tier: AttackEnvironmentTier = elite ? "ELITE" : favorable ? "FAVORABLE" : hostile ? "HOSTILE" : "NEUTRAL";
  const cohort = classifyAttackEnvironmentCohort(inputs.pitcherVulnerabilityScore, direction);

  return {
    tier,
    direction,
    cohort,
    independentlyElite,
    parkDirection: inputs.parkDirection,
    carryType: inputs.carryType,
    eliminationEligible: tier === "HOSTILE" && !independentlyElite,
  };
}

/**
 * Appends zero-weight tag drivers to `drivers`, mutating it in place — called
 * AFTER `composePregameScore` has run, so it can check whether the gate actually
 * changed the outcome (unlocked a higher tier, or actually suppressed the
 * candidate). A tier read that changed nothing emits no driver at all.
 */
export function appendAttackEnvironmentDrivers(
  drivers: PowerDriver[],
  ae: AttackEnvironmentResult,
  scoring: Pick<ScoringResult, "tier" | "suppressedReasons">,
  primaryMarket: PregamePowerActiveMarket,
): void {
  const unlockedElite = scoring.tier === "elite" || scoring.tier === "nuclear";

  if (ae.tier === "ELITE" && unlockedElite) {
    drivers.push({
      key: primaryMarket === "home_runs" ? "atkenv_power_env" : "atkenv_extra_base_env",
      label: primaryMarket === "home_runs" ? "Power Environment" : "Extra-Base Environment",
      direction: "positive",
      weight: 0,
    });
  } else if (ae.tier === "FAVORABLE" && scoring.tier === "elite") {
    // FAVORABLE always implies ae.direction === "positive" (it's part of
    // FAVORABLE's own gate), so branching on `direction` here would make
    // "Carry Boost" unreachable dead code. Branch on the preserved
    // `parkDirection` input instead — the only way to tell "the park itself is
    // hitter-friendly" apart from "the park is neutral but today's wind/
    // temperature happens to be favorable."
    const parkDriven = ae.parkDirection === "positive";
    drivers.push({
      key: parkDriven ? "atkenv_weak_pitcher_park" : "atkenv_weak_pitcher_carry",
      label: parkDriven ? "Weak Pitcher • Hitter's Park" : "Weak Pitcher • Carry Boost",
      direction: "positive",
      weight: 0,
    });
  } else if (ae.tier === "HOSTILE" && scoring.suppressedReasons.includes("attack_environment_hostile_borderline")) {
    // The ONLY condition that fires this tag — HOSTILE alone (e.g. an
    // independently-elite batter reading HOSTILE, or a HOSTILE candidate scoring
    // >= 6.5) never suppresses, so it never emits this tag either.
    drivers.push({ key: "atkenv_hostile", label: "Hostile Attack Environment", direction: "negative", weight: 0 });
  }
  // NEUTRAL, or a positive/hostile read that changed nothing: no driver.
}
