// MLB Live Edge Stage C — calibration-artifacts schema bootstrap invariants.
//
// Run: npx tsx server/dbMigrations/mlbCalibrationArtifactsPersistence.test.ts

import {
  ensureMlbCalibrationArtifactsSchema,
  MLB_CALIBRATION_ARTIFACTS_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./mlbCalibrationArtifactsPersistence";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

class RecordingExecutor implements SqlExecutor {
  public executed: string[] = [];
  async query(sql: string): Promise<unknown> { this.executed.push(sql); return undefined; }
}

const ALL_SQL = MLB_CALIBRATION_ARTIFACTS_PERSISTENCE_STATEMENTS.join("\n").toUpperCase();

// 1. Table + PK + load-bearing columns
{
  ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS MLB_CALIBRATION_ARTIFACTS"), "table created");
  ok(ALL_SQL.includes("ARTIFACT_ID TEXT PRIMARY KEY"), "artifact_id PK (append-only; re-insert fails the key, not overwrites)");
  ok(ALL_SQL.includes("SEGMENT TEXT NOT NULL") && ALL_SQL.includes("ARTIFACT JSONB NOT NULL"), "segment + artifact jsonb NOT NULL");
  ok(ALL_SQL.includes("PROMOTION_READY BOOLEAN NOT NULL DEFAULT FALSE"), "promotion_ready defaults false (fail-closed)");
}

// 2. Idempotent IF NOT EXISTS only
{
  for (const s of MLB_CALIBRATION_ARTIFACTS_PERSISTENCE_STATEMENTS) {
    const u = s.toUpperCase();
    ok(u.includes("CREATE TABLE") || u.includes("CREATE INDEX"), `CREATE TABLE/INDEX only: ${s.trim().slice(0, 50)}...`);
    ok(u.includes("IF NOT EXISTS"), `IF NOT EXISTS guarded: ${s.trim().slice(0, 50)}...`);
  }
}

// 3. Required indexes by name
{
  ok(ALL_SQL.includes("MLB_CALIBRATION_ARTIFACTS_SEGMENT_IDX"), "segment index");
  ok(ALL_SQL.includes("MLB_CALIBRATION_ARTIFACTS_BUILT_AT_IDX"), "built_at index");
  ok(ALL_SQL.includes("MLB_CALIBRATION_ARTIFACTS_SEGMENT_BUILT_AT_IDX") && ALL_SQL.includes("ON MLB_CALIBRATION_ARTIFACTS (SEGMENT, BUILT_AT)"), "segment/built_at composite (latest-per-segment)");
}

// 4. No destructive SQL
{
  ok(!/\bDROP\b/.test(ALL_SQL) && !/\bTRUNCATE\b/.test(ALL_SQL) && !/\bDELETE\s+FROM\b/.test(ALL_SQL) && !/\bRENAME\b/.test(ALL_SQL) && !/DROP\s+COLUMN/.test(ALL_SQL), "no destructive statements");
}

// 5. Idempotent double-run
{
  const c = new RecordingExecutor();
  await ensureMlbCalibrationArtifactsSchema(c);
  const n = c.executed.length;
  ok(n === MLB_CALIBRATION_ARTIFACTS_PERSISTENCE_STATEMENTS.length, "first run executes each once");
  await ensureMlbCalibrationArtifactsSchema(c);
  ok(c.executed.length === n * 2 && c.executed.slice(0, n).join("\n") === c.executed.slice(n).join("\n"), "second run byte-identical (idempotent)");
}

// 6. Failure propagates
{
  class Failing implements SqlExecutor { async query(): Promise<unknown> { throw new Error("boom"); } }
  let threw = false;
  try { await ensureMlbCalibrationArtifactsSchema(new Failing()); } catch { threw = true; }
  ok(threw, "a query failure propagates (must fail startup)");
}

console.log(`\nmlbCalibrationArtifactsPersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
