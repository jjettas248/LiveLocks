// Plate HR V2 — derive the append-only two-layer snapshot write from a capture
// row, and persist it safely (plan §7.1, PR3).
//
// PURE builder + a never-throws persister. The builder reuses the provenance the
// existing forward capture already assembled (predictionAsOf, firstPitchTime,
// per-family featureFreshness.sourceAt, inputHash) — it fabricates NO timestamps:
// a family without a real source timestamp produces no source-evidence row.
//
// AUTHORIZED-FIELDS-ONLY (per docs/plate/plateHrV2DataFeasibility.md): the zone /
// location group is UNAUTHORIZED (its Savant columns are unverified), so it is
// stripped from the captured derived-feature vector and no zone source-evidence
// row is emitted. Odds/market is never a model input, so it is not evidence.

import type {
  InsertPlateHrV2SourceEvidence,
  InsertPlateHrV2PredictionSnapshot,
} from "@shared/schema";
import type { PlateHrV2CaptureRow } from "./plateHrV2ForwardCapture";
import {
  isPredictionSnapshotEligible,
  type EvidenceKind,
  type SourceEvidenceSnapshot,
} from "./plateHrV2Snapshots";

export interface PlateHrV2SnapshotWrite {
  sources: InsertPlateHrV2SourceEvidence[];
  prediction: InsertPlateHrV2PredictionSnapshot;
}

// Derived-feature groups stripped from the captured vector because their inputs
// are UNAUTHORIZED (PR2 go/no-go). Keep in sync with the feasibility artifact.
export const UNAUTHORIZED_DERIVED_FEATURE_GROUPS: ReadonlySet<string> = new Set(["zoneLocation"]);

// featureFreshness family → (evidenceKind, entity resolver). Only families the
// capture actually timestamps appear here; market/availability/starterBullpen
// carry no source timestamp and so never become fabricated evidence.
interface FamilySpec {
  evidenceKind: EvidenceKind;
  entity: (row: PlateHrV2CaptureRow) => { entityType: "batter" | "pitcher" | "game" | "venue"; entityId: string } | null;
}
const FAMILY_SPECS: Record<string, FamilySpec> = {
  batterPower: { evidenceKind: "historical_stat", entity: (r) => ({ entityType: "batter", entityId: r.batterId }) },
  batTracking: { evidenceKind: "historical_stat", entity: (r) => ({ entityType: "batter", entityId: r.batterId }) },
  pitchType: { evidenceKind: "historical_stat", entity: (r) => ({ entityType: "batter", entityId: r.batterId }) },
  pitcherVulnerability: {
    evidenceKind: "historical_stat",
    entity: (r) => (r.pitcherId ? { entityType: "pitcher", entityId: r.pitcherId } : null),
  },
  parkWeatherSpray: { evidenceKind: "weather_forecast", entity: (r) => ({ entityType: "game", entityId: r.gameId }) },
  lineupOpportunity: { evidenceKind: "lineup", entity: (r) => ({ entityType: "game", entityId: r.gameId }) },
};

/** Season-to-date pregame stats cover only games BEFORE the slate day (the
 * Savant query excludes the game day), so `dataThroughAt` is the start of the
 * session date. Documented derivation from the query semantics — not fabricated. */
function historicalDataThroughAt(sessionDate: string): string {
  return `${sessionDate}T00:00:00.000Z`;
}

function sourceId(entityType: string, entityId: string, kind: string, availableAtIso: string, contentHash: string): string {
  return `plate-hr-v2-src:${entityType}:${entityId}:${kind}:${availableAtIso}:${contentHash}`;
}

function predictionId(gamePk: string, batterId: string, featureVersion: string, predictionAsOfIso: string): string {
  return `plate-hr-v2-pred:${gamePk}:${batterId}:${featureVersion}:${predictionAsOfIso}`;
}

/**
 * Build the append-only source-evidence rows + one prediction snapshot for a
 * capture row. Pure. Returns Date-typed insert objects; ids are deterministic so
 * re-capturing the SAME (gamePk, batterId, featureVersion, predictionAsOf) is
 * idempotent, while a later cycle (new predictionAsOf) appends a new revision.
 */
