// Mound Radar — graded-state carry-forward (pure, no I/O).
// Mirrors pregamePowerRadar/gradedStateCarry.ts's role for pitcher signals.

import type { MoundSignal } from "./types";
import { wasPubliclyFlaggedMound } from "./diagnostics";

export function carryForwardMoundGradedState(
  fresh: MoundSignal,
  prev: MoundSignal | undefined,
): MoundSignal {
  if (!prev || prev.sessionDate !== fresh.sessionDate) {
    fresh.everPubliclyFlagged = wasPubliclyFlaggedMound(fresh);
    return fresh;
  }

  fresh.everPubliclyFlagged = wasPubliclyFlaggedMound(fresh) || prev.everPubliclyFlagged === true;
  if (prev.outcomes && !fresh.outcomes) {
    fresh.outcomes = prev.outcomes;
    if (prev.status === "graded") fresh.status = "graded";
  }
  fresh.becameLiveReady = fresh.becameLiveReady || prev.becameLiveReady;
  fresh.becameLiveFire = fresh.becameLiveFire || prev.becameLiveFire;
  fresh.convertedLiveAt = fresh.convertedLiveAt ?? prev.convertedLiveAt;
  if (prev.lockedAt) fresh.lockedAt = prev.lockedAt;
  return fresh;
}
