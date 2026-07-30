// Durable persistence bootstrap for Mound Radar V2 (shadow) prediction
// capture (Flagship Program Phase 2, Part 4).
//
// Mirrors the Drizzle definition in shared/schema.ts column-for-column, for
// the same reason server/dbMigrations/hrRadarResearchPersistence.ts exists:
// `drizzle-kit push` may not have been run by hand against a given database
// yet, so this creates the table (and its indexes) idempotently via
// `IF NOT EXISTS` on every boot. Drizzle continues to own the canonical
// schema/types — this is a runtime safety net, not a replacement for
// `drizzle-kit push`.
//
// This table was brand new when first created; it has since gained one
// additive column (v1_recommended_side, Correction 1) via the exact same
// self-heal `ADD COLUMN IF NOT EXISTS` pattern already established in
// pregameRadarPersistence.ts/plateHrV2Persistence.ts. No DROP / destructive
// ALTER statements anywhere in this file — see moundV2ShadowPersistence.test.ts.

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

const MOUND_V2_SHADOW_PREDICTIONS = `
  CREATE TABLE IF NOT EXISTS mound_v2_shadow_predictions (
    prediction_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    game_pk TEXT,
    pitcher_id TEXT NOT NULL,
    pitcher_name TEXT NOT NULL,
    market TEXT NOT NULL,
    frozen_line NUMERIC,
    frozen_over_price INTEGER,
    frozen_under_price INTEGER,
    sportsbook TEXT,
    odds_fetched_at TIMESTAMP,
    scheduled_game_time TIMESTAMP,
    evaluation_timestamp TIMESTAMP NOT NULL,
    v1_score_10 NUMERIC,
    v1_tier TEXT,
    setup_grade TEXT,
    v1_recommended_side TEXT,
    v1_qualification_status TEXT,
    v2_expected_value NUMERIC NOT NULL,
    v2_over_probability NUMERIC NOT NULL,
    v2_under_probability NUMERIC NOT NULL,
    v2_push_probability NUMERIC NOT NULL,
    v2_decision_policy_version TEXT,
    v2_decision_side TEXT,
    v2_qualified BOOLEAN,
    v2_qualification_reason TEXT,
    production_model_version TEXT NOT NULL,
    v2_model_version TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    feature_hash TEXT NOT NULL,
    data_quality TEXT NOT NULL,
    lineup_status TEXT NOT NULL,
    shadow_latency_ms NUMERIC,
    shadow_failure_reason TEXT,
    settlement_status TEXT NOT NULL DEFAULT 'pending',
    final_result TEXT,
    final_stat_value NUMERIC,
    void_reason TEXT,
    graded_at TIMESTAMP,
    reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0,
    last_reconciliation_attempt_at TIMESTAMP,
    last_reconciliation_failure_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );
`;

// Self-heal for a table created before v1_recommended_side existed
// (Correction 1) — additive only, mirrors pregameRadarPersistence.ts's
// mound_direction self-heal exactly. A no-op on a fresh table, since the
// CREATE TABLE above already includes the column.
const MOUND_V2_SHADOW_PREDICTIONS_ADD_V1_RECOMMENDED_SIDE = `
  ALTER TABLE mound_v2_shadow_predictions
    ADD COLUMN IF NOT EXISTS v1_recommended_side TEXT;
`;

// Self-heal for a table created before the reconciliation-bookkeeping
// columns existed (Correction 3) — additive only, same convention.
const MOUND_V2_SHADOW_PREDICTIONS_ADD_RECONCILIATION_COLUMNS = `
  ALTER TABLE mound_v2_shadow_predictions
    ADD COLUMN IF NOT EXISTS void_reason TEXT,
    ADD COLUMN IF NOT EXISTS reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_reconciliation_attempt_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS last_reconciliation_failure_reason TEXT;
`;

