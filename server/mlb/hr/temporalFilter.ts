// Temporal filter (T) — enforces the 2024–2026 player-data window and blends
// per-season values with fixed recency weights. Pure, no I/O.

import {
  HR_ALLOWED_SEASONS,
  SEASON_TRIAD_WEIGHTS,
  type AllowedSeason,
} from "./hrOverlayConstants";
import { isPresent } from "./normalization";

export interface SeasonValue {
  season: number;
  value: number | null;
  pa?: number | null;
}

export interface TriadResult {
  value: number | null;
  seasonsUsed: AllowedSeason[];
  totalPA: number;
  rejectedSeasons: number[];
}

export function isAllowedSeason(season: number): season is AllowedSeason {
  return (HR_ALLOWED_SEASONS as readonly number[]).includes(season);
}

/**
 * Blend per-season values across the 2024–2026 triad using fixed recency
 * weights, renormalized over the seasons actually present with data. Rows
 * outside the triad are rejected (recorded, never used). Returns a null value
 * when no allowed season has data.
 */
export function applySeasonTriadWeighting(
  rows: SeasonValue[] | null | undefined,
): TriadResult {
  const rejectedSeasons: number[] = [];
  const valid: Array<{ season: AllowedSeason; value: number; pa: number }> = [];

  for (const r of rows ?? []) {
    if (!isAllowedSeason(r.season)) {
      rejectedSeasons.push(r.season);
      continue;
    }
    if (!isPresent(r.value)) continue;
    valid.push({ season: r.season, value: r.value, pa: r.pa ?? 0 });
  }

  if (valid.length === 0) {
    return { value: null, seasonsUsed: [], totalPA: 0, rejectedSeasons };
  }

  let weightSum = 0;
  for (const v of valid) weightSum += SEASON_TRIAD_WEIGHTS[v.season];

  let acc = 0;
  for (const v of valid) {
    acc += (SEASON_TRIAD_WEIGHTS[v.season] / weightSum) * v.value;
  }

  return {
    value: acc,
    seasonsUsed: valid.map((v) => v.season),
    totalPA: valid.reduce((s, v) => s + v.pa, 0),
    rejectedSeasons,
  };
}
