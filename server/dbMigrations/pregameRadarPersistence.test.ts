// Durable Pregame Radar persistence bootstrap — invariants.
//
// This sandbox has no live Postgres instance, so these tests exercise the
// migration against a recording fake `SqlExecutor` rather than a real
// database: (1) every required table/index is present in the emitted SQL,
// (2) every CREATE is guarded with IF NOT EXISTS so running the bootstrap
// twice back-to-back never throws (idempotent), and (3) no destructive DROP
// (or other data-destroying) statement is ever emitted.
//
// Run: npx tsx server/dbMigrations/pregameRadarPersistence.test.ts

import {
  ensurePregameRadarPersistenceSchema,
  PREGAME_RADAR_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./pregameRadarPersistence";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

class RecordingExecutor implements SqlExecutor {
  public executed: string[] = [];
  async query(sql: string): Promise<unknown> {
    this.executed.push(sql);
    return undefined;
  }
}

const ALL_SQL = PREGAME_RADAR_PERSISTENCE_STATEMENTS.join("\n").toUpperCase();

// ── 1. All four tables are created ──────────────────────────────────────────
{
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS PREGAME_POWER_RADAR_SIGNALS"), "pregame_power_radar_signals table is created");
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS PREGAME_POWER_RADAR_BUILDS"), "pregame_power_radar_builds table is created");
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS MLB_MOUND_RADAR_SIGNALS"), "mlb_mound_radar_signals table is created");
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS MLB_MOUND_RADAR_BUILDS"), "mlb_mound_radar_builds table is created");
}

// ── 2. Every statement is idempotent (IF NOT EXISTS-guarded) ───────────────
{
  for (const statement of PREGAME_RADAR_PERSISTENCE_STATEMENTS) {
    const upper = statement.toUpperCase();
    const isTable = upper.includes("CREATE TABLE");
    const isIndex = upper.includes("CREATE INDEX") || upper.includes("CREATE UNIQUE INDEX");
    ok(isTable || isIndex, "every statement is a CREATE TABLE or CREATE INDEX");
    ok(upper.includes("IF NOT EXISTS"), `statement is IF NOT EXISTS-guarded: ${statement.trim().slice(0, 60)}...`);
  }
}

// ── 3. Required indexes exist, matching shared/schema.ts exactly ───────────
{
  ok(ALL_SQL.includes("PREGAME_POWER_RADAR_SIGNALS_UNIQUE_IDX") && ALL_SQL.includes("SESSION_DATE, GAME_ID, BATTER_ID"),
    "pregame_power_radar_signals unique index covers (session_date, game_id, batter_id)");
  ok(ALL_SQL.includes("PREGAME_POWER_RADAR_SIGNALS_SESSION_DATE_IDX"), "pregame_power_radar_signals session_date index exists");
  ok(ALL_SQL.includes("PREGAME_POWER_RADAR_SIGNALS_BUILD_IDX"), "pregame_power_radar_signals build_id index exists");
  ok(ALL_SQL.includes("PREGAME_POWER_RADAR_BUILDS_SESSION_DATE_IDX"), "pregame_power_radar_builds session_date index exists");

  ok(ALL_SQL.includes("MLB_MOUND_RADAR_SIGNALS_UNIQUE_IDX") && ALL_SQL.includes("SESSION_DATE, GAME_ID, PITCHER_ID"),
    "mlb_mound_radar_signals unique index covers (session_date, game_id, pitcher_id)");
  ok(ALL_SQL.includes("MLB_MOUND_RADAR_SIGNALS_SESSION_DATE_IDX"), "mlb_mound_radar_signals session_date index exists");
  ok(ALL_SQL.includes("MLB_MOUND_RADAR_SIGNALS_BUILD_IDX"), "mlb_mound_radar_signals build_id index exists");
  ok(ALL_SQL.includes("MLB_MOUND_RADAR_BUILDS_SESSION_DATE_IDX"), "mlb_mound_radar_builds session_date index exists");
}

// ── 4. Durable/graded-state columns from shared/schema.ts are present ──────
{
  ok(ALL_SQL.includes("OUTCOMES JSONB"), "outcomes JSONB column is present (both signals tables)");
  ok(ALL_SQL.includes("GRADED_AT TIMESTAMP"), "graded_at TIMESTAMP column is present (both signals tables)");
  ok(ALL_SQL.includes("EVER_PUBLICLY_FLAGGED BOOLEAN"), "ever_publicly_flagged column is present (both signals tables)");
  ok(ALL_SQL.includes("EVER_PUBLICLY_FLAGGED_FADE BOOLEAN"), "ever_publicly_flagged_fade column is present (mound signals)");
  ok(ALL_SQL.includes("MOUND_DIRECTION TEXT"), "mound_direction column is present (mound signals)");
}

// ── 5. No destructive statement anywhere in the migration ──────────────────
{
  ok(!/\bDROP\b/.test(ALL_SQL), "no DROP statement anywhere in the migration");
  ok(!/\bTRUNCATE\b/.test(ALL_SQL), "no TRUNCATE statement anywhere in the migration");
  ok(!/\bDELETE\s+FROM\b/.test(ALL_SQL), "no DELETE FROM statement anywhere in the migration");
  ok(!/\bALTER\s+TABLE\b/.test(ALL_SQL), "no ALTER TABLE statement anywhere in the migration (tables are created whole)");
}

// ── 6. Running the bootstrap twice back-to-back never throws ───────────────
{
  const client = new RecordingExecutor();
  await ensurePregameRadarPersistenceSchema(client);
  const firstRunCount = client.executed.length;
  ok(firstRunCount === PREGAME_RADAR_PERSISTENCE_STATEMENTS.length, "first run executes every statement exactly once");

  await ensurePregameRadarPersistenceSchema(client);
  ok(client.executed.length === firstRunCount * 2, "second run re-issues the same statement set without throwing (idempotent)");
  ok(
    client.executed.slice(0, firstRunCount).join("\n") === client.executed.slice(firstRunCount).join("\n"),
    "the second run's statements are byte-identical to the first run's",
  );
}

// ── 7. A failure from the executor propagates (must fail startup) ──────────
{
  class FailingExecutor implements SqlExecutor {
    async query(): Promise<unknown> {
      throw new Error("simulated connection failure");
    }
  }
  let threw = false;
  try {
    await ensurePregameRadarPersistenceSchema(new FailingExecutor());
  } catch {
    threw = true;
  }
  ok(threw, "a query failure propagates out of ensurePregameRadarPersistenceSchema rather than being swallowed");
}

console.log(`\npregameRadarPersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
