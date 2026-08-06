// Cross-Radar: pure display logic for Plate ("the Plate") target suggestions
// on Mound cards. Extracted from MoundPowerRadar.tsx so the heading/score
// decisions are unit-testable without a React render harness (this
// codebase's established convention — see moundSettlementLabels.ts).
//
// Never re-derives rankingBasis/hrScore/tier — those are server-stamped and
// read verbatim. This module only decides how to PRESENT them safely.

export type PlateSuggestionTier = "watch" | "power_watch" | "strong" | "elite" | "nuclear";

export interface PlateTargetSuggestionLike {
  rankingBasis: "home_runs" | "overall_fallback";
  hrScore: number | null;
}

export const PLATE_TIER_LABELS: Record<PlateSuggestionTier, string> = {
  watch: "Watch",
  power_watch: "Power Watch",
  strong: "Strong",
  elite: "Elite",
  nuclear: "Nuclear",
};

export function plateTierLabel(tier: string): string {
  return (PLATE_TIER_LABELS as Record<string, string>)[tier] ?? tier;
}

/**
 * True only when EVERY suggestion is genuinely HR-ranked with a real finite
 * score — a single overall-fallback entry (or a malformed hrScore on an
 * entry claiming rankingBasis "home_runs") must never let the whole group
 * read as an HR-specific list. Empty input is never "all HR ranked."
 */
export function isAllHrRanked(targets: readonly PlateTargetSuggestionLike[]): boolean {
  return (
    targets.length > 0 &&
    targets.every(
      (t) => t.rankingBasis === "home_runs" && typeof t.hrScore === "number" && Number.isFinite(t.hrScore),
    )
  );
}

export function plateTargetsHeading(targets: readonly PlateTargetSuggestionLike[]): string {
  return isAllHrRanked(targets) ? "Plate HR Targets vs This Arm" : "Plate Targets vs This Pitcher";
}

/** Safe formatting — never a non-null assertion. Null for anything that isn't a real finite number. */
export function formatHrScore(hrScore: number | null | undefined): string | null {
  return typeof hrScore === "number" && Number.isFinite(hrScore) ? hrScore.toFixed(1) : null;
}

/**
 * The exact score+label fragment for one suggestion row. Falls back to the
 * Plate overall score whenever the HR score is missing or malformed — even
 * if `rankingBasis` claims "home_runs" — so a bad/older payload degrades
 * gracefully instead of rendering "undefined" or crashing.
 */
export function plateTargetScoreLabel(target: { rankingBasis: "home_runs" | "overall_fallback"; hrScore: number | null; plateScore10: number }): string {
  const formattedHr = formatHrScore(target.hrScore);
  if (target.rankingBasis === "home_runs" && formattedHr !== null) {
    return `HR Score ${formattedHr}`;
  }
  return `Plate Score ${target.plateScore10.toFixed(1)}`;
}
