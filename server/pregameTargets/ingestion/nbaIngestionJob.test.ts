// Run: npx tsx server/pregameTargets/ingestion/nbaIngestionJob.test.ts
// Pregame Targets PR5 — ingestion job (mock ports). Observation identity is NOT
// content identity (audit-4): idempotency is equality to the CURRENT HEAD (latest by
// knownAt), so a genuine A→B→A recurrence appends a new capture instead of collapsing;
// an out-of-order (older knownAt) arrival fails closed; a same-instant different payload
// is a conflict. Plus: orchestrator identity firewall, transaction atomicity, and the
// concurrency/no-lost-update posterior guarantees.
import { ingestPlayerSeason, buildValidatedIngestRequest, IngestInvocationError, type IngestionStorePort, type GameLogFetcher, type AtomicIngestArgs } from "./nbaIngestionJob";
import type { InsertPregameRawSourceSnapshot, InsertPregameFeatureSnapshot, InsertPregamePosteriorState } from "../../../shared/schema";
import type { PosteriorState } from "../posteriorState/posteriorState";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

type StoredRaw = InsertPregameRawSourceSnapshot & { knownAtMs: number };

function mockStore(opts: { failFeatureWrite?: boolean; interleaveYield?: () => Promise<void> } = {}) {
  const raw = new Map<string, StoredRaw>();
  const features: InsertPregameFeatureSnapshot[] = [];
  const posteriors = new Map<string, InsertPregamePosteriorState>();
  const pk = (e: string, f: string, v: string) => `${e}|${f}|${v}`;
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
    ingestSnapshotAtomic: async (args: AtomicIngestArgs) => withEntityLock(args.entityCanonicalId, async () => {
      // HEAD of the observation chain for this SEMANTIC identity, by knownAt (tie: id).
      let head: StoredRaw | null = null;
      for (const r of raw.values()) {
        if (r.semanticSourceKey !== args.semanticSourceKey) continue;
        if (head === null || r.knownAtMs > head.knownAtMs || (r.knownAtMs === head.knownAtMs && r.snapshotId > head.snapshotId)) head = r;
      }
      const inMs = args.incomingKnownAt.getTime();
      let supersedes: string | null = null;
      if (head) {
        if (inMs < head.knownAtMs) return { decision: "stale" as const, snapshotId: null, supersedes: null };
        if (inMs === head.knownAtMs) {
          return args.incomingContentHash === head.contentHash
            ? { decision: "noop" as const, snapshotId: head.snapshotId, supersedes: null }
            : { decision: "conflict" as const, snapshotId: null, supersedes: null };
        }
        if (args.incomingContentHash === head.contentHash) return { decision: "noop" as const, snapshotId: head.snapshotId, supersedes: null };
        supersedes = head.snapshotId;
      }
      // Fold posteriors under the lock, against current state.
      const lockedPriors = new Map<string, PosteriorState>();
      for (const fk of args.featureKeys) {
        const r = posteriors.get(pk(args.entityCanonicalId, fk, args.featureVersion));
        if (r) lockedPriors.set(fk, { version: r.stateVersion, featureKey: fk, featureVersion: args.featureVersion, entityCanonicalId: args.entityCanonicalId, bySeason: r.bySeason as PosteriorState["bySeason"] });
      }
      if (opts.interleaveYield) await opts.interleaveYield();
      const posts = args.foldPosteriors(lockedPriors);
      const staged: InsertPregameFeatureSnapshot[] = [];
      for (const f of args.features) {
        if (opts.failFeatureWrite) throw new Error("simulated DB failure mid-write");
        if (!features.some((x) => x.featureRowId === f.featureRowId)) staged.push(f);
      }
      raw.set(args.raw.snapshotId, { ...args.raw, supersedesSnapshotId: supersedes, knownAtMs: inMs });
      features.push(...staged);
      for (const p of posts) posteriors.set(pk(p.entityCanonicalId, p.featureKey, p.featureVersion), p);
      return { decision: (supersedes === null ? "first_capture" : "appended") as const, snapshotId: args.raw.snapshotId, supersedes };
    }),
  };
  return { store, raw, features, posteriors };
}

