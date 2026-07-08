-- Mound Radar — dedicated, sticky-upsert column for moundDirection (2026-07).
-- Previously embedded in the jsonb `diagnostics` column, which is
-- wholesale-overwritten on every upsert with no merge logic — an intervening
-- rebuild (e.g. after a server restart with no prevSignals to pin against)
-- could silently lose a legitimately-stamped "fade" direction before
-- grading ever runs. Promoted to its own column with sticky-once-"fade"
-- upsert semantics (see storage.ts's CASE expression): once a signal is
-- ever persisted with moundDirection='fade', no later rebuild can overwrite
-- it. "follow" and null are NOT sticky — deriveMoundOutcome's settlement
-- rule treats them identically (only "fade" flips the comparison), so only
-- "fade" needs durability. Additive, nullable — safe to apply online with
-- zero backfill.
--
-- Canonical apply path for this repo is `drizzle-kit push:pg` (diffs
-- shared/schema.ts against the DB). This file is an idempotent hand-written
-- equivalent for manual/ops application; it is intentionally NOT wired into
-- the drizzle migration journal (mirrors 0005/0006's pattern).

ALTER TABLE "mlb_mound_radar_signals" ADD COLUMN IF NOT EXISTS "mound_direction" text;
