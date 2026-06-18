// HR Overlay — season triad filter and temporal weighting.
// Restricts data to HR_ALLOWED_SEASONS and blends across present seasons
// using TEMPORAL_WEIGHTS. Marks coverage based on how many seasons are present.

import { HR_ALLOWED_SEASONS, TEMPORAL_WEIGHTS } from "./hrOverlayConstants";
import type { SeasonStatBundle, DataCoverage } from "./hrOverlayTypes";

const BLENDED_NUMERIC_KEYS: ReadonlyArray<keyof SeasonStatBundle> = [
  "barrelPerPA", "maxEV", "sweetSpotPct", "xwOBAcon",
  "fbPct", "pullAirPct", "xSLG", "toppedPct", "slgBySlot",
];

export interface TriadBlendResult {
  blended: Partial<SeasonStatBundle>;
  coverage: DataCoverage;
  presentSeasons: number[];
}

/**
 * Filter season bundles to HR_ALLOWED_SEASONS and compute a temporally-weighted blend.
 * Seasons outside [2024, 2025, 2026] are excluded — their data is stale for the current model.
 */
export function applySeasonTriadWeighting(
  bundles: SeasonStatBundle[],
): TriadBlendResult {
  const allowedSet = new Set<number>(HR_ALLOWED_SEASONS);
  const valid = bundles.filter(b => allowedSet.has(b.season));
  const presentSeasons = valid.map(b => b.season);

  if (valid.length === 0) {
    return { blended: {}, coverage: "MISSING", presentSeasons: [] };
  }

  const coverage: DataCoverage =
    presentSeasons.length === HR_ALLOWED_SEASONS.length ? "FULL" : "PARTIAL";

  // Renormalize weights over the seasons that are actually present.
  const totalWeight = presentSeasons.reduce(
    (sum, s) => sum + (TEMPORAL_WEIGHTS[s] ?? 0), 0,
  );
  if (totalWeight === 0) return { blended: {}, coverage: "MISSING", presentSeasons: [] };

  const blended: Partial<SeasonStatBundle> = {};
  for (const key of BLENDED_NUMERIC_KEYS) {
    let weightedSum = 0;
    let keyWeight = 0;
    for (const bundle of valid) {
      const val = bundle[key];
      if (val != null && typeof val === "number" && Number.isFinite(val)) {
        const w = TEMPORAL_WEIGHTS[bundle.season] ?? 0;
        weightedSum += val * w;
        keyWeight += w;
      }
    }
    if (keyWeight > 0) {
      (blended as Record<string, unknown>)[key] = weightedSum / keyWeight;
    }
  }

  return { blended, coverage, presentSeasons };
}
