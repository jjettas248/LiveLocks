// Durable persistence bootstrap for the HR Radar research foundation (PR 1).
//
// Mirrors the Drizzle definitions in shared/schema.ts column-for-column, for
// the same reason pregameRadarPersistence.ts exists: `drizzle-kit push` may
// not have been run by hand against a given database yet, so this creates
// the five HR Radar research tables (and their indexes) idempotently via
// `IF NOT EXISTS` on every boot. Drizzle continues to own the canonical
// schema/types — this is a runtime safety net, not a replacement for
// `drizzle-kit push`.
//
// All five tables are brand new in this PR, so there is no pre-existing
// older shape to self-heal from (no `..._SELF_HEAL` ALTER TABLE constants).
// A future PR that adds a column to one of these tables should add one then,
// following the exact ADD COLUMN IF NOT EXISTS pattern used in
// pregameRadarPersistence.ts.
//
// No DROP / destructive-ALTER statements anywhere in this file — see
// hrRadarResearchPersistence.test.ts.
//
// PR 1 scope: this module creates schema only. Nothing in this PR reads or
// writes rows in these tables — no capture, no labeling, no inference, no
// champion/runtime/UI call site exists yet.

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

const HR_RADAR_EVALUATION_SNAPSHOTS = `
  CREATE TABLE IF NOT EXISTS hr_radar_evaluation_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    evaluation_epoch_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL DEFAULT 0,
    session_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT,
    evaluation_at TIMESTAMP NOT NULL,
    source_event_at TIMESTAMP,
    source_event_id TEXT,
    trigger_type TEXT NOT NULL,
    play_sequence INTEGER,
    plate_appearance_id TEXT,
    inning INTEGER,
    half TEXT,
    outs INTEGER,
    current_pitcher_id TEXT,
    batting_order_slot INTEGER,
    eligible BOOLEAN NOT NULL DEFAULT true,
    exclusion_reason TEXT,
    prediction_target_scope TEXT NOT NULL DEFAULT 'first_hr_of_game',
    input_contract_version TEXT NOT NULL,
    raw_inputs JSONB NOT NULL,
    feature_version TEXT NOT NULL,
    feature_hash TEXT NOT NULL,
    derived_features JSONB NOT NULL,
    availability JSONB NOT NULL,
    feature_freshness JSONB NOT NULL,
    stats_as_of TIMESTAMP NOT NULL,
    champion_evaluated BOOLEAN NOT NULL DEFAULT false,
    champion_exclusion_reason TEXT,
    champion_version_source TEXT,
    champion_model_version TEXT,
    champion_raw_probability NUMERIC,
    champion_calibrated_probability NUMERIC,
    champion_build_score NUMERIC,
    champion_readiness_score NUMERIC,
    champion_alert_path TEXT,
    champion_alert_tier TEXT,
    champion_stage TEXT,
    champion_user_visible BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
  );
`;

const HR_RADAR_EVALUATION_SNAPSHOTS_EPOCH_UNIQUE_IDX = `
  CREATE UNIQUE INDEX IF NOT EXISTS hr_radar_eval_snapshots_epoch_unique_idx
    ON hr_radar_evaluation_snapshots (evaluation_epoch_id, player_id, feature_version, source_revision);
`;

const HR_RADAR_EVALUATION_SNAPSHOTS_EPOCH_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_eval_snapshots_epoch_idx
    ON hr_radar_evaluation_snapshots (evaluation_epoch_id);
`;

const HR_RADAR_EVALUATION_SNAPSHOTS_SESSION_GAME_EVAL_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_eval_snapshots_session_game_eval_idx
    ON hr_radar_evaluation_snapshots (session_date, game_id, evaluation_at);
`;

const HR_RADAR_EVALUATION_SNAPSHOTS_GAME_PLAYER_EVAL_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_eval_snapshots_game_player_eval_idx
    ON hr_radar_evaluation_snapshots (game_id, player_id, evaluation_at);
`;

const HR_RADAR_EVALUATION_SNAPSHOTS_FEATURE_VERSION_EVAL_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_eval_snapshots_feature_version_eval_idx
    ON hr_radar_evaluation_snapshots (feature_version, evaluation_at);
`;

// Supports an anti-join against hr_radar_evaluation_labels to find
// eligible-but-unlabeled rows. NOT a partial/predicated index — Postgres
// cannot index one table by the absence of a row in a different table.
const HR_RADAR_EVALUATION_SNAPSHOTS_ELIGIBLE_UNLABELED_LOOKUP_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_eval_snapshots_eligible_unlabeled_lookup_idx
    ON hr_radar_evaluation_snapshots (eligible, session_date, snapshot_id);
