// Mound V2 shadow prediction schema bootstrap — invariants.
//
// This sandbox has no live Postgres instance, so these tests exercise the
// migration against a recording fake `SqlExecutor` rather than a real
// database — mirrors hrRadarResearchPersistence.test.ts's convention.
//
// Run: npx tsx server/dbMigrations/moundV2ShadowPersistence.test.ts

import {
  ensureMoundV2ShadowPersistenceSchema,
  MOUND_V2_SHADOW_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./moundV2ShadowPersistence";

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

const ALL_SQL = MOUND_V2_SHADOW_PERSISTENCE_STATEMENTS.join("\n").toUpperCase();

// ── 1. Table is created ─────────────────────────────────────────────────────
{
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS MOUND_V2_SHADOW_PREDICTIONS"), "mound_v2_shadow_predictions table is created");
  ok(ALL_SQL.includes("PREDICTION_ID TEXT PRIMARY KEY"), "prediction_id is the primary key — a repeated evaluation is a harmless no-op, not a silent overwrite");
}

// ── 2. Every statement is idempotent (IF NOT EXISTS-guarded) ───────────────
function isSelfHealOnlyAlter(statement: string): boolean {
  const upper = statement.toUpperCase().trim().replace(/;\s*$/, "");
  const match = upper.match(/^ALTER TABLE\s+\S+\s+([\s\S]+)$/);
  if (!match) return false;
  const clauses = match[1].split(",").map((c) => c.trim());
  return clauses.length > 0 && clauses.every((c) => c.startsWith("ADD COLUMN IF NOT EXISTS"));
}
{
  for (const statement of MOUND_V2_SHADOW_PERSISTENCE_STATEMENTS) {
    const upper = statement.toUpperCase();
    const isTable = upper.includes("CREATE TABLE");
    const isIndex = upper.includes("CREATE INDEX") || upper.includes("CREATE UNIQUE INDEX");
    const isAlter = upper.includes("ALTER TABLE");
    ok(isTable || isIndex || isAlter, `every statement is a CREATE TABLE, CREATE INDEX, or ALTER TABLE: ${statement.trim().slice(0, 60)}...`);
    if (isAlter) {
      ok(isSelfHealOnlyAlter(statement), `ALTER TABLE statement is additive ADD COLUMN IF NOT EXISTS only: ${statement.trim().slice(0, 80)}...`);
    }
    ok(upper.includes("IF NOT EXISTS"), `statement is IF NOT EXISTS-guarded: ${statement.trim().slice(0, 60)}...`);
  }
}

// ── 3. Required indexes exist, matching shared/schema.ts ───────────────────
{
  ok(ALL_SQL.includes("MOUND_V2_SHADOW_PREDICTIONS_SNAPSHOT_IDX"), "snapshot_id index exists");
  ok(ALL_SQL.includes("MOUND_V2_SHADOW_PREDICTIONS_GAME_PITCHER_IDX"), "game_id/pitcher_id index exists");
  ok(ALL_SQL.includes("MOUND_V2_SHADOW_PREDICTIONS_SETTLEMENT_STATUS_IDX"), "settlement_status index exists");
  ok(ALL_SQL.includes("MOUND_V2_SHADOW_PREDICTIONS_EVALUATION_TIMESTAMP_IDX"), "evaluation_timestamp index exists");
  ok(
    ALL_SQL.includes("MOUND_V2_SHADOW_PREDICTIONS_MARKET_VERSION_IDX") &&
    ALL_SQL.includes("ON MOUND_V2_SHADOW_PREDICTIONS (MARKET, V2_MODEL_VERSION)"),
    "market/model-version composite index exists",
  );
}

// ── 4. No destructive statement anywhere in the migration ──────────────────
{
  ok(!/\bDROP\b/.test(ALL_SQL), "no DROP statement anywhere in the migration");
  ok(!/\bTRUNCATE\b/.test(ALL_SQL), "no TRUNCATE statement anywhere in the migration");
  ok(!/\bDELETE\s+FROM\b/.test(ALL_SQL), "no DELETE FROM statement anywhere in the migration");
  ok(!/\bRENAME\b/.test(ALL_SQL), "no RENAME statement anywhere in the migration");
  ok(!/ALTER\s+COLUMN[\s\S]*?\bTYPE\b/.test(ALL_SQL), "no destructive ALTER COLUMN ... TYPE change anywhere in the migration");
  ok(!/DROP\s+COLUMN/.test(ALL_SQL), "no DROP COLUMN anywhere in the migration");
}

// ── 5. Running the bootstrap twice back-to-back never throws ───────────────
{
  const client = new RecordingExecutor();
  await ensureMoundV2ShadowPersistenceSchema(client);
  const firstRunCount = client.executed.length;
  ok(firstRunCount === MOUND_V2_SHADOW_PERSISTENCE_STATEMENTS.length, "first run executes every statement exactly once");

  await ensureMoundV2ShadowPersistenceSchema(client);
  ok(client.executed.length === firstRunCount * 2, "second run re-issues the same statement set without throwing (idempotent)");
  ok(
    client.executed.slice(0, firstRunCount).join("\n") === client.executed.slice(firstRunCount).join("\n"),
    "the second run's statements are byte-identical to the first run's",
  );
}

// ── 6. A failure from the executor propagates (must fail startup) ─────────
{
  class FailingExecutor implements SqlExecutor {
    async query(): Promise<unknown> {
      throw new Error("simulated connection failure");
    }
  }
  let threw = false;
  try {
    await ensureMoundV2ShadowPersistenceSchema(new FailingExecutor());
  } catch {
    threw = true;
  }
  ok(threw, "a query failure propagates out of ensureMoundV2ShadowPersistenceSchema rather than being swallowed");
}

console.log(`\nmoundV2ShadowPersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
