// PR5 — NBA ingestion orchestrator (pure of I/O via injected ports).
//
// Per (player, season): fetch RAW provider payload → parse → (idempotency probe) →
// write immutable raw snapshot → build as-of feature rows → fold posteriors. Storage
// and the provider are PORTS so the whole job is unit-testable with mocks (no DB, no
// network).
//
// Guarantees enforced here:
//   • Transport/HTTP/JSON failure → typed provider_failure, NO writes, coverage gap.
//   • Empty/malformed provider RESULTSET → the adapter classifies it (empty/incomplete);
//     the fetch still "succeeded", so a shallow response is never mislabeled a failure.
//   • Identical content (deterministic snapshotId already present) → NO-OP, NO writes.
//   • New content (first capture OR correction) → append-only immutable raw snapshot
//     (never an update/delete), new feature rows, incremental posterior fold. A
//     correction reuses PR1's same-game correction semantics in updatePosterior.
//   • The posterior read→fold→write happens INSIDE the storage transaction under a
//     per-entity lock (see ingestSnapshotAtomic) so two concurrent season ingests for
//     one player can never lose an update.
//   • Nothing here writes persisted_plays, produces targets/grades, emits analytics,
//     or reads a line/price/EV/outcome. The projection-core inputs stay blind.

import type {
  InsertPregameRawSourceSnapshot,
  InsertPregameFeatureSnapshot,
  InsertPregamePosteriorState,
} from "../../../shared/schema";
import { instantMs, type AsOfFeatureRow } from "../../../shared/pregameTargets/featureStore";
import { type PosteriorState } from "../posteriorState/posteriorState";
import { buildRawSnapshotIdentity, computeContentHash } from "./rawSnapshotIdentity";
import { parseNbaGameLog, gameDateToIso, nbaSeasonIntFromString } from "./nbaGameLogAdapter";
import { buildNbaFeatureRows, NBA_FEATURE_VERSION } from "./nbaFeatureBuilder";
import { foldNbaPosteriors } from "./nbaPosteriorBuilder";
import { classifySourceCoverage, type SourceCoverage } from "./ingestionCoverage";
import { buildNbaGameLogSourceKey, isNbaIngestSeasonType, NBA_KNOWN_AT_POLICY_VERSION, type NbaIngestSeasonType, type NbaSourceKind } from "./nbaSourceContracts";
import { buildCanonicalId } from "../../../shared/pregameTargets/canonicalEntities";

/**
 * Typed, fail-closed invocation error. Thrown when a caller — the CLI OR any direct
 * programmatic caller — asks the orchestrator to ingest with an incoherent identity
 * (mismatched season/label, unsupported season type, invalid current-season/as-of).
 * The CLI maps it to exit code 2. This is the identity firewall that does NOT rely on
 * the runner having validated first.
 */
export class IngestInvocationError extends Error {
  constructor(public readonly kind: string, message: string) {
    super(message);
    this.name = "IngestInvocationError";
  }
}

/** An immutable, fully-validated request plan. The provider request AND the persisted
 *  sourceKey are BOTH derived from this ONE object — never from independently supplied
 *  fields — so a fetch can never disagree with the identity it is stored under. */
export interface ValidatedIngestRequest {
  readonly kind: NbaSourceKind;
  readonly playerNativeId: string;
  readonly entityCanonicalId: string;
  readonly season: number;
  readonly seasonLabel: string;
  readonly seasonType: NbaIngestSeasonType;
  readonly currentSeason: number;
  readonly asOfDate: string;
  readonly sourceKey: string;
}

/**
 * Validate an ingestion invocation and produce the immutable request plan, or THROW a
 * typed fail-closed error. All checks run before any provider or storage access.
 */
