// HR Radar Live — v2 Shadow Model: additive advanced-context layer.
// ─────────────────────────────────────────────────────────────────────────
// SHADOW MODE ONLY. Pure assembly of the 15 advanced-context components into
// a single SIGNED point adjustment, plus the availability inventory.
//
// Boost math (no hidden optimism):
//   componentDelta  = componentScore01 - 0.5      // 0.5 = neutral = 0 effect
//   componentPoints = weight_i * componentDelta * MAX_COMPONENT_IMPACT
//   rawBoost        = Σ componentPoints  over NON-NULL components only
//   boostPoints     = clamp(rawBoost, -12.5, +17.5)
//
//   • Missing components are EXCLUDED — never imputed to 0.5, never
//     renormalized. Sparse advanced data therefore has *limited* influence,
//     never amplified influence.
//   • Weights sum to 1.0, MAX_COMPONENT_IMPACT = 35 ⇒ all-max ⇒ +17.5,
//     all-min ⇒ -17.5 (clamped to -12.5: deliberately more cautious on the
//     downside vs upside, per spec).
//
// Today almost every advanced component is null because the canonical HR
// Radar state does not carry the required feeds (pitch-type splits, zone
// data, spray angle, park geometry, market odds, calibration buckets, etc.).
// That is correct: missing → null → excluded → zero boost.

import type { HRRadarAdvancedContext, HRRadarV2Input, Score01 } from "./hrRadarV2Types";
import {
  scoreBatterFatigue,
  scoreCommandDeterioration,
  scoreCountLeverage,
  scoreDriverCalibration,
  scoreGameStateAttack,
  scoreMarketConfirmation,
  scoreParkGeometryFit,
  scorePitchTypeDamage,
  scorePitcherPitchTypeVulnerability,
  scorePullAirIntent,
  scoreSimilarityMatchup,
  scoreSwingDecisionForm,
  scoreUmpCatcherContext,
  scoreWindSprayFit,
  scoreZoneMistakeRisk,
} from "./hrRadarAdvancedScoring";

// Per-component weights for the boost (sum = 1.0). Order/values per spec.
const BOOST_WEIGHTS = {
  batterPitchTypeDamageScore: 0.13,
  pitcherPitchTypeVulnerabilityScore: 0.13,
  zoneMistakeRiskScore: 0.13,
  pullAirIntentScore: 0.1,
  parkGeometryFitScore: 0.1,
  windSprayFitScore: 0.07,
  commandDeteriorationScore: 0.1,
  countLeverageScore: 0.07,
  gameStateAttackScore: 0.05,
  swingDecisionFormScore: 0.05,
  marketConfirmationScore: 0.03,
  driverCalibrationBoost: 0.04,
} as const;

type BoostComponentKey = keyof typeof BOOST_WEIGHTS;

const MAX_COMPONENT_IMPACT = 35; // points; calibrated so all-max ⇒ +17.5
export const ADVANCED_BOOST_MAX_POINTS = 17.5;
export const ADVANCED_BOOST_MIN_POINTS = -12.5;

function clampBoost(points: number): number {
  if (!Number.isFinite(points)) return 0;
  return Math.max(ADVANCED_BOOST_MIN_POINTS, Math.min(ADVANCED_BOOST_MAX_POINTS, points));
}

// The future-feed stats this layer would consume once available. Listed in
// missingStats so the inventory is explicit and honest.
const FUTURE_FEED_STATS = [
  "batter_pitch_type_damage_splits",
  "pitcher_pitch_type_vulnerability_splits",
  "zone_location_mistake_data",
  "pull_side_air_spray_profile",
  "park_sector_geometry",
  "wind_by_spray_vector",
  "command_by_zone",
  "swing_decision_today (chase/whiff/zone-contact)",
  "count_balls_strikes",
  "game_state_outs_runners_score",
  "similarity_archetype",
  "ump_catcher_context",
  "batter_fatigue_rest_travel",
  "live_hr_prop_odds_movement",
  "driver_calibration_buckets",
];

