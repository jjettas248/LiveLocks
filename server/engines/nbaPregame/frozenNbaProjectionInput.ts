// PR3 — NBA Pregame Targets: frozen projection input + canonical hashing.
//
// ONE versioned, immutable, deep-frozen DTO capturing every PMF-altering input to
// the blind projection engine, plus two DISTINCT hashes:
//
//   • FEATURE HASH — over the semantic INPUT: model version, input-schema
//     version, canonical player/game identity, season, latent strength, per-stat
//     posterior parameters (reason/ESS/rate mean+variance/game-total moments), the
//     minutes-distribution contents, and truncation caps. It EXCLUDES only the
//     non-semantic envelope (snapshotId, capturedAt, the hash field itself), so
//     identical evidence captured twice hashes identically regardless of when or
//     under what id it was captured.
//   • PROJECTION HASH — over the actual OUTPUT (see computeProjectionHash): model
//     version, feature hash, and every emitted market's key, PMF, mean, variance,
//     availability, and reason code. It is NOT a reuse of the feature hash — two
//     runs with byte-identical inputs share a feature hash AND (deterministically)
//     a projection hash, but the projection hash is derived from the OUTPUT and
//     changes if any emitted distribution changes.
//
// BLIND BY CONSTRUCTION: there is NO line/price/book/odds/edge/EV/outcome field
// anywhere on this type, and the builder additionally runs a runtime forbidden-key
// scan (fail closed) so an untyped leak is caught, not trusted.
//
// stableStringify handles the JSON-lossy values EXPLICITLY: undefined, NaN,
// +Infinity, -Infinity get distinct sentinels (JSON.stringify collapses them all
// to `null`/omission), and -0 is normalized to 0 — so byte-identical semantic
// input always yields byte-identical serialization, and semantically distinct
// values never collide.

import { createHash } from "node:crypto";
import { FORBIDDEN_PROJECTION_KEYS, normalizeProjectionKey } from "../../../shared/pregameTargets/projectionContract";
import type { NbaBaseStat, NbaMarketKey } from "./markets";
import type { StatPosteriorReason } from "./statPosterior";

export const NBA_PREGAME_MODEL_VERSION = "nba_pregame_projection_v1";
export const NBA_PREGAME_INPUT_SCHEMA_VERSION = "nba_pregame_input_v1";

/** Per-stat resolved posterior parameters — the PMF-altering modeling inputs. */
export interface FrozenStatInput {
  stat: NbaBaseStat;
  reason: StatPosteriorReason;
  projected: boolean;
  ess: number;
  rateMean: number | null;
  rateVariance: number | null;
  /** Game-total count moments (null when the stat is unavailable). */
  moments: { mean: number; variance: number } | null;
}

export interface FrozenMinutesSupportPoint {
  minutes: number;
  prob: number;
}

export interface FrozenMinutesInput {
  playerId: string;
  support: FrozenMinutesSupportPoint[];
  expectedMinutes: number;
  dnpProbability: number;
}

export interface FrozenNbaProjectionInput {
  // Envelope — EXCLUDED from both hashes (non-semantic) ----------------------
  snapshotId: string;
  capturedAt: string;
  featureHash: string;

  // Semantic identity + versions --------------------------------------------
  modelVersion: string;
  inputSchemaVersion: string;
  playerCanonicalId: string;
  gameCanonicalId: string;
  season: number;

  // PMF-altering modeling inputs --------------------------------------------
  latentStrength: number;
  /**
   * ONE canonical truncation-caps object over ALL FOUR base stats — including the
   * standalone three_pointers_made cap. Every cap alters an emitted PMF, so every
   * cap is part of the semantic (hashed) input. (Combo caps are derived from these
   * component caps, so they need no separate entry.)
   */
  truncationCaps: Record<NbaBaseStat, number>;
  stats: FrozenStatInput[];
  minutes: FrozenMinutesInput;
}

// ── Canonical serialization ──────────────────────────────────────────────────

/**
 * Deterministic, key-sorted stringify with EXPLICIT handling of JSON-lossy
 * values. undefined / NaN / ±Infinity are encoded as BAREWORD tokens
 * (`@undefined`, `@NaN`, `@Infinity`, `@-Infinity`) — never quoted. Because every
 * real string is emitted via JSON.stringify (always surrounded by `"`), a bareword
 * token can never collide with a legitimate string identity: the string
 * `"@NaN"` serializes to `"\"@NaN\""` (quoted), distinct from the numeric NaN's
 * `@NaN` (bareword). `-0` is normalized to `0` explicitly. Object keys are sorted
 * so serialization is insertion-order-independent.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "@undefined";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "@NaN";
    if (value === Infinity) return "@Infinity";
    if (value === -Infinity) return "@-Infinity";
    if (Object.is(value, -0)) return "0"; // explicit: -0 and +0 serialize identically
    return JSON.stringify(value);
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function sha256(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** The semantic (hashed) view of a frozen input — envelope fields stripped. */
type SemanticInput = Omit<FrozenNbaProjectionInput, "snapshotId" | "capturedAt" | "featureHash">;

