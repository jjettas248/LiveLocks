// Pre-Game Power Radar → live HR ladder bridge (read-only).
//
// Builds a lookup of today's NON-suppressed (public) pre-game targets keyed by
// `${gameId}:${batterId}` so the live HR Radar ladder route can stamp an
// additive "Pre-Game target" annotation on matching rows. Pure read of the
// in-memory snapshot — never mutates the live engine, bus, lifecycle, or any
// live canonical field. Live ladder rows carry ESPN gameId + MLB player id,
// which match the pregame signal's gameId + batterId, so the join is valid.

import { allSignals } from "./pregamePowerRadarStore";
import type { PregamePowerSignal } from "./types";

export interface PregamePowerTargetRef {
  tier: string;
  score10: number;
  primaryMarket: string;
}

/** Join key shared by live ladder rows and pregame signals. */
export function bridgeKey(gameId: string, batterId: string): string {
  return `${gameId}:${batterId}`;
}

/**
 * Map of public (non-suppressed) pre-game targets keyed by `${gameId}:${batterId}`.
 * Pure; reads only the in-memory snapshot. When two targets share a key (should
 * not happen — ids are unique per game), the higher score wins.
 */
export function buildPregamePowerTargetMap(
  signals: PregamePowerSignal[],
): Map<string, PregamePowerTargetRef> {
  const map = new Map<string, PregamePowerTargetRef>();
  for (const s of signals) {
    if (s.suppressed) continue;
    const key = bridgeKey(s.gameId, s.batterId);
    const existing = map.get(key);
    if (existing && existing.score10 >= s.score10) continue;
    map.set(key, { tier: s.tier, score10: s.score10, primaryMarket: s.primaryMarket });
  }
  return map;
}

/** Convenience used by the route: read the live snapshot and build the map. */
export function getPregamePowerTargetMap(): Map<string, PregamePowerTargetRef> {
  try {
    return buildPregamePowerTargetMap(allSignals());
  } catch {
    return new Map();
  }
}
