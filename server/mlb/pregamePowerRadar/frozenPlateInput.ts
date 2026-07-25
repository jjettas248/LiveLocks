// The Plate — the frozen per-candidate input DTO.
//
// Champion and challenger must never evaluate different data. This module owns
// the one immutable snapshot both receive: built once from the already-gathered
// sources, deep-frozen so neither model can mutate it, and hashed so the
// comparison record can PROVE they saw the same bytes rather than asserting it.
//
// No I/O. No fetches inside scoring. The `research` block is the only part that
// may be absent — it holds challenger-only enrichment, and when shadow
// evaluation is disabled it is never collected at all.

import { createHash } from "crypto";
import type { PowerDriver } from "./types";

export interface FrozenPlateBatterInput {
  xISO: number | null;
  xSLG: number | null;
  barrelRatePct: number | null;
  hardHitRatePct: number | null;
  exitVelocity: number | null;
  maxEV: number | null;
  flyBallPct: number | null;
  hrFBRatioPct: number | null;
  pullRatePct: number | null;
  sweetSpotPct: number | null;
  xwOBA: number | null;
  battedBallEvents: number | null;
  bats: "L" | "R" | "S" | null;
}

export interface FrozenPlatePitcherInput {
  pitcherKnown: boolean;
  throws: "L" | "R" | null;
  hrPer9VsLHB: number | null;
  hrPer9VsRHB: number | null;
  eraVsLHB: number | null;
  eraVsRHB: number | null;
}

/**
 * Challenger-only enrichment. Every field is nullable and the whole block
 * carries `collected` so "we didn't look" is distinguishable from "we looked
 * and there was nothing" — a distinction the comparison analytics need in order
 * to avoid reporting a disagreement that is really a missing fetch.
 */
export interface FrozenPlateResearchInput {
  collected: boolean;
  unavailableReason: "shadow_disabled" | "fetch_failed" | "no_pitcher" | null;
  barrelAllowedPct: number | null;
  hardHitAllowedPct: number | null;
  flyBallAllowedPct: number | null;
  last3StartERA: number | null;
  daysSinceLastStart: number | null;
}

export interface FrozenPlateMatchupInput {
  batterOpsVsHand: number | null;
  batterXslgVsDominantFamily: number | null;
  parkFavorsPull: boolean;
  bvpPlateAppearances: number | null;
  bvpAtBats: number | null;
  bvpHr: number | null;
  bvpHits: number | null;
  bvpStrikeouts: number | null;
  bvpOps: number | null;
  bvpAvg: number | null;
}

export interface FrozenPlateParkWeatherInput {
  parkHrFactor: number | null;
  isIndoors: boolean;
  weatherAvailable: boolean;
  temperature: number | null;
  windSpeed: number | null;
  windDirection: "in" | "out" | "cross" | "calm" | null;
}

export interface FrozenPlateLineupInput {
  battingOrderSlot: number | null;
  lineupPosted: boolean;
  teamImpliedRuns: number | null;
  obpAhead: number | null;
}

export interface FrozenPlateDataQuality {
  savantQuality: "full" | "fallback" | "missing";
  venueResolved: boolean;
  pitcherHandResolved: boolean;
}

/**
 * Component outputs that are POLICY-INDEPENDENT by construction — no field of
 * PlateModelPolicy reaches them. Freezing the outputs (rather than re-deriving
 * from raw inputs inside each model) is what guarantees the champion evaluation
 * reproduces the production champion bit-for-bit instead of approximating it.
 */
export interface FrozenPlatePrecomputed {
  nearHrRecentForm: { score10: number; available: boolean; drivers: PowerDriver[] };
  batterOrderSplit: { score10: number; direction: BatterOrderDirection; drivers: PowerDriver[] };
  pitcherOrderSplit: {
    score10: number;
    available: boolean;
    direction: PitcherOrderDirection;
    drivers: PowerDriver[];
  };
}

export type BatterOrderDirection = "strong" | "neutral" | "weak" | "unavailable";
export type PitcherOrderDirection = "vulnerable" | "neutral" | "suppressive" | "unavailable";

export interface FrozenPlateInput {
  sessionDate: string;
  gameId: string;
  batterId: string;
  pitcherId: string | null;
  batter: FrozenPlateBatterInput;
  pitcher: FrozenPlatePitcherInput;
  research: FrozenPlateResearchInput;
  matchup: FrozenPlateMatchupInput;
  parkWeather: FrozenPlateParkWeatherInput;
  lineup: FrozenPlateLineupInput;
  precomputed: FrozenPlatePrecomputed;
  dataQuality: FrozenPlateDataQuality;
}

/** Recursively freeze so neither model can mutate what the other will read. */
export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

/**
 * Stable serialization: keys sorted at every level, so an object-literal
 * reordering can never change the hash and produce a spurious "different
 * inputs" reading.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function hashFrozenPlateInput(input: FrozenPlateInput): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 16);
}

export function freezePlateInput(input: FrozenPlateInput): Readonly<FrozenPlateInput> {
  return deepFreeze(input);
}

export const RESEARCH_UNCOLLECTED: FrozenPlateResearchInput = {
  collected: false,
  unavailableReason: "shadow_disabled",
  barrelAllowedPct: null,
  hardHitAllowedPct: null,
  flyBallAllowedPct: null,
  last3StartERA: null,
  daysSinceLastStart: null,
};