function semanticView(input: SemanticInput): SemanticInput {
  return {
    modelVersion: input.modelVersion,
    inputSchemaVersion: input.inputSchemaVersion,
    playerCanonicalId: input.playerCanonicalId,
    gameCanonicalId: input.gameCanonicalId,
    season: input.season,
    latentStrength: input.latentStrength,
    truncationCaps: input.truncationCaps,
    stats: input.stats,
    minutes: input.minutes,
  };
}

/** Feature hash over the semantic input (envelope excluded). */
export function computeFeatureHash(input: SemanticInput): string {
  return sha256(stableStringify(semanticView(input)));
}

// ── Projection (output) hash ─────────────────────────────────────────────────

export interface ProjectionHashMarket {
  market: NbaMarketKey;
  available: boolean;
  reason: string;
  pmf: number[] | null;
  mean: number | null;
  variance: number | null;
}

export interface ProjectionHashPayload {
  modelVersion: string;
  /** Binds the output hash to the exact input that produced it. */
  featureHash: string;
  markets: ProjectionHashMarket[];
}

/**
 * Projection hash over the OUTPUT — distinct from the feature hash. It folds in
 * every emitted market's PMF/mean/variance/availability/reason so that ANY change
 * to the produced distributions changes the hash, while byte-identical output
 * (from byte-identical input) reproduces it exactly.
 */
export function computeProjectionHash(payload: ProjectionHashPayload): string {
  // Sort markets by key so payload ordering never affects the hash.
  const markets = [...payload.markets].sort((a, b) => (a.market < b.market ? -1 : a.market > b.market ? 1 : 0));
  return sha256(stableStringify({ modelVersion: payload.modelVersion, featureHash: payload.featureHash, markets }));
}

// ── Blindness (fail-closed) ──────────────────────────────────────────────────

const FORBIDDEN_NORMALIZED: ReadonlySet<string> = new Set(FORBIDDEN_PROJECTION_KEYS.map(normalizeProjectionKey));

/** Deep, cycle-safe scan: does any nested key normalize to a forbidden price/EV token? */
export function carriesForbiddenKey(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) return value.some((v) => carriesForbiddenKey(v, seen));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_NORMALIZED.has(normalizeProjectionKey(k))) return true;
    if (carriesForbiddenKey(v, seen)) return true;
  }
  return false;
}

// ── Deep freeze ──────────────────────────────────────────────────────────────

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.getOwnPropertyNames(value).forEach((prop) => {
      deepFreeze((value as Record<string, unknown>)[prop]);
    });
    Object.freeze(value);
  }
  return value;
}

// ── Builder ──────────────────────────────────────────────────────────────────

export interface BuildFrozenNbaInputArgs {
  snapshotId: string;
  capturedAt: string;
  playerCanonicalId: string;
  gameCanonicalId: string;
  season: number;
  latentStrength: number;
  /** Canonical truncation caps for all four base stats (incl. standalone threes). */
  truncationCaps: Record<NbaBaseStat, number>;
  stats: FrozenStatInput[];
  minutes: FrozenMinutesInput;
  modelVersion?: string;
  inputSchemaVersion?: string;
}

/**
 * The sole constructor. Deterministic: identical args (other than snapshotId /
 * capturedAt) yield an identical featureHash. Deep-frozen so no later mutation can
 * alter a captured snapshot. THROWS if a forbidden price/EV/line key is present at
 * any depth (fail closed — a leak is never silently accepted).
 */
export function buildFrozenNbaProjectionInput(args: BuildFrozenNbaInputArgs): Readonly<FrozenNbaProjectionInput> {
  const semantic: SemanticInput = {
    modelVersion: args.modelVersion ?? NBA_PREGAME_MODEL_VERSION,
    inputSchemaVersion: args.inputSchemaVersion ?? NBA_PREGAME_INPUT_SCHEMA_VERSION,
    playerCanonicalId: args.playerCanonicalId,
    gameCanonicalId: args.gameCanonicalId,
    season: args.season,
    latentStrength: args.latentStrength,
    truncationCaps: args.truncationCaps,
    stats: args.stats,
    minutes: args.minutes,
  };

  if (carriesForbiddenKey(semantic)) {
    throw new Error("frozenNbaProjectionInput: forbidden price/EV/line key present — blindness violated");
  }

  const featureHash = computeFeatureHash(semantic);
  return deepFreeze({
    snapshotId: args.snapshotId,
    capturedAt: args.capturedAt,
    featureHash,
    ...semantic,
  });
}
