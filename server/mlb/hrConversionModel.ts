import type { HRBuildResult, ClassifiedContact } from "./HRSignalBuilder";
import { estimateRichPADistribution } from "./paDistribution";
import type { PitchMixEntry, PitcherHandednessSplits, BatterHandednessSplits } from "./types";
import { getPitchFamily } from "./pitchTypeNormalizer";
import { computeHROverlay } from "./hr/hrOverlay";
import type {
  HROverlayInput,
  HROverlayResult,
  PitchTypeSplit,
  BattingOrderSplit,
} from "./hr/hrOverlayTypes";
import type { SeasonValue } from "./hr/temporalFilter";

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
  // Lane 3.3: recent in-game fastball velocity trend (mph) = avg(last N pitches)
  // − avg(prior N). Negative = velo actively falling now — a fresher decline
  // signal than the whole-game first/second-half `velocityDrop`. Optional —
  // no-op when null.
  veloTrendSlope?: number | null;
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
  // Lane 3.1: relative humidity % (Open-Meteo). Higher humidity → less dense
  // air → ball carries slightly farther. Optional — no-op (1.0) when null.
  humidity?: number | null;
  // Lane 3.2: surface barometric pressure hPa (Open-Meteo). Lower pressure →
  // thinner air → more carry. Optional — no-op (1.0) when null.
  pressure?: number | null;
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
  // SlateRadar gap #6: batter pull rate (% BIP to pull side). Pull-heavy power
  // hitters homer at higher rates. Optional — no-op (1.0) when null.
  pullRatePercent?: number | null;
  // Recent form: HR-rate streak + AVG/OPS form. A hot slugger should carry a
  // higher per-PA HR rate than an identical-profile cold one. Optional — no-op
  // (1.0) when absent.
  hrRateLast7?: number | null;
  hrRateLast15?: number | null;
  hrRateLast30?: number | null;
  recentOps?: number | null;   // L15 OPS
  seasonOps?: number | null;
  // Intentional-walk "feared slugger" prior (positive-only). Season IBB rate is
  // the standing respect signal; the in-game base/out context confirms it in a
  // high-leverage spot. Optional — no-op (1.0) when absent.
  seasonIBBRate?: number | null;   // IBB / PA
  firstBaseOpen?: boolean | null;
  runnerInScoringPosition?: boolean | null;
  scoreDifferential?: number | null;
  // Consolidated HR overlay (Ω) — supersedes the legacy power / lineup-slot /
  // recent-form multipliers. All inputs below are optional and no-op when
  // absent. Statcast/launch/recency fields reuse the existing inputs above;
  // these add the genuinely-new data the overlay consumes (typically null
  // until Phase 2 ingestion lands).
  exitVelocity?: number | null;
  xwOBAcon?: number | null;
  maxEV?: number | null;
  toppedPct?: number | null;
  recentSlg?: number | null;
  seasonSlg?: number | null;
  overallSlg?: number | null;
  barrelPerPA?: number | null;
  barrelPerPABySeason?: SeasonValue[] | null;
  batterPitchSplits?: PitchTypeSplit[] | null;
  orderSplits?: BattingOrderSplit[] | null;
  totalPA2024to2026?: number | null;
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
  // Consolidated HR overlay result (supersedes legacy power/slot/recent-form).
  overlay: HROverlayResult;
  // Phase 4 calibration diagnostics
  rawConversionProbability: number;
  calibratedConversionProbability: number;
  calibrationSource: "static_table" | "empirical_buckets";
  calibrationBucketLabel: string | null;
  calibrationSampleCount: number;
  components: {
    pregameFormScore: number;
    pregamePriorMult: number;
    baseRate: number;
    hardHitInteractionMult: number;
    liveAdjustedRate: number;
    pitcherAdjustedRate: number;
    envAdjustedRate: number;
    entryAdjustedRate: number;
    overlayMultiplier: number;
    ibbRespectMult: number;
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

// Lane 2.1 — single source of truth for calibration bin edges. The analytics
// empirical-bucket builder (server/analytics/hrRadarIntelligence.ts) imports
// this exact array so empirical buckets align 1:1 with the static table bins.
// Keep CALIBRATION_TABLE's [rawMin,rawMax) boundaries in lock-step with these.
export const CALIBRATION_BIN_EDGES: readonly number[] = [
  0.00, 0.03, 0.05, 0.08, 0.10, 0.13, 0.16, 0.20, 0.25, 0.30, 0.40, 1.00,
];

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

// ── Phase 3 — hard-hit × angle × bat-speed × IBB interaction booster ────────
// Real-world truth: a hard-hit ball OR a high-xBA ball is *much* more likely to
// be a HR when it co-occurs with a favorable launch angle, elite bat speed, or a
// feared-slugger (IBB) profile. The independent EV/xBA/LA/bat-speed/IBB terms in
// the model are additive and under-reward that co-occurrence, so this applies a
// small MULTIPLICATIVE interaction on top. Additive + no-op when the trigger
// isn't present or inputs are absent; capped at 1.25× so it can never breach the
// Phase 1.5 final per-PA clamp (§7a #4). Pure.
const HHI_HARD_HIT_EV = 104;        // peak EV that counts as "hard hit"
const HHI_HIGH_XBA = 0.65;          // in-game peak per-AB xBA that counts as "high"
const HHI_LA_SWEET_LOW = 20;
const HHI_LA_SWEET_HIGH = 35;
const HHI_ELITE_BAT_SPEED_MPH = 75; // user spec: >70 good, elite ~75+
const HHI_GOOD_BAT_SPEED_MPH = 72;

export function computeHardHitInteractionMultiplier(input: HRConversionInput): number {
  const f = input.factors;
  const classified = f.contactClasses;
  if (!classified || classified.length === 0) return 1.0;

  // 1. Trigger — a hard-hit OR high-xBA ball this game (peak across contact).
  const peakEV = f.maxEV ?? f.qualifiedEVMean ?? 0;
  const peakXBA = f.maxXBA ?? 0;
  const hardHit = peakEV >= HHI_HARD_HIT_EV;
  const highXba = peakXBA >= HHI_HIGH_XBA;
  if (!hardHit && !highXba) return 1.0;

  // 2. Favorable-angle co-occurrence — was a damage ball struck at a HR-sweet
  //    launch angle? (the hard-hit/barreled contact specifically, not any ball)
  let favorableAngle = false;
  for (const c of classified) {
    const ev = c.exitVelocity ?? 0;
    const la = c.launchAngle;
    const carriesTrigger = ev >= HHI_HARD_HIT_EV || c.isBarrel;
    if (carriesTrigger && la != null && la >= HHI_LA_SWEET_LOW && la <= HHI_LA_SWEET_HIGH) {
      favorableAngle = true;
      break;
    }
  }

  // Base interaction — hard-hit AND high-xBA together is the strongest signal.
  let mult = (hardHit && highXba) ? 1.10 : 1.06;

  // 3. Amplifiers — favorable angle, elite bat speed, feared-slugger IBB.
  if (favorableAngle) mult *= 1.05;
  const batSpeed = f.batSpeedMph;
  if (batSpeed != null) {
    if (batSpeed >= HHI_ELITE_BAT_SPEED_MPH) mult *= 1.05;
    else if (batSpeed >= HHI_GOOD_BAT_SPEED_MPH) mult *= 1.02;
  }
  const ibb = input.seasonIBBRate ?? 0;
  if (ibb >= 0.02) mult *= 1.04;
  else if (ibb >= 0.01) mult *= 1.02;

  return Math.min(1.25, mult);
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
// Build the overlay's input view from the conversion input. Existing engine
// fields are mapped onto the overlay's sub-engine inputs; genuinely-new data
// (pitch-type splits, order splits, recent SLG, Topped%, MaxEV) flows through
// optional fields and no-ops when absent. `pullRatePercent` is the best
// available proxy for Pull AIR% until Phase 2 ingestion adds the true metric.
function buildOverlayInput(input: HRConversionInput): HROverlayInput {
  return {
    barrelPerPA: input.barrelPerPA ?? null,
    barrelPerPABySeason: input.barrelPerPABySeason ?? null,
    barrelRate: input.barrelRate ?? null,
    exitVelocity: input.exitVelocity ?? null,
    sweetSpotPct: input.sweetSpotPercent ?? null,
    xwOBAcon: input.xwOBAcon ?? null,
    xwOBA: input.xwOBA ?? null,
    pitchMix: input.pitchMix ?? null,
    batterPitchSplits: input.batterPitchSplits ?? null,
    flyBallPct: input.flyBallPercent ?? null,
    pullAirPct: input.pullRatePercent ?? null,
    battingOrderSlot: input.battingOrderSlot ?? null,
    orderSplits: input.orderSplits ?? null,
    overallSlg: input.overallSlg ?? input.xSLG ?? null,
    recentSlg: input.recentSlg ?? null,
    recentOps: input.recentOps ?? null,
    seasonSlg: input.seasonSlg ?? null,
    seasonOps: input.seasonOps ?? null,
    hrRateLast7: input.hrRateLast7 ?? null,
    hrRateLast15: input.hrRateLast15 ?? null,
    seasonHRRate: input.seasonHRRate ?? null,
    maxEV: input.maxEV ?? input.factors?.maxEV ?? null,
    toppedPct: input.toppedPct ?? null,
    totalPA2024to2026: input.totalPA2024to2026 ?? null,
  };
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

    // Lane 3.3: recent velocity-decay TREND (last N pitches vs prior N). A
    // negative slope means the pitcher is losing velo right now — fresher than
    // the whole-game velocityDrop above. Small, under the Math.min(2.0) cap.
    if (det.veloTrendSlope != null) {
      if (det.veloTrendSlope <= -2.0) multiplier *= 1.10;
      else if (det.veloTrendSlope <= -1.0) multiplier *= 1.06;
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

    // Lane 3.1: humidity. Humid air is less dense → marginally more carry.
    // Small, capped by the env Math.min(1.35) below. No-op when null.
    const humidity = input.humidity;
    if (humidity != null) {
      if (humidity >= 85) multiplier *= 1.05;
      else if (humidity >= 70) multiplier *= 1.03;
      else if (humidity <= 30) multiplier *= 0.98;
    }

    // Lane 3.2: barometric pressure. Low pressure → thinner air → more carry.
    // Sea-level avg ≈ 1013 hPa. No-op when null.
    const pressure = input.pressure;
    if (pressure != null) {
      if (pressure <= 1000) multiplier *= 1.04;
      else if (pressure >= 1025) multiplier *= 0.97;
    }
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

// Recent form multiplier — a batter's hot/cold streak.
// Two orthogonal signals, combined multiplicatively:
//   1. HR-rate streak: blended recent HR rate (0.4*L7 + 0.6*L15, skipping nulls)
//      relative to season HR rate. A hot run pulls the per-PA rate up; a cold
//      stretch pulls it down (regression cuts both ways).
//   2. AVG/OPS form: recent (L15) OPS relative to season OPS — broader contact
//      form independent of HR specifically.
// Capped [0.90, 1.15]; no-op (1.0) when neither signal has data.
// Intentional-walk "feared slugger" prior — positive-only (floor 1.0).
// Batters who draw intentional walks are, by definition, treated as power
// threats. We model this as a standing season prior plus an in-game leverage
// confirmation; we never SUPPRESS opportunity (product decision: feared-slugger
// prior only). Capped [1.0, 1.10]; no-op (1.0) when absent.
function computeIbbRespectMultiplier(input: HRConversionInput): number {
  let mult = 1.0;

  // Season IBB rate (IBB / PA). League avg is ~0.4%; elite feared sluggers run
  // 2–4%+. Higher rate ⇒ more respect ⇒ stronger HR threat.
  const ibbRate = input.seasonIBBRate;
  if (ibbRate != null && ibbRate > 0) {
    if (ibbRate >= 0.030) mult *= 1.06;
    else if (ibbRate >= 0.020) mult *= 1.04;
    else if (ibbRate >= 0.010) mult *= 1.02;
  }

  // In-game IBB-risk respect context: first base open, runner in scoring
  // position, close game, late innings — the classic spot a dangerous bat gets
  // pitched around. Gated so we only reward genuine threats (high IBB rate or a
  // cleanup-slot bat), never an average hitter who happens to be in the spot.
  const firstBaseOpen = input.firstBaseOpen === true;
  const risp = input.runnerInScoringPosition === true;
  const scoreDiff = input.scoreDifferential;
  const closeGame = scoreDiff != null && Math.abs(scoreDiff) <= 2;
  const lateGame = input.inning >= 6;
  const isThreat = (ibbRate != null && ibbRate >= 0.010) ||
    (input.battingOrderSlot >= 3 && input.battingOrderSlot <= 5);
  if (firstBaseOpen && risp && isThreat) {
    if (closeGame && lateGame) mult *= 1.04;
    else mult *= 1.02;
  }

  return Math.min(1.10, Math.max(1.0, mult));
}

// ── SlateRadar gap #7 — pregame HR-form prior ──────────────────────────────
// Flag-gated (default on). A genuine power threat should carry a non-zero HR
// estimate INTO his first AB so we stop missing first-AB HRs
// (early_hr_no_window). The prior nudges baseRate from the season power profile
// and DECAYS to zero as live in-game contact accumulates, so existing in-game
// graded signals are unchanged (no drift on live signals). Engine-internal —
// never surfaced as a user-facing payload field.
const HR_PREGAME_PRIOR: boolean = (() => {
  const raw = (process.env.HR_PREGAME_PRIOR ?? "").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") return false;
  return true;
})();

/**
 * Blend the season power profile into a 0–100 pregame HR-form score. Uses only
 * fields already on HRConversionInput; returns a neutral 50 when no profile data
 * is present. Pure, no I/O.
 */
export function computePregameHrFormScore(input: HRConversionInput): number {
  let s = 50;
  let n = 0;
  const hrFB = input.hrFBRatio;
  if (hrFB != null) { s += hrFB >= 18 ? 12 : hrFB >= 14 ? 7 : hrFB >= 11 ? 2 : hrFB <= 8 ? -8 : -2; n++; }
  const fb = input.flyBallPercent;
  if (fb != null) { s += fb >= 42 ? 8 : fb >= 38 ? 4 : fb <= 28 ? -6 : 0; n++; }
  const pull = input.pullRatePercent;
  if (pull != null) { s += pull >= 48 ? 8 : pull >= 43 ? 4 : pull <= 32 ? -4 : 0; n++; }
  const xiso = input.xISO;
  if (xiso != null) { s += xiso >= 0.220 ? 10 : xiso >= 0.180 ? 5 : xiso <= 0.100 ? -8 : 0; n++; }
  const xwoba = input.xwOBA;
  if (xwoba != null) { s += xwoba >= 0.380 ? 6 : xwoba >= 0.340 ? 3 : xwoba <= 0.300 ? -5 : 0; n++; }
  const park = input.parkFactor;
  if (park != null) { s += park >= 1.10 ? 5 : park >= 1.05 ? 2 : park <= 0.92 ? -4 : 0; }
  const bs = input.batterHandednessSplits;
  const pt = input.pitcherThrows;
  if (bs && pt) {
    const r = pt === "L" ? bs.hrRateVsLHP : bs.hrRateVsRHP;
    if (r != null) { s += r >= 0.05 ? 6 : r >= 0.035 ? 2 : r <= 0.02 ? -4 : 0; }
  }
  if (n === 0) return 50;
  return Math.max(0, Math.min(100, s));
}

// Map the 0–100 pregame form score to a small capped multiplier on baseRate.
// Center (50) → 1.0; elite (~90) → ~1.14; cold (~20) → ~0.90.
function pregamePriorMultiplier(score: number): number {
  return Math.max(0.92, Math.min(1.15, 1 + (score - 50) * 0.0035));
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

  // SlateRadar gap #7: pregame HR-form prior. Full weight pre-contact, decaying
  // to zero as hrBuildScore (live in-game contact) accumulates — so strong live
  // signals are unchanged but pre/early-AB power threats carry a real estimate.
  let pregameFormScore = 50;
  let pregamePriorMult = 1.0;
  if (HR_PREGAME_PRIOR) {
    pregameFormScore = computePregameHrFormScore(input);
    const fullMult = pregamePriorMultiplier(pregameFormScore);
    const liveness = Math.min(1, Math.max(0, (input.hrBuildScore ?? 0) / 4));
    pregamePriorMult = 1 + (fullMult - 1) * (1 - liveness);
    baseRate *= pregamePriorMult;
  }

  const liveContactMultiplier = computeLiveContactMultiplier(input.factors);
  // Phase 3 — multiplicative interaction booster (hard-hit/high-xBA × angle ×
  // bat speed × IBB). No-op (1.0) when the trigger or inputs are absent.
  const hardHitInteractionMult = computeHardHitInteractionMultiplier(input);
  const liveAdjustedRate = baseRate * liveContactMultiplier * hardHitInteractionMult;

  const pitcherMultiplier = computePitcherMultiplier(input);
  const pitcherAdjustedRate = liveAdjustedRate * pitcherMultiplier;

  const environmentMultiplier = computeEnvironmentMultiplier(input);
  const envAdjustedRate = pitcherAdjustedRate * environmentMultiplier;

  // Gap 3: pre-game pitcher fatigue. Applied after env to keep multiplier layers
  // orthogonal and auditable in the components log.
  const entryFatigueMultiplier = computePitcherEntryFatigueMultiplier(input);
  const entryAdjustedRate = envAdjustedRate * entryFatigueMultiplier;

  // Consolidated HR overlay (Ω) — supersedes the legacy power-profile,
  // lineup-slot, and recent-form multipliers with a single capped, additive
  // multiplier built from the Ψ/Γ/Λ/Θ/Δ sub-engines and the soft contact gate.
  // No-op (~1.0) when overlay inputs are absent. Applied here so it modulates
  // the fully env/pitcher-adjusted rate, exactly where the three legacy
  // multipliers used to bind.
  const overlay = computeHROverlay(buildOverlayInput(input));
  const overlayAdjustedRate = entryAdjustedRate * overlay.overlayMultiplier;

  const ibbRespectMult = computeIbbRespectMultiplier(input);
  const ibbAdjustedRate = overlayAdjustedRate * ibbRespectMult;

  // Phase 4: tightened final per-PA cap (0.25 → 0.12) to prevent runaway probabilities.
  const finalPerPARate = Math.max(0.005, Math.min(0.12, ibbAdjustedRate));

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
    overlay,
    // Phase 4: explicit calibration diagnostics
    rawConversionProbability: Math.round(rawProbability * 10000) / 10000,
    calibratedConversionProbability: Math.round(calibratedProbability * 10000) / 10000,
    calibrationSource: cal.source,
    calibrationBucketLabel: cal.bucketLabel,
    calibrationSampleCount: cal.samples,
    components: {
      pregameFormScore: Math.round(pregameFormScore * 10) / 10,
      pregamePriorMult: Math.round(pregamePriorMult * 1000) / 1000,
      baseRate: Math.round(baseRate * 10000) / 10000,
      hardHitInteractionMult: Math.round(hardHitInteractionMult * 1000) / 1000,
      liveAdjustedRate: Math.round(liveAdjustedRate * 10000) / 10000,
      pitcherAdjustedRate: Math.round(pitcherAdjustedRate * 10000) / 10000,
      envAdjustedRate: Math.round(envAdjustedRate * 10000) / 10000,
      entryAdjustedRate: Math.round(entryAdjustedRate * 10000) / 10000,
      overlayMultiplier: overlay.overlayMultiplier,
      ibbRespectMult: Math.round(ibbRespectMult * 1000) / 1000,
      finalPerPARate: Math.round(finalPerPARate * 10000) / 10000,
      paDist,
      pZeroHR: Math.round(pZeroHR * 10000) / 10000,
      rawProbability: Math.round(rawProbability * 10000) / 10000,
    },
  };
}
