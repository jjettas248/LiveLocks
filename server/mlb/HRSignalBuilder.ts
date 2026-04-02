import type { MLBPropInput } from "./types";

export type HRIntensity = "weak" | "watch" | "strong" | "imminent";

export interface HRBuildResult {
  score: number;
  intensity: HRIntensity;
  boost: number;
  factors: {
    avgEV: number | null;
    maxEV: number | null;
    avgLA: number | null;
    barrels: number;
    hardHits: number;
    deepFlyouts: number;
    batSpeedScore: number;
    pitcherFatigueBoost: number;
    parkWindBoost: number;
    platoonBoost: number;
  };
}

const EV_BARREL_THRESHOLD = 98;
const EV_HARD_HIT_THRESHOLD = 95;
const LA_SWEET_SPOT_LOW = 20;
const LA_SWEET_SPOT_HIGH = 35;

function classifyIntensity(score: number): HRIntensity {
  if (score >= 7.5) return "imminent";
  if (score >= 5.0) return "strong";
  if (score >= 2.5) return "watch";
  return "weak";
}

function computeEdgeBoost(score: number): number {
  if (score >= 7.5) return 4.0;
  if (score >= 5.0) return 2.5;
  if (score >= 2.5) return 1.0;
  return 0;
}

export function buildHRSignal(input: MLBPropInput): HRBuildResult {
  let score = 0;
  const priorABs = input.contactQuality.priorABResults ?? [];

  const evValues = priorABs
    .map(ab => ab.exitVelocity)
    .filter((v): v is number => v != null && v > 0);

  const laValues = priorABs
    .map(ab => ab.launchAngle)
    .filter((v): v is number => v != null);

  const avgEV = evValues.length > 0 ? evValues.reduce((s, v) => s + v, 0) / evValues.length : null;
  const maxEV = evValues.length > 0 ? Math.max(...evValues) : null;
  const avgLA = laValues.length > 0 ? laValues.reduce((s, v) => s + v, 0) / laValues.length : null;

  const barrels = priorABs.filter(ab =>
    (ab.exitVelocity ?? 0) >= EV_BARREL_THRESHOLD &&
    (ab.launchAngle ?? 0) >= LA_SWEET_SPOT_LOW &&
    (ab.launchAngle ?? 0) <= LA_SWEET_SPOT_HIGH
  ).length;

  const hardHits = priorABs.filter(ab => (ab.exitVelocity ?? 0) >= EV_HARD_HIT_THRESHOLD).length;

  const deepFlyouts = priorABs.filter(ab =>
    ab.outcome === "out" || ab.outcome === "other"
  ).filter(ab =>
    (ab.launchAngle ?? 0) >= 20 && (ab.exitVelocity ?? 0) >= 95
  ).length;

  score += hardHits * 0.5;

  if (avgEV !== null) {
    if (avgEV >= 100) score += 2.0;
    else if (avgEV >= 95) score += 1.2;
    else if (avgEV >= 90) score += 0.5;
  }

  if (maxEV !== null) {
    if (maxEV >= 110) score += 1.5;
    else if (maxEV >= 105) score += 1.0;
    else if (maxEV >= 100) score += 0.5;
  }

  if (avgLA !== null && avgLA >= LA_SWEET_SPOT_LOW && avgLA <= LA_SWEET_SPOT_HIGH) {
    score += 1.0;
  }

  score += barrels * 1.5;

  score += deepFlyouts * 1.0;

  const seasonBarrel = input.contactQuality.barrelRateProxySeason ?? 0.06;
  const batSpeedScore = Math.min(1.5, (seasonBarrel / 0.06 - 1) * 1.5);
  if (batSpeedScore > 0) score += batSpeedScore;

  let pitcherFatigueBoost = 0;
  if (input.pitcher.pitchCount >= 90) {
    pitcherFatigueBoost = 1.0;
  } else if (input.pitcher.pitchCount >= 75) {
    pitcherFatigueBoost = 0.5;
  }
  if (input.pitcher.timesThrough >= 3) {
    pitcherFatigueBoost += 0.5;
  }
  if (input.pitcher.isPitcherCollapsing) {
    pitcherFatigueBoost += 0.75;
  }
  score += pitcherFatigueBoost;

  let parkWindBoost = 0;
  if (input.weatherPark.parkFactor >= 1.10) {
    parkWindBoost += 0.5;
  }
  if (!input.weatherPark.isIndoors &&
      input.weatherPark.windDirection === "out" &&
      (input.weatherPark.windSpeed ?? 0) >= 8) {
    parkWindBoost += 0.5;
  }
  const temp = input.weatherPark.temperature ?? 70;
  if (temp >= 85) parkWindBoost += 0.25;
  score += parkWindBoost;

  let platoonBoost = 0;
  if (input.batterHand && input.pitcher.throws && input.batterHand !== input.pitcher.throws) {
    platoonBoost = 0.3;
    score += platoonBoost;
  }

  const era = input.pitcher.era;
  if (era !== null && era >= 5.0) {
    score += 0.5;
  }

  const finalScore = Math.min(10, Math.max(0, score));

  return {
    score: Math.round(finalScore * 100) / 100,
    intensity: classifyIntensity(finalScore),
    boost: computeEdgeBoost(finalScore),
    factors: {
      avgEV: avgEV !== null ? Math.round(avgEV * 10) / 10 : null,
      maxEV: maxEV !== null ? Math.round(maxEV * 10) / 10 : null,
      avgLA: avgLA !== null ? Math.round(avgLA * 10) / 10 : null,
      barrels,
      hardHits,
      deepFlyouts,
      batSpeedScore: Math.round(Math.max(0, batSpeedScore) * 100) / 100,
      pitcherFatigueBoost: Math.round(pitcherFatigueBoost * 100) / 100,
      parkWindBoost: Math.round(parkWindBoost * 100) / 100,
      platoonBoost: Math.round(platoonBoost * 100) / 100,
    },
  };
}
