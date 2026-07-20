// Mound Radar — graded-state carry-forward (pure, no I/O).
// Mirrors pregamePowerRadar/gradedStateCarry.ts's role for pitcher signals.

import type { MoundGameStatus, MoundSignal } from "./types";
import { wasPubliclyFlaggedMound, wasPubliclyFlaggedMoundFade } from "./diagnostics";

export function carryForwardMoundGradedState(
  fresh: MoundSignal,
  prev: MoundSignal | undefined,
): MoundSignal {
  if (!prev || prev.sessionDate !== fresh.sessionDate) {
    // Follow flag: a false→true mint is allowed ONLY from a legitimate
    // pre-first-pitch state (firstPitchLockEligible === true). Without this
    // guard a brand-new build whose game is already live/final (cold restart /
    // delayed build / previously-unresolved gamePk) could mint a public Follow
    // flag using hindsight and surface a signal never shown before first pitch.
    // (wasPubliclyFlaggedMoundFade already requires firstPitchLockEligible, so
    // the Fade flag needs no extra guard here.)
    fresh.everPubliclyFlagged = fresh.firstPitchLockEligible === true && wasPubliclyFlaggedMound(fresh);
    fresh.everPubliclyFlaggedFade = wasPubliclyFlaggedMoundFade(fresh);
    return fresh;
  }

  // Once a signal has been legitimately shown to users with a direction
  // (Fade or Follow), a later pregame rebuild (updated lineup/stats data)
  // must not silently flip which settlement rule it grades against — the
  // grader branches on signal.moundDirection, so an un-pinned flip could
  // settle a pitcher the UI showed as "Fade (Under)" with Follow/Over logic
  // instead. Pin it, mirroring lockedAt's "once set, never overwritten"
  // discipline below. Must run BEFORE the wasPubliclyFlagged* recomputation
  // so those checks see the (possibly pinned) direction, not the fresh one.
  if (prev.moundDirection === "fade" && prev.everPubliclyFlaggedFade === true) {
    fresh.moundDirection = "fade";
  } else if (prev.moundDirection === "follow" && prev.everPubliclyFlagged === true) {
    fresh.moundDirection = "follow";
  }

  fresh.everPubliclyFlagged =
    (fresh.firstPitchLockEligible === true && wasPubliclyFlaggedMound(fresh)) || prev.everPubliclyFlagged === true;
  fresh.everPubliclyFlaggedFade = wasPubliclyFlaggedMoundFade(fresh) || prev.everPubliclyFlaggedFade === true;
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

/**
 * A rebuild only recreates signals for starters still resolvable this cycle
 * (getStartingPitcher reflects real-time rotation/roster state, not a fixed
 * probable-starters list fetched once). A starter dropped from resolution —
 * whether because the whole game's gamePk failed to resolve this cycle, or
 * because just that side's starter lookup came back empty — would otherwise
 * vanish from the rebuilt Map entirely, since carryForwardMoundGradedState
 * above only runs on freshly-rebuilt signals. This finds that game's
 * previous-build signals whose pitcher is no longer resolved and refreshes
 * only the game-status-derived fields so grading can still resolve them —
 * everything else (score, tier, drivers, and any already-stamped outcome) is
 * preserved untouched. Mirrors pregamePowerRadar/gradedStateCarry.ts's
 * carryForwardDroppedFromLineup.
 *
 * Scoped to already-live/final games only: a pre-first-pitch resolution gap
 * (rotation still TBD) is a legitimate reason for a starter to be absent — he
 * hasn't started yet, so he must not be held on the public board as a
 * confirmed target. Only an in-game drop (the game is already live or final)
 * carries the signal forward.
 */
export function carryForwardDroppedFromMound(
  gameId: string,
  currentStarterIds: Set<string>,
  prevSignalsForGame: MoundSignal[],
  gameStatus: MoundGameStatus,
  firstPitchLockEligible: boolean,
  nowIso: string,
  buildId: string,
): MoundSignal[] {
  if (gameStatus !== "live" && gameStatus !== "final") return [];
  const isLocked = !firstPitchLockEligible;
  return prevSignalsForGame
    .filter((prev) => prev.gameId === gameId && !currentStarterIds.has(prev.pitcherId))
    .map((prev) => ({
      ...prev,
      gameStatus,
      firstPitchLockEligible,
      buildId,
      status: prev.status === "graded" ? "graded" : isLocked ? "locked" : prev.status,
      lockedAt: prev.lockedAt ?? (isLocked ? nowIso : null),
    }));
}