`;

// Composite PRIMARY KEY (snapshot_id, label_version) — append-only. A
// corrected label adds a new versioned row rather than overwriting history.
const HR_RADAR_EVALUATION_LABELS = `
  CREATE TABLE IF NOT EXISTS hr_radar_evaluation_labels (
    snapshot_id TEXT NOT NULL,
    label_version TEXT NOT NULL,
    label_disposition TEXT NOT NULL,
    resolved_at TIMESTAMP,
    resolution_reason TEXT,
    hr_remainder_game BOOLEAN,
    hr_next_pa BOOLEAN,
    next_pa_occurred BOOLEAN,
    hr_next_two_pa BOOLEAN,
    second_pa_occurred BOOLEAN,
    remaining_pa_observed INTEGER,
    next_pa_id TEXT,
    second_pa_id TEXT,
    hr_event_id TEXT,
    hr_play_sequence INTEGER,
    hr_at TIMESTAMP,
    hr_inning INTEGER,
    hr_pa_ordinal INTEGER,
    label_source TEXT NOT NULL DEFAULT 'engine',
    data_quality TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (snapshot_id, label_version)
  );
`;

const HR_RADAR_EVALUATION_LABELS_DISPOSITION_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_eval_labels_disposition_idx
    ON hr_radar_evaluation_labels (label_disposition);
`;

const HR_RADAR_EVALUATION_LABELS_RESOLVED_AT_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_eval_labels_resolved_at_idx
    ON hr_radar_evaluation_labels (resolved_at);
`;

const HR_RADAR_EVALUATION_LABELS_SNAPSHOT_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_eval_labels_snapshot_idx
    ON hr_radar_evaluation_labels (snapshot_id);
`;

// Probability + rank ONLY. Proposed stage/policy live in
// hr_radar_shadow_decisions below.
const HR_RADAR_SHADOW_PREDICTIONS = `
  CREATE TABLE IF NOT EXISTS hr_radar_shadow_predictions (
    id SERIAL PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    prob_next_pa NUMERIC,
    prob_next_two_pa NUMERIC,
    prob_remainder_game NUMERIC,
    baseline_only_prob NUMERIC,
    live_lift NUMERIC,
    rank_in_game INTEGER,
    inference_duration_ms INTEGER,
    error_state TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );
`;

const HR_RADAR_SHADOW_PREDICTIONS_SNAPSHOT_MODEL_UNIQUE_IDX = `
  CREATE UNIQUE INDEX IF NOT EXISTS hr_radar_shadow_predictions_snapshot_model_unique_idx
    ON hr_radar_shadow_predictions (snapshot_id, model_version);
`;

const HR_RADAR_SHADOW_PREDICTIONS_MODEL_VERSION_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_shadow_predictions_model_version_idx
    ON hr_radar_shadow_predictions (model_version);
`;

const HR_RADAR_SHADOW_PREDICTIONS_SNAPSHOT_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_shadow_predictions_snapshot_idx
    ON hr_radar_shadow_predictions (snapshot_id);
`;

// Model + policy -> proposed stage. Split from hr_radar_shadow_predictions so
// multiple policy versions can be evaluated against one model's
// probabilities without duplicating the (expensive) inference output.
const HR_RADAR_SHADOW_DECISIONS = `
  CREATE TABLE IF NOT EXISTS hr_radar_shadow_decisions (
    id SERIAL PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    proposed_stage TEXT,
    previous_proposed_stage TEXT,
    stage_transitioned BOOLEAN NOT NULL DEFAULT false,
    top_drivers JSONB,
    artifact_checksum TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );
`;

const HR_RADAR_SHADOW_DECISIONS_SNAPSHOT_MODEL_POLICY_UNIQUE_IDX = `
  CREATE UNIQUE INDEX IF NOT EXISTS hr_radar_shadow_decisions_snapshot_model_policy_unique_idx
    ON hr_radar_shadow_decisions (snapshot_id, model_version, policy_version);
`;

const HR_RADAR_SHADOW_DECISIONS_MODEL_POLICY_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_shadow_decisions_model_policy_idx
    ON hr_radar_shadow_decisions (model_version, policy_version);
`;

const HR_RADAR_SHADOW_DECISIONS_SNAPSHOT_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_shadow_decisions_snapshot_idx
    ON hr_radar_shadow_decisions (snapshot_id);
`;

