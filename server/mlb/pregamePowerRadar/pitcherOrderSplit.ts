// Component 2b — Pitcher Batting-Order-Slot Vulnerability (PITCHER perspective).
//
// The input is the PITCHER's ALLOWED stats to the opposing batter's lineup slot.
// Orientation is canonical — do NOT invert blindly:
//   HIGH allowed OPS / SLG / HR-per-AB → pitcher is VULNERABLE to that slot → HIGH score
//   LOW  allowed OPS / SLG / HR-per-AB → pitcher SUPPRESSES that slot        → LOW score
//   HIGH strikeouts by the pitcher vs the slot → pitcher STRENGTH (not hitter
//     opportunity) → pulls the score DOWN.
//
// Sample-size shrinkage pulls thin samples toward neutral (5). The scorer is a
// no-op (available:false, neutral 5, direction "unknown") when no slot row is
// present, so a missing/absent feed can never penalize a hitter — it simply does
// not contribute. Pure function: no I/O, no engine imports.

import type { ComponentScore, PowerDriver } from "./types";
import { lin, round1, clamp10 } from "./scoreUtils";

export type OrderSplitDirection = "vulnerable" | "neutral" | "suppressive" | "unknown";

/** Pitcher-allowed stats to a single opposing batting-order slot. */
export interface PitcherOrderSplitInputs {
  slot: number | null; // opposing batter's lineup slot (1–9)
  atBats: number | null; // AB the pitcher has allowed to this slot
  hr: number | null; // HR allowed to this slot
  ops: number | null; // OPS allowed to this slot
  slg: number | null; // SLG allowed to this slot
  obp: number | null; // OBP allowed (optional)
  avg: number | null; // AVG allowed (optional)
  strikeouts: number | null; // K by the pitcher vs this slot (optional; pitcher STRENGTH)
}

export interface PitcherOrderSplitResult extends ComponentScore {
  /** vulnerable = pitcher gives up production to this slot; suppressive = pitcher owns it. */
  direction: OrderSplitDirection;
  sampleSize: number;
}

export function computePitcherOrderSplit(inputs: PitcherOrderSplitInputs): PitcherOrderSplitResult {
  const drivers: PowerDriver[] = [];
  const warnings: string[] = [];
  const ab = inputs.atBats ?? 0;

  // No usable row → neutral + unavailable + unknown. NEVER penalize on absence.
  const hasRow =
    inputs.slot != null &&
    ab > 0 &&
    (inputs.ops != null || inputs.slg != null || inputs.hr != null);
  if (!hasRow) {
    warnings.push("No pitcher batting-order split available");
    return { score10: 5, available: false, drivers, warnings, direction: "unknown", sampleSize: ab };
  }

  // Allowed production → vulnerability (higher allowed = more vulnerable).
  const sOps = inputs.ops != null ? lin(inputs.ops, 0.55, 0.95) : null;
  const sSlg = inputs.slg != null ? lin(inputs.slg, 0.3, 0.6) : null;
  const hrRate = inputs.hr != null && ab > 0 ? inputs.hr / ab : null;
  const sHr = hrRate != null ? lin(hrRate, 0.0, 0.08) : null;

  const parts: Array<{ value: number | null; weight: number }> = [
    { value: sOps, weight: 3 },
    { value: sSlg, weight: 2 },
    { value: sHr, weight: 3 },
  ];
  let sum = 0;
  let wsum = 0;
  for (const p of parts) {
    if (p.value == null) continue;
    sum += p.value * p.weight;
    wsum += p.weight;
  }
  let raw = wsum > 0 ? sum / wsum : 5;

  // Pitcher strikeout dominance vs this slot SUPPRESSES vulnerability.
  if (inputs.strikeouts != null && ab > 0) {
    const kRate = inputs.strikeouts / ab; // K per AB
    const kStrength = lin(kRate, 0.15, 0.4); // 0–10, higher = more dominant
    raw = clamp10(raw - (kStrength - 5) * 0.4);
  }

  // Sample-size shrinkage toward neutral 5 (<5 AB barely moves, 25+ AB ≈ full).
  const shrink = Math.min(1, ab / 25);
  const score10 = round1(clamp10(5 + (raw - 5) * shrink));

  const direction: OrderSplitDirection =
    score10 >= 6 ? "vulnerable" : score10 <= 4 ? "suppressive" : "neutral";

  const opsEvidence = `slot OPS ${(inputs.ops ?? 0).toFixed(3)} in ${ab} AB`;
  if (direction === "vulnerable") {
    drivers.push({
      key: "pos_order_vuln",
      label: `Pitcher Vulnerable to Slot ${inputs.slot}`,
      direction: "positive",
      weight: Math.round(score10 * 10),
      evidence: opsEvidence,
    });
  } else if (direction === "suppressive") {
    drivers.push({
      key: "neg_order_suppress",
      label: "Pitcher Slot Suppression",
      direction: "negative",
      weight: Math.round((10 - score10) * 10),
      evidence: opsEvidence,
    });
  }
  if (ab < 10) warnings.push(`Thin batting-order sample (${ab} AB)`);

  return { score10, available: true, drivers, warnings, direction, sampleSize: ab };
}
