import type { HRBuildResult, ClassifiedContact } from "./HRSignalBuilder";
import { estimateRichPADistribution } from "./paDistribution";
import type { PitchMixEntry, PitcherHandednessSplits, BatterHandednessSplits } from "./types";
import { getPitchFamily } from "./pitchTypeNormalizer";

export interface PitcherDeteriorationContext {
  velocityDrop: number | null;
  avgVelocity: number | null;
  seasonAvgVelocity: number | null;
  isReliever: boolean;
  relieverEra: number | null;
  starterEra: number | null;
  bullpenEra: number | null;
  bullpenUsageLast3Days: number | null;
  relieversUsedCount: number;
}

export interface HRConversionInput {
  hrBuildScore: number;
  factors: HRBuildResult["factors"];
  inning: number;
  isTopInning: boolean;
  battingOrderSlot: number;
  currentRuns: number;
  leagueAvgRuns: number;
  pitchCount: number;
  timesThrough: number;
  isPitcherCollapsing: boolean;
  era: number | null;
  parkFactor: number;
  windDirection: string | null;
  windSpeed: number | null;
  temperature: number | null;
  isIndoors: boolean;
  batterHand: string | null;
  pitcherThrows: string | null;
  seasonHRRate: number | null;
  barrelRate: number | null;
  hardHitRate: number | null;
  xSLG: number | null;
  pitcherDeterioration?: PitcherDeteriorationContext | null;
  // Gap 1: pitch mix for handedness × pitch-type HR multiplier
  pitchMix?: PitchMixEntry[] | null;
  // Gap 3: pre-game pitcher fatigue
  lastStartPitchCount?: number | null;
  daysSinceLastStart?: number | null;
  last3StartERA?: number | null;
  // Gap 4: empirical pitcher ERA/HR rate by batter handedness
  pitcherHandednessSplits?: PitcherHandednessSplits | null;
  // Gap 5: batter HR rate vs this pitcher's hand
  batterHandednessSplits?: BatterHandednessSplits | null;
  // Gaps 7–9: Savant power profile
  flyBallPercent?: number | null;
  hrFBRatio?: number | null;
  xwOBA?: number | null;
  xISO?: number | null;
  sweetSpotPercent?: number | null;
}

export interface HRConversionResult {
  hrConversionProbability: number;
  calibratedProbability: number;
  perPAHRRate: number;
  expectedRemainingPA: number;
  liveContactMultiplier: number;
  pitcherMultiplier: number;
  environmentMultiplier: number;
  pitcherDeteriorationState: string;
  // Phase 4 calibration diagnostics
  rawConversionProbability: number;
  calibratedConversionProbability: number;
  calibrationSource: "static_table" | "empirical_buckets";
  calibrationBucketLabel: string | null;
  calibrationSampleCount: number;
  components: {
    baseRate: number;
    liveAdjustedRate: number;
    pitcherAdjustedRate: number;
    envAdjustedRate: number;
    entryAdjustedRate: number;
    finalPerPARate: number;
    paDist: Record<number, number>;
    pZeroHR: number;
    rawProbability: number;
  };
}

/** Empirical bucket loaded from resolved outcomes (Phase 4). */
export interface HrCalibrationBucket {
  min: number;
  max: number;
  calibrated: number;
  samples: number;
  label?: string;
}

/**
 * Generic empirical remap helper. If `buckets` is empty or no bucket matches,
 * returns the raw value (caller is expected to fall back to the static table).
 */
export function calibrateHrProbability(rawProb: number, buckets: HrCalibrationBucket[]): number {
  if (!buckets || buckets.length === 0) return rawProb;
  const bucket = buckets.find(b => rawProb >= b.min && rawProb < b.max);
  if (!bucket) return rawProb;
  return bucket.calibrated;
}

/**
 * Empirical buckets are loaded asynchronously (e.g. from analytics). When
 * present, calibration uses them in preference to the static table.
 * Defaults to empty so existing behavior is unchanged.
 */
let EMPIRICAL_BUCKETS: HrCalibrationBucket[] = [];

export function setEmpiricalCalibrationBuckets(buckets: HrCalibrationBucket[]): void {
  EMPIRICAL_BUCKETS = Array.isArray(buckets) ? buckets : [];
}