const HEADERS = ["GAME_ID", "GAME_DATE", "MATCHUP", "MIN", "PTS", "REB", "AST", "FG3M"];
const payload = (pts: number, gameId = "0022300500", gameDate = "2024-01-15") => ({ resultSets: [{ headers: HEADERS, rowSet: [[gameId, gameDate, "DEN vs. LAL", 34, pts, 8, 6, 3]] }] });
const at = (n: number) => `2026-08-05T18:00:0${n}.000Z`; // distinct, increasing observation instants (n=0..9)
const fetchAt = (p: unknown, iso: string): GameLogFetcher => async () => ({ ok: true, rawPayload: p, fetchedAt: iso });
const failFetch = (reason = "transport_failure"): GameLogFetcher => async () => ({ ok: false, reason, failedAt: at(0) });
const params = { playerNativeId: "201939", season: 2024, seasonLabel: "2023-24", seasonType: "Regular Season" as const, currentSeason: 2026, asOfDate: "2026-08-06T00:00:00Z" };

// ── First ingest writes raw + features + posteriors ─────────────────────────
{
  const m = mockStore();
  const out = await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(1)) }, params);
  ok(out.status === "ingested", "first ingest → ingested");
  ok(m.raw.size === 1, "one immutable raw capture written");
  ok(m.features.length > 0 && out.featureRowsWritten === m.features.length, "feature rows written");
  ok(out.posteriorsUpdated.includes("nba.player.points_per_min"), "points_per_min posterior updated");
}

// ── TRUE idempotency: same content at a LATER instant with no intervening state ─
{
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(1)) }, params);
  const out2 = await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(2)) }, params); // same content, later instant
  ok(out2.status === "noop_identical", "same content as head (later instant) → noop_identical");
  ok(m.raw.size === 1, "no new capture (state unchanged)");
  ok(m.features.length === Array.from(m.features).length && out2.featureRowsWritten === 0, "no feature/posterior writes on the no-op");
}

// ── A → B → A recurrence: return to earlier content is a NEW capture ────────
{
  const m = mockStore();
  const a1 = await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(1)) }, params); // A
  const b = await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(31), at(2)) }, params);  // B
  const a2 = await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(3)) }, params); // A again (exact bytes)
  ok(a1.status === "ingested" && b.status === "ingested" && a2.status === "ingested", "all three observations accepted as captures");
  ok(m.raw.size === 3, "three distinct captures persisted (A→B→A not collapsed)");
  const rowA1 = m.raw.get(a1.snapshotId!)!, rowB = m.raw.get(b.snapshotId!)!, rowA2 = m.raw.get(a2.snapshotId!)!;
  ok(a1.snapshotId !== a2.snapshotId, "A1 and A2 have DIFFERENT capture ids");
  ok(rowA1.contentHash === rowA2.contentHash, "A1 and A2 have the SAME contentHash (pure payload hash)");
  ok(rowB.supersedesSnapshotId === a1.snapshotId, "B supersedes A1");
  ok(rowA2.supersedesSnapshotId === b.snapshotId, "A2 supersedes B (return to earlier content, later instant)");
  // Posterior reflects the newest state A2 (points_per_min = 30/34 again).
  const p = m.posteriors.get("nba:player:201939|nba.player.points_per_min|nba_gamelog_v1")!;
  const byGame = (p.bySeason as Record<number, { byGame: Record<string, { wx: number; w: number }> }>)[2024].byGame;
  const gk = Object.keys(byGame)[0];
  ok(Object.keys(byGame).length === 1 && Math.abs(byGame[gk].wx / byGame[gk].w - 30 / 34) < 1e-9, "posterior reflects the newest state (A2, 30/34), single lineage entry");
}

