// Run: npx tsx server/dbMigrations/pregameTargetsProvenancePersistence.test.ts
import {
  ensurePregameTargetsProvenanceColumns,
  PREGAME_TARGETS_PROVENANCE_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./pregameTargetsProvenancePersistence";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

class RecordingExecutor implements SqlExecutor {
  public executed: string[] = [];
  async query(sql: string): Promise<unknown> {
    this.executed.push(sql);
    return undefined;
  }
}

const STMTS = PREGAME_TARGETS_PROVENANCE_PERSISTENCE_STATEMENTS;
const ALL_SQL = STMTS.join("\n").toUpperCase();

// ── All five provenance columns are added, by exact name (matches schema.ts) ─
{
  const requiredColumns: Array<[string, string]> = [
    ["surface", "TEXT"],
    ["projection_snapshot_id", "TEXT"],
    ["decision_snapshot_id", "TEXT"],
    ["target_tier", "TEXT"],
    ["role_certainty", "NUMERIC"],
  ];
  for (const [col, type] of requiredColumns) {
    ok(
      new RegExp(`ADD COLUMN IF NOT EXISTS ${col.toUpperCase()} ${type}\\b`).test(ALL_SQL),
      `column added (nullable, no default): ${col} ${type}`,
    );
  }
  ok(STMTS.length === requiredColumns.length, "exactly one statement per provenance column");
}

// ── Additive self-heal only: ALTER … ADD COLUMN IF NOT EXISTS on persisted_plays
{
  for (const stmt of STMTS) {
    const u = stmt.toUpperCase();
    ok(u.includes("ALTER TABLE PERSISTED_PLAYS"), "statement targets persisted_plays");
    ok(u.includes("ADD COLUMN IF NOT EXISTS"), "statement is ADD COLUMN IF NOT EXISTS");
  }
  // These columns must be NULLABLE with no default — an existing row / a product
  // that does not emit them stays null (no backfill, no fabrication).
  ok(!/\bNOT NULL\b/.test(ALL_SQL), "no NOT NULL (columns are nullable)");
  ok(!/\bDEFAULT\b/.test(ALL_SQL), "no DEFAULT (no backfill of existing rows)");
  // Only persisted_plays is touched — no other table.
  ok(!/ALTER TABLE (?!PERSISTED_PLAYS\b)/.test(ALL_SQL), "no ALTER TABLE against any other table");
  ok(!/CREATE TABLE/.test(ALL_SQL), "no CREATE TABLE (persisted_plays already exists)");
}

// ── No destructive SQL (never rewrite/drop an existing column) ───────────────
{
  ok(!/\bDROP\b/.test(ALL_SQL), "no DROP");
  ok(!/\bTRUNCATE\b/.test(ALL_SQL), "no TRUNCATE");
  ok(!/\bDELETE\s+FROM\b/.test(ALL_SQL), "no DELETE FROM");
  ok(!/\bRENAME\b/.test(ALL_SQL), "no RENAME");
  ok(!/ALTER\s+COLUMN/.test(ALL_SQL), "no ALTER COLUMN (never rewrites an existing column)");
  ok(!/DROP\s+COLUMN/.test(ALL_SQL), "no DROP COLUMN");
}

// ── Idempotence: re-running executes the same statements byte-for-byte ────────
{
  const rec = new RecordingExecutor();
  await ensurePregameTargetsProvenanceColumns(rec);
  const n = STMTS.length;
  ok(rec.executed.length === n, "first run executes exactly one query per statement");
  await ensurePregameTargetsProvenanceColumns(rec);
  ok(rec.executed.length === 2 * n, "second run executes the same count again (no throw)");
  ok(
    rec.executed.slice(0, n).join("\n") === rec.executed.slice(n).join("\n"),
    "the two runs are byte-identical (pure idempotent self-heal)",
  );
}

// ── Failure propagates (must fail startup, not swallow) ───────────────────────
{
  class FailingExecutor implements SqlExecutor {
    async query(): Promise<unknown> {
      throw new Error("db down");
    }
  }
  let threw = false;
  try {
    await ensurePregameTargetsProvenanceColumns(new FailingExecutor());
  } catch {
    threw = true;
  }
  ok(threw, "a query failure propagates (no try/catch swallowing)");
}

console.log(`\npregameTargetsProvenancePersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
