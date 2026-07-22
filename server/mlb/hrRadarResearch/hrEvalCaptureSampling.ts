// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — deterministic per-game capture sampling (PR 2).
//
// Decides whether a given gameId falls inside the rolled-out percentage of
// games sampled for evaluation capture (HR_RADAR_EVAL_CAPTURE_GAME_PERCENT).
// Deterministic per gameId (same game always samples the same way across
// ticks and process restarts) and monotonic in percent (raising the percent
// only adds games, never removes previously-sampled ones), since the bucket
// a game hashes into never moves. Pure, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";

export function shouldSampleGameForHrEvalCapture(gameId: string, percent: number): boolean {
  if (!Number.isFinite(percent) || percent <= 0) return false;
  if (percent >= 100) return true;
  const digest = crypto.createHash("sha256").update(gameId).digest();
  const bucket = digest.readUInt32BE(0) / 0xffffffff; // [0, 1)
  return bucket * 100 < percent;
}
