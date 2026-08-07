// Durable persistence bootstrap for the MLB Live Edge Stage B all-lane
// prediction ledger (server/mlb/stageB/*, shared/mlbPredictionLedger.ts).
//
// Mirrors server/dbMigrations/mlbRecommendationEpisodePersistence.ts: Drizzle
// (shared/schema.ts `mlbLanePredictions`) owns the canonical schema, and this
// creates the table + indexes idempotently via `IF NOT EXISTS` on every boot as
// a runtime safety net for databases where `drizzle-kit push` has not been run.
//
// This table is brand new, so there is no older shape to self-heal from (no
// `..._SELF_HEAL` ALTER TABLE constants). A future column addition should follow
// the exact `ADD COLUMN IF NOT EXISTS` pattern (see persistedPlaysSafetyCore
// Columns.ts) and remain additive/nullable.
//
// No DROP / destructive-ALTER statements anywhere — enforced by
// mlbLanePredictionLedgerPersistence.test.ts.

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

const MLB_LANE_PREDICTIONS = `
  CREATE TABLE IF NOT EXISTS mlb_lane_predictions (
    prediction_id TEXT PRIMARY KEY,
    signal_id TEXT NOT NULL,
    sport TEXT NOT NULL DEFAULT 'MLB',
    game_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    market TEXT NOT NULL,
    side TEXT NOT NULL,
    lane TEXT NOT NULL,
    line NUMERIC NOT NULL,
    over_odds INTEGER,
    under_odds INTEGER,
    side_odds INTEGER,
    sportsbook TEXT,
    odds_fetched_at TIMESTAMP,
    odds_age_ms INTEGER,
    captured_at TIMESTAMP NOT NULL,
    inning INTEGER,
    game_phase TEXT,
    stat_at_capture NUMERIC,
    candidate_probability_pct NUMERIC NOT NULL,
    calibrated_probability_pct NUMERIC,
    probability_semantics TEXT NOT NULL,
    model_edge_pct_points NUMERIC,
    no_vig_book_probability NUMERIC,
    edge_version TEXT,
    finalized_tier TEXT,
    model_method TEXT,
    data_quality TEXT,
    base_eligible BOOLEAN,
    signal_score NUMERIC,
    lane_reasons JSONB,
    finalizer_version TEXT,
    lane_version TEXT,
    goldmaster_version TEXT,
    contract_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'captured',
    settlement_result TEXT,
    final_stat NUMERIC,
    settled_at TIMESTAMP,
    void_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
`;

const MLB_LANE_PREDICTIONS_GAME_ID_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_lane_predictions_game_id_idx
    ON mlb_lane_predictions (game_id);
`;

const MLB_LANE_PREDICTIONS_SIGNAL_ID_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_lane_predictions_signal_id_idx
    ON mlb_lane_predictions (signal_id);
`;

const MLB_LANE_PREDICTIONS_STATUS_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_lane_predictions_status_idx
    ON mlb_lane_predictions (status);
`;

const MLB_LANE_PREDICTIONS_LANE_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_lane_predictions_lane_idx
    ON mlb_lane_predictions (lane);
`;

// The settlement sweep scans captured rows oldest-first — composite keeps that
// query index-only.
const MLB_LANE_PREDICTIONS_STATUS_CAPTURED_AT_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_lane_predictions_status_captured_at_idx
    ON mlb_lane_predictions (status, captured_at);
`;

export const MLB_LANE_PREDICTION_LEDGER_PERSISTENCE_STATEMENTS: readonly string[] = [
  MLB_LANE_PREDICTIONS,
  MLB_LANE_PREDICTIONS_GAME_ID_IDX,
  MLB_LANE_PREDICTIONS_SIGNAL_ID_IDX,
  MLB_LANE_PREDICTIONS_STATUS_IDX,
  MLB_LANE_PREDICTIONS_LANE_IDX,
  MLB_LANE_PREDICTIONS_STATUS_CAPTURED_AT_IDX,
];

/**
 * Idempotent startup bootstrap for the mlb_lane_predictions table. Safe to run
 * on every boot. Deliberately does NOT catch errors — a failure here must fail
 * startup (see server/index.ts) rather than let this schema silently fail to
 * exist while the Stage B capture/settlement code expects it.
 */
export async function ensureMlbLanePredictionLedgerSchema(client: SqlExecutor): Promise<void> {
  for (const statement of MLB_LANE_PREDICTION_LEDGER_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
