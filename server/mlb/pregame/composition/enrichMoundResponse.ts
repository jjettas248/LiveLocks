// Pregame composition layer — response enrichment.
//
// Takes an ALREADY-BUILT, canonical MoundRadarResponse — buildMoundResponse's
// own unmodified output — and Plate signals, and returns a NEW response
// object with plateTargetSuggestions attached per Mound signal.
//
//   buildMoundResponse()  →  canonical MoundRadarResponse
//                          →  enrichMoundResponseWithPlateTargets (here)
//                          →  MoundResponseWithPlateTargets
//
// Never mutates moundResponse or any of its signal objects. Never
// recomputes score10/tier/moundDirection/settlementView/ordering/
// diagnostics — those are already final by the time this runs.
// mound/diagnostics.ts and mound/types.ts have no awareness of this file.

import { isPublicPregameSignal } from "../../pregamePowerRadar/diagnostics";
import type { PregamePowerSignal } from "../../pregamePowerRadar/types";
import type { MoundRadarResponse, MoundSignal } from "../mound/types";
import { buildMoundPlateTargetSuggestions, type MoundPlateTargetSuggestion } from "./moundPlateTargets";

export type MoundSignalWithPlateTargets = MoundSignal & {
  plateTargetSuggestions: MoundPlateTargetSuggestion[];
};

export interface MoundResponseWithPlateTargets extends Omit<MoundRadarResponse, "signals"> {
  signals: MoundSignalWithPlateTargets[];
}

/**
 * isPublicPregameSignal is Plate's canonical VISIBILITY-AND-RETENTION
 * predicate, not a pregame-only predicate — it intentionally stays true for
 * a signal that was publicly flagged pre-first-pitch and is now locked or
 * graded during a live/final/suspended game (that's correct for Plate's own
 * product, which keeps showing completed cards). This temporary cross-radar
 * display is pregame-only, so it layers an explicit lifecycle check on top:
 * the game must not have started, and the signal must still be in its
 * initial active/unlocked state. A signal that's genuinely public but
 * already locked/live/final/suspended/postponed is excluded here even
 * though isPublicPregameSignal itself would still say "public."
 */
export function isPlateCompositionEligible(signal: Readonly<PregamePowerSignal>): boolean {
  return (
    isPublicPregameSignal(signal) &&
    signal.status === "active" &&
    signal.firstPitchLockEligible === true &&
    signal.gameStatus !== "live" &&
    signal.gameStatus !== "final" &&
    signal.gameStatus !== "suspended" &&
    signal.gameStatus !== "postponed"
  );
}

/**
 * Pure. `plateSignals` may be any Plate signals (including suppressed/
 * unpublished/live/final ones) — this function is the one place that
 * applies both Plate's canonical publication gate AND the pregame-only
 * lifecycle check before anything is joined against a Mound card, so
 * eligibility is never approximated with an ad hoc suppressed/tier check
 * and never silently widened to include live/completed games.
 */
export function enrichMoundResponseWithPlateTargets(
  moundResponse: Readonly<MoundRadarResponse>,
  plateSignals: readonly PregamePowerSignal[],
): MoundResponseWithPlateTargets {
  const eligiblePlateSignals = plateSignals.filter(isPlateCompositionEligible);

  return {
    ...moundResponse,
    signals: moundResponse.signals.map((signal) => ({
      ...signal,
      plateTargetSuggestions: buildMoundPlateTargetSuggestions(signal, eligiblePlateSignals),
    })),
  };
}
