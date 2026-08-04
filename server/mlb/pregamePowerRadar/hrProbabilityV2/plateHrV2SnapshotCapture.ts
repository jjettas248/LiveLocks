// Plate HR V2 — assemble real provider/entity evidence descriptors, derive the
// append-only two-layer snapshot write, and persist it safely (plan §7.1, PR3.1
// / PR4.2 / PR4.3 / PR4.3.1).
//
// Source evidence comes from EXPLICIT per-provider/entity descriptors carrying
// real provenance (fetchedAt/availableAt/dataThroughAt/validForAt/contentHash/
// payloadRef), assembled at the fetch site from the data the build actually has.
// No family heuristics, no synthesized timestamps, no batter-wide input hash
// standing in for a source hash.
//   • A provenance-incomplete historical source is written with NULL timestamps +
//     availabilitySource "unverified" + provenanceIncomplete=true (the capture
//     moment is NEVER substituted) — it stays training-INELIGIBLE, honestly.
//   • `reconstructed` is derived from the REAL fetch time (fetchedAt > prediction),
//     not availableAt (PR4.3.1 #1).
//   • The single canonical hasher, full-descriptor source id, and full immutable
//     prediction envelope hash come from plateHrV2Snapshots.ts (shared write+read).
//   • A missing/empty/wrong-shape authorized payload is REJECTED at write (no `{}`
//     manufacture, typed via validateSourcePayload — PR4.3.1 #2), recorded as a
//     training block reason.
// Odds/market and unverified zone are excluded by a CLOSED allowlist. The
// prediction stores the real MLB gamePk (not ESPN gameId).

import type {
  InsertPlateHrV2SourceEvidence,
  InsertPlateHrV2PredictionSnapshot,
} from "@shared/schema";
import type { PlateHrV2CaptureRow } from "./plateHrV2ForwardCapture";
import {
  isPredictionSnapshotEligible,
  computeSourceSnapshotId,
  computePredictionSnapshotId,
  computePredictionEnvelopeHash,
  authorizedSufficientStatsPayload,
  validateSourcePayload,
  isValidIsoTimestamp,
  canonicalHash,
  canonicalJson,
  type AvailabilitySource,
  type EvidenceKind,
  type PlateHrV2EvidenceDescriptor,
  type ResolvedEligibilitySource,
} from "./plateHrV2Snapshots";

// Re-export shared helpers so existing importers keep working; the single
// definitions live in plateHrV2Snapshots.ts (shared write+read).
export { canonicalHash, canonicalJson, authorizedSufficientStatsPayload } from "./plateHrV2Snapshots";

export interface PlateHrV2SnapshotWrite {
  sources: InsertPlateHrV2SourceEvidence[];
  prediction: InsertPlateHrV2PredictionSnapshot;
}

// CLOSED allowlist of derived-feature groups permitted into a captured snapshot.
// zoneLocation (unverified, PR2) and market/odds (never a model input) are absent.
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
  "recentContactForm",
  "dataQuality",
  "slateBaselineGameHrProbability",
]);

/** Deep-clone through canonical JSON (sorted keys). Throws on any non-canonical
 * value — a payload that can't be canonically serialized must fail closed. */
export function canonicalClone<T = unknown>(v: unknown): T {
  return JSON.parse(canonicalJson(v)) as T;
}

/** Exclusive upper bound of a season-to-date Savant query = start of the fetch's
 * UTC day. Derived from the REAL fetch timestamp, not a synthesized string. */
