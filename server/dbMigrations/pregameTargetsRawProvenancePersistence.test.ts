// Run: npx tsx server/dbMigrations/pregameTargetsRawProvenancePersistence.test.ts
// Pregame Targets PR5 (audit-3) — raw-snapshot audit-metadata + correction-lineage
// bootstrap: idempotent, ADD-COLUMN-IF-NOT-EXISTS-only (additive), required columns by
// exact name (matching schema.ts), a partial supersedes index, and no destructive SQL.
import {
  ensurePregameTargetsRawProvenanceColumns,
  PREGAME_TARGETS_RAW_PROVENANCE_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./pregameTargetsRawProvenancePersistence";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

class RecordingExecutor implements SqlExecutor {
  public executed: string[] = [];
  async query(sql: string): Promise<unknown> { this.executed.push(sql); return undefined; }
}

const STMTS = PREGAME_TARGETS_RAW_PROVENANCE_PERSISTENCE_STATEMENTS;
const ALL_SQL = STMTS.join("\n").toUpperCase();

// ── The three columns are added, by exact name + type (matches schema.ts) ───
{
  const required: Array<[string, string]> = [
    ["source_published_at", "TIMESTAMPTZ"],
    ["known_at_policy_version", "TEXT"],
    ["supersedes_snapshot_id", "TEXT"],
  ];
  for (const [col, type] of required) {
    ok(new RegExp(`ADD COLUMN IF NOT EXISTS ${col.toUpperCase()} ${type}\\b`).test(ALL_SQL), `adds ${col} ${type}`);
  }
  ok(/ALTER TABLE PREGAME_RAW_SOURCE_SNAPSHOTS/.test(ALL_SQL), "targets pregame_raw_source_snapshots only");
}

// ── Partial supersedes index for chain traversal ────────────────────────────
{
  ok(/CREATE INDEX IF NOT EXISTS PREGAME_RAW_SOURCE_SNAPSHOTS_SUPERSEDES_IDX/.test(ALL_SQL), "creates the supersedes index (IF NOT EXISTS)");
  ok(/WHERE SUPERSEDES_SNAPSHOT_ID IS NOT NULL/.test(ALL_SQL), "supersedes index is partial (non-null predecessors only)");
}

// ── Additive only: every ALTER is ADD COLUMN IF NOT EXISTS; NO destructive SQL ─
{
  for (const s of STMTS) {
    const up = s.toUpperCase();
    if (up.includes("ALTER TABLE")) ok(up.includes("ADD COLUMN IF NOT EXISTS"), "every ALTER is ADD COLUMN IF NOT EXISTS");
  }
  const destructive = /\bDROP\b|\bTRUNCATE\b|DELETE FROM|ALTER COLUMN|RENAME|\bUPDATE\b/;
  ok(!destructive.test(ALL_SQL), "no destructive SQL (no DROP/TRUNCATE/DELETE/ALTER COLUMN/RENAME/UPDATE)");
  ok(!/CREATE TABLE/.test(ALL_SQL), "no CREATE TABLE (table already exists via the foundation migration)");
}

// ── Idempotent: running twice issues the identical statements, no error ──────
{
  const ex = new RecordingExecutor();
  await ensurePregameTargetsRawProvenanceColumns(ex);
  const firstRun = [...ex.executed];
  await ensurePregameTargetsRawProvenanceColumns(ex);
  ok(firstRun.length === STMTS.length, "one query per statement");
  ok(ex.executed.length === STMTS.length * 2, "second run re-issues the same idempotent statements");
  ok(JSON.stringify(ex.executed.slice(0, STMTS.length)) === JSON.stringify(firstRun), "identical statements across runs");
}

// ── A bootstrap failure PROPAGATES (must fail startup, never silently swallow) ─
{
  class Boom implements SqlExecutor { async query(): Promise<unknown> { throw new Error("db down"); } }
  let threw = false;
  try { await ensurePregameTargetsRawProvenanceColumns(new Boom()); } catch { threw = true; }
  ok(threw, "a query failure propagates (no try/catch swallow)");
}

console.log(`\npregameTargetsRawProvenancePersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
