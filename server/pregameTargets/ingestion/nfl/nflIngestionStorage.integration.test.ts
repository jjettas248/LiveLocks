// NFL ingestion storage — REAL database invariants (Pregame Targets PR6).
// Exercises storage.ts's ACTUAL ingestPregameDatasetSnapshotAtomic transaction against a
// live Postgres connection — no monkey-patching. Proves what the mock-port unit test
// cannot for the DATASET-scoped (whole-season, multi-entity) path:
//   • BOTH inputs are persisted immutably (weekly + schedule + join = 3 captures) and the
//     feature sourceId resolves to the join-provenance capture, whose payload references the
//     exact weekly + schedule capture ids/hashes (both inputs recoverable from a feature row).
//   • genuine all-or-nothing rollback (a fold throw commits nothing — no partial captures).
//   • head selection by OBSERVATION chronology (known_at); A→B→A recurrence = 3 captures.
//   • consecutive identical content is a no-op; out-of-order arrival fails closed (stale);
//     same-knownAt different payload → conflict (no fake tiebreak).
//   • CONCURRENT DIFFERENT-SEASON ingests of the same player keep BOTH seasons' posteriors
//     (the stable cross-season lock serializes them — no lost update).
//
// Run: DATABASE_URL=postgresql://... npx tsx server/pregameTargets/ingestion/nfl/nflIngestionStorage.integration.test.ts
//
// CLASSIFICATION: without DATABASE_URL this suite is EXCLUDED_ENV (prints that token,
// exits 0) — not a silent pass, not a failure. Point it at a disposable database.

import type { CsvFetcher } from "./nflIngestionJob"; // type-only (erased) — no runtime DB import

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

// A minimal but schema-faithful weekly CSV (one player, one game) + schedule CSV.
const WEEKLY_HEADER = "player_id,game_id,season,week,season_type,team,opponent_team,position,targets,receptions,receiving_yards,carries,rushing_yards";
const SCHED_HEADER = "game_id,season,game_type,week,gameday,away_team,home_team";
const weeklyCsv = (playerId: string, gameId: string, season: number, week: number, recYds: number) =>
  `${WEEKLY_HEADER}\n${playerId},${gameId},${season},${week},REG,SF,KC,WR,10,7,${recYds},0,0\n`;
const schedCsv = (gameId: string, season: number, week: number, gameday: string) =>
  `${SCHED_HEADER}\n${gameId},${season},REG,${week},${gameday},SF,KC\n`;

