import type {
  ContactQualityMetrics,
  ContactQualityTier,
  LineupContext,
  PitcherContext,
  WeatherParkContext,
  MLBPropInput,
  BatterVsPitcherHistory,
  FormIndicator,
} from "./types";
import { STANDARD_THRESHOLDS, EARLY_EXPLOSIVE_THRESHOLDS, FORM_THRESHOLDS, HR_MIN_QUALIFYING_FACTORS } from "./types";
import { normalizePercentage } from "../services/normalizationService";

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

    // Explicit environment gate: Early Explosion also requires strong environmentScore
    const envScore = environmentScore(input);
    const hasStrongEnvironment = envScore >= EARLY_EXPLOSIVE_THRESHOLDS.environmentScoreMin;

    if (meetsMetrics && hasStrongContext && hasStrongEnvironment) {
      return {
        liveFormAllowed: true,
        mode: "early_explosive",
        reason: `Early explosive mode: EV=${ev}, LA=${la}°, Dist=${dist}ft cross elite thresholds; context score=${strongContextScore.toFixed(2)} ≥ ${EARLY_EXPLOSIVE_THRESHOLDS.strongContextScoreMin}, envScore=${envScore.toFixed(2)} ≥ ${EARLY_EXPLOSIVE_THRESHOLDS.environmentScoreMin}`,
        strongContextScore,
      };
    }

    if (meetsMetrics && (!hasStrongContext || !hasStrongEnvironment)) {
      return {
        liveFormAllowed: false,
        mode: "standard",
        reason: `Elite contact at ${completedAB} AB but gate failed — context=${strongContextScore.toFixed(2)} (min ${EARLY_EXPLOSIVE_THRESHOLDS.strongContextScoreMin}), envScore=${envScore.toFixed(2)} (min ${EARLY_EXPLOSIVE_THRESHOLDS.environmentScoreMin})`,
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
  // pitchMix.percentage may be on 0-100 or 0-1 scale; normalizePercentage auto-detects
  const fastballPct = pitcher.pitchMix
    .filter((p) => p.pitchType === "FF" || p.pitchType === "SI")
    .reduce((sum, p) => sum + normalizePercentage(p.percentage), 0);

  if (fastballPct >= 0.65) {
    score += 0.06;
  } else if (fastballPct <= 0.35) {
    score -= 0.04;
  }

  return score;
}

/**
 * Batter-vs-pitch-type split modifier.
 * Cross-references the pitcher's pitch mix profile with the batter's contact quality
 * (hard-hit rate as a proxy for power vs. contact profile) to estimate the matchup effect.
 *
 * Logic:
 * - Power hitters (hardHitRate >= 0.45) benefit more from fastball-heavy pitchers
 *   and are relatively disadvantaged vs. breaking-ball-heavy pitchers
 * - Contact hitters (hardHitRate <= 0.35) are more consistent vs. breaking-ball pitchers
 * - Balanced profiles (0.35-0.45) get near-zero adjustment
 */
export function computeBatterVsPitchTypeSplit(input: MLBPropInput): number {
  const pitchMix = input.pitcher.pitchMix;
  const hardHitRate = input.contactQuality.hardHitRateSeason;

  if (pitchMix.length === 0 || hardHitRate == null) return 0;

  // normalizePercentage auto-detects 0-100 vs 0-1 scale
  const fastballPct = pitchMix
    .filter((p) => p.pitchType === "FF" || p.pitchType === "SI")
    .reduce((sum, p) => sum + normalizePercentage(p.percentage), 0);

  const breakingPct = pitchMix
    .filter((p) => p.pitchType === "SL" || p.pitchType === "CU" || p.pitchType === "KC" || p.pitchType === "CS")
    .reduce((sum, p) => sum + normalizePercentage(p.percentage), 0);

  const isPowerHitter = hardHitRate >= 0.45;
  const isContactHitter = hardHitRate <= 0.35;

  let score = 0;

  if (fastballPct >= 0.60) {
    if (isPowerHitter) score += 0.04;    // power hitter vs fastball-heavy = favorable
    else if (isContactHitter) score += 0.01; // contact hitter vs fastball = slight edge
  }

  if (breakingPct >= 0.40) {
    if (isPowerHitter) score -= 0.03;    // power hitter vs breaking-heavy = unfavorable
    else if (isContactHitter) score += 0.02; // contact hitter vs breaking = slight edge
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

// ── Composite four-dimension scoring model ────────────────────────────────────
// Each function returns a normalized [0, 1] score. The composite finalScore is
// the sum of the four dimensions and is used directly for signal generation
// thresholds and Early Explosion mode gating.

/**
 * contactQualityScore — Exit velocity, launch angle, hard-hit rate, barrel
 * likelihood, and prior AB quality today.
 * Range: [0, 1]
 */
export function contactQualityScore(input: MLBPropInput): number {
  const metrics = input.contactQuality;
  const ev = metrics.exitVelocity ?? 0;
  const la = metrics.launchAngle ?? 0;
  const hhr = metrics.hardHitRateSeason ?? 0;
  const barrel = metrics.barrelRateProxySeason ?? 0;

  let score = 0;

  // Exit velocity contribution (0–0.35)
  if (ev >= EARLY_EXPLOSIVE_THRESHOLDS.exitVelocity) score += 0.35;
  else if (ev >= STANDARD_THRESHOLDS.exitVelocity.elite) score += 0.28;
  else if (ev >= STANDARD_THRESHOLDS.exitVelocity.hard) score += 0.18;
  else if (ev >= STANDARD_THRESHOLDS.exitVelocity.medium) score += 0.08;

  // Launch angle sweet spot contribution (0–0.20)
  const inSweetSpot =
    la >= STANDARD_THRESHOLDS.launchAngle.sweetSpotMin &&
    la <= STANDARD_THRESHOLDS.launchAngle.sweetSpotMax;
  if (inSweetSpot) score += 0.20;
  else if (la > 0 && la < STANDARD_THRESHOLDS.launchAngle.sweetSpotMin) score += 0.08;

  // Hard-hit rate contribution (0–0.25)
  if (hhr >= STANDARD_THRESHOLDS.hardHitRate.elite) score += 0.25;
  else if (hhr >= STANDARD_THRESHOLDS.hardHitRate.hard) score += 0.15;
  else if (hhr >= STANDARD_THRESHOLDS.hardHitRate.medium) score += 0.07;

  // Barrel rate contribution (0–0.10)
  if (barrel >= 0.10) score += 0.10;
  else if (barrel >= 0.05) score += 0.05;

  // Prior AB quality today (0–0.10)
  const priorABs = metrics.priorABResults;
  if (priorABs.length > 0) {
    const hardHits = priorABs.filter(
      (ab) => (ab.exitVelocity ?? 0) >= STANDARD_THRESHOLDS.exitVelocity.hard
    ).length;
    const frac = hardHits / priorABs.length;
    score += frac * 0.10;
  }

  return Math.min(1, score);
}

/**
 * opportunityScore — Batting order slot, remaining PA estimate, inning,
 * pitch count proxy for bullpen likelihood.
 * Range: [0, 1]
 */
export function opportunityScore(input: MLBPropInput): number {
  let score = 0;

  const slot = input.lineup.battingOrderSlot;
  const remainingPA = input.remainingPA ?? 1;
  const inning = input.inning;
  const pitchCount = input.pitcher.pitchCount;

  // Batting order slot (0–0.30)
  if (slot <= 2) score += 0.30;
  else if (slot <= 4) score += 0.22;
  else if (slot <= 6) score += 0.14;
  else score += 0.06;

  // Remaining PA estimate — normalized against typical max of 3.5 (0–0.30)
  const paNorm = Math.min(1, remainingPA / 3.5);
  score += paNorm * 0.30;

  // Inning — earlier innings have more opportunity (0–0.20)
  if (inning <= 3) score += 0.20;
  else if (inning <= 5) score += 0.14;
  else if (inning <= 7) score += 0.08;
  else score += 0.02;

  // High pitch count suggests bullpen entry soon → more PA opportunity vs. fresh arms (0–0.20)
  if (pitchCount >= 90) score += 0.20;
  else if (pitchCount >= 75) score += 0.14;
  else if (pitchCount >= 60) score += 0.08;

  return Math.min(1, score);
}

/**
 * environmentScore — Park factor, weather, handedness splits.
 * Range: [0, 1]
 */
export function environmentScore(input: MLBPropInput): number {
  let score = 0;

  const parkFactor = input.weatherPark.parkFactor;
  const isIndoors = input.weatherPark.isIndoors;
  const temp = input.weatherPark.temperature;
  const windSpeed = input.weatherPark.windSpeed;
  const windDir = input.weatherPark.windDirection;

  // Park factor contribution (0–0.35)
  if (parkFactor >= 1.10) score += 0.35;
  else if (parkFactor >= 1.05) score += 0.25;
  else if (parkFactor >= 1.00) score += 0.18;
  else if (parkFactor >= 0.95) score += 0.10;
  else score += 0.04;

  // Weather contribution (0–0.35)
  if (!isIndoors) {
    if (temp !== null) {
      if (temp >= 85) score += 0.15;
      else if (temp >= 75) score += 0.10;
      else if (temp <= 45) score += 0; // suppress
      else score += 0.07;
    } else {
      score += 0.07; // neutral
    }

    if (windDir === "out" && windSpeed !== null) {
      if (windSpeed >= 15) score += 0.20;
      else if (windSpeed >= 10) score += 0.14;
      else if (windSpeed >= 5) score += 0.07;
    } else if (windDir === "in" && windSpeed !== null && windSpeed >= 10) {
      score -= 0.10; // headwind suppresses
    } else {
      score += 0.07; // neutral/calm
    }
  } else {
    // Indoor: apply neutral baseline
    score += 0.30;
  }

  // Handedness contribution (0–0.30)
  const handedness = computeHandednessMatchupScore(input);
  if (handedness >= 0.06) score += 0.30;
  else if (handedness >= 0.03) score += 0.20;
  else if (handedness >= 0) score += 0.12;
  else score += 0.05; // unfavorable

  return Math.min(1, Math.max(0, score));
}

/**
 * pitcherVulnerabilityScore — Times through order, pitch count, contact
 * allowed today, and lineup pocket weakness.
 * Range: [0, 1]
 */
export function pitcherVulnerabilityScore(input: MLBPropInput): number {
  let score = 0;

  const pitcher = input.pitcher;
  const timesThrough = pitcher.timesThrough;
  const pitchCount = pitcher.pitchCount;
  const isCollapsing = pitcher.isPitcherCollapsing;
  const leashShort = pitcher.managerLeashShort;

  // Times through order (0–0.30)
  if (timesThrough >= 3) score += 0.30;
  else if (timesThrough >= 2) score += 0.18;
  else score += 0.06;

  // Pitch count (0–0.25)
  if (pitchCount >= 90) score += 0.25;
  else if (pitchCount >= 75) score += 0.18;
  else if (pitchCount >= 60) score += 0.10;
  else score += 0.04;

  // Pitcher collapsing / velocity drop (0–0.25)
  if (isCollapsing) score += 0.25;
  else if (leashShort) score += 0.10;

  // Contact allowed today — approximated via prior AB results against this pitcher
  // (uses lineup pocket weakness as proxy since batter-level data is shared)
  const pw = input.lineup.pocketWeakness ?? 0;
  if (pw >= 0.7) score += 0.20;
  else if (pw >= 0.5) score += 0.12;
  else score += 0.04;

  return Math.min(1, score);
}

/**
 * compositeHitterScore — Sum of all four dimension scores.
 * Drives signal generation thresholds. Range: [0, 4]
 */
export function compositeHitterScore(input: MLBPropInput): number {
  return (
    contactQualityScore(input) +
    opportunityScore(input) +
    environmentScore(input) +
    pitcherVulnerabilityScore(input)
  );
}

// ── Tier 1 vs Tier 3 market priority thresholds ───────────────────────────────
// Tier 1 (hits, total_bases, batter_strikeouts, pitcher_strikeouts): standard composite gate
// Tier 3 (home_runs, hrr): stricter composite gate
export const COMPOSITE_TIER1_THRESHOLD = 1.0;
export const COMPOSITE_TIER3_THRESHOLD = 1.5;

export function computeFormScore(input: MLBPropInput): number {
  const contact = contactQualityScore(input);
  const pitcher = pitcherVulnerabilityScore(input);
  const env = environmentScore(input);
  const priorABs = input.contactQuality.priorABResults;
  let abBonus = 0;
  if (priorABs.length > 0) {
    const hits = priorABs.filter((ab) => ab.outcome === "hit").length;
    const hardHits = priorABs.filter((ab) => (ab.exitVelocity ?? 0) >= 95).length;
    abBonus = (hits / priorABs.length) * 0.3 + (hardHits / priorABs.length) * 0.2;
  }

  let rollingBonus = 0;
  if (input.rollingForm) {
    const rf = input.rollingForm;
    const leagueAvg = 0.250;
    const recent = rf.last7Avg ?? rf.last15Avg;
    if (recent != null) {
      if (recent >= 0.350) rollingBonus = 0.12;
      else if (recent >= 0.300) rollingBonus = 0.08;
      else if (recent >= leagueAvg) rollingBonus = 0.03;
      else if (recent < 0.180) rollingBonus = -0.08;
      else if (recent < 0.200) rollingBonus = -0.04;
    }
  }

  return Math.min(1, contact * 0.30 + pitcher * 0.18 + env * 0.12 + abBonus + rollingBonus + 0.10);
}

export function classifyForm(input: MLBPropInput): FormIndicator {
  const score = computeFormScore(input);
  if (score >= FORM_THRESHOLDS.hot) return "hot";
  if (score >= FORM_THRESHOLDS.warm) return "warm";
  if (score <= FORM_THRESHOLDS.extremeCold) return "extreme_cold";
  if (score <= FORM_THRESHOLDS.cold) return "cold";
  return "neutral";
}

export interface HRQualifyingFactors {
  hardHitContact: boolean;
  favorableWind: boolean;
  hrPronePitcher: boolean;
  strongPitchMatchup: boolean;
  batterParkSuccess: boolean;
  fatiguePitcher: boolean;
  deepFlyout: boolean;
  count: number;
  labels: string[];
}

export function computeHRQualifyingFactors(input: MLBPropInput): HRQualifyingFactors {
  const factors: HRQualifyingFactors = {
    hardHitContact: false,
    favorableWind: false,
    hrPronePitcher: false,
    strongPitchMatchup: false,
    batterParkSuccess: false,
    fatiguePitcher: false,
    deepFlyout: false,
    count: 0,
    labels: [],
  };

  const priorABs = input.contactQuality.priorABResults;
  const hardHits = priorABs.filter((ab) => (ab.exitVelocity ?? 0) >= 100);
  if (hardHits.length > 0) {
    factors.hardHitContact = true;
    const bestEv = Math.max(...hardHits.map((h) => h.exitVelocity ?? 0));
    factors.labels.push(`${hardHits.length} Hard-Hit Ball${hardHits.length > 1 ? "s" : ""} (${Math.round(bestEv)}+ EV)`);
  }

  if (
    !input.weatherPark.isIndoors &&
    input.weatherPark.windDirection === "out" &&
    (input.weatherPark.windSpeed ?? 0) >= 8
  ) {
    factors.favorableWind = true;
    factors.labels.push(`Wind Out (${input.weatherPark.windSpeed} mph)`);
  }

  const era = input.pitcher.era;
  const hrPer9 = era !== null && era >= 4.5;
  if (hrPer9 || input.pitcher.isPitcherCollapsing) {
    factors.hrPronePitcher = true;
    factors.labels.push("HR-Prone Pitcher");
  }

  const handedness = computeHandednessMatchupScore(input);
  if (handedness >= 0.04) {
    factors.strongPitchMatchup = true;
    factors.labels.push("Strong Pitch Matchup");
  }

  const parkHistory = input.weatherPark.parkHistoryFactor ?? input.parkHistoryFactor;
  if (parkHistory !== null && parkHistory !== undefined && parkHistory >= 1.08) {
    factors.batterParkSuccess = true;
    factors.labels.push("Crushes This Park");
  }

  if (input.pitcher.pitchCount >= 80 || input.pitcher.timesThrough >= 3) {
    factors.fatiguePitcher = true;
    factors.labels.push("Pitcher Fatigue");
  }

  const deepFlys = priorABs.filter(
    (ab) => ab.outcome === "out" && (ab.distance ?? 0) >= 350 && (ab.launchAngle ?? 0) >= 20
  );
  if (deepFlys.length > 0) {
    factors.deepFlyout = true;
    factors.labels.push(`${deepFlys.length} Deep Flyout${deepFlys.length > 1 ? "s" : ""}`);
  }

  factors.count = [
    factors.hardHitContact,
    factors.favorableWind,
    factors.hrPronePitcher,
    factors.strongPitchMatchup,
    factors.batterParkSuccess,
    factors.fatiguePitcher,
    factors.deepFlyout,
  ].filter(Boolean).length;

  return factors;
}

export function meetsHRQualificationGate(input: MLBPropInput): { passes: boolean; factors: HRQualifyingFactors } {
  const factors = computeHRQualifyingFactors(input);
  return { passes: factors.count >= HR_MIN_QUALIFYING_FACTORS, factors };
}