export function getEmpiricalCalibrationBuckets(): HrCalibrationBucket[] {
  return EMPIRICAL_BUCKETS;
}

const LEAGUE_AVG_HR_PER_PA = 0.033;
const LEAGUE_AVG_BARREL_RATE = 0.065;

const CALIBRATION_TABLE: Array<{ rawMin: number; rawMax: number; calibrated: number }> = [
  { rawMin: 0.00, rawMax: 0.03, calibrated: 0.01 },
  { rawMin: 0.03, rawMax: 0.05, calibrated: 0.03 },
  { rawMin: 0.05, rawMax: 0.08, calibrated: 0.055 },
  { rawMin: 0.08, rawMax: 0.10, calibrated: 0.075 },
  { rawMin: 0.10, rawMax: 0.13, calibrated: 0.10 },
  { rawMin: 0.13, rawMax: 0.16, calibrated: 0.13 },
  { rawMin: 0.16, rawMax: 0.20, calibrated: 0.165 },
  { rawMin: 0.20, rawMax: 0.25, calibrated: 0.21 },
  { rawMin: 0.25, rawMax: 0.30, calibrated: 0.255 },
  { rawMin: 0.30, rawMax: 0.40, calibrated: 0.32 },
  { rawMin: 0.40, rawMax: 1.00, calibrated: 0.38 },
];

function calibrate(rawProb: number): { value: number; source: "static_table" | "empirical_buckets"; bucketLabel: string | null; samples: number } {
  // Phase 4: prefer empirical buckets when available; fall back to static table.
  if (EMPIRICAL_BUCKETS.length > 0) {
    const eb = EMPIRICAL_BUCKETS.find(b => rawProb >= b.min && rawProb < b.max);
    if (eb) {
      return {
        value: eb.calibrated,
        source: "empirical_buckets",
        bucketLabel: eb.label ?? `${eb.min.toFixed(2)}-${eb.max.toFixed(2)}`,
        samples: eb.samples,
      };
    }
  }
  for (const bucket of CALIBRATION_TABLE) {
    if (rawProb >= bucket.rawMin && rawProb < bucket.rawMax) {
      const t = (rawProb - bucket.rawMin) / (bucket.rawMax - bucket.rawMin);
      const nextIdx = CALIBRATION_TABLE.indexOf(bucket) + 1;
      const nextCal = nextIdx < CALIBRATION_TABLE.length ? CALIBRATION_TABLE[nextIdx].calibrated : bucket.calibrated;
      return {
        value: bucket.calibrated + t * (nextCal - bucket.calibrated),
        source: "static_table",
        bucketLabel: `${bucket.rawMin.toFixed(2)}-${bucket.rawMax.toFixed(2)}`,
        samples: 0,
      };
    }
  }
  return {
    value: rawProb >= 0.40 ? 0.38 : 0.01,
    source: "static_table",
    bucketLabel: null,
    samples: 0,
  };
}

function computeLiveContactMultiplier(factors: HRBuildResult["factors"]): number {
  const classified = factors.contactClasses;
  if (!classified || classified.length === 0) return 1.0;

  const hrShapedCount = factors.hrShapedCount ?? 0;
  const missedHrCount = factors.missedHrCount ?? 0;
  const eliteHrCount = factors.eliteHrCount ?? 0;

  let multiplier = 1.0;

  if (eliteHrCount >= 1) {
    multiplier += 0.6 * eliteHrCount;
  }
  if (missedHrCount >= 1) {
    multiplier += 0.4 * missedHrCount;
  }
  const pureHrShaped = hrShapedCount - missedHrCount - eliteHrCount;
  if (pureHrShaped >= 1) {
    multiplier += 0.25 * pureHrShaped;
  }

  const qualifiedEVMean = factors.qualifiedEVMean ?? 0;
  if (qualifiedEVMean >= 104) multiplier *= 1.25;
  else if (qualifiedEVMean >= 101) multiplier *= 1.15;
  else if (qualifiedEVMean >= 99) multiplier *= 1.08;

  const maxDistance = factors.maxDistance ?? 0;
  if (maxDistance >= 400) multiplier *= 1.20;
  else if (maxDistance >= 390) multiplier *= 1.12;
  else if (maxDistance >= 375) multiplier *= 1.06;

  if (hrShapedCount >= 2) {
    multiplier *= 1.0 + (hrShapedCount - 1) * 0.10;
  }

  // Phase 4: tightened cap to reduce upstream probability inflation.
  return Math.min(2.5, multiplier);
}

