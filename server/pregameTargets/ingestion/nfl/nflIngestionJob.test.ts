// Run: npx tsx server/pregameTargets/ingestion/nfl/nflIngestionJob.test.ts
// PR6 — NFL ingestion job (mock dataset store): one weekly file → MANY players' posteriors
// (multi-entity fold); provider game_id join to the schedule; DUAL-SOURCE provenance
// (weekly + schedule captured, feature sourceId = a join snapshot referencing both);
// head-by-knownAt (A→B→A / stale / conflict); CROSS-SEASON posterior lock (concurrent
// 2024+2023 keep both seasons); no fabricated validAt (unresolved join → unresolvable,
// nothing persisted); identity firewall; provider/parse failures write nothing.
import { ingestNflSeason, buildValidatedNflRequest, NflIngestInvocationError, NFL_POSTERIOR_LOCK_KEY, type NflIngestionStorePort, type CsvFetcher, type DatasetAtomicIngestArgs } from "./nflIngestionJob";
import type { InsertPregameRawSourceSnapshot, InsertPregameFeatureSnapshot, InsertPregamePosteriorState } from "../../../../shared/schema";
import type { PosteriorState } from "../../posteriorState/posteriorState";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

type StoredRaw = InsertPregameRawSourceSnapshot & { knownAtMs: number };

function mockStore(opts: { failFeatureWrite?: boolean; interleaveYield?: () => Promise<void> } = {}) {
  const raw = new Map<string, StoredRaw>();
  const features: InsertPregameFeatureSnapshot[] = [];
  const posteriors = new Map<string, InsertPregamePosteriorState>();
  const locks = new Map<string, Promise<unknown>>();
  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    locks.set(key, prev.then(() => gate));
    await prev;
    try { return await fn(); } finally { release(); }
  }
  const store: NflIngestionStorePort = {
    ingestDatasetSnapshotAtomic: async (args: DatasetAtomicIngestArgs) => withLock(args.posteriorLockKey, async () => {
      let head: StoredRaw | null = null;
      for (const r of raw.values()) {
        if (r.semanticSourceKey !== args.semanticSourceKey) continue;
        if (head === null || r.knownAtMs > head.knownAtMs || (r.knownAtMs === head.knownAtMs && r.snapshotId > head.snapshotId)) head = r;
      }
      const inMs = args.incomingKnownAt.getTime();
      let supersedes: string | null = null;
      if (head) {
        if (inMs < head.knownAtMs) return { decision: "stale" as const, snapshotId: null, supersedes: null };
        if (inMs === head.knownAtMs) return args.incomingContentHash === head.contentHash ? { decision: "noop" as const, snapshotId: head.snapshotId, supersedes: null } : { decision: "conflict" as const, snapshotId: null, supersedes: null };
        if (args.incomingContentHash === head.contentHash) return { decision: "noop" as const, snapshotId: head.snapshotId, supersedes: null };
        supersedes = head.snapshotId;
      }
      const lockedPriors = new Map<string, PosteriorState>();
      for (const e of args.entityCanonicalIds) for (const fk of args.featureKeys) {
        const r = posteriors.get(`${e}|${fk}|${args.featureVersion}`);
        if (r) lockedPriors.set(`${e}|${fk}`, { version: r.stateVersion, featureKey: fk, featureVersion: args.featureVersion, entityCanonicalId: e, bySeason: r.bySeason as PosteriorState["bySeason"] });
      }
      if (opts.interleaveYield) await opts.interleaveYield();
      const posts = args.foldPosteriors(lockedPriors);
      const staged: InsertPregameFeatureSnapshot[] = [];
      for (const f of args.features) { if (opts.failFeatureWrite) throw new Error("simulated DB failure mid-write"); if (!features.some((x) => x.featureRowId === f.featureRowId)) staged.push(f); }
      raw.set(args.raw.snapshotId, { ...args.raw, supersedesSnapshotId: supersedes, knownAtMs: inMs });
      for (const pr of args.provenanceRaws ?? []) { if (!raw.has(pr.snapshotId)) raw.set(pr.snapshotId, { ...pr, knownAtMs: new Date(pr.knownAt).getTime() }); }
      features.push(...staged);
      for (const p of posts) posteriors.set(`${p.entityCanonicalId}|${p.featureKey}|${p.featureVersion}`, p);
      return { decision: (supersedes === null ? "first_capture" : "appended") as const, snapshotId: args.raw.snapshotId, supersedes };
    }),
  };
  return { store, raw, features, posteriors };
}

const SCHED = (season: number) => `game_id,season,game_type,week,gameday,home_team,away_team\n` +
  `${season}_01_SF_KC,${season},REG,1,${season}-09-08,KC,SF\n${season}_01_BUF_MIA,${season},REG,1,${season}-09-08,MIA,BUF`;
