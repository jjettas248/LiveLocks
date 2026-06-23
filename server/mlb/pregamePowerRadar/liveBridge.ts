// Pre-Game Power Radar → live HR ladder bridge (singleton-bound wrapper).
//
// Reads the SERVICE-RESOLVED snapshot (TTL rebuild + DB fallback) so the live
// HR Radar ladder route can stamp an additive "Pre-Game target" annotation on
// matching rows. Pure read — never mutates the live engine, bus, lifecycle, or
// any live canonical field. Live ladder rows carry ESPN gameId + MLB player id,
// which match the pregame signal's gameId + batterId, so the join is valid.
//
// The pure, unit-tested logic lives in ./liveBridgeCore (kept free of the heavy
// service/store/build chain); this file adds the singleton-bound accessor.

import { peekRadarSnapshot } from "./pregamePowerRadarService";
import { buildPregamePowerTargetMap, type PregamePowerTargetRef } from "./liveBridgeCore";

export { bridgeKey, buildPregamePowerTargetMap, type PregamePowerTargetRef } from "./liveBridgeCore";

/**
 * Build the target map from the SERVICE-RESOLVED snapshot (TTL rebuild + DB
 * fallback), not the raw store, so ladder badges stay consistent with the
 * public Pre-Game endpoints. Uses the non-blocking `peekRadarSnapshot()` so the
 * hot ladder path never awaits a rebuild — it returns the current snapshot and
 * converges in the background.
 */
export function getPregamePowerTargetMap(): Map<string, PregamePowerTargetRef> {
  try {
    const snap = peekRadarSnapshot();
    const signals = snap ? Array.from(snap.signals.values()) : [];
    return buildPregamePowerTargetMap(signals);
  } catch {
    return new Map();
  }
}
