// Durable persistence bootstrap for the Plate HR V2 two-layer, APPEND-ONLY
// point-in-time snapshots (plan §7.1, PR1).
//
// Mirrors server/dbMigrations/plateHrV2Persistence.ts's convention against the
// Drizzle definitions in shared/schema.ts: idempotent
// `CREATE TABLE/INDEX IF NOT EXISTS` on every boot so `drizzle-kit push` not
// having been run by hand never leaves these tables missing. Drizzle owns the
// canonical schema/types — this is the runtime safety net.
//
// These tables are brand new in this PR, so there is no older shape to
// self-heal from. NO DROP / TRUNCATE / DELETE / RENAME / destructive ALTER
// anywhere in this file — enforced by plateHrV2SnapshotPersistence.test.ts.
//
// Nothing writes these tables yet: forward capture is wired in PR3. This PR
// only guarantees the schema exists so the capture writer has somewhere to go.

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

// One row per provider fetch of an entity's evidence. Append-only: a new fetch
// is a new row; shared source evidence is referenced by id from prediction
// snapshots, never duplicated into each batter row.
const PLATE_HR_V2_SOURCE_EVIDENCE = `
  CREATE TABLE IF NOT EXISTS plate_hr_v2_source_evidence (
    source_snapshot_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    evidence_kind TEXT NOT NULL,
    data_through_at TIMESTAMP,
    available_at TIMESTAMP NOT NULL,
    availability_source TEXT NOT NULL,
    valid_for_at TIMESTAMP,
    reconstructed BOOLEAN NOT NULL DEFAULT false,
    fetched_at TIMESTAMP NOT NULL,
    schema_version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    payload_ref TEXT,
    authorized_payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
  );
`;
// PR4.1: self-heal for any source-evidence table created before authorized_payload.
const PLATE_HR_V2_SOURCE_EVIDENCE_SELF_HEAL = `
  ALTER TABLE plate_hr_v2_source_evidence
    ADD COLUMN IF NOT EXISTS authorized_payload JSONB NOT NULL DEFAULT '{}';
`;
const PLATE_HR_V2_SOURCE_EVIDENCE_ENTITY_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_source_evidence_entity_idx
    ON plate_hr_v2_source_evidence (entity_type, entity_id);
`;
const PLATE_HR_V2_SOURCE_EVIDENCE_KIND_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_source_evidence_kind_idx
    ON plate_hr_v2_source_evidence (evidence_kind);
`;
const PLATE_HR_V2_SOURCE_EVIDENCE_AVAILABLE_AT_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_source_evidence_available_at_idx
    ON plate_hr_v2_source_evidence (available_at);
`;

// One row per (batter-game, moment). Append-only revisions: a distinct
// prediction_as_of is a distinct row (composite uniqueness below). A late
// lineup/probable/weather change creates a NEW row; the prior one is retained.
const PLATE_HR_V2_PREDICTION_SNAPSHOTS = `
  CREATE TABLE IF NOT EXISTS plate_hr_v2_prediction_snapshots (
    prediction_snapshot_id TEXT PRIMARY KEY,
    game_pk TEXT NOT NULL,
    batter_id TEXT NOT NULL,
    feature_version TEXT NOT NULL,
    prediction_as_of TIMESTAMP NOT NULL,
    first_pitch_time TIMESTAMP,
    source_snapshot_ids JSONB NOT NULL DEFAULT '[]',
    derived_features JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    authoritative BOOLEAN NOT NULL DEFAULT false,
    training_eligible BOOLEAN,
    created_at TIMESTAMP DEFAULT NOW()
  );
`;
// Composite uniqueness (game_pk, batter_id, feature_version, prediction_as_of):
// enforces "append a new revision", not "overwrite".
const PLATE_HR_V2_PREDICTION_SNAPSHOTS_IDENTITY_IDX = `
  CREATE UNIQUE INDEX IF NOT EXISTS plate_hr_v2_prediction_snapshots_identity_idx
    ON plate_hr_v2_prediction_snapshots (game_pk, batter_id, feature_version, prediction_as_of);
`;
const PLATE_HR_V2_PREDICTION_SNAPSHOTS_GAME_BATTER_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_prediction_snapshots_game_batter_idx
    ON plate_hr_v2_prediction_snapshots (game_pk, batter_id);
`;
const PLATE_HR_V2_PREDICTION_SNAPSHOTS_PREDICTION_AS_OF_IDX = `
  CREATE INDEX IF NOT EXISTS plate_hr_v2_prediction_snapshots_prediction_as_of_idx
    ON plate_hr_v2_prediction_snapshots (prediction_as_of);
`;

export const PLATE_HR_V2_SNAPSHOT_PERSISTENCE_STATEMENTS: readonly string[] = [
  PLATE_HR_V2_SOURCE_EVIDENCE,
  PLATE_HR_V2_SOURCE_EVIDENCE_SELF_HEAL,
  PLATE_HR_V2_SOURCE_EVIDENCE_ENTITY_IDX,
  PLATE_HR_V2_SOURCE_EVIDENCE_KIND_IDX,
  PLATE_HR_V2_SOURCE_EVIDENCE_AVAILABLE_AT_IDX,
  PLATE_HR_V2_PREDICTION_SNAPSHOTS,
  PLATE_HR_V2_PREDICTION_SNAPSHOTS_IDENTITY_IDX,
  PLATE_HR_V2_PREDICTION_SNAPSHOTS_GAME_BATTER_IDX,
  PLATE_HR_V2_PREDICTION_SNAPSHOTS_PREDICTION_AS_OF_IDX,
];

/**
 * Idempotent startup bootstrap for the two append-only snapshot tables. Safe on
 * every boot. Deliberately does NOT catch errors — a failure must fail startup
 * rather than let the schema silently not exist.
 */
export async function ensurePlateHrV2SnapshotSchema(client: SqlExecutor): Promise<void> {
  for (const statement of PLATE_HR_V2_SNAPSHOT_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
