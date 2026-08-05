// PR3 — NBA Pregame Targets: shadow flag parser (scaffolding only).
//
// Fail-closed, inert-by-default flags for the eventual shadow/public rollout of
// the NBA pregame projection core. This module is a TESTED PARSER ONLY: nothing
// here is wired into any route, scheduler, engine build loop, or persistence path
// in PR3. It exists so the later PR that actually integrates the projection core
// has a single, already-verified place to read these gates from — mirroring the
// discipline of plateShadowFlags.ts. The default (unset / typo / empty) is OFF,
// so the failure mode is "no shadow behavior", never "unexpected model runs".

export const NBA_PREGAME_SHADOW_ENV = "NBA_PREGAME_TARGETS_SHADOW" as const;
export const NBA_PREGAME_PUBLIC_ENV = "NBA_PREGAME_TARGETS_PUBLIC" as const;

const AFFIRMATIVE = new Set(["true", "1", "on", "yes"]);

/** Parse a single flag value. Only an exact affirmative (case/space-insensitive) enables it. */
export function parseNbaPregameFlag(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  return AFFIRMATIVE.has(raw.trim().toLowerCase());
}

/**
 * Read the flags at call time (not module load) so a deploy that flips a variable
 * takes effect on the next cycle without a restart-ordering dependency. Public
 * implies shadow: a projection cannot be published without also being shadowed.
 */
export function readNbaPregameFlags(env: NodeJS.ProcessEnv = process.env): {
  shadow: boolean;
  public: boolean;
} {
  const shadow = parseNbaPregameFlag(env[NBA_PREGAME_SHADOW_ENV]);
  const publicFlag = parseNbaPregameFlag(env[NBA_PREGAME_PUBLIC_ENV]);
  // Public can never be on while shadow is off — fail closed to shadow-gated.
  return { shadow: shadow || publicFlag, public: publicFlag && shadow };
}

export function isNbaPregameShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readNbaPregameFlags(env).shadow;
}

export function isNbaPregamePublicEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readNbaPregameFlags(env).public;
}
