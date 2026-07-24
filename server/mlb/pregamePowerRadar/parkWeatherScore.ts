// Component 4 — Park / Weather (weight 0.14).
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

/** Plain-English carry display contract (UI renders verbatim — never re-derives). */
export type CarryType = "boost" | "suppress" | "neutral" | "unknown";
export type CarryLabel =
  | "HR Carry"
  | "Carry Boost"
  | "Carry Suppressed"
  | "Neutral Air"
  | "Neutral Conditions"
  // "unknown" — used only when weather is genuinely unavailable. Distinct from
  // "Neutral Conditions", which asserts the conditions are *known* to be neutral.
  | "Conditions Unavailable";

export interface ParkWeatherResult extends ComponentScore {
  /** True when the only positive contribution came from the park factor. */
  parkIsOnlyPositiveDriver: boolean;
  /** Server-owned plain-English carry label (display contract). */
  carryLabel: CarryLabel;
  /** Server-owned carry direction — the client must NOT infer this from wind. */
  carryType: CarryType;
  /** Optional concise evidence string for the dominant park/weather effect. */
  carryDriverText: string | null;
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

  // ── Carry classification (display-only) ──────────────────────────────────────
  // Maps the SAME already-computed sub-scores into a plain-English carry label so
  // the UI never re-derives carry from raw wind/temp. Does NOT touch score10 — the
  // modifier weights above are unchanged. No-op (Neutral Conditions) when weather
  // data is absent so partial data never fabricates a carry claim.
  let carryType: CarryType = "neutral";
  let carryLabel: CarryLabel = "Neutral Conditions";
  let carryDriverText: string | null = null;

  if (inputs.isIndoors) {
    // Roof closed is a *known* controlled environment — genuinely neutral air.
    carryType = "neutral";
    carryLabel = "Neutral Conditions";
    carryDriverText = "Roof closed — neutral air";
  } else if (!inputs.weatherAvailable) {
    // We do NOT know the conditions — never assert "neutral" here.
    carryType = "unknown";
    carryLabel = "Conditions Unavailable";
  } else {
    const windOut = inputs.windDirection === "out" && sWind != null;
    const mildWindOut = windOut && sWind! >= 6.5;
    const strongWindOut = windOut && sWind! >= 7.5;
    const windInStrong = inputs.windDirection === "in" && sWind != null && sWind <= 3.5;
    const warm = sTemp != null && sTemp >= 7;
    const hot = sTemp != null && sTemp >= 8.5;
    const cold = sTemp != null && sTemp <= 3;

    if (cold || windInStrong) {
      carryType = "suppress";
      carryLabel = "Carry Suppressed";
      carryDriverText = windInStrong
        ? `Wind suppressing carry (${inputs.windSpeed} mph in)`
        : `Cold air suppressing carry (${inputs.temperature}°F)`;
    } else if (strongWindOut || (mildWindOut && warm) || hot) {
      carryType = "boost";
      carryLabel = "HR Carry";
      carryDriverText = windOut
        ? `Wind out boosting carry (${inputs.windSpeed} mph out)`
        : `Warm air carry (${inputs.temperature}°F)`;
    } else if (mildWindOut || warm) {
      carryType = "boost";
      carryLabel = "Carry Boost";
      carryDriverText = windOut
        ? `Wind out to the field (${inputs.windSpeed} mph)`
        : `Warm air carry (${inputs.temperature}°F)`;
    } else {
      carryType = "neutral";
      carryLabel = "Neutral Air";
    }
  }

  return {
    score10: round1(score),
    available: sPark != null,
    drivers,
    warnings,
    parkIsOnlyPositiveDriver,
    carryLabel,
    carryType,
    carryDriverText,
  };
}
