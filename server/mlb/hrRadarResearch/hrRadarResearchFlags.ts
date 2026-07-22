// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — feature flags (PR 1).
//
// A single module holding all seven flags for this initiative, rather than the
// codebase's usual one-flag-per-file precedent (e.g. HR_RADAR_GOLDMASTER_V1
// in hrRadarUserStage.ts, HR_PREGAME_PRIOR in hrConversionModel.ts). That
// precedent fits a flag guarding one specific, already-colocated code path
// in an existing file; here all six flags gate pieces of one currently-
// dormant subsystem with no existing file to naturally live in. Scattering
// them would force every later PR to add a new file just to hold one flag.
//
// All seven default to their INERT value (OFF / 0 / ""), inverted from the
// existing default-ON kill-switch precedent, since this is new dormant
// infrastructure, not a guard on already-shipped behavior.
//
// Every parser is a pure, exported function (not just an opaque module-level
// IIFE) so fail-closed behavior is directly unit-testable against many
// synthetic input strings, not merely checked once against whatever happens
// to be in process.env at process start. See hrRadarResearchContracts.test.ts.
//
// PR 1 scope: nothing in this PR branches on any of these flags — there is
// no `if (FLAG)` anywhere in this PR's diff. They exist solely so PR 2+ can
// import already-correct parsing/defaulting logic.
// ─────────────────────────────────────────────────────────────────────────────

const TRUTHY_VALUES = new Set(["true", "1", "on", "yes"]);

/**
 * Fails closed to `false` for anything other than an exact (case-insensitive,
 * trimmed) match against "true" | "1" | "on" | "yes" — including missing,
 * empty, or garbage input.
 */
export function parseHrResearchBooleanFlag(raw: string | undefined): boolean {
  const normalized = (raw ?? "").trim().toLowerCase();
  return TRUTHY_VALUES.has(normalized);
}

/**
 * Fails closed to `0` for non-numeric, non-finite, negative, or >100 input —
 * deliberately NOT clamped into range, since clamping a typo like "150" down
 * to 100 would silently mask bad input instead of failing closed.
 */
export function parseHrResearchGamePercent(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return 0;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return 0;
  return parsed;
}

/**
 * Trims and returns as-is; missing/empty stays "". An empty model version
 * must be treated by later PRs' challenger runner (PR 5+) as "no active
 * model" — forcing challenger behavior inert regardless of the other
 * challenger-related flags' values. That dependency is not enforced by any
 * code in PR 1 (no call site exists yet); it is documented here for PR 5+.
 */
export function parseHrResearchModelVersion(raw: string | undefined): string {
  return (raw ?? "").trim();
}

// Feature flag: HR_RADAR_EVAL_CAPTURE_ENABLED
//   Purpose: gates writing hr_radar_evaluation_snapshots rows from the live
//     HR path (PR 2+). Default OFF; set env to true/1/on/yes to enable.
//   Promotion plan: flip ON in a research/shadow environment once PR 2 lands;
//     never flip ON in a way that affects champion HR Radar output — this
//     flag only ever controls an additional, isolated DB write.
export const HR_RADAR_EVAL_CAPTURE_ENABLED: boolean = parseHrResearchBooleanFlag(
  process.env.HR_RADAR_EVAL_CAPTURE_ENABLED,
);

// Feature flag: HR_RADAR_SHADOW_MODEL_ENABLED
//   Purpose: gates running the challenger model inference in shadow (PR 5+).
//     Default OFF; set env to true/1/on/yes to enable.
//   Promotion plan: flip ON only after PR 5's artifact loader + inference
//     path exists; never consulted by champion HR Radar code.
export const HR_RADAR_SHADOW_MODEL_ENABLED: boolean = parseHrResearchBooleanFlag(
  process.env.HR_RADAR_SHADOW_MODEL_ENABLED,
);

// Feature flag: HR_RADAR_SHADOW_ADMIN_ENABLED
//   Purpose: gates any admin-only shadow-metrics UI/route surfacing
//     challenger output (later PR). Default OFF; set env to true/1/on/yes to
//     enable.
//   Promotion plan: flip ON only once an admin surface actually exists to
//     read it; never exposed to non-admin users.
export const HR_RADAR_SHADOW_ADMIN_ENABLED: boolean = parseHrResearchBooleanFlag(
  process.env.HR_RADAR_SHADOW_ADMIN_ENABLED,
);

