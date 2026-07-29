// MLB Recommendation Episode schema bootstrap — invariants.
//
// This sandbox has no live Postgres instance, so these tests exercise the
// migration against a recording fake `SqlExecutor` rather than a real
// database: (1) the table/indexes are present in the emitted SQL, (2) every
// CREATE is guarded with IF NOT EXISTS so running the bootstrap twice
// back-to-back never throws (idempotent), and (3) no destructive statement
// is ever emitted. Mirrors hrRadarResearchPersistence.test.ts's convention.
//
// Run: npx tsx server/dbMigrations/mlbRecommendationEpisodePersistence.test.ts

import {
  ensureMlbRecommendationEpisodePersistenceSchema,
  MLB_RECOMMENDATION_EPISODE_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./mlbRecommendationEpisodePersistence";

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

const ALL_SQL = MLB_RECOMMENDATION_EPISODE_PERSISTENCE_STATEMENTS.join("\n").toUpperCase();

// ── 1. Table is created ─────────────────────────────────────────────────────
{
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS MLB_RECOMMENDATION_EPISODES"), "mlb_recommendation_episodes table is created");
  ok(ALL_SQL.includes("EPISODE_ID TEXT PRIMARY KEY"), "episode_id is the primary key — a re-create attempt fails the key rather than silently overwriting a frozen row");
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
  for (const statement of MLB_RECOMMENDATION_EPISODE_PERSISTENCE_STATEMENTS) {
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
  ok(ALL_SQL.includes("MLB_RECOMMENDATION_EPISODES_GAME_ID_IDX"), "game_id index exists");
  ok(ALL_SQL.includes("MLB_RECOMMENDATION_EPISODES_PLAYER_ID_IDX"), "player_id index exists");
  ok(
    ALL_SQL.includes("MLB_RECOMMENDATION_EPISODES_PRODUCT_STATUS_IDX") &&
    ALL_SQL.includes("ON MLB_RECOMMENDATION_EPISODES (PRODUCT, STATUS)"),
    "product/status composite index exists",
  );
  ok(ALL_SQL.includes("MLB_RECOMMENDATION_EPISODES_CREATED_AT_IDX"), "recommendation_created_at index exists");
  ok(ALL_SQL.includes("MLB_RECOMMENDATION_EPISODES_STATUS_IDX"), "status index exists");
  ok(ALL_SQL.includes("MLB_RECOMMENDATION_EPISODES_MODEL_VERSION_IDX"), "model_version index exists");
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
  await ensureMlbRecommendationEpisodePersistenceSchema(client);
  const firstRunCount = client.executed.length;
  ok(firstRunCount === MLB_RECOMMENDATION_EPISODE_PERSISTENCE_STATEMENTS.length, "first run executes every statement exactly once");

  await ensureMlbRecommendationEpisodePersistenceSchema(client);
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
    await ensureMlbRecommendationEpisodePersistenceSchema(new FailingExecutor());
  } catch {
    threw = true;
  }
  ok(threw, "a query failure propagates out of ensureMlbRecommendationEpisodePersistenceSchema rather than being swallowed");
}

console.log(`\nmlbRecommendationEpisodePersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
