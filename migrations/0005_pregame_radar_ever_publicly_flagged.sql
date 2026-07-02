-- Pre-Game Power Radar — freeze pregame eligibility across rebuilds (2026-07).
-- Adds `ever_publicly_flagged`, OR'd forward across same-slate rebuilds, so a
-- later dip in mutable eligibility fields (tier/score/dataCoverageScore/etc.)
-- can never erase an earlier legitimate "publicly flagged pregame" result.
-- Additive, boolean, defaulted — safe to apply online with zero backfill.
--
-- Canonical apply path for this repo is `drizzle-kit push:pg` (diffs
-- shared/schema.ts against the DB). This file is an idempotent hand-written
-- equivalent for manual/ops application; it is intentionally NOT wired into
-- the drizzle migration journal.

ALTER TABLE "pregame_power_radar_signals" ADD COLUMN IF NOT EXISTS "ever_publicly_flagged" boolean NOT NULL DEFAULT false;
