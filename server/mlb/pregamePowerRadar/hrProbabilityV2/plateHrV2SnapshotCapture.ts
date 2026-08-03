// Plate HR V2 — assemble real provider/entity evidence descriptors, derive the
// append-only two-layer snapshot write, and persist it safely (plan §7.1, PR3.1
// / PR4.2 / PR4.3).
//
// Source evidence comes from EXPLICIT per-provider/entity descriptors carrying
// real provenance (fetchedAt/availableAt/dataThroughAt/validForAt/contentHash/
// payloadRef), assembled at the fetch site from the data the build actually has.
// No family heuristics, no synthesized timestamps, no batter-wide input hash
// standing in for a source hash. PR4.3:
//   • a provenance-incomplete historical source is written with NULL timestamps +
//     availabilitySource "unverified" + provenanceIncomplete=true (the capture
//     moment is NEVER substituted) — it stays training-INELIGIBLE, honestly;
//   • the single canonical hasher + the full-descriptor source id + the full
//     immutable prediction envelope hash come from plateHrV2Snapshots.ts, shared
//     by the write builder and the training reader;
//   • a missing/empty authorized payload is REJECTED at write (no `{}` manufacture),
//     recorded as a training block reason;
//   • authorized nested structures (pitchFamilyStats/pitchTypeExactStats/
//     percentiles) pass through CLOSED nested projections, not just a top-level key.
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
  canonicalHash,
  canonicalJson,
  type AvailabilitySource,
  type EvidenceKind,
  type PlateHrV2EvidenceDescriptor,
  type ResolvedEligibilitySource,
} from "./plateHrV2Snapshots";

// Re-export the canonical hashers so existing importers keep working; the single
// definitions live in plateHrV2Snapshots.ts (shared write+read).
export { canonicalHash, canonicalJson } from "./plateHrV2Snapshots";

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

/** Deep-clone through canonical JSON (sorted keys). Throws on any non-canonical
 * value (NaN/Infinity/undefined/Date/…) — a payload that can't be canonically
 * serialized must fail closed, never collapse. Breaks all references, so a later
 * mutation of the original can't change it. */
export function canonicalClone<T = unknown>(v: unknown): T {
  return JSON.parse(canonicalJson(v)) as T;
}

/** Exclusive upper bound of a season-to-date Savant query = start of the fetch's
 * UTC day (the query used game_date_lt = fetch date, so it covers through the
 * prior day). Derived from the REAL fetch timestamp, not a synthesized string. */
export function startOfUtcDay(iso: string): string {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

// ── Authorized payload projection (CLOSED, top-level AND nested) ──────────────

// CLOSED allowlist of authorized sufficient-stat top-level keys. Zone/chase
// fields are deliberately ABSENT (unauthorized, PR2), and any future/unknown
// top-level key is dropped rather than captured (PR4.2 #4).
export const AUTHORIZED_SUFFICIENT_STAT_KEYS: ReadonlySet<string> = new Set([
  "pitchesSeen", "swings", "whiffs", "calledStrikes", "balls",
  "paCount", "strikeouts", "walks", "battedBallEvents",
  "pitchFamilyStats", "pitchTypeExactStats",
  "evPercentiles", "laPercentiles",
  "pulledBip", "sprayClassifiedBip", "sourceRowCount",
]);

// CLOSED nested allowlists (PR4.3): a nested stat structure is projected key-by-key
// so an unauthorized nested field can never ride along inside an authorized group.
const AUTHORIZED_PITCH_FAMILY_STAT_KEYS: ReadonlySet<string> = new Set([
  "pitches", "swings", "whiffs", "xslgSum", "xslgN",
]);
const AUTHORIZED_PITCH_TYPE_EXACT_STAT_KEYS: ReadonlySet<string> = new Set([
  "pitchCount", "swingCount", "whiffCount", "contactCount", "bbeCount",
  "qualityBbeCount", "paEndedCount", "barrelCount", "hrCount",
  "xslgContactSum", "xslgContactN", "xwobaContactSum", "xwobaContactN",
]);
const AUTHORIZED_PERCENTILE_KEYS: ReadonlySet<string> = new Set([
  "p10", "p25", "p50", "p75", "p90",
]);

/** Project a `Record<key, statObject>` — each entry's fields filtered to a closed
 * numeric allowlist. Non-finite / non-numeric fields are dropped (fail-closed). */
function projectRecordOfStats(v: unknown, allowed: ReadonlySet<string>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (v == null || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, entry] of Object.entries(v as Record<string, unknown>)) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const projected: Record<string, number> = {};
    for (const [ek, ev] of Object.entries(entry as Record<string, unknown>)) {
      if (allowed.has(ek) && typeof ev === "number" && Number.isFinite(ev)) projected[ek] = ev;
    }
    out[k] = projected;
  }
  return out;
}

