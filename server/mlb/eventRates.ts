import type { MLBPropInput, ProjectionSource, ProjectionQuality } from "./types";
import { getPitchFamily } from "./pitchTypeNormalizer";

const LEAGUE_AVG_BA = 0.248;
const LEAGUE_AVG_SLG = 0.400;
const LEAGUE_AVG_HR_RATE = 0.033;
const LEAGUE_AVG_K_PER_BF = 0.224;

const MLB_HIT_TYPE_SPLITS = {
  single: 0.64,
  double: 0.20,
  triple: 0.02,
  homeRun: 0.14,
};

export function computeHitRate(input: MLBPropInput): number {
  const playerAB = input.atBats > 0 ? input.atBats : input.completedAB;
  const currentHits = input.currentStatValue ?? 0;

  let playerRate = playerAB > 0 ? currentHits / playerAB : LEAGUE_AVG_BA;
  let baseRate = playerRate * 0.55 + LEAGUE_AVG_BA * 0.45;

  if (input.seasonAvg > 0) {
    baseRate = input.seasonAvg * 0.50 + baseRate * 0.50;
  }

  if (input.contactQuality.xBA != null && input.contactQuality.xBA > 0) {
    const xbaDelta = input.contactQuality.xBA - LEAGUE_AVG_BA;
    const abWeight = Math.min(1.0, playerAB / 40);
    baseRate *= 1 + xbaDelta * abWeight * 0.40;
  }

  const pitcherKRate = input.pitcher.kPer9 != null ? input.pitcher.kPer9 / (9 * 4.3) : LEAGUE_AVG_K_PER_BF;
  const pitcherBABIP = 0.296;
  baseRate *= 1 - (pitcherKRate * 0.25) + ((pitcherBABIP - 0.296) * 0.40);

  if (input.pitcher.era != null && input.pitcher.era > 0) {
    const eraSurface = (input.pitcher.era - 4.15) * 0.015;
    baseRate *= 1 + Math.max(-0.06, Math.min(0.06, eraSurface));
  }

  baseRate *= input.weatherPark.parkFactor;

  if (!input.weatherPark.isIndoors) {
    const windOut = input.weatherPark.windDirection === "out";
    const temp = input.weatherPark.temperature ?? 70;
    baseRate *= 1 + (windOut ? 0.015 : 0) + ((temp - 70) * 0.002);
  }

  if (input.bullpen.bullpenEra != null && input.bullpen.bullpenEra > 0) {
    const bullpenFactor = Math.max(0.94, Math.min(1.06, 4.15 / input.bullpen.bullpenEra));
    baseRate *= bullpenFactor;
  }

  if (input.batterHand && input.pitcher.throws) {
    const platoonAdv = input.batterHand !== input.pitcher.throws;
    if (platoonAdv) baseRate *= 1.03;
    else baseRate *= 0.97;
  }

  const hardHit = input.contactQuality.hardHitRateSeason;
  if (hardHit != null && hardHit > 0) {
    const hhDelta = hardHit - 0.35;
    baseRate *= 1 + hhDelta * 0.15;
  }

  if (input.pitcher.timesThrough >= 3) {
    baseRate *= 1.04;
  } else if (input.pitcher.pitchCount > 80) {
    baseRate *= 1.02;
  }

  return Math.max(0.08, Math.min(0.50, baseRate));
}

