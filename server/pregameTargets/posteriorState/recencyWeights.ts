// PR1 — Recency / continuity weight product (temporal data foundation, §5B).
//
// Every historical observation that feeds a posterior gets a scalar weight in
// [0, 1] built as a PRODUCT of independent factors:
//
//   weight = season × recency × continuity(role·org·scheme) × context × quality
//
// The product form means any single factor can veto an observation (→ 0) and
// factors compose without interaction assumptions. This module is pure math: no
// I/O, deterministic, and no-op-safe (absent optional inputs default to 1.0, so
// partial data never inflates or destabilizes a weight).
//
// Design intent this file encodes and its tests lock:
//  • current season > prior-1 > prior-2 (season decay), seasons older than the
//    rolling window get weight 0 (rollover drop);
//  • ROLE information decays FASTER than SKILL (shorter half-life) — a stale role
//    read is worth less than a stale skill read of the same age;
//  • a broken continuity dimension (trade, scheme change) discounts but does not
//    necessarily zero the observation (floored), because skill partially carries.

/** Which half-life a feature ages on. Role ages fastest; skill slowest. */
export type FeatureClass = "skill" | "role" | "context";

export interface RecencyWeightConfig {
  /** Half-life (days) per feature class. role < context < skill by design. */
  halfLifeDaysByClass: Record<FeatureClass, number>;
  /** Multiplicative season decay per season offset (prior-1 = decay^1, …). */
  seasonDecay: number;
  /** Largest season offset kept; anything older gets weight 0 (rollover). */
  maxSeasonOffset: number;
  /** Floor a fully-broken continuity dimension decays to (not 0 — skill carries). */
  continuityFloor: number;
}

export const DEFAULT_RECENCY_CONFIG: RecencyWeightConfig = {
  halfLifeDaysByClass: { role: 45, context: 120, skill: 240 },
  seasonDecay: 0.5,
  maxSeasonOffset: 2,
  continuityFloor: 0.25,
};

export interface RecencyWeightInputs {
  /** Days between the observation's event time and the decision instant (>=0). */
  ageDays: number;
  /** 0 = current season, 1 = prior-1, 2 = prior-2, … Larger → dropped. */
  seasonOffset: number;
  /** Which half-life this observation ages on. */
  featureClass: FeatureClass;
  /** Continuity in [0,1]: 1 = unchanged, 0 = fully broken. Absent → 1 (no discount). */
  roleContinuity?: number;
  orgContinuity?: number;
  schemeContinuity?: number;
  /** Context similarity in [0,1] (e.g. matchup/home-away). Absent → 1. */
  contextSimilarity?: number;
  /** Data-quality/coverage in [0,1]. Absent → 1. */
  dataQuality?: number;
}

export interface RecencyWeightBreakdown {
  season: number;
  recency: number;
  continuity: number;
  context: number;
  quality: number;
  weight: number;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Continuity factor for one dimension: floor + (1-floor)·clamp01(c). */
function continuityFactor(c: number | undefined, floor: number): number {
  const v = c == null ? 1 : clamp01(c);
  return floor + (1 - floor) * v;
}

/**
 * Compute the full weight and its factor breakdown. Deterministic and total:
 * every non-finite or out-of-range input is clamped rather than throwing, so a
 * bad upstream value degrades the weight toward 0 (fail-safe) instead of NaN.
 */
export function computeRecencyWeight(
  inputs: RecencyWeightInputs,
  config: RecencyWeightConfig = DEFAULT_RECENCY_CONFIG,
): RecencyWeightBreakdown {
  // Season factor — rolling-window rollover: older-than-window → 0.
  const offset = Math.trunc(inputs.seasonOffset);
  const season =
    offset < 0 || offset > config.maxSeasonOffset
      ? 0
      : Math.pow(config.seasonDecay, offset);

  // Recency factor — exponential half-life decay on age. Negative age (a fact
  // "from the future" relative to the decision) is clamped to 0 age = weight 1;
  // the leakage firewall, not this function, rejects future knownAt.
  const halfLife = config.halfLifeDaysByClass[inputs.featureClass];
  const age = Number.isFinite(inputs.ageDays) ? Math.max(0, inputs.ageDays) : Infinity;
  const recency =
    halfLife > 0 && Number.isFinite(age) ? Math.pow(0.5, age / halfLife) : 0;

  const continuity =
    continuityFactor(inputs.roleContinuity, config.continuityFloor) *
    continuityFactor(inputs.orgContinuity, config.continuityFloor) *
    continuityFactor(inputs.schemeContinuity, config.continuityFloor);

  const context = inputs.contextSimilarity == null ? 1 : clamp01(inputs.contextSimilarity);
  const quality = inputs.dataQuality == null ? 1 : clamp01(inputs.dataQuality);

  const weight = season * recency * continuity * context * quality;

  return { season, recency, continuity, context, quality, weight };
}
