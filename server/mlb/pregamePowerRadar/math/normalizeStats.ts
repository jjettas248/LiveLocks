// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW normalization helpers
//
// Pure mapping helpers shared by the v2 component scorers. No I/O. These convert
// raw stats into bounded, centered features that feed the additive log-odds
// model. Distinct from production scoreUtils.ts (which maps onto a 0–10 display
// scale) — here we map onto [0,1] and signed [-1,1] feature spaces.
// ─────────────────────────────────────────────────────────────────────────────

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Linear-map `v` from [lo, hi] onto [0,1], clamped. `lo===hi` → 0.5. */
export function norm01(v: number, lo: number, hi: number): number {
  if (hi === lo) return 0.5;
  return clamp01((v - lo) / (hi - lo));
}

/**
 * Signed feature in [-1,1]: maps [lo, mid] → [-1, 0] and [mid, hi] → [0, 1],
 * clamped. Use when `mid` is a neutral reference (e.g. league average) and we
 * want symmetric above/below contributions.
 */
export function signed(v: number, lo: number, mid: number, hi: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v >= mid) {
    if (hi === mid) return 0;
    return clamp((v - mid) / (hi - mid), 0, 1);
  }
  if (mid === lo) return 0;
  return clamp((v - mid) / (mid - lo), -1, 0);
}

export function round(v: number, dp = 4): number {
  if (!Number.isFinite(v)) return 0;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** Inverse sigmoid (logit). Clamps probability away from 0/1 to stay finite. */
export function logit(p: number): number {
  const c = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(c / (1 - c));
}

/**
 * Weighted mean of present `{ value, weight }` pairs (nulls ignored). Returns
 * the value and the fraction of total weight that was present (coverage).
 */
export function weightedMean(
  parts: Array<{ value: number | null; weight: number }>,
): { value: number | null; coverage: number } {
  let sum = 0;
  let wPresent = 0;
  let wTotal = 0;
  for (const p of parts) {
    wTotal += p.weight;
    if (p.value == null || !Number.isFinite(p.value)) continue;
    sum += p.value * p.weight;
    wPresent += p.weight;
  }
  if (wPresent === 0) return { value: null, coverage: 0 };
  return { value: sum / wPresent, coverage: wTotal === 0 ? 0 : wPresent / wTotal };
}
