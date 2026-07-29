// Mound Radar V2 (shadow) — frozen point-in-time input contract.
//
// ONE versioned, immutable DTO both production Mound (V1, via the adapters
// in moundV1Adapters.ts) and Mound V2 evaluate from — so "V1 vs V2" is
// always a comparison of two models against the SAME evidence, never two
// models each fed by separately (and possibly inconsistently) rebuilt
// inputs. Capturing this once, at evaluation time, and freezing it is what
// makes a later grading pass honest: whatever the models saw is exactly
// what a human reviewer can see too, forever.
//
// No outcome field exists anywhere on this type BY CONSTRUCTION — there is
// no `finalStrikeouts`/`finalOutsRecorded`/`result` field to accidentally
// populate. Post-lock data (a later lineup change, a later odds move) must
// never be written back onto an already-captured snapshot; callers achieve
// this by never mutating a FrozenMoundInput object after `deepFreezeMoundInput`
// and by minting a NEW snapshotId (never reusing one) for any later capture.

export type MoundFrozenLineupStatus = "confirmed" | "projected" | "unconfirmed";
export type MoundFrozenDataQuality = "complete" | "partial" | "degraded";
export type MoundFrozenHandedness = "L" | "R" | "S";

export interface FrozenMoundBatterInput {
  playerId: string;
  playerName: string;
  battingOrderSlot: number;
  handedness: MoundFrozenHandedness | null;
  /** Shrunk K rate vs the pitcher's throwing hand (see opponentBatterKProfile.ts's shrinkage). */
  kRateVsThrowHand: number | null;
  /** Plate-appearance sample size backing kRateVsThrowHand — null/0 means "no real split data," never treated as a confident zero. */
  kRateSamplePa: number | null;
  bvpAtBats: number | null;
  bvpStrikeouts: number | null;
}

export interface FrozenMoundMarketQuote {
  line: number | null;
  overPrice: number | null;
  underPrice: number | null;
  sportsbook: string | null;
  /** The provider's real fetch timestamp — never Date.now() at capture time. Null iff no market was ever posted. */
  fetchedAt: string | null;
}

export interface FrozenMoundUmpireContext {
  name: string | null;
  /**
   * "unavailable" today, always — no umpire strikeout-tendency data source
   * exists anywhere in this codebase (confirmed against every Mound v1 input
   * file). Kept as a real field, not omitted, so a future data source has a
   * documented place to attach without a contract-shape change; never
   * fabricated in the meantime.
   */
  reliability: "confirmed" | "estimated" | "unavailable";
  kBoostFactor: number | null;
}

export interface FrozenMoundParkWeather {
  venueName: string | null;
  temperatureF: number | null;
  windMph: number | null;
  /** Same 0-10 signal computeRunEnvironment() already produces for production Mound — general park/weather proxy, not K-specific (see matchupAdjustedKs.ts's own header on this same limitation). */
  runEnvironmentScore10: number | null;
  runEnvironmentAvailable: boolean;
}

export interface FrozenMoundInput {
  // Identity — frozen forever ------------------------------------------------
  snapshotId: string;
  gameId: string;
  pitcherId: string;
  pitcherName: string;
  opponent: string;
  scheduledGameTime: string | null;
  /** When THIS snapshot was captured — distinct from scheduledGameTime. */
  evaluationTimestamp: string;

  // Lineup -------------------------------------------------------------------
  lineupStatus: MoundFrozenLineupStatus;
  battingOrder: FrozenMoundBatterInput[];

  // Pitcher -------------------------------------------------------------------
  pitcherThrows: MoundFrozenHandedness | null;
  kPer9: number | null;
  /** Positionally aligned [year-1, year-2] — null for a disqualified/missing year, never compacted (mirrors matchupAdjustedKs.ts's own contract). */
  priorSeasonsKPer9: (number | null)[];
  swStrPct: number | null;
  cswPct: number | null;
  missesBatsFamily: { family: "fastball" | "breaking" | "offspeed"; whiffPct: number; usagePct: number } | null;
  kRateVsLHB: number | null;
  kRateVsRHB: number | null;

  // Workload -------------------------------------------------------------------
  avgInningsPerStart: number | null;
  ipVarianceLast3: number | null;
  lastStartPitchCount: number | null;
  lastStartInningsPitched: number | null;
  bbPer9: number | null;

  // Context — no data source exists for these today; always null/"unavailable"
  umpireContext: FrozenMoundUmpireContext | null;
  parkWeather: FrozenMoundParkWeather | null;

  // Real sportsbook markets available AT CAPTURE TIME --------------------------
  strikeoutsMarket: FrozenMoundMarketQuote;
  outsMarket: FrozenMoundMarketQuote;

  dataQuality: MoundFrozenDataQuality;
  contractVersion: string;
  productionModelVersion: string;
  v2ModelVersion: string;
  /** Deterministic hash of every field above EXCEPT snapshotId/evaluationTimestamp/featureHash itself — see computeMoundFeatureHash. */
  featureHash: string;
}

