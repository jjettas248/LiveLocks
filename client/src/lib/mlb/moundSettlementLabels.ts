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
