import type { MLBMarket } from "./types";
import { MARKET_SIGMA, MARKET_PROBABILITY_CAPS, MARKET_UNDER_CAPS } from "./types";
import type { MLBBatterArchetype, MLBPitcherArchetype } from "./archetypes";
import { getCalibrationShrinkage, getMLBSafetyCeiling } from "./archetypes";
import {
  binomialOverProbability,
  negativeBinomialPMF,
} from "./math/distributions";

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
  // [MLB Phase 1.5] Optional — used only for diagnostic logging in
  // applyModelSafetyCeiling ([MLB_UNDER_CALIBRATION] / [MLB_HRR_CEILING]).
  playerName?: string;
  // [MLB Phase 3B] HRR-specific input. When raw probability > 82, the HRR
  // wrapper softly compresses unless `contactScore >= 0.65` (i.e. the
  // batter has genuine contact-quality signal justifying the high prob).
  // The Phase 1.5 ceiling of 88 still binds downstream — this layer only
  // shapes the climb 82 → 88.
  hrrJustification?: { contactScore?: number };
  // [MLB Phase 3B] hits_allowed wrapper input. Pure normal CDF is replaced
  // by a CDF + fatigue/TTO/contact-allowed shift toward OVER. Phase 1.5
  // UNDER cap of 74 still binds downstream.
  pitcherFatigue?: {
    pitchCount?: number;
    timesThrough?: number;
    contactAllowedScore?: number;
  };
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
    // [MLB Phase 3B] HRR wrapper.
    // Base distribution is still the TB negative-binomial (separate from
    // total_bases purely by being a different market with different
    // featureMultiplier upstream — same probability primitive). On top
    // of that we apply soft compression when raw probability climbs above
    // 82 unless the batter's contact-quality signal justifies it.
    // Compression: compressed = 82 + (raw - 82) * 0.5  →  smooth descent
    // toward the Phase 1.5 ceiling of 88, never above it.
    // Justification gate: contactScore >= 0.65 (computeFullFeatureLayer's
    // contactQuality). If justified, full strength passes through and the
    // Phase 1.5 ceiling of 88 still binds via applyModelSafetyCeiling.
    const raw = computeTBDistributionProbability(input);
    const COMPRESSION_FLOOR = 82;
    const JUSTIFY_THRESHOLD = 0.65;
    const contactScore = input.hrrJustification?.contactScore ?? null;
    const justified = contactScore != null && contactScore >= JUSTIFY_THRESHOLD;

    let out = raw;
    let capApplied = false;
    if (raw.dominantProbability > COMPRESSION_FLOOR && !justified) {
      const dom = raw.dominantProbability;
      const compressed = Math.round(
        (COMPRESSION_FLOOR + (dom - COMPRESSION_FLOOR) * 0.5) * 100
      ) / 100;
      const opposite = Math.round((100 - compressed) * 100) / 100;
      const compressedOver = raw.isOverFavored ? compressed : opposite;
      const compressedUnder = raw.isOverFavored ? opposite : compressed;
      out = {
        overProbability: clampProbability(compressedOver),
        underProbability: clampProbability(compressedUnder),
        dominantProbability: Math.max(compressedOver, compressedUnder),
        isOverFavored: raw.isOverFavored,
        method: raw.method,
        purityTag: raw.purityTag,
      };
      capApplied = true;
      try {
        console.log(
          `[MLB_HRR_COMPRESSION] player=${input.playerName ?? "?"} raw=${dom.toFixed(2)} compressed=${compressed.toFixed(2)} contactScore=${contactScore?.toFixed(2) ?? "null"} justified=false`
        );
      } catch {}
    }

    try {
      console.log(
        `[MLB_HRR_CALIBRATION] player=${input.playerName ?? "?"} raw=${raw.dominantProbability.toFixed(2)} adj=${out.dominantProbability.toFixed(2)} usedTbFallback=true cap=${capApplied} contactScore=${contactScore?.toFixed(2) ?? "null"} justified=${justified}`
      );
      import("./diagnosticsBuffer").then((d) => {
        d.recordHrrCalibration({
          player: input.playerName ?? null,
          rawProbability: raw.dominantProbability,
          adjustedProbability: out.dominantProbability,
          capApplied,
          usedTbFallback: true,
          nearHrCount: null,
          contactScore: contactScore,
          reason: capApplied ? "compression_above_82_unjustified" : (justified ? "passthrough_justified" : "passthrough_below_floor"),
        });
        if (capApplied) {
          d.recordCapApplied({
            market: "hrr",
            side: raw.isOverFavored ? "OVER" : "UNDER",
            player: input.playerName ?? null,
            rawProbability: raw.dominantProbability,
            cappedProbability: out.dominantProbability,
            capReason: "phase3b_hrr_compression",
          });
        }
      }).catch(() => {});
    } catch {}
    return out;
  }

  if (market === "hits_allowed") {
    // [MLB Phase 3B] hits_allowed wrapper.
    // Base = normal CDF. On top, apply a fatigue/TTO/contact-allowed shift
    // toward OVER (more hits expected). The Phase 1.5 UNDER cap of 74 still
    // binds downstream via applyModelSafetyCeiling, so the wrapper can only
    // make UNDER less aggressive — never more.
    //   pitchCount >= 90  →  +6
    //   pitchCount >= 75  →  +3 (skipped if the >=90 branch already fired)
    //   timesThrough >= 3 →  +5
    //   contactAllowedScore >= 0.6 → +4
    // Total shift capped at +12pts.
    const base = computeNormalCDFProbability(projection, threshold, market);
    const fatigue = input.pitcherFatigue ?? {};
    let shift = 0;
    if ((fatigue.pitchCount ?? 0) >= 90) shift += 6;
    else if ((fatigue.pitchCount ?? 0) >= 75) shift += 3;
    if ((fatigue.timesThrough ?? 0) >= 3) shift += 5;
    if ((fatigue.contactAllowedScore ?? 0) >= 0.6) shift += 4;
    if (shift > 12) shift = 12;

    const adjustedOver = clampProbability(base.overProbability + shift);
    const adjustedUnder = clampProbability(100 - adjustedOver);
    const isOverFavored = adjustedOver >= adjustedUnder;
    const out: ProbabilityOutput = {
      overProbability: Math.round(adjustedOver * 100) / 100,
      underProbability: Math.round(adjustedUnder * 100) / 100,
      dominantProbability: Math.max(adjustedOver, adjustedUnder),
      isOverFavored,
      method: base.method,
      purityTag: shift > 0 ? "mlb-hits_allowed-wrapper-v1" : base.purityTag,
    };

    try {
      console.log(
        `[MLB_HITS_ALLOWED_WRAPPER] pitcher=${input.playerName ?? "?"} baseOver=${base.overProbability.toFixed(2)} shift=+${shift} adjOver=${out.overProbability.toFixed(2)} pc=${fatigue.pitchCount ?? "?"} tto=${fatigue.timesThrough ?? "?"} contactAllowed=${fatigue.contactAllowedScore?.toFixed(2) ?? "?"}`
      );
      import("./diagnosticsBuffer").then((d) => {
        d.recordHitsAllowedCalibration({
          pitcher: input.playerName ?? null,
          side: isOverFavored ? "OVER" : "UNDER",
          rawProbability: base.dominantProbability,
          adjustedProbability: out.dominantProbability,
          pitchCount: fatigue.pitchCount ?? null,
          timesThroughOrder: fatigue.timesThrough ?? null,
          contactAllowedScore: fatigue.contactAllowedScore ?? null,
          fallbackUsed: shift === 0,
        });
      }).catch(() => {});
    } catch {}
    return out;
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
  market: MLBMarket,
  recommendedSide?: "OVER" | "UNDER",
  playerName?: string,
): { probability: number; ceilingApplied: boolean; ceiling: number } {
  // [MLB Phase 1.5] Side-specific UNDER cap for overconfident pitcher markets.
  // Applied BEFORE archetype/market caps so it always binds when triggered.
  if (recommendedSide === "UNDER") {
    const underCap = MARKET_UNDER_CAPS[market];
    if (underCap && calibratedProb > underCap) {
      console.log("[MLB_UNDER_CALIBRATION]", {
        player: playerName,
        market,
        side: "UNDER",
        rawProbability: calibratedProb,
        adjustedProbability: underCap,
        reason: "pitcher_under_cap",
      });
      return { probability: underCap, ceilingApplied: true, ceiling: underCap };
    }
  }

  if (!archetype) {
    const marketCap = MARKET_PROBABILITY_CAPS[market];
    if (marketCap && calibratedProb > marketCap) {
      if (market === "hrr") {
        console.log("[MLB_HRR_CEILING]", {
          player: playerName,
          rawProbability: calibratedProb,
          cappedProbability: marketCap,
          capSource: "MARKET_PROBABILITY_CAPS",
          actualCap: marketCap,
        });
      }
      return { probability: marketCap, ceilingApplied: true, ceiling: marketCap };
    }
    return { probability: calibratedProb, ceilingApplied: false, ceiling: marketCap ?? 99 };
  }

  const ceiling = getMLBSafetyCeiling(archetype, market);
  if (calibratedProb > ceiling) {
    console.log(`[PROBABILITY_ENGINE] ceiling applied: archetype=${archetype} market=${market} raw=${calibratedProb.toFixed(1)} capped=${ceiling}`);
    if (market === "hrr") {
      console.log("[MLB_HRR_CEILING]", {
        player: playerName,
        rawProbability: calibratedProb,
        cappedProbability: ceiling,
        capSource: `archetype:${archetype}`,
        actualCap: ceiling,
      });
    }
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

  // [MLB Phase 1.5] Pass the model-favored side so applyModelSafetyCeiling can
  // apply UNDER-specific pitcher caps. Note: BATTER_OVER_POSITIVE_SKEW markets
  // (home_runs, hrr) get forced to OVER downstream by determineSide regardless,
  // so the UNDER cap correctly never applies to them via this path.
  const sideHint: "OVER" | "UNDER" = raw.isOverFavored ? "OVER" : "UNDER";
  const ceilingResult = market
    ? applyModelSafetyCeiling(calibratedSidedRaw, archetype ?? null, market, sideHint, input.playerName)
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

// MLB Canonical Probability v1 — single source of truth for sided mapping.
// The orchestrator, persistence, API normalization and the test harness all
// resolve recommended-side calibrated probability through THIS helper. If the
// mapping ever regresses, every call site fails together (no silent drift).
export function getCanonicalSidedProbability(output: {
  recommendedSide: "OVER" | "UNDER" | string;
  calibratedProbabilityOver: number;
  calibratedProbabilityUnder: number;
}): number {
  return output.recommendedSide === "OVER"
    ? output.calibratedProbabilityOver
    : output.calibratedProbabilityUnder;
}

// MLB Canonical Probability v1 — analytics bucketing helper. Keys off the
// canonical persisted recommended-side calibrated probability (`prob`). Never
// reads signalScore, edge, or dominant probability. Exported so the analytics
// route and the test harness share the same math.
export const MLB_PROB_BUCKETS = [
  { label: "60-64%", min: 60, max: 64 },
  { label: "65-69%", min: 65, max: 69 },
  { label: "70-74%", min: 70, max: 74 },
  { label: "75%+", min: 75, max: 100 },
] as const;

export function bucketPlaysByCanonicalProb(
  plays: Array<{ prob: number | string | null | undefined; result?: string | null }>,
  buckets: ReadonlyArray<{ label: string; min: number; max: number }> = MLB_PROB_BUCKETS,
): Array<{ label: string; total: number; hits: number; winRate: number }> {
  return buckets.map((bucket) => {
    const bucketPlays = plays.filter((p) => {
      const prob = Number(p.prob) || 0;
      return prob >= bucket.min && prob <= bucket.max;
    });
    const bucketHits = bucketPlays.filter((p) => p.result === "hit").length;
    const bucketTotal = bucketPlays.filter(
      (p) => p.result === "hit" || p.result === "miss",
    ).length;
    return {
      label: bucket.label,
      total: bucketPlays.length,
      hits: bucketHits,
      winRate: bucketTotal > 0 ? Math.round((bucketHits / bucketTotal) * 1000) / 10 : 0,
    };
  });
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
  const rec = {
    reason,
    player: qs.player ?? qs.playerName ?? null,
    market: qs.market ?? null,
    recommendedSide: qs.recommendedSide ?? qs.side ?? null,
    engineProbability: qs.engineProbability ?? null,
    signalScore: qs.signalScore ?? null,
  };
  console.warn("[MLB_PERSIST_REJECT]", rec);
  // Mirror to admin diagnostics ring buffer for /api/admin/mlb/engine-debug.
  // Lazy import to avoid any circular dependency risk at module load.
  import("./diagnosticsBuffer")
    .then((m) => m.recordPersistReject(rec))
    .catch(() => {});
}

