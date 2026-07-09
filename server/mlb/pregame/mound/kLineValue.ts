// Mound Radar — K Line Value (display-only, weight 0 on score10).
//
// Line-aware, Over/Under-aware read on the strikeout projection vs. the
// posted sportsbook pitcher-strikeouts line. Not Over-only ("K Over
// Playability") — a real projection can sit meaningfully below the line too,
// and that's a genuine Under edge, not a non-event. `side` is stamped
// explicitly so the UI never has to infer over-vs-under from a bare sign.
//
// `line` must be the posted pitcher-strikeouts line (MoundMarketEdgeContext.line)
// ONLY — never a pitcher_outs line or any other market's odds. Pure function,
// no I/O — mirrors nearHrContact.ts's discipline. Returns null when inputs are
// missing, never a placeholder.

import { round1 } from "./scoreUtils";

export interface KLineValue {
  side: "Over" | "Under" | "No Edge";
  label: "Elite" | "Strong" | "Solid" | "Weak";
  margin: number;
  line: number;
  projection: number;
}

export function computeKLineValue(
  projectedStrikeouts: number | null,
  matchupAdjustedStrikeouts: number | null,
  line: number | null | undefined,
): KLineValue | null {
  const projection = matchupAdjustedStrikeouts ?? projectedStrikeouts;
  if (projection == null || line == null) return null;
  const margin = round1(projection - line);
  const absMargin = Math.abs(margin);
  const side: KLineValue["side"] = absMargin < 0.5 ? "No Edge" : margin > 0 ? "Over" : "Under";
  const label: KLineValue["label"] =
    absMargin >= 1.5 ? "Elite" : absMargin >= 1.0 ? "Strong" : absMargin >= 0.5 ? "Solid" : "Weak";
  return { side, label, margin, line, projection };
}
