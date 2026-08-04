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
import { isoInstantMs, parseCanonicalId } from "./canonicalEntities";

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

/**
 * Parse an ISO instant to epoch ms. Delegates to `isoInstantMs`, which REQUIRES
 * an explicit timezone offset (…Z or ±HH:MM) — an offsetless datetime would be
 * parsed in the process-local zone and make `knownAt <= predictionAt` depend on
 * where the process runs. Returns NaN for offsetless/unparseable values.
 */
export function instantMs(iso: string): number {
  return isoInstantMs(iso);
}

/**
 * Structural validity of a row's state↔value pairing and its instants. This is a
 * CONTRACT check (shape), not the leakage check (which needs a predictionAt).
 */
export function isStructurallyValidFeatureRow(row: AsOfFeatureRow): boolean {
  // The state must be a DECLARED enum member — a typo (e.g. "observd") has no
  // defined semantics and must never clear structural validity (and thus never
  // clear the leakage firewall) just because it happens not to be value-bearing.
  if (!isFeatureState(row.state)) return false;
  if (!Number.isFinite(instantMs(row.validAt))) return false;
  if (!Number.isFinite(instantMs(row.knownAt))) return false;
  if (typeof row.featureKey !== "string" || row.featureKey.length === 0) return false;
  if (typeof row.featureVersion !== "string" || row.featureVersion.length === 0) return false;
  if (typeof row.sourceId !== "string" || row.sourceId.length === 0) return false;
  if (!Number.isInteger(row.season)) return false;

  // Identity fields must be internally consistent: the canonical id must parse
  // and its sport/kind must equal the row's redundant `sport`/`entityKind`. A
  // row like sport="nba", entityCanonicalId="nba:player:1", entityKind="team"
  // is malformed and must never enter an input set via a string-only filter.
  const parsedId = parseCanonicalId(row.entityCanonicalId);
  if (!parsedId) return false;
  if (parsedId.sport !== row.sport) return false;
  if (parsedId.kind !== row.entityKind) return false;

  // Provenance, when present, must be an ARRAY OF STRINGS. A persisted/provider
  // row could carry `{}` or a JSON string in this jsonb-backed field; the type
  // annotation is not a runtime guarantee. A malformed value must fail here so
  // the same-game guard never runs `.includes` on a non-array. `null` (the
  // nullable DB column's "no provenance recorded") is treated the same as an
  // absent value — `!= null` skips both null and undefined.
  if (row.derivedFromGameIds != null) {
    if (!Array.isArray(row.derivedFromGameIds)) return false;
    if (!row.derivedFromGameIds.every((g) => typeof g === "string")) return false;
  }

  // `observed_zero` means a GENUINELY MEASURED zero — it must carry exactly 0.
  // A nonzero value under this state would defeat the measured-zero distinction.
  if (row.state === "observed_zero") {
    return row.value === 0;
  }
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

/**
 * The subset of a persisted `pregame_feature_snapshots` row as the DB layer
 * hands it back: Drizzle maps `timestamp` columns to `Date` and `numeric` to a
 * STRING (`"0.18"`), neither of which the shared contract accepts. This is the
 * bridge shape between storage and `AsOfFeatureRow`.
 */
export interface PersistedFeatureSnapshotFields {
  sport: string;
  entityCanonicalId: string;
  entityKind: string;
  featureKey: string;
  featureVersion: string;
  season: number;
  validAt: Date | string;
  knownAt: Date | string;
  state: string;
  value: number | string | null;
  sourceId: string;
  derivedFromGameIds?: readonly string[] | null;
}

/**
 * Normalize a DB-read feature snapshot into the shared `AsOfFeatureRow` contract:
 *  • `Date` instants → offset-bearing ISO strings (so `instantMs` accepts them and
 *    the `knownAt <= predictionAt` cutoff stays timezone-correct), and
 *  • a `numeric` value returned as a string → a number.
 *
 * A persisted row MUST pass through this mapper before it is fed to the store /
 * firewall / replay — otherwise the raw `Date`/`string` shapes would be rejected
 * as `malformed_instants` / `structural_invalid` even though the row is valid.
 */
export function asOfRowFromPersisted(row: PersistedFeatureSnapshotFields): AsOfFeatureRow {
  return {
    sport: row.sport as PregameSport,
    entityCanonicalId: row.entityCanonicalId,
    entityKind: row.entityKind as PregameEntityKind,
    featureKey: row.featureKey,
    featureVersion: row.featureVersion,
    season: row.season,
    validAt: row.validAt instanceof Date ? row.validAt.toISOString() : row.validAt,
    knownAt: row.knownAt instanceof Date ? row.knownAt.toISOString() : row.knownAt,
    state: row.state as FeatureState,
    value:
      row.value === null
        ? null
        : typeof row.value === "number"
          ? row.value
          : Number(row.value),
    sourceId: row.sourceId,
    // null (nullable DB column) collapses to absent, matching the contract.
    derivedFromGameIds: row.derivedFromGameIds ?? undefined,
  };
}
