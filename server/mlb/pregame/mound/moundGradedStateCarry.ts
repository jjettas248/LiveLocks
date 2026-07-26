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

  // Once a signal has been legitimately shown to users under a specific
  // primary market (Ks vs. Outs), a later rebuild must not silently swap
  // which market it settles/displays against. computeMarketTags recomputes
  // primaryMarket every cycle from live pitcherSkill/opponentKProfile/workload
  // scores — exactly like moundDirection — and moundOutcomeAttribution.ts's
  // deriveMoundOutcome/deriveMoundMarketOutcome/buildMoundSettlementView all
  // branch on signal.primaryMarket to pick the frozen line and the
  // final-stat field. An un-pinned flip after first pitch (degraded
  // workload/opponent-K data shifting which side of the kScore-vs-outsScore
  // comparison wins) silently regrades a pitcher the UI showed as a real
  // Pitcher Ks recommendation (real sportsbook line) against the Outs market
  // instead — which has no sportsbook line source at all today — losing a
  // real Cashed/Missed/Push result to the model-review baseline fallback.
  // Pin it, mirroring moundDirection's pin immediately below; keep
  // marketSetups' isPrimary flags consistent with the pinned value so the
  // "Best Angle" display and settlement routing never disagree.
  if (prev.everPubliclyFlagged === true || prev.everPubliclyFlaggedFade === true) {
    fresh.primaryMarket = prev.primaryMarket;
    fresh.marketSetups = fresh.marketSetups.map((setup) => ({
      ...setup,
      isPrimary: setup.market === fresh.primaryMarket,
    }));
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
