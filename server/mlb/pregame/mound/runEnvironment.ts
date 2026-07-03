// Mound Radar Component — Run Environment (weight 0.18).
//
// v1 real signal: park run factor (getVenueParkFactors — generic park lookup,
// shared infra) + weather (syncWeather cache — generic weather lookup, shared
// infra), independently coded/thresholded here (not imported from Plate's
// parkWeatherScore.ts). Framing is inverted from Plate's HR-carry-boost logic:
// for a pitcher, a RUN-SUPPRESSING park/weather is favorable.
//
// No K-specific or outs-specific park factor exists in the codebase — evidence
// text says "run-suppressing park," never claims a K-specific number.

import type { ComponentScore, MoundDriver, MoundParkContext } from "./types";
import { lin, weightedAvg, round1 } from "./scoreUtils";

export interface RunEnvironmentInputs {
  venueName: string | null;
  parkFactorRuns: number | null;
  isIndoors: boolean;
  weatherAvailable: boolean;
  temperatureF: number | null;
  windMph: number | null;
  windDirection: "in" | "out" | "cross" | "calm" | null;
}

export function computeRunEnvironment(
  inputs: RunEnvironmentInputs,
): ComponentScore & { parkContext: MoundParkContext } {
  const drivers: MoundDriver[] = [];
  const warnings: string[] = [];

  const sPark = inputs.parkFactorRuns != null ? lin(inputs.parkFactorRuns, 1.15, 0.85) : null;
  const sTemp = !inputs.isIndoors && inputs.temperatureF != null ? lin(inputs.temperatureF, 85, 55) : null;
  let sWind: number | null = null;
  if (!inputs.isIndoors && inputs.windDirection != null) {
    if (inputs.windDirection === "in") sWind = 8;
    else if (inputs.windDirection === "out") sWind = 2;
    else sWind = 5;
  }

  const { score, coverage } = weightedAvg([
    { value: sPark, weight: 3 },
    { value: sTemp, weight: 2 },
    { value: sWind, weight: 2 },
  ]);

  const suppressing = (sPark != null && sPark >= 6.5) || (sTemp != null && sTemp >= 6.5) || sWind === 8;

  // Human-readable evidence for the park row's tooltip / the hub API's
  // weatherLabel — mirrors Plate's carryDriverText contract. Picks the
  // single dominant reason so it stays a short, honest sentence rather than
  // concatenating every contributing factor.
  let driverText: string | null = null;
  if (!inputs.isIndoors) {
    if (sWind === 8) {
      driverText = `Wind blowing in${inputs.windMph != null ? ` (${Math.round(inputs.windMph)} mph)` : ""} — suppresses offense`;
    } else if (sTemp != null && sTemp >= 6.5) {
      driverText = `Cool air${inputs.temperatureF != null ? ` (${Math.round(inputs.temperatureF)}°F)` : ""} — suppresses offense`;
    } else if (sPark != null && sPark >= 6.5) {
      driverText = `Run-suppressing park${inputs.parkFactorRuns != null ? ` (factor ${round1(inputs.parkFactorRuns)})` : ""}`;
    }
  }

  let parkContext: MoundParkContext;
  if (!inputs.venueName || (!inputs.weatherAvailable && !inputs.isIndoors)) {
    parkContext = {
      venueName: inputs.venueName,
      temperatureF: null,
      windMph: null,
      windDirectionLabel: null,
      runEnvironmentLabel: "Conditions Unavailable",
      runEnvironmentType: "unknown",
    };
    warnings.push("Park/weather context unavailable");
  } else {
    parkContext = {
      venueName: inputs.venueName,
      temperatureF: inputs.temperatureF,
      windMph: inputs.windMph,
      windDirectionLabel:
        inputs.windDirection === "in" ? "In" : inputs.windDirection === "out" ? "Out" : inputs.windDirection === "cross" ? "Crosswind" : inputs.windDirection === "calm" ? "Calm" : null,
      runEnvironmentLabel: inputs.isIndoors ? "Neutral Conditions" : suppressing ? "Run Suppression" : "Neutral Air",
      runEnvironmentType: inputs.isIndoors ? "neutral" : suppressing ? "suppress" : "neutral",
      driverText,
    };
  }

  if (coverage === 0) {
    return { score10: 5, available: false, drivers, warnings, parkContext };
  }

  // Exactly ONE positive driver per independently-computed sub-signal — never
  // two chips for the same threshold crossing. A signal backed by a single
  // real number (e.g. park factor alone) must never inflate the "≥2 positive
  // drivers" publish-quality gate by being double-counted as two chips.
  if (sPark != null && sPark >= 6.5) {
    drivers.push({
      key: "re_park",
      label: "Favorable Park",
      direction: "positive",
      weight: Math.round(sPark * 10),
      evidence: inputs.parkFactorRuns != null ? `Run factor ${round1(inputs.parkFactorRuns)}` : undefined,
    });
  }
  if (sTemp != null && sTemp >= 6.5) {
    drivers.push({ key: "re_cool", label: "Cool Temps", direction: "positive", weight: Math.round(sTemp * 10), evidence: inputs.temperatureF != null ? `${inputs.temperatureF}°F` : undefined });
  }
  if (sWind === 8) {
    drivers.push({ key: "re_wind_in", label: "Wind In", direction: "positive", weight: 70 });
  }
  // Park+temp both favorable is genuinely distinct compounding evidence (not
  // a restatement of re_park/re_cool above) — worth exactly one additional
  // driver, not two.
  if (sPark != null && sTemp != null && sPark >= 6 && sTemp >= 6) {
    drivers.push({ key: "re_low_run_env", label: "Low Run Environment", direction: "positive", weight: 60 });
  }

  return { score10: round1(score), available: true, drivers, warnings, parkContext };
}
