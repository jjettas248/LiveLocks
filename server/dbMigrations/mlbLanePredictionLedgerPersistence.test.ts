// MLB Live Edge Stage B — prediction-ledger schema bootstrap invariants.
//
// No live Postgres here, so this runs the migration against a recording fake
// SqlExecutor: (1) the table/indexes appear in the emitted SQL, (2) every CREATE
// is IF NOT EXISTS-guarded so running twice never throws (idempotent), (3) no
// destructive statement is ever emitted, and (4) a query failure propagates
// (must fail startup). Mirrors mlbRecommendationEpisodePersistence.test.ts.
//
// Run: npx tsx server/dbMigrations/mlbLanePredictionLedgerPersistence.test.ts

import {
  ensureMlbLanePredictionLedgerSchema,
  MLB_LANE_PREDICTION_LEDGER_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./mlbLanePredictionLedgerPersistence";

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

const ALL_SQL = MLB_LANE_PREDICTION_LEDGER_PERSISTENCE_STATEMENTS.join("\n").toUpperCase();

// ── 1. Table is created + append-only PK ────────────────────────────────────
{
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS MLB_LANE_PREDICTIONS"), "mlb_lane_predictions table is created");
  ok(ALL_SQL.includes("PREDICTION_ID TEXT PRIMARY KEY"), "prediction_id is the PK — a re-insert of the same capture fails the key rather than overwriting a frozen row");
  // A few load-bearing columns are present with the expected null-ness.
  ok(ALL_SQL.includes("SIGNAL_ID TEXT NOT NULL"), "signal_id NOT NULL (grouping key)");
  ok(ALL_SQL.includes("LANE TEXT NOT NULL"), "lane NOT NULL (all-lane capture)");
  ok(ALL_SQL.includes("CANDIDATE_PROBABILITY_PCT NUMERIC NOT NULL"), "candidate_probability_pct NOT NULL (the prediction)");
  ok(ALL_SQL.includes("STATUS TEXT NOT NULL DEFAULT 'CAPTURED'"), "status defaults to 'captured'");
  ok(ALL_SQL.includes("SETTLEMENT_RESULT TEXT") && ALL_SQL.includes("FINAL_STAT NUMERIC") && ALL_SQL.includes("VOID_REASON TEXT"), "settlement columns nullable (unset at capture)");
}

// ── 2. Every statement is idempotent (IF NOT EXISTS-guarded) ────────────────
function isSelfHealOnlyAlter(statement: string): boolean {
  const upper = statement.toUpperCase().trim().replace(/;\s*$/, "");
  const match = upper.match(/^ALTER TABLE\s+\S+\s+([\s\S]+)$/);
  if (!match) return false;
  const clauses = match[1].split(",").map((c) => c.trim());
  return clauses.length > 0 && clauses.every((c) => c.startsWith("ADD COLUMN IF NOT EXISTS"));
}
{
  for (const statement of MLB_LANE_PREDICTION_LEDGER_PERSISTENCE_STATEMENTS) {
    const upper = statement.toUpperCase();
    const isTable = upper.includes("CREATE TABLE");
    const isIndex = upper.includes("CREATE INDEX") || upper.includes("CREATE UNIQUE INDEX");
    const isAlter = upper.includes("ALTER TABLE");
    ok(isTable || isIndex || isAlter, `every statement is CREATE TABLE / CREATE INDEX / ALTER TABLE: ${statement.trim().slice(0, 60)}...`);
    if (isAlter) ok(isSelfHealOnlyAlter(statement), `ALTER is additive ADD COLUMN IF NOT EXISTS only: ${statement.trim().slice(0, 80)}...`);
    ok(upper.includes("IF NOT EXISTS"), `statement is IF NOT EXISTS-guarded: ${statement.trim().slice(0, 60)}...`);
  }
}

// ── 3. Required indexes exist by name ───────────────────────────────────────
{
  ok(ALL_SQL.includes("MLB_LANE_PREDICTIONS_GAME_ID_IDX"), "game_id index exists");
  ok(ALL_SQL.includes("MLB_LANE_PREDICTIONS_SIGNAL_ID_IDX"), "signal_id index exists");
  ok(ALL_SQL.includes("MLB_LANE_PREDICTIONS_STATUS_IDX"), "status index exists");
  ok(ALL_SQL.includes("MLB_LANE_PREDICTIONS_LANE_IDX"), "lane index exists");
  ok(
    ALL_SQL.includes("MLB_LANE_PREDICTIONS_STATUS_CAPTURED_AT_IDX") &&
    ALL_SQL.includes("ON MLB_LANE_PREDICTIONS (STATUS, CAPTURED_AT)"),
    "status/captured_at composite index exists (sweep scans captured oldest-first)",
  );
}

// ── 4. No destructive statement anywhere ────────────────────────────────────
{
  ok(!/\bDROP\b/.test(ALL_SQL), "no DROP statement anywhere");
  ok(!/\bTRUNCATE\b/.test(ALL_SQL), "no TRUNCATE statement anywhere");
  ok(!/\bDELETE\s+FROM\b/.test(ALL_SQL), "no DELETE FROM statement anywhere");
  ok(!/\bRENAME\b/.test(ALL_SQL), "no RENAME statement anywhere");
  ok(!/ALTER\s+COLUMN[\s\S]*?\bTYPE\b/.test(ALL_SQL), "no destructive ALTER COLUMN ... TYPE change");
  ok(!/DROP\s+COLUMN/.test(ALL_SQL), "no DROP COLUMN anywhere");
}

// ── 5. Running the bootstrap twice back-to-back never throws ─────────────────
{
  const client = new RecordingExecutor();
  await ensureMlbLanePredictionLedgerSchema(client);
  const firstRunCount = client.executed.length;
  ok(firstRunCount === MLB_LANE_PREDICTION_LEDGER_PERSISTENCE_STATEMENTS.length, "first run executes every statement exactly once");
  await ensureMlbLanePredictionLedgerSchema(client);
  ok(client.executed.length === firstRunCount * 2, "second run re-issues the same statement set without throwing (idempotent)");
  ok(
    client.executed.slice(0, firstRunCount).join("\n") === client.executed.slice(firstRunCount).join("\n"),
    "the second run's statements are byte-identical to the first run's",
  );
}

// ── 6. A failure from the executor propagates (must fail startup) ────────────
{
  class FailingExecutor implements SqlExecutor {
    async query(): Promise<unknown> { throw new Error("simulated connection failure"); }
  }
  let threw = false;
  try { await ensureMlbLanePredictionLedgerSchema(new FailingExecutor()); } catch { threw = true; }
  ok(threw, "a query failure propagates rather than being swallowed");
}

console.log(`\nmlbLanePredictionLedgerPersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