// Supports the "first Fire transition" counting query — see
// hrStagePolicyContract.ts.
const HR_RADAR_SHADOW_DECISIONS_STAGE_TRANSITION_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_shadow_decisions_stage_transition_idx
    ON hr_radar_shadow_decisions (proposed_stage, stage_transitioned);
`;

const HR_RADAR_MODEL_REGISTRY = `
  CREATE TABLE IF NOT EXISTS hr_radar_model_registry (
    model_version TEXT PRIMARY KEY,
    model_type TEXT NOT NULL,
    feature_version TEXT NOT NULL,
    training_window_start TEXT,
    training_window_end TEXT,
    calibration_window_start TEXT,
    calibration_window_end TEXT,
    holdout_window_start TEXT,
    holdout_window_end TEXT,
    artifact_path TEXT,
    artifact_checksum TEXT,
    metrics JSONB,
    status TEXT NOT NULL DEFAULT 'candidate',
    activated_at TIMESTAMP,
    retired_at TIMESTAMP,
    retirement_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );
`;

const HR_RADAR_MODEL_REGISTRY_STATUS_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_model_registry_status_idx
    ON hr_radar_model_registry (status);
`;

const HR_RADAR_MODEL_REGISTRY_FEATURE_VERSION_IDX = `
  CREATE INDEX IF NOT EXISTS hr_radar_model_registry_feature_version_idx
    ON hr_radar_model_registry (feature_version);
`;

// Order matters only for readability (snapshots first since the other four
// conceptually depend on it, though no DB-level FK enforces that). Every
// statement is independently idempotent (`IF NOT EXISTS`), so re-ordering is
// otherwise safe.
export const HR_RADAR_RESEARCH_PERSISTENCE_STATEMENTS: readonly string[] = [
  HR_RADAR_EVALUATION_SNAPSHOTS,
  HR_RADAR_EVALUATION_SNAPSHOTS_EPOCH_UNIQUE_IDX,
  HR_RADAR_EVALUATION_SNAPSHOTS_EPOCH_IDX,
  HR_RADAR_EVALUATION_SNAPSHOTS_SESSION_GAME_EVAL_IDX,
  HR_RADAR_EVALUATION_SNAPSHOTS_GAME_PLAYER_EVAL_IDX,
  HR_RADAR_EVALUATION_SNAPSHOTS_FEATURE_VERSION_EVAL_IDX,
  HR_RADAR_EVALUATION_SNAPSHOTS_ELIGIBLE_UNLABELED_LOOKUP_IDX,
  HR_RADAR_EVALUATION_LABELS,
  HR_RADAR_EVALUATION_LABELS_DISPOSITION_IDX,
  HR_RADAR_EVALUATION_LABELS_RESOLVED_AT_IDX,
  HR_RADAR_EVALUATION_LABELS_SNAPSHOT_IDX,
  HR_RADAR_SHADOW_PREDICTIONS,
  HR_RADAR_SHADOW_PREDICTIONS_SNAPSHOT_MODEL_UNIQUE_IDX,
  HR_RADAR_SHADOW_PREDICTIONS_MODEL_VERSION_IDX,
  HR_RADAR_SHADOW_PREDICTIONS_SNAPSHOT_IDX,
  HR_RADAR_SHADOW_DECISIONS,
  HR_RADAR_SHADOW_DECISIONS_SNAPSHOT_MODEL_POLICY_UNIQUE_IDX,
  HR_RADAR_SHADOW_DECISIONS_MODEL_POLICY_IDX,
  HR_RADAR_SHADOW_DECISIONS_SNAPSHOT_IDX,
  HR_RADAR_SHADOW_DECISIONS_STAGE_TRANSITION_IDX,
  HR_RADAR_MODEL_REGISTRY,
  HR_RADAR_MODEL_REGISTRY_STATUS_IDX,
  HR_RADAR_MODEL_REGISTRY_FEATURE_VERSION_IDX,
];

/**
 * Idempotent startup bootstrap for the five HR Radar research tables.
 * Safe to run on every boot.
 *
 * Deliberately does NOT catch errors — a failure here must fail startup
 * (see server/index.ts) rather than let this schema silently fail to exist,
 * which would surface as confusing failures the first time a later PR
 * actually tries to write to one of these tables.
 */
export async function ensureHrRadarResearchPersistenceSchema(client: SqlExecutor): Promise<void> {
  for (const statement of HR_RADAR_RESEARCH_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
