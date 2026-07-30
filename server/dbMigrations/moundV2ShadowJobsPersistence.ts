// Durable persistence bootstrap for Mound Radar V2 (shadow) evaluation
// outbox (Final Pre-Push Integrity Pass). Mirrors
// moundV2ShadowPersistence.ts's exact convention: idempotent `IF NOT EXISTS`
// DDL run on every boot, since `drizzle-kit push` may not have been run by
// hand against a given database yet. Drizzle continues to own the canonical
// schema/types — this is a runtime safety net, not a replacement.
//
// This table is the durable handoff that makes V2 evaluation safe to move
// out of buildMlbMoundRadar.ts's publication-critical path — see
// shared/schema.ts's moundV2ShadowJobs doc comment for the full design.

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

const MOUND_V2_SHADOW_JOBS = `
  CREATE TABLE IF NOT EXISTS mound_v2_shadow_jobs (
    job_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL UNIQUE,
    game_id TEXT NOT NULL,
    pitcher_id TEXT NOT NULL,
    signal_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    enqueued_at TIMESTAMP NOT NULL DEFAULT NOW(),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempted_at TIMESTAMP,
    last_failure_reason TEXT,
    claimed_at TIMESTAMP,
    claimed_by TEXT,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );
`;

const MOUND_V2_SHADOW_JOBS_STATUS_IDX = `
  CREATE INDEX IF NOT EXISTS mound_v2_shadow_jobs_status_idx
    ON mound_v2_shadow_jobs (status);
`;

const MOUND_V2_SHADOW_JOBS_ENQUEUED_AT_IDX = `
  CREATE INDEX IF NOT EXISTS mound_v2_shadow_jobs_enqueued_at_idx
    ON mound_v2_shadow_jobs (enqueued_at);
`;

const MOUND_V2_SHADOW_JOBS_GAME_PITCHER_IDX = `
  CREATE INDEX IF NOT EXISTS mound_v2_shadow_jobs_game_pitcher_idx
    ON mound_v2_shadow_jobs (game_id, pitcher_id);
`;

export const MOUND_V2_SHADOW_JOBS_PERSISTENCE_STATEMENTS: readonly string[] = [
  MOUND_V2_SHADOW_JOBS,
  MOUND_V2_SHADOW_JOBS_STATUS_IDX,
  MOUND_V2_SHADOW_JOBS_ENQUEUED_AT_IDX,
  MOUND_V2_SHADOW_JOBS_GAME_PITCHER_IDX,
];

/**
 * Idempotent startup bootstrap for the mound_v2_shadow_jobs table. Safe to
 * run on every boot. Deliberately does NOT catch errors — a failure here
 * must fail startup (see server/index.ts) rather than let this schema
 * silently fail to exist.
 */
export async function ensureMoundV2ShadowJobsPersistenceSchema(client: SqlExecutor): Promise<void> {
  for (const statement of MOUND_V2_SHADOW_JOBS_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
