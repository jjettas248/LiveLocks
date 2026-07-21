// HR Radar research schema bootstrap — invariants.
//
// This sandbox has no live Postgres instance, so these tests exercise the
// migration against a recording fake `SqlExecutor` rather than a real
// database: (1) every required table/index/constraint is present in the
// emitted SQL, (2) every CREATE is guarded with IF NOT EXISTS so running the
// bootstrap twice back-to-back never throws (idempotent), and (3) no
// destructive statement is ever emitted.
//
// Run: npx tsx server/dbMigrations/hrRadarResearchPersistence.test.ts

import {
  ensureHrRadarResearchPersistenceSchema,
  HR_RADAR_RESEARCH_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./hrRadarResearchPersistence";

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

const ALL_SQL = HR_RADAR_RESEARCH_PERSISTENCE_STATEMENTS.join("\n").toUpperCase();

// ── 1. All five tables are created ──────────────────────────────────────────
{
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS HR_RADAR_EVALUATION_SNAPSHOTS"), "hr_radar_evaluation_snapshots table is created");
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS HR_RADAR_EVALUATION_LABELS"), "hr_radar_evaluation_labels table is created");
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS HR_RADAR_SHADOW_PREDICTIONS"), "hr_radar_shadow_predictions table is created");
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS HR_RADAR_SHADOW_DECISIONS"), "hr_radar_shadow_decisions table is created");
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS HR_RADAR_MODEL_REGISTRY"), "hr_radar_model_registry table is created");
}

// Returns true only if every ADD-COLUMN clause in an ALTER TABLE statement is
// additive (`ADD COLUMN IF NOT EXISTS ...`).
function isSelfHealOnlyAlter(statement: string): boolean {
  const upper = statement.toUpperCase().trim().replace(/;\s*$/, "");
  const match = upper.match(/^ALTER TABLE\s+\S+\s+([\s\S]+)$/);
  if (!match) return false;
  const clauses = match[1].split(",").map((c) => c.trim());
  return clauses.length > 0 && clauses.every((c) => c.startsWith("ADD COLUMN IF NOT EXISTS"));
}

// ── 2. Every statement is idempotent (IF NOT EXISTS-guarded) ───────────────
// This PR ships no ALTER TABLE statements at all (all five tables are brand
// new — there is no pre-existing older shape to self-heal from), but the
// guard is kept here so a future PR that adds one is held to the same bar.
{
  for (const statement of HR_RADAR_RESEARCH_PERSISTENCE_STATEMENTS) {
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

// ── 3. Required indexes and constraints exist, matching shared/schema.ts ───
{
  ok(
    ALL_SQL.includes("HR_RADAR_EVAL_SNAPSHOTS_EPOCH_UNIQUE_IDX") &&
    ALL_SQL.includes("EVALUATION_EPOCH_ID, PLAYER_ID, FEATURE_VERSION, SOURCE_REVISION"),
    "hr_radar_evaluation_snapshots unique index covers (evaluation_epoch_id, player_id, feature_version, source_revision)",
  );
  ok(ALL_SQL.includes("HR_RADAR_EVAL_SNAPSHOTS_EPOCH_IDX"), "hr_radar_evaluation_snapshots epoch index exists");
  ok(ALL_SQL.includes("HR_RADAR_EVAL_SNAPSHOTS_SESSION_GAME_EVAL_IDX"), "hr_radar_evaluation_snapshots session/game/eval index exists");
  ok(ALL_SQL.includes("HR_RADAR_EVAL_SNAPSHOTS_GAME_PLAYER_EVAL_IDX"), "hr_radar_evaluation_snapshots game/player/eval index exists");
  ok(ALL_SQL.includes("HR_RADAR_EVAL_SNAPSHOTS_FEATURE_VERSION_EVAL_IDX"), "hr_radar_evaluation_snapshots feature-version/eval index exists");
  ok(
    ALL_SQL.includes("HR_RADAR_EVAL_SNAPSHOTS_ELIGIBLE_UNLABELED_LOOKUP_IDX") &&
    ALL_SQL.includes("ELIGIBLE, SESSION_DATE, SNAPSHOT_ID"),
    "hr_radar_evaluation_snapshots eligible-unlabeled lookup index covers (eligible, session_date, snapshot_id) — plain, not partial",
  );

  ok(
    ALL_SQL.includes("PRIMARY KEY (SNAPSHOT_ID, LABEL_VERSION)"),
    "hr_radar_evaluation_labels declares a composite PRIMARY KEY (snapshot_id, label_version) — append-only versioning",
  );
  ok(ALL_SQL.includes("HR_RADAR_EVAL_LABELS_DISPOSITION_IDX"), "hr_radar_evaluation_labels label_disposition index exists");
  ok(ALL_SQL.includes("HR_RADAR_EVAL_LABELS_RESOLVED_AT_IDX"), "hr_radar_evaluation_labels resolved_at index exists");
  ok(ALL_SQL.includes("HR_RADAR_EVAL_LABELS_SNAPSHOT_IDX"), "hr_radar_evaluation_labels snapshot_id index exists");

  ok(
    ALL_SQL.includes("HR_RADAR_SHADOW_PREDICTIONS_SNAPSHOT_MODEL_UNIQUE_IDX") &&
    ALL_SQL.includes("ON HR_RADAR_SHADOW_PREDICTIONS (SNAPSHOT_ID, MODEL_VERSION)"),
    "hr_radar_shadow_predictions unique index covers (snapshot_id, model_version)",
  );
  ok(ALL_SQL.includes("HR_RADAR_SHADOW_PREDICTIONS_MODEL_VERSION_IDX"), "hr_radar_shadow_predictions model_version index exists");
  ok(ALL_SQL.includes("HR_RADAR_SHADOW_PREDICTIONS_SNAPSHOT_IDX"), "hr_radar_shadow_predictions snapshot_id index exists");

  ok(
    ALL_SQL.includes("HR_RADAR_SHADOW_DECISIONS_SNAPSHOT_MODEL_POLICY_UNIQUE_IDX") &&
    ALL_SQL.includes("ON HR_RADAR_SHADOW_DECISIONS (SNAPSHOT_ID, MODEL_VERSION, POLICY_VERSION)"),
    "hr_radar_shadow_decisions unique index covers (snapshot_id, model_version, policy_version)",
  );
  ok(ALL_SQL.includes("HR_RADAR_SHADOW_DECISIONS_MODEL_POLICY_IDX"), "hr_radar_shadow_decisions model/policy index exists");
  ok(ALL_SQL.includes("HR_RADAR_SHADOW_DECISIONS_SNAPSHOT_IDX"), "hr_radar_shadow_decisions snapshot_id index exists");
  ok(
    ALL_SQL.includes("HR_RADAR_SHADOW_DECISIONS_STAGE_TRANSITION_IDX") &&
    ALL_SQL.includes("ON HR_RADAR_SHADOW_DECISIONS (PROPOSED_STAGE, STAGE_TRANSITIONED)"),
    "hr_radar_shadow_decisions stage-transition index covers (proposed_stage, stage_transitioned) — supports first-Fire counting",
  );

  ok(ALL_SQL.includes("HR_RADAR_MODEL_REGISTRY_STATUS_IDX"), "hr_radar_model_registry status index exists");
  ok(ALL_SQL.includes("HR_RADAR_MODEL_REGISTRY_FEATURE_VERSION_IDX"), "hr_radar_model_registry feature_version index exists");
}

// ── 4. No destructive statement anywhere in the migration ──────────────────
{
  ok(!/\bDROP\b/.test(ALL_SQL), "no DROP statement anywhere in the migration");
  ok(!/\bTRUNCATE\b/.test(ALL_SQL), "no TRUNCATE statement anywhere in the migration");
  ok(!/\bDELETE\s+FROM\b/.test(ALL_SQL), "no DELETE FROM statement anywhere in the migration");
  ok(!/\bRENAME\b/.test(ALL_SQL), "no RENAME statement anywhere in the migration");
  ok(!/ALTER\s+COLUMN[\s\S]*?\bTYPE\b/.test(ALL_SQL), "no destructive ALTER COLUMN ... TYPE change anywhere in the migration");
  ok(!/DROP\s+COLUMN/.test(ALL_SQL), "no DROP COLUMN anywhere in the migration");
  for (const statement of HR_RADAR_RESEARCH_PERSISTENCE_STATEMENTS) {
    if (statement.toUpperCase().includes("ALTER TABLE")) {
      ok(isSelfHealOnlyAlter(statement), "every ALTER TABLE statement is additive ADD COLUMN IF NOT EXISTS only (aggregate check)");
    }
  }
}

// ── 5. Running the bootstrap twice back-to-back never throws ───────────────
{
  const client = new RecordingExecutor();
  await ensureHrRadarResearchPersistenceSchema(client);
  const firstRunCount = client.executed.length;
  ok(firstRunCount === HR_RADAR_RESEARCH_PERSISTENCE_STATEMENTS.length, "first run executes every statement exactly once");

  await ensureHrRadarResearchPersistenceSchema(client);
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
    await ensureHrRadarResearchPersistenceSchema(new FailingExecutor());
  } catch {
    threw = true;
  }
  ok(threw, "a query failure propagates out of ensureHrRadarResearchPersistenceSchema rather than being swallowed");
}

console.log(`\nhrRadarResearchPersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
