// Pre-Game Power Radar — internal Total Bases outcome classification (pure).
//
// Research instrumentation, fully isolated from winAttribution.ts's HR-oriented
// `outcome`/`userVisible` public classification — this module never touches
// those fields and is never read by them. Fixed internal target only: not a
// public claim, not fed into scoring/qualification/ranking.

export type TotalBasesOutcome = "tb_success" | "tb_miss" | "tb_unknown";

/**
 * Classify a graded target's Total Bases result against the fixed internal
 * 2+ TB target. `totalBases` is the final box-score value; `null`/`undefined`
 * (final line unavailable) always yields "tb_unknown" — never fabricated.
 */
export function classifyTotalBasesOutcome(totalBases: number | null | undefined): TotalBasesOutcome {
  if (totalBases == null) return "tb_unknown";
  return totalBases >= 2 ? "tb_success" : "tb_miss";
}
