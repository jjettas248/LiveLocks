// Run: npx tsx server/dbMigrations/pregameTargetsFoundationPersistence.test.ts
import {
  ensurePregameTargetsFoundationSchema,
  PREGAME_TARGETS_FOUNDATION_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./pregameTargetsFoundationPersistence";

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

const STMTS = PREGAME_TARGETS_FOUNDATION_PERSISTENCE_STATEMENTS;
const ALL_SQL = STMTS.join("\n").toUpperCase();

// ── Tables + primary keys present ────────────────────────────────────────────
{
  for (const table of [
    "pregame_raw_source_snapshots",
    "pregame_feature_snapshots",
    "pregame_posterior_states",
  ]) {
    ok(ALL_SQL.includes(`CREATE TABLE IF NOT EXISTS ${table.toUpperCase()}`), `${table}: CREATE TABLE IF NOT EXISTS`);
  }
  ok(ALL_SQL.includes("SNAPSHOT_ID TEXT PRIMARY KEY"), "raw snapshots have a primary key");
  ok(ALL_SQL.includes("FEATURE_ROW_ID TEXT PRIMARY KEY"), "feature snapshots have a primary key");
  ok(ALL_SQL.includes("POSTERIOR_ID TEXT PRIMARY KEY"), "posterior states have a primary key");
  // The value column must be NULLABLE so "missing" is never stored as 0.
  ok(/VALUE NUMERIC(?!\s+NOT NULL)/.test(ALL_SQL), "feature value column is nullable (missing != 0)");
}

// ── Every required index exists, by exact name (matches schema.ts) ───────────
{
  const requiredIndexes = [
    "pregame_raw_source_snapshots_sport_kind_idx",
    "pregame_raw_source_snapshots_known_at_idx",
    "pregame_raw_source_snapshots_source_key_idx",
    "pregame_raw_source_snapshots_source_content_uidx",
    "pregame_feature_snapshots_entity_feature_known_at_idx",
    "pregame_feature_snapshots_sport_feature_idx",
    "pregame_feature_snapshots_season_idx",
    "pregame_posterior_states_entity_feature_version_uidx",
    "pregame_posterior_states_sport_feature_idx",
  ];
  for (const idx of requiredIndexes) {
    ok(ALL_SQL.includes(idx.toUpperCase()), `index present: ${idx}`);
  }
  // The as-of read path index must be composite over (entity, feature, known_at).
  ok(
    /PREGAME_FEATURE_SNAPSHOTS_ENTITY_FEATURE_KNOWN_AT_IDX[\s\S]*?\(ENTITY_CANONICAL_ID, FEATURE_KEY, KNOWN_AT\)/.test(ALL_SQL),
    "as-of read index is composite (entity_canonical_id, feature_key, known_at)",
  );
  // The two uniqueness guarantees are UNIQUE indexes.
  ok(/CREATE UNIQUE INDEX IF NOT EXISTS PREGAME_RAW_SOURCE_SNAPSHOTS_SOURCE_CONTENT_UIDX/.test(ALL_SQL), "snapshot uniqueness is a UNIQUE index");
  // Snapshot uniqueness is scoped to the SOURCE, not the payload alone — so two
  // different source_key requests returning the same payload never collide.
  ok(
    /PREGAME_RAW_SOURCE_SNAPSHOTS_SOURCE_CONTENT_UIDX[\s\S]*?\(SOURCE_KIND, SOURCE_KEY, CONTENT_HASH\)/.test(ALL_SQL),
    "snapshot uniqueness is composite (source_kind, source_key, content_hash)",
  );
  ok(/CREATE UNIQUE INDEX IF NOT EXISTS PREGAME_POSTERIOR_STATES_ENTITY_FEATURE_VERSION_UIDX/.test(ALL_SQL), "posterior identity is a UNIQUE index");
  // Absolute instants must be timezone-aware so a round trip can't shift the cutoff.
  ok(!/VALID_AT TIMESTAMP\b(?!TZ)/.test(ALL_SQL) && /VALID_AT TIMESTAMPTZ/.test(ALL_SQL), "valid_at is TIMESTAMPTZ");
  ok(!/KNOWN_AT TIMESTAMP\b(?!TZ)/.test(ALL_SQL) && /KNOWN_AT TIMESTAMPTZ/.test(ALL_SQL), "known_at is TIMESTAMPTZ");
}

// ── IF-NOT-EXISTS only; every statement is CREATE TABLE / CREATE INDEX ────────
{
  for (const stmt of STMTS) {
    const u = stmt.toUpperCase();
    const isCreateTable = u.includes("CREATE TABLE IF NOT EXISTS");
    const isCreateIndex = /CREATE (UNIQUE )?INDEX IF NOT EXISTS/.test(u);
    ok(isCreateTable || isCreateIndex, "statement is a CREATE TABLE/INDEX IF NOT EXISTS");
  }
  ok(!/ALTER TABLE/.test(ALL_SQL), "no ALTER in PR1 (no existing table touched)");
}

// ── No destructive SQL ───────────────────────────────────────────────────────
{
  ok(!/\bDROP\b/.test(ALL_SQL), "no DROP");
  ok(!/\bTRUNCATE\b/.test(ALL_SQL), "no TRUNCATE");
  ok(!/\bDELETE\s+FROM\b/.test(ALL_SQL), "no DELETE FROM");
  ok(!/\bRENAME\b/.test(ALL_SQL), "no RENAME");
  ok(!/ALTER\s+COLUMN[\s\S]*?\bTYPE\b/.test(ALL_SQL), "no destructive ALTER COLUMN ... TYPE");
  ok(!/DROP\s+COLUMN/.test(ALL_SQL), "no DROP COLUMN");
}

// ── Idempotence: re-running executes the same statements byte-for-byte ────────
{
  const rec = new RecordingExecutor();
  await ensurePregameTargetsFoundationSchema(rec);
  const n = STMTS.length;
  ok(rec.executed.length === n, "first run executes exactly one query per statement");
  await ensurePregameTargetsFoundationSchema(rec);
  ok(rec.executed.length === 2 * n, "second run executes the same count again (no throw)");
  ok(
    rec.executed.slice(0, n).join("\n") === rec.executed.slice(n).join("\n"),
    "the two runs are byte-identical (pure idempotent bootstrap)",
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
    await ensurePregameTargetsFoundationSchema(new FailingExecutor());
  } catch {
    threw = true;
  }
  ok(threw, "a query failure propagates (no try/catch swallowing)");
}

console.log(`\npregameTargetsFoundationPersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
