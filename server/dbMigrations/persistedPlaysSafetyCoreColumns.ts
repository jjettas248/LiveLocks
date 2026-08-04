// Durable persistence bootstrap for the MLB Live Edge safety-core (Stage A)
// canonical no-vig edge + lane columns on persisted_plays.
//
// Same pattern as the other server/dbMigrations/* bootstraps: idempotent,
// additive, `ADD COLUMN IF NOT EXISTS` only, run on every boot. Drizzle owns the
// canonical schema (shared/schema.ts) — this is a runtime safety net so an
// un-migrated database self-heals instead of throwing "column does not exist"
// when the analytics/persistence surfaces read the new columns.
//
// All columns additive + nullable. NO backfill of historical rows. The legacy
// `edge_gap` column is NOT touched — it stays as-is (its historical values are
// preserved; new MLB rows simply leave it null, carrying canonical edge in
// `model_edge` + `edge_version` instead).
//
// No DROP / destructive-ALTER statements anywhere in this file — enforced by
// persistedPlaysSafetyCoreColumns.test.ts.

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

// One statement per column so a partially-migrated table (some columns already
// present) still self-heals the rest — every clause is independently
// IF NOT EXISTS.
export const PERSISTED_PLAYS_SAFETY_CORE_STATEMENTS: readonly string[] = [
  `ALTER TABLE persisted_plays ADD COLUMN IF NOT EXISTS edge_version text;`,
  `ALTER TABLE persisted_plays ADD COLUMN IF NOT EXISTS no_vig_book_probability numeric;`,
  `ALTER TABLE persisted_plays ADD COLUMN IF NOT EXISTS probability_semantics text;`,
  `ALTER TABLE persisted_plays ADD COLUMN IF NOT EXISTS lane text;`,
];

/**
 * Idempotent startup bootstrap for the safety-core persisted_plays columns.
 * Safe to run on every boot. Deliberately does NOT catch errors — a failure
 * must fail startup (see server/index.ts) rather than let the columns silently
 * fail to exist while the code expects them.
 */
export async function ensurePersistedPlaysSafetyCoreColumns(client: SqlExecutor): Promise<void> {
  for (const statement of PERSISTED_PLAYS_SAFETY_CORE_STATEMENTS) {
    await client.query(statement);
  }
}
