// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: lineup opportunity → small log-odds term
//
// Pure. Lineup opportunity mostly affects PA VOLUME (handled by the PA
// distribution), so its per-PA log-odds effect is deliberately SMALL — a better
// run environment / protection slightly raises pitch quality seen. Team implied
// runs and OBP-ahead are the per-PA signals; batting slot drives volume elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

import type { LineupOpportunityInputs, LogOddsTerm } from "./mathTypes";
import { signed, weightedMean } from "./normalizeStats";

export const LINEUP_OPPORTUNITY_CAP = 0.10;

export function scoreLineupOpportunity(
  inp: LineupOpportunityInputs | null | undefined,
): LogOddsTerm {
  if (!inp) return { key: "lineupOpportunity", logOdds: 0, available: false, shrinkWeight: 0 };

  const parts: Array<{ value: number | null; weight: number }> = [
    { value: feat(inp.teamImpliedRuns, 3.2, 4.4, 6.0), weight: 2 },
    { value: feat(inp.obpAhead, 0.29, 0.33, 0.37), weight: 1 },
  ];

  const { value: composite, coverage } = weightedMean(parts);
  if (composite == null || coverage === 0) {
    return { key: "lineupOpportunity", logOdds: 0, available: false, shrinkWeight: 0 };
  }

  const logOdds = LINEUP_OPPORTUNITY_CAP * composite * coverage;
  return {
    key: "lineupOpportunity",
    logOdds,
    available: true,
    shrinkWeight: 1,
    note: `composite=${composite.toFixed(2)} cov=${coverage.toFixed(2)}`,
  };
}

function feat(v: number | null, lo: number, mid: number, hi: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return signed(v, lo, mid, hi);
}
