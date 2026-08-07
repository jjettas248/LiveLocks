// Run: npx tsx server/pregameTargets/ingestion/nbaIngestionJob.test.ts
// Pregame Targets PR5 — ingestion job (mock ports): identical rerun is a no-op,
// genuine correction creates a NEW immutable snapshot + posterior correction,
// provider failure / incomplete response writes NOTHING and fabricates nothing,
// and CONCURRENT season ingests for one player never lose a posterior update
// (the fold runs under the atomic method's per-entity serialization).
import { ingestPlayerSeason, buildValidatedIngestRequest, IngestInvocationError, type IngestionStorePort, type GameLogFetcher, type AtomicIngestArgs } from "./nbaIngestionJob";
import type { InsertPregameRawSourceSnapshot, InsertPregameFeatureSnapshot, InsertPregamePosteriorState } from "../../../shared/schema";
import type { PosteriorState } from "../posteriorState/posteriorState";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

function mockStore(opts: { failFeatureWrite?: boolean; interleaveYield?: () => Promise<void> } = {}) {
  const raw = new Map<string, InsertPregameRawSourceSnapshot>();
  const features: InsertPregameFeatureSnapshot[] = [];
  const posteriors = new Map<string, InsertPregamePosteriorState>();
  const pk = (e: string, f: string, v: string) => `${e}|${f}|${v}`;
  // Faithful model of the storage contract: ingestSnapshotAtomic serializes the
  // posterior READ→FOLD→WRITE per entity. We enforce that with a per-entity promise
  // chain (the mock's stand-in for pg_advisory_xact_lock), so a concurrent same-player
  // ingest cannot read a stale prior. The optional interleaveYield inside the locked
  // section proves the lock is load-bearing: without it, two concurrent folds would
  // both read the empty prior and the last writer would clobber the other's season.
  const entityLocks = new Map<string, Promise<unknown>>();
  async function withEntityLock<T>(entity: string, fn: () => Promise<T>): Promise<T> {
    const prev = entityLocks.get(entity) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    entityLocks.set(entity, prev.then(() => gate));
    await prev;
    try { return await fn(); } finally { release(); }
  }
  const store: IngestionStorePort = {
    getRawSnapshotById: async (id) => (raw.has(id) ? { snapshotId: id } : null),
    ingestSnapshotAtomic: async (args: AtomicIngestArgs) => {
      if (raw.has(args.raw.snapshotId)) return { inserted: false };
      return withEntityLock(args.entityCanonicalId, async () => {
        // Correction lineage under the lock: latest existing raw for the same source
        // identity (insertion order == recency in this Map model).
        let predecessor: string | null = null;
        for (const r of raw.values()) {
          if (r.sourceKind === args.raw.sourceKind && r.sourceKey === args.raw.sourceKey) predecessor = r.snapshotId;
        }
        // Read CURRENT posteriors under the lock, then fold against them.
        const lockedPriors = new Map<string, PosteriorState>();
        for (const fk of args.featureKeys) {
          const r = posteriors.get(pk(args.entityCanonicalId, fk, args.featureVersion));
          if (r) lockedPriors.set(fk, { version: r.stateVersion, featureKey: fk, featureVersion: args.featureVersion, entityCanonicalId: args.entityCanonicalId, bySeason: r.bySeason as PosteriorState["bySeason"] });
        }
        if (opts.interleaveYield) await opts.interleaveYield();
        const posts = args.foldPosteriors(lockedPriors);
        const stagedFeatures: InsertPregameFeatureSnapshot[] = [];
        for (const f of args.features) {
          if (opts.failFeatureWrite) throw new Error("simulated DB failure mid-write");
          if (!features.some((x) => x.featureRowId === f.featureRowId)) stagedFeatures.push(f);
        }
        raw.set(args.raw.snapshotId, { ...args.raw, supersedesSnapshotId: predecessor });
        features.push(...stagedFeatures);
        for (const p of posts) posteriors.set(pk(p.entityCanonicalId, p.featureKey, p.featureVersion), p);
        return { inserted: true };
      });
    },
  };
  return { store, raw, features, posteriors };
}

