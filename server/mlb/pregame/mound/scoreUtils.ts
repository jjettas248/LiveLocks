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

/**
 * Season K/9 → expected per-start strikeout count, assuming a ~6-inning
 * start. Single source of truth for this conversion — used by BOTH
 * recentForm.ts's "Recent K Form" scoring trend and
 * moundOutcomeAttribution.ts's settlement bar, so the two can never silently
 * drift apart (a pregame score claiming a pitcher is "trending above
 * expectation" and the settlement rule judging "did they beat expectation"
 * must use the identical expectation).
 */
export function seasonKPer9ToPerStartExpectation(seasonKPer9: number): number {
  return seasonKPer9 * (6 / 9);
}

/**
 * Rounded, nullable per-start strikeout expectation — the actual shared call
 * site for both the Mound card's displayed "Projected Ks" (buildMlbMoundRadar.ts)
 * and the win/loss settlement baseline (moundOutcomeAttribution.ts), so the
 * two are computed by calling the identical function, not just the identical
 * formula.
 */
export function projectedStrikeoutsFromKPer9(seasonKPer9: number | null | undefined): number | null {
  return seasonKPer9 != null ? round1(seasonKPer9ToPerStartExpectation(seasonKPer9)) : null;
}

/**
 * Lineup-weighted platoon strikeout rate for a pitcher — the pitcher's own
 * K-rate split by opposing-batter handedness, weighted by the confirmed
 * opposing lineup's L/R/S composition. Extracted so opponentKProfile.ts's
 * score10 component and matchupAdjustedKs.ts's display-only projection both
 * derive this number from one place rather than duplicating the weighting
 * math. Switch hitters bat opposite the pitcher's throwing hand in
 * aggregate — approximated with a 50/50 split across the two known rates
 * when both exist.
 */
export function weightedPlatoonKRate(
  kRateVsLHB: number | null,
  kRateVsRHB: number | null,
  handedness: { left: number; right: number; switchHit: number } | null,
): number | null {
  if (!handedness || (kRateVsLHB == null && kRateVsRHB == null)) return null;
  const total = handedness.left + handedness.right + handedness.switchHit;
  if (total <= 0) return null;
  const lWeight = handedness.left + handedness.switchHit / 2;
  const rWeight = handedness.right + handedness.switchHit / 2;
  if (kRateVsLHB != null && kRateVsRHB != null) {
    return (kRateVsLHB * lWeight + kRateVsRHB * rWeight) / total;
  }
  return kRateVsLHB ?? kRateVsRHB;
}