export function computeHitTypeDistribution(input: MLBPropInput): {
  pSingle: number;
  pDouble: number;
  pTriple: number;
  pHR: number;
} {
  let { single, double, triple, homeRun } = { ...MLB_HIT_TYPE_SPLITS };

  const barrel = input.contactQuality.barrelRateProxySeason ?? 0.06;
  const hardHit = input.contactQuality.hardHitRateSeason ?? 0.35;

  const powerFactor = Math.min(1.5, (barrel / 0.08) * 0.5 + (hardHit / 0.40) * 0.5);

  homeRun *= powerFactor;
  double *= 0.7 + powerFactor * 0.3;
  triple *= 0.8 + powerFactor * 0.2;

  if (input.contactQuality.xSLG != null && input.contactQuality.xSLG > 0) {
    const xslgRatio = input.contactQuality.xSLG / LEAGUE_AVG_SLG;
    homeRun *= Math.max(0.7, Math.min(1.5, xslgRatio));
    double *= Math.max(0.85, Math.min(1.2, xslgRatio));
  }

  if (input.weatherPark.parkFactor > 1.0) {
    const parkBoost = (input.weatherPark.parkFactor - 1.0) * 2;
    homeRun *= 1 + parkBoost;
    double *= 1 + parkBoost * 0.5;
  }

  if (!input.weatherPark.isIndoors && input.weatherPark.windDirection === "out") {
    homeRun *= 1.06;
    double *= 1.03;
  }

  if (input.pitcher.era != null && input.pitcher.era > 4.5) {
    homeRun *= 1.05;
  }

  const sum = single + double + triple + homeRun;
  return {
    pSingle: single / sum,
    pDouble: double / sum,
    pTriple: triple / sum,
    pHR: homeRun / sum,
  };
}

export function computeKRatePerBF(input: MLBPropInput): number {
  const baseKRate = input.pitcher.kPer9 != null ? input.pitcher.kPer9 / (9 * 4.3) : LEAGUE_AVG_K_PER_BF;

  let adjustedK = baseKRate;

  if (input.pitcher.whip != null && input.pitcher.whip > 0) {
    const commandFactor = Math.max(0.9, Math.min(1.1, 1.30 / input.pitcher.whip));
    adjustedK *= commandFactor * 0.3 + 0.7;
  }

  if (input.pitcher.timesThrough >= 3) {
    adjustedK *= 0.88;
  } else if (input.pitcher.timesThrough === 2) {
    adjustedK *= 0.95;
  }

  if (input.pitcher.pitchCount > 90) {
    adjustedK *= 0.85;
  } else if (input.pitcher.pitchCount > 75) {
    adjustedK *= 0.92;
  }

  if (input.pitcher.isPitcherCollapsing) {
    adjustedK *= 0.80;
  }

  if (input.pitcher.managerLeashShort) {
    adjustedK *= 0.90;
  }

  const oppContactQuality = input.contactQuality.hardHitRateSeason ?? 0.35;
  const oppKTendency = 1 - oppContactQuality;
  adjustedK *= 0.7 + 0.3 * (oppKTendency / 0.65);

  if (input.pitcher.pitchMix && input.pitcher.pitchMix.length > 0) {
    const whiffPitches = input.pitcher.pitchMix.filter(p => {
      const fam = getPitchFamily(p.pitchType);
      return fam === "breaking" || fam === "offspeed";
    });
    const whiffPct = whiffPitches.reduce((s, p) => s + p.percentage, 0);
    if (whiffPct > 40) adjustedK *= 1.04;
    else if (whiffPct < 20) adjustedK *= 0.96;
  }

  return Math.max(0.08, Math.min(0.45, adjustedK));
}

