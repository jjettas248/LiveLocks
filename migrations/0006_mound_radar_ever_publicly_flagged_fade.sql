-- Mound Radar — Fade-track analog of ever_publicly_flagged (2026-07).
-- Adds `ever_publicly_flagged_fade`, OR'd forward across same-slate rebuilds
-- AND at the DB upsert layer (see storage.ts's upsertMlbMoundRadarSignal),
-- mirroring ever_publicly_flagged's existing durability discipline exactly —
-- wasPubliclyFlaggedMound's tierEligible check (strong/elite/nuclear only)
-- structurally excludes "track" tier, so a Fade Candidate signal needs its
-- own flag with the same restart-durable guarantees. Additive, boolean,
-- defaulted — safe to apply online with zero backfill.
--
-- Canonical apply path for this repo is `drizzle-kit push:pg` (diffs
-- shared/schema.ts against the DB). This file is an idempotent hand-written
-- equivalent for manual/ops application; it is intentionally NOT wired into
-- the drizzle migration journal (mirrors 0005_pregame_radar_ever_publicly_flagged.sql).

ALTER TABLE "mlb_mound_radar_signals" ADD COLUMN IF NOT EXISTS "ever_publicly_flagged_fade" boolean NOT NULL DEFAULT false;