export function buildValidatedIngestRequest(params: IngestPlayerSeasonParams): ValidatedIngestRequest {
  if (typeof params.playerNativeId !== "string" || params.playerNativeId.trim() === "") {
    throw new IngestInvocationError("invalid_player", "playerNativeId must be a non-empty string");
  }
  if (!isNbaIngestSeasonType(params.seasonType)) {
    throw new IngestInvocationError("unsupported_season_type", `unsupported seasonType ${JSON.stringify(params.seasonType)}`);
  }
  const parsedSeason = nbaSeasonIntFromString(params.seasonLabel);
  if (parsedSeason === null) {
    throw new IngestInvocationError("malformed_season_label", `malformed seasonLabel ${JSON.stringify(params.seasonLabel)}`);
  }
  if (parsedSeason !== params.season) {
    throw new IngestInvocationError("season_identity_mismatch", `seasonLabel ${JSON.stringify(params.seasonLabel)} resolves to ${parsedSeason}, not season ${params.season}`);
  }
  if (!Number.isInteger(params.currentSeason) || params.currentSeason <= 0) {
    throw new IngestInvocationError("invalid_current_season", `invalid currentSeason ${params.currentSeason}`);
  }
  if (typeof params.asOfDate !== "string" || !Number.isFinite(Date.parse(params.asOfDate))) {
    throw new IngestInvocationError("invalid_as_of_date", `invalid asOfDate ${JSON.stringify(params.asOfDate)}`);
  }
  const kind: NbaSourceKind = "nba_stats_playergamelog";
  const entityCanonicalId = buildCanonicalId("nba", "player", params.playerNativeId);
  const sourceKey = buildNbaGameLogSourceKey({ sourceKind: kind, entityCanonicalId, season: params.season, seasonType: params.seasonType });
  return {
    kind,
    playerNativeId: params.playerNativeId,
    entityCanonicalId,
    season: params.season,
    seasonLabel: params.seasonLabel,
    seasonType: params.seasonType,
    currentSeason: params.currentSeason,
    asOfDate: params.asOfDate,
    sourceKey,
  };
}

export interface AtomicIngestArgs {
  entityCanonicalId: string;
  featureVersion: string;
  /** featureKeys whose posterior states must be read + locked before folding. */
  featureKeys: string[];
  raw: InsertPregameRawSourceSnapshot;
  features: InsertPregameFeatureSnapshot[];
  /**
   * Fold the new feature rows against the CURRENT posterior states → the posterior
   * rows to upsert. This runs INSIDE the storage transaction, AFTER the current
   * states are read under a per-entity lock, so the read-modify-write is atomic:
   * two concurrent ingestions for the same player each observe the other's
   * committed seasons and neither is silently overwritten.
   */
  foldPosteriors: (lockedPriors: Map<string, PosteriorState>) => InsertPregamePosteriorState[];
}

export interface IngestionStorePort {
  /** Fast idempotency probe (short-circuits the no-op common case). */
  getRawSnapshotById(snapshotId: string): Promise<{ snapshotId: string } | null>;
  /**
   * ALL-OR-NOTHING, serialized-per-entity write. Inserts the immutable raw snapshot
   * (idempotent on the content-identity unique index), and ONLY if that insert is
   * new: acquires a per-entity advisory lock, reads the current posterior states
   * under it, invokes `foldPosteriors`, then writes the feature rows + folded
   * posteriors — inside ONE transaction. A failure rolls the whole thing back;
   * concurrent same-player ingestions serialize instead of losing updates. Returns
   * `{ inserted: false }` when the content already existed (a no-op).
   */
  ingestSnapshotAtomic(args: AtomicIngestArgs): Promise<{ inserted: boolean }>;
}

export interface GameLogFetchArgs {
  kind: NbaSourceKind;
  entityNativeId: string;
  season: number; // integer season (e.g. 2026) — identity/feature stamping
  seasonLabel: string; // exact validated NBA season string (e.g. "2023-24") — the provider request
  seasonType: string;
}

/** Typed fetch result: a shallow/empty provider response is `ok:true` (the adapter
 *  classifies it); only a real transport/HTTP/JSON failure is `ok:false`. `fetchedAt`
 *  is the post-decode OBSERVATION instant (→ knownAt); `failedAt` is a failure-observed
 *  instant that is NEVER treated as a successful payload's fetchedAt. */
