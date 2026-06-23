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
}

export interface MatchupFitResult extends ComponentScore {
  /** Capped BvP modifier in final-score POINTS (applied after baseScore). */
  bvpModifier: number;
  bvpAvailable: boolean;
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

  // ── BvP capped modifier (final-score points) ───────────────────────────────
  let bvpModifier = 0;
  let bvpAvailable = false;
  const pa = inputs.bvpPlateAppearances ?? 0;
  if (pa >= 6 && inputs.bvpHr != null && inputs.bvpHits != null) {
    bvpAvailable = true;
    // Raw edge: HR and hits per PA relative to neutral baselines.
    const hrRate = inputs.bvpHr / pa; // ~0.04 neutral
    const hitRate = inputs.bvpHits / pa; // ~0.25 neutral
    const raw = (hrRate - 0.04) * 12 + (hitRate - 0.25) * 2;
    const cap = pa >= 30 ? 1.0 : pa >= 15 ? 0.6 : 0.3;
    bvpModifier = clamp(raw, -cap, cap);
    if (bvpModifier >= 0.3) {
      drivers.push({ key: "fit_bvp", label: "Owns This Pitcher (BvP)", direction: "positive", weight: 40, evidence: `${inputs.bvpHr} HR in ${pa} PA` });
    } else if (bvpModifier <= -0.3) {
      drivers.push({ key: "fit_bvp_bad", label: "Struggles vs Pitcher (BvP)", direction: "negative", weight: 40, evidence: `${inputs.bvpHits} H in ${pa} PA` });
    }
  } else if (pa > 0 && pa < 6) {
    warnings.push("BvP sample too small (PA<6) — no modifier");
  }

  if (coverage === 0) {
    warnings.push("No matchup-fit data available");
    return { score10: 5, available: false, drivers, warnings, bvpModifier, bvpAvailable };
  }

  return { score10: round1(score), available: true, drivers, warnings, bvpModifier, bvpAvailable };
}