export function buildPlateHrV2SnapshotWrite(row: PlateHrV2CaptureRow): PlateHrV2SnapshotWrite {
  const predictionAsOfIso = row.predictionAsOfIso;
  const predictionAsOfMs = Date.parse(predictionAsOfIso);

  const sources: InsertPlateHrV2SourceEvidence[] = [];
  const sourceIds: string[] = [];
  // For eligibility annotation (PR1 predicate) — mirror shape keyed by id.
  const resolved = new Map<string, Pick<SourceEvidenceSnapshot, "evidenceKind" | "dataThroughAt" | "availableAt" | "validForAt" | "reconstructed">>();

  for (const [family, spec] of Object.entries(FAMILY_SPECS)) {
    const fresh = row.featureFreshness[family];
    const availableAtIso = fresh?.sourceAt ?? null;
    if (!availableAtIso) continue; // no real source timestamp → no fabricated evidence
    const ent = spec.entity(row);
    if (!ent) continue;

    const dataThroughAtIso = spec.evidenceKind === "historical_stat" ? historicalDataThroughAt(row.sessionDate) : null;
    const validForAtIso = spec.evidenceKind === "weather_forecast" ? row.firstPitchTimeIso : null;
    const availableAtMs = Date.parse(availableAtIso);
    // Forward capture: availableAt should be <= predictionAsOf. If a fetch time
    // is somehow after the prediction, mark it reconstructed rather than hide it.
    const reconstructed = Number.isFinite(availableAtMs) && Number.isFinite(predictionAsOfMs) && availableAtMs > predictionAsOfMs;
    const contentHash = `${row.inputHash}:${family}`;
    const id = sourceId(ent.entityType, ent.entityId, spec.evidenceKind, availableAtIso, contentHash);

    sources.push({
      sourceSnapshotId: id,
      provider: family === "parkWeatherSpray" ? "open_meteo" : family === "lineupOpportunity" ? "mlb_stats_api" : "baseball_savant",
      entityId: ent.entityId,
      entityType: ent.entityType,
      evidenceKind: spec.evidenceKind,
      dataThroughAt: dataThroughAtIso ? new Date(dataThroughAtIso) : null,
      availableAt: new Date(availableAtIso),
      availabilitySource: "fetched_at",
      validForAt: validForAtIso ? new Date(validForAtIso) : null,
      reconstructed,
      fetchedAt: new Date(availableAtIso),
      schemaVersion: row.inputContractVersion,
      contentHash,
      payloadRef: row.sufficientStatsRef ?? null,
    });
    sourceIds.push(id);
    resolved.set(id, {
      evidenceKind: spec.evidenceKind,
      dataThroughAt: dataThroughAtIso,
      availableAt: availableAtIso,
      validForAt: validForAtIso,
      reconstructed,
    });
  }

  // AUTHORIZED-fields-only: strip unauthorized derived-feature groups.
  const authorizedDerived: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row.derivedFeatures as unknown as Record<string, unknown>)) {
    if (!UNAUTHORIZED_DERIVED_FEATURE_GROUPS.has(k)) authorizedDerived[k] = v;
  }

  const eligibility = isPredictionSnapshotEligible(
    { predictionAsOf: predictionAsOfIso, firstPitchTime: row.firstPitchTimeIso, sourceSnapshotIds: sourceIds },
    resolved,
  );

  const prediction: InsertPlateHrV2PredictionSnapshot = {
    predictionSnapshotId: predictionId(row.gameId, row.batterId, row.featureVersion, predictionAsOfIso),
    gamePk: row.gameId,
    batterId: row.batterId,
    featureVersion: row.featureVersion,
    predictionAsOf: new Date(predictionAsOfIso),
    firstPitchTime: row.firstPitchTimeIso ? new Date(row.firstPitchTimeIso) : null,
    sourceSnapshotIds: sourceIds,
    derivedFeatures: authorizedDerived,
    contentHash: row.inputHash,
    // Selection of the single authoritative <= first-pitch snapshot happens later
    // (across revisions); a capture write is never authoritative on its own.
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
 * storage layer (ON CONFLICT DO NOTHING).
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
