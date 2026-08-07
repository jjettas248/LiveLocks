// PR6 — NFL (nflverse) ingestion orchestrator (pure of I/O via injected ports).
//
// Per season: validate identity → fetch the SCHEDULE (transient join input) + the WEEKLY
// player-stats CSV (the feature source + capture) → build the capture identity from the
// weekly payload → build as-of feature rows (schedule-anchored) → hand to the DATASET
// atomic store, which decides vs. the current head (audit-4 head-by-knownAt, incl.
// A→B→A) and folds posteriors for ALL players in one transaction.
//
// Reuses the shared, sport-neutral rawSnapshotIdentity + storage dataset method + the PR1
// posterior/recency modules. Imports NO other sport engine. The schedule is a transient
// join input (not persisted as a feature source in PR6); the WEEKLY file is the immutable
// capture.

import type { InsertPregameRawSourceSnapshot, InsertPregameFeatureSnapshot, InsertPregamePosteriorState } from "../../../../shared/schema";
import { instantMs, type AsOfFeatureRow } from "../../../../shared/pregameTargets/featureStore";
import type { PosteriorState } from "../../posteriorState/posteriorState";
import { buildCaptureSnapshotIdentity, computeContentHash } from "../rawSnapshotIdentity";
import { parseNflWeeklyStats, parseNflSchedule } from "./nflCsvAdapter";
import { buildNflFeatureRows, buildScheduleAnchor, NFL_FEATURE_VERSION } from "./nflFeatureBuilder";
import { foldNflPosteriors } from "./nflPosteriorBuilder";
import { classifyNflCoverage, type NflSourceCoverage } from "./nflIngestionCoverage";
import { buildNflSourceKey, NFL_KNOWN_AT_POLICY_VERSION } from "./nflSourceContracts";

/** A stable dataset-identity marker for the whole-season weekly file (the season field of
 *  the semantic key disambiguates seasons). Not a resolvable per-player entity. */
export const NFL_WEEKLY_DATASET_ENTITY = "nfl:weekly_stats:dataset";

export type IngestDecision = "first_capture" | "appended" | "noop" | "stale" | "conflict";

export interface DatasetAtomicIngestArgs {
  featureVersion: string;
  entityCanonicalIds: string[];
  featureKeys: string[];
  semanticSourceKey: string;
  incomingKnownAt: Date;
  incomingContentHash: string;
  raw: InsertPregameRawSourceSnapshot;
  features: InsertPregameFeatureSnapshot[];
  foldPosteriors: (lockedPriors: Map<string, PosteriorState>) => InsertPregamePosteriorState[];
}

export interface NflIngestionStorePort {
  ingestDatasetSnapshotAtomic(args: DatasetAtomicIngestArgs): Promise<{ decision: IngestDecision; snapshotId: string | null; supersedes: string | null }>;
}

/** Typed CSV fetch result (post-decode fetchedAt; failures carry failedAt). */
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
  | "provider_failure" | "incomplete"
  | "noop_identical" | "ingested" | "stale_observation" | "conflicting_observation";

export interface NflIngestOutcome {
  status: NflIngestStatus;
  semanticSourceKey: string;
  snapshotId: string | null;
  recordCount: number;
  featureRowsWritten: number;
  playersUpdated: number;
  coverage: NflSourceCoverage | null;
}

export interface IngestNflSeasonParams {
  season: number;
  currentSeason: number;
  /** Recency-weighting reference instant (ISO) only — NOT payload availability/prediction time. */
  asOfDate: string;
}

export interface ValidatedNflRequest {
  season: number;
  currentSeason: number;
  asOfDate: string;
  semanticSourceKey: string;
}

export function buildValidatedNflRequest(params: IngestNflSeasonParams): ValidatedNflRequest {
  if (!Number.isInteger(params.season) || params.season <= 0) throw new NflIngestInvocationError("invalid_season", `invalid season ${params.season}`);
  if (!Number.isInteger(params.currentSeason) || params.currentSeason <= 0) throw new NflIngestInvocationError("invalid_current_season", `invalid currentSeason ${params.currentSeason}`);
  if (typeof params.asOfDate !== "string" || !Number.isFinite(Date.parse(params.asOfDate))) throw new NflIngestInvocationError("invalid_as_of_date", `invalid asOfDate ${JSON.stringify(params.asOfDate)}`);
  const semanticSourceKey = buildNflSourceKey({ sourceKind: "nflverse_weekly_stats", entityCanonicalId: NFL_WEEKLY_DATASET_ENTITY, season: params.season });
  return { season: params.season, currentSeason: params.currentSeason, asOfDate: params.asOfDate, semanticSourceKey };
}

function deterministicId(parts: readonly (string | number | null)[]): string {
  return computeContentHash(parts.map((p) => String(p)).join(" "));
}

function toFeatureInsert(row: AsOfFeatureRow, snapshotId: string): InsertPregameFeatureSnapshot {
  const featureRowId = deterministicId([row.entityCanonicalId, row.featureKey, row.featureVersion, row.validAt, row.knownAt, snapshotId, row.state, row.value]);
  return {
    featureRowId, sport: row.sport, entityCanonicalId: row.entityCanonicalId, entityKind: row.entityKind,
    featureKey: row.featureKey, featureVersion: row.featureVersion, season: row.season,
    validAt: new Date(row.validAt), knownAt: new Date(row.knownAt), state: row.state,
    value: row.value === null ? null : String(row.value), sourceId: snapshotId,
    derivedFromGameIds: row.derivedFromGameIds ? [...row.derivedFromGameIds] : null,
  };
}

