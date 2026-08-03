// Plate HR V2 — assemble real provider/entity evidence descriptors, derive the
// append-only two-layer snapshot write, and persist it safely (plan §7.1, PR3.1).
//
// PR3.1 rewrite: source evidence now comes from EXPLICIT per-provider/entity
// descriptors carrying real provenance (fetchedAt/availableAt/dataThroughAt/
// validForAt/contentHash/payloadRef), assembled at the fetch site from the data
// the build actually has. No family heuristics, no synthesized timestamps, no
// batter-wide input hash standing in for a source hash. Absent provenance →
// fail-closed (no descriptor). Odds/market and unverified zone are excluded by a
// CLOSED allowlist. The prediction stores the real MLB gamePk (not ESPN gameId).

import { createHash } from "node:crypto";
import type {
  InsertPlateHrV2SourceEvidence,
  InsertPlateHrV2PredictionSnapshot,
} from "@shared/schema";
import type { PlateHrV2CaptureRow } from "./plateHrV2ForwardCapture";
import {
  isPredictionSnapshotEligible,
  type EvidenceKind,
  type PlateHrV2EvidenceDescriptor,
  type ResolvedEligibilitySource,
} from "./plateHrV2Snapshots";

export interface PlateHrV2SnapshotWrite {
  sources: InsertPlateHrV2SourceEvidence[];
  prediction: InsertPlateHrV2PredictionSnapshot;
}

// CLOSED allowlist of derived-feature groups permitted into a captured snapshot.
// A group not listed here is dropped — a newly added group stays out until it is
// deliberately added. zoneLocation (unverified, PR2) and market/odds (never a
// model input) are intentionally absent.
export const AUTHORIZED_DERIVED_FEATURE_GROUPS: ReadonlySet<string> = new Set([
  "featureVersion",
  "batterPower",
  "batTracking",
  "pitcherVulnerability",
  "pitchType",
  "parkWeatherSpray",
  "lineupOpportunity",
  "starterBullpen",
  "availability",
  "contactOpportunity",
  "dataQuality",
  "slateBaselineGameHrProbability",
]);

/** Stable, sorted-key JSON → sha256. Deterministic content hash for a payload. */
export function canonicalHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex").slice(0, 40);
}

