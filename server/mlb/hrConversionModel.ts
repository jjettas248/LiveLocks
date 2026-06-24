import type { HRBuildResult, ClassifiedContact } from "./HRSignalBuilder";
import { estimateRichPADistribution } from "./paDistribution";
import type { PitchMixEntry, PitcherHandednessSplits, BatterHandednessSplits } from "./types";
import { getPitchFamily } from "./pitchTypeNormalizer";
import { computeHROverlay } from "./hr/hrOverlay";
import type { HROverlayResult, SeasonStatBundle, PitchTypeBatterSplit } from "./hr/hrOverlayTypes";
import { PREGAME_SEED_CAP } from "@shared/hrRadarConviction";
import { computePlayerParkWindFit } from "./parkWindFit";

export type { SeasonStatBundle, PitchTypeBatterSplit };

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
  // Player-specific park/wind fit (shared parkWindFit module). All optional and
  // no-op when absent → a missing venue / wind sector / spray profile collapses
  // the fit to a neutral 1.0, so partial data never destabilizes runtime. These
  // refine the generic environment term into a hand- and pull-aware modifier.
  venueName?: string | null;        // canonical park name (registry + orientation)
  windString?: string | null;       // MLB feed raw wind text, e.g. "12 mph, Out To LF"
  windDegrees?: number | null;      // meteorological wind bearing (Open-Meteo)
  fieldOrientation?: number | null; // home-plate→CF bearing override
  batterArchetype?: string | null;  // spray fallback when pull% missing
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

  // Consolidated overlay inputs (all optional — no-op when absent).
  // Overlay supersedes powerMultiplier × slotMultiplier × recentFormMult.
  maxEV?: number | null;                         // avg/max exit velocity, mph
  toppedPercent?: number | null;                 // Topped% (Phase 2 data)
  seasonSLG?: number | null;                     // season SLG baseline for Δ
  recentSLG?: number | null;                     // L15–L30 SLG for Δ
  battingOrderSlgSplit?: number | null;          // slot-specific SLG (Phase 2)
  seasonBundles?: SeasonStatBundle[] | null;     // multi-season triad (Phase 2)
  pitchTypeSplits?: PitchTypeBatterSplit[] | null; // batter pitch-type damage (Phase 2)
}

export interface HRConversionResult {
  hrConversionProbability: number;
  calibratedProbability: number;
  // HR occurrence contract (2026-06) — P(HR >= 1), post evidence-rail cap.
  // Equals calibratedProbability; named explicitly so HR Radar consumers read
  // an unambiguous occurrence probability (never a side-dependent value).
  hrOccurrenceProbability: number;
  occurrenceEvidenceQuality: BatterEvidenceQuality;
  occurrenceCeiling: number;
  preCapCalibratedProbability: number;
  calibrationRailBlocked: boolean;
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
  // Consolidated overlay result (Ψ/Γ/Λ/Θ/Δ sub-engines + soft gate).
  // Intentional payload shape change — goldmaster re-baselined to v8.
  overlay: HROverlayResult;
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
  // Audit fix C3 — the top bins were over-compressed: attack/STRONG calls
  // realized ~57–67% but calibrated probability was ceilinged at 0.38, leaving
  // the model badly under-confident exactly where it commits. Lift the top two
  // bins toward the observed rate. The final per-PA clamp (0.12, §7a #4) and the
  // empirical buckets (C4) still bind above this static fallback.
  { rawMin: 0.30, rawMax: 0.40, calibrated: 0.36 },
  { rawMin: 0.40, rawMax: 1.00, calibrated: 0.46 },
];

// Audit fix (2026-06-25) — hard ceiling on the *empirical* calibrated value.
// A per-PA-window HR conversion probability is physically bounded well below 1:
// even an elite slugger (~12% per-PA, the §7a #4 clamp) over ~3 remaining PA
// tops out at 1-(0.88)^3 ≈ 0.32 raw, and the curated static table caps belief at
// 0.46. Empirical buckets must only *refine within* that plausible band — never
// invert the model. Without this guard a selection-biased, near-all-positive bin
// (mostly `uncalled_hr`, almost no graded `called_miss` under FIRE-only grading)
// drove Laplace `(cashed+1)/(n+2)` to ~0.95, which then pegged readiness to ~100
// and tripped every FIRE/HR-max-window grading gate. 0.50 sits just above the
// static max so genuine upward refinement is still allowed, impossible values are
// not. The static table (≤0.46) already lives under this ceiling — untouched.
export const EMPIRICAL_CALIBRATION_CEILING = 0.50;

