// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: zone/location interaction → log-odds term
//
// Pure. Rewards overlap between the batter's hot zones and the pitcher's mistake
// tendencies: heart-of-zone damage × pitcher heart/middle-middle rate, plus
// elevated-FB and low-breaking overlaps. Fully no-op when zone data is absent
// (this is a P2 family — see the stat-coverage audit; usually unavailable today).
// ─────────────────────────────────────────────────────────────────────────────

import type { ZoneLocationInputs, LogOddsTerm } from "./mathTypes";
import { signed, clamp01 } from "./normalizeStats";

export const ZONE_LOCATION_CAP = 0.30;

export function scoreZoneLocationInteraction(
  inp: ZoneLocationInputs | null | undefined,
): LogOddsTerm {
  if (!inp) return { key: "zoneLocation", logOdds: 0, available: false, shrinkWeight: 0 };

  // Each overlap term = signed(batterDamage) * pitcherMistakeExposure[0,1].
  const overlaps: number[] = [];

  // Heart of zone — batter heart xSLG × pitcher heart+middle-middle exposure.
  const heartExposure = bestExposure(inp.pitcherHeartRate, inp.pitcherMiddleMiddleRate);
  pushOverlap(overlaps, inp.batterHeartXslg, heartExposure, 0.32, 0.42, 0.60);

  // Elevated fastball — batter elevated-FB xSLG × pitcher heart exposure (proxy).
  pushOverlap(overlaps, inp.batterElevatedFbXslg, inp.pitcherHeartRate, 0.30, 0.40, 0.58);

  // Low breaking ball — batter low-breaking xSLG × pitcher hanger rate.
  pushOverlap(overlaps, inp.batterLowBreakingXslg, inp.pitcherHangerRate, 0.26, 0.36, 0.52);

  if (overlaps.length === 0) {
    return { key: "zoneLocation", logOdds: 0, available: false, shrinkWeight: 0 };
  }

  // Mean overlap, already in roughly [-1,1] because exposure ∈ [0,1].
  const composite = overlaps.reduce((a, b) => a + b, 0) / overlaps.length;
  const logOdds = ZONE_LOCATION_CAP * composite;

  return {
    key: "zoneLocation",
    logOdds,
    available: true,
    shrinkWeight: 1,
    note: `overlaps=${overlaps.length} composite=${composite.toFixed(2)}`,
  };
}

function bestExposure(a: number | null, b: number | null): number | null {
  const vals = [a, b].filter((x): x is number => x != null && Number.isFinite(x));
  if (vals.length === 0) return null;
  return Math.max(...vals);
}

function pushOverlap(
  out: number[],
  batterDamage: number | null,
  pitcherExposure: number | null,
  lo: number,
  mid: number,
  hi: number,
): void {
  if (batterDamage == null || !Number.isFinite(batterDamage)) return;
  if (pitcherExposure == null || !Number.isFinite(pitcherExposure)) return;
  const dmg = signed(batterDamage, lo, mid, hi); // [-1,1]
  const exp = clamp01(pitcherExposure); // [0,1]
  out.push(dmg * exp);
}
