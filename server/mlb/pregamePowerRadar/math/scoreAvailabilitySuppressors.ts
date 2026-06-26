// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: availability suppressors → penalty term
//
// Pure. Returns a NON-NEGATIVE penalty (subtracted from the per-PA logit) plus a
// list of suppressor labels and a confidence-damage factor. Suppressors model
// opportunity/availability risk (late scratch, rest day, platoon sub) — they can
// only HURT a candidate, never inflate it (task §P).
// ─────────────────────────────────────────────────────────────────────────────

import type { AvailabilitySuppressorInputs } from "./mathTypes";

export const SUPPRESSOR_MAX_PENALTY = 0.8;

export interface SuppressorResult {
  key: "availabilitySuppressors";
  /** Non-negative log-odds penalty to SUBTRACT from the per-PA logit. */
  penaltyLogOdds: number;
  /** Multiplicative confidence damage in [0,1] (1 = no damage). */
  confidenceFactor: number;
  suppressors: string[];
  available: boolean;
}

export function scoreAvailabilitySuppressors(
  inp: AvailabilitySuppressorInputs | null | undefined,
): SuppressorResult {
  const suppressors: string[] = [];
  let penalty = 0;
  let confidenceFactor = 1;

  if (!inp) {
    return {
      key: "availabilitySuppressors",
      penaltyLogOdds: 0,
      confidenceFactor: 1,
      suppressors,
      available: false,
    };
  }

  // Explicitly not active / confirmed scratch → hard suppression.
  if (inp.confirmedActive === false) {
    suppressors.push("not_confirmed_active");
    penalty += 0.6;
    confidenceFactor *= 0.5;
  }
  if (inp.lateScratchRisk === true) {
    suppressors.push("late_scratch_risk");
    penalty += 0.3;
    confidenceFactor *= 0.85;
  }
  if (inp.restDayRisk === true) {
    suppressors.push("rest_day_risk");
    penalty += 0.25;
    confidenceFactor *= 0.9;
  }
  if (inp.platoonSubRisk === true) {
    suppressors.push("platoon_sub_risk");
    penalty += 0.2;
    confidenceFactor *= 0.9;
  }

  return {
    key: "availabilitySuppressors",
    penaltyLogOdds: Math.min(penalty, SUPPRESSOR_MAX_PENALTY),
    confidenceFactor,
    suppressors,
    available: true,
  };
}
