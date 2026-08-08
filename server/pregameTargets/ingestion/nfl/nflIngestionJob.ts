// PR6 — NFL (nflverse) ingestion orchestrator (pure of I/O via injected ports).
//
// Per season: validate identity → fetch SCHEDULE + WEEKLY CSVs → parse (season-enforced) →
// join weekly→schedule BY provider game_id → build as-of feature rows → hand to the DATASET
// atomic store, which head-decides on the weekly capture and folds posteriors for ALL
// players under a stable cross-season lock. BOTH inputs are persisted immutably and are
// recoverable from each feature row via a join-provenance snapshot (feature sourceId).
//
// No fabricated validAt: if the join resolves NO feature rows, nothing is persisted and a
// typed unresolvable result is returned. Imports NO other sport engine.

import type { InsertPregameRawSourceSnapshot, InsertPregameFeatureSnapshot, InsertPregamePosteriorState } from "../../../../shared/schema";
import { instantMs, type AsOfFeatureRow } from "../../../../shared/pregameTargets/featureStore";
import type { PosteriorState } from "../../posteriorState/posteriorState";
import { buildCaptureSnapshotIdentity, computeContentHash, computeSnapshotId, canonicalJson } from "../rawSnapshotIdentity";
import { parseNflWeeklyStats, parseNflSchedule } from "./nflCsvAdapter";
import { buildNflFeatureRows, NFL_FEATURE_VERSION } from "./nflFeatureBuilder";
import { foldNflPosteriors } from "./nflPosteriorBuilder";
import { buildNflCoverage, type NflSourceCoverage } from "./nflIngestionCoverage";
import { buildNflSourceKey, NFL_KNOWN_AT_POLICY_VERSION } from "./nflSourceContracts";

export const NFL_WEEKLY_DATASET_ENTITY = "nfl:weekly_stats:dataset";
export const NFL_SCHEDULE_DATASET_ENTITY = "nfl:schedule:dataset";
export const NFL_JOIN_DATASET_ENTITY = "nfl:weekly_schedule_join:dataset";
/** Stable cross-season posterior serialization key (blocker 4). */
export const NFL_POSTERIOR_LOCK_KEY = `nfl|pregame_dataset_ingest|${NFL_FEATURE_VERSION}`;

export type IngestDecision = "first_capture" | "appended" | "noop" | "stale" | "conflict";

export interface DatasetAtomicIngestArgs {
  featureVersion: string;
  entityCanonicalIds: string[];
  featureKeys: string[];
  semanticSourceKey: string;
  posteriorLockKey: string;
  incomingKnownAt: Date;
  incomingContentHash: string;
  raw: InsertPregameRawSourceSnapshot;
  provenanceRaws?: InsertPregameRawSourceSnapshot[];
  features: InsertPregameFeatureSnapshot[];
  foldPosteriors: (lockedPriors: Map<string, PosteriorState>) => InsertPregamePosteriorState[];
}

export interface NflIngestionStorePort {
  ingestDatasetSnapshotAtomic(args: DatasetAtomicIngestArgs): Promise<{ decision: IngestDecision; snapshotId: string | null; supersedes: string | null }>;
}

export type CsvFetchResult =
  | { ok: true; rawCsv: string; fetchedAt: string; sourcePublishedAt: string | null }
  | { ok: false; reason: string; failedAt: string };
export interface CsvFetchArgs { season: number }
export type CsvFetcher = (args: CsvFetchArgs) => Promise<CsvFetchResult>;

export class NflIngestInvocationError extends Error {
  constructor(public readonly kind: string, message: string) { super(message); this.name = "NflIngestInvocationError"; }
}

export type NflIngestStatus =
  | "provider_failure_schedule" | "incomplete_schedule"
  | "provider_failure" | "incomplete" | "unresolvable"
  | "noop_identical" | "ingested" | "stale_observation" | "conflicting_observation";

export interface NflIngestOutcome {
  status: NflIngestStatus;
  semanticSourceKey: string;
  snapshotId: string | null;
  featureRowsWritten: number;
  playersUpdated: number;
  coverage: NflSourceCoverage | null;
}

