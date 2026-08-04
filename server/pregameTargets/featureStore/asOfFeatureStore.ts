// PR1 — As-of feature store (temporal data foundation).
//
// The store is the SINGLE read path both live inference and historical backtest
// go through, which is what makes live/replay parity structural rather than
// hoped-for: an "as-of read" returns the most recent reading whose `knownAt` is
// <= the decision instant, and nothing else. A live decision (store holds only
// what has arrived) and a replay decision (store holds everything, filtered by
// knownAt) therefore see byte-identical inputs.
//
// PR1 ships an in-memory implementation. It is append-only (readings are
// immutable — a correction is a new row with a later knownAt), and the as-of
// read is deterministic including tie-breaks. DB-backed storage is a separate
// layer (server/storage.ts) and must preserve exactly this read semantics.

import {
  type AsOfFeatureRow,
  instantMs,
} from "../../../shared/pregameTargets/featureStore";
import type { PregameSport } from "../../../shared/pregameTargets/canonicalEntities";
import {
  type LeakageContext,
  type LeakageViolation,
  checkFeatureLeakage,
} from "./leakageFirewall";

export interface AsOfReadQuery {
  sport: PregameSport;
  entityCanonicalId: string;
  featureKey: string;
  /** If given, only readings of this feature-definition version are considered. */
  featureVersion?: string;
  /** The decision instant. Only readings with knownAt <= this are eligible. */
  predictionAt: string;
}

export interface InputSetResult {
  /** featureKey → the single as-of, leakage-safe reading chosen for it. */
  features: Map<string, AsOfFeatureRow>;
  /** Feature keys with no eligible reading (genuine absence → treat as missing). */
  missing: string[];
  /** Readings that existed but were rejected by the firewall, with reasons. */
  rejected: Array<{ row: AsOfFeatureRow; violations: LeakageViolation[] }>;
}

export interface AsOfFeatureStore {
  write(row: AsOfFeatureRow): void;
  writeMany(rows: readonly AsOfFeatureRow[]): void;
  /** As-of read: the most recent reading with knownAt <= predictionAt, or null. */
  readAsOf(query: AsOfReadQuery): AsOfFeatureRow | null;
  /**
   * Build a leakage-safe input set for a decision: one as-of reading per
   * requested feature key, each cleared by the firewall. This is the shared
   * builder for live inference and replay.
   */
  buildInputSet(
    sport: PregameSport,
    entityCanonicalId: string,
    featureKeys: readonly string[],
    ctx: LeakageContext,
    featureVersions?: Readonly<Record<string, string>>,
  ): InputSetResult;
  /** All stored rows (stable insertion order) — for diagnostics/replay dumps. */
  all(): readonly AsOfFeatureRow[];
  size(): number;
}

/**
 * Deterministic tie-break when two eligible readings share the same knownAt:
 * prefer the later validAt, then the greater sourceId, then the greater
 * featureVersion. The featureVersion tail matters when version selection is
 * unpinned and two versions are computed from the SAME source snapshot (equal
 * knownAt/validAt/sourceId) — without it the choice would depend on insertion
 * order and break live/replay parity. The DB as-of query orders by the same keys.
 */
function isPreferred(candidate: AsOfFeatureRow, incumbent: AsOfFeatureRow): boolean {
  const cK = instantMs(candidate.knownAt);
  const iK = instantMs(incumbent.knownAt);
  if (cK !== iK) return cK > iK;
  const cV = instantMs(candidate.validAt);
  const iV = instantMs(incumbent.validAt);
  if (cV !== iV) return cV > iV;
  if (candidate.sourceId !== incumbent.sourceId) return candidate.sourceId > incumbent.sourceId;
  return candidate.featureVersion > incumbent.featureVersion;
}

/**
 * Store an ISOLATED, deeply-frozen copy so a caller that mutates its row after
 * `write` cannot retroactively rewrite stored history (append-only: a correction
 * is a NEW row, never an edit). The provenance array is copied and frozen too.
 */
function isolateRow(row: AsOfFeatureRow): AsOfFeatureRow {
  const copy: AsOfFeatureRow = {
    ...row,
    derivedFromGameIds: row.derivedFromGameIds
      ? Object.freeze([...row.derivedFromGameIds])
      : undefined,
  };
  return Object.freeze(copy);
}

export function createInMemoryAsOfFeatureStore(): AsOfFeatureStore {
  const rows: AsOfFeatureRow[] = [];

  function readAsOf(query: AsOfReadQuery): AsOfFeatureRow | null {
    const predMs = instantMs(query.predictionAt);
    if (!Number.isFinite(predMs)) return null;

    let best: AsOfFeatureRow | null = null;
    for (const row of rows) {
      if (row.sport !== query.sport) continue;
      if (row.entityCanonicalId !== query.entityCanonicalId) continue;
      if (row.featureKey !== query.featureKey) continue;
      if (query.featureVersion != null && row.featureVersion !== query.featureVersion) continue;
      const knownMs = instantMs(row.knownAt);
      if (!Number.isFinite(knownMs) || knownMs > predMs) continue; // future → not knowable
      if (best === null || isPreferred(row, best)) best = row;
    }
    return best;
  }

  return {
    write(row) {
      rows.push(isolateRow(row));
    },
    writeMany(batch) {
      for (const r of batch) rows.push(isolateRow(r));
    },
    readAsOf,
    buildInputSet(sport, entityCanonicalId, featureKeys, ctx, featureVersions) {
      const features = new Map<string, AsOfFeatureRow>();
      const missing: string[] = [];
      const rejected: Array<{ row: AsOfFeatureRow; violations: LeakageViolation[] }> = [];

      for (const featureKey of featureKeys) {
        const reading = readAsOf({
          sport,
          entityCanonicalId,
          featureKey,
          featureVersion: featureVersions?.[featureKey],
          predictionAt: ctx.predictionAt,
        });
        if (reading === null) {
          missing.push(featureKey);
          continue;
        }
        const check = checkFeatureLeakage(reading, ctx);
        if (check.ok) {
          features.set(featureKey, reading);
        } else {
          rejected.push({ row: reading, violations: check.violations });
          missing.push(featureKey); // a rejected reading is a genuine absence
        }
      }
      return { features, missing, rejected };
    },
    all() {
      return rows;
    },
    size() {
      return rows.length;
    },
  };
}
