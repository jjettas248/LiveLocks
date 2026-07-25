// Mound Radar — settlement-label helpers (extracted from MoundPowerRadar.tsx
// for testability, mirroring setupGrade.ts's extraction pattern).
//
// "Cashed"/"Missed"/"Push" are reserved exclusively for a real market-graded
// result (settlementView.marketOutcome). This module produces the baseline-
// only fallback label rendered when no real sportsbook line was ever
// captured — never those three words, never fabricated.

export type MoundModelOutcome = "confirmed" | "not_confirmed" | "push" | null;

/**
 * Baseline-only fallback label — rendered ONLY when marketOutcome is
 * "unavailable" (no real sportsbook line was ever captured for this signal:
 * always true for pitcher_outs, sometimes true for pitcher_strikeouts).
 * Never renders "Cashed"/"Missed"/"Push" — those words are reserved
 * exclusively for a real market-line result. "Push" specifically is reserved
 * for a real market-line tie; the baseline-tie case here reads "Matched
 * Engine Baseline" instead, so the two are never confused.
 */
export function baselineOnlyLabel(modelOutcome: MoundModelOutcome, recommendedSide: "OVER" | "UNDER" | null): string | null {
  if (modelOutcome == null) return null;
  if (modelOutcome === "push") return "Matched Engine Baseline";
  const isFade = recommendedSide === "UNDER";
  if (modelOutcome === "confirmed") return isFade ? "Fade Read Confirmed" : "Follow Read Confirmed";
  return isFade ? "Performed Above Baseline" : "Performed Below Baseline";
}

export type MoundMarketOutcome = "cashed" | "missed" | "push" | "unavailable";

/** Server-decided settlement lane — mirrors shared/moundRadarWin.ts's MoundSettlementLane. */
export type MoundSettlementLane = "market" | "integrity_gap" | "model_review";

/**
 * The label for a public recommendation whose frozen sportsbook bet could not
 * be recovered. Deliberately says nothing about how the pitcher performed: a
 * broken settlement record is not a model-performance verdict, and it is
 * certainly not a win. Never green, never red.
 */
export const MOUND_INTEGRITY_LABEL = "Result Unavailable" as const;

/**
 * The single recommendation-result label shown beneath the letter grade on
 * the RIGHT side of the settled card — the only place this concept ever
 * renders. Mirrors the batting card's single "Cashed"/"Batter Power Only"
 * result slot: exactly one of these strings, never duplicated elsewhere on
 * the card (the left side shows the factual final performance instead — see
 * moundFinalStatLabel). Returns null only when the signal isn't actually
 * settled (no modelOutcome to fall back to either).
 *
 * Lane precedence is decided server-side (buildMoundSettlementView) and only
 * read here:
 *   • market        → Cashed/Missed/Push, absolute precedence.
 *   • integrity_gap → "Result Unavailable". A public recommendation must
 *                     never fall back to model-performance wording, and must
 *                     never be upgraded into a Cashed off the engine baseline.
 *   • model_review  → the baseline-only wording, legitimate only because no
 *                     sportsbook bet was ever recommended on this card.
 */
export function moundResultLabel(
  marketOutcome: MoundMarketOutcome,
  modelOutcome: MoundModelOutcome,
  recommendedSide: "OVER" | "UNDER" | null,
  lane: MoundSettlementLane = "model_review",
): string | null {
  if (marketOutcome === "cashed") return "Cashed";
  if (marketOutcome === "missed") return "Missed";
  if (marketOutcome === "push") return "Push";
  // Model-performance wording is reachable ONLY from the model lane. The
  // "market" lane with no market outcome is a contradiction the server should
  // never produce — treat it like any other unrecoverable bet rather than
  // letting a betting result quietly degrade into a model verdict.
  if (lane !== "model_review") return MOUND_INTEGRITY_LABEL;
  return baselineOnlyLabel(modelOutcome, recommendedSide);
}

/**
 * The factual final-performance text shown beneath the pitcher name on the
 * LEFT side of the settled card — mirrors the batting card's "HOMERED"/
 * "No HR" position, but as a plain counting stat (Mound has no single
 * discrete event to name). Always this exact "{stat} {unit} · Final" shape,
 * identical regardless of Follow/Fade or Cashed/Missed/Push/fallback — the
 * factual outcome never changes based on how it graded. Null when there's no
 * final stat to show (never a placeholder).
 */
export function moundFinalStatLabel(finalStat: number | null, unit: "Ks" | "Outs"): string | null {
  if (finalStat == null) return null;
  return `${finalStat} ${unit} · Final`;
}