export function startOfUtcDay(iso: string): string {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

// ── Descriptor assembly (pure) ────────────────────────────────────────────────

export interface PlateHrV2EvidenceAssemblyInput {
  gamePk: string;
  batterId: string;
  pitcherId: string | null;
  capturedAtIso: string;
  firstPitchIso: string | null;
  schemaVersion: string;
  batterSufficientStats: unknown | null;
  batterStatsRef: string | null;
  pitcherSufficientStats: unknown | null;
  pitcherStatsRef: string | null;
  batterFetchedAtMs?: number | null;
  batterDataThroughDate?: string | null;
  pitcherFetchedAtMs?: number | null;
  pitcherDataThroughDate?: string | null;
  weather: { available: boolean; temperatureF: number | null; windSpeedMph: number | null; windDirection: string | null; isIndoors: boolean } | null;
  lineupPosted: boolean;
  park: { venueResolved: boolean; payload: unknown } | null;
}

/**
 * Build the real evidence descriptors for one candidate. Emits a descriptor ONLY
 * when the underlying source genuinely exists — a missing source yields no
 * descriptor (fail-closed). Game/venue-level evidence dedupes across batters.
 */
export function assemblePlateHrV2EvidenceDescriptors(inp: PlateHrV2EvidenceAssemblyInput): PlateHrV2EvidenceDescriptor[] {
  const out: PlateHrV2EvidenceDescriptor[] = [];
  const captured = inp.capturedAtIso;
  const isoOrNull = (msVal: number | null | undefined): string | null =>
    msVal != null && Number.isFinite(msVal) ? new Date(msVal).toISOString() : null;
  const cutoffIso = (date: string, fetchedIso: string): string =>
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
        fetchedAt: realFetchedAt, availableAt: realFetchedAt, availabilitySource: "fetched_at",
        provenanceIncomplete: false,
        dataThroughAt: cutoffIso(cutoffDate as string, realFetchedAt), validForAt: null,
        schemaVersion: inp.schemaVersion, contentHash: canonicalHash(payload), payloadRef: statsRef,
        authorizedPayload: payload,
      });
      return;
    }
    // Provenance-incomplete: HONEST null timestamps + provenanceIncomplete=true —
    // never a substituted capture moment. Emitted (not omitted) so it INVALIDATES
    // the prediction, and always training-ineligible.
    out.push({
      provider: "baseball_savant", entityType, entityId, evidenceKind: "historical_stat",
      fetchedAt: null, availableAt: null, availabilitySource: "unverified",
      provenanceIncomplete: true,
      dataThroughAt: null, validForAt: null,
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
      fetchedAt: captured, availableAt: captured, availabilitySource: "fetched_at", provenanceIncomplete: false,
      dataThroughAt: null, validForAt: inp.firstPitchIso,
      schemaVersion: inp.schemaVersion, contentHash: canonicalHash(payload), payloadRef: null, authorizedPayload: payload,
    });
  }
  if (inp.park?.venueResolved) {
    out.push({
      provider: "livelocks_park", entityType: "venue", entityId: inp.gamePk, evidenceKind: "park",
      fetchedAt: captured, availableAt: captured, availabilitySource: "fetched_at", provenanceIncomplete: false,
      dataThroughAt: null, validForAt: null,
      schemaVersion: inp.schemaVersion, contentHash: canonicalHash(inp.park.payload), payloadRef: null, authorizedPayload: inp.park.payload,
    });
  }
  if (inp.lineupPosted) {
    const payload = { lineupConfirmed: true };
    out.push({
      provider: "mlb_stats_api", entityType: "game", entityId: inp.gamePk, evidenceKind: "lineup",
      fetchedAt: captured, availableAt: captured, availabilitySource: "fetched_at", provenanceIncomplete: false,
      dataThroughAt: null, validForAt: null,
      schemaVersion: inp.schemaVersion, contentHash: canonicalHash(payload), payloadRef: null, authorizedPayload: payload,
    });
  }
  return out;
}

/**
 * Build the append-only source-evidence rows + one prediction snapshot from a
 * capture row's REAL descriptors. Pure. Throws when the real MLB gamePk is
 * missing — the persister counts the failure rather than propagating it.
 */
