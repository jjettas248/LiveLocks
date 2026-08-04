// PR1 — Historical replay harness (temporal data foundation, §9A.3).
//
// Reconstructs, for any past decision origin, EXACTLY the leakage-safe input set
// that was knowable at that instant — using the same `AsOfFeatureStore.buildInputSet`
// path live inference uses. That shared path is the whole point: a replay is not
// a separate code route that "approximates" live, it IS the live route pointed at
// a past `predictionAt`. This module adds only (a) a rolling-origin driver that
// processes many origins in deterministic time order and (b) a canonical,
// serializable projection of each result so live and replay outputs can be
// compared byte-for-byte (the parity guarantee).

import type { AsOfFeatureRow } from "../../../shared/pregameTargets/featureStore";
import type { PregameSport } from "../../../shared/pregameTargets/canonicalEntities";
import { instantMs } from "../../../shared/pregameTargets/featureStore";
import type { AsOfFeatureStore } from "../featureStore/asOfFeatureStore";
import type { LeakageContext, LeakageViolation } from "../featureStore/leakageFirewall";

export interface ReplayOrigin {
  sport: PregameSport;
  entityCanonicalId: string;
  /** The decision instant to reconstruct as-of. */
  predictionAt: string;
  featureKeys: readonly string[];
  /** Canonical id of the game being predicted (self-update guard). */
  targetGameId?: string;
  /** Feature keys that are outcomes and must never appear as inputs. */
  outcomeFeatureKeys?: ReadonlySet<string>;
  /** Optional per-feature version pins. */
  featureVersions?: Readonly<Record<string, string>>;
}

/** A single feature's reconstructed value — the minimal, comparable projection. */
export interface ReplayFeatureView {
  state: AsOfFeatureRow["state"];
  value: number | null;
  validAt: string;
  knownAt: string;
  featureVersion: string;
  sourceId: string;
}

export interface ReplayResult {
  sport: PregameSport;
  entityCanonicalId: string;
  predictionAt: string;
  /** featureKey → reconstructed reading (key-sorted for stable serialization). */
  features: Record<string, ReplayFeatureView>;
  /** Requested feature keys with no leakage-safe reading (sorted). */
  missing: string[];
  /** Firewall rejections (feature key + violations), sorted by key. */
  rejected: Array<{ featureKey: string; violations: LeakageViolation[] }>;
}

function toLeakageContext(origin: ReplayOrigin): LeakageContext {
  return {
    predictionAt: origin.predictionAt,
    targetGameId: origin.targetGameId,
    outcomeFeatureKeys: origin.outcomeFeatureKeys,
  };
}

/**
 * Reconstruct one origin's input set through the store's shared builder and
 * project it to a canonical, key-sorted, serialization-stable shape. Pure with
 * respect to the store's contents.
 */
export function replayOrigin(store: AsOfFeatureStore, origin: ReplayOrigin): ReplayResult {
  const built = store.buildInputSet(
    origin.sport,
    origin.entityCanonicalId,
    origin.featureKeys,
    toLeakageContext(origin),
    origin.featureVersions,
  );

  const features: Record<string, ReplayFeatureView> = {};
  for (const key of Array.from(built.features.keys()).sort()) {
    const row = built.features.get(key)!;
    features[key] = {
      state: row.state,
      value: row.value,
      validAt: row.validAt,
      knownAt: row.knownAt,
      featureVersion: row.featureVersion,
      sourceId: row.sourceId,
    };
  }

  const rejected = built.rejected
    .map((r) => ({ featureKey: r.row.featureKey, violations: r.violations.slice().sort() }))
    .sort((a, b) => (a.featureKey < b.featureKey ? -1 : a.featureKey > b.featureKey ? 1 : 0));

  return {
    sport: origin.sport,
    entityCanonicalId: origin.entityCanonicalId,
    predictionAt: origin.predictionAt,
    features,
    missing: built.missing.slice().sort(),
    rejected,
  };
}

/**
 * Rolling-origin replay: process origins in ascending `predictionAt` order
 * (deterministic; ties broken by entity then by original index) and reconstruct
 * each. Ordering never affects an individual result (each read is as-of and
 * independent) but a stable order makes the run reproducible and diffable.
 */
export function replayRollingOrigins(
  store: AsOfFeatureStore,
  origins: readonly ReplayOrigin[],
): ReplayResult[] {
  const ordered = origins
    .map((origin, index) => ({ origin, index }))
    .sort((a, b) => {
      const at = instantMs(a.origin.predictionAt);
      const bt = instantMs(b.origin.predictionAt);
      if (at !== bt) return at - bt;
      if (a.origin.entityCanonicalId !== b.origin.entityCanonicalId) {
        return a.origin.entityCanonicalId < b.origin.entityCanonicalId ? -1 : 1;
      }
      return a.index - b.index;
    });
  return ordered.map(({ origin }) => replayOrigin(store, origin));
}

/** Canonical JSON of a replay result — the unit of live/replay parity comparison. */
export function serializeReplayResult(result: ReplayResult): string {
  return JSON.stringify(result);
}