export function computeHRRatePerPA(input: MLBPropInput): number {
  const barrel = input.contactQuality.barrelRateProxySeason ?? 0.06;
  const hardHit = input.contactQuality.hardHitRateSeason ?? 0.35;

  let baseHR = input.seasonAvg > 0 && input.seasonAvg < 0.15
    ? input.seasonAvg
    : LEAGUE_AVG_HR_RATE;

  const barrelPower = Math.min(2.0, barrel / 0.06);
  baseHR *= 0.5 + 0.5 * barrelPower;

  const hhPower = Math.min(1.5, hardHit / 0.35);
  baseHR *= 0.6 + 0.4 * hhPower;

  const ev = input.contactQuality.exitVelocity;
  if (ev != null && ev > 0) {
    if (ev >= 100) baseHR *= 1.15;
    else if (ev >= 95) baseHR *= 1.05;
    else if (ev < 88) baseHR *= 0.85;
  }

  const la = input.contactQuality.launchAngle;
  if (la != null) {
    if (la >= 20 && la <= 35) baseHR *= 1.10;
    else if (la < 10 || la > 45) baseHR *= 0.75;
  }

  if (input.contactQuality.xSLG != null && input.contactQuality.xSLG > 0) {
    const xslgFactor = input.contactQuality.xSLG / LEAGUE_AVG_SLG;
    baseHR *= Math.max(0.7, Math.min(1.5, xslgFactor));
  }

  if (input.pitcher.era != null && input.pitcher.era > 4.5) {
    baseHR *= 1.08;
  }

  baseHR *= input.weatherPark.parkFactor;

  if (!input.weatherPark.isIndoors) {
    if (input.weatherPark.windDirection === "out" && (input.weatherPark.windSpeed ?? 0) >= 8) {
      baseHR *= 1.08;
    }
    const temp = input.weatherPark.temperature ?? 70;
    if (temp >= 85) baseHR *= 1.04;
    else if (temp <= 50) baseHR *= 0.92;
  }

  if (input.batterHand && input.pitcher.throws && input.batterHand !== input.pitcher.throws) {
    baseHR *= 1.05;
  }

  // Conditional upside: when multiple elite signals stack (high EV + ideal LA + HR-friendly
  // park + platoon edge + weak/fading pitcher), allow projection to climb to 0.18/PA.
  // Otherwise retain conservative 0.12 cap.
  const evSafe = input.contactQuality.exitVelocity ?? 0;
  const laSafe = input.contactQuality.launchAngle ?? 0;
  const isElitePower =
    (evSafe >= 95) &&
    (laSafe >= 18 && laSafe <= 36) &&
    (input.weatherPark.parkFactor >= 1.02) &&
    (input.batterHand && input.pitcher.throws && input.batterHand !== input.pitcher.throws) &&
    ((input.pitcher.era ?? 0) > 4.5 ||
      (input.weatherPark.windDirection === "out" && (input.weatherPark.windSpeed ?? 0) >= 8));

  const cap = isElitePower ? 0.18 : 0.12;
  return Math.max(0.01, Math.min(cap, baseHR));
}

export function determineProjectionSource(input: MLBPropInput): ProjectionSource {
  const hasLiveContact = input.contactQuality.exitVelocity != null ||
    input.contactQuality.priorABResults.length > 0;
  const hasGameState = input.completedAB > 0;
  const hasSeasonData = input.seasonAvg > 0;

  if (hasLiveContact && hasGameState && hasSeasonData) return "engine_live_context";
  if (hasGameState && hasSeasonData) return "engine_live_plus_baseline";
  if (hasSeasonData) return "baseline_only";
  return "fallback_static";
}

export function determineProjectionQuality(
  source: ProjectionSource,
  input: MLBPropInput,
): ProjectionQuality {
  if (source === "fallback_static") return "LOW";

  const hasContactData = input.contactQuality.exitVelocity != null ||
    input.contactQuality.hardHitRateSeason != null;
  const hasPitcherData = input.pitcher.kPer9 != null && input.pitcher.era != null;
  const hasWeatherData = input.weatherPark.temperature != null;

  let score = 0;
  if (source === "engine_live_context") score += 3;
  else if (source === "engine_live_plus_baseline") score += 2;
  else score += 1;

  if (hasContactData) score += 2;
  if (hasPitcherData) score += 1;
  if (hasWeatherData) score += 1;
  if (input.completedAB >= 2) score += 1;

  if (score >= 6) return "HIGH";
  if (score >= 3) return "MEDIUM";
  return "LOW";
}

export function computeTrustScore(
  quality: ProjectionQuality,
  source: ProjectionSource,
  fallbackUsed: boolean,
): number {
  let base = 0.5;

  if (quality === "HIGH") base = 0.90;
  else if (quality === "MEDIUM") base = 0.70;
  else base = 0.40;

  if (source === "engine_live_context") base *= 1.0;
  else if (source === "engine_live_plus_baseline") base *= 0.95;
  else if (source === "baseline_only") base *= 0.80;
  else base *= 0.50;

  if (fallbackUsed) base *= 0.60;

  return Math.max(0.10, Math.min(1.0, Math.round(base * 100) / 100));
}
