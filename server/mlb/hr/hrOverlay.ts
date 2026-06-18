// HR Overlay — orchestrator.
// Runs T (temporal filter) → sub-engines Ψ/Γ/Λ/Θ/Δ → soft gate K →
// final overlayMultiplier = clamp((1 + Ω) · K, [0.6, 1.6]).
//
// Integration point: called from computeHRConversionProbability in
// hrConversionModel.ts. Replaces powerMultiplier × slotMultiplier × recentFormMult.

import { SUB_ENGINE_WEIGHTS, OVERLAY_CLAMP } from "./hrOverlayConstants";
import { applySeasonTriadWeighting } from "./temporalFilter";
import {
  computePowerProfile,
  computeArsenalMatchupFit,
  computeLaunchTopology,
  computeLineupVolume,
  computeRecencyDelta,
  computeSoftGate,
} from "./subEngines";
import type {
  HROverlayInput,
  HROverlayResult,
  DataCoverage,
  OverlayComponentResult,
} from "./hrOverlayTypes";

export type { HROverlayInput, HROverlayResult };

export function computeHROverlay(input: HROverlayInput): HROverlayResult {
  // 1. Temporal triad weighting — blend multi-season bundles when provided.
  let effectiveInput = input;
  let triadCoverage: DataCoverage = "PARTIAL"; // default when no bundles
  if (input.seasonBundles && input.seasonBundles.length > 0) {
    const { blended, coverage, presentSeasons } = applySeasonTriadWeighting(input.seasonBundles);
    if (presentSeasons.length > 0) {
      effectiveInput = { ...input, ...blended };
      triadCoverage = coverage;
    } else {
      triadCoverage = "MISSING";
    }
  }

  // 2. Run sub-engines.
  const psi: OverlayComponentResult = computePowerProfile(effectiveInput);
  const gamma: OverlayComponentResult = computeArsenalMatchupFit(effectiveInput);
  const lambda: OverlayComponentResult = computeLaunchTopology(effectiveInput);
  const theta: OverlayComponentResult = computeLineupVolume(effectiveInput);
  const delta: OverlayComponentResult = computeRecencyDelta(effectiveInput);

  // 3. Soft gate K.
  const { softGateFactor, confidencePenalty } = computeSoftGate(effectiveInput);

  // 4. Ω = weighted sum of component scores.
  const omega =
    SUB_ENGINE_WEIGHTS.psi * psi.score +
    SUB_ENGINE_WEIGHTS.gamma * gamma.score +
    SUB_ENGINE_WEIGHTS.lambda * lambda.score +
    SUB_ENGINE_WEIGHTS.theta * theta.score +
    SUB_ENGINE_WEIGHTS.delta * delta.score;

  // 5. Final multiplier: (1 + Ω) · K, clamped.
  const overlayMultiplier = Math.max(
    OVERLAY_CLAMP.min,
    Math.min(OVERLAY_CLAMP.max, (1 + omega) * softGateFactor),
  );

  // 6. Aggregate coverage.
  const coverageMap = {
    psi: psi.coverage,
    gamma: gamma.coverage,
    lambda: lambda.coverage,
    theta: theta.coverage,
    delta: delta.coverage,
  };
  const coverageValues = Object.values(coverageMap) as DataCoverage[];
  const overall: DataCoverage = coverageValues.every(c => c === "FULL")
    ? "FULL"
    : coverageValues.every(c => c === "MISSING")
    ? "MISSING"
    : "PARTIAL";

  // 7. Aggregate reasons and risks.
  const reasons: string[] = [
    ...psi.reasons, ...gamma.reasons, ...lambda.reasons,
    ...theta.reasons, ...delta.reasons,
  ];
  const risks: string[] = [
    ...psi.risks, ...gamma.risks, ...lambda.risks,
    ...theta.risks, ...delta.risks,
  ];
  if (triadCoverage !== "FULL" && !risks.includes("LOW_2024_2026_SAMPLE")) {
    risks.push("LOW_2024_2026_SAMPLE");
  }

  return {
    overlayMultiplier: Math.round(overlayMultiplier * 10000) / 10000,
    omega: Math.round(omega * 10000) / 10000,
    softGateFactor: Math.round(softGateFactor * 10000) / 10000,
    confidencePenalty,
    components: { psi, gamma, lambda, theta, delta },
    dataCoverage: { ...coverageMap, overall },
    reasons,
    risks,
  };
}