/**
 * Build the advanced-context layer. Pure. Today this returns a fully-null
 * component set (all future-feed) plus a zero boost — by design. The data
 * params are threaded through so a future PR can populate real feeds without
 * changing the boost math or any caller.
 */
export function buildAdvancedContext(input: HRRadarV2Input): HRRadarAdvancedContext {
  // Every advanced scorer is called with the real data the input actually
  // carries. Today the canonical state carries none of these feeds, so each
  // returns null. NO proxy is computed for any of them.
  const components: Record<BoostComponentKey, Score01 | null> = {
    batterPitchTypeDamageScore: scorePitchTypeDamage(null),
    pitcherPitchTypeVulnerabilityScore: scorePitcherPitchTypeVulnerability(null),
    zoneMistakeRiskScore: scoreZoneMistakeRisk(null),
    pullAirIntentScore: scorePullAirIntent(null),
    parkGeometryFitScore: scoreParkGeometryFit(null),
    windSprayFitScore: scoreWindSprayFit(null),
    commandDeteriorationScore: scoreCommandDeterioration(null),
    countLeverageScore: scoreCountLeverage(null),
    gameStateAttackScore: scoreGameStateAttack(null),
    swingDecisionFormScore: scoreSwingDecisionForm(null),
    marketConfirmationScore: scoreMarketConfirmation(null),
    driverCalibrationBoost: scoreDriverCalibration(null),
  };

  // Diagnostics-only components (NOT part of the boost).
  const similarityMatchupScore = scoreSimilarityMatchup(null);
  const umpCatcherContextScore = scoreUmpCatcherContext(null);
  const batterFatigueSuppressor = scoreBatterFatigue(null);

  // Signed-delta boost over NON-NULL components only. No renormalization.
  let rawBoost = 0;
  let availableComponentCount = 0;
  const keys = Object.keys(BOOST_WEIGHTS) as BoostComponentKey[];
  for (const key of keys) {
    const score = components[key];
    if (score == null) continue; // excluded — not imputed, not renormalized
    availableComponentCount += 1;
    const delta = score - 0.5;
    rawBoost += BOOST_WEIGHTS[key] * delta * MAX_COMPONENT_IMPACT;
  }
  const advancedContextBoostPoints = clampBoost(rawBoost);

  return {
    ...components,
    similarityMatchupScore,
    umpCatcherContextScore,
    batterFatigueSuppressor,

    advancedContextBoostPoints,
    availableComponentCount,
    totalComponentCount: keys.length,

    availableStats: [...input.availableStats],
    derivableStats: [...input.derivableStats],
    missingStats: dedupe([...input.missingStats, ...FUTURE_FEED_STATS]),
    diagnosticsOnlyStats: [...input.diagnosticsOnlyStats],
    diagnostics: {
      note: "All advanced components null today — required feeds not endpoint-accessible. Boost = 0.",
      rawBoostBeforeClamp: rawBoost,
      maxComponentImpact: MAX_COMPONENT_IMPACT,
    },
  };
}

/**
 * Test/utility helper: compute the boost points from an explicit component
 * map using the exact production weights + clamp. Lets tests prove
 * neutral→0, missing→excluded, weak→negative, strong→positive without
 * needing real feeds. Pure.
 */
export function computeAdvancedBoostPoints(
  components: Partial<Record<BoostComponentKey, Score01 | null>>,
): { boostPoints: number; availableComponentCount: number; rawBoost: number } {
  let rawBoost = 0;
  let availableComponentCount = 0;
  const keys = Object.keys(BOOST_WEIGHTS) as BoostComponentKey[];
  for (const key of keys) {
    const score = components[key];
    if (score == null) continue;
    availableComponentCount += 1;
    rawBoost += BOOST_WEIGHTS[key] * (score - 0.5) * MAX_COMPONENT_IMPACT;
  }
  return { boostPoints: clampBoost(rawBoost), availableComponentCount, rawBoost };
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs.filter(Boolean)));
}
