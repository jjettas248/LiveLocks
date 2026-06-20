// HR Overlay — ratio-vs-baseline and winsorize helpers.

/**
 * Compute (value − baseline) / baseline, winsorized to ±maxZ.
 * Returns 0.0 when value or baseline is null/zero/invalid.
 */
export function ratioVsBaseline(
  value: number | null | undefined,
  baseline: number,
  maxZ = 2.0,
): number {
  if (value == null || baseline <= 0 || !Number.isFinite(value)) return 0.0;
  const ratio = (value - baseline) / baseline;
  return Math.max(-maxZ, Math.min(maxZ, ratio));
}

/** Clamp score to ±bound (component-level winsorization). */
export function winsorize(score: number, bound = 1.0): number {
  return Math.max(-bound, Math.min(bound, score));
}
