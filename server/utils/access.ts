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
  const t = (tier ?? "").toLowerCase();
  return {
    hasNBA:       ["all", "elite"].includes(t),
    hasNCAAB:     ["all", "elite"].includes(t),
    hasMLB:       ["elite"].includes(t),
    hasUnlimited: ["all", "elite"].includes(t),
  };
}
