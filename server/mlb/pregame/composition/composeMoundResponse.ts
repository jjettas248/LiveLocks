// Pregame composition layer — route-level orchestration.
//
//   buildMoundResponse()  →  canonical MoundRadarResponse  →  neutral
//   composition layer (enrichMoundResponseWithPlateTargets)  →
//   MoundResponseWithPlateTargets
//
// buildMoundResponse (server/mlb/pregame/mound/diagnostics.ts) is called
// here with its ORIGINAL, unmodified signature and is not aware this layer
// exists — its canonical output is never mutated, only wrapped. It is
// called exactly once, unconditionally, OUTSIDE the try/catch below: a
// genuine Mound-engine exception must propagate to the route's own error
// handler like it always has, never get caught and mislabeled as a Plate
// composition failure. A Plate composition failure, in turn, can never fail
// or delay the Mound response — the try/catch covers only the composition
// step and always degrades to the canonical response with empty
// suggestions rather than a 500.

import { buildMoundResponse, type MoundCoverageCounters } from "../mound/diagnostics";
import { isMoundCompositionEligible } from "./moundPlateTargets";
import type { MoundSignal, MoundRadarResponse } from "../mound/types";
import {
  enrichMoundResponseWithPlateTargets,
  type MoundResponseWithPlateTargets,
} from "./enrichMoundResponse";
import {
  loadPlateCompositionContext,
  isMoundPlateTargetSuggestionsEnabled,
  type PlateCompositionContext,
} from "./loadPregameCompositionContext";

const DISABLED_CONTEXT: PlateCompositionContext = { signals: [], state: "disabled", generatedAt: null, buildId: null };
const UNEXPECTED_FAILURE_CONTEXT: PlateCompositionContext = { signals: [], state: "load_error", generatedAt: null, buildId: null };

/**
 * Builds the canonical Mound response exactly as buildMoundResponse always
 * has, then composes cross-radar Plate suggestions on top — failing closed
 * to empty suggestions (never a thrown/500 Mound route) on any composition
 * error. Emits exactly one bounded [MOUND_PLATE_COMPOSITION] diagnostic log
 * per call — never one per signal/batter, and never a second, separate log
 * for the same failure (loadPregameCompositionContext.ts never logs itself).
 */
export async function composeMoundResponseWithPlateTargets(
  route: string,
  sessionDate: string,
  buildId: string,
  generatedAt: string,
  source: MoundRadarResponse["source"],
  signals: MoundSignal[],
  counters: MoundCoverageCounters,
  includeSuppressed: boolean,
  includeResearchInstrumentation: boolean,
  // Injectable for tests only — defaults to the real loader. Lets a test
  // deterministically exercise the fail-closed catch path (a throwing
  // stub) without needing to mock the Plate module or its DB fallback.
  plateContextLoader: typeof loadPlateCompositionContext = loadPlateCompositionContext,
): Promise<MoundResponseWithPlateTargets> {
  // Canonical Mound response — unmodified, no composition awareness. Called
  // exactly once, unconditionally, before the try/catch: any exception here
  // is a genuine Mound-engine failure and must propagate to the caller.
  const moundResponse = buildMoundResponse(
    sessionDate, buildId, generatedAt, source, signals, counters,
    includeSuppressed, includeResearchInstrumentation,
  );

  const enabled = isMoundPlateTargetSuggestionsEnabled();

  try {
    const plateContext = enabled
      ? await plateContextLoader(sessionDate)
      : DISABLED_CONTEXT;

    const enriched = enrichMoundResponseWithPlateTargets(moundResponse, plateContext.signals);
    logComposition(route, enabled, plateContext, enriched);
    return enriched;
  } catch (error) {
    console.warn("[MOUND_PLATE_COMPOSITION_FAILED]", error);
    const fallback = enrichMoundResponseWithPlateTargets(moundResponse, []);
    logComposition(route, enabled, UNEXPECTED_FAILURE_CONTEXT, fallback);
    return fallback;
  }
}

function logComposition(
  route: string,
  enabled: boolean,
  plateContext: PlateCompositionContext,
  resp: MoundResponseWithPlateTargets,
): void {
  const eligibleMoundCount = resp.signals.filter(isMoundCompositionEligible).length;
  const matchedMoundCount = resp.signals.filter((s) => s.plateTargetSuggestions.length > 0).length;
  const suggestionCount = resp.signals.reduce((sum, s) => sum + s.plateTargetSuggestions.length, 0);
  console.log("[MOUND_PLATE_COMPOSITION]", JSON.stringify({
    route,
    enabled,
    plateSnapshotState: plateContext.state,
    plateBuildId: plateContext.buildId,
    plateSignalCount: plateContext.signals.length,
    eligibleMoundCount,
    matchedMoundCount,
    suggestionCount,
  }));
}
