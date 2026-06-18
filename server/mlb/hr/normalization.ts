// Pure normalization helpers for the HR overlay. No I/O.

import {
  WINSOR_RATIO_MIN,
  WINSOR_RATIO_MAX,
  COMPONENT_SCORE_MIN,
  COMPONENT_SCORE_MAX,
} from "./hrOverlayConstants";

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function isPresent(x: number | null | undefined): x is number {
  return x != null && Number.isFinite(x);
}

/**
 * Ratio of a stat vs its league baseline, winsorized to bound outliers.
 * Returns null when the input is missing/invalid so callers can mark coverage.
 */
export function ratioVsBaseline(
  value: number | null | undefined,
  baseline: number,
): number | null {
  if (!isPresent(value) || baseline <= 0) return null;
  return clamp(value / baseline, WINSOR_RATIO_MIN, WINSOR_RATIO_MAX);
}

/**
 * Convert a winsorized ratio (≈[0.5, 2.0], 1.0 = neutral) into a signed,
 * log-symmetric component score in [-1, 1]: ratio 2.0 → +1, 0.5 → −1, 1.0 → 0.
 * A null ratio (absent data) is a no-op contribution of 0.
 */
export function ratioToScore(ratio: number | null): number {
  if (ratio == null || ratio <= 0) return 0;
  const score = Math.log(ratio) / Math.log(2);
  return clamp(score, COMPONENT_SCORE_MIN, COMPONENT_SCORE_MAX);
}
