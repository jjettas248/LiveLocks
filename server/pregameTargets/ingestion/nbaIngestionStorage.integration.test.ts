// NBA ingestion storage — REAL database invariants (Pregame Targets PR5).
// Exercises storage.ts's ACTUAL ingestPregameNbaSnapshotAtomic transaction against
// a live Postgres connection — no monkey-patching. Proves what the mock-port unit
// test cannot: genuine all-or-nothing rollback, content-identity idempotency, and
// that two concurrent same-player season ingests do NOT lose a posterior update
// (the per-entity advisory lock + in-transaction read/fold/write).
//
// Run: DATABASE_URL=postgresql://... npx tsx server/pregameTargets/ingestion/nbaIngestionStorage.integration.test.ts
//
// CLASSIFICATION: when DATABASE_URL is absent this suite is EXCLUDED_ENV (it prints
// that token and exits 0) — it is NOT a silent pass and NOT a failure. Point it at a
// disposable database (never production) with the PR1 foundation schema present.

import type { GameLogFetcher } from "./nbaIngestionJob"; // type-only (erased) — no runtime DB import

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

async function run(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("EXCLUDED_ENV: nbaIngestionStorage.integration.test — no DATABASE_URL (real-DB atomicity/concurrency not exercised here).");
    process.exit(0);
  }

  // Deferred imports: only reached when a DB is actually configured.
  const { storage } = await import("../../storage");
  const { db, pool } = await import("../../db");
  const { pregameRawSourceSnapshots, pregameFeatureSnapshots, pregamePosteriorStates } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const { ensurePregameTargetsFoundationSchema } = await import("../../dbMigrations/pregameTargetsFoundationPersistence");
  const { buildStorePort } = await import("../../scripts/nbaPregameBackfill");
  const { ingestPlayerSeason } = await import("./nbaIngestionJob");
  const { buildNbaFeatureRows } = await import("./nbaFeatureBuilder");
  const { buildRawSnapshotIdentity } = await import("./rawSnapshotIdentity");

  await ensurePregameTargetsFoundationSchema({ query: (s: string) => pool.query(s) } as never);

  const ENTITY = "nba:player:itest_pr5_777";
  const cleanup = async () => {
    await db.delete(pregameFeatureSnapshots).where(eq(pregameFeatureSnapshots.entityCanonicalId, ENTITY));
    await db.delete(pregamePosteriorStates).where(eq(pregamePosteriorStates.entityCanonicalId, ENTITY));
    await db.delete(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.sport, "nba_itest_pr5"));
  };
  await cleanup();

  const H = ["GAME_ID", "GAME_DATE", "MATCHUP", "MIN", "PTS", "REB", "AST", "FG3M"];
  const raw = (gid: string, date: string, pts: number) => ({ resultSets: [{ headers: H, rowSet: [[gid, date, "DEN vs. LAL", 34, pts, 8, 6, 3]] }] });

  // ── (1) A failure AFTER the raw insert rolls back raw + features + posteriors ─
  {
    const payload = raw("0022400900", "2025-01-15", 30);
    const identity = buildRawSnapshotIdentity("nba_stats_playergamelog", "itest|sk|1", payload);
    const built = buildNbaFeatureRows({ season: 2025, playerNativeId: "itest_pr5_777", sourceId: identity.snapshotId, records: [] });
    let threw = false;
    try {
      await storage.ingestPregameNbaSnapshotAtomic({
        entityCanonicalId: ENTITY,
        featureVersion: "nba_gamelog_v1",
        featureKeys: ["nba.player.points_per_min"],
        raw: { snapshotId: identity.snapshotId, sport: "nba_itest_pr5", sourceKind: "nba_stats_playergamelog", sourceKey: "itest|sk|1", validAt: new Date("2025-01-15T00:00:00Z"), knownAt: new Date(), payload: payload as never, contentHash: identity.contentHash },
        features: built.rows.map((r) => ({ featureRowId: `itest_${r.featureKey}`, sport: "nba", entityCanonicalId: ENTITY, entityKind: "player", featureKey: r.featureKey, featureVersion: r.featureVersion, season: 2025, validAt: new Date(r.validAt), knownAt: new Date(r.knownAt), state: r.state, value: r.value === null ? null : String(r.value), sourceId: identity.snapshotId, derivedFromGameIds: null })),
        foldPosteriors: () => { throw new Error("injected failure after raw insert"); },
      });
    } catch { threw = true; }
    ok(threw, "injected post-raw-insert failure propagates");
    const rawRows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.snapshotId, identity.snapshotId));
    ok(rawRows.length === 0, "atomic rollback: the raw snapshot was NOT committed");
  }

  const port = buildStorePort(storage as never);
  const fetcherOf = (p: unknown): GameLogFetcher => async () => ({ ok: true, rawPayload: p, fetchedAt: new Date().toISOString() });
  const baseParams = { playerNativeId: "itest_pr5_777", seasonType: "Regular Season", currentSeason: 2026, asOfDate: "2026-08-06T00:00:00Z" };

  // ── (2) Identical rerun is a no-op ──────────────────────────────────────────
  {
    const first = await ingestPlayerSeason({ store: port, fetch: fetcherOf(raw("0022500500", "2026-01-15", 30)) }, { ...baseParams, season: 2026, seasonLabel: "2025-26" });
    const again = await ingestPlayerSeason({ store: port, fetch: fetcherOf(raw("0022500500", "2026-01-15", 30)) }, { ...baseParams, season: 2026, seasonLabel: "2025-26" });
    ok(first.status === "ingested", "first real ingest → ingested");
    ok(again.status === "noop_identical", "identical rerun → noop_identical (content-identity idempotent)");
  }

  // ── (3) Concurrent season ingests do not lose posterior state ───────────────
  {
    const a = ingestPlayerSeason({ store: port, fetch: fetcherOf(raw("0022500600", "2026-02-01", 28)) }, { ...baseParams, season: 2026, seasonLabel: "2025-26" });
    const b = ingestPlayerSeason({ store: port, fetch: fetcherOf(raw("0022400700", "2025-02-01", 22)) }, { ...baseParams, season: 2025, seasonLabel: "2024-25" });
    await Promise.all([a, b]);
    const rows = await db.select().from(pregamePosteriorStates).where(eq(pregamePosteriorStates.entityCanonicalId, ENTITY));
    const pts = rows.find((r) => r.featureKey === "nba.player.points_per_min");
    const seasons = pts ? Object.keys((pts.bySeason ?? {}) as Record<string, unknown>) : [];
    ok(seasons.includes("2026") && seasons.includes("2025"), "concurrent ingests: final posterior contains BOTH seasons (advisory lock prevented lost update)");
  }

  await cleanup();
  await pool.end();
  console.log(`\nnbaIngestionStorage.integration.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error("integration harness error:", err instanceof Error ? err.message : err); process.exit(1); });