/** Project a single stat object — allowlisted keys, allowing null (percentiles). */
function projectFlatStat(v: unknown, allowed: ReadonlySet<string>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (v == null || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!allowed.has(k)) continue;
    if (val === null) out[k] = null;
    else if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
  }
  return out;
}

/** Project a sufficient-stats payload through the CLOSED top-level allowlist AND
 * closed nested projections, then it is already a fresh deep structure (PR4.2 #4 +
 * PR4.3). Scalars are cloned; unknown/zone keys are excluded. */
export function authorizedSufficientStatsPayload(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw == null || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!AUTHORIZED_SUFFICIENT_STAT_KEYS.has(k)) continue;
    if (k === "pitchFamilyStats") out[k] = projectRecordOfStats(v, AUTHORIZED_PITCH_FAMILY_STAT_KEYS);
    else if (k === "pitchTypeExactStats") out[k] = projectRecordOfStats(v, AUTHORIZED_PITCH_TYPE_EXACT_STAT_KEYS);
    else if (k === "evPercentiles" || k === "laPercentiles") out[k] = projectFlatStat(v, AUTHORIZED_PERCENTILE_KEYS);
    else out[k] = canonicalClone(v);
  }
  return out;
}

/** A plain object with no own enumerable keys (an empty authorized payload). */
function isEmptyPayload(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  return Object.keys(v as Record<string, unknown>).length === 0;
}

// ── Descriptor assembly (pure) ────────────────────────────────────────────────

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
   * Absent → the source is provenance-INCOMPLETE (null timestamps), NOT the
   * capture moment (PR4.3). */
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
  const isoOrNull = (msVal: number | null | undefined): string | null =>
    msVal != null && Number.isFinite(msVal) ? new Date(msVal).toISOString() : null;
  // Query cutoff (game_date_lt, a YYYY-MM-DD) → ISO start-of-day (exclusive
  // season-to-date bound), derived from the REAL fetch day.
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
    // PR4.3: a historical payload with NO real fetch time / cutoff is written with
    // HONEST null provenance + provenanceIncomplete=true — never the substituted
    // capture moment. It is emitted (not silently omitted) so it INVALIDATES the
    // prediction, and it is always training-ineligible.
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
    // Game-level "lineup confirmed" evidence — the batter's slot is a FEATURE,
    // not part of evidence identity, so this dedupes across the game's batters.
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
  const blockReasons: string[] = [];

  for (const d of row.evidence) {
    const payload = d.authorizedPayload;
    // PR4.3: reject a missing/empty authorized payload at WRITE — never manufacture
    // `{}`. Record a block reason so the prediction is invalidated with a trace.
    if (isEmptyPayload(payload)) {
      blockReasons.push(`source_payload_empty:${d.provider}:${d.entityType}:${d.entityId}:${d.evidenceKind}`);
      continue;
    }

    const availableAtMs = d.availableAt ? Date.parse(d.availableAt) : NaN;
    const reconstructed = Number.isFinite(availableAtMs) && Number.isFinite(predictionAsOfMs) && availableAtMs > predictionAsOfMs;
    // The builder RECOMPUTES the content hash from the stored payload, so the
    // persisted contentHash always agrees with the persisted payload.
    const contentHash = canonicalHash(payload);
    const availabilitySource = d.availabilitySource as AvailabilitySource;
    const provenanceIncomplete = d.provenanceIncomplete;

    // Full-descriptor content-addressed id (PR4.3): every eligibility-critical
    // provenance field participates, so provenance can never change without
    // minting a distinct immutable row.
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
    // Prediction identity hash: the COMPLETE immutable envelope (PR4.3 #5) —
    // gamePk/batterId/featureVersion/predictionAsOf/firstPitchTime + authorized
    // features + sorted source ids. Mutable lifecycle state is excluded.
    contentHash: computePredictionEnvelopeHash({
      gamePk, batterId: row.batterId, featureVersion: row.featureVersion,
      predictionAsOf: predictionAsOfIso, firstPitchTime: row.firstPitchTimeIso,
      derivedFeatures: authorizedDerived, sourceSnapshotIds: sortedIds,
    }),
    // Authority is assigned at TRAINING-READ time (deterministic selection), never
    // at write — the writer cannot know which revision is last before first pitch.
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
