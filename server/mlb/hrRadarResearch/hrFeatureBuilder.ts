// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — pure feature builder (PR 2).
//
// buildHrFeatureSnapshot is a pure mapping/aggregation function shared by
// live capture (this PR), future replay, and future shadow inference. It
// performs NO I/O and NO `Date.now()` — every timestamp-dependent value is
// derived from the caller-supplied `statsAsOfMs` and per-source `fetchedAt`
// values. Every leaf on the 7 scored blocks is derived ONLY from data already
// available in-game (batter/pitcher priors, live contact evidence, matchup,
// lineup/score state, park/weather) — never from sportsbook odds, lines, or
// any future-outcome signal. The ordered non-HR BBE sequence this function
// consumes is pre-filtered by the caller to exclude the batter's own
// home-run BBEs (see hrEvaluationCapture.ts) — an HR event can never become
// evidence for predicting that same HR.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  HrDerivedFeatureVectorV1,
  HrFeatureAvailabilityVectorV1,
  HrFeatureFreshnessVectorV1,
  HrRawInputEnvelope,
} from "./hrFeatureContract";
import { HR_FEATURES_V1, HR_RAW_INPUTS_V1 } from "./hrFeatureContract";

export interface HrFeatureBuilderBbe {
  exitVelocity: number | null;
  launchAngle: number | null;
  distance: number | null;
  outcome: string;
  hitType: "single" | "double" | "triple" | "home_run" | null;
  hrProbability?: number | null;
  inning?: number | null;
  half?: "top" | "bottom" | null;
}

export interface HrFeatureBuilderSourceMeta {
  fetchedAtMs: number | null;
}

export interface HrFeatureBuilderInput {
  statsAsOfMs: number;

  // ── Batter prior (season/career baselines) ────────────────────────────────
  batterHand: string | null;
  seasonHRRate: number | null;
  careerHRRate: number | null;
  barrelRateSeasonal: number | null;
  hardHitRateSeasonal: number | null;
  flyBallPercent: number | null;
  hrFBRatio: number | null;
  xSlg: number | null;
  xIso: number | null;
  sweetSpotPercent: number | null;
  pullRatePercent: number | null;
  batterPriorMeta?: HrFeatureBuilderSourceMeta;

  // ── Live current form — pre-filtered to non-HR BBEs, oldest-first ────────
  liveBbeSequence: HrFeatureBuilderBbe[];
  gameBarrelCount: number | null;
  gameAvgXBaToday: number | null;
  seasonXBaForDelta: number | null; // used only for contactQualityDeltaVsPrior
  parkHrFactorForDistance: number | null;
  liveFormMeta?: HrFeatureBuilderSourceMeta;

  // ── Current pitcher state ────────────────────────────────────────────────
  pitcherHrRateAllowedSeasonal: number | null;
  pitcherFatigueScore: number | null;
  pitchCountToday: number | null;
  timesThroughOrder: number | null;
  battersFacedToday: number | null;
  velocityTrendSlope: number | null;
  velocityDropFromSeason: number | null;
  pitchMixShiftScore: number | null;
  pitcherHand: string | null;
  pitcherEraSeasonal: number | null; // ablation only
  pitcherRemovalProbability: number | null;
  pitcherStateMeta?: HrFeatureBuilderSourceMeta;

  // ── Matchup ───────────────────────────────────────────────────────────────
  handednessSplitFactor: number | null;
  platoonAdvantage: boolean | null;
  shrunkBatterVsHandHrRate: number | null;
  shrunkPitcherVsHandHrRateAllowed: number | null;
  pitchFamilyPowerFitScore: number | null;
  arsenalProfileFitScore: number | null;
  matchupMeta?: HrFeatureBuilderSourceMeta;

  // ── Opportunity ───────────────────────────────────────────────────────────
  battingOrderSlot: number | null;
  lineupDistanceToNextPa: number | null;
  remainingPaEstimate: number | null;
  remainingPaP25: number | null;
  remainingPaP50: number | null;
  remainingPaP75: number | null;
  inning: number | null;
  scoreDifferential: number | null;
  substitutionRiskScore: number | null;
  pitcherSurvivalUncertaintyScore: number | null;
  opportunityMeta?: HrFeatureBuilderSourceMeta;

  // ── Environment ───────────────────────────────────────────────────────────
  windOutFactor: number | null;
  temperatureF: number | null;
  parkHrFactor: number | null;
  handednessParkHrFactor: number | null;
  wallDistanceFitScore: number | null;
  windVectorDegrees: number | null;
  windSpeedMph: number | null;
  humidityPercent: number | null;
  pressureHpa: number | null;
  roofState: "open" | "closed" | "retractable_unknown" | "na" | null;
  environmentMeta?: HrFeatureBuilderSourceMeta;

