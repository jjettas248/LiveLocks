import type { MLBMarket } from "./types";
import { MARKET_SIGMA, MARKET_PROBABILITY_CAPS } from "./types";
import type { MLBBatterArchetype, MLBPitcherArchetype } from "./archetypes";
import { getCalibrationShrinkage, getMLBSafetyCeiling } from "./archetypes";

const PROBABILITY_PURITY_TAG = "PURE_MODEL_OUTPUT";

function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * ax);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

function clampProbability(prob: number): number {
  if (!Number.isFinite(prob)) return 5;
  return Math.min(96, Math.max(5, prob));
}

function binomialCoeff(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

function binomialOverProbability(
  remainingPA: number,
  rate: number,
  target: number
): number {
  const n = Math.round(Math.max(1, remainingPA));
  const p = Math.max(0, Math.min(1, rate));
  const t = Math.max(0, Math.ceil(target));

  if (t <= 0) return 100;

  let cumUnder = 0;
  for (let k = 0; k < t; k++) {
    cumUnder += binomialCoeff(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
  }
  return (1 - cumUnder) * 100;
}

function logGamma(z: number): number {
  if (z <= 0) return Infinity;
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953,
  ];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += c[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function negativeBinomialPMF(x: number, k: number, p: number): number {
  const logCoeff = logGamma(x + k) - logGamma(x + 1) - logGamma(k);
  const logProb = x * Math.log(1 - p) + k * Math.log(p);
  return Math.exp(logCoeff + logProb);
}

function negativeBinomialOverProbability(
  remainingPA: number,
  rate: number,
  target: number
): number {
  const meanOutcome = remainingPA * rate;

  if (meanOutcome <= 0 || !isFinite(meanOutcome)) {
    return binomialOverProbability(remainingPA, rate, target);
  }

  const variance = meanOutcome * 1.35;
  const diff = variance - meanOutcome;

  if (diff <= 0 || !isFinite(diff)) {
    return binomialOverProbability(remainingPA, rate, target);
  }

  let k = (meanOutcome * meanOutcome) / diff;
  if (k < 1) k = 1;

  const p = k / (k + meanOutcome);

  if (!isFinite(k) || !isFinite(p) || isNaN(k) || isNaN(p)) {
    return binomialOverProbability(remainingPA, rate, target);
  }

  const cap = 10;
  let probOver = 0;
  for (let x = target; x <= cap; x++) {
    const pmf = negativeBinomialPMF(x, k, p);
    if (isNaN(pmf) || !isFinite(pmf)) {
      return binomialOverProbability(remainingPA, rate, target);
    }
    probOver += pmf;
  }

  if (isNaN(probOver) || !isFinite(probOver)) {
    return binomialOverProbability(remainingPA, rate, target);
  }

  return probOver * 100;
}

export interface ProbabilityInput {
  projection: number;
  threshold: number;
  market: MLBMarket;
  remainingPA?: number;
  adjustedRate?: number;
  currentStatValue?: number;
  paDistribution?: Record<number, number>;
}

export interface ProbabilityOutput {
  overProbability: number;
  underProbability: number;
  dominantProbability: number;
  isOverFavored: boolean;
  method: "normal_cdf" | "negative_binomial" | "binomial" | "hr_binomial";
  purityTag: string;
}

export function computeModelProbability(input: ProbabilityInput): ProbabilityOutput {
  const { projection, threshold, market } = input;

  if (market === "hits" && input.remainingPA != null && input.adjustedRate != null) {
    return computeHitsDistributionProbability(input);
  }

  if (market === "home_runs" && input.adjustedRate != null && input.remainingPA != null) {
    return computeHRDistributionProbability(input);
  }

  if (market === "hr_allowed" && input.adjustedRate != null && input.remainingPA != null) {
    return computeHRDistributionProbability(input);
  }

  if (market === "total_bases" && input.remainingPA != null && input.adjustedRate != null) {
    return computeTBDistributionProbability(input);
  }

  if ((market === "batter_strikeouts") && input.remainingPA != null && input.adjustedRate != null) {
    return computeBinomialMarketProbability(input, "binomial");
  }

  if ((market === "pitcher_strikeouts" || market === "pitcher_outs") && input.remainingPA != null && input.adjustedRate != null) {
    return computeBinomialMarketProbability(input, "binomial");
  }

  if (market === "hrr" && input.remainingPA != null && input.adjustedRate != null) {
    return computeTBDistributionProbability(input);
  }

  return computeNormalCDFProbability(projection, threshold, market);
}

function computeNormalCDFProbability(
  projection: number,
  threshold: number,
  market: MLBMarket
): ProbabilityOutput {
  const sigma = MARKET_SIGMA[market];
  const clampedProjection = Math.max(0, projection);
  const diff = clampedProjection - threshold;
  const zScore = diff / sigma;
  const rawOver = normalCDF(zScore) * 100;
  const rawUnder = 100 - rawOver;

  const overProb = Math.round(clampProbability(rawOver) * 100) / 100;
  const underProb = Math.round(clampProbability(rawUnder) * 100) / 100;
  const isOverFavored = overProb >= underProb;

  return {
    overProbability: overProb,
    underProbability: underProb,
    dominantProbability: Math.max(overProb, underProb),
    isOverFavored,
    method: "normal_cdf",
    purityTag: PROBABILITY_PURITY_TAG,
  };
}

function computeHitsDistributionProbability(input: ProbabilityInput): ProbabilityOutput {
  const { currentStatValue = 0, adjustedRate = 0.25, threshold } = input;
  const neededHits = Math.max(0, Math.ceil(threshold) - currentStatValue);

  if (neededHits === 0) {
    return {
      overProbability: clampProbability(100),
      underProbability: clampProbability(0),
      dominantProbability: clampProbability(100),
      isOverFavored: true,
      method: "negative_binomial",
      purityTag: PROBABILITY_PURITY_TAG,
    };
  }

  let rawOver: number;

  if (input.paDistribution && Object.keys(input.paDistribution).length > 0) {
    let weightedProb = 0;
    for (const [paCountStr, paProb] of Object.entries(input.paDistribution)) {
      const paCount = Number(paCountStr);
      weightedProb += negativeBinomialOverProbability(paCount, adjustedRate, neededHits) * paProb;
    }
    rawOver = weightedProb;
  } else {
    const remainingPA = input.remainingPA ?? 2;
    rawOver = negativeBinomialOverProbability(remainingPA, adjustedRate, neededHits);
  }

  const overProb = Math.round(clampProbability(rawOver) * 100) / 100;
  const underProb = Math.round(clampProbability(100 - rawOver) * 100) / 100;
  const isOverFavored = overProb >= underProb;

  return {
    overProbability: overProb,
    underProbability: underProb,
    dominantProbability: Math.max(overProb, underProb),
    isOverFavored,
    method: "negative_binomial",
    purityTag: PROBABILITY_PURITY_TAG,
  };
}

function computeHRDistributionProbability(input: ProbabilityInput): ProbabilityOutput {
  const { adjustedRate = 0.035, remainingPA = 2, currentStatValue = 0, threshold } = input;
  const neededHR = Math.max(0, Math.ceil(threshold) - currentStatValue);

  if (neededHR === 0) {
    return {
      overProbability: clampProbability(100),
      underProbability: clampProbability(0),
      dominantProbability: clampProbability(100),
      isOverFavored: true,
      method: "hr_binomial",
      purityTag: PROBABILITY_PURITY_TAG,
    };
  }

  const rawOver = binomialOverProbability(remainingPA, adjustedRate, neededHR);
  const overProb = Math.round(clampProbability(rawOver) * 100) / 100;
  const underProb = Math.round(clampProbability(100 - rawOver) * 100) / 100;
  const isOverFavored = overProb >= underProb;

  return {
    overProbability: overProb,
    underProbability: underProb,
    dominantProbability: Math.max(overProb, underProb),
    isOverFavored,
    method: "hr_binomial",
    purityTag: PROBABILITY_PURITY_TAG,
  };
}

function computeTBDistributionProbability(input: ProbabilityInput): ProbabilityOutput {
  const { currentStatValue = 0, adjustedRate = 0.40, threshold } = input;
  const neededTB = Math.max(0, Math.ceil(threshold) - currentStatValue);

  if (neededTB === 0) {
    return {
      overProbability: clampProbability(100),
      underProbability: clampProbability(0),
      dominantProbability: clampProbability(100),
      isOverFavored: true,
      method: "negative_binomial",
      purityTag: PROBABILITY_PURITY_TAG,
    };
  }

  let rawOver: number;

  if (input.paDistribution && Object.keys(input.paDistribution).length > 0) {
    let weightedProb = 0;
    for (const [paCountStr, paProb] of Object.entries(input.paDistribution)) {
      const paCount = Number(paCountStr);
      weightedProb += negativeBinomialOverProbability(paCount, adjustedRate, neededTB) * paProb;
    }
    rawOver = weightedProb;
  } else {
    const remainingPA = input.remainingPA ?? 2;
    rawOver = negativeBinomialOverProbability(remainingPA, adjustedRate, neededTB);
  }

  const overProb = Math.round(clampProbability(rawOver) * 100) / 100;
  const underProb = Math.round(clampProbability(100 - rawOver) * 100) / 100;
  const isOverFavored = overProb >= underProb;

  return {
    overProbability: overProb,
    underProbability: underProb,
    dominantProbability: Math.max(overProb, underProb),
    isOverFavored,
    method: "negative_binomial",
    purityTag: PROBABILITY_PURITY_TAG,
  };
}

function computeBinomialMarketProbability(
  input: ProbabilityInput,
  method: "binomial"
): ProbabilityOutput {
  const { currentStatValue = 0, adjustedRate = 0.20, threshold } = input;
  const needed = Math.max(0, Math.ceil(threshold) - currentStatValue);

  if (needed === 0) {
    return {
      overProbability: clampProbability(100),
      underProbability: clampProbability(0),
      dominantProbability: clampProbability(100),
      isOverFavored: true,
      method: "binomial",
      purityTag: PROBABILITY_PURITY_TAG,
    };
  }

  const remainingPA = input.remainingPA ?? 2;
  const rawOver = binomialOverProbability(remainingPA, adjustedRate, needed);

  const overProb = Math.round(clampProbability(rawOver) * 100) / 100;
  const underProb = Math.round(clampProbability(100 - rawOver) * 100) / 100;
  const isOverFavored = overProb >= underProb;

  return {
    overProbability: overProb,
    underProbability: underProb,
    dominantProbability: Math.max(overProb, underProb),
    isOverFavored,
    method: "binomial",
    purityTag: PROBABILITY_PURITY_TAG,
  };
}

const DEFAULT_SHRINK = 0.96;

export function calibrateModelProbability(
  rawProb: number,
  archetype?: MLBBatterArchetype | MLBPitcherArchetype | null,
  market?: MLBMarket | null,
  isPitcherMarket?: boolean
): number {
  let shrinkage = DEFAULT_SHRINK;

  if (archetype && market) {
    shrinkage = getCalibrationShrinkage(archetype, market, isPitcherMarket ?? false);
  }

  const shifted = rawProb - 50;
  const calibrated = 50 + shifted * shrinkage;
  return Math.round(Math.min(96, Math.max(5, calibrated)) * 100) / 100;
}

export function applyModelSafetyCeiling(
  calibratedProb: number,
  archetype: MLBBatterArchetype | MLBPitcherArchetype | null,
  market: MLBMarket
): { probability: number; ceilingApplied: boolean; ceiling: number } {
  if (!archetype) {
    const marketCap = MARKET_PROBABILITY_CAPS[market];
    if (marketCap && calibratedProb > marketCap) {
      return { probability: marketCap, ceilingApplied: true, ceiling: marketCap };
    }
    return { probability: calibratedProb, ceilingApplied: false, ceiling: marketCap ?? 99 };
  }

  const ceiling = getMLBSafetyCeiling(archetype, market);
  if (calibratedProb > ceiling) {
    console.log(`[PROBABILITY_ENGINE] ceiling applied: archetype=${archetype} market=${market} raw=${calibratedProb.toFixed(1)} capped=${ceiling}`);
    return { probability: ceiling, ceilingApplied: true, ceiling };
  }

  return { probability: calibratedProb, ceilingApplied: false, ceiling };
}

export interface FullProbabilityResult {
  rawOverProbability: number;
  rawUnderProbability: number;
  calibratedOverProbability: number;
  calibratedUnderProbability: number;
  dominantRawProbability: number;
  dominantCalibratedProbability: number;
  isOverFavored: boolean;
  method: ProbabilityOutput["method"];
  ceilingApplied: boolean;
  ceiling: number;
  purityTag: string;
}

export function computeFullModelProbability(
  input: ProbabilityInput,
  archetype?: MLBBatterArchetype | MLBPitcherArchetype | null,
  market?: MLBMarket | null,
  isPitcherMarket?: boolean,
  isExperimental?: boolean
): FullProbabilityResult {
  const raw = computeModelProbability(input);

  let calibratedOver = calibrateModelProbability(
    raw.overProbability, archetype, market, isPitcherMarket
  );
  let calibratedUnder = calibrateModelProbability(
    raw.underProbability, archetype, market, isPitcherMarket
  );

  if (isExperimental) {
    calibratedOver = 50 + (calibratedOver - 50) * 0.90;
    calibratedUnder = 50 + (calibratedUnder - 50) * 0.90;
    calibratedOver = Math.round(calibratedOver * 100) / 100;
    calibratedUnder = Math.round(calibratedUnder * 100) / 100;
  }

  const calibratedSidedRaw = raw.isOverFavored ? calibratedOver : calibratedUnder;

  const ceilingResult = market
    ? applyModelSafetyCeiling(calibratedSidedRaw, archetype ?? null, market)
    : { probability: calibratedSidedRaw, ceilingApplied: false, ceiling: 99 };

  const calibratedSided = ceilingResult.probability;
  const calibratedOpposite = Math.round((100 - calibratedSided) * 100) / 100;

  const finalOver = clampProbability(raw.isOverFavored ? calibratedSided : calibratedOpposite);
  const finalUnder = clampProbability(raw.isOverFavored ? calibratedOpposite : calibratedSided);

  return {
    rawOverProbability: raw.overProbability,
    rawUnderProbability: raw.underProbability,
    calibratedOverProbability: Math.round(finalOver * 100) / 100,
    calibratedUnderProbability: Math.round(finalUnder * 100) / 100,
    dominantRawProbability: raw.dominantProbability,
    dominantCalibratedProbability: Math.max(finalOver, finalUnder),
    isOverFavored: raw.isOverFavored,
    method: raw.method,
    ceilingApplied: ceilingResult.ceilingApplied,
    ceiling: ceilingResult.ceiling,
    purityTag: raw.purityTag,
  };
}


// ============================================================================
// MLB Canonical Probability v1 — persistence & API guardrail
// ----------------------------------------------------------------------------
// Validates that a qualified MLB signal carries a usable engine probability
// (recommended-side calibrated). Rejects null/undefined/NaN/non-finite values
// and values outside [0, 100]. Callers should skip persistence and emit
// [MLB_PERSIST_REJECT] when this returns null. signalScore is NEVER substituted.
// ============================================================================
export function validateMlbEngineProbability(qs: {
  engineProbability?: number | null;
  signalScore?: number | null;
  player?: string | null;
  playerName?: string | null;
  market?: string | null;
  side?: string | null;
  recommendedSide?: string | null;
}): number | null {
  const p = qs.engineProbability;
  if (p === null || p === undefined) return null;
  if (typeof p !== "number" || !Number.isFinite(p)) return null;
  if (p < 0 || p > 100) return null;
  return p;
}

export function logMlbPersistReject(
  reason: "missing_engine_probability" | "invalid_probability_at_persist" | "out_of_range",
  qs: {
    player?: string | null;
    playerName?: string | null;
    market?: string | null;
    side?: string | null;
    recommendedSide?: string | null;
    engineProbability?: number | null;
    signalScore?: number | null;
  }
): void {
  console.warn("[MLB_PERSIST_REJECT]", {
    reason,
    player: qs.player ?? qs.playerName ?? null,
    market: qs.market ?? null,
    recommendedSide: qs.recommendedSide ?? qs.side ?? null,
    engineProbability: qs.engineProbability ?? null,
    signalScore: qs.signalScore ?? null,
  });
}

