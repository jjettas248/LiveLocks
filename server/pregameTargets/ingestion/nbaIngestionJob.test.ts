// Run: npx tsx server/pregameTargets/ingestion/nbaIngestionJob.test.ts
// Pregame Targets PR5 — ingestion job (mock ports): identical rerun is a no-op,
// genuine correction creates a NEW immutable snapshot + posterior correction,
// provider failure / incomplete response writes NOTHING and fabricates nothing.
import { ingestPlayerSeason, type IngestionStorePort, type GameLogFetcher } from "./nbaIngestionJob";
import type { InsertPregameRawSourceSnapshot, InsertPregameFeatureSnapshot, InsertPregamePosteriorState } from "../../../shared/schema";
import type { PosteriorState } from "../posteriorState/posteriorState";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

function mockStore(opts: { failFeatureWrite?: boolean } = {}) {
  const raw = new Map<string, InsertPregameRawSourceSnapshot>();
  const features: InsertPregameFeatureSnapshot[] = [];
  const posteriors = new Map<string, InsertPregamePosteriorState>();
  const pk = (e: string, f: string, v: string) => `${e}|${f}|${v}`;
  const store: IngestionStorePort = {
    getRawSnapshotById: async (id) => (raw.has(id) ? { snapshotId: id } : null),
    getPosterior: async (e, f, v) => {
      const r = posteriors.get(pk(e, f, v));
      if (!r) return null;
      return { version: r.stateVersion, featureKey: f, featureVersion: v, entityCanonicalId: e, bySeason: r.bySeason as PosteriorState["bySeason"] };
    },
    // ALL-OR-NOTHING: stage into locals, then commit only if nothing threw. The
    // content-identity gate returns inserted:false when the raw already exists.
    ingestSnapshotAtomic: async ({ raw: rawRow, features: feats, posteriors: posts }) => {
      if (raw.has(rawRow.snapshotId)) return { inserted: false };
      const stagedFeatures: InsertPregameFeatureSnapshot[] = [];
      for (const f of feats) {
        if (opts.failFeatureWrite) throw new Error("simulated DB failure mid-write");
        if (!features.some((x) => x.featureRowId === f.featureRowId)) stagedFeatures.push(f);
      }
      raw.set(rawRow.snapshotId, rawRow);
      features.push(...stagedFeatures);
      for (const p of posts) posteriors.set(pk(p.entityCanonicalId, p.featureKey, p.featureVersion), p);
      return { inserted: true };
    },
  };
  return { store, raw, features, posteriors };
}

const HEADERS = ["GAME_ID", "GAME_DATE", "MATCHUP", "MIN", "PTS", "REB", "AST", "FG3M"];
const payload = (pts: number) => ({ resultSets: [{ headers: HEADERS, rowSet: [["0022300500", "2024-01-15", "DEN vs. LAL", 34, pts, 8, 6, 3]] }] });
const fetcherOf = (p: unknown | null): GameLogFetcher => async () => (p === null ? null : { rawPayload: p, fetchedAt: "2026-08-05T18:00:00Z" });
const params = { playerNativeId: "201939", season: 2024, seasonType: "Regular Season", currentSeason: 2026, asOfDate: "2026-08-06T00:00:00Z" };

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
  // The points_per_min posterior for the game reflects the corrected value (same game → correction).
  const p = m.posteriors.get("nba:player:201939|nba.player.points_per_min|nba_gamelog_v1")!;
  const byGame = (p.bySeason as Record<number, { byGame: Record<string, { wx: number; w: number }> }>)[2024].byGame;
  const gameKey = Object.keys(byGame)[0];
  ok(Object.keys(byGame).length === 1, "single lineage entry after correction (not double-counted)");
  ok(Math.abs(byGame[gameKey].wx / byGame[gameKey].w - 31 / 34) < 1e-9, "posterior reflects the CORRECTED per-min value");
}

// ── Provider failure (null fetch) → NO writes, no fabrication ────────────────
{
  const m = mockStore();
  const out = await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(null) }, params);
  ok(out.status === "provider_failure", "null fetch → provider_failure");
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

// ── Incremental posterior accumulation across seasons ───────────────────────
{
  const m = mockStore();
  await ingestPlayerSeason({ store: m.store, fetch: fetcherOf(payload(30)) }, { ...params, season: 2026 });
  await ingestPlayerSeason({ store: m.store, fetch: fetcherOf({ resultSets: [{ headers: HEADERS, rowSet: [["0022400111", "2025-01-10", "DEN vs. LAL", 30, 24, 6, 5, 2]] }] }) }, { ...params, season: 2025 });
  const p = m.posteriors.get("nba:player:201939|nba.player.points_per_min|nba_gamelog_v1")!;
  const seasons = Object.keys(p.bySeason as Record<string, unknown>);
  ok(seasons.includes("2026") && seasons.includes("2025"), "posterior accumulates across separate season ingests");
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

console.log(`\nnbaIngestionJob.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