  // ── Ablation-only raw inputs (no predetermined weight anywhere) ─────────
  rawBvpHrRate: number | null;
  rawBvpPlateAppearances: number | null;
  atBatsSinceLastHr: number | null;
  seasonIbbRate: number | null;
  genericHotLabel: string | null;
  leverageIndex: number | null;

  // ── Data-quality signals the caller already knows ────────────────────────
  identityConfidence: "confirmed" | "fuzzy_matched" | "unresolved" | null;
  feedDegradationFlags: string[];
}

export interface HrFeatureBuilderResult {
  derivedFeatures: HrDerivedFeatureVectorV1;
  availability: HrFeatureAvailabilityVectorV1;
  featureFreshness: HrFeatureFreshnessVectorV1;
  rawInputs: HrRawInputEnvelope;
}

function avg(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function maxOf(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

/** Simple two-half comparison (first half avg vs second half avg) — a
 * deterministic, easily-auditable trend slope over the ordered sequence. */
function twoHalfTrendSlope(values: number[]): number | null {
  if (values.length < 2) return null;
  const mid = Math.floor(values.length / 2);
  const firstHalf = avg(values.slice(0, mid));
  const secondHalf = avg(values.slice(mid));
  if (firstHalf == null || secondHalf == null) return null;
  return secondHalf - firstHalf;
}

/** Exponential recency weighting — most recent BBE weighted highest. */
function recencyWeightedAvg(values: Array<number | null | undefined>): number | null {
  const withIndex = values
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => typeof x.v === "number" && Number.isFinite(x.v));
  if (withIndex.length === 0) return null;
  const n = withIndex.length;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const { v, i } of withIndex) {
    const recencyRank = i; // later index = more recent
    const weight = Math.pow(0.85, n - 1 - recencyRank);
    weightedSum += v * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? weightedSum / weightTotal : null;
}

/** Exported so the capture orchestrator can turn estimateRichPADistribution's
 * discrete PMF into the three percentile leaves before calling the builder. */
export function percentileFromDistribution(dist: Record<number, number> | null, p: number): number | null {
  if (!dist) return null;
  const entries = Object.entries(dist)
    .map(([k, v]) => [Number(k), v] as [number, number])
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) return null;
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) return null;
  let cumulative = 0;
  for (const [paCount, weight] of entries) {
    cumulative += weight / total;
    if (cumulative >= p) return paCount;
  }
  return entries[entries.length - 1][0];
}