// Self-heal for a table created before game_pk/scheduled_game_time existed
// (Correction 3) — additive only, same convention. Both are captured-at-build
// identity/context fields (not reconciliation bookkeeping), but arrived in
// the same correction pass as the columns above.
const MOUND_V2_SHADOW_PREDICTIONS_ADD_SCHEDULING_COLUMNS = `
  ALTER TABLE mound_v2_shadow_predictions
    ADD COLUMN IF NOT EXISTS game_pk TEXT,
    ADD COLUMN IF NOT EXISTS scheduled_game_time TIMESTAMP;
`;

// Self-heal for a table created before the V1 qualification-status and V2
// decision-policy columns existed (Final Pre-Push Integrity Pass) —
// additive only, same convention.
const MOUND_V2_SHADOW_PREDICTIONS_ADD_DECISION_POLICY_COLUMNS = `
  ALTER TABLE mound_v2_shadow_predictions
    ADD COLUMN IF NOT EXISTS v1_qualification_status TEXT,
    ADD COLUMN IF NOT EXISTS v2_decision_policy_version TEXT,
    ADD COLUMN IF NOT EXISTS v2_decision_side TEXT,
    ADD COLUMN IF NOT EXISTS v2_qualified BOOLEAN,
    ADD COLUMN IF NOT EXISTS v2_qualification_reason TEXT;
`;

const MOUND_V2_SHADOW_PREDICTIONS_SNAPSHOT_IDX = `
  CREATE INDEX IF NOT EXISTS mound_v2_shadow_predictions_snapshot_idx
    ON mound_v2_shadow_predictions (snapshot_id);
`;

const MOUND_V2_SHADOW_PREDICTIONS_GAME_PITCHER_IDX = `
  CREATE INDEX IF NOT EXISTS mound_v2_shadow_predictions_game_pitcher_idx
    ON mound_v2_shadow_predictions (game_id, pitcher_id);
`;

const MOUND_V2_SHADOW_PREDICTIONS_SETTLEMENT_STATUS_IDX = `
  CREATE INDEX IF NOT EXISTS mound_v2_shadow_predictions_settlement_status_idx
    ON mound_v2_shadow_predictions (settlement_status);
`;

const MOUND_V2_SHADOW_PREDICTIONS_EVALUATION_TIMESTAMP_IDX = `
  CREATE INDEX IF NOT EXISTS mound_v2_shadow_predictions_evaluation_timestamp_idx
    ON mound_v2_shadow_predictions (evaluation_timestamp);
`;

const MOUND_V2_SHADOW_PREDICTIONS_MARKET_VERSION_IDX = `
  CREATE INDEX IF NOT EXISTS mound_v2_shadow_predictions_market_version_idx
    ON mound_v2_shadow_predictions (market, v2_model_version);
`;

export const MOUND_V2_SHADOW_PERSISTENCE_STATEMENTS: readonly string[] = [
  MOUND_V2_SHADOW_PREDICTIONS,
  MOUND_V2_SHADOW_PREDICTIONS_ADD_V1_RECOMMENDED_SIDE,
  MOUND_V2_SHADOW_PREDICTIONS_ADD_RECONCILIATION_COLUMNS,
  MOUND_V2_SHADOW_PREDICTIONS_ADD_SCHEDULING_COLUMNS,
  MOUND_V2_SHADOW_PREDICTIONS_ADD_DECISION_POLICY_COLUMNS,
  MOUND_V2_SHADOW_PREDICTIONS_SNAPSHOT_IDX,
  MOUND_V2_SHADOW_PREDICTIONS_GAME_PITCHER_IDX,
  MOUND_V2_SHADOW_PREDICTIONS_SETTLEMENT_STATUS_IDX,
  MOUND_V2_SHADOW_PREDICTIONS_EVALUATION_TIMESTAMP_IDX,
  MOUND_V2_SHADOW_PREDICTIONS_MARKET_VERSION_IDX,
];

/**
 * Idempotent startup bootstrap for the mound_v2_shadow_predictions table.
 * Safe to run on every boot.
 *
 * Deliberately does NOT catch errors — a failure here must fail startup
 * (see server/index.ts) rather than let this schema silently fail to exist.
 */
export async function ensureMoundV2ShadowPersistenceSchema(client: SqlExecutor): Promise<void> {
  for (const statement of MOUND_V2_SHADOW_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
