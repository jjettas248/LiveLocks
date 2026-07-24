// Component 3 — Matchup Fit (weight 0.18).
//
// Pure scorer combining: handedness platoon edge, batter pitch-type strength vs
// pitcher mix, and a tightly-capped BvP supporting modifier. BvP is returned
// separately as a final-score point modifier (applied in scoring.ts) so it can
// never override the composite or surface a signal on its own.

import type { ComponentScore, PowerDriver } from "./types";
import { lin, weightedAvg, round1, clamp } from "./scoreUtils";

export interface MatchupFitInputs {
  batterHand: "L" | "R" | "S" | null;
  pitcherThrows: "L" | "R" | null;
  /** Batter platoon edge: OPS vs the hand the pitcher throws (when available). */
  batterOpsVsHand: number | null;
  /** Batter xSLG vs the pitcher's dominant pitch family, when available (0–1). */
  batterXslgVsDominantFamily: number | null;
  pullRatePct: number | null;
  parkFavorsPull: boolean;
  // BvP supporting modifier inputs:
  bvpPlateAppearances: number | null;
  bvpHr: number | null;
  bvpHits: number | null;
  // Richer BvP context (optional — additive, no-op when absent):
  bvpAtBats?: number | null;
  bvpStrikeouts?: number | null;
  bvpOps?: number | null;
  bvpAvg?: number | null;
}

export type BvpDirection = "positive" | "neutral" | "negative";

export interface MatchupFitResult extends ComponentScore {
  /** Capped BvP modifier in final-score POINTS (applied after baseScore). */
  bvpModifier: number;
  bvpAvailable: boolean;
  /** Directional 0–10 BvP score (null when no usable sample). */
  bvpScore: number | null;
  /** AB (preferred) or PA used for BvP. */
  bvpSampleSize: number;
  /** BvP hits (numerator) — additive passthrough of inputs.bvpHits, null when unavailable. */
  bvpHits: number | null;
  bvpDirection: BvpDirection;
  /** Which key production fields are .000 (AVG/SLG/OPS) — drives the zero-prod rule. */
  zeroProductionFlags: string[];
  /** True only on a meaningful sample (15+ AB) with ≥2 key production fields at .000. */
  bvpZeroProduction: boolean;
}

function platoonEdge(batterHand: "L" | "R" | "S" | null, pitcherThrows: "L" | "R" | null): number | null {
  if (!pitcherThrows) return null;
  // Opposite-hand matchups (L vs R, R vs L) favor the batter; switch always neutral-plus.
  if (batterHand === "S") return 7;
  if (batterHand === "L") return pitcherThrows === "R" ? 7 : 3.5;
  if (batterHand === "R") return pitcherThrows === "L" ? 7 : 4.5;
  return null;
}

