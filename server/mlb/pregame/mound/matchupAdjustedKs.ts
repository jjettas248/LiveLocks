// Mound Radar — Matchup-Adjusted Ks (display-only enrichment).
//
// "Projected Ks" (projectedStrikeoutsFromKPer9 in scoreUtils.ts) is a locked
// settlement baseline — it decides mound_win/mound_calibration_miss and must
// stay a simple, stable, ungameable season-pace number. This module computes
// a SEPARATE, richer number for user context only: never fed into score10,
// tier, drivers, market selection, grading, or moundOutcomeAttribution.ts's
// settlement logic. Closed-form deterministic arithmetic only — no random
// sampling, no Monte Carlo (this repo has none anywhere; see
// hrRadarLiveOnly.test.ts).
//
// Inputs, all real and already fetched elsewhere in the build (never
// fabricated; each degrades to neutral/no-op when its data is unavailable):
//   - Current + prior-2-seasons K/9, Marcel-style recency-weighted blend
//     (5/4/3, current season heaviest)
//   - Opponent lineup's platoon strikeout-rate profile (same weighting as
//     opponentKProfile.ts's score10, via the shared weightedPlatoonKRate)
//   - Aggregate BvP: today's confirmed opposing lineup's historical
//     strikeouts vs THIS pitcher (sample-size shrunk, mirrors
//     pregamePowerRadar/matchupFit.ts's BvP shrinkage discipline)
//   - Run environment (same score10 computeRunEnvironment already produces —
//     reused as a small, honestly-labeled general proxy; no K-specific park
//     factor exists in this codebase, so this stays a narrow nudge, not a
//     precise adjustment)
//   - Recent-start K trend vs. season pace (same delta recentForm.ts scores)

import { clamp, round1, seasonKPer9ToPerStartExpectation } from "./scoreUtils";

/** Roughly league-average K rate per PA — same constant family as the 0.18–0.32 working range opponentKProfile.ts's lin() uses. */
const LEAGUE_AVG_PLATOON_K_RATE = 0.223;

const OPPONENT_MODIFIER_MIN = 0.85;
const OPPONENT_MODIFIER_MAX = 1.15;

const BVP_MIN_SAMPLE_AB = 15;
const BVP_FULL_CONFIDENCE_AB = 60;
const BVP_MODIFIER_MIN = 0.9;
const BVP_MODIFIER_MAX = 1.1;

const RUN_ENV_MODIFIER_MIN = 0.95;
const RUN_ENV_MODIFIER_MAX = 1.05;
const RUN_ENV_WEIGHT = 0.01;

const RECENT_FORM_NUDGE_CAP = 1.5;
const RECENT_FORM_WEIGHT = 0.5;

const OVERALL_MIN_MULT = 0.65;
const OVERALL_MAX_MULT = 1.4;

export interface MatchupAdjustedKsInputs {
  kPer9: number | null;
  /** Prior seasons' K/9, most-recent-first (from PitcherMultiYearStats). Enrichment only — never a substitute for a missing current-season kPer9. */
  priorSeasonsKPer9: number[];
  avgInningsPerStart: number | null;
  /** Lineup-weighted platoon K-rate — pass the same value opponentKProfile.ts derives via weightedPlatoonKRate(). */
  platoonKRate: number | null;
  opposingLineupConfirmed: boolean;
  /** Same 0–10 score computeRunEnvironment() already produces for this start. */
  runEnvironmentScore10: number | null;
  runEnvironmentAvailable: boolean;
  last3StartStrikeouts: number[] | null;
  /** Aggregate BvP across today's confirmed opposing lineup vs this pitcher. */
  bvpTotalAtBats: number;
  bvpTotalStrikeouts: number;
}

/** Marcel-style recency-weighted K/9 blend: current season weighted heaviest, each prior season progressively lighter. Falls back to the current season alone when no prior-season data clears the IP floor. */
function blendKPer9(kPer9: number, priorSeasonsKPer9: number[]): number {
  const weights = [5, 4, 3]; // [current, year-1, year-2]
  const values = [kPer9, ...priorSeasonsKPer9].slice(0, weights.length);
  let sum = 0;
  let wsum = 0;
  values.forEach((v, i) => {
    sum += v * weights[i];
    wsum += weights[i];
  });
  return sum / wsum;
}

export function computeMatchupAdjustedStrikeouts(inputs: MatchupAdjustedKsInputs): number | null {
  if (inputs.kPer9 == null) return null;

  const blendedKPer9 = blendKPer9(inputs.kPer9, inputs.priorSeasonsKPer9);

  const base =
    inputs.avgInningsPerStart != null
      ? (blendedKPer9 * inputs.avgInningsPerStart) / 9
      : seasonKPer9ToPerStartExpectation(blendedKPer9);

  const opponentModifier =
    inputs.opposingLineupConfirmed && inputs.platoonKRate != null
      ? clamp(inputs.platoonKRate / LEAGUE_AVG_PLATOON_K_RATE, OPPONENT_MODIFIER_MIN, OPPONENT_MODIFIER_MAX)
      : 1;

  let bvpModifier = 1;
  if (inputs.opposingLineupConfirmed && inputs.bvpTotalAtBats >= BVP_MIN_SAMPLE_AB) {
    const bvpKRate = inputs.bvpTotalStrikeouts / inputs.bvpTotalAtBats;
    const rawRatio = clamp(bvpKRate / LEAGUE_AVG_PLATOON_K_RATE, OPPONENT_MODIFIER_MIN, OPPONENT_MODIFIER_MAX);
    const shrink = Math.min(1, inputs.bvpTotalAtBats / BVP_FULL_CONFIDENCE_AB);
    bvpModifier = clamp(1 + (rawRatio - 1) * shrink, BVP_MODIFIER_MIN, BVP_MODIFIER_MAX);
  }

  const runEnvModifier =
    inputs.runEnvironmentAvailable && inputs.runEnvironmentScore10 != null
      ? clamp(1 + (inputs.runEnvironmentScore10 - 5) * RUN_ENV_WEIGHT, RUN_ENV_MODIFIER_MIN, RUN_ENV_MODIFIER_MAX)
      : 1;

  const avgRecentK =
    inputs.last3StartStrikeouts && inputs.last3StartStrikeouts.length > 0
      ? inputs.last3StartStrikeouts.reduce((a, b) => a + b, 0) / inputs.last3StartStrikeouts.length
      : null;
  const recentFormNudge =
    avgRecentK != null
      ? clamp(avgRecentK - seasonKPer9ToPerStartExpectation(blendedKPer9), -RECENT_FORM_NUDGE_CAP, RECENT_FORM_NUDGE_CAP) *
        RECENT_FORM_WEIGHT
      : 0;

  const adjusted = base * opponentModifier * bvpModifier * runEnvModifier + recentFormNudge;
  const bounded = clamp(adjusted, base * OVERALL_MIN_MULT, base * OVERALL_MAX_MULT);
  return round1(bounded);
}