const WH = "player_id,game_id,season,week,season_type,team,opponent_team,position,targets,receptions,receiving_yards,carries,rushing_yards";
const WEEKLY = (season: number, t1: number, t2: number) => `${WH}\n` +
  `00-0036355,${season}_01_SF_KC,${season},1,REG,SF,KC,WR,${t1},7,110,0,0\n` +
  `00-0000001,${season}_01_BUF_MIA,${season},1,REG,BUF,MIA,WR,${t2},5,70,0,0`;
const fetchAt = (csv: string, iso: string): CsvFetcher => async () => ({ ok: true, rawCsv: csv, fetchedAt: iso, sourcePublishedAt: null });
const failFetch = (): CsvFetcher => async () => ({ ok: false, reason: "transport_failure", failedAt: "2026-08-05T00:00:00Z" });
const at = (n: number) => `2026-08-05T18:00:0${n}.000Z`;
const params = { season: 2024, currentSeason: 2024, asOfDate: "2026-08-06T00:00:00Z" };
const deps = (m: ReturnType<typeof mockStore>, season: number, t1: number, t2: number, iso: string) => ({ store: m.store, fetchSchedule: fetchAt(SCHED(season), iso), fetchWeekly: fetchAt(WEEKLY(season, t1, t2), iso) });

// ── First ingest: 2 players; 3 raw captures; dual-source provenance ─────────
{
  const m = mockStore();
  const out = await ingestNflSeason(deps(m, 2024, 10, 8, at(1)), params);
  ok(out.status === "ingested", "first ingest → ingested");
  ok(out.playersUpdated === 2, "both players' posteriors from one file");
  ok(out.coverage?.counts.scheduleResolvedRows === 2 && out.coverage?.counts.rawCapturesPersisted === 3, "coverage: 2 resolved, 3 raw captures (weekly+schedule+join)");
  // Provenance: exactly weekly + schedule + join captured; join payload references both.
  const kinds = Array.from(m.raw.values()).map((r) => r.sourceKind).sort();
  ok(JSON.stringify(kinds) === JSON.stringify(["nfl_weekly_schedule_join", "nflverse_schedule", "nflverse_weekly_stats"]), "three source kinds captured");
  const join = Array.from(m.raw.values()).find((r) => r.sourceKind === "nfl_weekly_schedule_join")!;
  const weekly = Array.from(m.raw.values()).find((r) => r.sourceKind === "nflverse_weekly_stats")!;
  const schedule = Array.from(m.raw.values()).find((r) => r.sourceKind === "nflverse_schedule")!;
  const jp = join.payload as { weeklySnapshotId: string; scheduleSnapshotId: string };
  ok(jp.weeklySnapshotId === weekly.snapshotId && jp.scheduleSnapshotId === schedule.snapshotId, "join provenance references BOTH the weekly and schedule captures");
  ok(m.features.every((f) => f.sourceId === join.snapshotId), "feature sourceId = the join provenance snapshot (both inputs recoverable)");
  ok(weekly.sourceKind === "nflverse_weekly_stats" && String(weekly.payload).startsWith("player_id,game_id"), "weekly raw payload is verbatim CSV");
  ok(String(schedule.payload).startsWith("game_id,season"), "schedule raw payload is verbatim CSV");
}

// ── A→B→A recurrence on the weekly capture ──────────────────────────────────
{
  const m = mockStore();
  const a1 = await ingestNflSeason(deps(m, 2024, 10, 8, at(1)), params);
  const b = await ingestNflSeason(deps(m, 2024, 11, 8, at(2)), params);
  const a2 = await ingestNflSeason(deps(m, 2024, 10, 8, at(3)), params);
  ok(a1.status === "ingested" && b.status === "ingested" && a2.status === "ingested", "A→B→A three captures");
  const weeklies = Array.from(m.raw.values()).filter((r) => r.sourceKind === "nflverse_weekly_stats");
  ok(weeklies.length === 3 && a1.snapshotId !== a2.snapshotId, "three distinct weekly captures");
}

// ── No fabricated validAt: unresolved join → unresolvable, nothing persisted ─
{
  const m = mockStore();
  // Weekly references games the schedule (empty for this season's teams) can't resolve.
  const out = await ingestNflSeason({ store: m.store, fetchSchedule: fetchAt("game_id,season,game_type,week,gameday,home_team,away_team\n2024_05_XX_YY,2024,REG,5,2024-10-06,XX,YY", at(1)), fetchWeekly: fetchAt(WEEKLY(2024, 10, 8), at(1)) }, params);
  ok(out.status === "unresolvable" && m.raw.size === 0 && m.features.length === 0, "no schedule match → unresolvable, NOTHING persisted (no season-start fabrication)");
  ok(out.coverage?.coverage === "incomplete" && out.coverage?.counts.unresolvedGameIds === 2, "coverage incomplete with unresolved count");
}

