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
 * Pure. `plateSignals` may be any Plate signals (including suppressed/
 * unpublished ones) — this function is the one place that applies Plate's
 * own canonical publication gate (isPublicPregameSignal) before anything is
 * joined against a Mound card, so eligibility is never approximated with an
 * ad hoc suppressed/tier check.
 */
export function enrichMoundResponseWithPlateTargets(
  moundResponse: Readonly<MoundRadarResponse>,
  plateSignals: readonly PregamePowerSignal[],
): MoundResponseWithPlateTargets {
  const eligiblePlateSignals = plateSignals.filter(isPublicPregameSignal);

  return {
    ...moundResponse,
    signals: moundResponse.signals.map((signal) => ({
      ...signal,
      plateTargetSuggestions: buildMoundPlateTargetSuggestions(signal, eligiblePlateSignals),
    })),
  };
}
