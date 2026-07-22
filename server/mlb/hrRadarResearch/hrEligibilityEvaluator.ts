// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — eligibility evaluator (PR 2).
//
// Every active lineup batter gets a snapshot row regardless of eligibility —
// exclusion never means "skip the row," it means eligible=false + a named
// reason (HR_RADAR_EXCLUSION_REASONS). First-match-wins order below mirrors
// the natural precedence of these conditions (missing identity is checked
// before anything else can even be evaluated; a positive-probability check
// is last since it depends on the champion having actually run).
// ─────────────────────────────────────────────────────────────────────────────

import type { HrExclusionReason } from "./hrEligibilityContract";

export interface HrEligibilityInput {
  hasResolvedPlayerId: boolean;
  gameStatus: "live" | "pregame" | "final" | "unknown" | "suspended" | "postponed";
  stillInBattingOrder: boolean;
  alreadyHomeredThisGame: boolean;
  remainingPaEstimate: number | null;
  // null when the champion did not evaluate this batter at all this epoch
  // (championEvaluated=false) — distinct from "evaluated and found no edge."
  championModeledProbabilityPositive: boolean | null;
}

export interface HrEligibilityResult {
  eligible: boolean;
  exclusionReason: HrExclusionReason | null;
}

export function evaluateHrEligibility(input: HrEligibilityInput): HrEligibilityResult {
  if (!input.hasResolvedPlayerId) {
    return { eligible: false, exclusionReason: "identity_missing" };
  }
  if (input.gameStatus === "suspended" || input.gameStatus === "postponed") {
    return { eligible: false, exclusionReason: "suspended_or_postponed_game" };
  }
  if (!input.stillInBattingOrder) {
    return { eligible: false, exclusionReason: "lineup_removed_or_substituted" };
  }
  if (input.alreadyHomeredThisGame) {
    return { eligible: false, exclusionReason: "already_homered_this_game" };
  }
  if (input.remainingPaEstimate != null && input.remainingPaEstimate <= 0) {
    return { eligible: false, exclusionReason: "no_remaining_pa" };
  }
  if (input.championModeledProbabilityPositive === false) {
    return { eligible: false, exclusionReason: "no_positive_modeled_probability" };
  }
  return { eligible: true, exclusionReason: null };
}
