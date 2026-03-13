import type {
  ContactQualityMetrics,
  ContactQualityTier,
  LineupContext,
  PitcherContext,
  WeatherParkContext,
  MLBPropInput,
  BatterVsPitcherHistory,
} from "./types";
import { STANDARD_THRESHOLDS, EARLY_EXPLOSIVE_THRESHOLDS } from "./types";

function clampRange(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

export function classifyContactQuality(
  metrics: ContactQualityMetrics
): ContactQualityTier {
  const ev = metrics.exitVelocity ?? 0;
  const la = metrics.launchAngle ?? 0;
  const dist = metrics.hitDistance ?? 0;
  const hhr = metrics.hardHitRateSeason ?? 0;

  const inSweetSpot =
    la >= STANDARD_THRESHOLDS.launchAngle.sweetSpotMin &&
    la <= STANDARD_THRESHOLDS.launchAngle.sweetSpotMax;

  if (
    ev >= STANDARD_THRESHOLDS.exitVelocity.elite &&
    inSweetSpot &&
    dist >= STANDARD_THRESHOLDS.distance.elite &&
    hhr >= STANDARD_THRESHOLDS.hardHitRate.elite
  ) {
    return "ELITE";
  }

  if (
    ev >= STANDARD_THRESHOLDS.exitVelocity.hard &&
    dist >= STANDARD_THRESHOLDS.distance.hard &&
    hhr >= STANDARD_THRESHOLDS.hardHitRate.hard
  ) {
    return "HARD";
  }

  if (
    ev >= STANDARD_THRESHOLDS.exitVelocity.medium &&
    dist >= STANDARD_THRESHOLDS.distance.medium
  ) {
    return "MEDIUM";
  }

  return "SOFT";
}

export function computeLiveContactQualityScore(
  metrics: ContactQualityMetrics
): number {
  const tier = classifyContactQuality(metrics);

  const tierScores: Record<ContactQualityTier, number> = {
    ELITE: 0.25,
    HARD: 0.15,
    MEDIUM: 0.05,
    SOFT: -0.05,
  };

  let score = tierScores[tier];

  const priorABs = metrics.priorABResults;
  if (priorABs.length > 0) {
    const hardHits = priorABs.filter(
      (ab) => (ab.exitVelocity ?? 0) >= STANDARD_THRESHOLDS.exitVelocity.hard
    ).length;
    const hardHitFraction = hardHits / priorABs.length;
    score += hardHitFraction * 0.10;
  }

  return score;
}

export function computeLineupContextScore(lineup: LineupContext): number {
  let score = 0;

  if (lineup.battingOrderSlot <= 3) {
    score += 0.08;
  } else if (lineup.battingOrderSlot <= 5) {
    score += 0.04;
  } else if (lineup.battingOrderSlot >= 8) {
    score -= 0.04;
  }

  if (lineup.orderTurnoverProximity <= 2) {
    score += 0.05;
  }

  if (lineup.lineupSectionStrength === "strong") {
    score += 0.06;
  } else if (lineup.lineupSectionStrength === "weak") {
    score -= 0.06;
  }

  if (lineup.hittersAheadOnBase >= 2) {
    score += 0.04;
  } else if (lineup.hittersAheadOnBase >= 1) {
    score += 0.02;
  }

  return score;
}

function clamp01(value: number, min: number, max: number): number {
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

export function computeStrongContextScore(input: MLBPropInput): number {
  const contactRaw = computeLiveContactQualityScore(input.contactQuality);
  const pitcherRaw = computePitcherContextScore(input.pitcher);
  const lineupRaw = computeLineupContextScore(input.lineup);
  const handednessRaw = computeHandednessMatchupScore(input);
  const weatherRaw = computeWeatherParkScore(input.weatherPark);

  const contactNorm = clamp01(contactRaw, -0.05, 0.35);
  const pitcherNorm = clamp01(pitcherRaw, 0, 0.40);
  const lineupNorm = clamp01(lineupRaw, -0.10, 0.23);
  const handednessNorm = clamp01(handednessRaw, -0.04, 0.06);
  const weatherNorm = clamp01(weatherRaw, -0.10, 0.20);

  return (
    0.30 * contactNorm +
    0.20 * pitcherNorm +
    0.20 * lineupNorm +
    0.15 * handednessNorm +
    0.15 * weatherNorm
  );
}

export interface TwoABRuleResult {
  liveFormAllowed: boolean;
  mode: "standard" | "early_explosive";
  reason: string;
  strongContextScore?: number;
}

export function applyTwoABRule(input: MLBPropInput): TwoABRuleResult {
  const { completedAB, contactQuality } = input;

  if (completedAB >= STANDARD_THRESHOLDS.minABForLiveBoost) {
    return {
      liveFormAllowed: true,
      mode: "standard",
      reason: `${completedAB} AB completed (≥ ${STANDARD_THRESHOLDS.minABForLiveBoost} required)`,
    };
  }

  if (completedAB >= EARLY_EXPLOSIVE_THRESHOLDS.minAB) {
    const ev = contactQuality.exitVelocity ?? 0;
    const la = contactQuality.launchAngle ?? 0;
    const dist = contactQuality.hitDistance ?? 0;

    const meetsMetrics =
      ev >= EARLY_EXPLOSIVE_THRESHOLDS.exitVelocity &&
      la >= EARLY_EXPLOSIVE_THRESHOLDS.launchAngle.min &&
      la <= EARLY_EXPLOSIVE_THRESHOLDS.launchAngle.max &&
      dist >= EARLY_EXPLOSIVE_THRESHOLDS.distance;

    const strongContextScore = computeStrongContextScore(input);
    const hasStrongContext = strongContextScore >= EARLY_EXPLOSIVE_THRESHOLDS.strongContextScoreMin;

    if (meetsMetrics && hasStrongContext) {
      return {
        liveFormAllowed: true,
        mode: "early_explosive",
        reason: `Early explosive mode: EV=${ev}, LA=${la}°, Dist=${dist}ft cross elite thresholds; context score=${strongContextScore.toFixed(2)} ≥ ${EARLY_EXPLOSIVE_THRESHOLDS.strongContextScoreMin}`,
        strongContextScore,
      };
    }

    if (meetsMetrics && !hasStrongContext) {
      return {
        liveFormAllowed: false,
        mode: "standard",
        reason: `Elite contact at ${completedAB} AB but context score ${strongContextScore.toFixed(2)} < ${EARLY_EXPLOSIVE_THRESHOLDS.strongContextScoreMin} required`,
        strongContextScore,
      };
    }
  }

  return {
    liveFormAllowed: false,
    mode: "standard",
    reason: `Only ${completedAB} AB completed; need ${STANDARD_THRESHOLDS.minABForLiveBoost} or elite contact metrics + strong context`,
  };
}

export function computePitcherContextScore(pitcher: PitcherContext): number {
  let score = 0;

  if (pitcher.pitchCount >= 90) {
    score += 0.12;
  } else if (pitcher.pitchCount >= 75) {
    score += 0.06;
  } else if (pitcher.pitchCount >= 60) {
    score += 0.02;
  }

  if (pitcher.timesThrough >= 3) {
    score += 0.10;
  } else if (pitcher.timesThrough >= 2) {
    score += 0.04;
  }

  if (pitcher.isPitcherCollapsing) {
    score += 0.15;
  }

  if (pitcher.managerLeashShort) {
    score += 0.05;
  }

  if (pitcher.era !== null) {
    if (pitcher.era >= 5.0) {
      score += 0.08;
    } else if (pitcher.era >= 4.0) {
      score += 0.03;
    } else if (pitcher.era <= 2.5) {
      score -= 0.08;
    } else if (pitcher.era <= 3.2) {
      score -= 0.03;
    }
  }

  return score;
}

export function computePitchTypeScore(pitcher: PitcherContext): number {
  if (pitcher.pitchMix.length === 0) return 0;

  let score = 0;
  const fastballPct = pitcher.pitchMix
    .filter((p) => p.pitchType === "FF" || p.pitchType === "SI")
    .reduce((sum, p) => sum + p.percentage, 0);

  if (fastballPct >= 0.65) {
    score += 0.06;
  } else if (fastballPct <= 0.35) {
    score -= 0.04;
  }

  return score;
}

export function computeWeatherParkScore(wp: WeatherParkContext): number {
  let score = 0;

  const parkDelta = wp.parkFactor - 1.0;
  score += parkDelta * 0.10;

  if (!wp.isIndoors && wp.temperature !== null) {
    if (wp.temperature >= 85) {
      score += 0.04;
    } else if (wp.temperature <= 45) {
      score -= 0.04;
    }
  }

  if (!wp.isIndoors && wp.windSpeed !== null && wp.windDirection !== null) {
    if (wp.windDirection === "out" && wp.windSpeed >= 10) {
      score += 0.06;
    } else if (wp.windDirection === "in" && wp.windSpeed >= 10) {
      score -= 0.06;
    }
  }

  return score;
}

export function computeBullpenScore(
  bullpen: {
    bullpenEra: number | null;
    bullpenUsageLastThreeDays: number | null;
    isTopRelieverAvailable: boolean;
  }
): number {
  let score = 0;

  if (bullpen.bullpenEra !== null) {
    if (bullpen.bullpenEra >= 4.5) {
      score += 0.08;
    } else if (bullpen.bullpenEra <= 2.8) {
      score -= 0.06;
    }
  }

  if (bullpen.bullpenUsageLastThreeDays !== null) {
    if (bullpen.bullpenUsageLastThreeDays >= 6) {
      score += 0.05;
    }
  }

  if (!bullpen.isTopRelieverAvailable) {
    score += 0.04;
  }

  return score;
}

export function computeParkHistoryAdjustment(input: MLBPropInput): number {
  const factor =
    (input.parkHistoryFactor !== undefined && input.parkHistoryFactor !== null)
      ? input.parkHistoryFactor
      : input.weatherPark.parkHistoryFactor;
  if (factor === null) return 0;
  const delta = factor - 1.0;
  return clampRange(delta * 0.15, -0.15, 0.15);
}

export function computeHandednessMatchupScore(input: MLBPropInput): number {
  if (
    input.pitcherVsHandednessFactor !== undefined &&
    input.pitcherVsHandednessFactor !== null
  ) {
    return clampRange(input.pitcherVsHandednessFactor, -0.20, 0.20);
  }

  const batterHand = input.batterHand;
  const pitcherThrows = input.pitcherThrows ?? input.pitcher.throws;

  if (!batterHand || !pitcherThrows) return 0;

  if (batterHand === "S") return 0.03;

  if (
    (batterHand === "R" && pitcherThrows === "L") ||
    (batterHand === "L" && pitcherThrows === "R")
  ) {
    return 0.06;
  }

  if (
    (batterHand === "L" && pitcherThrows === "L") ||
    (batterHand === "R" && pitcherThrows === "R")
  ) {
    return -0.04;
  }

  return 0;
}

export function computeBvpAdjustment(input: MLBPropInput): number {
  const pa = input.bvpPlateAppearances;
  const opsFactor = input.bvpOpsLikeFactor;

  if (pa !== undefined && pa !== null && pa >= 10 && opsFactor !== undefined && opsFactor !== null) {
    const delta = opsFactor - 1.0;
    return clampRange(delta * 0.20, -0.15, 0.15);
  }

  return computeBatterVsPitcherHistoryAdjustment(input.bvpHistory);
}

export function computeBatterVsPitcherHistoryAdjustment(
  bvp: BatterVsPitcherHistory | undefined
): number {
  if (!bvp || bvp.atBats < 5) return 0;

  const avg = bvp.avg ?? (bvp.atBats > 0 ? bvp.hits / bvp.atBats : 0);
  const leagueAvg = 0.250;

  if (avg >= 0.350 && bvp.atBats >= 10) return 0.08;
  if (avg >= 0.300) return 0.05;
  if (avg >= leagueAvg) return 0.02;
  if (avg < 0.180 && bvp.atBats >= 10) return -0.06;
  if (avg < 0.200) return -0.03;

  return 0;
}

export function computeLineupPocketWeaknessScore(input: MLBPropInput): number {
  const pw =
    (input.lineupPocketWeakness !== undefined && input.lineupPocketWeakness !== null)
      ? input.lineupPocketWeakness
      : input.lineup.pocketWeakness;

  if (pw === null) return 0;

  if (pw >= 0.8) return clampRange(0.07, -0.20, 0.20);
  if (pw >= 0.6) return clampRange(0.04, -0.20, 0.20);
  if (pw >= 0.4) return clampRange(0.02, -0.20, 0.20);
  if (pw <= 0.15) return clampRange(-0.04, -0.20, 0.20);

  return 0;
}
