// Plate HR Probability V2 — forward-capture flag. Fail-closed, inert by default.
//
// This flag controls ONE thing: whether pregame candidates are captured into
// the plate_hr_v2_* research tables for a future PR2 to train against. It
// grants zero production/publication authority — nothing reads these tables
// on any request path a user can reach.
//
// Parsing mirrors modelVersions/plateShadowFlags.ts: only an exact
// affirmative enables it. A typo, an empty string, or an unset variable
// leaves capture inert, so the failure mode is "no research data collected",
// never "unexpected model runs".

export const PLATE_HR_V2_FORWARD_CAPTURE_ENV = "PLATE_HR_V2_FORWARD_CAPTURE_ENABLED" as const;

const AFFIRMATIVE = new Set(["true", "1", "on", "yes"]);

export function parsePlateHrV2ForwardCaptureFlag(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  return AFFIRMATIVE.has(raw.trim().toLowerCase());
}

/**
 * Read at call time rather than module load, so a deploy that flips the
 * variable takes effect on the next build cycle without a restart-ordering
 * dependency.
 */
export function isPlateHrV2ForwardCaptureEnabled(): boolean {
  return parsePlateHrV2ForwardCaptureFlag(process.env[PLATE_HR_V2_FORWARD_CAPTURE_ENV]);
}
