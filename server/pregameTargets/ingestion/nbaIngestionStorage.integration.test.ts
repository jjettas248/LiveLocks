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
  const { eq, like, or } = await import("drizzle-orm");
  const { ensurePregameTargetsFoundationSchema } = await import("../../dbMigrations/pregameTargetsFoundationPersistence");
  const { ensurePregameTargetsRawProvenanceColumns } = await import("../../dbMigrations/pregameTargetsRawProvenancePersistence");
  const { buildStorePort } = await import("../../scripts/nbaPregameBackfill");
  const { ingestPlayerSeason } = await import("./nbaIngestionJob");
  const { buildNbaFeatureRows } = await import("./nbaFeatureBuilder");
  const { buildRawSnapshotIdentity } = await import("./rawSnapshotIdentity");

  await ensurePregameTargetsFoundationSchema({ query: (s: string) => pool.query(s) } as never);
  await ensurePregameTargetsRawProvenanceColumns({ query: (s: string) => pool.query(s) } as never);

  const ENTITY = "nba:player:itest_pr5_777";
  // All test artifacts are scoped by the "itest_pr5" marker (entity id / source key)
  // so cleanup never touches real rows even on a shared disposable database.
  const cleanup = async () => {
    await db.delete(pregameFeatureSnapshots).where(like(pregameFeatureSnapshots.entityCanonicalId, "%itest_pr5%"));
    await db.delete(pregamePosteriorStates).where(like(pregamePosteriorStates.entityCanonicalId, "%itest_pr5%"));
    await db.delete(pregameRawSourceSnapshots).where(
      or(like(pregameRawSourceSnapshots.sourceKey, "%itest_pr5%"), eq(pregameRawSourceSnapshots.sport, "nba_itest_pr5")),
    );
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

  // ── (4) Timestamp-policy metadata survives a DB round trip ──────────────────
  const CH_PLAYER = "itest_pr5_chain";
  const CH_ENTITY = "nba:player:itest_pr5_chain";
  const chParams = { playerNativeId: CH_PLAYER, seasonType: "Regular Season" as const, currentSeason: 2026, asOfDate: "2026-08-06T00:00:00Z", season: 2026, seasonLabel: "2025-26" };
  {
    const out = await ingestPlayerSeason({ store: port, fetch: fetcherOf(raw("0022500910", "2026-01-15", 30)) }, chParams);
    const row = await storage.getPregameRawSourceSnapshot(out.snapshotId!);
    ok(row !== null && row!.knownAtPolicyVersion === "nba_gamelog_knownAt_v1", "knownAtPolicyVersion survives the DB round trip");
    ok(row !== null && row!.sourcePublishedAt === null, "sourcePublishedAt = null remains explicitly unknown after round trip");
    ok(row !== null && row!.createdAt != null, "immutable ingestion instant (created_at) present");
    ok(row !== null && (row!.supersedesSnapshotId ?? null) === null, "first capture has no predecessor");
    // Feature sourceId resolves back to this immutable raw snapshot + its policy version.
    const feats = await db.select().from(pregameFeatureSnapshots).where(eq(pregameFeatureSnapshots.entityCanonicalId, CH_ENTITY));
    ok(feats.length > 0 && feats.every((f) => f.sourceId === out.snapshotId), "feature sourceId resolves to the correct immutable raw snapshot");
  }

  // ── (5) Correction chain A←B←C is deterministic + serialized ────────────────
  {
    const a = await ingestPlayerSeason({ store: port, fetch: fetcherOf(raw("0022500910", "2026-01-15", 30)) }, chParams); // == (4)'s content → no-op
    ok(a.status === "noop_identical", "re-ingesting identical content is a no-op (no lineage change)");
    const firstId = a.snapshotId!;
    const b = await ingestPlayerSeason({ store: port, fetch: fetcherOf(raw("0022500910", "2026-01-15", 31)) }, chParams); // correction B
    const between = new Date();
    await new Promise((r) => setTimeout(r, 5));
    const c = await ingestPlayerSeason({ store: port, fetch: fetcherOf(raw("0022500910", "2026-01-15", 33)) }, chParams); // correction C
    const rowB = await storage.getPregameRawSourceSnapshot(b.snapshotId!);
    const rowC = await storage.getPregameRawSourceSnapshot(c.snapshotId!);
    ok(rowB!.supersedesSnapshotId === firstId, "correction B supersedes A");
    ok(rowC!.supersedesSnapshotId === b.snapshotId, "correction C supersedes B (deterministic chain)");
    const rowA = await storage.getPregameRawSourceSnapshot(firstId);
    ok((rowA!.supersedesSnapshotId ?? null) === null, "prior snapshot A never repointed by a later correction");

    // Replay: as-of BETWEEN B and C sees B's value; as-of NOW sees C's value.
    const asB = await storage.getPregameFeatureAsOf({ sport: "nba", entityCanonicalId: CH_ENTITY, featureKey: "nba.player.points_per_min", featureVersion: "nba_gamelog_v1", predictionAt: between });
    const asNow = await storage.getPregameFeatureAsOf({ sport: "nba", entityCanonicalId: CH_ENTITY, featureKey: "nba.player.points_per_min", featureVersion: "nba_gamelog_v1", predictionAt: new Date() });
    ok(asB !== null && Math.abs(Number(asB!.value) - 31 / 34) < 1e-9, "replay before C sees correction B (31/34)");
    ok(asNow !== null && Math.abs(Number(asNow!.value) - 33 / 34) < 1e-9, "replay after C sees correction C (33/34)");
  }

  // ── (6) Concurrent corrections serialize into one deterministic chain ───────
  {
    const CC_PLAYER = "itest_pr5_ccorr", CC_ENTITY = "nba:player:itest_pr5_ccorr";
    const ccParams = { playerNativeId: CC_PLAYER, seasonType: "Regular Season" as const, currentSeason: 2026, asOfDate: "2026-08-06T00:00:00Z", season: 2026, seasonLabel: "2025-26" };
    await ingestPlayerSeason({ store: port, fetch: fetcherOf(raw("0022500999", "2026-03-01", 20)) }, ccParams); // base
    const x = ingestPlayerSeason({ store: port, fetch: fetcherOf(raw("0022500999", "2026-03-01", 21)) }, ccParams);
    const y = ingestPlayerSeason({ store: port, fetch: fetcherOf(raw("0022500999", "2026-03-01", 22)) }, ccParams);
    await Promise.all([x, y]);
    const rows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.entityCanonicalId, CC_ENTITY));
    // Exactly one chain: no two snapshots share a predecessor (a fork would mean a lost update).
    const preds = rows.map((r) => r.supersedesSnapshotId).filter((p): p is string => p != null);
    ok(new Set(preds).size === preds.length, "concurrent corrections form a single linear chain (no shared predecessor / fork)");
    void CC_ENTITY;
  }

  void CH_ENTITY;
  await cleanup();
  await pool.end();
  console.log(`\nnbaIngestionStorage.integration.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error("integration harness error:", err instanceof Error ? err.message : err); process.exit(1); });
