// ─────────────────────────────────────────────────────────────────────────────
// Power Prior module — public surface (Phase 1, shadow-only).
//
// Re-exports the canonical contract + read-only mappers/comparators, and provides
// `runPowerPriorShadow(...)`: the single, bounded, fully try/catch-wrapped hook the
// live HR path calls to log a standalone-vs-inline comparison under
// `[POWER_PRIOR_SHADOW]`. It NEVER mutates state, NEVER throws into the caller, and
// NEVER changes the inline prior or any live scoring/staging/grading.
// ─────────────────────────────────────────────────────────────────────────────

import { todayET } from "../../utils/dateUtils";
import { getCachedMlbGameSessionDate } from "../../utils/mlbSessionDate";
import { comparePowerPriors } from "./comparePowerPriors";
import { getPowerPrior } from "./getPowerPrior";

export * from "./types";
export { getPowerPrior, mapSignalToPowerPrior, mapStandaloneTier } from "./getPowerPrior";
export {
  comparePowerPriors,
  inlineFormScoreToApproxTier,
  POWER_PRIOR_DELTA_LOW_MAX,
  POWER_PRIOR_DELTA_MEDIUM_MAX,
} from "./comparePowerPriors";

// ── Bounded rate limiting ────────────────────────────────────────────────────
// Log at most once per (gameId:playerId) per interval, and cap the dedupe map so
// a long-running process can never leak memory through this diagnostic.
const SHADOW_MIN_INTERVAL_MS = 60_000;
const SHADOW_MAX_KEYS = 5_000;
const lastLoggedAtMs = new Map<string, number>();

function shouldLog(key: string, nowMs: number): boolean {
  const prev = lastLoggedAtMs.get(key);
  if (prev != null && nowMs - prev < SHADOW_MIN_INTERVAL_MS) return false;
  if (!lastLoggedAtMs.has(key) && lastLoggedAtMs.size >= SHADOW_MAX_KEYS) {
    // Map is full of recent keys — drop the oldest to stay bounded.
    const oldest = lastLoggedAtMs.keys().next().value;
    if (oldest !== undefined) lastLoggedAtMs.delete(oldest);
  }
  lastLoggedAtMs.set(key, nowMs);
  return true;
}

export interface PowerPriorShadowInput {
  gameId: string;
  playerId: string | number;
  playerName?: string | null;
  teamAbbr?: string | null;
  /** Inline `pregameFormScore` (0–100) from HRConversionResult.components. */
  inlineFormScore: number | null;
  /** Inline `pregamePriorMult` from HRConversionResult.components. */
  inlinePriorMult: number | null;
}

/**
 * SHADOW-ONLY: fetch the canonical standalone Power Prior, compare it to the live
 * inline prior, and emit a bounded `[POWER_PRIOR_SHADOW]` diagnostic line. Pure
 * side effect (logging). Returns nothing and swallows all errors so it can never
 * affect the live HR computation.
 */
export function runPowerPriorShadow(input: PowerPriorShadowInput): void {
  try {
    const nowMs = Date.now();
    const playerId = String(input.playerId ?? "");
    const gameId = String(input.gameId ?? "");
    if (!gameId || !playerId) return;

    const key = `${gameId}:${playerId}`;
    if (!shouldLog(key, nowMs)) return;

    // Warm the in-memory pregame snapshot via the service accessor so a cold or
    // stale store (e.g. after a server restart, or when a rebuild failed but a
    // persisted build exists) kicks the same non-blocking background rebuild +
    // DB-fallback path the public Pre-Game radar / live ladder bridge use. The
    // service is loaded via a fire-and-forget dynamic import (matching routes.ts)
    // so the always-loaded live HR module graph stays decoupled from the pregame
    // build + storage layer. Never awaited, never blocks the live HR path; the
    // store converges over subsequent ticks so `getPowerPrior` stops reporting a
    // false `standaloneExists=false` once memory warms.
    void import("../pregamePowerRadar/pregamePowerRadarService")
      .then((m) => m.peekRadarSnapshot())
      .catch(() => {
        /* never throw into the live HR path */
      });

    // Use the cached canonical ET date (no fallback logging); default to todayET()
    // silently when the game's official date hasn't been cached yet.
    const gameDateET = getCachedMlbGameSessionDate(gameId) ?? todayET();

    const prior = getPowerPrior({
      gameDateET,
      gameId,
      playerId,
      playerName: input.playerName ?? null,
      teamAbbr: input.teamAbbr ?? null,
    });

    const comparison = comparePowerPriors(prior, {
      formScore: input.inlineFormScore,
      priorMult: input.inlinePriorMult,
    });

    // Bounded, no sensitive data — ids, scores, tiers, and severity only.
    console.log(
      `[POWER_PRIOR_SHADOW] gameId=${gameId} playerId=${playerId}` +
        ` player=${input.playerName ?? "n/a"}` +
        ` standaloneExists=${prior.diagnostics.hasStandalonePregameSignal}` +
        ` source=${prior.source}` +
        ` standaloneScore10=${comparison.standaloneScore10 ?? "n/a"}` +
        ` inlineScore10=${comparison.inlineScore10 ?? "n/a"}` +
        ` delta=${comparison.absoluteDelta ?? "n/a"}` +
        ` standaloneTier=${comparison.standaloneTier ?? "n/a"}` +
        ` inlineTierApprox=${comparison.inlineTierApprox ?? "n/a"}` +
        ` severity=${comparison.severity}` +
        ` notes=${comparison.notes.join("|")}`,
    );
  } catch {
    // Shadow diagnostics must never destabilize the live HR path.
  }
}

/** Test-only reset of the rate-limit dedupe map. */
export function _resetPowerPriorShadowForTests(): void {
  lastLoggedAtMs.clear();
}
