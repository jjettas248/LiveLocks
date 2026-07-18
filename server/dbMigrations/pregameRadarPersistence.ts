// Durable persistence bootstrap for the Pre-Game Power Radar (Plate) and MLB
// Mound Radar (Mound) tracks.
//
// These tracks previously relied on `drizzle-kit push:pg` having been run
// by hand against the target database before boot. If it hadn't, every
// upsert in storage.ts (upsertPregamePowerRadarSignal, recordPregamePowerBuild,
// upsertMlbMoundRadarSignal, recordMlbMoundRadarBuild) failed against a
// missing table, was swallowed by the caller's try/catch, and the radar ran
// on in-memory state only — durable history silently lost across restarts.
//
// This module creates the four tables (and their indexes) idempotently via
// `IF NOT EXISTS` so a fresh database is self-healing on boot. It intentionally
// mirrors the Drizzle definitions in shared/schema.ts column-for-column;
// Drizzle continues to own the canonical schema/types, this is a runtime
// safety net, not a replacement for `drizzle-kit push:pg`.
//
// Also self-heals a pre-existing (older) copy of these tables that predates
// one of the sticky/graded-state columns below — additive `ADD COLUMN IF NOT
// EXISTS` only, so re-running against an already-current table is a no-op.
//
// No DROP / destructive-ALTER statements anywhere in this file — see
// pregameRadarPersistence.test.ts.

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

const PREGAME_POWER_RADAR_SIGNALS = `
  CREATE TABLE IF NOT EXISTS pregame_power_radar_signals (
    signal_id TEXT PRIMARY KEY,
    build_id TEXT NOT NULL,
    session_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    game_date TEXT NOT NULL,
    starts_at TEXT,
    game_status TEXT NOT NULL DEFAULT 'unknown',
    first_pitch_lock_eligible BOOLEAN NOT NULL DEFAULT false,
    batter_id TEXT NOT NULL,
    batter_name TEXT NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT NOT NULL,
    pitcher_id TEXT,
    pitcher_name TEXT,
    batting_order_slot INTEGER,
    primary_market TEXT NOT NULL,
    market_tags JSONB NOT NULL DEFAULT '[]',
    market_scores JSONB NOT NULL DEFAULT '{}',
    score_10 NUMERIC NOT NULL,
    tier TEXT NOT NULL,
    drivers JSONB NOT NULL DEFAULT '[]',
    warnings JSONB NOT NULL DEFAULT '[]',
    diagnostics JSONB NOT NULL DEFAULT '{}',
    lineup_status TEXT NOT NULL,
    weather_status TEXT NOT NULL,
    has_market_line BOOLEAN NOT NULL DEFAULT false,
    is_official_play BOOLEAN NOT NULL DEFAULT false,
    is_pregame_target BOOLEAN NOT NULL DEFAULT true,
    status TEXT NOT NULL DEFAULT 'active',
    suppressed BOOLEAN NOT NULL DEFAULT false,
    suppressed_reasons JSONB NOT NULL DEFAULT '[]',
    outcomes JSONB,
    ever_publicly_flagged BOOLEAN NOT NULL DEFAULT false,
    became_live_ready BOOLEAN NOT NULL DEFAULT false,
    became_live_fire BOOLEAN NOT NULL DEFAULT false,
    converted_live_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    locked_at TIMESTAMP,
    graded_at TIMESTAMP
  );
`;

// Self-heal: an older copy of this table created before ever_publicly_flagged
// existed. Additive-only — no-op once the column is already present.
const PREGAME_POWER_RADAR_SIGNALS_SELF_HEAL = `
  ALTER TABLE pregame_power_radar_signals
    ADD COLUMN IF NOT EXISTS ever_publicly_flagged BOOLEAN NOT NULL DEFAULT false;
`;

const PREGAME_POWER_RADAR_SIGNALS_UNIQUE_IDX = `
  CREATE UNIQUE INDEX IF NOT EXISTS pregame_power_radar_signals_unique_idx
    ON pregame_power_radar_signals (session_date, game_id, batter_id);
`;

const PREGAME_POWER_RADAR_SIGNALS_DATE_IDX = `
  CREATE INDEX IF NOT EXISTS pregame_power_radar_signals_session_date_idx
    ON pregame_power_radar_signals (session_date);
`;

const PREGAME_POWER_RADAR_SIGNALS_BUILD_IDX = `
  CREATE INDEX IF NOT EXISTS pregame_power_radar_signals_build_idx
    ON pregame_power_radar_signals (build_id);
`;

const PREGAME_POWER_RADAR_BUILDS = `
  CREATE TABLE IF NOT EXISTS pregame_power_radar_builds (
    build_id TEXT PRIMARY KEY,
    session_date TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    games_scanned INTEGER NOT NULL DEFAULT 0,
    batters_evaluated INTEGER NOT NULL DEFAULT 0,
    lineup_coverage NUMERIC,
    weather_coverage NUMERIC,
    batter_coverage NUMERIC,
    pitcher_coverage NUMERIC,
    signals_created INTEGER NOT NULL DEFAULT 0,
    suppressed_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'complete',
    error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
`;

const PREGAME_POWER_RADAR_BUILDS_DATE_IDX = `
  CREATE INDEX IF NOT EXISTS pregame_power_radar_builds_session_date_idx
    ON pregame_power_radar_builds (session_date);
`;

