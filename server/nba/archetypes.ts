export type NBAArchetype =
  | "stable_star"
  | "stable_starter"
  | "volatile_starter"
  | "bench_microwave"
  | "low_minute_big"
  | "lineup_impacted"
  | "role_uncertain";

export interface ArchetypeInput {
  avgMinutes: number;
  recentMinutesVariance?: number;
  seasonMinutesVariance?: number;
  isStarter?: boolean;
  starterConsistency?: number;
  usageRate?: number;
  usageVariance?: number;
  position?: string;
  lineupDisrupted?: boolean;
  gamesPlayed?: number;
}

export function classifyArchetype(input: ArchetypeInput): NBAArchetype {
  const {
    avgMinutes,
    recentMinutesVariance = 0,
    seasonMinutesVariance = 0,
    isStarter = avgMinutes >= 25,
    starterConsistency = isStarter ? 0.85 : 0.3,
    usageRate = 0.20,
    position,
    lineupDisrupted = false,
    gamesPlayed = 60,
  } = input;

  const minutesVar = Math.max(recentMinutesVariance, seasonMinutesVariance);
  const isHighVariance = minutesVar > 30;
  const isBig = position === "C" || position === "PF";

  if (lineupDisrupted || gamesPlayed < 15) {
    return "lineup_impacted";
  }

  if (starterConsistency < 0.5 && avgMinutes < 22) {
    return "role_uncertain";
  }

  if (avgMinutes >= 30 && starterConsistency >= 0.8 && !isHighVariance) {
    return "stable_star";
  }

  if (avgMinutes >= 24 && isStarter && !isHighVariance) {
    return "stable_starter";
  }

  if (avgMinutes >= 22 && isStarter && isHighVariance) {
    return "volatile_starter";
  }

  if (avgMinutes < 22 && isBig) {
    return "low_minute_big";
  }

  if (avgMinutes < 22 && usageRate >= 0.20) {
    return "bench_microwave";
  }

  if (avgMinutes >= 22) {
    return isHighVariance ? "volatile_starter" : "stable_starter";
  }

  return "bench_microwave";
}

export const VARIANCE_MULTIPLIERS: Record<NBAArchetype, number> = {
  stable_star: 1.00,
  stable_starter: 1.05,
  volatile_starter: 1.20,
  bench_microwave: 1.30,
  low_minute_big: 1.25,
  lineup_impacted: 1.35,
  role_uncertain: 1.40,
};

export const MINUTES_FRAGILITY_MULTIPLIERS: Record<NBAArchetype, number> = {
  stable_star: 1.00,
  stable_starter: 1.05,
  volatile_starter: 1.20,
  bench_microwave: 1.30,
  low_minute_big: 1.35,
  lineup_impacted: 1.40,
  role_uncertain: 1.50,
};

export interface CorrelationDefaults {
  rho_PR: number;
  rho_PA: number;
  rho_RA: number;
}

export const CORRELATION_DEFAULTS: Record<NBAArchetype, CorrelationDefaults> = {
  stable_star:       { rho_PR: 0.20, rho_PA: 0.28, rho_RA: 0.12 },
  stable_starter:    { rho_PR: 0.18, rho_PA: 0.22, rho_RA: 0.10 },
  volatile_starter:  { rho_PR: 0.14, rho_PA: 0.18, rho_RA: 0.08 },
  bench_microwave:   { rho_PR: 0.08, rho_PA: 0.12, rho_RA: 0.05 },
  low_minute_big:    { rho_PR: 0.22, rho_PA: 0.05, rho_RA: 0.10 },
  lineup_impacted:   { rho_PR: 0.14, rho_PA: 0.18, rho_RA: 0.08 },
  role_uncertain:    { rho_PR: 0.14, rho_PA: 0.18, rho_RA: 0.08 },
};

export const COMBO_VARIANCE_EXTRA: Record<NBAArchetype, number> = {
  stable_star: 1.0,
  stable_starter: 1.0,
  volatile_starter: 1.0,
  bench_microwave: 1.0,
  low_minute_big: 1.0,
  lineup_impacted: 1.12,
  role_uncertain: 1.12,
};

export const SAFETY_CEILINGS: Record<string, number> = {
  stable_single: 0.80,
  stable_combo: 0.74,
  volatile_single: 0.70,
  volatile_combo: 0.66,
  impacted_any: 0.64,
};

export function isVolatileArchetype(a: NBAArchetype): boolean {
  return a === "volatile_starter" || a === "bench_microwave" || a === "low_minute_big";
}

export function isImpactedArchetype(a: NBAArchetype): boolean {
  return a === "lineup_impacted" || a === "role_uncertain";
}

export function getSafetyCeiling(archetype: NBAArchetype, isCombo: boolean): number {
  if (isImpactedArchetype(archetype)) return SAFETY_CEILINGS.impacted_any;
  if (isVolatileArchetype(archetype)) return isCombo ? SAFETY_CEILINGS.volatile_combo : SAFETY_CEILINGS.volatile_single;
  return isCombo ? SAFETY_CEILINGS.stable_combo : SAFETY_CEILINGS.stable_single;
}

// ── Playoff-aware ceilings ────────────────────────────────────────────────
// Lower than regular-season ceilings across the board. Top-end probability is
// historically inflated in playoff conditions (tighter rotations, higher
// variance, tougher matchups) so we cap how confident the engine is allowed
// to be even before display rounding.
export function getPlayoffSafetyCeiling(archetype: NBAArchetype, isCombo: boolean): number {
  if (isImpactedArchetype(archetype)) return 0.60;
  if (isVolatileArchetype(archetype)) return isCombo ? 0.62 : 0.66;
  return isCombo ? 0.70 : 0.76;
}

// ── Playoff fragility multiplier ──────────────────────────────────────────
// Stars are slightly steadier in playoffs (coaches lean on them); fringe and
// bench archetypes get *more* fragile (shorter leashes, role compression,
// blowout substitutions, foul trouble matters more). Used to scale the
// fragilityScore in storage.calculateProbability when isPlayoffs.
export function getPlayoffFragilityMultiplier(archetype: NBAArchetype): number {
  switch (archetype) {
    case "stable_star":      return 0.98;
    case "stable_starter":   return 1.00;
    case "volatile_starter": return 1.08;
    case "bench_microwave":  return 1.15;
    case "low_minute_big":   return 1.12;
    case "lineup_impacted":  return 1.20;
    case "role_uncertain":   return 1.25;
    default:                 return 1.0;
  }
}
