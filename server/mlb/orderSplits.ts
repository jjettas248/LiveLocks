// Batting-order split aggregation — pure, no I/O (kept DB-free so it is
// unit-testable and importable without provisioning a database).
//
// Aggregates SLG/OPS by lineup slot from locally-collected per-game stat lines
// (game_player_stats). OBP is approximated from (H+BB)/(AB+BB) since the line
// lacks HBP/SF; the HR overlay only consumes SLG, with OPS as a display extra.

export interface OrderSplitRow {
  battingOrderSlot: number | null;
  ab: number | null;
  h: number | null;
  tb: number | null;
  bb: number | null;
}

export interface OrderSplitAgg {
  splits: Array<{ slot: number; slg: number | null; ops: number | null; pa: number }>;
  overallSlg: number | null;
}

export function aggregateOrderSplits(rows: OrderSplitRow[]): OrderSplitAgg {
  const bySlot = new Map<number, { ab: number; h: number; tb: number; bb: number }>();
  let totAB = 0;
  let totTB = 0;
  for (const r of rows) {
    const slot = r.battingOrderSlot;
    if (slot == null || slot < 1 || slot > 9) continue;
    const ab = r.ab ?? 0;
    const h = r.h ?? 0;
    const tb = r.tb ?? 0;
    const bb = r.bb ?? 0;
    const cur = bySlot.get(slot) ?? { ab: 0, h: 0, tb: 0, bb: 0 };
    cur.ab += ab; cur.h += h; cur.tb += tb; cur.bb += bb;
    bySlot.set(slot, cur);
    totAB += ab; totTB += tb;
  }
  const splits = Array.from(bySlot.entries())
    .map(([slot, s]) => {
      const slg = s.ab > 0 ? parseFloat((s.tb / s.ab).toFixed(3)) : null;
      const obp = (s.ab + s.bb) > 0 ? (s.h + s.bb) / (s.ab + s.bb) : 0;
      const ops = s.ab > 0 ? parseFloat((obp + s.tb / s.ab).toFixed(3)) : null;
      return { slot, slg, ops, pa: s.ab + s.bb };
    })
    .sort((a, b) => a.slot - b.slot);
  const overallSlg = totAB > 0 ? parseFloat((totTB / totAB).toFixed(3)) : null;
  return { splits, overallSlg };
}

/** SLG for a specific lineup slot from an aggregation, or null when absent. */
export function slgForSlot(agg: OrderSplitAgg, slot: number | null | undefined): number | null {
  if (slot == null) return null;
  return agg.splits.find((s) => s.slot === slot)?.slg ?? null;
}
