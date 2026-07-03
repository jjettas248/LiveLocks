// Shared pure helpers for the Mound Radar component scorers.
//
// Intentionally DUPLICATED from ../../pregamePowerRadar/scoreUtils.ts rather
// than imported — Mound must not share any file with the Plate engine beyond
// generic roster/date/weather/park/storage/validation utilities. This file is
// small (~40 lines), so duplication is cheaper than the coupling risk of a
// shared import. No I/O, no imports from sport engines.

/** Linear-map `v` from [lo, hi] onto a clamped 0–10 scale. */
export function lin(v: number, lo: number, hi: number): number {
  if (hi === lo) return 5;
  const t = (v - lo) / (hi - lo);
  return clamp10(t * 10);
}

export function clamp10(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(10, v));
}

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Weighted average of `{ value, weight }` entries; ignores null values. */
export function weightedAvg(
  parts: Array<{ value: number | null; weight: number }>,
): { score: number; coverage: number } {
  let sum = 0;
  let wsum = 0;
  let present = 0;
  let total = 0;
  for (const p of parts) {
    total += p.weight;
    if (p.value == null || !Number.isFinite(p.value)) continue;
    sum += p.value * p.weight;
    wsum += p.weight;
    present += p.weight;
  }
  if (wsum === 0) return { score: 0, coverage: 0 };
  return { score: clamp10(sum / wsum), coverage: total === 0 ? 0 : present / total };
}
