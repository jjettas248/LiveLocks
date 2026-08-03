// Plate HR V2 append-only snapshot schema bootstrap — invariants.
//
// No live Postgres in the sandbox, so this exercises the migration against a
// recording fake SqlExecutor: (1) both tables + required indexes are emitted,
// (2) the append-only composite uniqueness index exists, (3) every CREATE is
// IF NOT EXISTS-guarded (idempotent), and (4) no destructive statement is
// emitted.
//
// Run: npx tsx server/dbMigrations/plateHrV2SnapshotPersistence.test.ts

import {
  ensurePlateHrV2SnapshotSchema,
  PLATE_HR_V2_SNAPSHOT_PERSISTENCE_STATEMENTS,
  type SqlExecutor,
} from "./plateHrV2SnapshotPersistence";

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

const ALL_SQL = PLATE_HR_V2_SNAPSHOT_PERSISTENCE_STATEMENTS.join("\n").toUpperCase();

// ── 1. Both tables created ────────────────────────────────────────────────────
ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS PLATE_HR_V2_SOURCE_EVIDENCE"), "source_evidence table created");
ok(ALL_SQL.includes("CREATE TABLE IF NOT EXISTS PLATE_HR_V2_PREDICTION_SNAPSHOTS"), "prediction_snapshots table created");

// ── 2. Point-in-time + append-only columns present ────────────────────────────
ok(ALL_SQL.includes("EVIDENCE_KIND TEXT NOT NULL"), "source_evidence has evidence_kind");
ok(ALL_SQL.includes("AVAILABLE_AT TIMESTAMP NOT NULL"), "source_evidence has NOT NULL available_at");
ok(ALL_SQL.includes("AVAILABILITY_SOURCE TEXT NOT NULL"), "source_evidence has availability_source");
ok(ALL_SQL.includes("DATA_THROUGH_AT TIMESTAMP"), "source_evidence has data_through_at");
ok(ALL_SQL.includes("VALID_FOR_AT TIMESTAMP"), "source_evidence has valid_for_at (forecast game time)");
ok(ALL_SQL.includes("RECONSTRUCTED BOOLEAN NOT NULL"), "source_evidence has reconstructed flag");
ok(ALL_SQL.includes("PREDICTION_AS_OF TIMESTAMP NOT NULL"), "prediction_snapshots has NOT NULL prediction_as_of");
ok(ALL_SQL.includes("SOURCE_SNAPSHOT_IDS JSONB NOT NULL"), "prediction_snapshots references source ids (not duplicated)");
// PR4.1/4.2: immutable authorized payload stored inline; nullable w/ precise
// legacy correction (drop default, drop NOT NULL, convert legacy {} → NULL).
ok(ALL_SQL.includes("AUTHORIZED_PAYLOAD JSONB"), "source_evidence stores the immutable authorized_payload inline");
ok(ALL_SQL.includes("ADD COLUMN IF NOT EXISTS AUTHORIZED_PAYLOAD JSONB"), "self-heal ADD COLUMN for authorized_payload");
ok(ALL_SQL.includes("ALTER COLUMN AUTHORIZED_PAYLOAD DROP DEFAULT"), "legacy correction: drop the {} default");
ok(ALL_SQL.includes("ALTER COLUMN AUTHORIZED_PAYLOAD DROP NOT NULL"), "legacy correction: drop NOT NULL (nullable)");
ok(/UPDATE PLATE_HR_V2_SOURCE_EVIDENCE\s+SET AUTHORIZED_PAYLOAD = NULL\s+WHERE AUTHORIZED_PAYLOAD = '\{\}'/.test(ALL_SQL), "legacy correction: convert {} → NULL");
// The CREATE must NOT re-introduce a NOT NULL / DEFAULT '{}' on authorized_payload.
ok(!/AUTHORIZED_PAYLOAD JSONB NOT NULL/.test(ALL_SQL), "authorized_payload is nullable (never NOT NULL)");
ok(!/AUTHORIZED_PAYLOAD JSONB[^,\n]*DEFAULT/.test(ALL_SQL), "authorized_payload column def has no {} default");