// ── Out-of-order → stale; same-instant different content → conflict ─────────
{
  const m = mockStore();
  await ingestNflSeason(deps(m, 2024, 10, 8, at(1)), params);
  await ingestNflSeason(deps(m, 2024, 12, 8, at(3)), params);
  const stale = await ingestNflSeason(deps(m, 2024, 11, 8, at(2)), params);
  ok(stale.status === "stale_observation", "older-knownAt → stale");
  const conflict = await ingestNflSeason(deps(m, 2024, 99, 8, at(3)), params);
  ok(conflict.status === "conflicting_observation", "same knownAt + different content → conflict");
}

// ── CROSS-SEASON: concurrent 2024 + 2023 keep BOTH seasons (no lost update) ──
{
  const interleaveYield = async () => { await Promise.resolve(); await Promise.resolve(); };
  const m = mockStore({ interleaveYield });
  const a = ingestNflSeason(deps(m, 2024, 10, 8, at(1)), { ...params, season: 2024, currentSeason: 2024 });
  const b = ingestNflSeason(deps(m, 2023, 9, 7, at(1)), { ...params, season: 2023, currentSeason: 2024 });
  const [ra, rb] = await Promise.all([a, b]);
  ok(ra.status === "ingested" && rb.status === "ingested", "both season ingests complete");
  const p = m.posteriors.get("nfl:player:00-0036355|nfl.player.targets_per_game|nfl_nflverse_v1")!;
  const seasons = Object.keys(p.bySeason as Record<string, unknown>);
  ok(seasons.includes("2024") && seasons.includes("2023"), "shared player's posterior contains BOTH seasons (cross-season lock, no lost update)");
}

// ── Provider / parse failures write nothing ─────────────────────────────────
{
  const m1 = mockStore();
  ok((await ingestNflSeason({ store: m1.store, fetchSchedule: failFetch(), fetchWeekly: fetchAt(WEEKLY(2024, 10, 8), at(1)) }, params)).status === "provider_failure_schedule" && m1.raw.size === 0, "schedule failure → nothing written");
  const m2 = mockStore();
  ok((await ingestNflSeason({ store: m2.store, fetchSchedule: fetchAt(SCHED(2024), at(1)), fetchWeekly: failFetch() }, params)).status === "provider_failure" && m2.raw.size === 0, "weekly failure → nothing written");
  const m3 = mockStore();
  const mixed = await ingestNflSeason({ store: m3.store, fetchSchedule: fetchAt(SCHED(2024), at(1)), fetchWeekly: fetchAt(`${WH}\n00-0036355,2023_01_SF_PIT,2023,1,REG,SF,PIT,WR,9,6,90,0,0`, at(1)) }, params);
  ok(mixed.status === "incomplete" && m3.raw.size === 0, "mixed-season weekly → incomplete (adapter season_mismatch), nothing written");
}

// ── Atomic rollback + identity firewall ─────────────────────────────────────
{
  const m = mockStore({ failFeatureWrite: true });
  let threw = false;
  try { await ingestNflSeason(deps(m, 2024, 10, 8, at(1)), params); } catch { threw = true; }
  ok(threw && m.raw.size === 0 && m.posteriors.size === 0, "mid-write failure → no partial state");

  let fetched = 0;
  const spy: CsvFetcher = async () => { fetched++; return { ok: true, rawCsv: SCHED(2024), fetchedAt: at(1), sourcePublishedAt: null }; };
  const throwsBefore = async (p: typeof params, label: string) => {
    fetched = 0; let kind: string | null = null;
    try { await ingestNflSeason({ store: mockStore().store, fetchSchedule: spy, fetchWeekly: spy }, p); } catch (e) { if (e instanceof NflIngestInvocationError) kind = e.kind; }
    ok(kind !== null && fetched === 0, label);
  };
  await throwsBefore({ ...params, season: 0 }, "invalid season rejected before fetch");
  await throwsBefore({ ...params, asOfDate: "nope" }, "invalid asOfDate rejected before fetch");
  ok(NFL_POSTERIOR_LOCK_KEY === "nfl|pregame_dataset_ingest|nfl_nflverse_v1", "stable cross-season posterior lock key");
  const plan = buildValidatedNflRequest(params);
  ok(plan.semanticSourceKey.includes("kind=nflverse_weekly_stats") && plan.semanticSourceKey.includes("season=2024"), "weekly semantic key");
}

console.log(`\nnflIngestionJob.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
