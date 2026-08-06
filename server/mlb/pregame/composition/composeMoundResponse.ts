// Pregame composition layer — route-level orchestration.
//
//   buildMoundResponse()  →  canonical MoundRadarResponse  →  neutral
//   composition layer (enrichMoundResponseWithPlateTargets)  →
//   MoundResponseWithPlateTargets
//
// buildMoundResponse (server/mlb/pregame/mound/diagnostics.ts) is called
// here with its ORIGINAL, unmodified signature and is not aware this layer
// exists — its canonical output is never mutated, only wrapped. A Plate
// composition failure can never fail or delay the Mound response: the
// try/catch below covers only the composition step, not buildMoundResponse
// itself, and always degrades to the canonical response with empty
// suggestions rather than a 500.

import { buildMoundResponse, type MoundCoverageCounters } from "../mound/diagnostics";
import { hasHighContactRisk } from "../mound/contactRisk";
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

const NO_PLATE_CONTEXT: PlateCompositionContext = { signals: [], state: "missing", generatedAt: null };

/**
 * Builds the canonical Mound response exactly as buildMoundResponse always
 * has, then composes cross-radar Plate suggestions on top — failing closed
 * to empty suggestions (never a thrown/500 Mound route) on any composition
 * error. Emits exactly one bounded [MOUND_PLATE_COMPOSITION] diagnostic log
 * per call — never one per signal/batter.
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
): Promise<MoundResponseWithPlateTargets> {
  // Canonical Mound response — unmodified, no composition awareness.
  const moundResponse = buildMoundResponse(
    sessionDate, buildId, generatedAt, source, signals, counters,
    includeSuppressed, includeResearchInstrumentation,
  );

  try {
    const plateContext = isMoundPlateTargetSuggestionsEnabled()
      ? await loadPlateCompositionContext(sessionDate)
      : NO_PLATE_CONTEXT;

    const enriched = enrichMoundResponseWithPlateTargets(moundResponse, plateContext.signals);
    logComposition(route, plateContext, enriched);
    return enriched;
  } catch (error) {
    console.warn("[MOUND_PLATE_COMPOSITION_FAILED]", error);
    const fallback = enrichMoundResponseWithPlateTargets(moundResponse, []);
    logComposition(route, { signals: [], state: "load_error", generatedAt: null }, fallback);
    return fallback;
  }
}

function logComposition(
  route: string,
  plateContext: PlateCompositionContext,
  resp: MoundResponseWithPlateTargets,
): void {
  const eligibleMoundCount = resp.signals.filter(hasHighContactRisk).length;
  const matchedMoundCount = resp.signals.filter((s) => s.plateTargetSuggestions.length > 0).length;
  const suggestionCount = resp.signals.reduce((sum, s) => sum + s.plateTargetSuggestions.length, 0);
  console.log("[MOUND_PLATE_COMPOSITION]", JSON.stringify({
    route,
    plateSnapshotState: plateContext.state,
    plateSignalCount: plateContext.signals.length,
    eligibleMoundCount,
    matchedMoundCount,
    suggestionCount,
  }));
}
