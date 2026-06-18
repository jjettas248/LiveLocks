// HR Overlay — pure sub-engine functions.
// Each returns an OverlayComponentResult with score ∈ [-1, 1].
// All are no-op (+0, MISSING) when their required inputs are absent.

import { LEAGUE_BASELINES, GATE_THRESHOLDS } from "./hrOverlayConstants";
import { ratioVsBaseline, winsorize } from "./normalization";
import type { HROverlayInput, OverlayComponentResult, DataCoverage } from "./hrOverlayTypes";

// ── Ψ (Power Profile) ────────────────────────────────────────────────────────
// Inputs: Barrel/PA, MaxEV, SweetSpot%, xwOBAcon.
// Score is a weighted average of ratio-vs-baseline for each present metric.
export function computePowerProfile(input: HROverlayInput): OverlayComponentResult {
  const scores: number[] = [];
  const reasons: string[] = [];
  const risks: string[] = [];

  const barrel = input.barrelPerPA;
  if (barrel != null) {
    const s = ratioVsBaseline(barrel, LEAGUE_BASELINES.barrelPerPA, 2.0);
    scores.push(s);
    if (s > 0.3) reasons.push("STRONG_BARREL_RATE");
    else if (s < -0.3) risks.push("WEAK_BARREL_RATE");
  }

  const ev = input.maxEV;
  if (ev != null) {
    // EV is an absolute threshold metric — winsorize tighter (1.5×)
    const s = ratioVsBaseline(ev, LEAGUE_BASELINES.maxEV, 1.5) * 0.8;
    scores.push(s);
    if (s > 0.2) reasons.push("STRONG_XHR_PER_PA");
    else if (s < -0.2) risks.push("LOW_EXIT_VELOCITY");
  }

  const ss = input.sweetSpotPct;
  if (ss != null) {
    scores.push(ratioVsBaseline(ss, LEAGUE_BASELINES.sweetSpotPct, 2.0) * 0.85);
  }

  const xwoba = input.xwOBAcon;
  if (xwoba != null) {
    const s = ratioVsBaseline(xwoba, LEAGUE_BASELINES.xwOBAcon, 2.0);
    scores.push(s);
    if (s > 0.3) reasons.push("HIGH_XWOBACON");
    else if (s < -0.3) risks.push("WEAK_XWOBACON");
  }

  if (scores.length === 0) {
    return { score: 0, coverage: "MISSING", reasons: [], risks: ["POWER_PROFILE_MISSING"] };
  }

  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const coverage: DataCoverage = scores.length >= 4 ? "FULL" : "PARTIAL";
  return { score: winsorize(avg, 1.0), coverage, reasons, risks };
}

// ── Γ (Arsenal Matchup Fit) ───────────────────────────────────────────────────
// Fully no-op until Phase 2 pitch-type batter-split data is ingested.
// Returns +0 and coverage MISSING so the weight (0.20) is effectively inert.
export function computeArsenalMatchupFit(input: HROverlayInput): OverlayComponentResult {
  if (!input.pitchTypeSplits || input.pitchTypeSplits.length === 0) {
    return {
      score: 0,
      coverage: "MISSING",
      reasons: [],
      risks: ["PITCH_TRACKING_PARTIAL"],
    };
  }
  // Phase 2 placeholder — data present but scoring not yet implemented.
  return { score: 0, coverage: "PARTIAL", reasons: [], risks: ["PITCH_TRACKING_PARTIAL"] };
}

// ── Λ (Launch Topology) ───────────────────────────────────────────────────────
// Score = ln((FB% · PullAir%) / (μ_FB · μ_PullAir)), scaled and clamped.
// High FB% combined with high pull-air rate → power-pull shape → positive.
export function computeLaunchTopology(input: HROverlayInput): OverlayComponentResult {
  const fb = input.fbPct;
  const pull = input.pullAirPct;

  if (fb == null && pull == null) {
    return { score: 0, coverage: "MISSING", reasons: [], risks: ["LAUNCH_TOPOLOGY_MISSING"] };
  }

  // Use league baseline as stand-in for whichever input is absent.
  const fbEff = fb ?? LEAGUE_BASELINES.fbPct;
  const pullEff = pull ?? LEAGUE_BASELINES.pullAirPct;

  const safeProduct = Math.max(0.001, fbEff * pullEff);
  const baseProduct = LEAGUE_BASELINES.fbPct * LEAGUE_BASELINES.pullAirPct;
  // Scale factor 0.7 keeps most real-world values within [-1, 1] before winsorize.
  const logRatio = Math.log(safeProduct / baseProduct) * 0.7;

  const score = winsorize(logRatio, 1.0);
  const reasons: string[] = score > 0.3 ? ["PULL_AIR_POWER_SHAPE"] : [];
  const risks: string[] = score < -0.3 ? ["GROUND_BALL_SUPPRESSION"] : [];
  const coverage: DataCoverage = (fb != null && pull != null) ? "FULL" : "PARTIAL";

  return { score, coverage, reasons, risks };
}