export interface IngestNflSeasonParams { season: number; currentSeason: number; asOfDate: string }
export interface ValidatedNflRequest { season: number; currentSeason: number; asOfDate: string; semanticSourceKey: string }

export function buildValidatedNflRequest(params: IngestNflSeasonParams): ValidatedNflRequest {
  if (!Number.isInteger(params.season) || params.season <= 1900 || params.season > 2100) throw new NflIngestInvocationError("invalid_season", `invalid season ${params.season}`);
  if (!Number.isInteger(params.currentSeason) || params.currentSeason <= 1900 || params.currentSeason > 2100) throw new NflIngestInvocationError("invalid_current_season", `invalid currentSeason ${params.currentSeason}`);
  if (typeof params.asOfDate !== "string" || !Number.isFinite(Date.parse(params.asOfDate))) throw new NflIngestInvocationError("invalid_as_of_date", `invalid asOfDate ${JSON.stringify(params.asOfDate)}`);
  const semanticSourceKey = buildNflSourceKey({ sourceKind: "nflverse_weekly_stats", entityCanonicalId: NFL_WEEKLY_DATASET_ENTITY, season: params.season });
  return { season: params.season, currentSeason: params.currentSeason, asOfDate: params.asOfDate, semanticSourceKey };
}

function deterministicId(parts: readonly (string | number | null)[]): string {
  return computeContentHash(parts.map((p) => String(p)).join(" "));
}
function toFeatureInsert(row: AsOfFeatureRow, sourceId: string): InsertPregameFeatureSnapshot {
  const featureRowId = deterministicId([row.entityCanonicalId, row.featureKey, row.featureVersion, row.validAt, row.knownAt, sourceId, row.state, row.value]);
  return {
    featureRowId, sport: row.sport, entityCanonicalId: row.entityCanonicalId, entityKind: row.entityKind,
    featureKey: row.featureKey, featureVersion: row.featureVersion, season: row.season,
    validAt: new Date(row.validAt), knownAt: new Date(row.knownAt), state: row.state,
    value: row.value === null ? null : String(row.value), sourceId,
    derivedFromGameIds: row.derivedFromGameIds ? [...row.derivedFromGameIds] : null,
  };
}
function toPosteriorInsert(state: PosteriorState): InsertPregamePosteriorState {
  return {
    posteriorId: deterministicId([state.entityCanonicalId, state.featureKey, state.featureVersion]),
    sport: "nfl", entityCanonicalId: state.entityCanonicalId, featureKey: state.featureKey,
    featureVersion: state.featureVersion, stateVersion: state.version,
    bySeason: state.bySeason as unknown as InsertPregamePosteriorState["bySeason"],
  };
}
function maxValidAtIso(rows: readonly AsOfFeatureRow[]): string | null {
  let best: string | null = null, bestMs = -Infinity;
  for (const r of rows) { const ms = instantMs(r.validAt); if (Number.isFinite(ms) && ms > bestMs) { bestMs = ms; best = r.validAt; } }
  return best;
}

