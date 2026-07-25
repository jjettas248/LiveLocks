// The Plate — shadow-challenger flag. Fail-closed, inert by default.
//
// This flag controls ONE thing: whether the challenger is evaluated at all. It
// cannot promote the challenger to production authority — the champion policy
// is hard-coded at the call site in buildPregamePowerRadar.ts, and no value of
// this variable reaches that decision.
//
// Parsing mirrors hrRadarResearchFlags.ts: only an exact affirmative enables it.
// A typo, an empty string, or an unset variable leaves the challenger inert, so
// the failure mode is "no shadow data collected", never "unexpected model runs".

export const PLATE_SHADOW_CHALLENGER_ENV = "PLATE_SHADOW_CHALLENGER_ENABLED" as const;

const AFFIRMATIVE = new Set(["true", "1", "on", "yes"]);

export function parsePlateShadowFlag(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  return AFFIRMATIVE.has(raw.trim().toLowerCase());
}

/**
 * Read at call time rather than module load, so a deploy that flips the variable
 * takes effect on the next build cycle without a restart-ordering dependency.
 */
export function isPlateShadowChallengerEnabled(): boolean {
  return parsePlateShadowFlag(process.env[PLATE_SHADOW_CHALLENGER_ENV]);
}
