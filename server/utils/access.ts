interface AccessFlags {
  hasNBA: boolean;
  hasNCAAB: boolean;
  hasMLB: boolean;
  // Contract-only (PR2, migration plan C3). NFL is not operational, so NO
  // assignable subscription tier grants it — `hasNFL` is `false` for every real
  // tier and only `true` under the global admin bypass. The NFL entitlement
  // mapping is deliberately deferred to a later PR (data layer). Adding this
  // flag does not change hasNBA/hasNCAAB/hasMLB/hasUnlimited for any tier.
  hasNFL: boolean;
  hasUnlimited: boolean;
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
    // No assignable tier grants NFL (contract-only until the entitlement lands).
    hasNFL:       false,
    hasUnlimited: ["all", "elite"].includes(t),
  };
}
