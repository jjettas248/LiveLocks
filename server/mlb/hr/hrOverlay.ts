// Consolidated HR overlay (Ω) — orchestrates the sub-engines into a single,
// capped, additive multiplier applied inside the HR engine before the bus.
//
//   overlayMultiplier = clamp( (1 + Ω) · K_soft )
//   Ω = Σ wᵢ · componentᵢ        (componentᵢ ∈ [-1, 1])
//
// It supersedes the legacy power / lineup-slot / recent-form multipliers. Every
// input is optional and no-op when absent, so the multiplier degrades to ~1.0
// on thin data rather than fabricating signal.

import {
  OVERLAY_WEIGHTS,
  OVERLAY_MULTIPLIER_MIN,
  OVERLAY_MULTIPLIER_MAX,
  LOW_SAMPLE_PA,
} from "./hrOverlayConstants";
import { clamp, isPresent } from "./normalization";
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
  HROverlayComponent,
  SubEngineResult,
  Coverage,
} from "./hrOverlayTypes";

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function withWeight(sub: SubEngineResult, weight: number): HROverlayComponent {
  return { score: round4(sub.score), coverage: sub.coverage, weight };
}

export function computeHROverlay(input: HROverlayInput): HROverlayResult {
  const power = computePowerProfile(input);
  const matchup = computeArsenalMatchupFit(input);
  const launch = computeLaunchTopology(input);
  const lineup = computeLineupVolume(input);
  const recency = computeRecencyDelta(input);

  const omega =
    OVERLAY_WEIGHTS.power * power.score +
    OVERLAY_WEIGHTS.matchup * matchup.score +
    OVERLAY_WEIGHTS.launch * launch.score +
    OVERLAY_WEIGHTS.lineup * lineup.score +
    OVERLAY_WEIGHTS.recency * recency.score;

  const gate = computeSoftGate(input);
  const overlayMultiplier = clamp(
    (1 + omega) * gate.factor,
    OVERLAY_MULTIPLIER_MIN,
    OVERLAY_MULTIPLIER_MAX,
  );

  // ── Reason codes (positive evidence only) ─────────────────────────────────
  const reasons: string[] = [];
  if (power.score >= 0.40) reasons.push("STRONG_STATCAST_POWER");
  if (launch.score >= 0.40) reasons.push("PULL_AIR_POWER_SHAPE");
  if (matchup.coverage !== "MISSING" && matchup.score >= 0.30) {
    reasons.push("ARSENAL_DAMAGE_MATCH");
  }
  if (lineup.score >= 0.15) reasons.push("PROJECTED_PA_VOLUME");
  if (recency.score >= 0.30) reasons.push("RECENT_POWER_CONFIRMED");

  // ── Risk codes ────────────────────────────────────────────────────────────
  const risks: string[] = [...gate.risks];
  if (matchup.coverage === "MISSING") risks.push("PITCH_TRACKING_MISSING");
  else if (matchup.coverage === "PARTIAL") risks.push("PITCH_TRACKING_PARTIAL");
  if (lineup.coverage === "PARTIAL") risks.push("BATTING_ORDER_SPLIT_UNAVAILABLE");
  if (recency.coverage === "MISSING") risks.push("RECENT_FORM_UNAVAILABLE");

  let confidencePenalty = gate.confidencePenalty;
  if (isPresent(input.totalPA2024to2026) && input.totalPA2024to2026 < LOW_SAMPLE_PA) {
    risks.push("LOW_2024_2026_SAMPLE");
    confidencePenalty = true;
  }

  const qualityContact = qualityContactCoverage(input);

  return {
    omega: round4(omega),
    softGateFactor: round4(gate.factor),
    overlayMultiplier: round4(overlayMultiplier),
    confidencePenalty,
    components: {
      power: withWeight(power, OVERLAY_WEIGHTS.power),
      matchup: withWeight(matchup, OVERLAY_WEIGHTS.matchup),
      launch: withWeight(launch, OVERLAY_WEIGHTS.launch),
      lineup: withWeight(lineup, OVERLAY_WEIGHTS.lineup),
      recency: withWeight(recency, OVERLAY_WEIGHTS.recency),
    },
    dataCoverage: {
      statcastBatting: power.coverage,
      pitchTracking: matchup.coverage,
      battedBallProfile: launch.coverage,
      battingOrderSplits: lineup.coverage,
      recentPower: recency.coverage,
      qualityContact,
    },
    reasons,
    risks: Array.from(new Set(risks)),
  };
}

function qualityContactCoverage(input: HROverlayInput): Coverage {
  const hasGateInputs =
    isPresent(input.barrelRate) || isPresent(input.barrelPerPA) || isPresent(input.maxEV);
  if (!hasGateInputs) return "MISSING";
  // Topped% is the last missing piece until Phase 2 ingestion lands.
  return isPresent(input.toppedPct) ? "FULL" : "PARTIAL";
}

export type { HROverlayInput, HROverlayResult } from "./hrOverlayTypes";