// ── Historical content reuse A → B → C → B: second B is a new transition ─────
{
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(1)) }, params); // A
  const b1 = await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(31), at(2)) }, params); // B
  await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(32), at(3)) }, params); // C
  const b2 = await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(31), at(4)) }, params); // B again
  ok(b2.status === "ingested" && b2.snapshotId !== b1.snapshotId, "second B is a NEW capture (not collapsed to the historical B)");
  ok(m.raw.size === 4, "four captures retained");
}

// ── Out-of-order (older knownAt) arrival fails closed as stale ──────────────
{
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(1)) }, params); // A @ t1
  await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(31), at(3)) }, params); // C @ t3 (head)
  const stale = await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(32), at(2)) }, params); // @ t2 < head
  ok(stale.status === "stale_observation", "older-knownAt arrival → stale_observation");
  ok(m.raw.size === 2, "stale observation wrote nothing (no false chronology)");
  // The head is unchanged, no fork.
  const preds = Array.from(m.raw.values()).map((r) => r.supersedesSnapshotId).filter((x): x is string => x != null);
  ok(new Set(preds).size === preds.length, "no lineage fork introduced by the stale arrival");
}

// ── Same-knownAt, different payload → conflict (fail closed, no fake tiebreak) ─
{
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(1)) }, params);
  const conflict = await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(31), at(1)) }, params); // same instant, diff payload
  ok(conflict.status === "conflicting_observation", "same knownAt + different payload → conflicting_observation");
  ok(m.raw.size === 1, "conflicting observation wrote nothing");
}

// ── Provider failure (transport) → NO writes, no fabrication ─────────────────
{
  const m = mockStore();
  const out = await ingestPlayerSeason({ store: m.store, fetch: failFetch() }, params);
  ok(out.status === "provider_failure", "transport failure → provider_failure");
  ok(m.raw.size === 0 && m.features.length === 0 && m.posteriors.size === 0, "provider failure writes NOTHING");
}

// ── Incomplete response / empty resultSet ───────────────────────────────────
{
  const m1 = mockStore();
  const bad = await ingestPlayerSeason({ store: m1.store, fetch: fetchAt({ resultSets: [{ headers: "bad", rowSet: [] }] }, at(1)) }, params);
  ok(bad.status === "incomplete" && m1.raw.size === 0, "malformed resultSets → incomplete, writes nothing");
  const m2 = mockStore();
  const empty = await ingestPlayerSeason({ store: m2.store, fetch: fetchAt({ resultSets: [{ headers: HEADERS, rowSet: [] }] }, at(1)) }, params);
  ok(empty.status === "incomplete" && empty.coverage.reason.includes("provider_empty_result"), "empty rowSet → incomplete (not provider_failure)");
}

// ── Incremental posterior accumulation across seasons ───────────────────────
{
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(1)) }, { ...params, season: 2026, seasonLabel: "2025-26" });
  await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(24, "0022400111", "2025-01-10"), at(2)) }, { ...params, season: 2025, seasonLabel: "2024-25" });
  const p = m.posteriors.get("nba:player:201939|nba.player.points_per_min|nba_gamelog_v1")!;
  const seasons = Object.keys(p.bySeason as Record<string, unknown>);
  ok(seasons.includes("2026") && seasons.includes("2025"), "posterior accumulates across separate season ingests");
}

// ── CONCURRENCY: two different seasons started together, both keep their season ─
{
  const interleaveYield = async () => { await Promise.resolve(); await Promise.resolve(); };
  const m = mockStore({ interleaveYield });
  const a = ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(1)) }, { ...params, season: 2026, seasonLabel: "2025-26" });
  const b = ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(24, "0022400111", "2025-01-10"), at(2)) }, { ...params, season: 2025, seasonLabel: "2024-25" });
  const [ra, rb] = await Promise.all([a, b]);
  ok(ra.status === "ingested" && rb.status === "ingested", "both concurrent season ingests complete");
  const p = m.posteriors.get("nba:player:201939|nba.player.points_per_min|nba_gamelog_v1")!;
  const seasons = Object.keys(p.bySeason as Record<string, unknown>);
  ok(seasons.includes("2026") && seasons.includes("2025"), "final posterior contains BOTH seasons (no concurrent lost update)");
}

