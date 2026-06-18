// HR Overlay — type contracts for inputs, sub-engine results, and the final overlay.

export type DataCoverage = "FULL" | "PARTIAL" | "MISSING";

/** Per-season stat bundle for the 2024–2026 triad weighting. */
export interface SeasonStatBundle {
  season: number;
  barrelPerPA?: number | null;
  maxEV?: number | null;
  sweetSpotPct?: number | null;
  xwOBAcon?: number | null;
  fbPct?: number | null;
  pullAirPct?: number | null;
  xSLG?: number | null;
  toppedPct?: number | null;
  slgBySlot?: number | null;
}

/** Per-pitch-type batter damage entry — Phase 2 data (no-op when absent). */
export interface PitchTypeBatterSplit {
  pitchType: "fastball" | "breaking" | "offspeed";
  usagePct?: number | null;    // pitcher's usage % for this pitch type
  xSLG?: number | null;        // batter xSLG vs this pitch type
  whiffPct?: number | null;    // batter whiff% vs this pitch type
}

/** All inputs to the consolidated HR overlay. Every field is optional — no-op when absent. */
export interface HROverlayInput {
  // Power profile (Ψ)
  barrelPerPA?: number | null;
  maxEV?: number | null;
  sweetSpotPct?: number | null;
  xwOBAcon?: number | null;

  // Launch topology (Λ)
  fbPct?: number | null;
  pullAirPct?: number | null;

  // Soft gate (K) — toppedPct is Phase 2 data; no-op when null
  toppedPct?: number | null;

  // Lineup volume (Θ)
  battingOrderSlot?: number | null;
  battingOrderSlgSplit?: number | null;  // batter SLG specific to this slot — Phase 2 partial
  overallSLG?: number | null;            // season SLG baseline for shrinkage

  // Recency delta (Δ)
  recentSLG?: number | null;
  seasonSLG?: number | null;
  recentOPS?: number | null;
  seasonOPS?: number | null;

  // Arsenal matchup fit (Γ) — fully no-op until Phase 2 data ingestion
  pitchTypeSplits?: PitchTypeBatterSplit[] | null;

  // Multi-season stat bundles for temporal triad weighting — Phase 2 data
  seasonBundles?: SeasonStatBundle[] | null;
}

/** Single sub-engine output. */
export interface OverlayComponentResult {
  score: number;             // contribution ∈ [-1, 1]
  coverage: DataCoverage;
  reasons: string[];         // positive driver codes (e.g. "STRONG_BARREL_RATE")
  risks: string[];           // risk codes (e.g. "LOW_2024_2026_SAMPLE")
}

/** Final result returned by computeHROverlay. */
export interface HROverlayResult {
  overlayMultiplier: number;   // (1 + Ω) · softGateFactor, clamped [0.6, 1.6]
  omega: number;               // Σ wᵢ · componentᵢ before clamping
  softGateFactor: number;      // K ∈ [gateFloor, 1.0]
  confidencePenalty: boolean;  // true when at least one gate condition fired
  components: {
    psi: OverlayComponentResult;
    gamma: OverlayComponentResult;
    lambda: OverlayComponentResult;
    theta: OverlayComponentResult;
    delta: OverlayComponentResult;
  };
  dataCoverage: {
    psi: DataCoverage;
    gamma: DataCoverage;
    lambda: DataCoverage;
    theta: DataCoverage;
    delta: DataCoverage;
    overall: DataCoverage;
  };
  reasons: string[];
  risks: string[];
}
