// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: pitch-type interaction → log-odds term
//
// Pure. For each pitch family the pitcher throws, weight the batter's damage vs
// that family by the pitcher's USAGE share, and shrink the batter split by its
// own sample. Sparse splits contribute little; absent families are skipped.
//
//   term ∝ Σ_family  usageShare * shrink(batterDamageVsFamily)
//
// Usage weighting is the key idea: damage vs a pitch the pitcher rarely throws
// matters less than damage vs his bread-and-butter offering.
// ─────────────────────────────────────────────────────────────────────────────

import type { PitchTypeInteractionInputs, LogOddsTerm } from "./mathTypes";
import { signed, clamp01 } from "./normalizeStats";
import { shrinkWeight, STABILIZATION_K } from "./shrinkRates";

export const PITCH_TYPE_CAP = 0.35;

export function scorePitchTypeInteraction(
  inp: PitchTypeInteractionInputs | null | undefined,
): LogOddsTerm {
  const families = inp?.families?.filter((f) => f && Number.isFinite(f.usageShare as number)) ?? [];
  if (families.length === 0) {
    return { key: "pitchType", logOdds: 0, available: false, shrinkWeight: 0 };
  }

  let usageSum = 0;
  let weightedSignal = 0; // Σ usage * shrinkW * signedDamage
  let weightedShrink = 0; // Σ usage * shrinkW   (for an aggregate trust weight)

  for (const f of families) {
    const usage = clamp01(f.usageShare ?? 0);
    if (usage <= 0) continue;
    usageSum += usage;
    if (f.batterXslg == null || !Number.isFinite(f.batterXslg)) continue;

    // Signed damage vs league-average xSLG against that family (mid ~0.40).
    const dmg = signed(f.batterXslg, 0.30, 0.40, 0.58);
    const w = f.batterSample != null ? shrinkWeight(f.batterSample, STABILIZATION_K.pitchTypeSplit) : 0.5;
    weightedSignal += usage * w * dmg;
    weightedShrink += usage * w;
  }

  if (usageSum <= 0 || weightedShrink <= 0) {
    return { key: "pitchType", logOdds: 0, available: false, shrinkWeight: 0 };
  }

  // Normalize the signal by usage so it stays in roughly [-1,1].
  const composite = weightedSignal / usageSum;
  const aggShrink = weightedShrink / usageSum;
  const logOdds = PITCH_TYPE_CAP * composite;

  return {
    key: "pitchType",
    logOdds,
    available: true,
    shrinkWeight: aggShrink,
    note: `usageSum=${usageSum.toFixed(2)} composite=${composite.toFixed(2)}`,
  };
}