function describePitcherDeteriorationState(input: HRConversionInput): string {
  const det = input.pitcherDeterioration;
  const parts: string[] = [];

  if (input.isPitcherCollapsing) parts.push("COLLAPSING");

  if (det) {
    if (det.velocityDrop !== null && det.velocityDrop > 3) parts.push(`velo-drop=${det.velocityDrop.toFixed(1)}mph`);
    else if (det.velocityDrop !== null && det.velocityDrop > 2) parts.push(`velo-fading=${det.velocityDrop.toFixed(1)}mph`);

    if (det.isReliever) {
      parts.push("reliever");
      if (det.relieverEra !== null && det.relieverEra >= 5.0) parts.push(`rlvERA=${det.relieverEra.toFixed(2)}`);
    }

    if (det.bullpenEra !== null && det.bullpenEra >= 5.0) parts.push(`bpERA=${det.bullpenEra.toFixed(2)}`);
    if (det.bullpenUsageLast3Days !== null && det.bullpenUsageLast3Days >= 80) parts.push("tired-bp");
    if (det.relieversUsedCount >= 3) parts.push(`${det.relieversUsedCount}-rlv-used`);
  }

  if (input.pitchCount >= 90) parts.push(`PC=${input.pitchCount}`);
  else if (input.pitchCount >= 75) parts.push(`PC=${input.pitchCount}`);

  if (input.timesThrough >= 3) parts.push(`TTO=${input.timesThrough}`);

  if (input.era !== null && input.era >= 5.0) parts.push(`ERA=${input.era.toFixed(2)}`);

  return parts.length > 0 ? parts.join(", ") : "stable";
}


// Gaps 7–9: structural HR power profile multiplier from Savant season stats.
// Applied after environment to keep layers orthogonal. Cap at ×1.20 / floor 0.88.
function computePowerProfileMultiplier(input: HRConversionInput): number {
  let mult = 1.0;
  const LEAGUE_AVG_HR_FB = 11;    // ~11% league avg
  const LEAGUE_AVG_FB_PCT = 35;   // ~35% fly ball rate

  // Improvement 5: park-normalize fly ball stats (~50% home game assumption).
  const parkBias = 0.5 + 0.5 * (input.parkFactor ?? 1.0);

  const hrFB = input.hrFBRatio != null ? input.hrFBRatio / parkBias : null;
  if (hrFB != null) {
    if (hrFB >= 18) mult *= 1.20;
    else if (hrFB >= 14) mult *= 1.12;
    else if (hrFB >= LEAGUE_AVG_HR_FB) mult *= 1.04;
    else if (hrFB <= 8) mult *= 0.90;
    else if (hrFB <= LEAGUE_AVG_HR_FB) mult *= 0.96;
  }

  const fbPct = input.flyBallPercent != null ? input.flyBallPercent / Math.sqrt(parkBias) : null;
  if (fbPct != null) {
    if (fbPct >= 42) mult *= 1.12;
    else if (fbPct >= 38) mult *= 1.05;
    else if (fbPct <= 28) mult *= 0.90;
    else if (fbPct <= LEAGUE_AVG_FB_PCT) mult *= 0.96;
  }

  const xISO = input.xISO;
  if (xISO != null) {
    if (xISO >= 0.220) mult *= 1.15;
    else if (xISO >= 0.180) mult *= 1.08;
    else if (xISO >= 0.140) mult *= 1.02;
    else if (xISO <= 0.100) mult *= 0.92;
  }

  const xwoba = input.xwOBA;
  if (xwoba != null) {
    if (xwoba >= 0.380) mult *= 1.08;
    else if (xwoba >= 0.340) mult *= 1.03;
    else if (xwoba <= 0.280) mult *= 0.93;
  }

  return Math.min(1.28, Math.max(0.88, mult));
}

