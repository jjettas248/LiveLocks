// NBA ingestion storage — REAL database invariants (Pregame Targets PR5, audit-4).
// Exercises storage.ts's ACTUAL ingestPregameNbaSnapshotAtomic transaction against a
// live Postgres connection — no monkey-patching. Proves what the mock-port unit test
// cannot: genuine all-or-nothing rollback; head selection by OBSERVATION chronology
// (known_at), not insertion order; A→B→A recurrence as distinct captures; consecutive
// identical content as a no-op; out-of-order arrival failing closed without inverting
// the chain; the semantic key surviving a round trip; and feature source_id resolving
// to the exact capture.
//
// Run: DATABASE_URL=postgresql://... npx tsx server/pregameTargets/ingestion/nbaIngestionStorage.integration.test.ts
//
// CLASSIFICATION: without DATABASE_URL this suite is EXCLUDED_ENV (prints that token,
// exits 0) — not a silent pass, not a failure. Point it at a disposable database.

import type { GameLogFetcher } from "./nbaIngestionJob"; // type-only (erased) — no runtime DB import

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

async function run(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("EXCLUDED_ENV: nbaIngestionStorage.integration.test — no DATABASE_URL (real-DB atomicity/concurrency/recurrence not exercised here).");
    process.exit(0);
  }

  const { storage } = await import("../../storage");
  const { db, pool } = await import("../../db");
  const { pregameRawSourceSnapshots, pregameFeatureSnapshots, pregamePosteriorStates } = await import("@shared/schema");
  const { eq, like, or } = await import("drizzle-orm");
  const { ensurePregameTargetsFoundationSchema } = await import("../../dbMigrations/pregameTargetsFoundationPersistence");
  const { ensurePregameTargetsRawProvenanceColumns } = await import("../../dbMigrations/pregameTargetsRawProvenancePersistence");
  const { buildStorePort } = await import("../../scripts/nbaPregameBackfill");
  const { ingestPlayerSeason } = await import("./nbaIngestionJob");
  const { buildNbaFeatureRows } = await import("./nbaFeatureBuilder");
  const { buildCaptureSnapshotIdentity, computeContentHash } = await import("./rawSnapshotIdentity");
  const { buildNbaGameLogSourceKey } = await import("./nbaSourceContracts");

  await ensurePregameTargetsFoundationSchema({ query: (s: string) => pool.query(s) } as never);
  await ensurePregameTargetsRawProvenanceColumns({ query: (s: string) => pool.query(s) } as never);

  // All artifacts scoped by the "itest_pr5" marker so cleanup never touches real rows.
  const cleanup = async () => {
    await db.delete(pregameFeatureSnapshots).where(like(pregameFeatureSnapshots.entityCanonicalId, "%itest_pr5%"));
    await db.delete(pregamePosteriorStates).where(like(pregamePosteriorStates.entityCanonicalId, "%itest_pr5%"));
    await db.delete(pregameRawSourceSnapshots).where(
      or(like(pregameRawSourceSnapshots.semanticSourceKey, "%itest_pr5%"), like(pregameRawSourceSnapshots.sourceKey, "%itest_pr5%"), eq(pregameRawSourceSnapshots.sport, "nba_itest_pr5")),
    );
  };
  await cleanup();

  const port = buildStorePort(storage as never);
  const H = ["GAME_ID", "GAME_DATE", "MATCHUP", "MIN", "PTS", "REB", "AST", "FG3M"];
  const raw = (gid: string, date: string, pts: number) => ({ resultSets: [{ headers: H, rowSet: [[gid, date, "DEN vs. LAL", 34, pts, 8, 6, 3]] }] });
  const fetchAt = (p: unknown, iso: string): GameLogFetcher => async () => ({ ok: true, rawPayload: p, fetchedAt: iso });

  // ── (1) A failure AFTER capture prep but before commit rolls everything back ─
  {
    const ENTITY = "nba:player:itest_pr5_rb";
    const semanticSourceKey = buildNbaGameLogSourceKey({ sourceKind: "nba_stats_playergamelog", entityCanonicalId: ENTITY, season: 2025, seasonType: "Regular Season" });
    const payload = raw("0022400900", "2025-01-15", 30);
    const obs = "2025-02-01T00:00:00.000Z";
    const identity = buildCaptureSnapshotIdentity({ sourceKind: "nba_stats_playergamelog", semanticSourceKey, observationInstant: obs, payload });
    const built = buildNbaFeatureRows({ season: 2025, playerNativeId: "itest_pr5_rb", sourceId: identity.snapshotId, records: [] });
    let threw = false;
    try {
      await storage.ingestPregameNbaSnapshotAtomic({
        entityCanonicalId: ENTITY,
        featureVersion: "nba_gamelog_v1",
        featureKeys: ["nba.player.points_per_min"],
        semanticSourceKey,
        incomingKnownAt: new Date(obs),
        incomingContentHash: identity.contentHash,
        raw: { snapshotId: identity.snapshotId, sport: "nba_itest_pr5", sourceKind: "nba_stats_playergamelog", sourceKey: identity.captureKey, semanticSourceKey, validAt: new Date("2025-01-15T00:00:00Z"), knownAt: new Date(obs), payload: payload as never, contentHash: identity.contentHash },
        features: built.rows.map((r) => ({ featureRowId: `itest_pr5_${r.featureKey}`, sport: "nba", entityCanonicalId: ENTITY, entityKind: "player", featureKey: r.featureKey, featureVersion: r.featureVersion, season: 2025, validAt: new Date(r.validAt), knownAt: new Date(r.knownAt), state: r.state, value: r.value === null ? null : String(r.value), sourceId: identity.snapshotId, derivedFromGameIds: null })),
        foldPosteriors: () => { throw new Error("injected failure after capture prep"); },
      });
    } catch { threw = true; }
    ok(threw, "injected post-capture-prep failure propagates");
    const rows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.snapshotId, identity.snapshotId));
    ok(rows.length === 0, "atomic rollback: no raw capture committed");
    const fr = await db.select().from(pregameFeatureSnapshots).where(eq(pregameFeatureSnapshots.entityCanonicalId, ENTITY));
    ok(fr.length === 0, "atomic rollback: no feature rows, no posterior mutation");
  }

  const CH = "itest_pr5_chain", CH_ENTITY = "nba:player:itest_pr5_chain";
  const chParams = { playerNativeId: CH, seasonType: "Regular Season" as const, currentSeason: 2026, asOfDate: "2026-08-06T00:00:00Z", season: 2026, seasonLabel: "2025-26" };
  const t1 = "2026-01-10T00:00:00.000Z", t2 = "2026-01-11T00:00:00.000Z", t3 = "2026-01-12T00:00:00.000Z";

  // ── (2) A→B→A recurrence + metadata round trip + replay chronology ──────────
  {
    const a1 = await ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022500910", "2026-01-05", 30), t1) }, chParams); // A
    const b = await ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022500910", "2026-01-05", 31), t2) }, chParams);  // B
    const a2 = await ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022500910", "2026-01-05", 30), t3) }, chParams); // A again
    ok(a1.status === "ingested" && b.status === "ingested" && a2.status === "ingested", "A→B→A: three accepted captures");
    const rowA1 = (await storage.getPregameRawSourceSnapshot(a1.snapshotId!))!;
    const rowB = (await storage.getPregameRawSourceSnapshot(b.snapshotId!))!;
    const rowA2 = (await storage.getPregameRawSourceSnapshot(a2.snapshotId!))!;
    ok(a1.snapshotId !== a2.snapshotId, "A1 and A2 have different capture IDs");
    ok(rowA1.contentHash === rowA2.contentHash, "A1 and A2 share the same contentHash");
    ok(rowB.supersedesSnapshotId === a1.snapshotId && rowA2.supersedesSnapshotId === b.snapshotId, "chain A1←B←A2 by observation chronology");
    ok(rowA1.semanticSourceKey === rowA2.semanticSourceKey && rowA1.semanticSourceKey!.includes("itest_pr5"), "semantic source key survives round trip and is stable across observations");
    ok(rowA1.sourceKey !== rowA2.sourceKey, "capture-specific source_key differs across A→B→A");
    ok(rowA1.knownAtPolicyVersion === "nba_gamelog_knownAt_v1" && rowA1.sourcePublishedAt === null, "timestamp-policy metadata round trips (sourcePublishedAt null explicit)");
    // Replay: before t2 → A(30/34); between t2/t3 → B(31/34); after t3 → A(30/34).
    const asOf = async (iso: string) => storage.getPregameFeatureAsOf({ sport: "nba", entityCanonicalId: CH_ENTITY, featureKey: "nba.player.points_per_min", featureVersion: "nba_gamelog_v1", predictionAt: new Date(iso) });
    const rBefore = await asOf("2026-01-10T12:00:00Z"), rBetween = await asOf("2026-01-11T12:00:00Z"), rAfter = await asOf("2026-01-13T00:00:00Z");
    ok(rBefore !== null && Math.abs(Number(rBefore!.value) - 30 / 34) < 1e-9, "replay before t2 sees A1 (30/34)");
    ok(rBetween !== null && Math.abs(Number(rBetween!.value) - 31 / 34) < 1e-9, "replay between t2/t3 sees B (31/34)");
    ok(rAfter !== null && Math.abs(Number(rAfter!.value) - 30 / 34) < 1e-9, "replay after t3 sees A2 (30/34)");
    // feature sourceId resolves to a real capture for this entity.
    const feats = await db.select().from(pregameFeatureSnapshots).where(eq(pregameFeatureSnapshots.entityCanonicalId, CH_ENTITY));
    const ids = new Set([a1.snapshotId, b.snapshotId, a2.snapshotId]);
    ok(feats.length > 0 && feats.every((f) => ids.has(f.sourceId)), "feature sourceId resolves to the correct immutable capture");
  }

  // ── (3) Consecutive identical content is a no-op (unchanged counts) ──────────
  {
    const E = "nba:player:itest_pr5_idem";
    const p = { playerNativeId: "itest_pr5_idem", seasonType: "Regular Season" as const, currentSeason: 2026, asOfDate: "2026-08-06T00:00:00Z", season: 2026, seasonLabel: "2025-26" };
    await ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022500920", "2026-02-01", 20), "2026-02-02T00:00:00Z") }, p);
    const again = await ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022500920", "2026-02-01", 20), "2026-02-03T00:00:00Z") }, p); // same content, later
    ok(again.status === "noop_identical", "consecutive identical content → no-op");
    const rows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.semanticSourceKey, buildNbaGameLogSourceKey({ sourceKind: "nba_stats_playergamelog", entityCanonicalId: E, season: 2026, seasonType: "Regular Season" })));
    ok(rows.length === 1, "only one accepted capture for a no-op rerun");
  }

  // ── (4) Out-of-order arrival fails closed; head not inverted ────────────────
  {
    const p = { playerNativeId: "itest_pr5_ooo", seasonType: "Regular Season" as const, currentSeason: 2026, asOfDate: "2026-08-06T00:00:00Z", season: 2026, seasonLabel: "2025-26" };
    await ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022500930", "2026-03-01", 20), t1) }, p);
    await ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022500930", "2026-03-01", 22), t3) }, p); // head
    const stale = await ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022500930", "2026-03-01", 21), t2) }, p); // older
    ok(stale.status === "stale_observation", "older-knownAt arrival → stale_observation (wrote nothing)");
    const semKey = buildNbaGameLogSourceKey({ sourceKind: "nba_stats_playergamelog", entityCanonicalId: "nba:player:itest_pr5_ooo", season: 2026, seasonType: "Regular Season" });
    const rows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.semanticSourceKey, semKey));
    ok(rows.length === 2, "stale observation created no capture");
    const preds = rows.map((r) => r.supersedesSnapshotId).filter((x): x is string => x != null);
    ok(new Set(preds).size === preds.length, "no lineage fork from the stale arrival");
  }

  // ── (5) Same-knownAt different payload → conflict (no fake tiebreak) ─────────
  {
    const p = { playerNativeId: "itest_pr5_conf", seasonType: "Regular Season" as const, currentSeason: 2026, asOfDate: "2026-08-06T00:00:00Z", season: 2026, seasonLabel: "2025-26" };
    await ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022500940", "2026-03-05", 20), t1) }, p);
    const conflict = await ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022500940", "2026-03-05", 21), t1) }, p); // same instant, diff payload
    ok(conflict.status === "conflicting_observation", "same knownAt + different payload → conflicting_observation (fail closed)");
  }

  // ── (6) Concurrent DIFFERENT seasons keep both posteriors ───────────────────
  {
    const p = { playerNativeId: "itest_pr5_conc", seasonType: "Regular Season" as const, currentSeason: 2026, asOfDate: "2026-08-06T00:00:00Z" };
    const a = ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022500950", "2026-02-01", 28), t1) }, { ...p, season: 2026, seasonLabel: "2025-26" });
    const b = ingestPlayerSeason({ store: port, fetch: fetchAt(raw("0022400960", "2025-02-01", 22), t1) }, { ...p, season: 2025, seasonLabel: "2024-25" });
    await Promise.all([a, b]);
    const rows = await db.select().from(pregamePosteriorStates).where(eq(pregamePosteriorStates.entityCanonicalId, "nba:player:itest_pr5_conc"));
    const pts = rows.find((r) => r.featureKey === "nba.player.points_per_min");
    const seasons = pts ? Object.keys((pts.bySeason ?? {}) as Record<string, unknown>) : [];
    ok(seasons.includes("2026") && seasons.includes("2025"), "concurrent seasons: final posterior contains both (no lost update)");
  }

  await cleanup();
  await pool.end();
  console.log(`\nnbaIngestionStorage.integration.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error("integration harness error:", err instanceof Error ? err.message : err); process.exit(1); });
