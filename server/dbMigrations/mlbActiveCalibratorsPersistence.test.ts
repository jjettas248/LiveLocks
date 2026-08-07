// MLB Live Edge Stage C PR3 — active-calibrator registry schema bootstrap.
//
// Run: npx tsx server/dbMigrations/mlbActiveCalibratorsPersistence.test.ts

import {
  ensureMlbActiveCalibratorsSchema,
  MLB_ACTIVE_CALIBRATORS_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./mlbActiveCalibratorsPersistence";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

class RecordingExecutor implements SqlExecutor {
  public executed: string[] = [];
  async query(sql: string): Promise<unknown> { this.executed.push(sql); return undefined; }
}

const ALL_SQL = MLB_ACTIVE_CALIBRATORS_PERSISTENCE_STATEMENTS.join("\n").toUpperCase();

// 1. Table + PK + load-bearing columns
{
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS MLB_ACTIVE_CALIBRATORS"), "table created");
  ok(ALL_SQL.includes("SEGMENT TEXT PRIMARY KEY"), "segment PK (one active row per segment; promotion upserts)");
  ok(ALL_SQL.includes("ARTIFACT_ID TEXT NOT NULL") && ALL_SQL.includes("ARTIFACT JSONB NOT NULL"), "artifact_id + artifact jsonb NOT NULL (registry loads without a join)");
  ok(ALL_SQL.includes("ACTIVE BOOLEAN NOT NULL DEFAULT TRUE"), "active defaults true");
  ok(ALL_SQL.includes("ACTIVATED_AT TIMESTAMP NOT NULL") && ALL_SQL.includes("ACTIVATED_BY TEXT NOT NULL"), "activation provenance NOT NULL");
  ok(ALL_SQL.includes("DEACTIVATED_AT TIMESTAMP") && ALL_SQL.includes("DEACTIVATION_REASON TEXT"), "deactivation audit columns present (row kept, never deleted)");
}

// 2. Idempotent IF NOT EXISTS only
{
  for (const s of MLB_ACTIVE_CALIBRATORS_PERSISTENCE_STATEMENTS) {
    const u = s.toUpperCase();
    ok(u.includes("CREATE TABLE") || u.includes("CREATE INDEX"), `CREATE TABLE/INDEX only: ${s.trim().slice(0, 50)}...`);
    ok(u.includes("IF NOT EXISTS"), `IF NOT EXISTS guarded: ${s.trim().slice(0, 50)}...`);
  }
}

// 3. Required index by name
{
  ok(ALL_SQL.includes("MLB_ACTIVE_CALIBRATORS_ACTIVE_IDX") && ALL_SQL.includes("ON MLB_ACTIVE_CALIBRATORS (ACTIVE)"), "active index (registry load reads active rows)");
}

// 4. No destructive SQL
{
  ok(!/\bDROP\b/.test(ALL_SQL) && !/\bTRUNCATE\b/.test(ALL_SQL) && !/\bDELETE\s+FROM\b/.test(ALL_SQL) && !/\bRENAME\b/.test(ALL_SQL) && !/DROP\s+COLUMN/.test(ALL_SQL), "no destructive statements");
}

// 5. Idempotent double-run
{
  const c = new RecordingExecutor();
  await ensureMlbActiveCalibratorsSchema(c);
  const n = c.executed.length;
  ok(n === MLB_ACTIVE_CALIBRATORS_PERSISTENCE_STATEMENTS.length, "first run executes each once");
  await ensureMlbActiveCalibratorsSchema(c);
  ok(c.executed.length === n * 2 && c.executed.slice(0, n).join("\n") === c.executed.slice(n).join("\n"), "second run byte-identical (idempotent)");
}

// 6. Failure propagates
{
  class Failing implements SqlExecutor { async query(): Promise<unknown> { throw new Error("boom"); } }
  let threw = false;
  try { await ensureMlbActiveCalibratorsSchema(new Failing()); } catch { threw = true; }
  ok(threw, "a query failure propagates (must fail startup)");
}

console.log(`\nmlbActiveCalibratorsPersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
