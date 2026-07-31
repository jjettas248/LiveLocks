-- MLB Live Edge Trust Recovery — official-episode provenance columns (2026-07).
-- Additive, nullable, safe for rolling deployment. Populated ONLY at first
-- insert for MLB official rows; left NULL for every existing row and for
-- NBA/NCAAB, which never populate them. No backfill, no fabrication.
--
--   official_episode_key — mlb:v1:${gameId}:${playerId}:${market}. The MLB
--     conflict key for storage.ts's atomic INSERT ... ON CONFLICT DO NOTHING
--     path (recordMlbOfficialPlay), replacing duplicate_guard (which encodes
--     `direction` and would let a side flip mint a second official row for
--     the same episode). A plain UNIQUE constraint is correct here: Postgres
--     treats NULL as distinct from any other NULL, so legacy pre-recovery
--     rows (official_episode_key IS NULL) and NBA/NCAAB rows (always NULL)
--     may coexist in any number, while two non-NULL episode keys can never
--     collide.
--   first_public_at — the database's own now(), captured at the instant the
--     winning writer's INSERT actually commits. Distinct from `timestamp`
--     (engineGeneratedAt, i.e. engine-computation time, preserved unchanged)
--     — the two are frequently close but are not proven identical, so this
--     gets its own column rather than reusing `timestamp`.
--   odds_source_updated_at — the selected sportsbook's real provider
--     last_update. odds_fetched_at — LiveLocks' cache/receipt time for the
--     same quote. Never collapsed into one value; official freshness reads
--     odds_source_updated_at only.
--   raw_probability — pre-calibration side-selected probability, frozen
--     alongside the final calibrated value (`prob`) for calibration
--     reporting.
--   calibration_version, input_snapshot_hash, official_eligibility_version,
--     official_eligibility_reasons, data_quality, current_stat_known —
--     additional first-public provenance fields required by the recovery's
--     full 14-field snapshot (several of the 14 reuse existing generic
--     columns — prob/odds/engine_version/calibration_track — with identical
--     semantics; see shared/schema.ts for the field-by-field mapping).
--
-- Canonical apply path for this repo is `drizzle-kit push:pg` (diffs
-- shared/schema.ts against the DB). This file is an idempotent hand-written
-- equivalent for manual/ops application; it is intentionally NOT wired into
-- the drizzle migration journal (mirrors 0003/0005/0006/0007's pattern).

ALTER TABLE "persisted_plays" ADD COLUMN IF NOT EXISTS "official_episode_key" text;
ALTER TABLE "persisted_plays" ADD COLUMN IF NOT EXISTS "first_public_at" timestamp;
ALTER TABLE "persisted_plays" ADD COLUMN IF NOT EXISTS "odds_source_updated_at" timestamp;
ALTER TABLE "persisted_plays" ADD COLUMN IF NOT EXISTS "odds_fetched_at" timestamp;
ALTER TABLE "persisted_plays" ADD COLUMN IF NOT EXISTS "raw_probability" numeric;
ALTER TABLE "persisted_plays" ADD COLUMN IF NOT EXISTS "calibration_version" text;
ALTER TABLE "persisted_plays" ADD COLUMN IF NOT EXISTS "input_snapshot_hash" text;
ALTER TABLE "persisted_plays" ADD COLUMN IF NOT EXISTS "official_eligibility_version" text;
ALTER TABLE "persisted_plays" ADD COLUMN IF NOT EXISTS "official_eligibility_reasons" text;
ALTER TABLE "persisted_plays" ADD COLUMN IF NOT EXISTS "data_quality" text;
ALTER TABLE "persisted_plays" ADD COLUMN IF NOT EXISTS "current_stat_known" boolean;

-- Idempotent unique-constraint add (no IF NOT EXISTS form for constraints in
-- Postgres < 16's ALTER TABLE ADD CONSTRAINT; guard via catalog lookup so
-- this file can be re-run safely, matching this repo's other hand-written
-- migrations' re-run safety).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'persisted_plays_official_episode_key_unique'
  ) THEN
    ALTER TABLE "persisted_plays"
      ADD CONSTRAINT "persisted_plays_official_episode_key_unique" UNIQUE ("official_episode_key");
  END IF;
END $$;
