// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: bat tracking → log-odds term + 0–100 score
//
// Pure. Uses repeatable swing traits that are mechanistically relevant to HR
// creation without fabricating proprietary Statcast metrics:
//   • bat speed / fast-swing frequency = energy ceiling
//   • ideal attack-angle frequency (Statcast 5–20°) = launch-path quality
//   • squared-up rate / blast rate = contact efficiency, ONLY when sourced
//   • average swing length / swing-path tilt remain diagnostics until fitted
//
// The component is deliberately capped and sample-shrunk. It is a challenger
// feature, not permission to change the production champion without backtest.
// ─────────────────────────────────────────────────────────────────────────────

import type { BatTrackingInputs, LogOddsTerm } from "./mathTypes";
import { signed, weightedMean, norm01, clamp } from "./normalizeStats";
import { shrinkWeight } from "./shrinkRates";

export const BAT_TRACKING_CAP = 0.32;
const BAT_ANGLE_SYNERGY_CAP = 0.06;

export interface BatTrackingResult extends LogOddsTerm {
  /** 0–100 standalone bat-tracking power score (null when unavailable). */
  score100: number | null;
}

export function scoreBatTrackingPower(inp: BatTrackingInputs | null | undefined): BatTrackingResult {
  if (!inp) {
    return { key: "batTracking", logOdds: 0, available: false, shrinkWeight: 0, score100: null };
  }

  const idealAngleRate = feat(inp.idealAttackAngleRatePct, 20, 42, 68);
  const averageAngleFallback =
    idealAngleRate == null && inp.avgAttackAngle != null && Number.isFinite(inp.avgAttackAngle)
      ? averageAttackAngleFit(inp.avgAttackAngle)
      : null;

  // Signed [-1,1] features around documented/default swing references. Swing
  // length is intentionally NOT rewarded as "longer = more power": Statcast
  // defines what it measures, but no honest fitted relationship exists in this
  // repo yet. Keep it diagnostic until historical ablation proves a direction.
  const signedParts: Array<{ value: number | null; weight: number }> = [
    { value: feat(inp.avgBatSpeed, 67, 71.5, 78), weight: 3.0 },
    { value: feat(inp.fastSwingRatePct, 5, 23, 55), weight: 2.0 },
    { value: idealAngleRate ?? averageAngleFallback, weight: 2.5 },
    { value: feat(inp.squaredUpPerSwingPct, 18, 25, 34), weight: 2.0 },
    { value: feat(inp.blastPerSwingPct, 4, 11, 22), weight: 2.0 },
  ];
  const { value: composite, coverage } = weightedMean(signedParts);
  if (composite == null || coverage === 0) {
    return { key: "batTracking", logOdds: 0, available: false, shrinkWeight: 0, score100: null };
  }

  const w = inp.swingSample != null ? shrinkWeight(inp.swingSample, 50) : 0.55;
  let logOdds = BAT_TRACKING_CAP * composite * w * coverage;

  // Small interaction: top-end swing speed is more useful for HR creation when
  // the player's attack path also repeatedly enters Statcast's ideal 5–20° band.
  // No bonus from either feature alone; this avoids double-counting raw speed.
  const speed = feat(inp.avgBatSpeed, 67, 71.5, 78);
  if (speed != null && idealAngleRate != null && speed > 0 && idealAngleRate > 0) {
    logOdds += BAT_ANGLE_SYNERGY_CAP * speed * idealAngleRate * w;
  }
  logOdds = clamp(logOdds, -BAT_TRACKING_CAP, BAT_TRACKING_CAP);

  const score100 = Math.round(norm01(composite, -1, 1) * 100);

  const diagnostics: string[] = [
    `composite=${composite.toFixed(2)}`,
    `w=${w.toFixed(2)}`,
    `coverage=${coverage.toFixed(2)}`,
  ];
  if (inp.avgSwingLength != null) diagnostics.push(`swingLen=${inp.avgSwingLength.toFixed(2)}ft(diagnostic)`);
  if (inp.avgSwingPathTilt != null) diagnostics.push(`pathTilt=${inp.avgSwingPathTilt.toFixed(1)}deg(diagnostic)`);
  if (inp.attackAngleStdDev != null) diagnostics.push(`attackSd=${inp.attackAngleStdDev.toFixed(1)}deg(diagnostic)`);

  return {
    key: "batTracking",
    logOdds,
    available: true,
    shrinkWeight: w,
    score100,
    note: diagnostics.join(" "),
  };
}

function feat(v: number | null, lo: number, mid: number, hi: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return signed(v, lo, mid, hi);
}

/**
 * Fallback only when ideal-angle frequency is unavailable. Statcast defines the
 * ideal attack-angle band as 5–20°. The midpoint (12.5°) is best, with a smooth
 * decline to neutral at the edges and negative outside an extended -5..30° band.
 */
function averageAttackAngleFit(angle: number): number {
  const center = 12.5;
  const distance = Math.abs(angle - center);
  if (distance <= 7.5) return 1 - (distance / 7.5) * 0.35; // all 5–20° stays positive
  if (distance >= 17.5) return -1;
  return 0.65 - ((distance - 7.5) / 10) * 1.65;
}
