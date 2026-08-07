// Run: npx tsx server/pregameTargets/ingestion/nfl/nflIngestionJob.test.ts
// PR6 — NFL ingestion job (mock dataset store): one weekly file → MANY players' posteriors
// (multi-entity fold, no lost update across players); head-by-knownAt observation chain
// (A→B→A recurrence, true idempotency, stale, conflict); identity firewall; provider/parse
// failures write nothing.
import { ingestNflSeason, buildValidatedNflRequest, NflIngestInvocationError, type NflIngestionStorePort, type CsvFetcher, type DatasetAtomicIngestArgs } from "./nflIngestionJob";
import type { InsertPregameRawSourceSnapshot, InsertPregameFeatureSnapshot, InsertPregamePosteriorState } from "../../../../shared/schema";
import type { PosteriorState } from "../../posteriorState/posteriorState";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

type StoredRaw = InsertPregameRawSourceSnapshot & { knownAtMs: number };

function mockStore(opts: { failFeatureWrite?: boolean } = {}) {
  const raw = new Map<string, StoredRaw>();
  const features: InsertPregameFeatureSnapshot[] = [];
  const posteriors = new Map<string, InsertPregamePosteriorState>();
  const store: NflIngestionStorePort = {
    ingestDatasetSnapshotAtomic: async (args: DatasetAtomicIngestArgs) => {
      // HEAD by knownAt for this semantic identity.
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
      // Multi-entity priors keyed `${entity}|${featureKey}`.
      const lockedPriors = new Map<string, PosteriorState>();
      for (const e of args.entityCanonicalIds) for (const fk of args.featureKeys) {
        const r = posteriors.get(`${e}|${fk}|${args.featureVersion}`);
        if (r) lockedPriors.set(`${e}|${fk}`, { version: r.stateVersion, featureKey: fk, featureVersion: args.featureVersion, entityCanonicalId: e, bySeason: r.bySeason as PosteriorState["bySeason"] });
      }
      const posts = args.foldPosteriors(lockedPriors);
      const staged: InsertPregameFeatureSnapshot[] = [];
      for (const f of args.features) { if (opts.failFeatureWrite) throw new Error("simulated DB failure mid-write"); if (!features.some((x) => x.featureRowId === f.featureRowId)) staged.push(f); }
      raw.set(args.raw.snapshotId, { ...args.raw, supersedesSnapshotId: supersedes, knownAtMs: inMs });
      features.push(...staged);
      for (const p of posts) posteriors.set(`${p.entityCanonicalId}|${p.featureKey}|${p.featureVersion}`, p);
      return { decision: (supersedes === null ? "first_capture" : "appended") as const, snapshotId: args.raw.snapshotId, supersedes };
    },
  };
  return { store, raw, features, posteriors };
}

const SCHED = "game_id,season,week,gameday,home_team,away_team\n" +
  "2024_01_SF_KC,2024,1,2024-09-08,KC,SF\n2024_01_BUF_MIA,2024,1,2024-09-08,MIA,BUF";
const WH = "player_id,season,week,recent_team,team,position,targets,receptions,receiving_yards,carries,rushing_yards";
const weekly = (t1: number, t2: number) => `${WH}\n` +
  `00-0036355,2024,1,SF,SF,WR,${t1},7,110,0,0\n` +   // player A on SF
  `00-0000001,2024,1,BUF,BUF,WR,${t2},5,70,0,0`;      // player B on BUF
const fetchAt = (csv: string, iso: string): CsvFetcher => async () => ({ ok: true, rawCsv: csv, fetchedAt: iso, sourcePublishedAt: null });
const failFetch = (): CsvFetcher => async () => ({ ok: false, reason: "transport_failure", failedAt: "2026-08-05T00:00:00Z" });
const at = (n: number) => `2026-08-05T18:00:0${n}.000Z`;
const params = { season: 2024, currentSeason: 2024, asOfDate: "2026-08-06T00:00:00Z" };
const deps = (m: ReturnType<typeof mockStore>, wCsv: string, iso: string) => ({ store: m.store, fetchSchedule: fetchAt(SCHED, iso), fetchWeekly: fetchAt(wCsv, iso) });

// ── First ingest: one file → BOTH players' features + posteriors ────────────
{
  const m = mockStore();
  const out = await ingestNflSeason(deps(m, weekly(10, 8), at(1)), params);
  ok(out.status === "ingested", "first ingest → ingested");
  ok(m.raw.size === 1, "one immutable dataset capture");
  ok(out.playersUpdated === 2, "BOTH players' posteriors updated from one file (multi-entity fold)");
  ok(m.posteriors.has("nfl:player:00-0036355|nfl.player.targets_per_game|nfl_nflverse_v1"), "player A posterior written");
  ok(m.posteriors.has("nfl:player:00-0000001|nfl.player.targets_per_game|nfl_nflverse_v1"), "player B posterior written");
  const pa = m.posteriors.get("nfl:player:00-0036355|nfl.player.targets_per_game|nfl_nflverse_v1")!;
  const g = (pa.bySeason as Record<number, { byGame: Record<string, { wx: number; w: number }> }>)[2024].byGame;
  ok(Math.abs(g[Object.keys(g)[0]].wx / g[Object.keys(g)[0]].w - 10) < 1e-9, "player A targets_per_game = 10 (per-game value)");
}