const HEADERS = ["GAME_ID", "GAME_DATE", "MATCHUP", "MIN", "PTS", "REB", "AST", "FG3M"];
const payload = (pts: number, gameId = "0022300500", gameDate = "2024-01-15") => ({ resultSets: [{ headers: HEADERS, rowSet: [[gameId, gameDate, "DEN vs. LAL", 34, pts, 8, 6, 3]] }] });
const fetcherOf = (p: unknown | null): GameLogFetcher => async () =>
  p === null ? { ok: false, reason: "transport_failure", failedAt: "2026-08-05T18:00:00Z" } : { ok: true, rawPayload: p, fetchedAt: "2026-08-05T18:00:00Z" };
const params = { playerNativeId: "201939", season: 2024, seasonLabel: "2023-24", seasonType: "Regular Season" as const, currentSeason: 2026, asOfDate: "2026-08-06T00:00:00Z" };

// ── First ingest writes raw + features + posteriors ─────────────────────────
{
  const m = mockStore();
  const out = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, params);
  ok(out.status === "ingested", "first ingest → ingested");
  ok(m.raw.size === 1, "one immutable raw snapshot written");
  ok(m.features.length > 0 && out.featureRowsWritten === m.features.length, "feature rows written");
  ok(m.posteriors.size > 0 && out.posteriorsUpdated.length === m.posteriors.size, "posteriors updated");
  ok(out.posteriorsUpdated.includes("nba.player.points_per_min"), "points_per_min posterior updated");
}

// ── Identical rerun is a NO-OP (no duplicate, no rewrite) ───────────────────
{
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, params);
  const rawAfter1 = m.raw.size, featAfter1 = m.features.length;
  const out2 = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, params);
  ok(out2.status === "noop_identical", "identical rerun → noop_identical");
  ok(m.raw.size === rawAfter1, "no duplicate raw snapshot");
  ok(m.features.length === featAfter1, "no duplicate feature rows");
  ok(out2.featureRowsWritten === 0 && out2.posteriorsUpdated.length === 0, "no writes on the no-op rerun");
}

// ── Genuine correction → NEW immutable snapshot + posterior correction ──────
{
  const m = mockStore();
  const out1 = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, params);
  const out2 = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(31)) }, params); // corrected PTS
  ok(out2.status === "ingested", "correction → ingested (new content)");
  ok(out2.snapshotId !== out1.snapshotId, "correction produces a NEW snapshotId");
  ok(m.raw.size === 2, "both snapshots retained (prior not overwritten/deleted)");
  ok(m.raw.has(out1.snapshotId!) && m.raw.has(out2.snapshotId!), "prior + corrected snapshots both present (lineage retained)");
  const p = m.posteriors.get("nba:player:201939|nba.player.points_per_min|nba_gamelog_v1")!;
  const byGame = (p.bySeason as Record<number, { byGame: Record<string, { wx: number; w: number }> }>)[2024].byGame;
  const gameKey = Object.keys(byGame)[0];
  ok(Object.keys(byGame).length === 1, "single lineage entry after correction (not double-counted)");
  ok(Math.abs(byGame[gameKey].wx / byGame[gameKey].w - 31 / 34) < 1e-9, "posterior reflects the CORRECTED per-min value");
}

// ── Provider failure (transport) → NO writes, no fabrication ─────────────────
{
  const m = mockStore();
  const out = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(null) }, params);
  ok(out.status === "provider_failure", "transport failure → provider_failure");
  ok(m.raw.size === 0 && m.features.length === 0 && m.posteriors.size === 0, "provider failure writes NOTHING (no fabricated zero/feature)");
}

// ── Incomplete response → NO writes, classified incomplete ──────────────────
{
  const m = mockStore();
  const out = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf({ resultSets: [{ headers: "bad", rowSet: [] }] }) }, params);
  ok(out.status === "incomplete", "malformed resultSets → incomplete");
  ok(m.raw.size === 0 && m.features.length === 0, "incomplete response writes nothing");
  ok(out.coverage.coverage === "incomplete", "coverage marked incomplete (never complete)");
}