const MLB_MOUND_RADAR_SIGNALS = `
  CREATE TABLE IF NOT EXISTS mlb_mound_radar_signals (
    signal_id TEXT PRIMARY KEY,
    build_id TEXT NOT NULL,
    session_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    game_date TEXT NOT NULL,
    starts_at TEXT,
    game_status TEXT NOT NULL DEFAULT 'unknown',
    first_pitch_lock_eligible BOOLEAN NOT NULL DEFAULT false,
    pitcher_id TEXT NOT NULL,
    pitcher_name TEXT NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT NOT NULL,
    opposing_lineup_confirmed BOOLEAN NOT NULL DEFAULT false,
    primary_market TEXT NOT NULL,
    market_tags JSONB NOT NULL DEFAULT '[]',
    market_scores JSONB NOT NULL DEFAULT '{}',
    score_10 NUMERIC NOT NULL,
    tier TEXT NOT NULL,
    drivers JSONB NOT NULL DEFAULT '[]',
    warnings JSONB NOT NULL DEFAULT '[]',
    diagnostics JSONB NOT NULL DEFAULT '{}',
    lineup_status TEXT NOT NULL,
    weather_status TEXT NOT NULL,
    has_market_line BOOLEAN NOT NULL DEFAULT false,
    is_official_play BOOLEAN NOT NULL DEFAULT false,
    is_pregame_target BOOLEAN NOT NULL DEFAULT true,
    status TEXT NOT NULL DEFAULT 'active',
    suppressed BOOLEAN NOT NULL DEFAULT false,
    suppressed_reasons JSONB NOT NULL DEFAULT '[]',
    outcomes JSONB,
    ever_publicly_flagged BOOLEAN NOT NULL DEFAULT false,
    ever_publicly_flagged_fade BOOLEAN NOT NULL DEFAULT false,
    mound_direction TEXT,
    became_live_ready BOOLEAN NOT NULL DEFAULT false,
    became_live_fire BOOLEAN NOT NULL DEFAULT false,
    converted_live_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    locked_at TIMESTAMP,
    graded_at TIMESTAMP
  );
`;

// Self-heal: an older copy of this table created before the fade-track
// columns existed. Additive-only — no-op once both columns are present.
const MLB_MOUND_RADAR_SIGNALS_SELF_HEAL = `
  ALTER TABLE mlb_mound_radar_signals
    ADD COLUMN IF NOT EXISTS ever_publicly_flagged_fade BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS mound_direction TEXT;
`;

const MLB_MOUND_RADAR_SIGNALS_UNIQUE_IDX = `
  CREATE UNIQUE INDEX IF NOT EXISTS mlb_mound_radar_signals_unique_idx
    ON mlb_mound_radar_signals (session_date, game_id, pitcher_id);
`;

const MLB_MOUND_RADAR_SIGNALS_DATE_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_mound_radar_signals_session_date_idx
    ON mlb_mound_radar_signals (session_date);
`;

const MLB_MOUND_RADAR_SIGNALS_BUILD_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_mound_radar_signals_build_idx
    ON mlb_mound_radar_signals (build_id);
`;

const MLB_MOUND_RADAR_BUILDS = `
  CREATE TABLE IF NOT EXISTS mlb_mound_radar_builds (
    build_id TEXT PRIMARY KEY,
    session_date TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    games_scanned INTEGER NOT NULL DEFAULT 0,
    pitchers_evaluated INTEGER NOT NULL DEFAULT 0,
    starter_coverage NUMERIC,
    weather_coverage NUMERIC,
    pitcher_coverage NUMERIC,
    lineup_coverage NUMERIC,
    signals_created INTEGER NOT NULL DEFAULT 0,
    suppressed_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'complete',
    error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
`;

const MLB_MOUND_RADAR_BUILDS_DATE_IDX = `
  CREATE INDEX IF NOT EXISTS mlb_mound_radar_builds_session_date_idx
    ON mlb_mound_radar_builds (session_date);
`;

// Order matters: each signals table before its build table is not required,
// but tables before their own indexes is. Every statement is independently
// idempotent (`IF NOT EXISTS`), so the array order is otherwise cosmetic.
export const PREGAME_RADAR_PERSISTENCE_STATEMENTS: readonly string[] = [
  PREGAME_POWER_RADAR_SIGNALS,
  PREGAME_POWER_RADAR_SIGNALS_SELF_HEAL,
  PREGAME_POWER_RADAR_SIGNALS_UNIQUE_IDX,
  PREGAME_POWER_RADAR_SIGNALS_DATE_IDX,
  PREGAME_POWER_RADAR_SIGNALS_BUILD_IDX,
  PREGAME_POWER_RADAR_BUILDS,
  PREGAME_POWER_RADAR_BUILDS_DATE_IDX,
  MLB_MOUND_RADAR_SIGNALS,
  MLB_MOUND_RADAR_SIGNALS_SELF_HEAL,
  MLB_MOUND_RADAR_SIGNALS_UNIQUE_IDX,
  MLB_MOUND_RADAR_SIGNALS_DATE_IDX,
  MLB_MOUND_RADAR_SIGNALS_BUILD_IDX,
  MLB_MOUND_RADAR_BUILDS,
  MLB_MOUND_RADAR_BUILDS_DATE_IDX,
];

/**
 * Idempotent startup bootstrap for the Pregame Power Radar (Plate) and MLB
 * Mound Radar (Mound) durable tables. Safe to run on every boot.
 *
 * Deliberately does NOT catch errors — a failure here must fail startup
 * (see server/index.ts) rather than let the radars silently fall back to
 * in-memory-only operation and lose history across restarts/deploys.
 */
export async function ensurePregameRadarPersistenceSchema(client: SqlExecutor): Promise<void> {
  for (const statement of PREGAME_RADAR_PERSISTENCE_STATEMENTS) {
    await client.query(statement);
  }
}