async function run(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("EXCLUDED_ENV: nflIngestionStorage.integration.test — no DATABASE_URL (real-DB dataset atomicity/dual-provenance/cross-season concurrency not exercised here).");
    process.exit(0);
  }

  const { storage } = await import("../../storage");
  const { db, pool } = await import("../../db");
  const { pregameRawSourceSnapshots, pregameFeatureSnapshots, pregamePosteriorStates } = await import("@shared/schema");
  const { eq, like, or } = await import("drizzle-orm");
  const { ensurePregameTargetsFoundationSchema } = await import("../../dbMigrations/pregameTargetsFoundationPersistence");
  const { ensurePregameTargetsRawProvenanceColumns } = await import("../../dbMigrations/pregameTargetsRawProvenancePersistence");
  const { buildStorePort } = await import("../../scripts/nflPregameBackfill");
  const { ingestNflSeason } = await import("./nflIngestionJob");
  const { buildNflSourceKey } = await import("./nflSourceContracts");
  const { NFL_WEEKLY_DATASET_ENTITY } = await import("./nflIngestionJob");

  await ensurePregameTargetsFoundationSchema({ query: (s: string) => pool.query(s) } as never);
  await ensurePregameTargetsRawProvenanceColumns({ query: (s: string) => pool.query(s) } as never);

  // All artifacts scoped by the "itest_pr6" marker so cleanup never touches real rows.
  const ITEST_PLAYER = "00-itest_pr6";
  const ENTITY = `nfl:player:${ITEST_PLAYER}`;
  const cleanup = async () => {
    await db.delete(pregameFeatureSnapshots).where(like(pregameFeatureSnapshots.entityCanonicalId, "%itest_pr6%"));
    await db.delete(pregamePosteriorStates).where(like(pregamePosteriorStates.entityCanonicalId, "%itest_pr6%"));
    await db.delete(pregameRawSourceSnapshots).where(
      or(like(pregameRawSourceSnapshots.semanticSourceKey, "%itest_pr6%"), like(pregameRawSourceSnapshots.sourceKey, "%itest_pr6%"), eq(pregameRawSourceSnapshots.sport, "nfl_itest_pr6")),
    );
  };
  await cleanup();

  const port = buildStorePort(storage as never);
  // Fetchers that return a fixed CSV at a chosen observation instant.
  const fetchWeeklyAt = (csv: string, iso: string): CsvFetcher => async () => ({ ok: true, rawCsv: csv, fetchedAt: iso, sourcePublishedAt: null });
  const fetchScheduleAt = (csv: string, iso: string): CsvFetcher => async () => ({ ok: true, rawCsv: csv, fetchedAt: iso, sourcePublishedAt: null });

  const t1 = "2026-01-10T00:00:00.000Z", t2 = "2026-01-11T00:00:00.000Z", t3 = "2026-01-12T00:00:00.000Z";
  const GAME = "2024_01_SF_KC", GAMEDAY = "2024-09-08";
  const semKey2024 = buildNflSourceKey({ sourceKind: "nflverse_weekly_stats", entityCanonicalId: NFL_WEEKLY_DATASET_ENTITY, season: 2024 });

  // ── (1) First capture persists weekly + schedule + join; feature provenance recoverable ─
  {
    const out = await ingestNflSeason(
      { store: port, fetchSchedule: fetchScheduleAt(schedCsv(GAME, 2024, 1, GAMEDAY), t1), fetchWeekly: fetchWeeklyAt(weeklyCsv(ITEST_PLAYER, GAME, 2024, 1, 110), t1) },
      { season: 2024, currentSeason: 2024, asOfDate: "2026-08-06T00:00:00Z" },
    );
    ok(out.status === "ingested" && out.featureRowsWritten === 5 && out.playersUpdated === 1, "first NFL season dataset ingest → 5 feature rows, 1 player");

    // Weekly + schedule + join = 3 immutable captures for this identity family.
    const weeklyRows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.semanticSourceKey, semKey2024));
    ok(weeklyRows.length === 1 && weeklyRows[0].sourceKind === "nflverse_weekly_stats", "weekly capture persisted (head chain)");
    const scheduleRows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.sourceKind, "nflverse_schedule"));
    const joinRows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.sourceKind, "nfl_weekly_schedule_join"));
    const itestSched = scheduleRows.filter((r) => (r.semanticSourceKey ?? "").includes("season=2024"));
    const itestJoin = joinRows.filter((r) => (r.semanticSourceKey ?? "").includes("season=2024"));
    ok(itestSched.length >= 1, "schedule capture persisted (content identity)");
    ok(itestJoin.length >= 1, "join-provenance capture persisted");

    // Feature sourceId → the join capture; the join payload references BOTH inputs.
    const feats = await db.select().from(pregameFeatureSnapshots).where(eq(pregameFeatureSnapshots.entityCanonicalId, ENTITY));
    ok(feats.length === 5, "5 feature rows for the player");
    const joinId = feats[0].sourceId;
    const join = await storage.getPregameRawSourceSnapshot(joinId);
    ok(join !== null && join!.sourceKind === "nfl_weekly_schedule_join", "feature sourceId resolves to the join-provenance capture");
    const jp = (join!.payload ?? {}) as Record<string, unknown>;
    ok(jp.weeklySnapshotId === weeklyRows[0].snapshotId, "join payload references the exact weekly capture id (weekly recoverable)");
    ok(jp.scheduleSnapshotId === itestSched[0].snapshotId, "join payload references the exact schedule capture id (schedule recoverable)");
    ok(typeof jp.weeklyContentHash === "string" && typeof jp.scheduleContentHash === "string", "join payload carries both input content hashes");
    ok(feats.every((f) => f.derivedFromGameIds && f.derivedFromGameIds.length === 1), "feature rows carry the canonical game id");
  }

  // ── (2) A→B→A recurrence (weekly content changes) = three distinct captures ──
  {
    const ingest = (recYds: number, iso: string) => ingestNflSeason(
      { store: port, fetchSchedule: fetchScheduleAt(schedCsv(GAME, 2024, 1, GAMEDAY), iso), fetchWeekly: fetchWeeklyAt(weeklyCsv(ITEST_PLAYER, GAME, 2024, 1, recYds), iso) },
      { season: 2024, currentSeason: 2024, asOfDate: "2026-08-06T00:00:00Z" },
    );
    // Head is already recYds=110 @ t1 from case (1). Change → B @ t2, back to A @ t3.
    const b = await ingest(120, t2);
    const a2 = await ingest(110, t3);
    ok(b.status === "ingested" && a2.status === "ingested", "B and A-again both accepted (recurrence)");
    const weeklyRows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.semanticSourceKey, semKey2024));
    ok(weeklyRows.length === 3, "A→B→A = three distinct weekly captures (no collapse)");
    const byId = new Map(weeklyRows.map((r) => [r.snapshotId, r]));
    const a1 = weeklyRows.find((r) => r.supersedesSnapshotId === null)!;
    const bRow = weeklyRows.find((r) => r.supersedesSnapshotId === a1.snapshotId)!;
    const a2Row = weeklyRows.find((r) => r.supersedesSnapshotId === bRow.snapshotId)!;
    ok(!!a1 && !!bRow && !!a2Row && byId.size === 3, "chain A1←B←A2 by observation chronology (known_at)");
    ok(a1.contentHash === a2Row.contentHash && a1.contentHash !== bRow.contentHash, "A1 and A2 share content hash; B differs");
  }

  // ── (3) Consecutive identical content → no-op ────────────────────────────────
  {
    const again = await ingestNflSeason(
      { store: port, fetchSchedule: fetchScheduleAt(schedCsv(GAME, 2024, 1, GAMEDAY), "2026-01-13T00:00:00Z"), fetchWeekly: fetchWeeklyAt(weeklyCsv(ITEST_PLAYER, GAME, 2024, 1, 110), "2026-01-13T00:00:00Z") },
      { season: 2024, currentSeason: 2024, asOfDate: "2026-08-06T00:00:00Z" },
    );
    ok(again.status === "noop_identical", "identical content later → no-op (head already A@110)");
    const weeklyRows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.semanticSourceKey, semKey2024));
    ok(weeklyRows.length === 3, "no-op created no new weekly capture");
  }

  // ── (4) Out-of-order older-knownAt → stale (no fork) ─────────────────────────
  {
    const stale = await ingestNflSeason(
      { store: port, fetchSchedule: fetchScheduleAt(schedCsv(GAME, 2024, 1, GAMEDAY), t2), fetchWeekly: fetchWeeklyAt(weeklyCsv(ITEST_PLAYER, GAME, 2024, 1, 999), t2) },
      { season: 2024, currentSeason: 2024, asOfDate: "2026-08-06T00:00:00Z" },
    );
    ok(stale.status === "stale_observation", "older-knownAt distinct content → stale_observation");
    const weeklyRows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.semanticSourceKey, semKey2024));
    ok(weeklyRows.length === 3, "stale observation wrote nothing (no fork)");
    const preds = weeklyRows.map((r) => r.supersedesSnapshotId).filter((x): x is string => x != null);
    ok(new Set(preds).size === preds.length, "no lineage fork from the stale arrival");
  }

  // ── (5) Same-knownAt, different payload → conflict ───────────────────────────
  {
    const conflict = await ingestNflSeason(
      { store: port, fetchSchedule: fetchScheduleAt(schedCsv(GAME, 2024, 1, GAMEDAY), t3), fetchWeekly: fetchWeeklyAt(weeklyCsv(ITEST_PLAYER, GAME, 2024, 1, 55), t3) },
      { season: 2024, currentSeason: 2024, asOfDate: "2026-08-06T00:00:00Z" },
    );
    ok(conflict.status === "conflicting_observation", "same knownAt (t3) + different payload → conflicting_observation");
  }

  // ── (6) Atomic rollback: a fold throw commits NOTHING (direct storage call) ──
  {
    const { computeContentHash, computeSnapshotId } = await import("../rawSnapshotIdentity");
    const semKey = buildNflSourceKey({ sourceKind: "nflverse_weekly_stats", entityCanonicalId: NFL_WEEKLY_DATASET_ENTITY, season: 2099 });
    const contentHash = computeContentHash("itest_pr6_rollback_payload");
    const snapshotId = computeSnapshotId("nflverse_weekly_stats", semKey, contentHash);
    let threw = false;
    try {
      await storage.ingestPregameDatasetSnapshotAtomic({
        featureVersion: "nfl_nflverse_v1",
        entityCanonicalIds: ["nfl:player:itest_pr6_rb"],
        featureKeys: ["nfl.player.targets_per_game"],
        semanticSourceKey: semKey,
        posteriorLockKey: "nfl|pregame_dataset_ingest|nfl_nflverse_v1",
        incomingKnownAt: new Date("2099-01-01T00:00:00Z"),
        incomingContentHash: contentHash,
        raw: { snapshotId, sport: "nfl_itest_pr6", sourceKind: "nflverse_weekly_stats", sourceKey: `${semKey}#itest_pr6`, semanticSourceKey: semKey, validAt: new Date("2099-09-01T00:00:00Z"), knownAt: new Date("2099-01-01T00:00:00Z"), payload: { x: 1 } as never, contentHash },
        features: [],
        foldPosteriors: () => { throw new Error("injected fold failure"); },
      });
    } catch { threw = true; }
    ok(threw, "injected fold failure propagates");
    const rows = await db.select().from(pregameRawSourceSnapshots).where(eq(pregameRawSourceSnapshots.snapshotId, snapshotId));
    ok(rows.length === 0, "atomic rollback: no weekly capture committed on fold failure");
  }

  // ── (7) Concurrent DIFFERENT-SEASON ingests of the SAME player keep both ─────
  {
    const CONC_PLAYER = "00-itest_pr6_conc";
    const cur = ingestNflSeason(
      { store: port, fetchSchedule: fetchScheduleAt(schedCsv("2024_02_SF_KC", 2024, 2, "2024-09-15"), t1), fetchWeekly: fetchWeeklyAt(weeklyCsv(CONC_PLAYER, "2024_02_SF_KC", 2024, 2, 88), t1) },
      { season: 2024, currentSeason: 2024, asOfDate: "2026-08-06T00:00:00Z" },
    );
    const prior = ingestNflSeason(
      { store: port, fetchSchedule: fetchScheduleAt(schedCsv("2023_02_SF_KC", 2023, 2, "2023-09-17"), t1), fetchWeekly: fetchWeeklyAt(weeklyCsv(CONC_PLAYER, "2023_02_SF_KC", 2023, 2, 66), t1) },
      { season: 2023, currentSeason: 2024, asOfDate: "2026-08-06T00:00:00Z" },
    );
    await Promise.all([cur, prior]);
    const rows = await db.select().from(pregamePosteriorStates).where(eq(pregamePosteriorStates.entityCanonicalId, `nfl:player:${CONC_PLAYER}`));
    const recYds = rows.find((r) => r.featureKey === "nfl.player.receiving_yards_per_game");
    const seasons = recYds ? Object.keys((recYds.bySeason ?? {}) as Record<string, unknown>) : [];
    ok(seasons.includes("2024") && seasons.includes("2023"), "concurrent different-season ingests keep BOTH posteriors (cross-season lock, no lost update)");
  }

  await cleanup();
  await pool.end();
  console.log(`\nnflIngestionStorage.integration.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error("integration harness error:", err instanceof Error ? err.message : err); process.exit(1); });
