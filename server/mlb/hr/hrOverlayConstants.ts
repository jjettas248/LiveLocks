// Consolidated HR overlay — constants & calibratable priors.
//
// This overlay supersedes the legacy batter-skill multipliers
// (power profile, lineup slot, recent form) inside the MLB HR engine. Every
// number here is an initial prior intended to be tuned against resolved
// outcomes; keep them as named constants so calibration is a one-file change.
//
// Scope rule (CLAUDE.md §7a / HR engine rules): player-level inputs must be
// drawn only from the 2024–2026 seasons. Older rows are rejected by the
// temporal filter, never silently blended in.

export const HR_ALLOWED_SEASONS = [2024, 2025, 2026] as const;
export type AllowedSeason = (typeof HR_ALLOWED_SEASONS)[number];

// Recency-weighted blend across the triad. 2026 carries the most weight,
// 2024 the least; renormalized over whichever seasons are actually present.
export const SEASON_TRIAD_WEIGHTS: Record<AllowedSeason, number> = {
  2026: 0.50,
  2025: 0.35,
  2024: 0.15,
};

// League-average baselines (μ) — 2024–2026 reference points. Stats are scored
// as a ratio vs these, so they double as the neutral point of each feature.
export const LEAGUE_BASELINES = {
  barrelPerPA: 0.060,      // Barrel/PA
  barrelRateBBE: 0.065,    // Barrel% of batted-ball events (engine LEAGUE_AVG_BARREL_RATE)
  exitVelocity: 88.5,      // avg EV (mph)
  sweetSpotPct: 33.0,      // %
  xwOBAcon: 0.370,         // xwOBA on contact
  xwOBA: 0.320,            // overall xwOBA (fallback anchor)
  flyBallPct: 35.0,        // %
  pullAirPct: 40.0,        // pull-rate proxy baseline (true Pull AIR% lands in Phase 2)
  maxEV: 108.0,            // mph
  xSlgByFamily: { fastball: 0.430, breaking: 0.370, offspeed: 0.380 },
  whiffPctByFamily: { fastball: 22.0, breaking: 32.0, offspeed: 30.0 },
} as const;

// Soft-gate (K) thresholds. The gate dampens — it never zeroes the overlay.
export const GATE_THRESHOLDS = {
  barrelPerPAFloor: 0.030,
  barrelRateBBEFloor: 0.040,
  maxEvFloor: 104.0,
  toppedPctCeiling: 32.0,
} as const;

// Per-trigger dampeners and the absolute soft floor the gate can reach.
export const GATE_DAMPENERS = {
  lowBarrel: 0.85,
  lowMaxEv: 0.88,
  highTopped: 0.85,
} as const;
export const GATE_SOFT_FLOOR = 0.70;

// Sub-engine weights (w1..w5). Sum = 1.0.
export const OVERLAY_WEIGHTS = {
  power: 0.30,     // Ψ
  matchup: 0.24,   // Γ
  launch: 0.18,    // Λ
  lineup: 0.16,    // Θ
  recency: 0.12,   // Δ
} as const;

// Arsenal-matchup damage vs whiff trade-off (θ1, θ2).
export const ARSENAL_THETA_DAMAGE = 1.0;
export const ARSENAL_THETA_WHIFF = 0.5;

// Final overlay multiplier clamp. Comparable envelope to the three legacy
// multipliers it replaces (~0.74..1.56 combined).
export const OVERLAY_MULTIPLIER_MIN = 0.60;
export const OVERLAY_MULTIPLIER_MAX = 1.60;

// Winsorize ratios (vs baseline) so one extreme stat can't dominate.
export const WINSOR_RATIO_MIN = 0.50;
export const WINSOR_RATIO_MAX = 2.00;

// Per-component signed-score clamp.
export const COMPONENT_SCORE_MIN = -1.0;
export const COMPONENT_SCORE_MAX = 1.0;

// Batting-order split shrinkage constant (PA at which the split earns ~50%
// trust vs the overall line).
export const ORDER_SPLIT_SHRINKAGE = 120;

// Below this 2024–2026 PA total the overlay stamps a low-sample risk + penalty.
export const LOW_SAMPLE_PA = 150;

// Expected PA by lineup slot (pregame baseline) and the league-average anchor.
export const LINEUP_SLOT_BASE_PA: Record<number, number> = {
  1: 4.65, 2: 4.55, 3: 4.45, 4: 4.35, 5: 4.20,
  6: 4.05, 7: 3.90, 8: 3.75, 9: 3.60,
};
export const BASELINE_PA = 4.18;
