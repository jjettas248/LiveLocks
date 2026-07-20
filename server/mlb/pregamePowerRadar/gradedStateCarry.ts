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
    // all there is. Suspended games are excluded from *minting a new* flag —
    // a target must never newly qualify as a fresh actionable recommendation
    // while its game is paused mid-suspension (there is no `prev` here to
    // preserve an already-true flag against, so this is strictly a new-signal
    // case).
    // A false→true mint is allowed ONLY from a legitimate pre-first-pitch state
    // (`firstPitchLockEligible === true`, i.e. gameStatus scheduled/pre). Without
    // this guard a brand-new build whose game is already live/final/suspended (a
    // cold restart / delayed build / previously-unresolved gamePk, with no `prev`
    // to inherit a true flag from) could mint a public flag using hindsight and
    // surface a signal never shown before first pitch — exactly what "never allow
    // an unseen signal to appear after first pitch" forbids. (firstPitchLockEligible
    // is false for suspended too, subsuming the old suspended-only exclusion.)
    fresh.everPubliclyFlagged = fresh.firstPitchLockEligible === true && wasPubliclyFlaggedPregame(fresh);
    return fresh;
  }

  // Suspended blocks only the false→true transition (no *new* public flag
  // while paused); an already-true `prev.everPubliclyFlagged` still OR-forwards
  // unconditionally, so an already-surfaced target remains preserved and
  // visible exactly as it was before its game paused.
  fresh.everPubliclyFlagged =
    (fresh.firstPitchLockEligible === true && wasPubliclyFlaggedPregame(fresh)) || prev.everPubliclyFlagged === true;
  if (prev.outcomes && !fresh.outcomes) {
    fresh.outcomes = prev.outcomes;
    if (prev.status === "graded") fresh.status = "graded";
  }
  fresh.becameLiveReady = fresh.becameLiveReady || prev.becameLiveReady;
  fresh.becameLiveFire = fresh.becameLiveFire || prev.becameLiveFire;
  fresh.convertedLiveAt = fresh.convertedLiveAt ?? prev.convertedLiveAt;
  // First lock time sticks across rebuilds of a live/final game.
  if (prev.lockedAt) fresh.lockedAt = prev.lockedAt;
  // Display-only power-profile snapshot: once the signal is no longer `active`
  // (locked, graded, or otherwise resolved — the canonical lifecycle boundary),
  // the completed card must show the ORIGINAL pregame snapshot — INCLUDING ITS
  // ABSENCE on a legacy row that predates the field — never a post-lock recompute.
  // So fresh inherits prev's value verbatim, even when that value is `undefined`
  // (a legacy public locked row then keeps rendering "Power profile unavailable"
  // rather than silently adopting freshly-computed post-lock values). While still
  // `active` — including a delayed/unknown pregame row whose firstPitchLockEligible
  // is false but which has NOT locked — a rebuild may still acquire/refresh the
  // additive snapshot safely, since that's legitimate pregame data. (`status` is
  // the right gate here, NOT firstPitchLockEligible: the latter is false for
  // delayed/unknown active games too, which would wrongly freeze pregame data.)
  // Storage persists diagnostics as a WHOLESALE JSONB overwrite, so freezing the
  // nested value here — before serialization — is what makes it durable across
  // restart/hydration.
  const evaluationLocked = fresh.status !== "active";
  if (evaluationLocked && fresh.diagnostics) {
    fresh.diagnostics.powerProfile = prev.diagnostics?.powerProfile;
  }
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
  // Suspended is grouped with live/final here — a suspended game has already
  // started, so a batter dropped from the lineup mid-suspension must still be
  // preserved exactly like an in-game substitution, not treated as a
  // pre-first-pitch scratch.
  if (gameStatus !== "live" && gameStatus !== "final" && gameStatus !== "suspended") return [];
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
