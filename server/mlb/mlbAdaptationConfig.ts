// ── MLB Live Edge — production-adaptation fail-closed configuration ─────────
// MLB Live Edge Trust Recovery (Phase 1). Several online-learning mechanisms
// in this engine compare AGGREGATE observed outcomes against fixed defaults
// (selfLearning.ts's league-wide hit/TB/K rate vs. a hardcoded 0.250/0.400/
// 0.220, markets.ts's mirrored shrink factor) or against a settled-outcome
// sample that cannot yet be trusted to be clean (HR empirical calibration
// buckets, built from persisted_plays / outcome stamps that predate the
// official-eligibility and immutability fixes elsewhere in this recovery).
// None of these compare a prediction to its OWN prior forecast — they are not
// valid production calibration signals today.
//
// This module is the single fail-closed gate for all of them. Every flag here
// defaults OFF, and only the exact literal value below turns it on — a
// missing, empty, misspelled, or truthy-but-wrong env value (e.g. "1", "yes",
// "TRUE") resolves to OFF, never ON. This is intentional: these systems must
// not be reactivated by an accidental config change. Turning them on for real
// requires a deliberate code change once clean, immutable, versioned official
// call episodes exist to validate against (see server/mlb/mlbOfficialEligibility.ts
// and CLAUDE.md Phase 4/6).
//
// Shadow computation is NEVER gated by these flags — the underlying values are
// still computed and logged via [MLB_ADAPTATION_SHADOW] so the diagnostics
// stay observable; only PRODUCTION CONSUMPTION is gated.

const ENABLED_VALUE = "true";

function isEnabled(envVar: string | undefined): boolean {
  return envVar === ENABLED_VALUE;
}

/**
 * Aggregate self-learning market-rate adjustment (selfLearning.ts
 * getLearnedRateAdjustment, markets.ts getSelfLearningShrink). Compares
 * LEAGUE-WIDE aggregate outcomes to fixed static defaults — not this engine's
 * own prior predictions. Fail-closed: OFF unless explicitly "true".
 */
export function isMlbSelfLearningProductionAdaptationEnabled(): boolean {
  return isEnabled(process.env.MLB_SELF_LEARNING_PRODUCTION_ADAPTATION);
}

/**
 * HR empirical calibration buckets (hrConversionModel.ts calibrate()). Built
 * from settled HR Radar outcome stamps, which — until Phase 4's official-
 * eligibility/immutability fixes are live and have accumulated a clean
 * sample — may include watch-only/overwritten/non-official rows. Fail-closed:
 * OFF unless explicitly "true".
 */
export function isMlbEmpiricalHrCalibrationEnabled(): boolean {
  return isEnabled(process.env.MLB_EMPIRICAL_HR_CALIBRATION_PRODUCTION);
}

export type MlbCalibrationSource =
  | "production_champion"
  | "static_calibration"
  | "empirical_shadow_calibration"
  | "aggregate_self_learning_shadow";