export type GameLogFetchResult =
  | { ok: true; rawPayload: unknown; fetchedAt: string; requestedAt?: string }
  | { ok: false; reason: string; failedAt: string; requestedAt?: string };
export type GameLogFetcher = (args: GameLogFetchArgs) => Promise<GameLogFetchResult>;

export type IngestStatus = "provider_failure" | "incomplete" | "noop_identical" | "ingested";

export interface IngestOutcome {
  status: IngestStatus;
  sourceKey: string;
  snapshotId: string | null;
  recordCount: number;
  featureRowsWritten: number;
  posteriorsUpdated: string[];
  coverage: SourceCoverage;
}

export interface IngestPlayerSeasonParams {
  playerNativeId: string;
  season: number;
  /** Exact NBA season string ("2023-24"); its parsed start year must equal `season`. */
  seasonLabel: string;
  /** Canonical supported season type — validated at the orchestrator boundary too. */
  seasonType: NbaIngestSeasonType;
  currentSeason: number;
  /** Reference instant for recency weighting (ISO). */
  asOfDate: string;
}

function deterministicId(parts: readonly (string | number | null)[]): string {
  return computeContentHash(parts.map((p) => String(p)).join(" "));
}

function maxGameDateIso(records: readonly { gameDate: string }[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const r of records) {
    const iso = gameDateToIso(r.gameDate);
    const ms = instantMs(iso);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = iso;
    }
  }
  return best;
}

function toFeatureInsert(row: AsOfFeatureRow, snapshotId: string): InsertPregameFeatureSnapshot {
  const featureRowId = deterministicId([
    row.entityCanonicalId, row.featureKey, row.featureVersion, row.validAt, row.knownAt, snapshotId, row.state, row.value,
  ]);
  return {
    featureRowId,
    sport: row.sport,
    entityCanonicalId: row.entityCanonicalId,
    entityKind: row.entityKind,
    featureKey: row.featureKey,
    featureVersion: row.featureVersion,
    season: row.season,
    validAt: new Date(row.validAt),
    knownAt: new Date(row.knownAt),
    state: row.state,
    value: row.value === null ? null : String(row.value),
    sourceId: snapshotId,
    derivedFromGameIds: row.derivedFromGameIds ? [...row.derivedFromGameIds] : null,
  };
}

function toPosteriorInsert(state: PosteriorState, sport: string): InsertPregamePosteriorState {
  const posteriorId = deterministicId([state.entityCanonicalId, state.featureKey, state.featureVersion]);
  return {
    posteriorId,
    sport,
    entityCanonicalId: state.entityCanonicalId,
    featureKey: state.featureKey,
    featureVersion: state.featureVersion,
    stateVersion: state.version,
    bySeason: state.bySeason as unknown as InsertPregamePosteriorState["bySeason"],
  };
}

/**
 * Ingest one player-season. Idempotent and correction-aware. Never fabricates a
 * row on provider failure; never writes on an identical rerun.
 */