// ── An EMPTY provider resultSet is a shallow response, not a transport failure ─
{
  const m = mockStore();
  const out = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf({ resultSets: [{ headers: HEADERS, rowSet: [] }] }) }, params);
  ok(out.status === "incomplete", "empty rowSet → incomplete (adapter empty_result), NOT provider_failure");
  ok(out.coverage.reason.includes("provider_empty_result"), "coverage attributes it to an empty provider result");
}

// ── Incremental posterior accumulation across seasons (sequential) ──────────
{
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, { ...params, season: 2026, seasonLabel: "2025-26" });
  await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(24, "0022400111", "2025-01-10")) }, { ...params, season: 2025, seasonLabel: "2024-25" });
  const p = m.posteriors.get("nba:player:201939|nba.player.points_per_min|nba_gamelog_v1")!;
  const seasons = Object.keys(p.bySeason as Record<string, unknown>);
  ok(seasons.includes("2026") && seasons.includes("2025"), "posterior accumulates across separate season ingests");
}

// ── CONCURRENCY: two seasons for one player, started from the SAME empty prior,
//    both complete → the final posterior contains BOTH seasons (no lost update) ─
{
  // The interleaveYield forces both ingests to reach the "read prior" point before
  // either writes. If the read→fold→write were NOT serialized, both would read the
  // empty prior and the last writer would clobber the first's season. The atomic
  // method's per-entity lock makes the second wait, read the first's committed
  // state, and fold its season on top.
  // Yield the event loop inside the locked read-fold section so the scheduler is
  // free to try to interleave the two ingests; the per-entity lock must still
  // serialize them.
  const interleaveYield = async () => { await Promise.resolve(); await Promise.resolve(); };
  const m = mockStore({ interleaveYield });
  const a = ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, { ...params, season: 2026, seasonLabel: "2025-26" });
  const b = ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(24, "0022400111", "2025-01-10")) }, { ...params, season: 2025, seasonLabel: "2024-25" });
  const [ra, rb] = await Promise.all([a, b]);
  ok(ra.status === "ingested" && rb.status === "ingested", "both concurrent ingests complete");
  const p = m.posteriors.get("nba:player:201939|nba.player.points_per_min|nba_gamelog_v1")!;
  const seasons = Object.keys(p.bySeason as Record<string, unknown>);
  ok(seasons.includes("2026") && seasons.includes("2025"), "final posterior contains BOTH seasons (no concurrent lost update)");
}

// ── Atomicity: a mid-write DB failure rolls back — nothing is written ────────
{
  const m = mockStore({ failFeatureWrite: true });
  let threw = false;
  try {
    await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, params);
  } catch { threw = true; }
  ok(threw, "a mid-write failure propagates (nonzero-exit path in the runner)");
  ok(m.raw.size === 0 && m.features.length === 0 && m.posteriors.size === 0, "atomic rollback: NO partial state (raw/features/posteriors all empty)");
}

// ── Fast idempotency probe short-circuits before any build/fold work ─────────
{
  const m = mockStore();
  const first = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, params);
  ok(first.status === "ingested", "first ingest ok");
  const again = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, params);
  ok(again.status === "noop_identical" && again.featureRowsWritten === 0, "identical rerun → no-op via fast probe");
}

