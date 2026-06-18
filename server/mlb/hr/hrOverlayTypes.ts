// Type contracts for the consolidated HR overlay.

import type { PitchMixEntry } from "../types";
import type { SeasonValue } from "./temporalFilter";

export type Coverage = "FULL" | "PARTIAL" | "MISSING";

export type PitchFamilyKey = "fastball" | "breaking" | "offspeed";

/** Batter damage by pitch family (NEW DATA — typically null until Phase 2). */
export interface PitchTypeSplit {
  family: PitchFamilyKey;
  xSlg: number | null;
  whiffPct: number | null;
}

/** Batter SLG/OPS by lineup slot (NEW DATA — typically null until Phase 2). */
export interface BattingOrderSplit {
  slot: number;
  slg: number | null;
  ops: number | null;
  pa: number | null;
}

export interface HROverlayInput {
  // --- Ψ power (Statcast batting + quality of contact) ---
  barrelPerPA?: number | null;
  barrelPerPABySeason?: SeasonValue[] | null; // preferred: triad-blended
  barrelRate?: number | null;                 // Barrel% of BBE (fallback)
  exitVelocity?: number | null;
  sweetSpotPct?: number | null;
  xwOBAcon?: number | null;
  xwOBA?: number | null;                       // fallback anchor for xwOBAcon

  // --- Γ arsenal matchup (pitch tracking) ---
  pitchMix?: PitchMixEntry[] | null;           // pitcher usage
  batterPitchSplits?: PitchTypeSplit[] | null; // batter damage by family

  // --- Λ launch topology (batted-ball profile) ---
  flyBallPct?: number | null;
  pullAirPct?: number | null;                  // pull-rate proxy today

  // --- Θ lineup volume + protection (batting-order splits) ---
  battingOrderSlot?: number | null;
  orderSplits?: BattingOrderSplit[] | null;
  overallSlg?: number | null;

  // --- Δ recency ---
  recentSlg?: number | null;
  recentOps?: number | null;
  seasonSlg?: number | null;
  seasonOps?: number | null;
  hrRateLast7?: number | null;
  hrRateLast15?: number | null;
  seasonHRRate?: number | null;

  // --- soft gate K (quality of contact) ---
  maxEV?: number | null;
  toppedPct?: number | null;

  // --- sample size for confidence ---
  totalPA2024to2026?: number | null;
}

/** A single sub-engine's output before weighting. */
export interface SubEngineResult {
  score: number;        // signed, [-1, 1]; 0 = neutral/absent
  coverage: Coverage;
}

export interface HROverlayComponent extends SubEngineResult {
  weight: number;
}

export interface HROverlayResult {
  omega: number;                 // Σ wᵢ·scoreᵢ
  softGateFactor: number;        // [GATE_SOFT_FLOOR, 1.0]
  overlayMultiplier: number;     // clamp((1 + omega) · softGate)
  confidencePenalty: boolean;
  components: {
    power: HROverlayComponent;
    matchup: HROverlayComponent;
    launch: HROverlayComponent;
    lineup: HROverlayComponent;
    recency: HROverlayComponent;
  };
  dataCoverage: {
    statcastBatting: Coverage;
    pitchTracking: Coverage;
    battedBallProfile: Coverage;
    battingOrderSplits: Coverage;
    recentPower: Coverage;
    qualityContact: Coverage;
  };
  reasons: string[];
  risks: string[];
}
