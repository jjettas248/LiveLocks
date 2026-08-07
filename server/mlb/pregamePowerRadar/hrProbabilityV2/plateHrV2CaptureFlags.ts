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

// ── PR7A: Retrosheet plate-discipline (no-location) capture flag ──────────────
// Gates the (future) Retrosheet-backed discipline capture into the plate_hr_v2_*
// research tables. Same fail-closed affirmative parsing as above. Inert by default.
// Per contract §6, PR7A capture ADDITIONALLY requires the master
// PLATE_HR_V2_FORWARD_CAPTURE_ENABLED — see isPlateDisciplineNoLocationCaptureEnabled().
export const PLATE_DISCIPLINE_NO_LOCATION_V1_ENV = "PLATE_DISCIPLINE_NO_LOCATION_V1_ENABLED" as const;

export function parsePlateDisciplineNoLocationFlag(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  return AFFIRMATIVE.has(raw.trim().toLowerCase());
}

/** True iff the PR7A discipline flag is affirmatively set. */
export function isPlateDisciplineNoLocationEnabled(): boolean {
  return parsePlateDisciplineNoLocationFlag(process.env[PLATE_DISCIPLINE_NO_LOCATION_V1_ENV]);
}

/**
 * The effective PR7A capture gate: BOTH the master forward-capture flag AND the
 * PR7A discipline flag must be affirmatively set (contract §6, "Both default off
 * ⇒ inert"). Either being off keeps the whole PR7A path inert.
 */
export function isPlateDisciplineNoLocationCaptureEnabled(): boolean {
  return isPlateHrV2ForwardCaptureEnabled() && isPlateDisciplineNoLocationEnabled();
}
