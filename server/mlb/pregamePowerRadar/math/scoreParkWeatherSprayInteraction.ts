// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: park + weather + spray + geometry
//
// Pure. Combines:
//   • observed Statcast HR park factor (handedness-specific when available)
//   • current pregame wind/temperature
//   • batter pull-air tendency
//   • actual 2026 Statcast pull-side fence distance/height versus park average
//
// Physical geometry is an INTERACTION term, not a replacement for empirical park
// factor. A short porch only matters more for a batter whose HR shape reaches
// that sector. All coefficients remain bounded shadow priors pending backtest.
// ─────────────────────────────────────────────────────────────────────────────

import type { ParkWeatherSprayInputs, LogOddsTerm } from "./mathTypes";
import { signed, clamp, clamp01 } from "./normalizeStats";

export const PARK_WEATHER_SPRAY_CAP = 0.45;

export function scoreParkWeatherSprayInteraction(
  inp: ParkWeatherSprayInputs | null | undefined,
): LogOddsTerm {
  if (!inp) return { key: "parkWeatherSpray", logOdds: 0, available: false, shrinkWeight: 0 };

  const parts: Array<{ value: number; weight: number; key: string }> = [];

  // Park HR factor: prefer handedness-specific. Mid = 1.0 (neutral).
  const parkFactor = inp.parkHrFactorHand ?? inp.parkHrFactor;
  if (parkFactor != null && Number.isFinite(parkFactor)) {
    parts.push({ value: signed(parkFactor, 0.82, 1.0, 1.30), weight: 3, key: "parkFactor" });
  }

  const pullGate = inp.batterPullAirShare != null ? clamp01(inp.batterPullAirShare / 0.45) : 0.5;

  if (
    inp.pullFenceDistanceFt != null &&
    inp.avgFenceDistanceFt != null &&
    Number.isFinite(inp.pullFenceDistanceFt) &&
    Number.isFinite(inp.avgFenceDistanceFt)
  ) {
    const distanceAdvantageFt = inp.avgFenceDistanceFt - inp.pullFenceDistanceFt;
    const distanceFit = signed(distanceAdvantageFt, -35, 0, 45) * (0.35 + 0.65 * pullGate);
    parts.push({ value: clamp(distanceFit, -1, 1), weight: 1.8, key: "fenceDistance" });
  }
  if (
    inp.pullFenceHeightFt != null &&
    inp.avgFenceHeightFt != null &&
    Number.isFinite(inp.pullFenceHeightFt) &&
    Number.isFinite(inp.avgFenceHeightFt)
  ) {
    const heightAdvantageFt = inp.avgFenceHeightFt - inp.pullFenceHeightFt;
    const heightFit = signed(heightAdvantageFt, -18, 0, 14) * (0.35 + 0.65 * pullGate);
    parts.push({ value: clamp(heightFit, -1, 1), weight: 0.7, key: "fenceHeight" });
  }

  // Whole-park HR distance requirement is a small physical sanity check. Lower
  // required distance is favorable, so invert a normal increasing signed map.
  if (inp.avgHrDistanceFt != null && Number.isFinite(inp.avgHrDistanceFt)) {
    parts.push({ value: -signed(inp.avgHrDistanceFt, 370, 382, 398), weight: 0.7, key: "avgHrDistance" });
  }

  if (!inp.isIndoors && inp.weatherAvailable && inp.windSpeedMph != null && inp.windDirection) {
    const speed = clamp(inp.windSpeedMph, 0, 25);
    const speedNorm = clamp01(speed / 18);
    let windSigned = 0;
    if (inp.windDirection === "out") windSigned = +speedNorm * (0.5 + 0.5 * pullGate);
    else if (inp.windDirection === "in") windSigned = -speedNorm;
    parts.push({ value: clamp(windSigned, -1, 1), weight: 2, key: "wind" });
  }

  if (inp.weatherAvailable && inp.temperatureF != null && !inp.isIndoors) {
    parts.push({ value: signed(inp.temperatureF, 50, 72, 92), weight: 1, key: "temperature" });
  }

  if (parts.length === 0) {
    return { key: "parkWeatherSpray", logOdds: 0, available: false, shrinkWeight: 0 };
  }

  let sum = 0;
  let wsum = 0;
  for (const p of parts) {
    sum += p.value * p.weight;
    wsum += p.weight;
  }
  const composite = clamp(sum / wsum, -1, 1);
  const logOdds = PARK_WEATHER_SPRAY_CAP * composite;

  return {
    key: "parkWeatherSpray",
    logOdds,
    available: true,
    shrinkWeight: 1,
    note: `parts=${parts.map((p) => p.key).join(",")} composite=${composite.toFixed(2)}`,
  };
}