// Feature flag: HR_RADAR_CHALLENGER_POLICY_ENABLED
//   Purpose: gates the challenger's own Watch/Build/Ready/Fire stage-policy
//     evaluation, as opposed to just raw probabilities (later PR). Default
//     OFF; set env to true/1/on/yes to enable.
//   Promotion plan: flip ON only after a frozen policy version exists (PR 6);
//     never influences the champion decision contract before an explicitly
//     approved canary phase (PR 7).
export const HR_RADAR_CHALLENGER_POLICY_ENABLED: boolean = parseHrResearchBooleanFlag(
  process.env.HR_RADAR_CHALLENGER_POLICY_ENABLED,
);

// Feature flag: HR_RADAR_CHALLENGER_GAME_PERCENT
//   Purpose: percent (0-100) of live games the challenger shadow pipeline
//     samples once enabled (traffic-shaping, not a boolean gate). Default 0
//     (no games sampled) until PR 5+ explicitly raises it in a research env.
//   Promotion plan: raised gradually as shadow-run confidence grows; never
//     consulted by champion HR Radar code. Invalid/out-of-range input fails
//     closed to 0, not clamped into range.
export const HR_RADAR_CHALLENGER_GAME_PERCENT: number = parseHrResearchGamePercent(
  process.env.HR_RADAR_CHALLENGER_GAME_PERCENT,
);

// Feature flag: HR_RADAR_MODEL_VERSION
//   Purpose: pins which hr_radar_model_registry.model_version the shadow
//     runner (PR 5+) loads for inference. Default "" (unset) — no model is
//     ever implicitly selected; an unset value must make later PRs' loader
//     no-op, not fall back to "latest".
export const HR_RADAR_MODEL_VERSION: string = parseHrResearchModelVersion(
  process.env.HR_RADAR_MODEL_VERSION,
);

// Feature flag: HR_RADAR_EVAL_CAPTURE_GAME_PERCENT (PR 2)
//   Purpose: percent (0-100) of live games the evaluation-capture observer
//     samples once HR_RADAR_EVAL_CAPTURE_ENABLED is also on (traffic-shaping,
//     not a boolean gate). Default 0 (no games sampled). Deliberately a
//     SEPARATE flag/parse call from HR_RADAR_CHALLENGER_GAME_PERCENT — the
//     two subsystems (capture vs. future challenger shadow) roll out on
//     independent schedules and must never share one sampling knob.
//   Promotion plan: raise gradually (e.g. to 10) once PR 2 lands in a
//     research/shadow environment; never consulted by champion HR Radar
//     code. Invalid/out-of-range input fails closed to 0, not clamped.
export const HR_RADAR_EVAL_CAPTURE_GAME_PERCENT: number = parseHrResearchGamePercent(
  process.env.HR_RADAR_EVAL_CAPTURE_GAME_PERCENT,
);

export interface HrRadarResearchFlagsSnapshot {
  HR_RADAR_EVAL_CAPTURE_ENABLED: boolean;
  HR_RADAR_SHADOW_MODEL_ENABLED: boolean;
  HR_RADAR_SHADOW_ADMIN_ENABLED: boolean;
  HR_RADAR_CHALLENGER_POLICY_ENABLED: boolean;
  HR_RADAR_CHALLENGER_GAME_PERCENT: number;
  HR_RADAR_MODEL_VERSION: string;
  HR_RADAR_EVAL_CAPTURE_GAME_PERCENT: number;
}

/** Convenience snapshot of all seven flags' current (import-time-resolved) values. */
export function hrRadarResearchFlagsSnapshot(): HrRadarResearchFlagsSnapshot {
  return {
    HR_RADAR_EVAL_CAPTURE_ENABLED,
    HR_RADAR_SHADOW_MODEL_ENABLED,
    HR_RADAR_SHADOW_ADMIN_ENABLED,
    HR_RADAR_CHALLENGER_POLICY_ENABLED,
    HR_RADAR_CHALLENGER_GAME_PERCENT,
    HR_RADAR_MODEL_VERSION,
    HR_RADAR_EVAL_CAPTURE_GAME_PERCENT,
  };
}
