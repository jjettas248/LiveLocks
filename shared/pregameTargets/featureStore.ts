// PR1 — As-of feature store contract (temporal data foundation).
//
// The single most important guarantee of the Pregame Targets program is that a
// historical decision can be reconstructed using ONLY what was knowable at the
// decision instant. Every feature therefore carries two instants:
//
//   • validAt — when the underlying fact became true (EVENT time). A player's
//     rebound rate "as of game N" has validAt = game N's end.
//   • knownAt — the earliest instant we could actually have OBSERVED it (data
//     arrival / publish time). A box score is valid at game end but only known
//     minutes-to-hours later.
//
// A feature is usable for a decision at `predictionAt` only when
// `knownAt <= predictionAt`. Comparing on validAt instead is the classic leakage
// bug (using a fact before it was observable). This contract makes both instants
// mandatory and first-class; the leakage firewall (server side) enforces the
// inequality.
//
// Instants are ISO-8601 strings with an explicit offset (…Z). They are compared
// as absolute instants via epoch ms (timezone-agnostic) — NOT via `todayET()`,
// which is for CALENDAR-DATE / slate logic, not instant ordering. Any calendar
// derivation from these instants must still go through the ET date helpers.

import type { PregameEntityKind, PregameSport } from "./canonicalEntities";

/**
 * The observability state of a feature value. `missing` and `observed_zero` are
 * deliberately distinct: a rebound rate of 0 that was really measured is NOT the
 * same as "we have no reading" — conflating them silently biases every model
 * downstream. Non-`observed*` states always carry `value: null`.
 */
export const FEATURE_STATES = [
  "observed", // a real, measured, non-null value
  "observed_zero", // genuinely measured zero (distinct from missing)
  "not_applicable", // structurally N/A for this entity/context
  "missing", // should exist but was not observed
  "stale", // last-known value older than the freshness bound for its use
  "disagreement", // multiple sources disagree and it is unresolved
  "imputed", // filled from a model/prior, not observed
] as const;
export type FeatureState = (typeof FEATURE_STATES)[number];

/** States that carry a real numeric reading (value must be finite, non-null). */
export const VALUE_BEARING_STATES: ReadonlySet<FeatureState> = new Set<FeatureState>([
  "observed",
  "observed_zero",
  "imputed",
]);

/**
 * A single as-of feature reading. Immutable by contract — a correction is a NEW
 * row with a later `knownAt`, never an in-place edit (so replay can reconstruct
 * what was known at any past instant).
 */
export interface AsOfFeatureRow {
  sport: PregameSport;
  /** Canonical entity id (see canonicalEntities.ts) this feature describes. */
  entityCanonicalId: string;
  entityKind: PregameEntityKind;
  /** Stable feature identifier, e.g. "nba.player.reb_per_min". */
  featureKey: string;
  /** Semantic version of the feature DEFINITION (bump on formula changes). */
  featureVersion: string;
  /** The season this reading pertains to (e.g. 2026 for the 2025-26 season). */
  season: number;

  /** Event time — when the underlying fact became true (ISO instant). */
  validAt: string;
  /** Observation time — earliest instant it could have been known (ISO instant). */
  knownAt: string;

  state: FeatureState;
  /** Finite number for value-bearing states; null otherwise. */
  value: number | null;

  /** Identifier of the raw source snapshot this reading was derived from. */
  sourceId: string;

  /**
   * Canonical game ids whose data contributed to this reading (provenance). A
   * season-aggregate feature lists every contributing game; a single-game
   * feature lists one. The leakage firewall rejects any reading whose provenance
   * includes the game being predicted (self-update). Absent/empty = "no game
   * provenance recorded" (e.g. a static prior) and is not self-update.
   */
  derivedFromGameIds?: readonly string[];
}

/** Parse an ISO instant to epoch ms; returns NaN on anything non-finite. */
export function instantMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Structural validity of a row's state↔value pairing and its instants. This is a
 * CONTRACT check (shape), not the leakage check (which needs a predictionAt).
 */
export function isStructurallyValidFeatureRow(row: AsOfFeatureRow): boolean {
  if (!Number.isFinite(instantMs(row.validAt))) return false;
  if (!Number.isFinite(instantMs(row.knownAt))) return false;
  if (typeof row.featureKey !== "string" || row.featureKey.length === 0) return false;
  if (typeof row.featureVersion !== "string" || row.featureVersion.length === 0) return false;
  if (!Number.isInteger(row.season)) return false;

  const valueBearing = VALUE_BEARING_STATES.has(row.state);
  if (valueBearing) {
    return typeof row.value === "number" && Number.isFinite(row.value);
  }
  // Non-value-bearing states MUST be null (not 0, not NaN) so "missing" can never
  // be silently read as a numeric zero.
  return row.value === null;
}

export function isFeatureState(v: unknown): v is FeatureState {
  return typeof v === "string" && (FEATURE_STATES as readonly string[]).includes(v);
}

/** A feature's numeric value if and only if it is a genuine reading, else null. */
export function readableValue(row: AsOfFeatureRow): number | null {
  return VALUE_BEARING_STATES.has(row.state) && typeof row.value === "number"
    ? row.value
    : null;
}
