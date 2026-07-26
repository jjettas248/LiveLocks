// Durable persistence bootstrap for Plate HR Probability V2's research
// foundation (PR 1).
//
// Mirrors server/dbMigrations/hrRadarResearchPersistence.ts's convention
// column-for-column against the Drizzle definitions in shared/schema.ts:
// idempotent `CREATE TABLE/INDEX IF NOT EXISTS` on every boot, so
// `drizzle-kit push` not having been run by hand against a given database
// yet never leaves these tables missing. Drizzle continues to own the
// canonical schema/types — this is a runtime safety net.
//
// All four tables are brand new in this PR, so there is no pre-existing
// older shape to self-heal from (no `..._SELF_HEAL` ALTER TABLE constants).
// A future PR that adds a column to one of these tables should add one then,
// following the exact ADD COLUMN IF NOT EXISTS pattern used elsewhere in
// this directory.
//
// No DROP / destructive-ALTER statements anywhere in this file — see
// plateHrV2Persistence.test.ts.
//
// PR 1 scope: this module creates schema only. Nothing in this PR reads or
// writes rows in plate_hr_v2_labels or plate_hr_v2_model_registry — no
// labeler, no fitter, no artifact loader exists yet. Only
// plate_hr_v2_feature_snapshots and plate_hr_v2_sufficient_stats are written
// to, and only when PLATE_HR_V2_FORWARD_CAPTURE_ENABLED is explicitly set —
// see server/mlb/pregamePowerRadar/hrProbabilityV2/installPlateHrV2Capture.ts.

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

// One row per (session_date, game_id, batter_id, feature_version) —
// mutable-until-locked, not full per-build history (mirrors
// pregame_power_radar_signals' own mutable-until-locked convention). Becomes
// immutable the instant first pitch occurs — see the app-level UPSERT guard
// in server/storage.ts's upsertPlateHrV2FeatureSnapshot (WHERE locked_at IS
// NULL), which is the actual enforcement point; this table only stores the
// locked_at marker.
const PLATE_HR_V2_FEATURE_SNAPSHOTS = `
  CREATE TABLE IF NOT EXISTS plate_hr_v2_feature_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    session_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    batter_id TEXT NOT NULL,
    batter_name TEXT NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT,
    pitcher_id TEXT,
    pitcher_name TEXT,
    batting_order_slot INTEGER,
    build_id TEXT NOT NULL,
    first_captured_at TIMESTAMP NOT NULL,
    last_captured_at TIMESTAMP NOT NULL,
    capture_revision INTEGER NOT NULL DEFAULT 1,
    first_pitch_time TIMESTAMP,
    first_pitch_lock_eligible BOOLEAN NOT NULL DEFAULT false,
    game_status TEXT NOT NULL DEFAULT 'unknown',
    prediction_as_of TIMESTAMP NOT NULL,
    seconds_to_first_pitch INTEGER,
    lineup_confirmed_at TIMESTAMP,
    starter_confirmed BOOLEAN NOT NULL DEFAULT false,
    locked_at TIMESTAMP,
    input_contract_version TEXT NOT NULL,
    raw_inputs JSONB NOT NULL,
    feature_version TEXT NOT NULL,
    feature_hash TEXT NOT NULL,
    derived_features JSONB NOT NULL,
    availability JSONB NOT NULL,
    feature_freshness JSONB NOT NULL,
    leakage_warnings JSONB NOT NULL DEFAULT '[]',
    sufficient_stats_ref TEXT,
    champion_model_version TEXT,
    champion_score10 NUMERIC,
    champion_tier TEXT,
    champion_suppressed BOOLEAN,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
`;

const PLATE_HR_V2_FEATURE_SNAPSHOTS_SESSION_GAME_BATTER_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_feature_snapshots_session_game_batter_idx
    ON plate_hr_v2_feature_snapshots (session_date, game_id, batter_id);