export function buildHrFeatureSnapshot(input: HrFeatureBuilderInput): HrFeatureBuilderResult {
  const bbes = input.liveBbeSequence ?? [];
  const evs = bbes.map((b) => b.exitVelocity);
  const las = bbes.map((b) => b.launchAngle);
  const hrProbs = bbes.map((b) => b.hrProbability ?? null);
  const distances = bbes.map((b) => b.distance);

  const evLaInteractionScore = avg(
    bbes.map((b) =>
      b.exitVelocity != null && b.launchAngle != null ? (b.exitVelocity * b.launchAngle) / 100 : null,
    ),
  );
  const avgBattedBallDistanceToday = avg(distances);
  const parkAdjustedContactQualityToday =
    avgBattedBallDistanceToday != null && input.parkHrFactorForDistance
      ? avgBattedBallDistanceToday / input.parkHrFactorForDistance
      : null;
  // One dangerous-contact increment per BBE (not per measurement) — a BBE
  // with EV>=95 or LA in the elevated-power band (8-40deg) counts once.
  const dangerousContactCountToday = bbes.filter(
    (b) => (b.exitVelocity ?? 0) >= 95 && (b.launchAngle ?? -999) >= 8 && (b.launchAngle ?? 999) <= 40,
  ).length;
  const contactQualityDeltaVsPrior =
    input.gameAvgXBaToday != null && input.seasonXBaForDelta != null
      ? input.gameAvgXBaToday - input.seasonXBaForDelta
      : null;
  const contactTrendSlope = twoHalfTrendSlope(hrProbs.filter((v): v is number => v != null));

  const hardHitAirBallRatePriorSeasonal =
    input.hardHitRateSeasonal != null && input.flyBallPercent != null
      ? input.hardHitRateSeasonal * input.flyBallPercent
      : null;

  const derivedFeatures: HrDerivedFeatureVectorV1 = {
    featureVersion: HR_FEATURES_V1,
    batterPrior: {
      hrRatePriorSeasonal: input.seasonHRRate ?? null,
      hrRateCareer: input.careerHRRate ?? null,
      barrelRatePriorSeasonal: input.barrelRateSeasonal ?? null,
      hardHitRatePriorSeasonal: input.hardHitRateSeasonal ?? null,
      pullRatePrior: input.pullRatePercent ?? null,
      hardHitAirBallRatePriorSeasonal,
      flyBallRatePrior: input.flyBallPercent ?? null,
      hrPerFlyBallRatePrior: input.hrFBRatio ?? null,
      xSlgPrior: input.xSlg ?? null,
      xIsoPrior: input.xIso ?? null,
      sweetSpotRatePrior: input.sweetSpotPercent ?? null,
      extra: {},
    },
    liveForm: {
      exitVeloTodayAvg: avg(evs),
      barrelsToday: input.gameBarrelCount ?? null,
      hardHitRateToday:
        evs.filter((v) => v != null).length > 0
          ? evs.filter((v): v is number => v != null && v >= 95).length / evs.filter((v) => v != null).length
          : null,
      recentFormStreakScore:
        input.seasonHRRate && input.seasonHRRate > 0 ? (avg(hrProbs) ?? 0) / input.seasonHRRate : avg(hrProbs),
      maxExitVeloToday: maxOf(evs),
      evLaInteractionScore,
      estimatedHrQualityToday: avg(hrProbs),
      maxEstimatedHrQualityToday: maxOf(hrProbs),
      avgBattedBallDistanceToday,
      parkAdjustedContactQualityToday,
      sprayPullFactorToday: null,
      recencyWeightedContactScore: recencyWeightedAvg(hrProbs),
      dangerousContactCountToday,
      contactQualityDeltaVsPrior,
      contactTrendSlope,
      extra: {},
    },
    pitcherState: {
      pitcherHrRateAllowedSeasonal: input.pitcherHrRateAllowedSeasonal ?? null,
      pitcherFatigueScore: input.pitcherFatigueScore ?? null,
      pitchCountToday: input.pitchCountToday ?? null,
      timesThroughOrder: input.timesThroughOrder ?? null,
      battersFacedToday: input.battersFacedToday ?? null,
      velocityTrendSlope: input.velocityTrendSlope ?? null,
      velocityDropFromSeason: input.velocityDropFromSeason ?? null,
      pitchMixShiftScore: input.pitchMixShiftScore ?? null,
      dangerousAerialContactAllowedToday: null,
      pitcherRemovalProbability: input.pitcherRemovalProbability ?? null,
      extra: {},
    },
    matchup: {
      handednessSplitFactor: input.handednessSplitFactor ?? null,
      platoonAdvantage: input.platoonAdvantage ?? null,
      shrunkBatterVsHandHrRate: input.shrunkBatterVsHandHrRate ?? null,
      shrunkPitcherVsHandHrRateAllowed: input.shrunkPitcherVsHandHrRateAllowed ?? null,
      pitchFamilyPowerFitScore: input.pitchFamilyPowerFitScore ?? null,
      arsenalProfileFitScore: input.arsenalProfileFitScore ?? null,
      extra: {},
    },
    opportunity: {
      battingOrderSlot: input.battingOrderSlot ?? null,
      remainingPaEstimate: input.remainingPaEstimate ?? null,
      inning: input.inning ?? null,
      lineupDistanceToNextPa: input.lineupDistanceToNextPa ?? null,
      remainingPaP25: input.remainingPaP25 ?? null,
      remainingPaP50: input.remainingPaP50 ?? null,
      remainingPaP75: input.remainingPaP75 ?? null,
      scoreDifferential: input.scoreDifferential ?? null,
      substitutionRiskScore: input.substitutionRiskScore ?? null,
      pitcherSurvivalUncertaintyScore: input.pitcherSurvivalUncertaintyScore ?? null,
      extra: {},
    },
    environment: {
      windOutFactor: input.windOutFactor ?? null,
      temperatureF: input.temperatureF ?? null,
      parkHrFactor: input.parkHrFactor ?? null,
      roofState: input.roofState ?? null,
      handednessParkHrFactor: input.handednessParkHrFactor ?? null,
      wallDistanceFitScore: input.wallDistanceFitScore ?? null,
      windVectorDegrees: input.windVectorDegrees ?? null,
      windSpeedMph: input.windSpeedMph ?? null,
      humidityPercent: input.humidityPercent ?? null,
      pressureHpa: input.pressureHpa ?? null,
      extra: {},
    },
    dataQuality: {
      missingInputs: [],
      overallQuality: "full",
      feedDegradationFlags: [...(input.feedDegradationFlags ?? [])],
      identityConfidence: input.identityConfidence ?? null,
    },
    ablationInputs: {
      xBaSeasonal: input.seasonXBaForDelta ?? null,
      pitcherEraSeasonal: input.pitcherEraSeasonal ?? null,
      rawBvpHrRate: input.rawBvpHrRate ?? null,
      rawBvpPlateAppearances: input.rawBvpPlateAppearances ?? null,
      atBatsSinceLastHr: input.atBatsSinceLastHr ?? null,
      seasonIbbRate: input.seasonIbbRate ?? null,
      genericHotLabel: input.genericHotLabel ?? null,
      leverageIndex: input.leverageIndex ?? null,
      extra: {},
    },
  };

  // ── Missing-inputs sweep — generic, walks every scored-block leaf once
  // (excludes `extra`, dataQuality, and ablationInputs, matching the schema's
  // own treatment of those as non-scored/non-mirrored). ─────────────────────
  const missingInputs: string[] = [];
  const SCORED_BLOCKS: Array<keyof HrDerivedFeatureVectorV1> = [
    "batterPrior", "liveForm", "pitcherState", "matchup", "opportunity", "environment",
  ];
  for (const blockKey of SCORED_BLOCKS) {
    const block = derivedFeatures[blockKey] as Record<string, unknown>;
    for (const leafKey of Object.keys(block)) {
      if (leafKey === "extra") continue;
      if (block[leafKey] === null) missingInputs.push(`${blockKey}.${leafKey}`);
    }
  }
  derivedFeatures.dataQuality.missingInputs = missingInputs;
  const missingRatio = missingInputs.length / (SCORED_BLOCKS.length * 6 || 1);
  derivedFeatures.dataQuality.overallQuality =
    missingInputs.length === 0 ? "full" : missingRatio > 0.6 ? "missing" : "degraded";

  // ── Availability mirror — presence + a per-leaf quality derived from the
  // same sweep (full when present, missing when null; "degraded" is reserved
  // for a source that responded but marked itself stale/partial, which this
  // generic sweep can't detect from a null value alone). ────────────────────
  const availability: HrFeatureAvailabilityVectorV1 = {
    featureVersion: HR_FEATURES_V1,
    batterPrior: leafAvailability(derivedFeatures.batterPrior),
    liveForm: leafAvailability(derivedFeatures.liveForm),
    pitcherState: leafAvailability(derivedFeatures.pitcherState),
    matchup: leafAvailability(derivedFeatures.matchup),
    opportunity: leafAvailability(derivedFeatures.opportunity),
    environment: leafAvailability(derivedFeatures.environment),
  };

  const nowMs = input.statsAsOfMs;
  const featureFreshness: HrFeatureFreshnessVectorV1 = {
    batterPrior: freshnessEntry(input.batterPriorMeta, nowMs),
    liveForm: freshnessEntry(input.liveFormMeta, nowMs),
    pitcherState: freshnessEntry(input.pitcherStateMeta, nowMs),
    matchup: freshnessEntry(input.matchupMeta, nowMs),
    opportunity: freshnessEntry(input.opportunityMeta, nowMs),
    environment: freshnessEntry(input.environmentMeta, nowMs),
  };

  const rawInputs: HrRawInputEnvelope = {
    inputContractVersion: HR_RAW_INPUTS_V1,
    capturedAt: new Date(nowMs).toISOString(),
    families: {
      liveContactBBE: bbes.map((b, i) => ({
        sequenceIndex: i,
        exitVelocity: b.exitVelocity,
        launchAngle: b.launchAngle,
        distance: b.distance,
        outcome: b.outcome,
        inning: b.inning ?? null,
        half: b.half ?? null,
      })),
    },
  };

  return { derivedFeatures, availability, featureFreshness, rawInputs };
}

function leafAvailability(block: Record<string, unknown>): Record<string, { present: boolean; quality: "full" | "degraded" | "missing" }> {
  const out: Record<string, { present: boolean; quality: "full" | "degraded" | "missing" }> = {};
  for (const key of Object.keys(block)) {
    if (key === "extra") continue;
    const present = block[key] !== null;
    out[key] = { present, quality: present ? "full" : "missing" };
  }
  return out;
}

function freshnessEntry(
  meta: HrFeatureBuilderSourceMeta | undefined,
  nowMs: number,
): { sourceAt: string | null; ageMs: number | null; quality: "full" | "degraded" | "missing" } {
  if (!meta || meta.fetchedAtMs == null) {
    return { sourceAt: null, ageMs: null, quality: "missing" };
  }
  const ageMs = Math.max(0, nowMs - meta.fetchedAtMs);
  return {
    sourceAt: new Date(meta.fetchedAtMs).toISOString(),
    ageMs,
    quality: ageMs > 15 * 60 * 1000 ? "degraded" : "full",
  };
}
