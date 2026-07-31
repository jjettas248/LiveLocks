// ── MLB Live Edge — production-adaptation fail-closed configuration ─────────
// MLB Live Edge Trust Recovery (Phase 1, tightened after review). Several
// online-learning mechanisms in this engine compare AGGREGATE observed
// outcomes against fixed defaults (selfLearning.ts's league-wide hit/TB/K
// rate vs. a hardcoded 0.250/0.400/0.220, markets.ts's mirrored shrink
// factor) or against a settled-outcome sample that cannot yet be trusted to
// be clean (HR empirical calibration buckets, built from persisted_plays /
// outcome stamps that predate the official-eligibility and immutability
// fixes elsewhere in this recovery). None of these compare a prediction to
// its OWN prior forecast — they are not valid production calibration
// signals today, and there is no correct "on" state to gate them to.
//
// IMPORTANT: there is deliberately NO environment variable, flag, or code
// path anywhere that can make production consume these values. The
// functions below control ONLY whether the (harmless) shadow-diagnostic
// computation is logged via [MLB_ADAPTATION_SHADOW] — they were previously
// named/used as production on/off switches and that was a defect: a flag
// set to "true" would have reactivated the exact contaminated feedback loop
// this recovery exists to remove. Production callers (selfLearning.ts's
// getLearnedRateAdjustment, markets.ts's getSelfLearningShrink,
// hrConversionModel.ts's calibrate()) now return their neutral/static value
// UNCONDITIONALLY, with no reference to these flags at all. Re-enabling
// online adaptation for real requires a deliberate code change once clean,
// immutable, versioned official call episodes exist to validate against
// (see server/mlb/mlbOfficialEligibility.ts and CLAUDE.md Phase 4/6) — not
// a config toggle.

const ENABLED_VALUE = "true";

function isEnabled(envVar: string | undefined): boolean {
  return envVar === ENABLED_VALUE;
}

/**
 * Whether to emit [MLB_ADAPTATION_SHADOW] diagnostics for the aggregate
 * self-learning market-rate computation (selfLearning.ts, markets.ts).
 * Shadow-logging-only — has no effect on what production consumes.
 */
export function isMlbSelfLearningShadowLoggingEnabled(): boolean {
  return isEnabled(process.env.MLB_SELF_LEARNING_SHADOW_LOGGING);
}

/**
 * Whether to emit [MLB_ADAPTATION_SHADOW] diagnostics for the HR empirical
 * calibration buckets (hrConversionModel.ts). Shadow-logging-only — has no
 * effect on what production consumes.
 */
export function isMlbEmpiricalHrCalibrationShadowLoggingEnabled(): boolean {
  return isEnabled(process.env.MLB_EMPIRICAL_HR_CALIBRATION_SHADOW_LOGGING);
}

export type MlbCalibrationSource =
  | "production_champion"
  | "static_calibration"
  | "empirical_shadow_calibration"
  | "aggregate_self_learning_shadow";