// Gap 6: lineup slot weight for HR markets.
// Cleanup hitters (3–5) produce HRs at structurally higher rates.
function computeLineupSlotHRMultiplier(slot: number): number {
  if (slot >= 3 && slot <= 5) return 1.06;
  if (slot === 2 || slot === 6) return 1.02;
  if (slot === 1) return 0.97;   // leadoff — speed/OBP, not power focus
  return 0.94;                    // 7–9: weakest HR production
}

function computePitcherMultiplier(input: HRConversionInput): number {
  let multiplier = 1.0;
  const det = input.pitcherDeterioration;

  if (input.pitchCount >= 100) multiplier *= 1.30;
  else if (input.pitchCount >= 90) multiplier *= 1.25;
  else if (input.pitchCount >= 80) multiplier *= 1.15;
  else if (input.pitchCount >= 70) multiplier *= 1.08;

  if (input.timesThrough >= 3) multiplier *= 1.20;
  else if (input.timesThrough >= 2) multiplier *= 1.08;

  if (input.isPitcherCollapsing) multiplier *= 1.30;

  if (det?.isReliever) {
    const rlvEra = det.relieverEra ?? input.era;
    if (rlvEra !== null) {
      if (rlvEra >= 6.0) multiplier *= 1.20;
      else if (rlvEra >= 5.0) multiplier *= 1.12;
      else if (rlvEra >= 4.5) multiplier *= 1.06;
      else if (rlvEra <= 2.0) multiplier *= 0.82;
      else if (rlvEra <= 3.0) multiplier *= 0.90;
    }

    const starterEra = det.starterEra;
    if (rlvEra !== null && starterEra !== null && starterEra > 0) {
      const eraRatio = rlvEra / starterEra;
      if (eraRatio >= 1.8) multiplier *= 1.12;
      else if (eraRatio >= 1.4) multiplier *= 1.06;
      else if (eraRatio <= 0.5) multiplier *= 0.90;
      else if (eraRatio <= 0.7) multiplier *= 0.95;
    }
  } else {
    if (input.era !== null) {
      if (input.era >= 6.0) multiplier *= 1.20;
      else if (input.era >= 5.0) multiplier *= 1.12;
      else if (input.era >= 4.5) multiplier *= 1.06;
      else if (input.era <= 2.5) multiplier *= 0.80;
      else if (input.era <= 3.2) multiplier *= 0.90;
    }
  }

  if (det) {
    if (det.velocityDrop !== null) {
      if (det.velocityDrop > 3.5) multiplier *= 1.25;
      else if (det.velocityDrop > 2.5) multiplier *= 1.15;
      else if (det.velocityDrop > 1.5) multiplier *= 1.06;
      else if (det.velocityDrop < -1.0) multiplier *= 0.95;
    }

    if (det.bullpenEra !== null && !det.isReliever) {
      if (input.pitchCount >= 80 || input.timesThrough >= 3) {
        if (det.bullpenEra >= 5.5) multiplier *= 1.10;
        else if (det.bullpenEra >= 4.5) multiplier *= 1.04;
        else if (det.bullpenEra <= 2.5) multiplier *= 0.94;
      }
    }

    if (det.bullpenUsageLast3Days !== null) {
      if (det.bullpenUsageLast3Days >= 100) multiplier *= 1.10;
      else if (det.bullpenUsageLast3Days >= 80) multiplier *= 1.05;
    }

    if (det.relieversUsedCount >= 4) multiplier *= 1.08;
    else if (det.relieversUsedCount >= 3) multiplier *= 1.04;
  }

  // Gap 4: adjust for matchup-specific pitcher ERA vs this batter's hand
  multiplier *= computeHandednessERAMultiplier(input);

  // Phase 4: tightened cap to reduce upstream probability inflation.
  return Math.min(2.0, multiplier);
}

