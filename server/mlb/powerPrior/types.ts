// ─────────────────────────────────────────────────────────────────────────────
// Canonical Power Prior contract (Phase 1 — shadow only)
//
// A `PowerPrior` is the *single canonical pregame input* that HR Radar Live will
// eventually consume in place of the inline `computePregameHrFormScore` /
// `pregamePriorMultiplier` prior currently embedded in `hrConversionModel.ts`.
//
// In THIS phase the type and its mappers exist only to (a) map the existing
// standalone Pre-Game Power Radar signal into a canonical shape, and (b) compare
// that shape against the live inline prior in *shadow* mode. Nothing here mutates
// scoring, probability, lifecycle, grading, or UI.
//
// Hard isolation rules (mirrors pregamePowerRadar/types.ts + CLAUDE.md §7):
//   • Read-only. Never writes the bus, lifecycle, DB, or any canonical field.
//   • Never computes new scoring and never calls Monte Carlo (none exists yet).
//   • Never imports across sport engines.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a `PowerPrior` was sourced from. */
export type PowerPriorSource =
  | "pregame_power_radar" // mapped from the standalone Pre-Game Power Radar signal
  | "inline_fallback" // reserved: a prior synthesized from the live inline model
  | "none"; // no standalone signal found — empty prior

/** Canonical, source-agnostic tier. Distinct from the standalone `PregamePowerTier`. */
export type PowerPriorTier =
  | "elite"
  | "strong"
  | "watch"
  | "neutral"
  | "suppressed";

/**
 * Canonical pregame power prior. All scoring fields are nullable so a missing
 * signal degrades to nulls (never fabricated values). No probability is computed
 * here — `estimatedHrProbability` stays null until a future sim/calibration layer
 * fills it.
 */
export type PowerPrior = {
  playerId: string;
  gameId: string;
  source: PowerPriorSource;

  /** Standalone headline score on the 0–10 scale (verbatim from the signal). */
  preGamePowerScore10: number | null;
  /** Same score normalized to 0–100 (score10 × 10) for cross-scale comparison. */
  preGamePowerScore100: number | null;
  preGameTier: PowerPriorTier | null;

  /** Reserved for a future calibrated HR probability — always null in Phase 1. */
  estimatedHrProbability: number | null;
  /** 0–100 confidence proxy mapped from the standalone data-coverage score. */
  confidenceScore: number | null;

  topDrivers: string[];
  topSuppressors: string[];

  generatedAt: string | null;

  diagnostics: {
    hasStandalonePregameSignal: boolean;
    hasInlineFallback: boolean;
    mappedFromStandaloneFields: string[];
    missingFields: string[];
  };
};

/** Divergence severity between the canonical standalone prior and the inline prior. */
export type PowerPriorComparisonSeverity = "none" | "low" | "medium" | "high";

/** Pure diagnostic describing standalone-vs-inline prior divergence. */
export type PowerPriorComparison = {
  playerId: string;
  gameId: string;

  /** Standalone score on the 0–10 scale. */
  standaloneScore10: number | null;
  /** Inline prior score normalized to the 0–10 scale (inline form score / 10). */
  inlineScore10: number | null;
  /** Absolute |standalone − inline| on the 0–10 scale, null when either is null. */
  absoluteDelta: number | null;

  standaloneTier: string | null;
  /** Approximate tier derived from the inline form score (heuristic, debug-only). */
  inlineTierApprox: string | null;

  severity: PowerPriorComparisonSeverity;

  notes: string[];
};

/** Read-only identity used to resolve a standalone signal into a `PowerPrior`. */
export interface PowerPriorLookupInput {
  /** Game's Eastern Time session date (`YYYY-MM-DD`) the snapshot was built under. */
  gameDateET: string;
  gameId: string;
  /** Live player id. In this codebase the pregame store keys by MLBAM id === batterId. */
  playerId: string | number;
  playerName?: string | null;
  teamAbbr?: string | null;
}

/**
 * The current inline prior values read from `HRConversionResult.components`.
 * `formScore` is the 0–100 `pregameFormScore`; `priorMult` is `pregamePriorMult`.
 */
export interface InlinePriorSnapshot {
  formScore: number | null;
  priorMult: number | null;
}
