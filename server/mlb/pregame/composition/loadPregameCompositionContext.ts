// Pregame composition layer — centralized Plate ("the Plate" / Pregame Power
// Radar) snapshot loading for cross-radar Mound response composition.
//
// Reuses the Plate engine's OWN existing snapshot service (peekRadarSnapshot,
// server/mlb/pregamePowerRadar/pregamePowerRadarService.ts) rather than
// reinventing freshness/TTL logic here. peekRadarSnapshot is the hot-path,
// non-blocking accessor already used elsewhere for exactly this shape of
// problem: it returns the current same-date in-memory snapshot immediately
// (never awaiting a rebuild) and kicks a guarded background refresh when
// stale, so a Mound request can never be blocked or slowed by a Plate
// rebuild/DB fallback. This module does not independently classify
// "stale" — that would require duplicating peekRadarSnapshot's private TTL
// constants, which this module deliberately does not do; a same-date
// snapshot it returns is reported "available" regardless of its own
// internal staleness, exactly mirroring what every other Plate-snapshot
// reader in this codebase already treats as current.
//
// Logging is centralized at the orchestration layer (composeMoundResponse.ts)
// — this module never logs itself, so a load failure produces exactly one
// [MOUND_PLATE_COMPOSITION] record there, not a second one here.

import { peekRadarSnapshot } from "../../pregamePowerRadar/pregamePowerRadarService";
import type { PregamePowerSnapshot } from "../../pregamePowerRadar/pregamePowerRadarStore";
import type { PregamePowerSignal } from "../../pregamePowerRadar/types";

export type PlateCompositionState =
  | "available"
  | "missing"
  | "date_mismatch"
  | "load_error"
  | "disabled";

export interface PlateCompositionContext {
  signals: PregamePowerSignal[];
  state: PlateCompositionState;
  generatedAt: string | null;
  buildId: string | null;
}

const EMPTY_CONTEXT = (state: Exclude<PlateCompositionState, "available">, generatedAt: string | null = null): PlateCompositionContext => ({
  signals: [],
  state,
  generatedAt,
  buildId: null,
});

/**
 * Load the Plate snapshot for the given (Mound) slate date, never throwing
 * and never blocking on a Plate rebuild. Returns `signals: []` whenever the
 * snapshot is absent, for a different slate day, or the read itself fails —
 * the Mound route this feeds must always get a usable context back.
 *
 * `snapshotAccessor` defaults to the real peekRadarSnapshot; tests inject a
 * throwing stub to exercise the load_error path deterministically without a
 * mocking framework (mirrors this codebase's existing injected-stub test
 * convention, e.g. moundV2ShadowRunner.test.ts).
 */
export async function loadPlateCompositionContext(
  expectedSlateDate: string,
  snapshotAccessor: () => PregamePowerSnapshot | null = peekRadarSnapshot,
): Promise<PlateCompositionContext> {
  try {
    const snapshot = snapshotAccessor();
    if (!snapshot) {
      return EMPTY_CONTEXT("missing");
    }
    if (snapshot.sessionDate !== expectedSlateDate) {
      return EMPTY_CONTEXT("date_mismatch", snapshot.generatedAt);
    }
    return {
      signals: Array.from(snapshot.signals.values()),
      state: "available",
      generatedAt: snapshot.generatedAt,
      buildId: snapshot.buildId,
    };
  } catch {
    return EMPTY_CONTEXT("load_error");
  }
}

/**
 * Server-side rollout flag. Controls response enrichment ONLY — never
 * branches Mound or Plate engine scoring. Deploy disabled, verify
 * composition diagnostics in production, then enable without a code change.
 */
export function isMoundPlateTargetSuggestionsEnabled(): boolean {
  return process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED === "true";
}
