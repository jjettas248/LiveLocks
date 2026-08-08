interface AccessFlags {
  hasNBA: boolean;
  hasNCAAB: boolean;
  hasMLB: boolean;
  // PR6 (NFL data & entitlement): the tier→NFL MAPPING is now defined
  // (`tierMapsToNfl`), but kept GATED OFF behind the default-off, fail-closed
  // `NFL_ENTITLEMENT_ENABLED` flag — because no NFL product is operational yet.
  // With the flag off (the default), `hasNFL` is `false` for every real tier,
  // exactly as before; only the global admin bypass sets it `true`. Enabling the
  // flag grants NFL to the mapped tier ("elite"/All Sports) and nothing else.
  // Adding/using this NEVER changes hasNBA/hasNCAAB/hasMLB/hasUnlimited.
  hasNFL: boolean;
  hasUnlimited: boolean;
}

/** Env flag that ACTIVATES the NFL entitlement mapping. Default OFF (fail-closed). */
export const NFL_ENTITLEMENT_ENABLED_ENV = "NFL_ENTITLEMENT_ENABLED" as const;
const NFL_FLAG_AFFIRMATIVE = new Set(["true", "1", "on", "yes"]);
export function isNflEntitlementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[NFL_ENTITLEMENT_ENABLED_ENV];
  return raw != null && NFL_FLAG_AFFIRMATIVE.has(raw.trim().toLowerCase());
}

/**
 * Contract mapping: which NORMALIZED tier WOULD grant NFL once the entitlement is
 * enabled. NFL is an "All Sports" sport (like MLB), so it maps to `elite`. Pure —
 * does NOT read the flag; the flag gates whether this mapping takes effect.
 */
export function tierMapsToNfl(normalizedTier: string): boolean {
  return normalizedTier === "elite";
}

export function resolveAccess(tier?: string | null, isAdmin?: boolean): AccessFlags {
  if (isAdmin) {
    // Admin is a global bypass — every sport flag is true, including the
    // contract-only hasNFL (no product reads it operationally yet).
    return { hasNBA: true, hasNCAAB: true, hasMLB: true, hasNFL: true, hasUnlimited: true };
  }
  const raw = (tier ?? "").toLowerCase().trim();
  // Canonical tiers are "all" (Pro NBA + NCAAB) and "elite" (All Sports incl. MLB).
  // Some users carry legacy / alternate labels in the DB (e.g. "all_sports") that
  // were previously treated as "no access", silently locking paid users out of
  // every sport. Normalize known aliases to the canonical name before gating.
  let t = raw;
  if (["all_sports", "all sports", "all-sports", "pro_all"].includes(raw)) {
    t = "elite";
  } else if (["pro_nba", "nba_only", "pro", "subscriber"].includes(raw)) {
    t = "all";
  }
  return {
    hasNBA:       ["all", "elite"].includes(t),
    hasNCAAB:     ["all", "elite"].includes(t),
    hasMLB:       ["elite"].includes(t),
    // Gated off by default → false for every tier (unchanged). Only when the
    // fail-closed NFL_ENTITLEMENT_ENABLED flag is on does the mapped tier grant NFL.
    hasNFL:       isNflEntitlementEnabled() && tierMapsToNfl(t),
    hasUnlimited: ["all", "elite"].includes(t),
  };
}
