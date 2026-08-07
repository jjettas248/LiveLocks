// Durable persistence bootstrap for MLB Live Edge Stage C offline calibration
// artifacts (shared/schema.ts `mlbCalibrationArtifacts`, shared/mlbCalibration.ts).
//
// Mirrors the other server/dbMigrations/* bootstraps: Drizzle owns the canonical
// schema, and this creates the table + indexes idempotently via `IF NOT EXISTS`
// on every boot as a runtime safety net. Brand-new table ⇒ no older shape to
// self-heal; a future column addition follows the ADD COLUMN IF NOT EXISTS
// pattern. No DROP / destructive-ALTER anywhere — enforced by the test.

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

const MLB_CALIBRATION_ARTIFACTS = `
  CREATE TABLE IF NOT EXISTS mlb_calibration_artifacts (
    artifact_id TEXT PRIMARY KEY,
    segment TEXT NOT NULL,
    method TEXT NOT NULL,
    built_at TIMESTAMP NOT NULL,
    sample_size INTEGER NOT NULL,
    distinct_slate_dates INTEGER NOT NULL,
    raw_brier NUMERIC,
    calibrated_brier NUMERIC,
    raw_ece_pct NUMERIC,
    calibrated_ece_pct NUMERIC,
    base_positive_rate NUMERIC,
    promotion_ready BOOLEAN NOT NULL DEFAULT false,
    promotion_reasons JSONB,
    artifact JSONB NOT NULL,
    ledger_contract_version TEXT NOT NULL,
    artifact_version TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );
`;

const MLB_CALIBRATION_ARTIFACTS_SEGMENT_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_calibration_artifacts_segment_idx
    ON mlb_calibration_artifacts (segment);
`;

const MLB_CALIBRATION_ARTIFACTS_BUILT_AT_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_calibration_artifacts_built_at_idx
    ON mlb_calibration_artifacts (built_at);
`;

// Composite for "latest artifact per segment" reads.
const MLB_CALIBRATION_ARTIFACTS_SEGMENT_BUILT_AT_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_calibration_artifacts_segment_built_at_idx
    ON mlb_calibration_artifacts (segment, built_at);
`;

export const MLB_CALIBRATION_ARTIFACTS_PERSISTENCE_STATEMENTS: readonly string[] = [
  MLB_CALIBRATION_ARTIFACTS,
  MLB_CALIBRATION_ARTIFACTS_SEGMENT_IDX,
  MLB_CALIBRATION_ARTIFACTS_BUILT_AT_IDX,
  MLB_CALIBRATION_ARTIFACTS_SEGMENT_BUILT_AT_IDX,
];

/**
 * Idempotent startup bootstrap for the mlb_calibration_artifacts table. Safe to
 * run on every boot. Deliberately does NOT catch errors — a failure must fail
 * startup rather than let the schema silently fail to exist.
 */
export async function ensureMlbCalibrationArtifactsSchema(client: SqlExecutor): Promise<void> {
  for (const statement of MLB_CALIBRATION_ARTIFACTS_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