`;
const PLATE_HR_V2_FEATURE_SNAPSHOTS_SESSION_DATE_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_feature_snapshots_session_date_idx
    ON plate_hr_v2_feature_snapshots (session_date);
`;
const PLATE_HR_V2_FEATURE_SNAPSHOTS_FEATURE_VERSION_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_feature_snapshots_feature_version_idx
    ON plate_hr_v2_feature_snapshots (feature_version);
`;
const PLATE_HR_V2_FEATURE_SNAPSHOTS_GAME_STATUS_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_feature_snapshots_game_status_idx
    ON plate_hr_v2_feature_snapshots (game_status);
`;
const PLATE_HR_V2_FEATURE_SNAPSHOTS_LOCKED_AT_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_feature_snapshots_locked_at_idx
    ON plate_hr_v2_feature_snapshots (locked_at);
`;

// Composite PRIMARY KEY (snapshot_id, label_version) — append-only, mirrors
// hr_radar_evaluation_labels exactly. Whole-game label rule (see
// plateHrV2LabelContract.ts), deliberately different from HR Radar
// Research's next-PA censoring rule.
const PLATE_HR_V2_LABELS = `
  CREATE TABLE IF NOT EXISTS plate_hr_v2_labels (
    snapshot_id TEXT NOT NULL,
    label_version TEXT NOT NULL,
    label_disposition TEXT NOT NULL,
    resolved_at TIMESTAMP,
    resolution_reason TEXT,
    hit_hr_today BOOLEAN,
    pa_count_observed INTEGER,
    hr_count_today INTEGER,
    hr_event_id TEXT,
    hr_inning INTEGER,
    hr_half TEXT,
    hr_plate_appearance_number INTEGER,
    hr_first_ab BOOLEAN,
    label_source TEXT NOT NULL DEFAULT 'engine',
    data_quality TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (snapshot_id, label_version)
  );
`;
const PLATE_HR_V2_LABELS_DISPOSITION_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_labels_disposition_idx ON plate_hr_v2_labels (label_disposition);
`;
const PLATE_HR_V2_LABELS_RESOLVED_AT_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_labels_resolved_at_idx ON plate_hr_v2_labels (resolved_at);
`;
const PLATE_HR_V2_LABELS_SNAPSHOT_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_labels_snapshot_idx ON plate_hr_v2_labels (snapshot_id);
`;

const PLATE_HR_V2_MODEL_REGISTRY = `
  CREATE TABLE IF NOT EXISTS plate_hr_v2_model_registry (
    model_version TEXT PRIMARY KEY,
    model_type TEXT NOT NULL,
    feature_version TEXT NOT NULL,
    training_window_start TEXT,
    training_window_end TEXT,
    holdout_window_start TEXT,
    holdout_window_end TEXT,
    artifact_path TEXT,
    artifact_checksum TEXT,
    standardization JSONB,
    metrics JSONB,
    status TEXT NOT NULL DEFAULT 'candidate',
    activated_at TIMESTAMP,
    retired_at TIMESTAMP,
    retirement_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );
`;
const PLATE_HR_V2_MODEL_REGISTRY_STATUS_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_model_registry_status_idx ON plate_hr_v2_model_registry (status);
`;
const PLATE_HR_V2_MODEL_REGISTRY_FEATURE_VERSION_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_model_registry_feature_version_idx ON plate_hr_v2_model_registry (feature_version);
`;