function calibrate(rawProb: number): { value: number; source: "static_table" | "empirical_buckets"; bucketLabel: string | null; samples: number } {
  // Phase 4: prefer empirical buckets when available; fall back to static table.
  if (EMPIRICAL_BUCKETS.length > 0) {
    const eb = EMPIRICAL_BUCKETS.find(b => rawProb >= b.min && rawProb < b.max);
    if (eb) {
      return {
        value: Math.min(EMPIRICAL_CALIBRATION_CEILING, eb.calibrated),
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
    value: rawProb >= 0.40 ? 0.46 : 0.01,
    source: "static_table",
    bucketLabel: null,
    samples: 0,
  };
}

// ── Batter-side evidence quality (2026-06) ──────────────────────────────────
// Classifies how much FRESH in-game batter contact evidence exists, used to
// rail the calibrated HR-occurrence probability (and, upstream, to gate
// promotion). Pure; tolerant of partial/absent factors. NOT a function of any
// sportsbook line/odds/edge — purely baseball contact evidence.
export type BatterEvidenceQuality = "elite" | "fresh" | "none";

// Caps are env-configurable (safe defaults). A value is only honored when it
// parses to a probability in (0, 1]; anything else falls back to the default so
// a bad env var can never disable the rail.
function occurrenceCapFromEnv(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : def;
}

export const OCCURRENCE_CEILING: Record<BatterEvidenceQuality, number> = {
  elite: occurrenceCapFromEnv("HR_OCCURRENCE_CAP_ELITE", 0.60),
  fresh: occurrenceCapFromEnv("HR_OCCURRENCE_CAP_FRESH", 0.45),
  none: occurrenceCapFromEnv("HR_OCCURRENCE_CAP_NONE", 0.35),
};

export function classifyBatterEvidenceQuality(
  factors: HRBuildResult["factors"] | null | undefined,
): BatterEvidenceQuality {
  if (!factors) return "none";
  const hrShaped = factors.hrShapedCount ?? 0;
  const missedHr = factors.missedHrCount ?? 0;   // near-HR (barrel that stayed in park)
  const eliteHr = factors.eliteHrCount ?? 0;
  const evMean = factors.qualifiedEVMean ?? 0;
  const maxDist = factors.maxDistance ?? 0;
  // Elite: a near-HR / elite-shaped contact, multiple HR-shaped balls, a 390ft+
  // blast, or a sustained 104+ EV mean — genuine top-end power evidence.
  if (eliteHr >= 1 || missedHr >= 1 || hrShaped >= 2 || maxDist >= 390 || evMean >= 104) {
    return "elite";
  }
  // Fresh: at least one HR-shaped ball, a 350ft+ drive, or solid 97+ EV mean.
  if (hrShaped >= 1 || maxDist >= 350 || evMean >= 97) {
    return "fresh";
  }
  // None: no qualified hard contact this game (pitcher context cannot rail HR%).
  return "none";
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

  // SlateRadar gap #6: pull rate. Pull-side power clears fences more often; a
  // short pull-side porch (handedness park split) amplifies it. League pull
  // rate on BIP is ~40%. Capped, no-op when null.
  const pull = input.pullRatePercent;
  if (pull != null) {
    const parkHrBias = (input.parkFactor ?? 1.0) >= 1.05;
    if (pull >= 48) mult *= parkHrBias ? 1.10 : 1.07;
    else if (pull >= 43) mult *= parkHrBias ? 1.05 : 1.03;
    else if (pull <= 32) mult *= 0.95;
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
    if (input.windDirection === "out" && ws >= 18) multiplier *= 1.22;
    else if (input.windDirection === "out" && ws >= 12) multiplier *= 1.15;
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

  // Gap 1: pitch mix × handedness model. HR occurrence engine (2026-06):
  // handedness/platoon advantage requires BOTH the batter's bat side AND the
  // pitcher's throwing hand to be known. If either is unknown, stay NEUTRAL
  // (no matchup/platoon boost or penalty) so the deterministic HR score is not
  // inflated by fake matchup confidence.
  if (input.batterHand == null || input.pitcherThrows == null) {
    console.log(
      `[MLB_HANDEDNESS_UNKNOWN_NEUTRALIZED] pitcherThrows=${input.pitcherThrows ?? "null"} ` +
      `batterHand=${input.batterHand ?? "null"} — handedness neutral (no platoon boost)`,
    );
  } else if (input.pitchMix && input.pitchMix.length > 0) {
    multiplier *= computePitchMixHandednessMultiplier(input.pitchMix, input.batterHand, input.pitcherThrows);
  } else if (input.batterHand !== input.pitcherThrows) {
    multiplier *= 1.06;
  } else {
    multiplier *= 0.94;
  }

  // Player-specific park/wind fit (shared parkWindFit module). A BOUNDED
  // supporting modifier on top of the generic wind/park terms above — it makes
  // the env aware of whether the wind sector + park geometry actually fit THIS
  // hitter's hand and pull profile, rather than treating "wind out" as equal for
  // everyone. Neutral (1.0) when venue/wind/spray data is missing, so it never
  // destabilizes runtime and leaves the goldmaster baseline untouched. It feeds
  // PROBABILITY only — it is never a qualifying/contact HR driver, so it can
  // never satisfy the FIRE gate on its own.
  const parkWindFit = computePlayerParkWindFit({
    venueName: input.venueName,
    batterHand: input.batterHand,
    pullRatePercent: input.pullRatePercent,
    batterArchetype: input.batterArchetype,
    windString: input.windString,
    windDegrees: input.windDegrees,
    windDirectionCoarse: input.windDirection as ("in" | "out" | "cross" | "calm" | null),
    windSpeedMph: input.windSpeed,
    fieldOrientation: input.fieldOrientation,
    isIndoors: input.isIndoors,
  });
  multiplier *= parkWindFit.fitMultiplier;

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
function computeRecentFormMultiplier(input: HRConversionInput): number {
  let mult = 1.0;

  // HR-rate streak vs season.
  const season = input.seasonHRRate;
  if (season != null && season > 0) {
    const l7 = input.hrRateLast7;
    const l15 = input.hrRateLast15;
    let recent: number | null = null;
    if (l7 != null && l15 != null) recent = 0.4 * l7 + 0.6 * l15;
    else if (l15 != null) recent = l15;
    else if (l7 != null) recent = l7;
    if (recent != null) {
      const ratio = recent / season;
      if (ratio >= 1.8) mult *= 1.08;
      else if (ratio >= 1.4) mult *= 1.05;
      else if (ratio <= 0.4) mult *= 0.93;
      else if (ratio <= 0.7) mult *= 0.97;
    }
  }

  // Broader AVG/OPS form: recent L15 OPS vs season OPS.
  const recentOps = input.recentOps;
  const seasonOps = input.seasonOps;
  if (recentOps != null && seasonOps != null && seasonOps > 0) {
    const opsRatio = recentOps / seasonOps;
    if (opsRatio >= 1.15) mult *= 1.05;
    else if (opsRatio >= 1.07) mult *= 1.02;
    else if (opsRatio <= 0.85) mult *= 0.95;
    else if (opsRatio <= 0.93) mult *= 0.98;
  }

  return Math.min(1.15, Math.max(0.90, mult));
}

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
// Feature flag: HR_PREGAME_PRIOR
//   Purpose: enables the pregame power-profile prior (decays to zero as live
//     contact accumulates). Default ON; set env to false/0/off/no to disable.
//   Retirement: once validated against a full season of graded outcomes, fold
//     the prior in permanently and remove this flag.
const HR_PREGAME_PRIOR: boolean = (() => {
  const raw = (process.env.HR_PREGAME_PRIOR ?? "").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") return false;
  return true;
})();

/**
 * Pregame HR-form breakdown: the 0–100 form score PLUS the human-readable
 * "why" drivers that pushed it above neutral. Single source of truth so the
 * score and its explanation can never drift. Uses only fields already on
 * HRConversionInput; returns a neutral 50 / empty drivers when no profile data
 * is present. Pure, no I/O. Drivers are positive-only (what makes this a
 * threat) and ordered by descending contribution for clean chip truncation.
 */
export function computePregameHrFormBreakdown(input: HRConversionInput): {
  score: number;
  drivers: string[];
  hasProfile: boolean;
} {
  let s = 50;
  let n = 0;
  // Collect (contribution, label) for positive drivers so we can rank them.
  const pos: Array<{ pts: number; label: string }> = [];
  const hrFB = input.hrFBRatio;
  if (hrFB != null) {
    const d = hrFB >= 18 ? 12 : hrFB >= 14 ? 7 : hrFB >= 11 ? 2 : hrFB <= 8 ? -8 : -2;
    s += d; n++;
    if (d >= 7) pos.push({ pts: d, label: hrFB >= 18 ? "Elite HR/FB" : "Strong HR/FB" });
  }
  const fb = input.flyBallPercent;
  if (fb != null) {
    const d = fb >= 42 ? 8 : fb >= 38 ? 4 : fb <= 28 ? -6 : 0;
    s += d; n++;
    if (d >= 4) pos.push({ pts: d, label: "Fly-ball lean" });
  }
  const pull = input.pullRatePercent;
  if (pull != null) {
    const d = pull >= 48 ? 8 : pull >= 43 ? 4 : pull <= 32 ? -4 : 0;
    s += d; n++;
    if (d >= 4) pos.push({ pts: d, label: "Pull power" });
  }
  const xiso = input.xISO;
  if (xiso != null) {
    const d = xiso >= 0.220 ? 10 : xiso >= 0.180 ? 5 : xiso <= 0.100 ? -8 : 0;
    s += d; n++;
    if (d >= 5) pos.push({ pts: d, label: xiso >= 0.220 ? "Elite xISO" : "Strong xISO" });
  }
  const xwoba = input.xwOBA;
  if (xwoba != null) {
    const d = xwoba >= 0.380 ? 6 : xwoba >= 0.340 ? 3 : xwoba <= 0.300 ? -5 : 0;
    s += d; n++;
    if (d >= 3) pos.push({ pts: d, label: "Strong xwOBA" });
  }
  const park = input.parkFactor;
  if (park != null) {
    const d = park >= 1.10 ? 5 : park >= 1.05 ? 2 : park <= 0.92 ? -4 : 0;
    s += d;
    if (d >= 2) pos.push({ pts: d, label: "Hitter park" });
  }
  const bs = input.batterHandednessSplits;
  const pt = input.pitcherThrows;
  if (bs && pt) {
    const r = pt === "L" ? bs.hrRateVsLHP : bs.hrRateVsRHP;
    if (r != null) {
      const d = r >= 0.05 ? 6 : r >= 0.035 ? 2 : r <= 0.02 ? -4 : 0;
      s += d;
      if (d >= 2) pos.push({ pts: d, label: "Matchup edge" });
    }
  }
  pos.sort((a, b) => b.pts - a.pts);
  return {
    score: n === 0 ? 50 : Math.max(0, Math.min(100, s)),
    drivers: pos.map(p => p.label),
    hasProfile: n > 0,
  };
}

/**
 * Blend the season power profile into a 0–100 pregame HR-form score. Thin
 * wrapper over computePregameHrFormBreakdown for callers that only need the
 * number. Pure, no I/O.
 */
export function computePregameHrFormScore(input: HRConversionInput): number {
  return computePregameHrFormBreakdown(input).score;
}

// Presence-floor eligibility thresholds — kept in lockstep with the orchestrator's
// PRESENCE_FLOOR_* constants so the seed nudges match the eligibility gate.
const SEED_SEASON_HR_RATE_FLOOR = 0.025;
const SEED_HR_RATE_L30_FLOOR = 0.030;
const SEED_BARREL_RATE_FLOOR = 0.090;

export interface PregameSeedEligibility {
  lineupSlot?: number | null;
  seasonHRRate?: number | null;
  hrRateLast30?: number | null;
  barrelRate?: number | null;
  isHotHitter?: boolean | null;
}

/**
 * Pregame seed: blend the season power profile (form breakdown) into a non-zero
 * 0–100 readiness floor PLUS the "why" drivers, so a pre-contact card reflects
 * the batter instead of a bare 0.0. Optional eligibility signals (slot / season
 * HR / L30 / barrel / hot streak) add display drivers and a small capped nudge —
 * additive and no-op when absent, so callers without rolling stats still get a
 * clean form-only seed. Clamped to PREGAME_SEED_CAP, which sits BELOW the in-game
 * ready/attack bands: a pure seed never fires a signal and never affects grading.
 * Pure, no I/O. Single source of truth for every pre-contact HR-radar row.
 */
export function computePregameSeed(
  input: HRConversionInput,
  eligibility: PregameSeedEligibility = {},
): { seedScore: number; formScore: number; drivers: string[] } {
  const formBreakdown = computePregameHrFormBreakdown(input);

  let seed = 25 + (formBreakdown.score - 50) * 0.6;
  const drivers = [...formBreakdown.drivers];

  const { lineupSlot, seasonHRRate, hrRateLast30, barrelRate, isHotHitter } = eligibility;
  if (lineupSlot != null && lineupSlot >= 1 && lineupSlot <= 3) drivers.push(`Slot ${lineupSlot}`);
  if (seasonHRRate != null && seasonHRRate >= 0.045) { seed += 6; drivers.push("Power bat"); }
  else if (seasonHRRate != null && seasonHRRate >= SEED_SEASON_HR_RATE_FLOOR) { seed += 3; }
  if (hrRateLast30 != null && hrRateLast30 >= 0.05) { seed += 5; drivers.push("Hot L30"); }
  else if (hrRateLast30 != null && hrRateLast30 >= SEED_HR_RATE_L30_FLOOR) { seed += 2; }
  if (barrelRate != null && barrelRate >= 0.12) { seed += 5; drivers.push("Elite barrel"); }
  else if (barrelRate != null && barrelRate >= SEED_BARREL_RATE_FLOOR) { seed += 2; }
  if (isHotHitter) drivers.push("Recent HRs");

  const seedScore = Math.max(0, Math.min(PREGAME_SEED_CAP, Math.round(seed)));
  // De-dup while preserving order; keep the top 4 for clean chip display.
  const dedupedDrivers = Array.from(new Set(drivers)).slice(0, 4);

  return { seedScore, formScore: formBreakdown.score, drivers: dedupedDrivers };
}

// ── Pregame HR-prior score (coverage-only; spec §2.3, 2026-07) ─────────────
// A SEPARATE, more specific weighted composition than computePregameSeed()
// above. computePregameSeed feeds the 0-100 DISPLAY readiness number (still
// authoritative, still capped at PREGAME_SEED_CAP=55). This function feeds a
// PROMOTION DECISION only — Watchlist/Lean radar coverage, never Playable/
// Attack — on an independent 0-1 scale per the product spec's exact weights.
// Pure, no I/O. Missing component inputs are NEUTRAL (0.5), never zero-
// suppressed, and reported in `missingInputs` for diagnostics.
export interface PregameHrPriorResult {
  priorScore: number; // 0-1
  componentScores: {
    batterPower: number;
    pitcherHrVulnerability: number;
    parkWeatherBoost: number;
    lineupOpportunity: number;
    handednessMatchup: number;
    recentPowerForm: number;
  };
  missingInputs: string[];
  drivers: string[];
}

const PREGAME_PRIOR_WEIGHTS = {
  batterPower: 0.35,
  pitcherHrVulnerability: 0.20,
  parkWeatherBoost: 0.15,
  lineupOpportunity: 0.10,
  handednessMatchup: 0.10,
  recentPowerForm: 0.10,
} as const;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function scoreBatterPower(input: HRConversionInput): number | null {
  const parts: number[] = [];
  if (input.seasonHRRate != null) parts.push(clamp01(input.seasonHRRate / 0.07));
  if (input.barrelRate != null) parts.push(clamp01(input.barrelRate / 0.16));
  if (input.hardHitRate != null) parts.push(clamp01(input.hardHitRate / 0.50));
  if (input.xISO != null) parts.push(clamp01(input.xISO / 0.28));
  else if (input.xSLG != null) parts.push(clamp01((input.xSLG - 0.350) / 0.300));
  return parts.length ? clamp01(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
}

function scorePitcherHrVulnerability(input: HRConversionInput): number | null {
  const parts: number[] = [];
  if (input.era != null) parts.push(clamp01((input.era - 3.0) / 4.0));
  if (input.isPitcherCollapsing) parts.push(1.0);
  const veloDrop = input.pitcherDeterioration?.velocityDrop;
  if (veloDrop != null) parts.push(clamp01(veloDrop / 3.0));
  return parts.length ? clamp01(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
}

function scoreParkWeatherBoost(input: HRConversionInput): number | null {
  const parts: number[] = [];
  if (input.parkFactor != null) parts.push(clamp01((input.parkFactor - 0.90) / 0.30));
  if (input.isIndoors === true) {
    parts.push(0.5);
  } else if (input.windSpeed != null && input.windDirection != null) {
    const favorable = /out|tail/i.test(input.windDirection);
    parts.push(favorable ? clamp01(input.windSpeed / 20) : clamp01(0.5 - input.windSpeed / 40));
  }
  return parts.length ? clamp01(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
}

function scoreLineupOpportunity(input: HRConversionInput): number | null {
  if (input.battingOrderSlot == null) return null;
  // Slot 1 (most remaining PA opportunity) → ~1.0; slot 9 → ~0.2.
  return clamp01(1 - (input.battingOrderSlot - 1) / 8);
}

function scoreHandednessMatchup(input: HRConversionInput): number | null {
  const splits = input.batterHandednessSplits;
  if (splits == null) return null;
  const hrRate = input.pitcherThrows === "L" ? splits.hrRateVsLHP : splits.hrRateVsRHP;
  if (typeof hrRate !== "number") return null;
  return clamp01(hrRate / 0.06);
}

function scoreRecentPowerForm(input: HRConversionInput): number | null {
  const parts: number[] = [];
  if (input.hrRateLast30 != null) parts.push(clamp01(input.hrRateLast30 / 0.07));
  if (input.hrRateLast15 != null) parts.push(clamp01(input.hrRateLast15 / 0.08));
  if (input.hrRateLast7 != null) parts.push(clamp01(input.hrRateLast7 / 0.10));
  if (input.recentOps != null && input.seasonOps != null) {
    parts.push(clamp01((input.recentOps - input.seasonOps) / 0.300 + 0.5));
  }
  return parts.length ? clamp01(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
}

const PREGAME_PRIOR_NEUTRAL = 0.5;

export function computePregameHrPriorScore(input: HRConversionInput): PregameHrPriorResult {
  const raw = {
    batterPower: scoreBatterPower(input),
    pitcherHrVulnerability: scorePitcherHrVulnerability(input),
    parkWeatherBoost: scoreParkWeatherBoost(input),
    lineupOpportunity: scoreLineupOpportunity(input),
    handednessMatchup: scoreHandednessMatchup(input),
    recentPowerForm: scoreRecentPowerForm(input),
  };

  const componentScores = {
    batterPower: raw.batterPower ?? PREGAME_PRIOR_NEUTRAL,
    pitcherHrVulnerability: raw.pitcherHrVulnerability ?? PREGAME_PRIOR_NEUTRAL,
    parkWeatherBoost: raw.parkWeatherBoost ?? PREGAME_PRIOR_NEUTRAL,
    lineupOpportunity: raw.lineupOpportunity ?? PREGAME_PRIOR_NEUTRAL,
    handednessMatchup: raw.handednessMatchup ?? PREGAME_PRIOR_NEUTRAL,
    recentPowerForm: raw.recentPowerForm ?? PREGAME_PRIOR_NEUTRAL,
  };

  const missingInputs = (Object.keys(raw) as (keyof typeof raw)[]).filter((k) => raw[k] == null);

  const drivers: string[] = [];
  if (componentScores.batterPower >= 0.7) drivers.push("Elite batter power profile");
  if (componentScores.pitcherHrVulnerability >= 0.7) drivers.push("Pitcher HR-vulnerable");
  if (componentScores.parkWeatherBoost >= 0.7) drivers.push("Park/weather HR boost");
  if (componentScores.recentPowerForm >= 0.7) drivers.push("Hot recent power form");

  const priorScore = clamp01(
    componentScores.batterPower * PREGAME_PRIOR_WEIGHTS.batterPower +
    componentScores.pitcherHrVulnerability * PREGAME_PRIOR_WEIGHTS.pitcherHrVulnerability +
    componentScores.parkWeatherBoost * PREGAME_PRIOR_WEIGHTS.parkWeatherBoost +
    componentScores.lineupOpportunity * PREGAME_PRIOR_WEIGHTS.lineupOpportunity +
    componentScores.handednessMatchup * PREGAME_PRIOR_WEIGHTS.handednessMatchup +
    componentScores.recentPowerForm * PREGAME_PRIOR_WEIGHTS.recentPowerForm,
  );

  return { priorScore, componentScores, missingInputs, drivers };
}

export type PregamePriorPromotion = "none" | "watchlist" | "lean";

const PREGAME_PRIOR_WATCHLIST_FLOOR = 0.70;
const PREGAME_PRIOR_LEAN_FLOOR = 0.78;
const PREGAME_PRIOR_LEAN_INNING_FLOOR = 6;
const PREGAME_PRIOR_LEAN_BULLPEN_FLOOR = 0.65;

/**
 * Promotion decision for the pregame prior — coverage-only. HARD INVARIANT:
 * no combination of prior-score inputs can ever promote past "lean" — that
 * cap is enforced structurally (this function's return type has no
 * "playable"/"attack" member), never by a threshold that could be tuned past
 * it. Watchlist/Lean are non-official radar coverage; Playable/Attack require
 * live qualifying-signal evidence and never come from a pregame prior alone.
 */
export function derivePregamePriorPromotion(args: {
  priorScore: number;
  inning?: number | null;
  pitcherOrBullpenVulnerabilityScore?: number | null;
}): PregamePriorPromotion {
  const { priorScore, inning, pitcherOrBullpenVulnerabilityScore } = args;
  if (
    priorScore >= PREGAME_PRIOR_LEAN_FLOOR &&
    inning != null && inning >= PREGAME_PRIOR_LEAN_INNING_FLOOR &&
    pitcherOrBullpenVulnerabilityScore != null && pitcherOrBullpenVulnerabilityScore >= PREGAME_PRIOR_LEAN_BULLPEN_FLOOR
  ) return "lean";
  if (priorScore >= PREGAME_PRIOR_WATCHLIST_FLOOR) return "watchlist";
  return "none";
}

// Map the 0–100 pregame form score to a small capped multiplier on baseRate.
// Center (50) → 1.0; elite (~90) → ~1.14; cold (~20) → ~0.90.
function pregamePriorMultiplier(score: number): number {
  return Math.max(0.92, Math.min(1.15, 1 + (score - 50) * 0.0035));
}

export function computeHRConversionProbability(input: HRConversionInput): HRConversionResult {
  // When seasonHRRate is unavailable (rookie/prospect/API gap), derive a
  // context-sensitive proxy from barrel rate rather than blindly applying
  // the league average — barrel rate is the strongest single HR predictor.
  let baseRate: number;
  let skipBarrelAdj = false;
  if (input.seasonHRRate !== null && input.seasonHRRate !== undefined && input.seasonHRRate > 0 && input.seasonHRRate <= 0.12) {
    baseRate = input.seasonHRRate;
  } else if (input.barrelRate !== null && input.barrelRate !== undefined && input.barrelRate > 0) {
    const ratio = Math.min(2.5, input.barrelRate / LEAGUE_AVG_BARREL_RATE);
    baseRate = Math.min(0.08, Math.max(0.015, LEAGUE_AVG_HR_PER_PA * ratio));
    skipBarrelAdj = true;
  } else {
    baseRate = LEAGUE_AVG_HR_PER_PA;
  }

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
  const barrelAdj = skipBarrelAdj ? 1.0 : Math.min(1.5, barrelRate / LEAGUE_AVG_BARREL_RATE);
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

  // Consolidated overlay: Ψ (power profile) + Λ (launch topology) + Θ (lineup
  // volume) + Δ (recency delta) + Γ (arsenal matchup, Phase 2 no-op) + K (soft gate).
  // Supersedes the previous powerMultiplier × slotMultiplier × recentFormMult chain.
  const overlayResult = computeHROverlay({
    barrelPerPA: input.barrelRate ?? null,
    maxEV: input.maxEV ?? null,
    sweetSpotPct: input.sweetSpotPercent ?? null,
    xwOBAcon: input.xwOBA ?? null,
    fbPct: input.flyBallPercent ?? null,
    pullAirPct: input.pullRatePercent ?? null,
    toppedPct: input.toppedPercent ?? null,
    battingOrderSlot: input.battingOrderSlot,
    battingOrderSlgSplit: input.battingOrderSlgSplit ?? null,
    overallSLG: input.xSLG ?? null,
    seasonSLG: input.seasonSLG ?? null,
    recentSLG: input.recentSLG ?? null,
    recentOPS: input.recentOps ?? null,
    seasonOPS: input.seasonOps ?? null,
    pitchTypeSplits: input.pitchTypeSplits ?? null,
    seasonBundles: input.seasonBundles ?? null,
  });
  const overlayAdjustedRate = entryAdjustedRate * overlayResult.overlayMultiplier;

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
  const preCapCalibrated = cal.value;

  // ── HR occurrence calibration rail (2026-06) ──────────────────────────────
  // The empirical calibration buckets (loaded from analytics) can bind ABOVE
  // the static table and, on thin samples, map a raw ~0.30 to a calibrated
  // ~0.95 — an unrealistic HR-occurrence probability with no batter-side
  // evidence. Cap the calibrated occurrence probability by the QUALITY of the
  // batter's in-game contact evidence so pitcher context alone can't rail it:
  //   • no fresh batter-side contact → <= 0.35
  //   • fresh (some qualified contact) → <= 0.45
  //   • elite (near-HR / barrel / 390ft+ / multi HR-shaped) → <= 0.60
  // Elite barrel/near-HR may exceed the lower caps; nothing reaches 0.95.
  const evidenceQuality = classifyBatterEvidenceQuality(input.factors);
  const occurrenceCeiling = OCCURRENCE_CEILING[evidenceQuality];
  const calibratedProbability = Math.min(preCapCalibrated, occurrenceCeiling);
  const calibrationRailBlocked = calibratedProbability < preCapCalibrated - 1e-9;

  const pitcherDeteriorationState = describePitcherDeteriorationState(input);

  return {
    hrConversionProbability: Math.round(rawProbability * 10000) / 10000,
    calibratedProbability: Math.round(calibratedProbability * 10000) / 10000,
    // HR occurrence contract (2026-06) — P(HR >= 1) at the fixed 0.5 threshold,
    // post evidence-rail cap. This is the ONLY probability HR Radar promotion
    // should use; it is independent of sportsbook odds/edge/line.
    hrOccurrenceProbability: Math.round(calibratedProbability * 10000) / 10000,
    occurrenceEvidenceQuality: evidenceQuality,
    occurrenceCeiling,
    preCapCalibratedProbability: Math.round(preCapCalibrated * 10000) / 10000,
    calibrationRailBlocked,
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
    overlay: overlayResult,
    components: {
      pregameFormScore: Math.round(pregameFormScore * 10) / 10,
      pregamePriorMult: Math.round(pregamePriorMult * 1000) / 1000,
      baseRate: Math.round(baseRate * 10000) / 10000,
      hardHitInteractionMult: Math.round(hardHitInteractionMult * 1000) / 1000,
      liveAdjustedRate: Math.round(liveAdjustedRate * 10000) / 10000,
      pitcherAdjustedRate: Math.round(pitcherAdjustedRate * 10000) / 10000,
      envAdjustedRate: Math.round(envAdjustedRate * 10000) / 10000,
      entryAdjustedRate: Math.round(entryAdjustedRate * 10000) / 10000,
      overlayMultiplier: Math.round(overlayResult.overlayMultiplier * 10000) / 10000,
      ibbRespectMult: Math.round(ibbRespectMult * 1000) / 1000,
      finalPerPARate: Math.round(finalPerPARate * 10000) / 10000,
      paDist,
      pZeroHR: Math.round(pZeroHR * 10000) / 10000,
      rawProbability: Math.round(rawProbability * 10000) / 10000,
    },
  };
}
