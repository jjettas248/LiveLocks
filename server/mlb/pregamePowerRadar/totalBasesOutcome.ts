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
 *
 * `isExact` defaults to `true` for callers who already know their source is
 * reliable. Pass `false` when the value came from a box-score fallback path
 * that cannot distinguish doubles/triples from singles (e.g. the Tank01
 * fallback in dataPullService.ts, which approximates `tb` as `hits + hr*3`
 * and silently undercounts any non-HR extra-base hit) — in that case the
 * result is always "tb_unknown", regardless of the numeric value, since a
 * "tb_miss" derived from an undercounted approximation would be a false miss.
 */
export function classifyTotalBasesOutcome(
  totalBases: number | null | undefined,
  isExact: boolean = true,
): TotalBasesOutcome {
  if (totalBases == null || !isExact) return "tb_unknown";
  return totalBases >= 2 ? "tb_success" : "tb_miss";
}