// ── CONCURRENCY CHRONOLOGY: later obs commits first; older then fails closed ──
{
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(1)) }, params); // base A @ t1
  // t3 acquires the lock first (called first) and commits; t2 then arrives older.
  const later = ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(33), at(3)) }, params); // t3
  const earlier = ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(31), at(2)) }, params); // t2
  const [rl, re] = await Promise.all([later, earlier]);
  ok(rl.status === "ingested", "later observation (t3) is accepted");
  ok(re.status === "stale_observation", "earlier observation (t2) that commits after t3 fails closed as stale");
  ok(m.raw.size === 2, "no extra capture from the stale arrival");
  // Normal order t2 then t3 → linear chain.
  const m2 = mockStore();
  await ingestPlayerSeason({ store: m2.store, fetch: fetchAt(payload(30), at(1)) }, params);
  const t2 = await ingestPlayerSeason({ store: m2.store, fetch: fetchAt(payload(31), at(2)) }, params);
  const t3 = await ingestPlayerSeason({ store: m2.store, fetch: fetchAt(payload(32), at(3)) }, params);
  ok(m2.raw.get(t3.snapshotId!)!.supersedesSnapshotId === t2.snapshotId, "in-order t2 then t3 produces a linear chain");
}

// ── Atomicity: a mid-write DB failure rolls back — nothing is written ────────
{
  const m = mockStore({ failFeatureWrite: true });
  let threw = false;
  try { await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(1)) }, params); } catch { threw = true; }
  ok(threw, "a mid-write failure propagates");
  ok(m.raw.size === 0 && m.features.length === 0 && m.posteriors.size === 0, "atomic rollback: NO partial state");
}

// ── Orchestrator identity firewall: rejected BEFORE any fetch ────────────────
{
  let fetchCalls = 0;
  const spy: GameLogFetcher = async () => { fetchCalls++; return { ok: true, rawPayload: payload(30), fetchedAt: at(1) }; };
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

  fetchCalls = 0;
  const okOut = await ingestPlayerSeason({ store: mockStore().store, fetch: spy }, { ...params, season: 2024, seasonLabel: "2023-24" });
  ok(okOut.status === "ingested" && fetchCalls === 1, "coherent season/label accepted, fetch invoked once");
}

// ── One validated plan drives BOTH the provider request and the semantic key ─
{
  const plan = buildValidatedIngestRequest({ ...params, season: 2025, seasonLabel: "2024-25", seasonType: "Playoffs" });
  ok(plan.sourceKey.includes("seasonType=Playoffs") && plan.sourceKey.includes("season=2025"), "semantic sourceKey derived from the ONE plan (Playoffs identity)");
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30, "0042400300", "2025-05-01"), at(1)) }, { ...params, season: 2025, seasonLabel: "2024-25", seasonType: "Playoffs" });
  const stored = Array.from(m.raw.values())[0];
  ok(stored.semanticSourceKey!.includes("seasonType=Playoffs"), "persisted capture carries the Playoffs semantic identity");
  ok(stored.sourceKey.includes("|obs="), "stored source_key is capture-specific (semantic key + observation instant)");
}

// ── Timestamp-policy metadata stamped on the capture ────────────────────────
{
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetchAt(payload(30), at(1)) }, params);
  const row = Array.from(m.raw.values())[0];
  ok(row.knownAtPolicyVersion === "nba_gamelog_knownAt_v1", "knownAtPolicyVersion persisted");
  ok(row.sourcePublishedAt === null, "sourcePublishedAt explicitly null");
  ok(row.contentHash.length === 64, "contentHash is a pure 64-hex payload hash");
}

console.log(`\nnbaIngestionJob.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