export function buildPlateHrV2SnapshotWrite(row: PlateHrV2CaptureRow): PlateHrV2SnapshotWrite {
  if (!row.gamePk) throw new Error("missing_gamePk");
  const gamePk = row.gamePk;
  const predictionAsOfIso = row.predictionAsOfIso;
  // PR4.3.3: the prediction moment + first pitch must be strict ISO/RFC3339.
  if (!isValidIsoTimestamp(predictionAsOfIso)) throw new Error("invalid_predictionAsOf");
  if (row.firstPitchTimeIso != null && !isValidIsoTimestamp(row.firstPitchTimeIso)) throw new Error("invalid_firstPitchTime");
  const predictionAsOfMs = Date.parse(predictionAsOfIso);

  const sources: InsertPlateHrV2SourceEvidence[] = [];
  const sourceIds: string[] = [];
  const resolved = new Map<string, ResolvedEligibilitySource>();
  const blockReasons: string[] = [];

  for (const d of row.evidence) {
    const payload = d.authorizedPayload;
    // PR4.3.1 #2: reject a missing/empty/wrong-shape authorized payload at WRITE —
    // never manufacture `{}`. Record a block reason so the prediction is invalidated.
    const pv = validateSourcePayload(d.evidenceKind as EvidenceKind, payload);
    if (!pv.ok) {
      blockReasons.push(`source_payload_invalid:${d.provider}:${d.entityType}:${d.entityId}:${d.evidenceKind}:${pv.reasons.join("|")}`);
      continue;
    }

    // PR4.3.3: every non-null descriptor timestamp must be strict ISO/RFC3339 —
    // reject before hashing / reconstruction / new Date(...). A bad timestamp
    // skips the source (block reason), never a manufactured or coerced value.
    const badTs = ([
      ["fetchedAt", d.fetchedAt], ["availableAt", d.availableAt],
      ["dataThroughAt", d.dataThroughAt], ["validForAt", d.validForAt],
    ] as const).find(([, v]) => v != null && !isValidIsoTimestamp(v));
    if (badTs) {
      blockReasons.push(`source_timestamp_invalid:${d.provider}:${d.entityType}:${d.entityId}:${d.evidenceKind}:${badTs[0]}`);
      continue;
    }

    // PR4.3.1 #1: reconstructed is derived from the REAL fetch time, not availableAt.
    const fetchedMs = d.fetchedAt ? Date.parse(d.fetchedAt) : NaN;
    const reconstructed = Number.isFinite(fetchedMs) && Number.isFinite(predictionAsOfMs) && fetchedMs > predictionAsOfMs;
    const contentHash = canonicalHash(payload);
    const availabilitySource = d.availabilitySource as AvailabilitySource;
    const provenanceIncomplete = d.provenanceIncomplete;

    const id = computeSourceSnapshotId({
      provider: d.provider, entityType: d.entityType, entityId: d.entityId, evidenceKind: d.evidenceKind,
      dataThroughAt: d.dataThroughAt, availableAt: d.availableAt, fetchedAt: d.fetchedAt,
      availabilitySource, validForAt: d.validForAt, reconstructed, provenanceIncomplete,
      schemaVersion: d.schemaVersion, contentHash,
    });

    sources.push({
      sourceSnapshotId: id,
      provider: d.provider,
      entityId: d.entityId,
      entityType: d.entityType,
      evidenceKind: d.evidenceKind,
      dataThroughAt: d.dataThroughAt ? new Date(d.dataThroughAt) : null,
      availableAt: d.availableAt ? new Date(d.availableAt) : null,
      availabilitySource,
      validForAt: d.validForAt ? new Date(d.validForAt) : null,
      reconstructed,
      provenanceIncomplete,
      fetchedAt: d.fetchedAt ? new Date(d.fetchedAt) : null,
      schemaVersion: d.schemaVersion,
      contentHash,
      payloadRef: d.payloadRef,
      authorizedPayload: payload as Record<string, unknown>,
    });
    if (!sourceIds.includes(id)) sourceIds.push(id);
    resolved.set(id, {
      evidenceKind: d.evidenceKind as EvidenceKind,
      dataThroughAt: d.dataThroughAt,
      availableAt: d.availableAt,
      validForAt: d.validForAt,
      reconstructed,
      provenanceIncomplete,
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
  const trainingBlockReasons = [...blockReasons, ...eligibility.reasons];

  const sortedIds = [...sourceIds].sort();
  const prediction: InsertPlateHrV2PredictionSnapshot = {
    predictionSnapshotId: computePredictionSnapshotId({
      gamePk, batterId: row.batterId, featureVersion: row.featureVersion, predictionAsOf: predictionAsOfIso,
    }),
    gamePk,
    batterId: row.batterId,
    featureVersion: row.featureVersion,
    predictionAsOf: new Date(predictionAsOfIso),
    firstPitchTime: row.firstPitchTimeIso ? new Date(row.firstPitchTimeIso) : null,
    sourceSnapshotIds: sortedIds,
    derivedFeatures: authorizedDerived,
    contentHash: computePredictionEnvelopeHash({
      gamePk, batterId: row.batterId, featureVersion: row.featureVersion,
      predictionAsOf: predictionAsOfIso, firstPitchTime: row.firstPitchTimeIso,
      derivedFeatures: authorizedDerived, sourceSnapshotIds: sortedIds,
    }),
    // Authority is assigned at TRAINING-READ time (deterministic selection).
    authoritative: false,
    trainingEligible: trainingBlockReasons.length === 0,
    trainingBlockReasons,
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
 * Persist the two-layer snapshot for each capture row. NEVER throws — a failure on
 * any row is counted and swallowed so it can never break the build loop. Inserts
 * are append-only + idempotent at the storage layer (ON CONFLICT DO NOTHING).
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
