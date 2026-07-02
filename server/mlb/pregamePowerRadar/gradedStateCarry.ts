// Pre-Game Power Radar — graded-state carry-forward (pure, no I/O).
//
// A snapshot rebuild always constructs signals with outcomes=null /
// becameLive*=false, but the shadow grader and live bridge may already have
// stamped the previous in-memory copy — losing that state on rebuild blanked
// the board's cashed/"HOMERED" treatment and the day's win log until the next
// grading pass (or forever, once the box score cache expired).

import type { PregameGameStatus, PregamePowerSignal } from "./types";
import { wasPubliclyFlaggedPregame } from "./diagnostics";

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
  if (!prev || prev.sessionDate !== fresh.sessionDate) {
    // Freeze "was this ever a legitimate publicly-flagged pregame target" —
    // OR'd forward (below) so a later dip in the mutable eligibility fields
    // (tier, score, dataCoverageScore, etc., all re-fetched from live data on
    // every rebuild) can never erase an earlier true evaluation. No same-slate
    // prior copy to OR against here, so this rebuild's own live evaluation is
    // all there is.
    fresh.everPubliclyFlagged = wasPubliclyFlaggedPregame(fresh);
    return fresh;
  }

  fresh.everPubliclyFlagged = wasPubliclyFlaggedPregame(fresh) || prev.everPubliclyFlagged === true;
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
 *
 * Scoped to already-live/final games only: a pre-first-pitch lineup change
 * (a late scratch) is a legitimate reason for a batter to disappear — he
 * never played, so he must not be held on the public board as a confirmed
 * target, and would likely never get a box-score line to grade. Only an
 * in-game substitution (the game is already live or final) should carry the
 * dropped batter's signal forward.
 */
export function carryForwardDroppedFromLineup(
  gameId: string,
  currentLineupBatterIds: Set<string>,
  prevSignalsForGame: PregamePowerSignal[],
  gameStatus: PregameGameStatus,
  firstPitchLockEligible: boolean,
  nowIso: string,
  buildId: string,
): PregamePowerSignal[] {
  if (gameStatus !== "live" && gameStatus !== "final") return [];
  const isLocked = !firstPitchLockEligible;
  return prevSignalsForGame
    .filter((prev) => prev.gameId === gameId && !currentLineupBatterIds.has(prev.batterId))
    .map((prev) => ({
      ...prev,
      gameStatus,
      firstPitchLockEligible,
      buildId,
      status: prev.status === "graded" ? "graded" : isLocked ? "locked" : prev.status,
      lockedAt: prev.lockedAt ?? (isLocked ? nowIso : null),
    }));
}
