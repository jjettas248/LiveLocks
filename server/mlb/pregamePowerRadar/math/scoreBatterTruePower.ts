// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: batter true-power → log-odds term
//
// Pure. Converts season batter power stats into a single capped log-odds delta
// applied to the per-PA HR logit. Absent stats are ignored (no-op); the term is
// scaled by sample-backed shrinkage so thin samples can't swing the model.
//
// League reference midpoints below are documented DEFAULT PRIORS (approx. recent
// MLB averages), NOT fitted parameters.
// ─────────────────────────────────────────────────────────────────────────────

import type { BatterTruePowerInputs, LogOddsTerm } from "./mathTypes";
import { signed, weightedMean } from "./normalizeStats";
import { shrinkWeight } from "./shrinkRates";

/** Max absolute log-odds this component may contribute. */
export const BATTER_POWER_CAP = 0.85;

export function scoreBatterTruePower(inp: BatterTruePowerInputs | null | undefined): LogOddsTerm {
  if (!inp) return { key: "batterPower", logOdds: 0, available: false, shrinkWeight: 0 };

  // Signed [-1,1] features centered on league-average reference (lo, mid, hi).
  const parts: Array<{ value: number | null; weight: number }> = [
    { value: feat(inp.xISO, 0.09, 0.14, 0.26), weight: 3 },
    { value: feat(inp.barrelRatePct, 2, 8, 16), weight: 3 },
    { value: feat(inp.hrFBRatioPct, 6, 13, 25), weight: 2 },
    { value: feat(inp.maxEV, 102, 108, 116), weight: 2 },
    { value: feat(inp.hardHitRatePct, 28, 38, 52), weight: 2 },
    { value: feat(inp.xSLG, 0.34, 0.42, 0.56), weight: 2 },
    { value: feat(inp.exitVelocity, 85, 89, 94), weight: 1 },
    { value: feat(inp.flyBallPct, 22, 37, 50), weight: 1 },
    { value: feat(inp.pullRatePct, 30, 40, 55), weight: 1 },
    { value: feat(inp.sweetSpotPct, 26, 33, 42), weight: 1 },
    { value: feat(inp.xwOBAcon, 0.30, 0.37, 0.46), weight: 1 },
  ];

  const { value: composite, coverage } = weightedMean(parts);
  if (composite == null || coverage === 0) {
    return { key: "batterPower", logOdds: 0, available: false, shrinkWeight: 0 };
  }

  // Shrink by the PA sample backing the season rates (power stabilizes by ~120 PA).
  const w = inp.paSample != null ? shrinkWeight(inp.paSample, 120) : 0.6; // default mid-trust when sample unknown
  const logOdds = BATTER_POWER_CAP * composite * w;

  return {
    key: "batterPower",
    logOdds,
    available: true,
    shrinkWeight: w,
    note: `composite=${composite.toFixed(2)} cov=${coverage.toFixed(2)} w=${w.toFixed(2)}`,
  };
}

function feat(v: number | null, lo: number, mid: number, hi: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return signed(v, lo, mid, hi);
}
