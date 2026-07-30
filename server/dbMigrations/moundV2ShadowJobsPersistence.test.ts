// Mound V2 shadow evaluation outbox schema bootstrap — invariants.
// Mirrors moundV2ShadowPersistence.test.ts's exact convention.
//
// Run: npx tsx server/dbMigrations/moundV2ShadowJobsPersistence.test.ts

import {
  ensureMoundV2ShadowJobsPersistenceSchema,
  MOUND_V2_SHADOW_JOBS_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./moundV2ShadowJobsPersistence";

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

const ALL_SQL = MOUND_V2_SHADOW_JOBS_PERSISTENCE_STATEMENTS.join("\n").toUpperCase();

// ── 1. Table is created ─────────────────────────────────────────────────────
{
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS MOUND_V2_SHADOW_JOBS"), "mound_v2_shadow_jobs table is created");
  ok(ALL_SQL.includes("JOB_ID TEXT PRIMARY KEY"), "job_id is the primary key");
  ok(ALL_SQL.includes("SNAPSHOT_ID TEXT NOT NULL UNIQUE"), "snapshot_id is UNIQUE — idempotent enqueue by construction");
}

// ── 2. Every statement is idempotent (IF NOT EXISTS-guarded), no destructive ALTERs ──
{
  for (const statement of MOUND_V2_SHADOW_JOBS_PERSISTENCE_STATEMENTS) {
    const upper = statement.toUpperCase();
    const isTable = upper.includes("CREATE TABLE");
    const isIndex = upper.includes("CREATE INDEX") || upper.includes("CREATE UNIQUE INDEX");
    ok(isTable || isIndex, `every statement is a CREATE TABLE or CREATE INDEX (no ALTER at all in this fresh table): ${statement.trim().slice(0, 60)}...`);
    ok(upper.includes("IF NOT EXISTS"), `statement is IF NOT EXISTS-guarded: ${statement.trim().slice(0, 60)}...`);
  }
}

// ── 3. Required indexes exist ───────────────────────────────────────────────
{
  ok(ALL_SQL.includes("MOUND_V2_SHADOW_JOBS_STATUS_IDX"), "status index exists — the worker's claim query filters on status");
  ok(ALL_SQL.includes("MOUND_V2_SHADOW_JOBS_ENQUEUED_AT_IDX"), "enqueued_at index exists — claim ordering + staleness queries");
  ok(ALL_SQL.includes("MOUND_V2_SHADOW_JOBS_GAME_PITCHER_IDX"), "game_id/pitcher_id index exists");
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
  await ensureMoundV2ShadowJobsPersistenceSchema(client);
  const firstRunCount = client.executed.length;
  ok(firstRunCount === MOUND_V2_SHADOW_JOBS_PERSISTENCE_STATEMENTS.length, "first run executes every statement exactly once");

  await ensureMoundV2ShadowJobsPersistenceSchema(client);
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
    await ensureMoundV2ShadowJobsPersistenceSchema(new FailingExecutor());
  } catch {
    threw = true;
  }
  ok(threw, "a query failure propagates out of ensureMoundV2ShadowJobsPersistenceSchema rather than being swallowed");
}

console.log(`\nmoundV2ShadowJobsPersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