import { createHash } from "node:crypto";

export const MOUND_FROZEN_CONTRACT_VERSION = "mound_frozen_input_v1";

// ── Deterministic feature hash ──────────────────────────────────────────────
// Self-contained (not imported from pregamePowerRadar/frozenPlateInput.ts) —
// same isolation discipline as every other Mound v1 utility. Node's crypto is
// used directly rather than pulling in a hashing library.

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** Hashes every field except snapshotId/evaluationTimestamp/featureHash, so identical evidence captured twice (idempotent re-evaluation) always hashes identically regardless of when or under what snapshot id it was captured. */
export function computeMoundFeatureHash(
  input: Omit<FrozenMoundInput, "snapshotId" | "evaluationTimestamp" | "featureHash">,
): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/** Recursively freezes a captured snapshot so no later code path can mutate a field after the fact (structural enforcement, not just convention). */
export function deepFreezeMoundInput<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.getOwnPropertyNames(value).forEach((prop) => {
      deepFreezeMoundInput((value as Record<string, unknown>)[prop]);
    });
    Object.freeze(value);
  }
  return value;
}

export interface BuildFrozenMoundInputArgs {
  snapshotId: string;
  gameId: string;
  pitcherId: string;
  pitcherName: string;
  opponent: string;
  scheduledGameTime: string | null;
  now: Date;
  lineupStatus: MoundFrozenLineupStatus;
  battingOrder: FrozenMoundBatterInput[];
  pitcherThrows: MoundFrozenHandedness | null;
  kPer9: number | null;
  priorSeasonsKPer9: (number | null)[];
  swStrPct: number | null;
  cswPct: number | null;
  missesBatsFamily: FrozenMoundInput["missesBatsFamily"];
  kRateVsLHB: number | null;
  kRateVsRHB: number | null;
  avgInningsPerStart: number | null;
  ipVarianceLast3: number | null;
  lastStartPitchCount: number | null;
  lastStartInningsPitched: number | null;
  bbPer9: number | null;
  umpireContext?: FrozenMoundUmpireContext | null;
  parkWeather?: FrozenMoundParkWeather | null;
  strikeoutsMarket: FrozenMoundMarketQuote;
  outsMarket: FrozenMoundMarketQuote;
  dataQuality: MoundFrozenDataQuality;
  productionModelVersion: string;
  v2ModelVersion: string;
}

/**
 * The sole constructor for a frozen snapshot. Deterministic: calling this
 * twice with identical `args` (other than snapshotId/now) yields identical
 * featureHash, and the returned object is deep-frozen so no later mutation
 * (a lineup change, a later odds move) can silently alter an already-
 * captured snapshot. There is no field anywhere on FrozenMoundInput for a
 * caller to even attempt writing outcome data into.
 */
export function buildFrozenMoundInput(args: BuildFrozenMoundInputArgs): Readonly<FrozenMoundInput> {
  const withoutHash: Omit<FrozenMoundInput, "snapshotId" | "evaluationTimestamp" | "featureHash"> = {
    gameId: args.gameId,
    pitcherId: args.pitcherId,
    pitcherName: args.pitcherName,
    opponent: args.opponent,
    scheduledGameTime: args.scheduledGameTime,
    lineupStatus: args.lineupStatus,
    battingOrder: args.battingOrder,
    pitcherThrows: args.pitcherThrows,
    kPer9: args.kPer9,
    priorSeasonsKPer9: args.priorSeasonsKPer9,
    swStrPct: args.swStrPct,
    cswPct: args.cswPct,
    missesBatsFamily: args.missesBatsFamily,
    kRateVsLHB: args.kRateVsLHB,
    kRateVsRHB: args.kRateVsRHB,
    avgInningsPerStart: args.avgInningsPerStart,
    ipVarianceLast3: args.ipVarianceLast3,
    lastStartPitchCount: args.lastStartPitchCount,
    lastStartInningsPitched: args.lastStartInningsPitched,
    bbPer9: args.bbPer9,
    umpireContext: args.umpireContext ?? { name: null, reliability: "unavailable", kBoostFactor: null },
    parkWeather: args.parkWeather ?? null,
    strikeoutsMarket: args.strikeoutsMarket,
    outsMarket: args.outsMarket,
    dataQuality: args.dataQuality,
    contractVersion: MOUND_FROZEN_CONTRACT_VERSION,
    productionModelVersion: args.productionModelVersion,
    v2ModelVersion: args.v2ModelVersion,
  };
  const featureHash = computeMoundFeatureHash(withoutHash);
  return deepFreezeMoundInput({
    snapshotId: args.snapshotId,
    evaluationTimestamp: args.now.toISOString(),
    featureHash,
    ...withoutHash,
  });
}