// ── TRUE idempotency: same content later instant → no-op ────────────────────
{
  const m = mockStore();
  await ingestNflSeason(deps(m, weekly(10, 8), at(1)), params);
  const out2 = await ingestNflSeason(deps(m, weekly(10, 8), at(2)), params);
  ok(out2.status === "noop_identical" && m.raw.size === 1, "same content, later instant → no-op (one capture)");
}

// ── A→B→A recurrence: return to earlier content is a NEW capture ────────────
{
  const m = mockStore();
  const a1 = await ingestNflSeason(deps(m, weekly(10, 8), at(1)), params);
  const b = await ingestNflSeason(deps(m, weekly(11, 8), at(2)), params);
  const a2 = await ingestNflSeason(deps(m, weekly(10, 8), at(3)), params);
  ok(a1.status === "ingested" && b.status === "ingested" && a2.status === "ingested", "three accepted captures (A→B→A)");
  ok(m.raw.size === 3 && a1.snapshotId !== a2.snapshotId, "A1 and A2 distinct captures");
  ok(m.raw.get(b.snapshotId!)!.supersedesSnapshotId === a1.snapshotId && m.raw.get(a2.snapshotId!)!.supersedesSnapshotId === b.snapshotId, "chain A1←B←A2");
}

// ── Out-of-order → stale; same-instant different content → conflict ─────────
{
  const m = mockStore();
  await ingestNflSeason(deps(m, weekly(10, 8), at(1)), params);
  await ingestNflSeason(deps(m, weekly(12, 8), at(3)), params); // head
  const stale = await ingestNflSeason(deps(m, weekly(11, 8), at(2)), params);
  ok(stale.status === "stale_observation" && m.raw.size === 2, "older-knownAt arrival → stale (wrote nothing)");
  const conflict = await ingestNflSeason(deps(m, weekly(99, 8), at(3)), params); // same instant as head, diff content
  ok(conflict.status === "conflicting_observation", "same knownAt + different content → conflict");
}

// ── Provider / parse failures write nothing ─────────────────────────────────
{
  const m1 = mockStore();
  const schedFail = await ingestNflSeason({ store: m1.store, fetchSchedule: failFetch(), fetchWeekly: fetchAt(weekly(10, 8), at(1)) }, params);
  ok(schedFail.status === "provider_failure_schedule" && m1.raw.size === 0, "schedule transport failure → provider_failure_schedule, nothing written");
  const m2 = mockStore();
  const wkFail = await ingestNflSeason({ store: m2.store, fetchSchedule: fetchAt(SCHED, at(1)), fetchWeekly: failFetch() }, params);
  ok(wkFail.status === "provider_failure" && m2.raw.size === 0, "weekly transport failure → provider_failure");
  const m3 = mockStore();
  const wkBad = await ingestNflSeason({ store: m3.store, fetchSchedule: fetchAt(SCHED, at(1)), fetchWeekly: fetchAt("player_id,season\n,2024", at(1)) }, params);
  ok(wkBad.status === "incomplete" && m3.raw.size === 0 && wkBad.coverage?.coverage === "incomplete", "malformed weekly → incomplete, coverage incomplete");
}

// ── Atomic rollback: mid-write failure → nothing written ────────────────────
{
  const m = mockStore({ failFeatureWrite: true });
  let threw = false;
  try { await ingestNflSeason(deps(m, weekly(10, 8), at(1)), params); } catch { threw = true; }
  ok(threw && m.raw.size === 0 && m.features.length === 0 && m.posteriors.size === 0, "mid-write failure propagates, no partial state");
}

// ── Identity firewall: invalid invocation throws BEFORE any fetch ───────────
{
  let fetched = 0;
  const spy: CsvFetcher = async () => { fetched++; return { ok: true, rawCsv: SCHED, fetchedAt: at(1), sourcePublishedAt: null }; };
  const expectThrow = async (p: typeof params, label: string) => {
    fetched = 0; let kind: string | null = null;
    try { await ingestNflSeason({ store: mockStore().store, fetchSchedule: spy, fetchWeekly: spy }, p); } catch (e) { if (e instanceof NflIngestInvocationError) kind = e.kind; }
    ok(kind !== null && fetched === 0, label);
  };
  await expectThrow({ ...params, season: 0 }, "invalid season rejected before fetch");
  await expectThrow({ ...params, currentSeason: NaN }, "invalid currentSeason rejected before fetch");
  await expectThrow({ ...params, asOfDate: "not-a-date" }, "invalid asOfDate rejected before fetch");
  const plan = buildValidatedNflRequest(params);
  ok(plan.semanticSourceKey.includes("sport=nfl") && plan.semanticSourceKey.includes("season=2024") && plan.semanticSourceKey.includes("kind=nflverse_weekly_stats"), "semantic key encodes sport/kind/season");
}

console.log(`\nnflIngestionJob.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
