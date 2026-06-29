// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: park + weather + spray fit → log-odds term
//
// Pure. Combines the park HR factor (handedness-specific when available), wind
// (gated by indoor state and modulated by the batter's pull-air share), and
// temperature (air density / carry). Pre-game forecast only — never live wind.
// Rewards matching handedness/spray/wind fit; suppresses poor fit.
// ─────────────────────────────────────────────────────────────────────────────

import type { ParkWeatherSprayInputs, LogOddsTerm } from "./mathTypes";
import { signed, clamp, clamp01 } from "./normalizeStats";

export const PARK_WEATHER_SPRAY_CAP = 0.45;

export function scoreParkWeatherSprayInteraction(
  inp: ParkWeatherSprayInputs | null | undefined,
): LogOddsTerm {
  if (!inp) return { key: "parkWeatherSpray", logOdds: 0, available: false, shrinkWeight: 0 };

  const parts: Array<{ value: number; weight: number }> = [];

  // Park HR factor: prefer handedness-specific. Mid = 1.0 (neutral).
  const parkFactor = inp.parkHrFactorHand ?? inp.parkHrFactor;
  if (parkFactor != null && Number.isFinite(parkFactor)) {
    parts.push({ value: signed(parkFactor, 0.82, 1.0, 1.30), weight: 3 });
  }

  // Wind — only outdoors and only with usable speed/direction.
  if (!inp.isIndoors && inp.weatherAvailable && inp.windSpeedMph != null && inp.windDirection) {
    const speed = clamp(inp.windSpeedMph, 0, 25);
    const speedNorm = clamp01(speed / 18); // ~18mph ≈ full effect
    // Pull-air hitters benefit more from a wind blowing out; gate by pull-air share.
    const pullGate = inp.batterPullAirShare != null ? clamp01(inp.batterPullAirShare) : 0.5;
    let windSigned = 0;
    if (inp.windDirection === "out") windSigned = +speedNorm * (0.5 + 0.5 * pullGate);
    else if (inp.windDirection === "in") windSigned = -speedNorm;
    else windSigned = 0; // cross / calm → neutral
    parts.push({ value: clamp(windSigned, -1, 1), weight: 2 });
  }

  // Temperature — warmer air carries. Mid ~72°F. Outdoors only meaningfully.
  if (inp.weatherAvailable && inp.temperatureF != null && !inp.isIndoors) {
    parts.push({ value: signed(inp.temperatureF, 50, 72, 92), weight: 1 });
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
    note: `parts=${parts.length} composite=${composite.toFixed(2)}`,
  };
}
