-- Phase 0 HR Radar diagnostic persistence (2026-06)
-- Makes a future HR-Radar miss diagnosable from the DB alone — separating
-- model weakness from missing/degraded data. All columns are additive and
-- nullable, so this is safe to apply online with zero backfill.
--
-- Canonical apply path for this repo is `drizzle-kit push:pg` (diffs
-- shared/schema.ts against the DB). This file is an idempotent hand-written
-- equivalent for manual/ops application; it is intentionally NOT wired into
-- the drizzle migration journal.

ALTER TABLE "hr_radar_alerts" ADD COLUMN IF NOT EXISTS "raw_pre_cap_score" numeric;
ALTER TABLE "hr_radar_alerts" ADD COLUMN IF NOT EXISTS "final_score" numeric;
ALTER TABLE "hr_radar_alerts" ADD COLUMN IF NOT EXISTS "cap_reason" text;
ALTER TABLE "hr_radar_alerts" ADD COLUMN IF NOT EXISTS "suppression_reason" text;
ALTER TABLE "hr_radar_alerts" ADD COLUMN IF NOT EXISTS "missing_inputs" text[];
ALTER TABLE "hr_radar_alerts" ADD COLUMN IF NOT EXISTS "confidence" numeric;
ALTER TABLE "hr_radar_alerts" ADD COLUMN IF NOT EXISTS "data_quality_flags" text[];
ALTER TABLE "hr_radar_alerts" ADD COLUMN IF NOT EXISTS "first_seen_at" timestamp;
ALTER TABLE "hr_radar_alerts" ADD COLUMN IF NOT EXISTS "promoted_at" timestamp;
ALTER TABLE "hr_radar_alerts" ADD COLUMN IF NOT EXISTS "alert_sent_at" timestamp;
