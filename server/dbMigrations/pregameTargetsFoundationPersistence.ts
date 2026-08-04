// PR1 — Pregame Targets temporal-foundation persistence bootstrap.
//
// Idempotent, additive schema bootstrap for the three foundation tables
// (pregame_raw_source_snapshots, pregame_feature_snapshots,
// pregame_posterior_states). Runs on every boot; safe to repeat.
//
// Conventions (mirrors mlbRecommendationEpisodePersistence.ts):
//  • CREATE TABLE / INDEX IF NOT EXISTS only — never ALTER an existing table in
//    PR1 (nothing here modifies a pre-existing table). A future column add must
//    use the self-heal `ADD COLUMN IF NOT EXISTS` form (see pregameRadarPersistence.ts).
//  • Deliberately NO try/catch — a bootstrap failure must fail startup loudly.
//  • The statements array is exported so the co-located test can introspect it
//    (idempotence, IF-NOT-EXISTS-only, no destructive SQL).

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

const PREGAME_RAW_SOURCE_SNAPSHOTS = `
  CREATE TABLE IF NOT EXISTS pregame_raw_source_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    sport TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_key TEXT NOT NULL,
    valid_at TIMESTAMPTZ NOT NULL,
    known_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

const PREGAME_RAW_SOURCE_SNAPSHOTS_SPORT_KIND_IDX = `
  CREATE INDEX IF NOT EXISTS pregame_raw_source_snapshots_sport_kind_idx
    ON pregame_raw_source_snapshots (sport, source_kind);
`;

const PREGAME_RAW_SOURCE_SNAPSHOTS_KNOWN_AT_IDX = `
  CREATE INDEX IF NOT EXISTS pregame_raw_source_snapshots_known_at_idx
    ON pregame_raw_source_snapshots (known_at);
`;

const PREGAME_RAW_SOURCE_SNAPSHOTS_SOURCE_KEY_IDX = `
  CREATE INDEX IF NOT EXISTS pregame_raw_source_snapshots_source_key_idx
    ON pregame_raw_source_snapshots (source_key);
`;

const PREGAME_RAW_SOURCE_SNAPSHOTS_SOURCE_CONTENT_UIDX = `
  CREATE UNIQUE INDEX IF NOT EXISTS pregame_raw_source_snapshots_source_content_uidx
    ON pregame_raw_source_snapshots (source_kind, source_key, content_hash);
`;

const PREGAME_FEATURE_SNAPSHOTS = `
  CREATE TABLE IF NOT EXISTS pregame_feature_snapshots (
    feature_row_id TEXT PRIMARY KEY,
    sport TEXT NOT NULL,
    entity_canonical_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    feature_key TEXT NOT NULL,
    feature_version TEXT NOT NULL,
    season INTEGER NOT NULL,
    valid_at TIMESTAMPTZ NOT NULL,
    known_at TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL,
    value NUMERIC,
    source_id TEXT NOT NULL,
    derived_from_game_ids JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

const PREGAME_FEATURE_SNAPSHOTS_ENTITY_FEATURE_KNOWN_AT_IDX = `
  CREATE INDEX IF NOT EXISTS pregame_feature_snapshots_entity_feature_known_at_idx
    ON pregame_feature_snapshots (entity_canonical_id, feature_key, known_at);
`;

const PREGAME_FEATURE_SNAPSHOTS_SPORT_FEATURE_IDX = `
  CREATE INDEX IF NOT EXISTS pregame_feature_snapshots_sport_feature_idx
    ON pregame_feature_snapshots (sport, feature_key);
`;

const PREGAME_FEATURE_SNAPSHOTS_SEASON_IDX = `
  CREATE INDEX IF NOT EXISTS pregame_feature_snapshots_season_idx
    ON pregame_feature_snapshots (season);
`;

const PREGAME_POSTERIOR_STATES = `
  CREATE TABLE IF NOT EXISTS pregame_posterior_states (
    posterior_id TEXT PRIMARY KEY,
    sport TEXT NOT NULL,
    entity_canonical_id TEXT NOT NULL,
    feature_key TEXT NOT NULL,
    feature_version TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    by_season JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

const PREGAME_POSTERIOR_STATES_ENTITY_FEATURE_VERSION_UIDX = `
  CREATE UNIQUE INDEX IF NOT EXISTS pregame_posterior_states_entity_feature_version_uidx
    ON pregame_posterior_states (entity_canonical_id, feature_key, feature_version);
`;

const PREGAME_POSTERIOR_STATES_SPORT_FEATURE_IDX = `
  CREATE INDEX IF NOT EXISTS pregame_posterior_states_sport_feature_idx
    ON pregame_posterior_states (sport, feature_key);
`;

export const PREGAME_TARGETS_FOUNDATION_PERSISTENCE_STATEMENTS: readonly string[] = [
  PREGAME_RAW_SOURCE_SNAPSHOTS,
  PREGAME_RAW_SOURCE_SNAPSHOTS_SPORT_KIND_IDX,
  PREGAME_RAW_SOURCE_SNAPSHOTS_KNOWN_AT_IDX,
  PREGAME_RAW_SOURCE_SNAPSHOTS_SOURCE_KEY_IDX,
  PREGAME_RAW_SOURCE_SNAPSHOTS_SOURCE_CONTENT_UIDX,
  PREGAME_FEATURE_SNAPSHOTS,
  PREGAME_FEATURE_SNAPSHOTS_ENTITY_FEATURE_KNOWN_AT_IDX,
  PREGAME_FEATURE_SNAPSHOTS_SPORT_FEATURE_IDX,
  PREGAME_FEATURE_SNAPSHOTS_SEASON_IDX,
  PREGAME_POSTERIOR_STATES,
  PREGAME_POSTERIOR_STATES_ENTITY_FEATURE_VERSION_UIDX,
  PREGAME_POSTERIOR_STATES_SPORT_FEATURE_IDX,
];

/**
 * Idempotent startup bootstrap for the Pregame Targets temporal foundation.
 * Safe to run on every boot. Deliberately does NOT catch errors — a failure
 * here must fail startup rather than silently leave the schema half-built.
 */
export async function ensurePregameTargetsFoundationSchema(client: SqlExecutor): Promise<void> {
  for (const statement of PREGAME_TARGETS_FOUNDATION_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
