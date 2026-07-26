// Plate HR Probability V2 research schema bootstrap — invariants.
//
// This sandbox has no live Postgres instance, so these tests exercise the
// migration against a recording fake `SqlExecutor` rather than a real
// database: (1) every required table/index is present in the emitted SQL,
// (2) every CREATE is guarded with IF NOT EXISTS so running the bootstrap
// twice back-to-back never throws (idempotent), and (3) no destructive
// statement is ever emitted.
//
// Run: npx tsx server/dbMigrations/plateHrV2Persistence.test.ts

import {
  ensurePlateHrV2PersistenceSchema,
  PLATE_HR_V2_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./plateHrV2Persistence";

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

const ALL_SQL = PLATE_HR_V2_PERSISTENCE_STATEMENTS.join("\n").toUpperCase();

// ── 1. All four tables are created ──────────────────────────────────────────
{
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS PLATE_HR_V2_FEATURE_SNAPSHOTS"), "plate_hr_v2_feature_snapshots table is created");
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS PLATE_HR_V2_LABELS"), "plate_hr_v2_labels table is created");
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS PLATE_HR_V2_MODEL_REGISTRY"), "plate_hr_v2_model_registry table is created");
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS PLATE_HR_V2_SUFFICIENT_STATS"), "plate_hr_v2_sufficient_stats table is created");
}

function isSelfHealOnlyAlter(statement: string): boolean {
  const upper = statement.toUpperCase().trim().replace(/;\s*$/, "");
  const match = upper.match(/^ALTER TABLE\s+\S+\s+([\s\S]+)$/);
  if (!match) return false;
  const clauses = match[1].split(",").map((c) => c.trim());
  return clauses.length > 0 && clauses.every((c) => c.startsWith("ADD COLUMN IF NOT EXISTS"));
}

// ── 2. Every statement is idempotent (IF NOT EXISTS-guarded) ───────────────
{
  for (const statement of PLATE_HR_V2_PERSISTENCE_STATEMENTS) {
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

// ── 3. Required indexes / constraints / new columns exist ─────────────────
{
  ok(ALL_SQL.includes("PLATE_HR_V2_FEATURE_SNAPSHOTS_SESSION_GAME_BATTER_IDX"), "feature_snapshots session/game/batter index exists");
  ok(ALL_SQL.includes("PLATE_HR_V2_FEATURE_SNAPSHOTS_SESSION_DATE_IDX"), "feature_snapshots session_date index exists");
  ok(ALL_SQL.includes("PLATE_HR_V2_FEATURE_SNAPSHOTS_FEATURE_VERSION_IDX"), "feature_snapshots feature_version index exists");
  ok(ALL_SQL.includes("PLATE_HR_V2_FEATURE_SNAPSHOTS_GAME_STATUS_IDX"), "feature_snapshots game_status index exists");
  ok(ALL_SQL.includes("PLATE_HR_V2_FEATURE_SNAPSHOTS_LOCKED_AT_IDX"), "feature_snapshots locked_at index exists");
  // Correction 3 — canonical-training-observation columns.
  ok(ALL_SQL.includes("PREDICTION_AS_OF TIMESTAMP NOT NULL"), "feature_snapshots has a NOT NULL prediction_as_of column");
  ok(ALL_SQL.includes("SECONDS_TO_FIRST_PITCH INTEGER"), "feature_snapshots has a seconds_to_first_pitch column");
  ok(ALL_SQL.includes("LINEUP_CONFIRMED_AT TIMESTAMP"), "feature_snapshots has a lineup_confirmed_at column");
  ok(ALL_SQL.includes("STARTER_CONFIRMED BOOLEAN"), "feature_snapshots has a starter_confirmed column");
  ok(ALL_SQL.includes("LOCKED_AT TIMESTAMP"), "feature_snapshots has a locked_at column (the immutability marker)");
  // Correction 2 — sufficient-stats pointer, never a copy.
  ok(ALL_SQL.includes("SUFFICIENT_STATS_REF TEXT"), "feature_snapshots has a sufficient_stats_ref pointer column");

  ok(ALL_SQL.includes("PRIMARY KEY (SNAPSHOT_ID, LABEL_VERSION)"), "plate_hr_v2_labels declares a composite PRIMARY KEY (snapshot_id, label_version)");
  ok(ALL_SQL.includes("PLATE_HR_V2_LABELS_DISPOSITION_IDX"), "labels label_disposition index exists");
  ok(ALL_SQL.includes("PLATE_HR_V2_LABELS_RESOLVED_AT_IDX"), "labels resolved_at index exists");
  ok(ALL_SQL.includes("PLATE_HR_V2_LABELS_SNAPSHOT_IDX"), "labels snapshot_id index exists");

  ok(ALL_SQL.includes("PLATE_HR_V2_MODEL_REGISTRY_STATUS_IDX"), "model_registry status index exists");
  ok(ALL_SQL.includes("PLATE_HR_V2_MODEL_REGISTRY_FEATURE_VERSION_IDX"), "model_registry feature_version index exists");
  ok(ALL_SQL.includes("STANDARDIZATION JSONB"), "model_registry has a standardization jsonb column (correction/deviation a)");

  ok(
    ALL_SQL.includes("PLATE_HR_V2_SUFFICIENT_STATS_ENTITY_DATE_IDX") && ALL_SQL.includes("ENTITY_TYPE, ENTITY_ID, AS_OF_DATE"),
    "sufficient_stats entity/date index covers (entity_type, entity_id, as_of_date)",
  );
  ok(ALL_SQL.includes("PLATE_HR_V2_SUFFICIENT_STATS_AS_OF_DATE_IDX"), "sufficient_stats as_of_date index exists");
  ok(ALL_SQL.includes("ZONE_DATA_AVAILABLE BOOLEAN"), "sufficient_stats has a zone_data_available flag (honest, not fabricated)");
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
  await ensurePlateHrV2PersistenceSchema(client);
  const firstRunCount = client.executed.length;
  ok(firstRunCount === PLATE_HR_V2_PERSISTENCE_STATEMENTS.length, "first run executes every statement exactly once");

  await ensurePlateHrV2PersistenceSchema(client);
  ok(client.executed.length === firstRunCount * 2, "second run re-issues the same statement set without throwing (idempotent)");
  ok(
    client.executed.slice(0, firstRunCount).join("\n") === client.executed.slice(firstRunCount).join("\n"),
    "the second run's statements are byte-identical to the first run's",
  );
}

// ── 6. A failure from the executor propagates (must fail startup) ──────────
{
  class FailingExecutor implements SqlExecutor {
    async query(): Promise<unknown> {
      throw new Error("simulated connection failure");
    }
  }
  let threw = false;
  try {
    await ensurePlateHrV2PersistenceSchema(new FailingExecutor());
  } catch {
    threw = true;
  }
  ok(threw, "a query failure propagates out of ensurePlateHrV2PersistenceSchema rather than being swallowed");
}

console.log(`\nplateHrV2Persistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