// ── Θ (Lineup Volume) ─────────────────────────────────────────────────────────
// Models expected HR opportunity based on batting order position.
// Slot 6 is the neutral reference (score 0). When battingOrderSlgSplit is
// present (Phase 2 partial), it's Bayesian-shrunk toward the overall SLG.
export function computeLineupVolume(input: HROverlayInput): OverlayComponentResult {
  const slot = input.battingOrderSlot;

  if (slot == null) {
    return { score: 0, coverage: "MISSING", reasons: [], risks: [] };
  }

  // HR opportunity by slot relative to slot 6 (neutral reference).
  const SLOT_BASE: Record<number, number> = {
    1: 0.05, 2: 0.10, 3: 0.28, 4: 0.32, 5: 0.20,
    6: 0.00, 7: -0.15, 8: -0.20, 9: -0.25,
  };
  const baseScore = SLOT_BASE[slot] ?? 0.0;

  // Batting-order SLG split (Phase 2) — shrink toward overall with 120 PA prior.
  let slgBoost = 0.0;
  let coverage: DataCoverage = "PARTIAL"; // slot alone
  const slgSplit = input.battingOrderSlgSplit;
  const overallSlg = input.overallSLG;
  if (slgSplit != null) {
    const ref = overallSlg ?? LEAGUE_BASELINES.xSLG;
    // Bayesian shrink: observed split weighted at 150 PA against 120 PA at ref.
    const shrunk = (slgSplit * 150 + ref * 120) / 270;
    slgBoost = ratioVsBaseline(shrunk, ref, 1.5) * 0.4;
    coverage = "FULL";
  }

  const score = winsorize(baseScore + slgBoost, 1.0);
  const reasons: string[] = score > 0.2 ? ["CLEANUP_SLOT_POWER"] : [];
  const risks: string[] = slot >= 7 ? ["LOW_ORDER_POSITION"] : [];

  return { score, coverage, reasons, risks };
}

// ── Δ (Recency Delta) ─────────────────────────────────────────────────────────
// Measures how much the batter's recent form (L15–L30) deviates from his
// season baseline. Captures hot/cold streaks. Lowest weight (0.10) because
// the hot-hand effect is real but noisy.
export function computeRecencyDelta(input: HROverlayInput): OverlayComponentResult {
  const contributions: number[] = [];

  const recentSlg = input.recentSLG;
  const seasonSlg = input.seasonSLG;
  if (recentSlg != null && seasonSlg != null && seasonSlg > 0) {
    contributions.push((recentSlg - seasonSlg) / seasonSlg);
  }

  const recentOps = input.recentOPS;
  const seasonOps = input.seasonOPS;
  if (recentOps != null && seasonOps != null && seasonOps > 0) {
    contributions.push((recentOps - seasonOps) / seasonOps);
  }

  if (contributions.length === 0) {
    return { score: 0, coverage: "MISSING", reasons: [], risks: [] };
  }

  const avg = contributions.reduce((a, b) => a + b, 0) / contributions.length;
  const score = winsorize(avg, 1.0);
  const reasons: string[] = score > 0.2 ? ["HOT_RECENT_FORM"] : [];
  const risks: string[] = score < -0.2 ? ["COLD_RECENT_FORM"] : [];
  const coverage: DataCoverage = contributions.length >= 2 ? "FULL" : "PARTIAL";

  return { score, coverage, reasons, risks };
}

// ── K (Soft Gate) ─────────────────────────────────────────────────────────────
// Dampens the overlay when a batter fails basic contact-quality floors.
// Never zeros the overlay — minimum is GATE_THRESHOLDS.gateFloor (0.65).
// Stamps confidencePenalty when any gate condition fires.
export function computeSoftGate(input: HROverlayInput): {
  softGateFactor: number;
  confidencePenalty: boolean;
} {
  let gate = 1.0;
  let confidencePenalty = false;

  const barrel = input.barrelPerPA;
  if (barrel != null && barrel < GATE_THRESHOLDS.barrelFloor) {
    // Linear dampening from gateFloor (barrel=0) to 1.0 (barrel=floor).
    const deficit = 1 - barrel / GATE_THRESHOLDS.barrelFloor;
    gate *= 1 - deficit * (1 - GATE_THRESHOLDS.gateFloor);
    confidencePenalty = true;
  }

  const ev = input.maxEV;
  if (ev != null && ev < GATE_THRESHOLDS.evFloor) {
    const deficit = 1 - ev / GATE_THRESHOLDS.evFloor;
    // Half weight vs barrel — EV alone is less definitive.
    gate *= 1 - deficit * (1 - GATE_THRESHOLDS.gateFloor) * 0.5;
    confidencePenalty = true;
  }

  const topped = input.toppedPct;
  if (topped != null && topped > GATE_THRESHOLDS.toppedCeiling) {
    const excess = (topped - GATE_THRESHOLDS.toppedCeiling) / GATE_THRESHOLDS.toppedCeiling;
    gate *= 1 - Math.min(0.35, excess * 0.5) * (1 - GATE_THRESHOLDS.gateFloor);
    confidencePenalty = true;
  }

  return { softGateFactor: Math.max(GATE_THRESHOLDS.gateFloor, gate), confidencePenalty };
}
