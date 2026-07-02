// Pre-Game Power Radar — graded-state carry-forward (pure, no I/O).
//
// A snapshot rebuild always constructs signals with outcomes=null /
// becameLive*=false, but the shadow grader and live bridge may already have
// stamped the previous in-memory copy — losing that state on rebuild blanked
// the board's cashed/"HOMERED" treatment and the day's win log until the next
// grading pass (or forever, once the box score cache expired).

import type { PregameGameStatus, PregamePowerSignal } from "./types";

/**
 * Carry grading + live-bridge truth forward from the previous same-slate copy
 * of a signal into a freshly rebuilt one. Refuses cross-slate carries so a
 * previous day's win can never mint a win on a new slate. Mutates and returns
 * `fresh`.
 */
export function carryForwardGradedState(
  fresh: PregamePowerSignal,
  prev: PregamePowerSignal | undefined,
): PregamePowerSignal {
  if (!prev || prev.sessionDate !== fresh.sessionDate) return fresh;
  if (prev.outcomes && !fresh.outcomes) {
    fresh.outcomes = prev.outcomes;
    if (prev.status === "graded") fresh.status = "graded";
  }
  fresh.becameLiveReady = fresh.becameLiveReady || prev.becameLiveReady;
  fresh.becameLiveFire = fresh.becameLiveFire || prev.becameLiveFire;
  fresh.convertedLiveAt = fresh.convertedLiveAt ?? prev.convertedLiveAt;
  // First lock time sticks across rebuilds of a live/final game.
  if (prev.lockedAt) fresh.lockedAt = prev.lockedAt;
  return fresh;
}

/**
 * A rebuild only recreates signals for batters still in the freshly-fetched
 * live batting order (rosterService's lineup reflects real-time
 * substitutions, not the fixed starting 9). A batter who is subbed out after
 * being flagged — pinch hit/run, defensive sub, injury — would otherwise
 * vanish from the Map entirely, since carryForwardGradedState above only
 * runs on freshly-rebuilt signals. This finds that game's previous-build
 * signals whose batter is no longer in the current lineup and refreshes only
 * the game-status-derived fields so grading can still resolve them and the
 * badge reflects reality — everything else (score, tier, drivers, and any
 * already-stamped outcome) is preserved untouched.
 */
export function carryForwardDroppedFromLineup(
  gameId: string,
  currentLineupBatterIds: Set<string>,
  prevSignalsForGame: PregamePowerSignal[],
  gameStatus: PregameGameStatus,
  firstPitchLockEligible: boolean,
  nowIso: string,
): PregamePowerSignal[] {
  const isLocked = !firstPitchLockEligible && (gameStatus === "live" || gameStatus === "final");
  return prevSignalsForGame
    .filter((prev) => prev.gameId === gameId && !currentLineupBatterIds.has(prev.batterId))
    .map((prev) => ({
      ...prev,
      gameStatus,
      firstPitchLockEligible,
      status: prev.status === "graded" ? "graded" : isLocked ? "locked" : prev.status,
      lockedAt: prev.lockedAt ?? (isLocked ? nowIso : null),
    }));
}
