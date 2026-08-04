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
import type { PaPathJointDistribution } from "./mathTypes";

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

/**
 * PR6 — corrected JOINT game HR probability across the starter/bullpen path.
 *
 *   P(HR in game) = 1 − Σ_{n_s,n_b} P(N_s=n_s, N_b=n_b)·(1−p_s)^{n_s}·(1−p_b)^{n_b}
 *
 * `p_s` (vs starter) and `p_b` (vs bullpen) are distinct per-PA rates; the joint
 * distribution over (n_s, n_b) supplies the exposure. Monotonically increasing in
 * p_s, p_b, and total PA; always bounded [0,1]. When the path is all-starter
 * (n_b ≡ 0) this reduces exactly to the single-path result for p_s.
 *
 * Returns NULL — never a fabricated value — when the path is unavailable (no
 * exposure evidence) or empty. Missing exposure must surface honestly, not as a
 * silent all-starter default.
 */
export function jointGameHrProbability(
  pStarter: number | null | undefined,
  pBullpen: number | null | undefined,
  path: PaPathJointDistribution | null | undefined,
): number | null {
  if (!path || !path.joint || path.available === false) return null;
  const ps = pStarter != null && Number.isFinite(pStarter) ? clamp01(pStarter) : 0;
  const pb = pBullpen != null && Number.isFinite(pBullpen) ? clamp01(pBullpen) : 0;

  let noHrProb = 0; // Σ P(n_s,n_b)·(1−p_s)^{n_s}·(1−p_b)^{n_b}
  let massSum = 0;
  for (const [key, mass] of Object.entries(path.joint)) {
    if (!Number.isFinite(mass) || mass <= 0) continue;
    const [ns, nb] = key.split(":").map(Number);
    if (!Number.isFinite(ns) || !Number.isFinite(nb) || ns < 0 || nb < 0) continue;
    noHrProb += mass * Math.pow(1 - ps, ns) * Math.pow(1 - pb, nb);
    massSum += mass;
  }
  if (massSum <= 0) return null;
  // Renormalize defensively if the joint didn't sum to exactly 1.
  if (Math.abs(massSum - 1) > 1e-9) noHrProb /= massSum;
  return clamp01(1 - noHrProb);
}
