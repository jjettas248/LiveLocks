// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — eligibility / prediction-scope contract (PR 1).
//
// Names the prediction target explicitly: HR Radar research predicts a
// player's FIRST home run of the game for the standard live market.
// Excluding a batter who already homered is valid ONLY under this named
// scope — it is not a claim that second-HR probability is zero. If a future
// PR ever predicts additional-HR probability, it must declare a new,
// separately-named scope rather than silently reusing this one.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const HR_RADAR_PREDICTION_SCOPE = "first_hr_of_game" as const;
export const hrPredictionScopeSchema = z.literal(HR_RADAR_PREDICTION_SCOPE);
export type HrPredictionScope = z.infer<typeof hrPredictionScopeSchema>;

// Controlled vocabulary for hr_radar_evaluation_snapshots.exclusion_reason.
export const HR_RADAR_EXCLUSION_REASONS = [
  // Batter already hit a HR this game — valid ONLY under HR_RADAR_PREDICTION_SCOPE.
  "already_homered_this_game",
  "no_remaining_pa",
  "lineup_removed_or_substituted",
  "identity_missing",
  "suspended_or_postponed_game",
  "no_positive_modeled_probability",
] as const;

export const hrExclusionReasonSchema = z.enum(HR_RADAR_EXCLUSION_REASONS);
export type HrExclusionReason = z.infer<typeof hrExclusionReasonSchema>;
