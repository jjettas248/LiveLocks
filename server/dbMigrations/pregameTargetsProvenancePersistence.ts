// PR2 — Pregame Targets official-target provenance columns (contract layer, §10).
//
// Additive, idempotent self-heal for the `persisted_plays` official-target
// SNAPSHOT-LINEAGE columns (migration plan C4): `surface`,
// `projection_snapshot_id`, `decision_snapshot_id`, `target_tier`,
// `role_certainty`. Runs on every boot; safe to repeat.
//
// Conventions (mirrors pregameTargetsFoundationPersistence.ts; the self-heal
// ADD COLUMN form it pointed to for a future column add):
//  • ALTER TABLE persisted_plays ADD COLUMN IF NOT EXISTS ONLY — additive, never
//    rewrites or drops an existing column (migration principle #1). No CREATE
//    TABLE (persisted_plays already exists), no destructive SQL.
//  • Every new column is NULLABLE with no default — an existing row and any
//    product that does not emit these stays null (no backfill, no fabrication).
//  • Deliberately NO try/catch — a bootstrap failure must fail startup loudly.
//  • The statements array is exported so the co-located test can introspect it
//    (idempotence, ADD-COLUMN-IF-NOT-EXISTS-only, no destructive SQL, coverage).

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

// One ALTER per column (each independently IF NOT EXISTS) so a partial prior
// run self-heals: a column that already exists is skipped, a missing one is
// added, and re-running is a pure no-op.
const PERSISTED_PLAYS_SURFACE = `
  ALTER TABLE persisted_plays
    ADD COLUMN IF NOT EXISTS surface TEXT;
`;

const PERSISTED_PLAYS_PROJECTION_SNAPSHOT_ID = `
  ALTER TABLE persisted_plays
    ADD COLUMN IF NOT EXISTS projection_snapshot_id TEXT;
`;

const PERSISTED_PLAYS_DECISION_SNAPSHOT_ID = `
  ALTER TABLE persisted_plays
    ADD COLUMN IF NOT EXISTS decision_snapshot_id TEXT;
`;

const PERSISTED_PLAYS_TARGET_TIER = `
  ALTER TABLE persisted_plays
    ADD COLUMN IF NOT EXISTS target_tier TEXT;
`;

const PERSISTED_PLAYS_ROLE_CERTAINTY = `
  ALTER TABLE persisted_plays
    ADD COLUMN IF NOT EXISTS role_certainty NUMERIC;
`;

export const PREGAME_TARGETS_PROVENANCE_PERSISTENCE_STATEMENTS: readonly string[] = [
  PERSISTED_PLAYS_SURFACE,
  PERSISTED_PLAYS_PROJECTION_SNAPSHOT_ID,
  PERSISTED_PLAYS_DECISION_SNAPSHOT_ID,
  PERSISTED_PLAYS_TARGET_TIER,
  PERSISTED_PLAYS_ROLE_CERTAINTY,
];

/**
 * Idempotent startup self-heal for the Pregame Targets official-target
 * provenance columns on `persisted_plays`. Additive only; safe to run on every
 * boot. Deliberately does NOT catch errors — a failure here must fail startup
 * rather than silently leave the schema half-built.
 */
export async function ensurePregameTargetsProvenanceColumns(client: SqlExecutor): Promise<void> {
  for (const statement of PREGAME_TARGETS_PROVENANCE_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