// The "separate historical aggregate/archive layer" (correction 2) — one row
// per (entity_type, entity_id, as_of_date), so a player's season-to-date
// evidence is stored once per day rather than duplicated into every game-day
// feature snapshot that references it (see deviation (k) in the plan).
const PLATE_HR_V2_SUFFICIENT_STATS = `
  CREATE TABLE IF NOT EXISTS plate_hr_v2_sufficient_stats (
    stats_id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    as_of_date TEXT NOT NULL,
    pitches_seen INTEGER NOT NULL DEFAULT 0,
    swings INTEGER NOT NULL DEFAULT 0,
    whiffs INTEGER NOT NULL DEFAULT 0,
    called_strikes INTEGER NOT NULL DEFAULT 0,
    balls INTEGER NOT NULL DEFAULT 0,
    zone_swings INTEGER,
    zone_takes INTEGER,
    chase_swings INTEGER,
    chase_takes INTEGER,
    zone_data_available BOOLEAN NOT NULL DEFAULT false,
    pa_count INTEGER NOT NULL DEFAULT 0,
    strikeouts INTEGER NOT NULL DEFAULT 0,
    walks INTEGER NOT NULL DEFAULT 0,
    batted_ball_events INTEGER NOT NULL DEFAULT 0,
    pitch_family_stats JSONB NOT NULL DEFAULT '{}',
    ev_percentiles JSONB NOT NULL DEFAULT '{}',
    la_percentiles JSONB NOT NULL DEFAULT '{}',
    pulled_bip INTEGER NOT NULL DEFAULT 0,
    spray_classified_bip INTEGER NOT NULL DEFAULT 0,
    source_row_count INTEGER NOT NULL DEFAULT 0,
    computed_at TIMESTAMP NOT NULL DEFAULT NOW()
  );
`;
const PLATE_HR_V2_SUFFICIENT_STATS_ENTITY_DATE_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_sufficient_stats_entity_date_idx
    ON plate_hr_v2_sufficient_stats (entity_type, entity_id, as_of_date);
`;
const PLATE_HR_V2_SUFFICIENT_STATS_AS_OF_DATE_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_sufficient_stats_as_of_date_idx
    ON plate_hr_v2_sufficient_stats (as_of_date);
`;

// Order matters only for readability (snapshots first since the other three
// conceptually depend on it, though no DB-level FK enforces that). Every
// statement is independently idempotent (`IF NOT EXISTS`), so re-ordering is
// otherwise safe.
export const PLATE_HR_V2_PERSISTENCE_STATEMENTS: readonly string[] = [
  PLATE_HR_V2_FEATURE_SNAPSHOTS,
  PLATE_HR_V2_FEATURE_SNAPSHOTS_SESSION_GAME_BATTER_IDX,
  PLATE_HR_V2_FEATURE_SNAPSHOTS_SESSION_DATE_IDX,
  PLATE_HR_V2_FEATURE_SNAPSHOTS_FEATURE_VERSION_IDX,
  PLATE_HR_V2_FEATURE_SNAPSHOTS_GAME_STATUS_IDX,
  PLATE_HR_V2_FEATURE_SNAPSHOTS_LOCKED_AT_IDX,
  PLATE_HR_V2_LABELS,
  PLATE_HR_V2_LABELS_DISPOSITION_IDX,
  PLATE_HR_V2_LABELS_RESOLVED_AT_IDX,
  PLATE_HR_V2_LABELS_SNAPSHOT_IDX,
  PLATE_HR_V2_MODEL_REGISTRY,
  PLATE_HR_V2_MODEL_REGISTRY_STATUS_IDX,
  PLATE_HR_V2_MODEL_REGISTRY_FEATURE_VERSION_IDX,
  PLATE_HR_V2_SUFFICIENT_STATS,
  PLATE_HR_V2_SUFFICIENT_STATS_ENTITY_DATE_IDX,
  PLATE_HR_V2_SUFFICIENT_STATS_AS_OF_DATE_IDX,
];

/**
 * Idempotent startup bootstrap for the four Plate HR V2 research tables.
 * Safe to run on every boot.
 *
 * Deliberately does NOT catch errors — a failure here must fail startup (see
 * server/index.ts) rather than let this schema silently fail to exist, which
 * would surface as confusing failures the first time forward capture
 * actually tries to write to one of these tables.
 */
export async function ensurePlateHrV2PersistenceSchema(client: SqlExecutor): Promise<void> {
  for (const statement of PLATE_HR_V2_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
