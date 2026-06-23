-- Pre-Game Power Radar — create the two additive tables.
-- Surgical + idempotent: touches ONLY these two tables (safe to run more than once).
-- Apply in your Replit env where DATABASE_URL is set, e.g.:
--   psql "$DATABASE_URL" -f migrations/manual_pregame_power_radar.sql

CREATE TABLE IF NOT EXISTS pregame_power_radar_signals (
  signal_id                 text PRIMARY KEY,
  build_id                  text NOT NULL,
  session_date              text NOT NULL,
  game_id                   text NOT NULL,
  game_date                 text NOT NULL,
  starts_at                 text,
  game_status               text NOT NULL DEFAULT 'unknown',
  first_pitch_lock_eligible boolean NOT NULL DEFAULT false,
  batter_id                 text NOT NULL,
  batter_name               text NOT NULL,
  team                      text NOT NULL,
  opponent                  text NOT NULL,
  pitcher_id                text,
  pitcher_name              text,
  batting_order_slot        integer,
  primary_market            text NOT NULL,
  market_tags               jsonb NOT NULL DEFAULT '[]'::jsonb,
  market_scores             jsonb NOT NULL DEFAULT '{}'::jsonb,
  score_10                  numeric NOT NULL,
  tier                      text NOT NULL,
  drivers                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostics               jsonb NOT NULL DEFAULT '{}'::jsonb,
  lineup_status             text NOT NULL,
  weather_status            text NOT NULL,
  has_market_line           boolean NOT NULL DEFAULT false,
  is_official_play          boolean NOT NULL DEFAULT false,
  is_pregame_target         boolean NOT NULL DEFAULT true,
  status                    text NOT NULL DEFAULT 'active',
  suppressed                boolean NOT NULL DEFAULT false,
  suppressed_reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcomes                  jsonb,
  became_live_ready         boolean NOT NULL DEFAULT false,
  became_live_fire          boolean NOT NULL DEFAULT false,
  converted_live_at         timestamp,
  created_at                timestamp DEFAULT now(),
  updated_at                timestamp DEFAULT now(),
  locked_at                 timestamp,
  graded_at                 timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS pregame_power_radar_signals_unique_idx
  ON pregame_power_radar_signals (session_date, game_id, batter_id);
CREATE INDEX IF NOT EXISTS pregame_power_radar_signals_session_date_idx
  ON pregame_power_radar_signals (session_date);
CREATE INDEX IF NOT EXISTS pregame_power_radar_signals_build_idx
  ON pregame_power_radar_signals (build_id);

CREATE TABLE IF NOT EXISTS pregame_power_radar_builds (
  build_id           text PRIMARY KEY,
  session_date       text NOT NULL,
  started_at         text NOT NULL,
  completed_at       text,
  games_scanned      integer NOT NULL DEFAULT 0,
  batters_evaluated  integer NOT NULL DEFAULT 0,
  lineup_coverage    numeric,
  weather_coverage   numeric,
  batter_coverage    numeric,
  pitcher_coverage   numeric,
  signals_created    integer NOT NULL DEFAULT 0,
  suppressed_count   integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'complete',
  error              text,
  created_at         timestamp DEFAULT now(),
  updated_at         timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pregame_power_radar_builds_session_date_idx
  ON pregame_power_radar_builds (session_date);
