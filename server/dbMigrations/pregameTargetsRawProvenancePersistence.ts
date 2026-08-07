// PR5 (audit-3) — Pregame Targets raw-snapshot audit-metadata + correction lineage.
//
// Additive, idempotent self-heal for `pregame_raw_source_snapshots`: persists the
// timestamp-policy metadata (`source_published_at`, `known_at_policy_version`) and the
// correction-lineage relation (`supersedes_snapshot_id`) so they survive the database
// as queryable audit facts — not only as transient TypeScript objects. Runs on every
// boot; safe to repeat.
//
// Conventions (mirror pregameTargetsProvenancePersistence.ts):
//  • ALTER TABLE ... ADD COLUMN IF NOT EXISTS ONLY — additive, never rewrites/drops an
//    existing column. No CREATE TABLE (the table already exists via the foundation
//    migration), no destructive SQL, no backfill.
//  • Every new column is NULLABLE with no default — an existing row and any writer that
//    does not emit these stays null (no fabrication). `source_published_at` NULL is the
//    honest "provider exposes no publish instant". The immutable ingestion instant is the
//    existing `created_at` (INSERT-only row) — no new column needed.
//  • A partial-lineage index (only non-null predecessors) for chain traversal.
//  • Deliberately NO try/catch — a bootstrap failure must fail startup loudly.
//  • The statements array is exported so the co-located test can introspect it.

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

const RAW_SOURCE_PUBLISHED_AT = `
  ALTER TABLE pregame_raw_source_snapshots
    ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ;
`;

const RAW_KNOWN_AT_POLICY_VERSION = `
  ALTER TABLE pregame_raw_source_snapshots
    ADD COLUMN IF NOT EXISTS known_at_policy_version TEXT;
`;

const RAW_SUPERSEDES_SNAPSHOT_ID = `
  ALTER TABLE pregame_raw_source_snapshots
    ADD COLUMN IF NOT EXISTS supersedes_snapshot_id TEXT;
`;

const RAW_SUPERSEDES_IDX = `
  CREATE INDEX IF NOT EXISTS pregame_raw_source_snapshots_supersedes_idx
    ON pregame_raw_source_snapshots (supersedes_snapshot_id)
    WHERE supersedes_snapshot_id IS NOT NULL;
`;

export const PREGAME_TARGETS_RAW_PROVENANCE_PERSISTENCE_STATEMENTS: readonly string[] = [
  RAW_SOURCE_PUBLISHED_AT,
  RAW_KNOWN_AT_POLICY_VERSION,
  RAW_SUPERSEDES_SNAPSHOT_ID,
  RAW_SUPERSEDES_IDX,
];

/**
 * Idempotent startup self-heal for the raw-snapshot audit-metadata + correction-lineage
 * columns. Additive only; safe to run on every boot. Deliberately does NOT catch errors —
 * a failure here must fail startup rather than silently leave the schema half-built.
 */
export async function ensurePregameTargetsRawProvenanceColumns(client: SqlExecutor): Promise<void> {
  for (const statement of PREGAME_TARGETS_RAW_PROVENANCE_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
