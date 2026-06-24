// Component 2b — Pitcher vs opposing BATTING-ORDER-SLOT vulnerability.
//
// Input is the PITCHER's ALLOWED stat line to a given opposing lineup slot
// (full box-score field set). Orientation is canonical from the pitcher-allowed
// perspective — do NOT invert:
//   high HR / SLG / OPS / AVG / OBP / H / 2B / 3B allowed  → pitcher VULNERABLE
//   high BB / HBP allowed                                  → command/traffic vuln
//   high SO by the pitcher vs the slot                     → pitcher STRENGTH (penalty)
//   low AVG/OBP/SLG/OPS allowed, 0 HR with low SLG         → pitcher SUPPRESSION
//   SB / CS                                                → ignored for HR/power
//
// AB drives confidence (shrinkage toward neutral 5). The scorer is a no-op
// (available:false, direction "unavailable") when no row is present, so a missing
// feed NEVER fabricates pitcher-order confidence. Pure function: no I/O.

import type { ComponentScore, PowerDriver } from "./types";
import { lin, round1, clamp10 } from "./scoreUtils";

export type PitcherOrderSplitDirection = "vulnerable" | "neutral" | "suppressive" | "unavailable";

/** Pitcher-allowed stat line to a single opposing batting-order slot. */
export interface PitcherOrderSplitInputs {
  slot: number | null;
  ab: number | null;
  r: number | null;
  h: number | null;
  doubles: number | null;
  triples: number | null;
  hr: number | null;
  rbi: number | null;
  bb: number | null;
  hbp: number | null;
  so: number | null;
  sb: number | null; // ignored
  cs: number | null; // ignored
  avg: number | null;
  obp: number | null;
  slg: number | null;
  ops: number | null;
}

export interface PitcherOrderSplitResult extends ComponentScore {
  direction: PitcherOrderSplitDirection;
  sampleSize: number;
}

/** AB → confidence shrink toward neutral. <10 informational, 50+ ≈ full weight. */
export function orderSplitShrink(ab: number): number {
  if (ab < 10) return 0.15;
  if (ab < 25) return 0.45;
  if (ab < 50) return 0.7;
  return 1.0;
}

export function computePitcherOrderSplit(inputs: PitcherOrderSplitInputs): PitcherOrderSplitResult {
  const drivers: PowerDriver[] = [];
  const warnings: string[] = [];
  const ab = inputs.ab ?? 0;

  const hasRow =
    inputs.slot != null && ab > 0 &&
    (inputs.ops != null || inputs.slg != null || inputs.hr != null || inputs.avg != null);
  if (!hasRow) {
    warnings.push("No pitcher batting-order split available");
    return { score10: 5, available: false, drivers, warnings, direction: "unavailable", sampleSize: ab };
  }

  const hrRate = inputs.hr != null ? inputs.hr / ab : null;
  const xbh = (inputs.doubles ?? 0) + (inputs.triples ?? 0);
  const xbhRate = ab > 0 ? xbh / ab : null;
  const bbHbp = (inputs.bb ?? 0) + (inputs.hbp ?? 0);
  const trafficRate = ab + bbHbp > 0 ? bbHbp / (ab + bbHbp) : null;

  // Allowed production → vulnerability (higher allowed = more vulnerable).
  const sHr = hrRate != null ? lin(hrRate, 0.0, 0.06) : null; // HR per AB
  const sSlg = inputs.slg != null ? lin(inputs.slg, 0.3, 0.6) : null;
  const sOps = inputs.ops != null ? lin(inputs.ops, 0.55, 0.95) : null;
  const sAvg = inputs.avg != null ? lin(inputs.avg, 0.21, 0.32) : null;
  const sObp = inputs.obp != null ? lin(inputs.obp, 0.28, 0.4) : null;
  const sXbh = xbhRate != null ? lin(xbhRate, 0.0, 0.1) : null;
  const sTraffic = trafficRate != null ? lin(trafficRate, 0.05, 0.16) : null;

  // Weights: HR highest, SLG very high, OPS high, AVG/OBP medium, XBH medium
  // support, BB/HBP low-medium. R/RBI low support (omitted as noise). SB/CS ignored.
  const parts: Array<{ value: number | null; weight: number }> = [
    { value: sHr, weight: 4 },
    { value: sSlg, weight: 3 },
    { value: sOps, weight: 2 },
    { value: sAvg, weight: 1 },
    { value: sObp, weight: 1 },
    { value: sXbh, weight: 1 },
    { value: sTraffic, weight: 0.5 },
  ];
  let sum = 0;
  let wsum = 0;
  for (const p of parts) {
    if (p.value == null) continue;
    sum += p.value * p.weight;
    wsum += p.weight;
  }
  let raw = wsum > 0 ? sum / wsum : 5;

  // SO by the pitcher vs this slot is pitcher STRENGTH → inverse penalty.
  if (inputs.so != null && ab > 0) {
    const kRate = inputs.so / ab;
    const kStrength = lin(kRate, 0.15, 0.4);
    raw = clamp10(raw - (kStrength - 5) * 0.5);
  }

  const shrink = orderSplitShrink(ab);
  const score10 = round1(clamp10(5 + (raw - 5) * shrink));

  const direction: PitcherOrderSplitDirection =
    score10 >= 6 ? "vulnerable" : score10 <= 4 ? "suppressive" : "neutral";

  const ev = `slot ${inputs.slot}: ${(inputs.ops ?? 0).toFixed(3)} OPS, ${inputs.hr ?? 0} HR in ${ab} AB`;
  if (direction === "vulnerable") {
    drivers.push({ key: "pos_order_vuln", label: `Pitcher Vulnerable to Slot ${inputs.slot}`, direction: "positive", weight: Math.round(score10 * 10), evidence: ev });
  } else if (direction === "suppressive") {
    drivers.push({ key: "neg_order_suppress", label: "Pitcher Slot Suppression", direction: "negative", weight: Math.round((10 - score10) * 10), evidence: ev });
  }
  if (ab < 10) warnings.push(`Thin pitcher batting-order sample (${ab} AB)`);

  return { score10, available: true, drivers, warnings, direction, sampleSize: ab };
}