// ── 3. Append-only composite uniqueness index ────────────────────────────────
ok(
  ALL_SQL.includes("CREATE UNIQUE INDEX IF NOT EXISTS PLATE_HR_V2_PREDICTION_SNAPSHOTS_IDENTITY_IDX") &&
    ALL_SQL.includes("(GAME_PK, BATTER_ID, FEATURE_VERSION, PREDICTION_AS_OF)"),
  "prediction_snapshots has composite unique (game_pk, batter_id, feature_version, prediction_as_of)",
);
ok(ALL_SQL.includes("PLATE_HR_V2_SOURCE_EVIDENCE_ENTITY_IDX"), "source_evidence entity index exists");
ok(ALL_SQL.includes("PLATE_HR_V2_PREDICTION_SNAPSHOTS_PREDICTION_AS_OF_IDX"), "prediction_snapshots prediction_as_of index exists");

// ── 4. Every statement is idempotent / safely re-runnable ────────────────────
// CREATE TABLE/INDEX + ADD COLUMN are IF NOT EXISTS-guarded. The three PR4.2
// corrective statements are inherently idempotent: ALTER COLUMN DROP DEFAULT /
// DROP NOT NULL are no-ops once applied, and the {}→NULL UPDATE matches nothing
// after its first run.
const IDEMPOTENT_WITHOUT_IF_NOT_EXISTS = [
  "ALTER COLUMN AUTHORIZED_PAYLOAD DROP DEFAULT",
  "ALTER COLUMN AUTHORIZED_PAYLOAD DROP NOT NULL",
  "SET AUTHORIZED_PAYLOAD = NULL",
];
for (const statement of PLATE_HR_V2_SNAPSHOT_PERSISTENCE_STATEMENTS) {
  const upper = statement.toUpperCase();
  const guarded = upper.includes("IF NOT EXISTS") || IDEMPOTENT_WITHOUT_IF_NOT_EXISTS.some((s) => upper.includes(s));
  ok(guarded, `idempotent / re-runnable: ${statement.trim().slice(0, 60)}...`);
}

// ── 5. No destructive statements (constraint corrections are allowed) ────────
// DROP DEFAULT / DROP NOT NULL are non-destructive column-constraint changes.
// Truly destructive forms remain banned.
ok(!/DROP\s+TABLE/.test(ALL_SQL), "no DROP TABLE");
ok(!/DROP\s+COLUMN/.test(ALL_SQL), "no DROP COLUMN");
ok(!/DROP\s+INDEX/.test(ALL_SQL), "no DROP INDEX");
ok(!/\bTRUNCATE\b/.test(ALL_SQL), "no TRUNCATE");
ok(!/\bDELETE\s+FROM\b/.test(ALL_SQL), "no DELETE FROM");
ok(!/\bRENAME\b/.test(ALL_SQL), "no RENAME");
ok(!/ALTER\s+COLUMN[\s\S]*?\bTYPE\b/.test(ALL_SQL), "no destructive ALTER COLUMN ... TYPE");
// The only UPDATE permitted is the targeted legacy {}→NULL correction.
ok(!/UPDATE\s+(?!PLATE_HR_V2_SOURCE_EVIDENCE\s+SET AUTHORIZED_PAYLOAD = NULL)/.test(ALL_SQL), "no UPDATE other than the {}→NULL legacy correction");

// ── 6. Running twice is byte-identical (idempotent) ──────────────────────────
{
  const client = new RecordingExecutor();
  await ensurePlateHrV2SnapshotSchema(client);
  const n = client.executed.length;
  ok(n === PLATE_HR_V2_SNAPSHOT_PERSISTENCE_STATEMENTS.length, "first run executes every statement once");
  await ensurePlateHrV2SnapshotSchema(client);
  ok(client.executed.length === n * 2, "second run re-issues without throwing");
  ok(
    client.executed.slice(0, n).join("\n") === client.executed.slice(n).join("\n"),
    "second run byte-identical to first",
  );
}

// ── 7. Executor failure propagates (must fail startup) ───────────────────────
{
  class FailingExecutor implements SqlExecutor {
    async query(): Promise<unknown> { throw new Error("simulated connection failure"); }
  }
  let threw = false;
  try { await ensurePlateHrV2SnapshotSchema(new FailingExecutor()); } catch { threw = true; }
  ok(threw, "a query failure propagates rather than being swallowed");
}

console.log(`\nplateHrV2SnapshotPersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