// Gap 4: select the matchup-appropriate ERA from pitcher handedness splits.
// Falls back to generic ERA if splits unavailable. Max swing ±8%.
function computeHandednessERAMultiplier(input: HRConversionInput): number {
  const splits = input.pitcherHandednessSplits;
  const batterHand = input.batterHand;
  if (!splits || !batterHand) return 1.0;

  const matchupERA = batterHand === "L" ? splits.eraVsLHB : splits.eraVsRHB;
  let eraMultiplier = 1.0;
  if (matchupERA != null) {
    if (matchupERA >= 6.0) eraMultiplier = 1.08;
    else if (matchupERA >= 5.0) eraMultiplier = 1.05;
    else if (matchupERA >= 4.5) eraMultiplier = 1.02;
    else if (matchupERA <= 2.5) eraMultiplier = 0.92;
    else if (matchupERA <= 3.2) eraMultiplier = 0.96;
  }

  // Blend in HR/9 by batter handedness (40%) — more direct signal for the HR market.
  // League avg HR/9 allowed is ~1.2.
  const matchupHrPer9 = batterHand === "L" ? splits.hrPer9VsLHB : splits.hrPer9VsRHB;
  let hrPer9Multiplier = 1.0;
  if (matchupHrPer9 != null) {
    if (matchupHrPer9 >= 2.0) hrPer9Multiplier = 1.10;
    else if (matchupHrPer9 >= 1.5) hrPer9Multiplier = 1.05;
    else if (matchupHrPer9 <= 0.6) hrPer9Multiplier = 0.88;
    else if (matchupHrPer9 <= 0.9) hrPer9Multiplier = 0.94;
  }

  // 60% ERA-based, 40% HR/9-based when both are available; ERA-only otherwise.
  const blended = matchupHrPer9 != null
    ? 0.60 * eraMultiplier + 0.40 * hrPer9Multiplier
    : eraMultiplier;

  return Math.max(0.88, Math.min(1.12, blended));
}

function computeEnvironmentMultiplier(input: HRConversionInput): number {
  let multiplier = 1.0;

  if (input.parkFactor >= 1.15) multiplier *= 1.20;
  else if (input.parkFactor >= 1.10) multiplier *= 1.14;
  else if (input.parkFactor >= 1.05) multiplier *= 1.07;
  else if (input.parkFactor <= 0.90) multiplier *= 0.85;
  else if (input.parkFactor <= 0.95) multiplier *= 0.92;

  if (!input.isIndoors) {
    const ws = input.windSpeed ?? 0;
    if (input.windDirection === "out" && ws >= 12) multiplier *= 1.15;
    else if (input.windDirection === "out" && ws >= 8) multiplier *= 1.08;
    else if (input.windDirection === "in" && ws >= 12) multiplier *= 0.82;
    else if (input.windDirection === "in" && ws >= 8) multiplier *= 0.90;

    const temp = input.temperature ?? 70;
    if (temp >= 90) multiplier *= 1.08;
    else if (temp >= 80) multiplier *= 1.04;
    else if (temp <= 40) multiplier *= 0.88;
    else if (temp <= 50) multiplier *= 0.94;
  }

  // Gap 1: replace simple handedness ±% with full pitch mix × handedness model.
  if (input.pitchMix && input.pitchMix.length > 0) {
    multiplier *= computePitchMixHandednessMultiplier(input.pitchMix, input.batterHand, input.pitcherThrows);
  } else if (input.batterHand && input.pitcherThrows && input.batterHand !== input.pitcherThrows) {
    multiplier *= 1.06;
  } else if (input.batterHand && input.pitcherThrows && input.batterHand === input.pitcherThrows) {
    multiplier *= 0.94;
  }

  // Phase 4: tightened cap to reduce upstream probability inflation.
  return Math.min(1.35, multiplier);
}