export async function ingestNflSeason(
  deps: { store: NflIngestionStorePort; fetchSchedule: CsvFetcher; fetchWeekly: CsvFetcher },
  params: IngestNflSeasonParams,
): Promise<NflIngestOutcome> {
  const plan = buildValidatedNflRequest(params);
  const base = { semanticSourceKey: plan.semanticSourceKey, snapshotId: null as string | null, featureRowsWritten: 0, playersUpdated: 0, coverage: null as NflSourceCoverage | null };
  const scheduleSemanticKey = buildNflSourceKey({ sourceKind: "nflverse_schedule", entityCanonicalId: NFL_SCHEDULE_DATASET_ENTITY, season: plan.season });
  const joinSemanticKey = buildNflSourceKey({ sourceKind: "nfl_weekly_schedule_join", entityCanonicalId: NFL_JOIN_DATASET_ENTITY, season: plan.season });

  // 1. Schedule (temporal anchor + cross-check + provenance input).
  const sched = await deps.fetchSchedule({ season: plan.season });
  if (!sched.ok) return { status: "provider_failure_schedule", ...base };
  const schedParsed = parseNflSchedule({ requestedSeason: plan.season, sourceKey: scheduleSemanticKey, rawPayload: sched.rawCsv, fetchedAt: sched.fetchedAt });
  if (!schedParsed.ok) return { status: "incomplete_schedule", ...base };

  // 2. Weekly stats (feature source + head-chained capture).
  const wk = await deps.fetchWeekly({ season: plan.season });
  if (!wk.ok) return { status: "provider_failure", ...base };
  const wkParsed = parseNflWeeklyStats({ requestedSeason: plan.season, sourceKey: plan.semanticSourceKey, rawPayload: wk.rawCsv, fetchedAt: wk.fetchedAt, sourcePublishedAt: wk.sourcePublishedAt });

  const mkCoverage = (coverage: "adapter_retrievable" | "incomplete", extra: Partial<NflSourceCoverage["counts"]> = {}): NflSourceCoverage =>
    buildNflCoverage({
      season: plan.season, currentSeason: plan.currentSeason, coverage,
      counts: {
        rawWeeklyRows: wkParsed.ok ? wkParsed.diagnostics.rawRows : 0,
        structurallyAcceptedWeeklyRows: wkParsed.ok ? wkParsed.records.length : 0,
        scheduleRawRows: schedParsed.diagnostics.rawRows,
        scheduleRowsForSeason: schedParsed.records.length,
        scheduleResolvedRows: 0, unresolvedGameIds: 0, contradictoryRows: 0,
        featureBearingPlayers: 0, rawCapturesPersisted: 0, featureRowsPersisted: 0, ...extra,
      },
    });

  if (!wkParsed.ok) return { status: "incomplete", ...base, coverage: mkCoverage("incomplete") };

  // 3. Provenance identities: weekly (head-chained), schedule + join (content-identity).
  const weeklyIdentity = buildCaptureSnapshotIdentity({ sourceKind: "nflverse_weekly_stats", semanticSourceKey: plan.semanticSourceKey, observationInstant: wk.fetchedAt, payload: wk.rawCsv });
  const scheduleContentHash = computeContentHash(sched.rawCsv);
  const scheduleSnapshotId = computeSnapshotId("nflverse_schedule", scheduleSemanticKey, scheduleContentHash);
  const joinPayload = { weeklySnapshotId: weeklyIdentity.snapshotId, weeklyContentHash: weeklyIdentity.contentHash, scheduleSnapshotId, scheduleContentHash, season: plan.season };
  const joinContentHash = computeContentHash(joinPayload);
  const joinSnapshotId = computeSnapshotId("nfl_weekly_schedule_join", joinSemanticKey, joinContentHash);

  // 4. Join weekly→schedule BY game_id → feature rows. sourceId = the join snapshot.
  const built = buildNflFeatureRows({ season: plan.season, sourceId: joinSnapshotId, weeklyRecords: wkParsed.records, scheduleRecords: schedParsed.records });
  const resolvedCounts = {
    scheduleResolvedRows: built.stats.scheduleResolvedRows, unresolvedGameIds: built.stats.unresolvedGameIds,
    contradictoryRows: built.stats.contradictoryRows, featureBearingPlayers: built.stats.featureBearingPlayers,
  };

  // No fabricated validAt: if nothing resolved, persist NOTHING and report unresolvable.
  if (built.rows.length === 0) {
    return { status: "unresolvable", ...base, coverage: mkCoverage("incomplete", { ...resolvedCounts }) };
  }

  const features = built.rows.map((r) => toFeatureInsert(r, joinSnapshotId));
  const entityCanonicalIds = Array.from(new Set(built.rows.map((r) => r.entityCanonicalId)));
  const featureKeys = Array.from(new Set(built.rows.map((r) => r.featureKey)));
  const knownAt = new Date(wk.fetchedAt);
  const validAtIso = maxValidAtIso(built.rows)!; // guaranteed present (>=1 resolved row)

  const weeklyRaw: InsertPregameRawSourceSnapshot = {
    snapshotId: weeklyIdentity.snapshotId, sport: "nfl", sourceKind: "nflverse_weekly_stats",
    sourceKey: weeklyIdentity.captureKey, semanticSourceKey: plan.semanticSourceKey,
    validAt: new Date(validAtIso), knownAt,
    sourcePublishedAt: wk.sourcePublishedAt === null ? null : new Date(wk.sourcePublishedAt),
    knownAtPolicyVersion: NFL_KNOWN_AT_POLICY_VERSION, payload: wk.rawCsv as InsertPregameRawSourceSnapshot["payload"], contentHash: weeklyIdentity.contentHash,
  };
  const scheduleRaw: InsertPregameRawSourceSnapshot = {
    snapshotId: scheduleSnapshotId, sport: "nfl", sourceKind: "nflverse_schedule",
    sourceKey: scheduleSemanticKey, semanticSourceKey: scheduleSemanticKey,
    validAt: new Date(validAtIso), knownAt: new Date(sched.fetchedAt),
    sourcePublishedAt: sched.sourcePublishedAt === null ? null : new Date(sched.sourcePublishedAt),
    knownAtPolicyVersion: NFL_KNOWN_AT_POLICY_VERSION, payload: sched.rawCsv as InsertPregameRawSourceSnapshot["payload"], contentHash: scheduleContentHash,
  };
  const joinRaw: InsertPregameRawSourceSnapshot = {
    snapshotId: joinSnapshotId, sport: "nfl", sourceKind: "nfl_weekly_schedule_join",
    sourceKey: joinSemanticKey, semanticSourceKey: joinSemanticKey,
    validAt: new Date(validAtIso), knownAt,
    sourcePublishedAt: null, knownAtPolicyVersion: NFL_KNOWN_AT_POLICY_VERSION,
    payload: JSON.parse(canonicalJson(joinPayload)) as InsertPregameRawSourceSnapshot["payload"], contentHash: joinContentHash,
  };

  let playersUpdated = 0;
  const foldPosteriors = (lockedPriors: Map<string, PosteriorState>): InsertPregamePosteriorState[] => {
    const rowsByEntity = new Map<string, AsOfFeatureRow[]>();
    for (const r of built.rows) { const arr = rowsByEntity.get(r.entityCanonicalId) ?? []; arr.push(r); rowsByEntity.set(r.entityCanonicalId, arr); }
    const out: InsertPregamePosteriorState[] = [];
    const touched = new Set<string>();
    for (const [entity, rows] of Array.from(rowsByEntity)) {
      const entityPriors = new Map<string, PosteriorState>();
      for (const [k, v] of Array.from(lockedPriors)) { if (k.startsWith(`${entity}|`)) entityPriors.set(v.featureKey, v); }
      const folded = foldNflPosteriors({ rows, currentSeason: plan.currentSeason, asOfDate: plan.asOfDate, priorStates: entityPriors });
      for (const state of Array.from(folded.values())) out.push(toPosteriorInsert(state));
      if (folded.size > 0) touched.add(entity);
    }
    playersUpdated = touched.size;
    return out;
  };

  const result = await deps.store.ingestDatasetSnapshotAtomic({
    featureVersion: NFL_FEATURE_VERSION, entityCanonicalIds, featureKeys,
    semanticSourceKey: plan.semanticSourceKey, posteriorLockKey: NFL_POSTERIOR_LOCK_KEY,
    incomingKnownAt: knownAt, incomingContentHash: weeklyIdentity.contentHash,
    raw: weeklyRaw, provenanceRaws: [scheduleRaw, joinRaw], features, foldPosteriors,
  });

  const persistedCounts = (rawCaptures: number, featureRows: number) =>
    mkCoverage("adapter_retrievable", { ...resolvedCounts, rawCapturesPersisted: rawCaptures, featureRowsPersisted: featureRows });
  switch (result.decision) {
    case "first_capture":
    case "appended":
      return { status: "ingested", ...base, snapshotId: result.snapshotId, featureRowsWritten: features.length, playersUpdated, coverage: persistedCounts(3, features.length) };
    case "noop":
      return { status: "noop_identical", ...base, snapshotId: result.snapshotId, coverage: persistedCounts(0, 0) };
    case "stale":
      return { status: "stale_observation", ...base, coverage: persistedCounts(0, 0) };
    case "conflict":
      return { status: "conflicting_observation", ...base, coverage: persistedCounts(0, 0) };
  }
}
