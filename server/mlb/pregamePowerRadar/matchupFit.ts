// Component 3 — Matchup Fit (weight 0.20).
//
// Pure scorer combining: handedness platoon edge, batter pitch-type strength vs
// pitcher mix, and a CAPPED BvP supporting modifier. BvP is returned separately
// as a final-score point modifier (applied in scoring.ts) so it can never
// override the composite or surface a signal on its own.

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
  bvpDirection: BvpDirection;
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
  if (sPullPark != null && sPullPark >= 7) {
    drivers.push({ key: "fit_pull_park", label: "Pull Profile Fits Park", direction: "positive", weight: Math.round(sPullPark * 10) });
  }

  // ── BvP supporting context (capped points modifier + direction) ─────────────
  // BvP is a LOW/MEDIUM-confidence context signal. Sample-size shrinkage keeps a
  // tiny sample from overriding the model: <5 AB is informational only; 5–10 is a
  // small nudge; 10–25 moderate; 25+ stronger. It can never surface a signal on
  // its own and never beats a coverage cap (applied later in scoring.ts).
  let bvpModifier = 0;
  let bvpAvailable = false;
  let bvpScore: number | null = null;
  let bvpDirection: BvpDirection = "neutral";
  const pa = inputs.bvpPlateAppearances ?? 0;
  const ab = inputs.bvpAtBats ?? pa; // prefer AB; fall back to PA
  const sample = Math.max(ab, pa);
  const bvpSampleSize = sample;

  if (sample >= 5 && inputs.bvpHr != null && inputs.bvpHits != null) {
    bvpAvailable = true;
    const denom = pa > 0 ? pa : ab;
    const hrRate = denom > 0 ? inputs.bvpHr / denom : 0; // ~0.04 neutral
    const hitRate = denom > 0 ? inputs.bvpHits / denom : 0; // ~0.25 neutral
    const kRate = inputs.bvpStrikeouts != null && ab > 0 ? inputs.bvpStrikeouts / ab : null;

    // Directional 0–10 score from OPS + HR rate, penalized by a high K rate, then
    // shrunk toward neutral (5) by sample size.
    const sOps = inputs.bvpOps != null ? lin(inputs.bvpOps, 0.5, 1.0) : null;
    const sHr = lin(hrRate, 0.0, 0.1);
    let rawScore = sOps != null ? sOps * 0.65 + sHr * 0.35 : sHr;
    if (kRate != null) rawScore = clamp(rawScore - Math.max(0, kRate - 0.25) * 6, 0, 10);
    const shrink = Math.min(1, sample / 25);
    bvpScore = round1(clamp(5 + (rawScore - 5) * shrink, 0, 10));

    // Points modifier with the same shrinkage caps.
    const raw =
      (hrRate - 0.04) * 12 + (hitRate - 0.25) * 2 - (kRate != null ? Math.max(0, kRate - 0.25) * 2 : 0);
    const cap = sample >= 25 ? 1.0 : sample >= 10 ? 0.6 : 0.3;
    bvpModifier = clamp(raw, -cap, cap);

    const negative =
      (inputs.bvpHits === 0 && (inputs.bvpStrikeouts ?? 0) >= 3) ||
      (inputs.bvpOps != null && inputs.bvpOps < 0.6) ||
      bvpModifier <= -0.2;
    const positive =
      inputs.bvpHr >= 1 || (inputs.bvpOps != null && inputs.bvpOps > 0.85) || bvpModifier >= 0.2;
    bvpDirection = negative ? "negative" : positive ? "positive" : "neutral";

    if (bvpDirection === "positive") {
      drivers.push({ key: "fit_bvp", label: "Owns This Pitcher (BvP)", direction: "positive", weight: 40, evidence: `${inputs.bvpHr} HR / ${inputs.bvpHits} H in ${sample} AB` });
    } else if (bvpDirection === "negative") {
      drivers.push({ key: "fit_bvp_bad", label: "Poor BvP History", direction: "negative", weight: 40, evidence: `${inputs.bvpHits} H, ${inputs.bvpStrikeouts ?? 0} K in ${sample} AB` });
    }
  } else if (sample > 0 && sample < 5) {
    warnings.push("BvP sample too small (<5 AB) — informational only");
  }

  if (coverage === 0) {
    warnings.push("No matchup-fit data available");
    return { score10: 5, available: false, drivers, warnings, bvpModifier, bvpAvailable, bvpScore, bvpSampleSize, bvpDirection };
  }

  return { score10: round1(score), available: true, drivers, warnings, bvpModifier, bvpAvailable, bvpScore, bvpSampleSize, bvpDirection };
}
