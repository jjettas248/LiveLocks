// Component 4 — Park / Weather (weight 0.15).
//
// Pure scorer over park HR factor + weather (temp, wind, roof). Park alone can
// never surface a signal (the build layer flags "park is only positive driver"
// and caps). Neutral + warning when weather data is missing — never fabricated.

import type { ComponentScore, PowerDriver } from "./types";
import { lin, weightedAvg, round1 } from "./scoreUtils";

export interface ParkWeatherInputs {
  /** Market park factor (1.0 = neutral; >1 favors hitters). */
  parkHrFactor: number | null;
  isIndoors: boolean;
  weatherAvailable: boolean;
  temperature: number | null; // °F
  windSpeed: number | null; // mph
  windDirection: "in" | "out" | "cross" | "calm" | null;
}

export interface ParkWeatherResult extends ComponentScore {
  /** True when the only positive contribution came from the park factor. */
  parkIsOnlyPositiveDriver: boolean;
}

export function computeParkWeatherScore(inputs: ParkWeatherInputs): ParkWeatherResult {
  const drivers: PowerDriver[] = [];
  const warnings: string[] = [];

  const sPark = inputs.parkHrFactor != null ? lin(inputs.parkHrFactor, 0.85, 1.25) : null;

  let sWind: number | null = null;
  let sTemp: number | null = null;
  let weatherPositive = false;

  if (inputs.isIndoors) {
    // Roof neutralizes wind/temp — park factor still applies.
    sWind = 5;
    sTemp = 5;
    drivers.push({ key: "pw_roof", label: "Roof Closed (Neutral Air)", direction: "neutral", weight: 10 });
  } else if (inputs.weatherAvailable) {
    if (inputs.windSpeed != null && inputs.windDirection != null) {
      if (inputs.windDirection === "out") {
        sWind = lin(inputs.windSpeed, 4, 18);
        if (sWind >= 6.5) { weatherPositive = true; drivers.push({ key: "pw_wind_out", label: "Wind Blowing Out", direction: "positive", weight: Math.round(sWind * 10), evidence: `${inputs.windSpeed} mph out` }); }
      } else if (inputs.windDirection === "in") {
        sWind = 10 - lin(inputs.windSpeed, 4, 18);
        if (sWind <= 3.5) drivers.push({ key: "pw_wind_in", label: "Wind Blowing In", direction: "negative", weight: 30, evidence: `${inputs.windSpeed} mph in` });
      } else {
        sWind = 5;
      }
    }
    if (inputs.temperature != null) {
      sTemp = lin(inputs.temperature, 55, 88);
      if (sTemp >= 7) { weatherPositive = true; drivers.push({ key: "pw_temp", label: "Warm Air Carry", direction: "positive", weight: Math.round(sTemp * 10), evidence: `${inputs.temperature}°F` }); }
      else if (sTemp <= 3) drivers.push({ key: "pw_cold", label: "Cold Air Suppresses", direction: "negative", weight: 25, evidence: `${inputs.temperature}°F` });
    }
  } else {
    warnings.push("Weather data unavailable — park factor only");
  }

  if (sPark != null && sPark >= 6.5) {
    drivers.push({ key: "pw_park", label: "Hitter-Friendly Park", direction: "positive", weight: Math.round(sPark * 10), evidence: `park HR factor ${inputs.parkHrFactor?.toFixed(2)}` });
  } else if (sPark != null && sPark <= 3.5) {
    drivers.push({ key: "pw_park_pitcher", label: "Pitcher-Friendly Park", direction: "negative", weight: 25 });
  }

  const { score } = weightedAvg([
    { value: sPark, weight: 3 },
    { value: sWind, weight: 2 },
    { value: sTemp, weight: 2 },
  ]);

  const parkPositive = sPark != null && sPark >= 6.5;
  const parkIsOnlyPositiveDriver = parkPositive && !weatherPositive;

  return { score10: round1(score), available: sPark != null, drivers, warnings, parkIsOnlyPositiveDriver };
}
