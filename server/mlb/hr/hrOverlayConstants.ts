// HR Overlay — shared constants for all sub-engines and the orchestrator.
// All probability-affecting numbers live here; sub-engines import from this file.

export const HR_ALLOWED_SEASONS = [2024, 2025, 2026] as const;

export const TEMPORAL_WEIGHTS: Record<number, number> = {
  2026: 0.50,
  2025: 0.35,
  2024: 0.15,
};

// League baselines (μ) calibrated for 2024–2026 MLB.
// Sub-engines compute ratio-vs-baseline against these values.
export const LEAGUE_BASELINES = {
  barrelPerPA: 0.065,
  maxEV: 110.0,          // avg EV benchmark for meaningful power contact, mph
  sweetSpotPct: 31.0,    // % BIP in 8–32° LA band
  xwOBAcon: 0.360,       // xwOBA on contact, league average
  fbPct: 35.0,           // fly ball %
  pullAirPct: 12.0,      // pull % in air (FB + LD pull side)
  xSLG: 0.420,           // SLG baseline for lineup slot normalization
} as const;

// Soft-gate (K) thresholds — contact-quality floors below which the overlay is dampened.
export const GATE_THRESHOLDS = {
  barrelFloor: 0.040,    // barrel/PA below this → soft suppression
  toppedCeiling: 25.0,   // Topped% above this → soft suppression
  evFloor: 87.0,         // avg EV below this → soft suppression
  gateFloor: 0.65,       // minimum dampener — never zero
} as const;

// Sub-engine weights — must sum to 1.0.
export const SUB_ENGINE_WEIGHTS = {
  psi: 0.35,    // Ψ — power profile
  gamma: 0.20,  // Γ — arsenal matchup fit (no-op until Phase 2)
  lambda: 0.20, // Λ — launch topology
  theta: 0.15,  // Θ — lineup volume
  delta: 0.10,  // Δ — recency delta
} as const;

// Final overlayMultiplier clamped to this range after soft gate is applied.
export const OVERLAY_CLAMP = { min: 0.60, max: 1.60 } as const;