/** Stable, sorted-key JSON string. Canonical serialization used for hashing + cloning. */
export function canonicalJson(v: unknown): string {
  return stableStringify(v);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** Exclusive upper bound of a season-to-date Savant query = start of the fetch's
 * UTC day (the query used game_date_lt = fetch date, so it covers through the
 * prior day). Derived from the REAL fetch timestamp, not a synthesized string. */
export function startOfUtcDay(iso: string): string {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

// ── Descriptor assembly (pure) ────────────────────────────────────────────────

// CLOSED allowlist of authorized sufficient-stat top-level keys. Zone/chase
// fields are deliberately ABSENT (unauthorized, PR2), and any future/unknown
// top-level key is dropped rather than captured (PR4.2 #4). The nested values
// (pitchFamilyStats, pitchTypeExactStats, percentiles) are our own computed
// numeric structures — deep-cloned below so no live reference survives.
export const AUTHORIZED_SUFFICIENT_STAT_KEYS: ReadonlySet<string> = new Set([
  "pitchesSeen", "swings", "whiffs", "calledStrikes", "balls",
  "paCount", "strikeouts", "walks", "battedBallEvents",
  "pitchFamilyStats", "pitchTypeExactStats",
  "evPercentiles", "laPercentiles",
  "pulledBip", "sprayClassifiedBip", "sourceRowCount",
]);

/** Deep-clone through canonical JSON (sorted keys). Drops functions/undefined and
 * breaks all references, so a later mutation of the original can't change it. */
export function canonicalClone<T = unknown>(v: unknown): T {
  return JSON.parse(canonicalJson(v)) as T;
}

/** Project a sufficient-stats payload through the CLOSED allowlist and deep-clone
 * it — the immutable, self-contained authorized payload stored inline as evidence
 * (PR4.2 #4). Unknown/zone top-level keys are excluded. */
export function authorizedSufficientStatsPayload(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw == null || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (AUTHORIZED_SUFFICIENT_STAT_KEYS.has(k)) out[k] = canonicalClone(v);
  }
  return out;
}

export interface PlateHrV2EvidenceAssemblyInput {
  gamePk: string;
  batterId: string;
  pitcherId: string | null;
  capturedAtIso: string;
  firstPitchIso: string | null;
  schemaVersion: string;
  /** Real season-to-date Savant payloads (authorized counts) + their stable refs. */
  batterSufficientStats: unknown | null;
  batterStatsRef: string | null;
  pitcherSufficientStats: unknown | null;
  pitcherStatsRef: string | null;
  /** Real Savant fetch provenance (preserved through the cache), per entity.
   * fetchedAt/availableAt use these; dataThroughAt uses the query cutoff date.
   * Absent → fall back to the capture moment (documented, still ≤ prediction). */
  batterFetchedAtMs?: number | null;
  batterDataThroughDate?: string | null;
  pitcherFetchedAtMs?: number | null;
  pitcherDataThroughDate?: string | null;
  /** Game-level forecast used this cycle (shared across batters). */
  weather: { available: boolean; temperatureF: number | null; windSpeedMph: number | null; windDirection: string | null; isIndoors: boolean } | null;
  /** Whether the confirmed lineup was posted (game-level evidence, shared). */
  lineupPosted: boolean;
  /** Static park/venue evidence (shared across batters). */
  park: { venueResolved: boolean; payload: unknown } | null;
}

/**
 * Build the real evidence descriptors for one candidate. Emits a descriptor ONLY
 * when the underlying source genuinely exists — a missing source yields no
 * descriptor (fail-closed). Game/venue-level evidence (pitcher, weather, park,
 * lineup) carries batter-independent content so it dedupes across batters.
 */
export function assemblePlateHrV2EvidenceDescriptors(inp: PlateHrV2EvidenceAssemblyInput): PlateHrV2EvidenceDescriptor[] {
  const out: PlateHrV2EvidenceDescriptor[] = [];
  const captured = inp.capturedAtIso;
  const isoOrNull = (ms: number | null | undefined): string | null =>
    ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  // Query cutoff (game_date_lt, a YYYY-MM-DD) → ISO start-of-day (exclusive
  // season-to-date bound). Falls back to the fetch day when the cutoff is absent.
  const cutoffIso = (date: string | null | undefined, fetchedIso: string): string =>
    date ? `${date}T00:00:00.000Z` : startOfUtcDay(fetchedIso);

  const pushHistorical = (
    entityType: "batter" | "pitcher", entityId: string, rawStats: unknown, statsRef: string | null,
    fetchedAtMs: number | null | undefined, cutoffDate: string | null | undefined,
  ) => {
    const payload = authorizedSufficientStatsPayload(rawStats);
    const realFetchedAt = isoOrNull(fetchedAtMs);
    const hasProvenance = realFetchedAt != null && cutoffDate != null && cutoffDate !== "";
    if (hasProvenance) {
      out.push({
        provider: "baseball_savant", entityType, entityId, evidenceKind: "historical_stat",
        fetchedAt: realFetchedAt, availableAt: realFetchedAt, dataThroughAt: cutoffIso(cutoffDate, realFetchedAt), validForAt: null,
        schemaVersion: inp.schemaVersion, contentHash: canonicalHash(payload), payloadRef: statsRef,
        authorizedPayload: payload,
      });
      return;
    }
    // PR4.2 #1: a historical payload with NO real fetch time / cutoff must
    // INVALIDATE the prediction, not silently vanish (else weather/lineup/park
    // could still make it eligible). Emit an explicitly-ineligible source
    // (reconstructed, no dataThroughAt) — the capture moment is NEVER substituted.
    out.push({
      provider: "baseball_savant", entityType, entityId, evidenceKind: "historical_stat",
      fetchedAt: captured, availableAt: captured, dataThroughAt: null, validForAt: null,
      schemaVersion: inp.schemaVersion, contentHash: canonicalHash(payload), payloadRef: statsRef,
      authorizedPayload: payload,
    });
  };

  if (inp.batterSufficientStats != null) {
    pushHistorical("batter", inp.batterId, inp.batterSufficientStats, inp.batterStatsRef, inp.batterFetchedAtMs, inp.batterDataThroughDate);
  }
  if (inp.pitcherId && inp.pitcherSufficientStats != null) {
    pushHistorical("pitcher", inp.pitcherId, inp.pitcherSufficientStats, inp.pitcherStatsRef, inp.pitcherFetchedAtMs, inp.pitcherDataThroughDate);
  }
  if (inp.weather?.available) {
    const payload = { temperatureF: inp.weather.temperatureF, windSpeedMph: inp.weather.windSpeedMph, windDirection: inp.weather.windDirection, isIndoors: inp.weather.isIndoors };
    out.push({
      provider: "open_meteo", entityType: "game", entityId: inp.gamePk, evidenceKind: "weather_forecast",
      fetchedAt: captured, availableAt: captured, dataThroughAt: null, validForAt: inp.firstPitchIso,
      schemaVersion: inp.schemaVersion, contentHash: canonicalHash(payload), payloadRef: null, authorizedPayload: payload,
    });
  }
  if (inp.park?.venueResolved) {
    out.push({
      provider: "livelocks_park", entityType: "venue", entityId: inp.gamePk, evidenceKind: "park",
      fetchedAt: captured, availableAt: captured, dataThroughAt: null, validForAt: null,
      schemaVersion: inp.schemaVersion, contentHash: canonicalHash(inp.park.payload), payloadRef: null, authorizedPayload: inp.park.payload,
    });
  }
  if (inp.lineupPosted) {
    // Game-level "lineup confirmed" evidence — the batter's slot is a FEATURE,
    // not part of evidence identity, so this dedupes across the game's batters.
    const payload = { lineupConfirmed: true };
    out.push({
      provider: "mlb_stats_api", entityType: "game", entityId: inp.gamePk, evidenceKind: "lineup",
      fetchedAt: captured, availableAt: captured, dataThroughAt: null, validForAt: null,
      schemaVersion: inp.schemaVersion, contentHash: canonicalHash(payload), payloadRef: null, authorizedPayload: payload,
    });
  }
  return out;
}

function sourceId(d: PlateHrV2EvidenceDescriptor, contentHash: string): string {
  // provider + entity + kind + dataThroughAt + schemaVersion + contentHash
  // (PR4.2 #3). Identical content across different cutoffs or schema versions
  // mints DISTINCT immutable rows, so ON CONFLICT DO NOTHING never retains stale
  // provenance. Shared game/venue evidence (same everything) still dedupes.
  return [
    "plate-hr-v2-src", d.provider, d.entityType, d.entityId, d.evidenceKind,
    d.dataThroughAt ?? "none", d.schemaVersion, contentHash,
  ].join(":");
}

function predictionId(gamePk: string, batterId: string, featureVersion: string, predictionAsOfIso: string): string {
  return `plate-hr-v2-pred:${gamePk}:${batterId}:${featureVersion}:${predictionAsOfIso}`;
}

/**
 * Build the append-only source-evidence rows + one prediction snapshot from a
 * capture row's REAL descriptors. Pure. Throws when the real MLB gamePk is
 * missing (a snapshot without a valid gamePk must not be written) — the persister
 * counts the failure rather than propagating it.
 */
export function buildPlateHrV2SnapshotWrite(row: PlateHrV2CaptureRow): PlateHrV2SnapshotWrite {
  if (!row.gamePk) throw new Error("missing_gamePk");
  const gamePk = row.gamePk;
  const predictionAsOfIso = row.predictionAsOfIso;
  const predictionAsOfMs = Date.parse(predictionAsOfIso);

  const sources: InsertPlateHrV2SourceEvidence[] = [];
  const sourceIds: string[] = [];
  const resolved = new Map<string, ResolvedEligibilitySource>();

  for (const d of row.evidence) {
    const availableAtMs = Date.parse(d.availableAt);
    const reconstructed = Number.isFinite(availableAtMs) && Number.isFinite(predictionAsOfMs) && availableAtMs > predictionAsOfMs;
    const payload = (d.authorizedPayload ?? {}) as Record<string, unknown>;
    // PR4.2 #2: the builder RECOMPUTES the content hash from the stored payload,
    // so the persisted contentHash always agrees with the persisted payload.
    const contentHash = canonicalHash(payload);
    const id = sourceId(d, contentHash);
    sources.push({
      sourceSnapshotId: id,
      provider: d.provider,
      entityId: d.entityId,
      entityType: d.entityType,
      evidenceKind: d.evidenceKind,
      dataThroughAt: d.dataThroughAt ? new Date(d.dataThroughAt) : null,
      availableAt: new Date(d.availableAt),
      availabilitySource: "fetched_at",
      validForAt: d.validForAt ? new Date(d.validForAt) : null,
      reconstructed,
      fetchedAt: new Date(d.fetchedAt),
      schemaVersion: d.schemaVersion,
      contentHash,
      payloadRef: d.payloadRef,
      authorizedPayload: payload,
    });
    if (!sourceIds.includes(id)) sourceIds.push(id);
    resolved.set(id, {
      evidenceKind: d.evidenceKind as EvidenceKind,
      dataThroughAt: d.dataThroughAt,
      availableAt: d.availableAt,
      validForAt: d.validForAt,
      reconstructed,
      authorizedPayload: payload,
      contentHash,
    });
  }

  // CLOSED allowlist — keep only authorized derived-feature groups.
  const authorizedDerived: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row.derivedFeatures as unknown as Record<string, unknown>)) {
    if (AUTHORIZED_DERIVED_FEATURE_GROUPS.has(k)) authorizedDerived[k] = v;
  }

  const eligibility = isPredictionSnapshotEligible(
    { predictionAsOf: predictionAsOfIso, firstPitchTime: row.firstPitchTimeIso, sourceSnapshotIds: sourceIds },
    resolved,
    { requireKnownFirstPitch: true, hashPayload: canonicalHash },
  );

  const sortedIds = [...sourceIds].sort();
  const prediction: InsertPlateHrV2PredictionSnapshot = {
    predictionSnapshotId: predictionId(gamePk, row.batterId, row.featureVersion, predictionAsOfIso),
    gamePk,
    batterId: row.batterId,
    featureVersion: row.featureVersion,
    predictionAsOf: new Date(predictionAsOfIso),
    firstPitchTime: row.firstPitchTimeIso ? new Date(row.firstPitchTimeIso) : null,
    sourceSnapshotIds: sortedIds,
    derivedFeatures: authorizedDerived,
    // Prediction identity hash: the STORED authorized vector + its source ids —
    // never the raw frozen input (which includes unauthorized zone/market).
    contentHash: canonicalHash({ derivedFeatures: authorizedDerived, sourceSnapshotIds: sortedIds }),
    authoritative: false,
    trainingEligible: eligibility.eligible,
  };

  return { sources, prediction };
}

export interface PlateHrV2SnapshotInserter {
  insertSources: (rows: InsertPlateHrV2SourceEvidence[]) => Promise<void>;
  insertPrediction: (row: InsertPlateHrV2PredictionSnapshot) => Promise<void>;
}

export interface SnapshotPersistResult {
  written: number;
  failed: number;
}

/**
 * Persist the two-layer snapshot for each capture row. NEVER throws — a failure
 * on any row is counted and swallowed so it can never break the build loop or the
 * sibling feature-snapshot capture. Inserts are append-only + idempotent at the
 * storage layer (ON CONFLICT DO NOTHING). The caller should log a non-zero
 * `failed` count (see installPlateHrV2Capture.ts).
 */
export async function persistPlateHrV2SnapshotWrites(
  rows: readonly PlateHrV2CaptureRow[],
  deps: PlateHrV2SnapshotInserter,
): Promise<SnapshotPersistResult> {
  let written = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const write = buildPlateHrV2SnapshotWrite(row);
      if (write.sources.length > 0) await deps.insertSources(write.sources);
      await deps.insertPrediction(write.prediction);
      written++;
    } catch {
      failed++;
    }
  }
  return { written, failed };
}
