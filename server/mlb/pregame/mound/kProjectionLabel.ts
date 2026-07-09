// Mound Radar — K Projection label (display-only, weight 0 on score10).
//
// Qualitative read on the numeric strikeout projection itself (Projected Ks /
// Matchup Adj. Ks), independent of pitcher skill, platoon fit, or any
// sportsbook line. Pure function, no I/O — mirrors nearHrContact.ts's
// discipline.

export function computeKProjectionLabel(
  projectedStrikeouts: number | null,
  matchupAdjustedStrikeouts: number | null,
): "High" | "Good" | "Average" | "Low" | null {
  const projection = matchupAdjustedStrikeouts ?? projectedStrikeouts;
  if (projection == null) return null;
  if (projection >= 7.0) return "High";
  if (projection >= 6.0) return "Good";
  if (projection >= 5.0) return "Average";
  return "Low";
}
