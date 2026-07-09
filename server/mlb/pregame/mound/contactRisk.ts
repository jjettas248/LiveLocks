// Mound Radar Component — Contact/HR Susceptibility (weight 0 on score10).
//
// Informational-only, like marketSetups — this component's score10 is never
// passed into composeMoundScore/MOUND_COMPONENT_WEIGHTS, only its threshold-
// crossing driver chips are folded into signal.drivers. Mirrors the REAL
// (non-dead) half of pregamePowerRadar/pitcherVulnerability.ts's formula
// shape (HR/9 + ERA vs batter handedness) — no shared code, no shared
// weights. Savant contact-allowed metrics (barrel%/hard-hit%/fly-ball%) are
// NOT wired here: for a pitcher ID, fetchBaseballSavantData's contact-quality
// fields are computed from a batter-side query that returns near-empty rows
// under the universal-DH rule, so there is no real pitcher-allowed
// contact-quality feed in this codebase today (confirmed true of Plate's own
// pitcherVulnerability.ts too, which never actually passes those three
// optional inputs in production).
//
// Neutral + `available:false` when the pitcher is unknown or no handedness
// splits exist — never fabricated.

import type { ComponentScore, MoundDriver } from "./types";
import { lin, weightedAvg, round1, weightedPlatoonKRate } from "./scoreUtils";

export interface ContactRiskInputs {
  pitcherKnown: boolean;
  opposingLineupConfirmed: boolean;
  hrPer9VsLHB: number | null;
  hrPer9VsRHB: number | null;
  eraVsLHB: number | null;
  eraVsRHB: number | null;
  opposingLineupHandedness: { left: number; right: number; switchHit: number } | null;
}

/** Unweighted fallback blend when lineup handedness composition isn't confirmed yet — HR/9 and ERA vs handedness are informative pitcher-level context even lineup-agnostic. */
function unweightedBlend(vsL: number | null, vsR: number | null): number | null {
  if (vsL != null && vsR != null) return (vsL + vsR) / 2;
  return vsL ?? vsR;
}

export function computeContactRisk(inputs: ContactRiskInputs): ComponentScore {
  const drivers: MoundDriver[] = [];
  const warnings: string[] = [];

  if (!inputs.pitcherKnown) {
    warnings.push("Probable starter unknown");
    return { score10: 5, available: false, drivers, warnings };
  }

  const blendedHr9 =
    inputs.opposingLineupConfirmed && inputs.opposingLineupHandedness
      ? weightedPlatoonKRate(inputs.hrPer9VsLHB, inputs.hrPer9VsRHB, inputs.opposingLineupHandedness)
      : unweightedBlend(inputs.hrPer9VsLHB, inputs.hrPer9VsRHB);
  const blendedEra =
    inputs.opposingLineupConfirmed && inputs.opposingLineupHandedness
      ? weightedPlatoonKRate(inputs.eraVsLHB, inputs.eraVsRHB, inputs.opposingLineupHandedness)
      : unweightedBlend(inputs.eraVsLHB, inputs.eraVsRHB);

  const sHr9 = blendedHr9 != null ? lin(blendedHr9, 0.6, 2.2) : null;
  const sEra = blendedEra != null ? lin(blendedEra, 2.8, 6.0) : null;

  const { score, coverage } = weightedAvg([
    { value: sHr9, weight: 4 },
    { value: sEra, weight: 2 },
  ]);

  if (coverage === 0) {
    warnings.push("No pitcher handedness splits available for contact risk");
    return { score10: 5, available: false, drivers, warnings };
  }

  const evidence = `HR/9 ${round1(blendedHr9 ?? 0)} · ERA ${round1(blendedEra ?? 0)}`;

  // Exactly two grades, at the tails only — no middle ground, mirrors
  // marketTagger.ts's marketSetupLabel() "no Solid/Watch middle ground" rule.
  if (score >= 6.5) {
    drivers.push({ key: "cr_high", label: "Hit/HR Susceptible: High", direction: "negative", weight: Math.round(score * 10), evidence });
  } else if (score <= 3.5) {
    drivers.push({ key: "cr_low", label: "Hit/HR Susceptible: Low", direction: "positive", weight: Math.round((10 - score) * 10), evidence });
  }

  return { score10: round1(score), available: true, drivers, warnings };
}
