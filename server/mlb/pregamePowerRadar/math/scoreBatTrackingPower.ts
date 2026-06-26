// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: bat-tracking → log-odds term + 0–100 score
//
// Pure. Season swing-quality aggregates (bat speed, fast-swing rate, squared-up,
// blasts) as a secondary, capped power signal. Fully no-op when bat-tracking is
// unavailable. Reference midpoints are documented DEFAULT PRIORS.
// ─────────────────────────────────────────────────────────────────────────────

import type { BatTrackingInputs, LogOddsTerm } from "./mathTypes";
import { signed, weightedMean, norm01 } from "./normalizeStats";
import { shrinkWeight } from "./shrinkRates";

export const BAT_TRACKING_CAP = 0.30;

export interface BatTrackingResult extends LogOddsTerm {
  /** 0–100 standalone bat-tracking power score (null when unavailable). */
  score100: number | null;
}

export function scoreBatTrackingPower(inp: BatTrackingInputs | null | undefined): BatTrackingResult {
  if (!inp) {
    return { key: "batTracking", logOdds: 0, available: false, shrinkWeight: 0, score100: null };
  }

  // Signed [-1,1] features around league-average swing references.
  const signedParts: Array<{ value: number | null; weight: number }> = [
    { value: feat(inp.avgBatSpeed, 67, 71.5, 78), weight: 3 }, // mph
    { value: feat(inp.fastSwingRatePct, 5, 23, 55), weight: 2 },
    { value: feat(inp.squaredUpPerSwingPct, 18, 25, 34), weight: 2 },
    { value: feat(inp.blastPerSwingPct, 4, 11, 22), weight: 2 },
    { value: feat(inp.avgSwingLength, 6.2, 7.0, 8.2), weight: 1 },
  ];
  const { value: composite, coverage } = weightedMean(signedParts);
  if (composite == null || coverage === 0) {
    return { key: "batTracking", logOdds: 0, available: false, shrinkWeight: 0, score100: null };
  }

  const w = inp.swingSample != null ? shrinkWeight(inp.swingSample, 40) : 0.6;
  const logOdds = BAT_TRACKING_CAP * composite * w;

  // 0–100 score: remap signed composite [-1,1] → [0,100] for display/diagnostics.
  const score100 = Math.round(norm01(composite, -1, 1) * 100);

  return {
    key: "batTracking",
    logOdds,
    available: true,
    shrinkWeight: w,
    score100,
    note: `composite=${composite.toFixed(2)} w=${w.toFixed(2)}`,
  };
}

function feat(v: number | null, lo: number, mid: number, hi: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return signed(v, lo, mid, hi);
}
