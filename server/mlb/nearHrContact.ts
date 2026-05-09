// [MLB Phase 2.5] Engine-owned near-HR contact detector.
//
// Surfaces high-quality contact events as HR Watch signals regardless of
// outcome (flyout, lineout, double, etc.). Pure function — no probability
// math, no I/O, no side effects. Caller decides what to do with the result.
//
// This is the SOLE source of truth for the spec's HR Watch thresholds.
// Do not duplicate these thresholds in liveEventInterpretation.ts (which
// uses looser EV>92 / dist>300 thresholds for its `nearHrScore` boost into
// the generic confidence stack — different purpose, kept intentionally).

export type NearHrTier = "watch" | "lean";

export interface NearHrContactEvent {
  ev: number | null | undefined;
  la: number | null | undefined;
  distance: number | null | undefined;
  xba?: number | null | undefined;
}

export interface NearHrContactResult {
  tier: NearHrTier | null;
  drivers: string[];
  suppressionReason?: string;
}

const DRIVERS_BASE = [
  "Near-HR contact",
  "Elite exit velocity",
  "Optimal launch angle",
  "Deep fly-ball distance",
];

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Detect whether a single contact event qualifies as HR Watch.
 *
 * WATCH thresholds (from spec):
 *   EV >= 98 AND LA in [20,35] AND distance >= 350
 *
 * LEAN thresholds (from spec):
 *   EV >= 102 AND LA in [20,32] AND distance >= 375
 *   (xBA >= .500 is the spec's stronger filter but per-AB xBA is not yet
 *   plumbed into priorABResults — it lives only in seasonal aggregates and
 *   per-pitch Savant feeds today. When provided, it's enforced; when null,
 *   the EV+LA+distance gate alone suffices for LEAN.)
 *
 * Result outcome (hit/out/flyout) is intentionally NOT consulted. A 102.9
 * EV / 24 LA / 392 ft flyout (Vientos case) qualifies as LEAN.
 */
export function detectNearHrContact(event: NearHrContactEvent): NearHrContactResult {
  const ev = isFiniteNum(event.ev) ? event.ev : null;
  const la = isFiniteNum(event.la) ? event.la : null;
  const distance = isFiniteNum(event.distance) ? event.distance : null;
  const xba = isFiniteNum(event.xba) ? event.xba : null;

  if (ev === null || la === null || distance === null) {
    return { tier: null, drivers: [], suppressionReason: "missing_statcast" };
  }

  const meetsLean =
    ev >= 102 &&
    la >= 20 && la <= 32 &&
    distance >= 375 &&
    (xba === null || xba >= 0.5);

  if (meetsLean) {
    return { tier: "lean", drivers: [...DRIVERS_BASE] };
  }

  const meetsWatch =
    ev >= 98 &&
    la >= 20 && la <= 35 &&
    distance >= 350;

  if (meetsWatch) {
    return { tier: "watch", drivers: [...DRIVERS_BASE] };
  }

  const closeToWatch =
    ev >= 95 &&
    la >= 18 && la <= 38 &&
    distance >= 320;

  if (closeToWatch) {
    return {
      tier: null,
      drivers: [],
      suppressionReason: `below_watch_threshold ev=${ev} la=${la} dist=${distance}`,
    };
  }

  return { tier: null, drivers: [] };
}

/**
 * Scan the last N at-bats (most-recent first) and return the STRONGEST
 * near-HR tier seen. Fixes a real-world miss: AB#3 was a textbook lean
 * (104.4 EV / 24° / 382 ft / barrel) but AB#4 was a flat 99.6 mph 6°
 * liner — looking only at AB#4 returned tier=null and the engine
 * "forgot" the lean signal, so the player stayed at peak score 0
 * and the eventual HR was graded uncalled. Scanning a small window
 * preserves the peak detection across the next at-bat without
 * touching probability math.
 *
 * Returns the lean if any AB qualifies as lean; otherwise the watch
 * if any AB qualifies as watch; otherwise the suppression reason of
 * the most recent AB (so existing diagnostics still fire).
 */
export function detectNearHrContactPeak(
  events: NearHrContactEvent[],
  windowSize = 5,
): NearHrContactResult & { sourceAbIndex: number | null } {
  if (!events || events.length === 0) {
    return { tier: null, drivers: [], suppressionReason: "no_at_bat", sourceAbIndex: null };
  }

  // Walk the last `windowSize` ABs newest→oldest so sourceAbIndex
  // points to the MOST RECENT qualifying AB (more useful for audit
  // than the oldest match). Tier correctness is unaffected — lean
  // still wins over watch regardless of order.
  const start = Math.max(0, events.length - windowSize);
  let bestTier: NearHrTier | null = null;
  let bestDrivers: string[] = [];
  let bestIdx: number | null = null;
  for (let i = events.length - 1; i >= start; i--) {
    const r = detectNearHrContact(events[i]);
    if (r.tier === "lean") {
      // lean is the ceiling — return immediately, this is the most
      // recent lean in the window.
      return { tier: "lean", drivers: r.drivers, sourceAbIndex: i };
    }
    if (r.tier === "watch" && bestTier === null) {
      // first watch found walking newest→oldest = most recent watch.
      bestTier = "watch";
      bestDrivers = r.drivers;
      bestIdx = i;
    }
  }
  if (bestTier) {
    return { tier: bestTier, drivers: bestDrivers, sourceAbIndex: bestIdx };
  }
  // Fall back to the suppression reason of the most recent AB so the
  // existing [MLB_HR_WATCH_SUPPRESSED] diagnostics path keeps firing.
  const lastResult = detectNearHrContact(events[events.length - 1]);
  return { tier: null, drivers: [], suppressionReason: lastResult.suppressionReason, sourceAbIndex: null };
}
