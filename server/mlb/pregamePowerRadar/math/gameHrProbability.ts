// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: per-PA → game HR probability
//
// Pure. Converts a per-PA HR probability + a PA distribution into the probability
// of 1+ HR in the game:
//
//   P(HR in game) = Σ_n  P(PA = n) * (1 - (1 - hrPerPa)^n)
//
// Monotonically increasing in both hrPerPa and PA count; always bounded [0,1].
// ─────────────────────────────────────────────────────────────────────────────

import { clamp01 } from "./normalizeStats";

/** P(1+ HR | exactly n PA) = 1 - (1 - p)^n. */
export function gameHrProbabilityForPaCount(hrPerPa: number, paCount: number): number {
  const p = clamp01(hrPerPa);
  const n = Math.max(0, Math.floor(paCount));
  if (n === 0) return 0;
  return clamp01(1 - Math.pow(1 - p, n));
}

/** P(1+ HR) marginalized over a PA distribution (keys = stringified counts). */
export function gameHrProbability(
  hrPerPa: number | null | undefined,
  paDistribution: Record<string, number> | null | undefined,
): number {
  if (hrPerPa == null || !Number.isFinite(hrPerPa)) return 0;
  const p = clamp01(hrPerPa);
  if (!paDistribution) return 0;

  let prob = 0;
  let massSum = 0;
  for (const [key, mass] of Object.entries(paDistribution)) {
    const n = Number(key);
    if (!Number.isFinite(n) || !Number.isFinite(mass) || mass <= 0) continue;
    prob += mass * (1 - Math.pow(1 - p, n));
    massSum += mass;
  }
  // Renormalize defensively if the distribution didn't sum to exactly 1.
  if (massSum > 0 && Math.abs(massSum - 1) > 1e-9) prob /= massSum;
  return clamp01(prob);
}