// Gap 1: pitch mix × handedness HR multiplier.
function computePitchMixHandednessMultiplier(
  pitchMix: PitchMixEntry[],
  batterHand: string | null,
  pitcherThrows: string | null,
): number {
  if (!pitchMix || pitchMix.length === 0) return 1.0;

  let fbPct = 0, breakPct = 0, offspeedPct = 0;
  for (const entry of pitchMix) {
    const family = getPitchFamily(entry.pitchType);
    if (family === "fastball") fbPct += entry.percentage;
    else if (family === "breaking") breakPct += entry.percentage;
    else if (family === "offspeed") offspeedPct += entry.percentage;
  }

  const isOppositeHand = batterHand && pitcherThrows && batterHand !== pitcherThrows;
  const isSameHand = batterHand && pitcherThrows && batterHand === pitcherThrows;

  let mult = 1.0;
  if (fbPct >= 55) {
    mult *= isOppositeHand ? 1.10 : isSameHand ? 1.04 : 1.06;
  }
  if (breakPct >= 45) mult *= 0.92;
  if (offspeedPct >= 35) mult *= 0.95;
  if (fbPct >= 60 && breakPct < 20) mult *= 1.06;

  return Math.min(1.18, Math.max(0.88, mult));
}

// Gap 3: pre-game pitcher fatigue multiplier.
// A starter entering today on short rest or coming off a high-pitch-count
// outing has a structurally elevated HR vulnerability before the first pitch
// is thrown — independent of in-game pitch count tracking.
//
// Rules:
//   - lastStartPitchCount >= 110: +12% (arm not fully recovered)
//   - lastStartPitchCount >= 95:  +7%
//   - daysSinceLastStart <= 3:    +10% (short rest — mechanics degrade)
//   - daysSinceLastStart <= 4:    +5%
//   - daysSinceLastStart >= 8:    -5% (well-rested, arm fresh)
//   - last3StartERA >= 6.0:       +10% (poor recent form)
//   - last3StartERA >= 5.0:       +6%
//   - last3StartERA <= 2.5:       -8% (dominant recent form)
function computePitcherEntryFatigueMultiplier(input: HRConversionInput): number {
  let mult = 1.0;

  const lastPC = input.lastStartPitchCount;
  if (lastPC !== null && lastPC !== undefined) {
    if (lastPC >= 110) mult *= 1.12;
    else if (lastPC >= 95) mult *= 1.07;
  }

  const daysRest = input.daysSinceLastStart;
  if (daysRest !== null && daysRest !== undefined) {
    if (daysRest <= 3) mult *= 1.10;
    else if (daysRest <= 4) mult *= 1.05;
    else if (daysRest >= 8) mult *= 0.95;
  }

  const recentERA = input.last3StartERA;
  if (recentERA !== null && recentERA !== undefined) {
    if (recentERA >= 6.0) mult *= 1.10;
    else if (recentERA >= 5.0) mult *= 1.06;
    else if (recentERA <= 2.5) mult *= 0.92;
  }

  return Math.min(1.30, Math.max(0.90, mult));
}