function toPosteriorInsert(state: PosteriorState): InsertPregamePosteriorState {
  const posteriorId = deterministicId([state.entityCanonicalId, state.featureKey, state.featureVersion]);
  return {
    posteriorId, sport: "nfl", entityCanonicalId: state.entityCanonicalId, featureKey: state.featureKey,
    featureVersion: state.featureVersion, stateVersion: state.version,
    bySeason: state.bySeason as unknown as InsertPregamePosteriorState["bySeason"],
  };
}

function maxValidAtIso(rows: readonly AsOfFeatureRow[], season: number): string {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const r of rows) {
    const ms = instantMs(r.validAt);
    if (Number.isFinite(ms) && ms > bestMs) { bestMs = ms; best = r.validAt; }
  }
  return best ?? `${season}-09-01T00:00:00Z`; // season-start fallback (never fabricate a game date)
}

/**
 * Ingest one NFL season's weekly player stats (all players). Idempotent + correction-aware
 * via the dataset atomic store. Never fabricates on a provider/parse failure.
 */
export async function ingestNflSeason(
  deps: { store: NflIngestionStorePort; fetchSchedule: CsvFetcher; fetchWeekly: CsvFetcher },
  params: IngestNflSeasonParams,
): Promise<NflIngestOutcome> {
  const plan = buildValidatedNflRequest(params);
  const base = { semanticSourceKey: plan.semanticSourceKey, snapshotId: null as string | null, recordCount: 0, featureRowsWritten: 0, playersUpdated: 0, coverage: null as NflSourceCoverage | null };

  // 1. Schedule (transient temporal-anchor input).
  const sched = await deps.fetchSchedule({ season: plan.season });
  if (!sched.ok) return { status: "provider_failure_schedule", ...base };
  const schedParsed = parseNflSchedule({ season: plan.season, sourceKey: `${plan.semanticSourceKey}#schedule`, rawPayload: sched.rawCsv, fetchedAt: sched.fetchedAt });
  if (!schedParsed.ok) return { status: "incomplete_schedule", ...base };
  const anchor = buildScheduleAnchor(schedParsed.records);

  // 2. Weekly stats (the feature source + immutable capture).
  const wk = await deps.fetchWeekly({ season: plan.season });
  if (!wk.ok) return { status: "provider_failure", ...base };
  const wkParsed = parseNflWeeklyStats({ season: plan.season, sourceKey: plan.semanticSourceKey, rawPayload: wk.rawCsv, fetchedAt: wk.fetchedAt, sourcePublishedAt: wk.sourcePublishedAt });
  const coverage = classifyNflCoverage(wkParsed, plan.currentSeason);
  if (!wkParsed.ok) return { status: "incomplete", ...base, coverage };

  const identity = buildCaptureSnapshotIdentity({ sourceKind: "nflverse_weekly_stats", semanticSourceKey: plan.semanticSourceKey, observationInstant: wk.fetchedAt, payload: wkParsed.rawPayload });
  const built = buildNflFeatureRows({ season: plan.season, sourceId: identity.snapshotId, records: wkParsed.records, anchor });
  const features = built.rows.map((r) => toFeatureInsert(r, identity.snapshotId));
  const entityCanonicalIds = Array.from(new Set(built.rows.map((r) => r.entityCanonicalId)));
  const featureKeys = Array.from(new Set(built.rows.map((r) => r.featureKey)));

  const knownAt = new Date(wk.fetchedAt);
  const rawRow: InsertPregameRawSourceSnapshot = {
    snapshotId: identity.snapshotId, sport: "nfl", sourceKind: "nflverse_weekly_stats",
    sourceKey: identity.captureKey, semanticSourceKey: plan.semanticSourceKey,
    validAt: new Date(maxValidAtIso(built.rows, plan.season)), knownAt,
    sourcePublishedAt: wk.sourcePublishedAt === null ? null : new Date(wk.sourcePublishedAt),
    knownAtPolicyVersion: NFL_KNOWN_AT_POLICY_VERSION,
    payload: wkParsed.rawPayload as InsertPregameRawSourceSnapshot["payload"], contentHash: identity.contentHash,
  };

  // Multi-entity fold under the lock: group rows by player, fold each against that player's
  // priors, keyed `${entity}|${featureKey}` in the locked-priors map.
  let playersUpdated = 0;
  const foldPosteriors = (lockedPriors: Map<string, PosteriorState>): InsertPregamePosteriorState[] => {
    const rowsByEntity = new Map<string, AsOfFeatureRow[]>();
    for (const r of built.rows) {
      const arr = rowsByEntity.get(r.entityCanonicalId) ?? [];
      arr.push(r); rowsByEntity.set(r.entityCanonicalId, arr);
    }
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
    semanticSourceKey: plan.semanticSourceKey, incomingKnownAt: knownAt, incomingContentHash: identity.contentHash,
    raw: rawRow, features, foldPosteriors,
  });

  const bwc = { ...base, coverage, recordCount: wkParsed.records.length };
  switch (result.decision) {
    case "first_capture":
    case "appended":
      return { status: "ingested", ...bwc, snapshotId: result.snapshotId, featureRowsWritten: features.length, playersUpdated };
    case "noop":
      return { status: "noop_identical", ...bwc, snapshotId: result.snapshotId };
    case "stale":
      return { status: "stale_observation", ...bwc };
    case "conflict":
      return { status: "conflicting_observation", ...bwc };
  }
}
