// Pre-Game Power Radar → live HR ladder bridge — PURE core.
//
// Kept free of the service/store/build chain (no heavy imports) so it stays
// unit-testable in isolation. The singleton-bound wrapper lives in liveBridge.ts.

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
 * Pure. When two targets share a key (should not happen — ids are unique per
 * game), the higher score wins.
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
