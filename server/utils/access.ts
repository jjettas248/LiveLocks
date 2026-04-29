export interface AccessFlags {
  hasNBA: boolean;
  hasNCAAB: boolean;
  hasMLB: boolean;
  hasUnlimited: boolean;
}

export function resolveAccess(tier?: string | null, isAdmin?: boolean): AccessFlags {
  if (isAdmin) {
    return { hasNBA: true, hasNCAAB: true, hasMLB: true, hasUnlimited: true };
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
    hasUnlimited: ["all", "elite"].includes(t),
  };
}
