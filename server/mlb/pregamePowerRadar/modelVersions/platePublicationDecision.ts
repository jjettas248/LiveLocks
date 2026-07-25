// The Plate — the single authoritative publication gate.
//
// Publication is NOT `!suppressed`. Suppression is a scoring-layer verdict;
// publication additionally requires tier eligibility, a score floor, an evidence
// minimum, data coverage, batter-power availability, a posted lineup, and the
// pregame/non-official flags. `!suppressed` is a strictly weaker condition and
// substituting it silently over-counts public candidates.
//
// Every consumer routes through this function:
//   • evaluatePlateModel  — stamps publicEligible onto the model evaluation
//   • diagnostics.ts      — wasPubliclyFlaggedPregame delegates here
//   • comparison analytics — reads the stamped value, never re-derives
//
// The evidence clause is the one genuinely policy-dependent term:
//   champion   → positiveDriverCount >= 2 (July-20 driver universe)
//   challenger → evidenceFamilyCount >= 2, with the legacy driver-count veto

import type { PregamePowerTier } from "../types";
import type { PlateModelPolicy, PlatePublicationResult } from "./plateModelTypes";

export const PUBLICATION_MIN_SCORE = 6.0;
export const PUBLICATION_MIN_DATA_COVERAGE = 0.6;
export const PUBLICATION_MIN_EVIDENCE = 2;

/**
 * Everything the publication decision reads. Deliberately a flat, primitive
 * struct so both a live evaluation and a rehydrated DB row can produce one
 * without either becoming the other's shape.
 */
export interface PlatePublicationInput {
  tier: PregamePowerTier;
  score10: number;
  suppressed: boolean;
  /** Positive drivers counted against the policy's own driver universe. */
  positiveDriverCount: number;
  evidenceFamilyCount: number;
  dataCoverageScore: number;
  batterPowerAvailable: boolean;
  lineupStatus: string;
  isOfficialPlay: boolean;
  isPregameTarget: boolean;
}

/** Tiers that may surface publicly. Bare `watch`/`track` never do. */
export function isPubliclyEligibleTier(tier: PregamePowerTier): boolean {
  return tier === "power_watch" || tier === "strong" || tier === "elite" || tier === "nuclear";
}

export function decidePlatePublication(
  input: PlatePublicationInput,
  policy: PlateModelPolicy,
): PlatePublicationResult {
  const ineligibleReasons: string[] = [];

  if (input.lineupStatus !== "posted") ineligibleReasons.push("lineup_not_posted");
  if (!isPubliclyEligibleTier(input.tier)) ineligibleReasons.push("tier_not_eligible");
  if (input.score10 < PUBLICATION_MIN_SCORE) ineligibleReasons.push("below_publish_score");

  // Evidence minimum — the only policy-forked clause.
  if (policy.gates.evidenceFamilyGate) {
    // Independent families are the authority; the historical chip count is
    // retained as a one-way veto (41c8978) — it can suppress, never rescue.
    if (
      input.evidenceFamilyCount < PUBLICATION_MIN_EVIDENCE ||
      input.positiveDriverCount < PUBLICATION_MIN_EVIDENCE
    ) {
      ineligibleReasons.push("insufficient_evidence_families");
    }
  } else if (input.positiveDriverCount < PUBLICATION_MIN_EVIDENCE) {
    ineligibleReasons.push("insufficient_drivers");
  }

  if (input.dataCoverageScore < PUBLICATION_MIN_DATA_COVERAGE) {
    ineligibleReasons.push("insufficient_data_coverage");
  }
  if (!input.batterPowerAvailable) ineligibleReasons.push("batter_power_unavailable");
  if (input.isOfficialPlay) ineligibleReasons.push("is_official_play");
  if (!input.isPregameTarget) ineligibleReasons.push("not_pregame_target");
  if (input.suppressed) ineligibleReasons.push("suppressed");

  return { publicEligible: ineligibleReasons.length === 0, ineligibleReasons };
}
