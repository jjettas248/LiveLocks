// Durable persistence bootstrap for the MLB Recommendation Episode contract
// (MLB Flagship Program Phase 1 — mlb-foundation-contracts).
//
// Mirrors the Drizzle definition in shared/schema.ts column-for-column, for
// the same reason server/dbMigrations/hrRadarResearchPersistence.ts exists:
// `drizzle-kit push` may not have been run by hand against a given database
// yet, so this creates the table (and its indexes) idempotently via
// `IF NOT EXISTS` on every boot. Drizzle continues to own the canonical
// schema/types — this is a runtime safety net, not a replacement for
// `drizzle-kit push`.
//
// This table is brand new, so there is no pre-existing older shape to
// self-heal from (no `..._SELF_HEAL` ALTER TABLE constants). A future PR that
// adds a column should add one then, following the exact
// ADD COLUMN IF NOT EXISTS pattern used in pregameRadarPersistence.ts.
//
// No DROP / destructive-ALTER statements anywhere in this file — see
// mlbRecommendationEpisodePersistence.test.ts.

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

const MLB_RECOMMENDATION_EPISODES = `
  CREATE TABLE IF NOT EXISTS mlb_recommendation_episodes (
    episode_id TEXT PRIMARY KEY,
    sport TEXT NOT NULL DEFAULT 'MLB',
    product TEXT NOT NULL,
    game_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    market TEXT NOT NULL,
    recommended_side TEXT NOT NULL,
    line NUMERIC NOT NULL,
    american_odds INTEGER NOT NULL,
    sportsbook TEXT NOT NULL,
    odds_fetched_at TIMESTAMP NOT NULL,
    recommendation_created_at TIMESTAMP NOT NULL,
    model_version TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    projection NUMERIC NOT NULL,
    model_probability NUMERIC NOT NULL,
    setup_grade TEXT NOT NULL,
    sportsbook_edge NUMERIC,
    data_quality TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'sportsbook',
    is_official BOOLEAN NOT NULL DEFAULT true,
    game_phase TEXT,
    surfaced_at TIMESTAMP,
    expires_at TIMESTAMP,
    lifecycle_status TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    settlement_result TEXT,
    settled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
`;

const MLB_RECOMMENDATION_EPISODES_GAME_ID_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_recommendation_episodes_game_id_idx
    ON mlb_recommendation_episodes (game_id);
`;

const MLB_RECOMMENDATION_EPISODES_PLAYER_ID_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_recommendation_episodes_player_id_idx
    ON mlb_recommendation_episodes (player_id);
`;

const MLB_RECOMMENDATION_EPISODES_PRODUCT_STATUS_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_recommendation_episodes_product_status_idx
    ON mlb_recommendation_episodes (product, status);
`;

const MLB_RECOMMENDATION_EPISODES_CREATED_AT_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_recommendation_episodes_created_at_idx
    ON mlb_recommendation_episodes (recommendation_created_at);
`;

const MLB_RECOMMENDATION_EPISODES_STATUS_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_recommendation_episodes_status_idx
    ON mlb_recommendation_episodes (status);
`;

const MLB_RECOMMENDATION_EPISODES_MODEL_VERSION_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_recommendation_episodes_model_version_idx
    ON mlb_recommendation_episodes (model_version);
`;

export const MLB_RECOMMENDATION_EPISODE_PERSISTENCE_STATEMENTS: readonly string[] = [
  MLB_RECOMMENDATION_EPISODES,
  MLB_RECOMMENDATION_EPISODES_GAME_ID_IDX,
  MLB_RECOMMENDATION_EPISODES_PLAYER_ID_IDX,
  MLB_RECOMMENDATION_EPISODES_PRODUCT_STATUS_IDX,
  MLB_RECOMMENDATION_EPISODES_CREATED_AT_IDX,
  MLB_RECOMMENDATION_EPISODES_STATUS_IDX,
  MLB_RECOMMENDATION_EPISODES_MODEL_VERSION_IDX,
];

/**
 * Idempotent startup bootstrap for the mlb_recommendation_episodes table.
 * Safe to run on every boot.
 *
 * Deliberately does NOT catch errors — a failure here must fail startup
 * (see server/index.ts) rather than let this schema silently fail to exist.
 */
export async function ensureMlbRecommendationEpisodePersistenceSchema(client: SqlExecutor): Promise<void> {
  for (const statement of MLB_RECOMMENDATION_EPISODE_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