export async function ingestPlayerSeason(
  deps: { store: IngestionStorePort; fetch: GameLogFetcher },
  params: IngestPlayerSeasonParams,
): Promise<IngestOutcome> {
  // Identity firewall — throws a typed error BEFORE any provider/storage access. The
  // provider request AND the persisted sourceKey both come from this ONE validated plan.
  const plan = buildValidatedIngestRequest(params);
  const { kind, entityCanonicalId, sourceKey } = plan;

  const fetched = await deps.fetch({ kind, entityNativeId: plan.playerNativeId, season: plan.season, seasonLabel: plan.seasonLabel, seasonType: plan.seasonType });
  if (!fetched.ok) {
    const parsedFail = parseNbaGameLog({ kind, season: plan.season, sourceKey, entityNativeId: plan.playerNativeId, rawPayload: null, fetchedAt: fetched.failedAt });
    return { status: "provider_failure", sourceKey, snapshotId: null, recordCount: 0, featureRowsWritten: 0, posteriorsUpdated: [], coverage: classifySourceCoverage(parsedFail, plan.currentSeason) };
  }

  const parsed = parseNbaGameLog({ kind, season: plan.season, sourceKey, entityNativeId: plan.playerNativeId, rawPayload: fetched.rawPayload, fetchedAt: fetched.fetchedAt });
  const coverage = classifySourceCoverage(parsed, plan.currentSeason);
  if (!parsed.ok) {
    return { status: "incomplete", sourceKey, snapshotId: null, recordCount: 0, featureRowsWritten: 0, posteriorsUpdated: [], coverage };
  }

  const identity = buildRawSnapshotIdentity(kind, sourceKey, parsed.rawPayload);
  const existing = await deps.store.getRawSnapshotById(identity.snapshotId);
  if (existing !== null) {
    // Byte-identical content already ingested — a true no-op (no duplicate, no rewrite).
    return { status: "noop_identical", sourceKey, snapshotId: identity.snapshotId, recordCount: parsed.records.length, featureRowsWritten: 0, posteriorsUpdated: [], coverage };
  }

  // New content (first capture or a genuine correction). Build the immutable raw
  // snapshot + feature rows; the posterior fold is deferred INTO the transaction.
  const validAtIso = maxGameDateIso(parsed.records) ?? gameDateToIso(parsed.records[0].gameDate);
  // Timestamp-policy metadata persisted as audit fields (survives the DB, not just the
  // transient TS object). `sourcePublishedAt` is explicitly null for these endpoints
  // (they expose no publish instant). `supersedesSnapshotId` is deliberately NOT set
  // here — the correction predecessor is resolved by storage UNDER the same lock as the
  // insert (a caller can never pick its own predecessor). `createdAt` (defaultNow) is
  // the immutable ingestion instant.
  const rawRow: InsertPregameRawSourceSnapshot = {
    snapshotId: identity.snapshotId,
    sport: "nba",
    sourceKind: kind,
    sourceKey,
    validAt: new Date(validAtIso),
    knownAt: new Date(fetched.fetchedAt),
    sourcePublishedAt: parsed.records[0].timestamps.sourcePublishedAt === null ? null : new Date(parsed.records[0].timestamps.sourcePublishedAt),
    knownAtPolicyVersion: parsed.records[0].timestamps.knownAtPolicyVersion ?? NBA_KNOWN_AT_POLICY_VERSION,
    payload: parsed.rawPayload as InsertPregameRawSourceSnapshot["payload"],
    contentHash: identity.contentHash,
  };

  const built = buildNbaFeatureRows({ season: plan.season, playerNativeId: plan.playerNativeId, sourceId: identity.snapshotId, records: parsed.records });
  const features = built.rows.map((row) => toFeatureInsert(row, identity.snapshotId));
  const featureKeys = Array.from(new Set(built.rows.map((r) => r.featureKey)));

  // The fold runs inside the storage transaction, against posterior states read
  // under a per-entity lock — so it always sees any concurrently-committed season.
  let posteriorsUpdated: string[] = [];
  const foldPosteriors = (lockedPriors: Map<string, PosteriorState>): InsertPregamePosteriorState[] => {
    const folded = foldNbaPosteriors({ rows: built.rows, currentSeason: plan.currentSeason, asOfDate: plan.asOfDate, priorStates: lockedPriors });
    posteriorsUpdated = Array.from(folded.keys()).sort();
    return Array.from(folded.values()).map((state) => toPosteriorInsert(state, "nba"));
  };

  const { inserted } = await deps.store.ingestSnapshotAtomic({
    entityCanonicalId,
    featureVersion: NBA_FEATURE_VERSION,
    featureKeys,
    raw: rawRow,
    features,
    foldPosteriors,
  });
  if (!inserted) {
    return { status: "noop_identical", sourceKey, snapshotId: identity.snapshotId, recordCount: parsed.records.length, featureRowsWritten: 0, posteriorsUpdated: [], coverage };
  }

  return { status: "ingested", sourceKey, snapshotId: identity.snapshotId, recordCount: parsed.records.length, featureRowsWritten: features.length, posteriorsUpdated, coverage };
}