export function computeMatchupFit(inputs: MatchupFitInputs): MatchupFitResult {
  const drivers: PowerDriver[] = [];
  const warnings: string[] = [];

  const sPlatoon = platoonEdge(inputs.batterHand, inputs.pitcherThrows);
  const sOps = inputs.batterOpsVsHand != null ? lin(inputs.batterOpsVsHand, 0.6, 0.95) : null;
  const sFamily = inputs.batterXslgVsDominantFamily != null ? lin(inputs.batterXslgVsDominantFamily, 0.34, 0.56) : null;
  const sPullPark = inputs.pullRatePct != null && inputs.parkFavorsPull ? lin(inputs.pullRatePct, 35, 55) : null;

  const { score, coverage } = weightedAvg([
    { value: sPlatoon, weight: 2 },
    { value: sOps, weight: 3 },
    { value: sFamily, weight: 2 },
    { value: sPullPark, weight: 1 },
  ]);

  if (sPlatoon != null && sPlatoon >= 6.5) {
    drivers.push({ key: "fit_platoon", label: "Platoon Advantage", direction: "positive", weight: Math.round(sPlatoon * 10) });
  }
  if (sOps != null && sOps >= 7) {
    drivers.push({ key: "fit_ops_hand", label: "Strong vs Pitcher Hand", direction: "positive", weight: Math.round(sOps * 10), evidence: `OPS ${round1(inputs.batterOpsVsHand ?? 0)}` });
  }
  if (sFamily != null && sFamily >= 7) {
    drivers.push({
      key: "fit_pitch_family",
      label: "Strong vs Primary Pitch Shape",
      direction: "positive",
      weight: Math.round(sFamily * 10),
      evidence: `xSLG ${inputs.batterXslgVsDominantFamily?.toFixed(3)}`,
    });
  }
  if (sPullPark != null && sPullPark >= 7) {
    drivers.push({ key: "fit_pull_park", label: "Pull Profile Fits Park", direction: "positive", weight: Math.round(sPullPark * 10) });
  }

  // ── BvP supporting context (strictly capped points modifier + direction) ─────
  // BvP is low-confidence context, not a core skill signal. 5–9 AB is display
  // only; 10–24 can nudge the score by at most ±0.20; 25–49 by ±0.35; 50+ by
  // ±0.50. It cannot independently block Elite until 25+ AB, and a hard
  // zero-production block requires 15+ AB. This keeps noisy matchup history
  // subordinate to repeatable batter/pitcher traits.
  let bvpModifier = 0;
  let bvpAvailable = false;
  let bvpScore: number | null = null;
  let bvpHits: number | null = null;
  let bvpDirection: BvpDirection = "neutral";
  let zeroProductionFlags: string[] = [];
  let bvpZeroProduction = false;
  const pa = inputs.bvpPlateAppearances ?? 0;
  const ab = inputs.bvpAtBats ?? pa; // prefer AB; fall back to PA
  const sample = Math.max(ab, pa);
  const bvpSampleSize = sample;

  if (sample >= 5 && inputs.bvpHr != null && inputs.bvpHits != null) {
    bvpAvailable = true;
    bvpHits = inputs.bvpHits;
    const denom = pa > 0 ? pa : ab;
    const hrRate = denom > 0 ? inputs.bvpHr / denom : 0; // ~0.04 neutral
    const hitRate = denom > 0 ? inputs.bvpHits / denom : 0; // ~0.25 neutral
    const kRate = inputs.bvpStrikeouts != null && ab > 0 ? inputs.bvpStrikeouts / ab : null;

    // Zero-production flags. 0 HR alone is never a negative signal.
    const avg = inputs.bvpAvg ?? (ab > 0 ? inputs.bvpHits / ab : null);
    if (avg === 0 || inputs.bvpHits === 0) zeroProductionFlags.push("AVG .000");
    if (inputs.bvpHits === 0) zeroProductionFlags.push("SLG .000");
    if (inputs.bvpOps != null && inputs.bvpOps === 0) zeroProductionFlags.push("OPS .000");
    bvpZeroProduction = sample >= 15 && zeroProductionFlags.length >= 2;

    // Directional display score shrinks much more slowly than the old 25-AB
    // full-confidence rule. Even at 25 AB, half the raw deviation is still
    // regressed toward neutral.
    const bvpOpsScore = inputs.bvpOps != null ? lin(inputs.bvpOps, 0.5, 1.0) : null;
    const sHr = lin(hrRate, 0.0, 0.1);
    let rawScore = bvpOpsScore != null ? bvpOpsScore * 0.65 + sHr * 0.35 : sHr;
    if (kRate != null) rawScore = clamp(rawScore - Math.max(0, kRate - 0.25) * 6, 0, 10);
    const displayShrink = Math.min(1, sample / 50);
    bvpScore = round1(clamp(5 + (rawScore - 5) * displayShrink, 0, 10));

    if (sample >= 10) {
      const raw =
        Math.max(0, hrRate - 0.04) * 12 +
        (hitRate - 0.25) * 2 -
        (kRate != null ? Math.max(0, kRate - 0.25) * 2 : 0) -
        (bvpZeroProduction ? 0.3 : 0);
      const cap = sample >= 50 ? 0.50 : sample >= 25 ? 0.35 : 0.20;
      bvpModifier = clamp(raw, -cap, cap);
    }

    // Direction is reserved for samples large enough to carry an actual model
    // meaning. Smaller samples can nudge the numeric score but never mint a
    // positive/negative gate or independently block Elite.
    if (sample >= 25) {
      const negative =
        bvpZeroProduction ||
        (inputs.bvpOps != null && inputs.bvpOps < 0.55 && (kRate ?? 0) >= 0.25) ||
        bvpModifier <= -0.20;
      const positive =
        (inputs.bvpHr >= 2 && sample >= 25) ||
        (inputs.bvpOps != null && inputs.bvpOps > 0.90) ||
        bvpModifier >= 0.20;
      bvpDirection = negative ? "negative" : positive ? "positive" : "neutral";
    }

    if (bvpDirection === "positive") {
      drivers.push({ key: "fit_bvp", label: "Positive BvP Context", direction: "positive", weight: 20, evidence: `${inputs.bvpHr} HR / ${inputs.bvpHits} H in ${sample} AB` });
    } else if (bvpDirection === "negative") {
      const ev = zeroProductionFlags.length > 0
        ? `${zeroProductionFlags.join(", ")} (${inputs.bvpHits} H, ${inputs.bvpStrikeouts ?? 0} K in ${sample} AB)`
        : `${inputs.bvpHits} H, ${inputs.bvpStrikeouts ?? 0} K in ${sample} AB`;
      drivers.push({ key: "fit_bvp_bad", label: "Poor BvP Context", direction: "negative", weight: 20, evidence: ev });
    } else if (sample < 10) {
      warnings.push("BvP sample too small (<10 AB) — informational only");
    }
  } else if (sample > 0 && sample < 5) {
    warnings.push("BvP sample too small (<5 AB) — informational only");
  }

  if (coverage === 0) {
    warnings.push("No matchup-fit data available");
    return { score10: 5, available: false, drivers, warnings, bvpModifier, bvpAvailable, bvpScore, bvpSampleSize, bvpHits, bvpDirection, zeroProductionFlags, bvpZeroProduction };
  }

  return { score10: round1(score), available: true, drivers, warnings, bvpModifier, bvpAvailable, bvpScore, bvpSampleSize, bvpHits, bvpDirection, zeroProductionFlags, bvpZeroProduction };
}
