// Durable persistence bootstrap for the MLB Live Edge Stage C PR3 active
// (promoted) calibrator registry (shared/schema.ts `mlbActiveCalibrators`,
// shared/mlbCalibration.ts `MlbActiveCalibrator`).
//
// Mirrors the other server/dbMigrations/* bootstraps: Drizzle owns the canonical
// schema, and this creates the table + index idempotently via `IF NOT EXISTS` on
// every boot as a runtime safety net. One row per segment (PK); a promotion
// upserts it, a deactivation flips `active` — the row is never dropped. No DROP /
// destructive-ALTER anywhere — enforced by the companion test.
//
// This table's mere existence is inert: nothing in the live engine reads it
// unless MLB_CALIBRATION_PROMOTION_ENABLED is on (default off).

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

const MLB_ACTIVE_CALIBRATORS = `
  CREATE TABLE IF NOT EXISTS mlb_active_calibrators (
    segment TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    artifact JSONB NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    activated_at TIMESTAMP NOT NULL,
    activated_by TEXT NOT NULL,
    promotion_evidence JSONB,
    deactivated_at TIMESTAMP,
    deactivation_reason TEXT,
    ledger_contract_version TEXT NOT NULL,
    artifact_version TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
`;

// Registry load reads only active rows.
const MLB_ACTIVE_CALIBRATORS_ACTIVE_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_active_calibrators_active_idx
    ON mlb_active_calibrators (active);
`;

export const MLB_ACTIVE_CALIBRATORS_PERSISTENCE_STATEMENTS: readonly string[] = [
  MLB_ACTIVE_CALIBRATORS,
  MLB_ACTIVE_CALIBRATORS_ACTIVE_IDX,
];

/**
 * Idempotent startup bootstrap for the mlb_active_calibrators table. Safe to run
 * on every boot. Deliberately does NOT catch errors — a failure must fail
 * startup rather than let the schema silently fail to exist.
 */
export async function ensureMlbActiveCalibratorsSchema(client: SqlExecutor): Promise<void> {
  for (const statement of MLB_ACTIVE_CALIBRATORS_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
