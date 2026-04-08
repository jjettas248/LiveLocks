import type { MLBPropInput } from "./types";

export type HRIntensity = "weak" | "watch" | "strong" | "imminent";

export type HRContactClass =
  | "noiseContact"
  | "powerContact"
  | "hrShapedContact"
  | "missedHrContact"
  | "eliteHrContact";

export interface ClassifiedContact {
  contactClass: HRContactClass;
  exitVelocity: number;
  launchAngle: number;
  distance: number;
  outcome: string;
  isBarrel: boolean;
}

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
    hrShapedCount: number;
    missedHrCount: number;
    eliteHrCount: number;
    qualifiedEVMean: number | null;
    maxDistance: number | null;
    contactClasses: ClassifiedContact[];
  };
}

const EV_BARREL_THRESHOLD = 98;
const EV_HARD_HIT_THRESHOLD = 95;
const LA_SWEET_SPOT_LOW = 20;
const LA_SWEET_SPOT_HIGH = 35;
const DEEP_FLY_DISTANCE = 350;

export function classifyContactEvent(ab: {
  exitVelocity: number | null;
  launchAngle: number | null;
  distance: number | null;
  outcome: string;
}): ClassifiedContact {
  const ev = ab.exitVelocity ?? 0;
  const la = ab.launchAngle ?? 0;
  const dist = ab.distance ?? 0;
  const isBarrel = ev >= EV_BARREL_THRESHOLD && la >= LA_SWEET_SPOT_LOW && la <= LA_SWEET_SPOT_HIGH;

  let contactClass: HRContactClass = "noiseContact";

  if (ev >= 102 && la >= 23 && la <= 34 && dist >= 390) {
    contactClass = "eliteHrContact";
  } else if (ev >= 100 && la >= 24 && la <= 36 && dist >= 370) {
    contactClass = "missedHrContact";
  } else if (ev >= 96 && la >= 18 && la <= 40 && dist >= 340) {
    contactClass = "hrShapedContact";
  } else if (ev >= 95) {
    contactClass = "powerContact";
  }

  return {
    contactClass,
    exitVelocity: ev,
    launchAngle: la,
    distance: dist,
    outcome: ab.outcome ?? "out",
    isBarrel,
  };
}

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

  const classified = priorABs.map(ab => classifyContactEvent(ab));

  const hrShapedEvents = classified.filter(c =>
    c.contactClass === "hrShapedContact" ||
    c.contactClass === "missedHrContact" ||
    c.contactClass === "eliteHrContact"
  );
  const missedHrEvents = classified.filter(c => c.contactClass === "missedHrContact");
  const eliteHrEvents = classified.filter(c => c.contactClass === "eliteHrContact");
  const powerEvents = classified.filter(c => c.contactClass === "powerContact");

  const hrShapedCount = hrShapedEvents.length;
  const missedHrCount = missedHrEvents.length;
  const eliteHrCount = eliteHrEvents.length;

  const evValues = classified
    .filter(c => c.exitVelocity > 0)
    .map(c => c.exitVelocity);
  const laValues = classified
    .filter(c => c.launchAngle !== 0 || c.exitVelocity > 0)
    .map(c => c.launchAngle);

  const avgEV = evValues.length > 0 ? evValues.reduce((s, v) => s + v, 0) / evValues.length : null;
  const maxEV = evValues.length > 0 ? Math.max(...evValues) : null;
  const avgLA = laValues.length > 0 ? laValues.reduce((s, v) => s + v, 0) / laValues.length : null;

  const qualifiedEVs = hrShapedEvents.map(e => e.exitVelocity);
  const qualifiedEVMean = qualifiedEVs.length > 0
    ? qualifiedEVs.reduce((s, v) => s + v, 0) / qualifiedEVs.length
    : null;

  const allDistances = classified.filter(c => c.distance > 0).map(c => c.distance);
  const maxDistance = allDistances.length > 0 ? Math.max(...allDistances) : null;

  const barrels = classified.filter(c => c.isBarrel).length;
  const hardHits = classified.filter(c => c.exitVelocity >= EV_HARD_HIT_THRESHOLD).length;

  const deepFlyouts = classified.filter(c =>
    (c.outcome === "out" || c.outcome === "other") &&
    ((c.distance >= DEEP_FLY_DISTANCE && c.launchAngle >= 20) ||
     (c.distance === 0 && c.launchAngle >= 20 && c.exitVelocity >= 95))
  ).length;

  score += eliteHrCount * 3.0;
  score += missedHrCount * 2.5;
  score += (hrShapedCount - missedHrCount - eliteHrCount) * 1.8;

  score += powerEvents.length * 0.5;

  const perABxBAs = priorABs
    .map((ab: any) => ab.perABxBA as number | null | undefined)
    .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  if (perABxBAs.length > 0) {
    const maxXBA = Math.max(...perABxBAs);
    const avgXBA = perABxBAs.reduce((a, b) => a + b, 0) / perABxBAs.length;
    if (maxXBA >= 0.800) score += 1.5;
    else if (maxXBA >= 0.600) score += 0.8;
    if (avgXBA >= 0.500) score += 1.0;
    else if (avgXBA >= 0.350) score += 0.4;
  }

  if (qualifiedEVMean !== null && qualifiedEVMean >= 99) {
    score += 1.0;
  } else if (avgEV !== null && avgEV >= 100) {
    score += 0.8;
  } else if (avgEV !== null && avgEV >= 95) {
    score += 0.3;
  }

  if (maxEV !== null) {
    if (maxEV >= 110) score += 1.0;
    else if (maxEV >= 105) score += 0.5;
  }

  if (maxDistance !== null) {
    if (maxDistance >= 400) score += 1.0;
    else if (maxDistance >= 380) score += 0.5;
    else if (maxDistance >= 360) score += 0.2;
  }

  if (avgLA !== null && avgLA >= LA_SWEET_SPOT_LOW && avgLA <= LA_SWEET_SPOT_HIGH) {
    score += 0.5;
  }

  const seasonBarrel = input.contactQuality.barrelRateProxySeason ?? 0.06;
  const batSpeedScore = Math.min(1.0, (seasonBarrel / 0.06 - 1) * 1.0);
  if (batSpeedScore > 0) score += batSpeedScore;

  let pitcherFatigueBoost = 0;
  if (input.pitcher.pitchCount >= 90) {
    pitcherFatigueBoost = 0.8;
  } else if (input.pitcher.pitchCount >= 75) {
    pitcherFatigueBoost = 0.4;
  }
  if (input.pitcher.timesThrough >= 3) {
    pitcherFatigueBoost += 0.4;
  }
  if (input.pitcher.isPitcherCollapsing) {
    pitcherFatigueBoost += 0.6;
  }
  score += pitcherFatigueBoost;

  let parkWindBoost = 0;
  if (input.weatherPark.parkFactor >= 1.10) {
    parkWindBoost += 0.4;
  }
  if (!input.weatherPark.isIndoors &&
      input.weatherPark.windDirection === "out" &&
      (input.weatherPark.windSpeed ?? 0) >= 8) {
    parkWindBoost += 0.4;
  }
  const temp = input.weatherPark.temperature ?? 70;
  if (temp >= 85) parkWindBoost += 0.2;

  if (!input.weatherPark.isIndoors &&
      input.weatherPark.windDirection === "in" &&
      (input.weatherPark.windSpeed ?? 0) >= 10) {
    parkWindBoost -= 0.3;
  }
  if (temp <= 45) parkWindBoost -= 0.2;
  score += parkWindBoost;

  let platoonBoost = 0;
  if (input.batterHand && input.pitcher.throws && input.batterHand !== input.pitcher.throws) {
    platoonBoost = 0.25;
    score += platoonBoost;
  }

  const era = input.pitcher.era;
  if (era !== null && era >= 5.0) {
    score += 0.4;
  }

  const lei = input.liveInterpretation;
  if (lei) {
    if (lei.nearHrScore > 0.04) score += lei.nearHrScore * 8;
    if (lei.momentumScore > 0.03) score += lei.momentumScore * 4;
    if (lei.veloDropScore > 0.03) score += lei.veloDropScore * 3;
  }

  const hotHitterBoost = input.hotHitterBoost ?? 0;
  score += hotHitterBoost;

  const bvpHrBoost = input.bvpHrBoost ?? 0;
  score += bvpHrBoost;

  const hrTrend = input.hrTrend;
  if (hrTrend) {
    const abSince = hrTrend.abSinceLastHR;
    const seasonRate = hrTrend.seasonTotalAB > 0 ? hrTrend.seasonTotalHR / hrTrend.seasonTotalAB : 0;
    if (abSince != null && seasonRate > 0) {
      const expectedABperHR = 1 / seasonRate;
      if (abSince >= expectedABperHR * 2.0) {
        score += 0.6;
      } else if (abSince >= expectedABperHR * 1.5) {
        score += 0.3;
      }
    }
    const hrL7 = hrTrend.hrRateLast7;
    const hrL30 = hrTrend.hrRateLast30;
    if (hrL7 != null && hrL30 != null && hrL30 > 0 && hrL7 > hrL30 * 1.5) {
      score += 0.3;
    }
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
      hrShapedCount,
      missedHrCount,
      eliteHrCount,
      qualifiedEVMean: qualifiedEVMean !== null ? Math.round(qualifiedEVMean * 10) / 10 : null,
      maxDistance: maxDistance !== null ? Math.round(maxDistance) : null,
      contactClasses: classified,
    },
  };
}
