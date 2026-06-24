// Component 5b — Batter production from TODAY's lineup slot.
//
// Input is the batter's OWN historical production hitting from the slot they bat
// in today (SLG/OPS by slot, from gamePlayerStats → aggregateOrderSplits).
// Orientation: strong production from the slot = positive context; weak
// production from the slot = downgrade ("Weak From Lineup Slot"). PA drives
// confidence (shrinkage toward neutral 5). No-op (available:false) when the slot
// row is absent, so it never penalizes on missing data. Pure function: no I/O.

import type { ComponentScore, PowerDriver } from "./types";
import { lin, round1, clamp10 } from "./scoreUtils";

export type BatterOrderSplitDirection = "strong" | "neutral" | "weak" | "unavailable";

export interface BatterOrderSplitInputs {
  slot: number | null;
  pa: number | null; // plate appearances accumulated from this slot
  slg: number | null;
  ops: number | null;
}

export interface BatterOrderSplitResult extends ComponentScore {
  direction: BatterOrderSplitDirection;
  sampleSize: number;
}

/** PA → confidence shrink. Order-slot samples accrue over many games. */
export function batterSlotShrink(pa: number): number {
  if (pa < 20) return 0.2;
  if (pa < 50) return 0.5;
  if (pa < 120) return 0.75;
  return 1.0;
}

export function computeBatterOrderSplit(inputs: BatterOrderSplitInputs): BatterOrderSplitResult {
  const drivers: PowerDriver[] = [];
  const warnings: string[] = [];
  const pa = inputs.pa ?? 0;

  const hasRow = inputs.slot != null && pa > 0 && (inputs.slg != null || inputs.ops != null);
  if (!hasRow) {
    warnings.push("No batter lineup-slot split available");
    return { score10: 5, available: false, drivers, warnings, direction: "unavailable", sampleSize: pa };
  }

  const sSlg = inputs.slg != null ? lin(inputs.slg, 0.34, 0.52) : null;
  const sOps = inputs.ops != null ? lin(inputs.ops, 0.66, 0.85) : null;
  const parts: Array<{ value: number | null; weight: number }> = [
    { value: sSlg, weight: 2 },
    { value: sOps, weight: 1 },
  ];
  let sum = 0;
  let wsum = 0;
  for (const p of parts) {
    if (p.value == null) continue;
    sum += p.value * p.weight;
    wsum += p.weight;
  }
  const raw = wsum > 0 ? sum / wsum : 5;
  const shrink = batterSlotShrink(pa);
  const score10 = round1(clamp10(5 + (raw - 5) * shrink));

  const direction: BatterOrderSplitDirection =
    score10 >= 6 ? "strong" : score10 <= 4 ? "weak" : "neutral";

  const ev = `slot ${inputs.slot}: ${(inputs.ops ?? 0).toFixed(3)} OPS in ${pa} PA`;
  if (direction === "strong") {
    drivers.push({ key: "pos_batter_slot", label: `Strong From Slot ${inputs.slot}`, direction: "positive", weight: Math.round(score10 * 10), evidence: ev });
  } else if (direction === "weak") {
    drivers.push({ key: "neg_batter_slot", label: "Weak From Lineup Slot", direction: "negative", weight: Math.round((10 - score10) * 10), evidence: ev });
  }
  if (pa < 20) warnings.push(`Thin lineup-slot sample (${pa} PA)`);

  return { score10, available: true, drivers, warnings, direction, sampleSize: pa };
}