// ── Orchestrator identity firewall: rejected BEFORE any fetch (not runner-only) ─
{
  let fetchCalls = 0;
  const spy: GameLogFetcher = async () => { fetchCalls++; return { ok: true, rawPayload: payload(30), fetchedAt: "2026-08-05T18:00:00Z" }; };
  const expectThrowBeforeFetch = async (p: typeof params, label: string) => {
    fetchCalls = 0;
    let kind: string | null = null;
    try { await ingestPlayerSeason({ store: mockStore().store, fetch: spy }, p); } catch (e) { if (e instanceof IngestInvocationError) kind = e.kind; }
    ok(kind !== null && fetchCalls === 0, label);
    return kind;
  };
  await expectThrowBeforeFetch({ ...params, season: 2024, seasonLabel: "2024-25" }, "season 2024 + label 2024-25 rejected before fetch");
  await expectThrowBeforeFetch({ ...params, seasonType: "Preseason" as unknown as "Regular Season" }, "unsupported season type rejected before fetch");
  await expectThrowBeforeFetch({ ...params, seasonLabel: "2023-2" }, "malformed season label rejected before fetch");
  await expectThrowBeforeFetch({ ...params, currentSeason: NaN }, "invalid currentSeason rejected before fetch");
  await expectThrowBeforeFetch({ ...params, asOfDate: "not-a-date" }, "invalid asOfDate rejected before fetch");
  const mk = await expectThrowBeforeFetch({ ...params, season: 2024, seasonLabel: "2024-25" }, "mismatch kind is season_identity_mismatch");
  ok(mk === "season_identity_mismatch", "typed mismatch kind surfaced");

  // A coherent request is accepted and reaches the fetch.
  fetchCalls = 0;
  const okOut = await ingestPlayerSeason({ store: mockStore().store, fetch: spy }, { ...params, season: 2024, seasonLabel: "2023-24" });
  ok(okOut.status === "ingested" && fetchCalls === 1, "coherent season/label accepted, fetch invoked once");
}

// ── One validated plan drives BOTH the provider request and the persisted sourceKey ─
{
  const plan = buildValidatedIngestRequest({ ...params, season: 2025, seasonLabel: "2024-25", seasonType: "Playoffs" });
  ok(plan.seasonType === "Playoffs" && plan.seasonLabel === "2024-25" && plan.season === 2025, "plan captures the validated identity");
  ok(plan.sourceKey.includes("seasonType=Playoffs") && plan.sourceKey.includes("season=2025"), "sourceKey derived from the ONE plan (Playoffs identity)");
  // A valid Playoffs ingest persists a Playoffs source identity.
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30, "0042400300", "2025-05-01")) }, { ...params, season: 2025, seasonLabel: "2024-25", seasonType: "Playoffs" });
  const stored = Array.from(m.raw.values())[0];
  ok(stored.sourceKey.includes("seasonType=Playoffs"), "persisted raw snapshot carries the Playoffs identity");
}

// ── Timestamp-policy metadata is stamped on the raw row ─────────────────────
{
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, params);
  const row = Array.from(m.raw.values())[0];
  ok(row.knownAtPolicyVersion === "nba_gamelog_knownAt_v1", "knownAtPolicyVersion persisted on the raw row");
  ok(row.sourcePublishedAt === null, "sourcePublishedAt explicitly null (provider exposes none)");
  ok(row.knownAt instanceof Date, "knownAt persisted as the observation instant");
}

// ── Correction lineage: first capture has no predecessor; B→A→...; C→B ──────
{
  const m = mockStore();
  const a = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, params);
  const rowA = m.raw.get(a.snapshotId!)!;
  ok((rowA.supersedesSnapshotId ?? null) === null, "first capture has NO predecessor");
  const b = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(31)) }, params); // correction
  const rowB = m.raw.get(b.snapshotId!)!;
  ok(rowB.supersedesSnapshotId === a.snapshotId, "correction B explicitly supersedes A");
  const c = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(32)) }, params); // 2nd correction
  const rowC = m.raw.get(c.snapshotId!)!;
  ok(rowC.supersedesSnapshotId === b.snapshotId, "correction C explicitly supersedes B (deterministic chain)");
  ok(m.raw.size === 3, "all three immutable snapshots retained (none repointed/deleted)");
  ok(rowA.supersedesSnapshotId == null && rowB.supersedesSnapshotId === a.snapshotId, "prior snapshots' lineage never mutated by a later correction");
}

// ── Identical rerun changes no lineage ──────────────────────────────────────
{
  const m = mockStore();
  const a = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, params);
  await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, params);
  ok(m.raw.size === 1 && (m.raw.get(a.snapshotId!)!.supersedesSnapshotId ?? null) === null, "identical rerun creates nothing and no lineage");
}

console.log(`\nnbaIngestionJob.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