export function computeHRConversionProbability(input: HRConversionInput): HRConversionResult {
  let baseRate = input.seasonHRRate ?? LEAGUE_AVG_HR_PER_PA;
  if (baseRate <= 0 || baseRate > 0.12) baseRate = LEAGUE_AVG_HR_PER_PA;

  // Gap 5: blend in handedness-specific batter HR rate (30% weight) when
  // sufficient sample exists — more predictive than undifferentiated season rate.
  const batterSplits = input.batterHandednessSplits;
  const pitcherThrows = input.pitcherThrows;
  if (batterSplits && pitcherThrows) {
    const matchupHRRate = pitcherThrows === "L" ? batterSplits.hrRateVsLHP : batterSplits.hrRateVsRHP;
    if (matchupHRRate != null && matchupHRRate > 0 && matchupHRRate <= 0.12) {
      baseRate = 0.70 * baseRate + 0.30 * matchupHRRate;
    }
  }

  const barrelRate = input.barrelRate ?? LEAGUE_AVG_BARREL_RATE;
  const barrelAdj = Math.min(1.5, barrelRate / LEAGUE_AVG_BARREL_RATE);
  baseRate *= 0.6 + 0.4 * barrelAdj;

  // Use xwOBA when available (better contact quality anchor than xSLG alone);
  // fall back to xSLG for the scaling factor.
  const xwoba = input.xwOBA;
  const xslg = input.xSLG;
  if (xwoba != null && xwoba > 0) {
    const xwobaFactor = xwoba / 0.320;   // league avg ~.320
    baseRate *= Math.max(0.70, Math.min(1.55, xwobaFactor));
  } else if (xslg !== null && xslg > 0) {
    const xslgFactor = xslg / 0.400;
    baseRate *= Math.max(0.7, Math.min(1.5, xslgFactor));
  }

  const liveContactMultiplier = computeLiveContactMultiplier(input.factors);
  const liveAdjustedRate = baseRate * liveContactMultiplier;

  const pitcherMultiplier = computePitcherMultiplier(input);
  const pitcherAdjustedRate = liveAdjustedRate * pitcherMultiplier;

  const environmentMultiplier = computeEnvironmentMultiplier(input);
  const envAdjustedRate = pitcherAdjustedRate * environmentMultiplier;

  // Gap 3: pre-game pitcher fatigue. Applied after env to keep multiplier layers
  // orthogonal and auditable in the components log.
  const entryFatigueMultiplier = computePitcherEntryFatigueMultiplier(input);
  const entryAdjustedRate = envAdjustedRate * entryFatigueMultiplier;

  // Gaps 7–9: structural power profile (fly ball%, HR/FB, xISO, xwOBA).
  // Applied last so it modulates the fully-env/pitcher-adjusted rate.
  const powerMultiplier = computePowerProfileMultiplier(input);
  const powerAdjustedRate = entryAdjustedRate * powerMultiplier;

  // Gap 6: lineup slot weight — cleanup hitters structurally produce more HRs.
  const slotMultiplier = computeLineupSlotHRMultiplier(input.battingOrderSlot);
  const slotAdjustedRate = powerAdjustedRate * slotMultiplier;

  // Phase 4: tightened final per-PA cap (0.25 → 0.12) to prevent runaway probabilities.
  const finalPerPARate = Math.max(0.005, Math.min(0.12, slotAdjustedRate));

  const paDist = estimateRichPADistribution(
    input.inning,
    input.battingOrderSlot,
    input.currentRuns,
    input.leagueAvgRuns,
    input.isTopInning
  );

  const expectedPA = Object.entries(paDist).reduce(
    (sum, [k, v]) => sum + Number(k) * v, 0
  );

  let pZeroHR = 0;
  for (const [paCount, paProb] of Object.entries(paDist)) {
    const n = Number(paCount);
    const pZeroGivenN = Math.pow(1 - finalPerPARate, n);
    pZeroHR += paProb * pZeroGivenN;
  }

  const rawProbability = Math.max(0, Math.min(1, 1 - pZeroHR));
  const cal = calibrate(rawProbability);
  const calibratedProbability = cal.value;

  const pitcherDeteriorationState = describePitcherDeteriorationState(input);

  return {
    hrConversionProbability: Math.round(rawProbability * 10000) / 10000,
    calibratedProbability: Math.round(calibratedProbability * 10000) / 10000,
    perPAHRRate: Math.round(finalPerPARate * 10000) / 10000,
    expectedRemainingPA: Math.round(expectedPA * 100) / 100,
    liveContactMultiplier: Math.round(liveContactMultiplier * 100) / 100,
    pitcherMultiplier: Math.round(pitcherMultiplier * 100) / 100,
    environmentMultiplier: Math.round(environmentMultiplier * 100) / 100,
    pitcherDeteriorationState,
    // Phase 4: explicit calibration diagnostics
    rawConversionProbability: Math.round(rawProbability * 10000) / 10000,
    calibratedConversionProbability: Math.round(calibratedProbability * 10000) / 10000,
    calibrationSource: cal.source,
    calibrationBucketLabel: cal.bucketLabel,
    calibrationSampleCount: cal.samples,
    components: {
      baseRate: Math.round(baseRate * 10000) / 10000,
      liveAdjustedRate: Math.round(liveAdjustedRate * 10000) / 10000,
      pitcherAdjustedRate: Math.round(pitcherAdjustedRate * 10000) / 10000,
      envAdjustedRate: Math.round(envAdjustedRate * 10000) / 10000,
      entryAdjustedRate: Math.round(entryAdjustedRate * 10000) / 10000,
      finalPerPARate: Math.round(finalPerPARate * 10000) / 10000,
      paDist,
      pZeroHR: Math.round(pZeroHR * 10000) / 10000,
      rawProbability: Math.round(rawProbability * 10000) / 10000,
    },
  };
}
