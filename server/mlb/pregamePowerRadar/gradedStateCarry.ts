// Pre-Game Power Radar — graded-state carry-forward (pure, no I/O).
//
// A snapshot rebuild always constructs signals with outcomes=null /
// becameLive*=false, but the shadow grader and live bridge may already have
// stamped the previous in-memory copy — losing that state on rebuild blanked
// the board's cashed/"HOMERED" treatment and the day's win log until the next
// grading pass (or forever, once the box score cache expired).

import type { PregamePowerSignal } from "./types";

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
