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
 * Realistic avg-innings-per-start for a probable starter, derived from
 * season totals. seasonStats.inningsPitched is a SEASON-TOTAL across every
 * appearance (starts + relief) — MLB Stats API's group=pitching/stats=season
 * returns one aggregate row, with no starts-only split available anywhere in
 * this codebase's data pulls. For a pure starter this ratio is accurate; for
 * a swingman/call-up who also relieved, dividing total IP by gamesStarted
 * alone overstates true innings-per-start (relief innings get folded into
 * the starts-only denominator) — e.g. 20 relief IP + 12 start IP over 2
 * starts = 32 total IP / 2 GS = 16.0 "avg IP/start" (real value ~6). Clamped
 * to a realistic MLB-starter band rather than attempting a starts-only IP
 * recomputation (that would require new data-pull work; see CLAUDE.md §7a's
 * discipline on additive, no-op-when-absent inputs and capped effects).
 * Single source of truth — buildMlbMoundRadar.ts and moundShadowOutcomes.ts
 * BOTH call this instead of duplicating the raw division, so the
 * display-time and grading-time values can never independently drift, and
 * every downstream consumer (matchupAdjustedKs.ts's base, workload.ts's
 * "Long Leash", riskDrivers.ts's "Short Leash Risk") gets the same
 * corrected value instead of the same duplicated bug.
 *
 * ONLY an upper clamp — no lower bound. The distortion this function exists
 * to correct (relief innings folded into a starts-only denominator) is
 * strictly one-directional: season-total inningsPitched can only be >= true
 * innings-as-a-starter (relief innings are never negative), so the raw ratio
 * can only ever be inflated, never deflated. A genuinely LOW ratio (e.g. a
 * true opener/call-up with 1 IP in 1 GS) is therefore real, not an artifact —
 * clamping it upward would falsely raise moundShadowOutcomes.ts's
 * pitcher_outs settlement baseline for exactly the low-sample starters who
 * most need an accurate (low) bar (Codex review, PR #105).
 */
const AVG_INNINGS_PER_START_MAX = 8.0;

export function computeAvgInningsPerStart(
  gamesStarted: number | null | undefined,
  inningsPitched: number | null | undefined,
): number | null {
  if (gamesStarted == null || gamesStarted <= 0 || inningsPitched == null) return null;
  return Math.min(inningsPitched / gamesStarted, AVG_INNINGS_PER_START_MAX);
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
