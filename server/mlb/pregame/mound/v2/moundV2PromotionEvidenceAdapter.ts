// Mound Radar V2 (shadow) — promotion evidence adapter (Flagship Program
// Phase 2, Part 7). Converts REAL Part 6 comparison rows (plus REAL Part 3
// shadow-evaluation metrics) into the MoundV2PromotionEvidence shape
// moundV2PromotionGate.ts's evaluateMoundV2PromotionReadiness already
// checks against fixed thresholds. Produces EVIDENCE ONLY — nothing here
// promotes anything, and nothing calls this automatically. Promotion
// requires a separate, deliberate, explicit code/config change.
//
// Baseline for the calibration/Brier/log-loss deltas: V1 has no comparable
// probability (score10 is a matchup-quality composite, never a
// probability — see CLAUDE.md §3.9), so "production's calibration error"
// literally doesn't exist to diff against. Per MoundV2PromotionEvidence's
// own doc comment ("V1's... or a baseline forecast's"), this uses a
// climatology baseline instead — a constant forecast, for every graded
// row, equal to the empirical over/under/push rate observed across that
// same sample. This is standard forecast-verification methodology (the
// same idea behind Brier Skill Score: score a model against the skill of
// "always predict the historical base rate," not against a strawman like
// a flat 50/50 guess) and needs no V1 data at all.
//
// Fail-closed: every value that can't be honestly computed reads as
// "blocks promotion," never as "clears the gate." A delta with no V2 or
// baseline metric to compare (e.g. zero graded-with-line strikeouts rows
// in the window) reads as +Infinity ("not improved"), never 0 ("matches
// exactly"). Market coverage with no evaluation data at all reads as 0.
// settlementOrProvenanceRegressionDetected has no live runtime monitor
// today (see the module-level gap note below) and is therefore a REQUIRED
// explicit input, not a defaulted one — there is no way to silently get a
// favorable "false" out of this function.

import { computeMoundV2OwnMetrics, type MoundV2ComparisonRow } from "./moundV2ComparisonStats";
import { evaluateMoundV2PromotionReadiness, type MoundV2PromotionEvidence, type MoundV2PromotionVerdict } from "./moundV2PromotionGate";

const STRIKEOUTS_MARKET = "pitcher_strikeouts";
const UNMEASURABLE_DELTA = Number.POSITIVE_INFINITY;
// A climatology baseline is tautologically ~perfectly calibrated against
// its OWN generating sample (a constant matched to the empirical rate it
// was computed from), so a V2 that is ALSO well-calibrated will often tie
// it exactly in theory. Floating-point arithmetic across many rows can
// turn an exact theoretical tie into a +1e-14-ish noise value on either
// side — snapping anything within this epsilon to exactly 0 stops that
// noise from ever flipping a genuine tie into an artificial regression
// (or, symmetrically, an artificial improvement) against the gate's
// strict `> 0` threshold.
const DELTA_EPSILON = 1e-9;

function delta(v2Metric: number | null, baselineMetric: number | null): number {
  if (v2Metric == null || baselineMetric == null) return UNMEASURABLE_DELTA;
  const raw = v2Metric - baselineMetric;
  return Math.abs(raw) < DELTA_EPSILON ? 0 : raw;
}

function computeClimatologyRate(rows: readonly MoundV2ComparisonRow[]): { over: number; under: number; push: number } {
  const n = rows.length;
  if (n === 0) return { over: 1 / 3, under: 1 / 3, push: 1 / 3 }; // never actually used: an empty input produces an empty synthetic set, and computeMoundV2OwnMetrics([]) is null-safe.
  const over = rows.filter((r) => r.finalResult === "over").length / n;
  const under = rows.filter((r) => r.finalResult === "under").length / n;
  const push = rows.filter((r) => r.finalResult === "push").length / n;
  return { over, under, push };
}

/**
 * A synthetic row set — same real finalResult per observation, but every
 * row's probabilities replaced by the sample's own constant empirical
 * rate — fed back through computeMoundV2OwnMetrics so the baseline's
 * Brier/log-loss/calibration are computed via the EXACT same formulas as
 * V2's own, rather than a parallel/duplicated implementation.
 */
function buildClimatologyBaselineRows(gradedWithLine: readonly MoundV2ComparisonRow[]): MoundV2ComparisonRow[] {
  const rate = computeClimatologyRate(gradedWithLine);
  return gradedWithLine.map((r) => ({
    ...r,
    v2OverProbability: rate.over,
    v2UnderProbability: rate.under,
    v2PushProbability: rate.push,
  }));
}

export interface MoundV2PromotionEvidenceOpts {
  /** From moundV2ShadowStore.ts's getMoundV2ShadowMetrics().totalEvaluations. */
  shadowEvaluationTotal: number;
  /** From moundV2ShadowStore.ts's getMoundV2ShadowMetrics().totalFailures. */
  shadowEvaluationFailures: number;
  /**
   * Required, not defaulted. No live runtime monitor for a V2-caused
   * settlement/provenance regression exists today — the actual evidence
   * base right now is (a) moundV2ShadowWiring.test.ts's structural,
   * source-level proof that the shadow block never assigns to `signal.`
   * or calls `signals.set(` and always runs after V1's own signal object
   * is fully built, and (b) the explicit per-file grep confirming zero
   * production-Mound import edges into v2/ (moundV2Engine.test.ts's own
   * isolation check). Passing `false` here asserts "I have reviewed that
   * evidence for the code currently deployed and it holds" — it is a
   * human/CI attestation, not something this function can verify itself.
   */
  settlementOrProvenanceRegressionDetected: boolean;
}

/**
 * Builds real MoundV2PromotionEvidence from a set of comparison rows
 * (typically the pitcher_strikeouts subset of what
 * moundV2ComparisonGatherer.ts fetches for a declared window — the outs
 * market has no real line today, so it can never feed a calibration/Brier/
 * log-loss delta and is intentionally excluded here, matching the
 * evidence type's own strikeouts-scoped field names).
 */
export function buildMoundV2PromotionEvidence(
  v2Rows: readonly MoundV2ComparisonRow[],
  opts: MoundV2PromotionEvidenceOpts,
): MoundV2PromotionEvidence {
  const strikeoutsRows = v2Rows.filter((r) => r.market === STRIKEOUTS_MARKET);
  const v2Metrics = computeMoundV2OwnMetrics(strikeoutsRows);

  const gradedWithLine = strikeoutsRows.filter((r) => r.settlementStatus === "graded" && r.finalResult != null);
  const baselineMetrics = computeMoundV2OwnMetrics(buildClimatologyBaselineRows(gradedWithLine));

  const marketCoverage = opts.shadowEvaluationTotal > 0
    ? (opts.shadowEvaluationTotal - opts.shadowEvaluationFailures) / opts.shadowEvaluationTotal
    : 0;

  return {
    sampleSize: v2Metrics.gradedWithLineCount,
    strikeoutsCalibrationErrorDelta: delta(v2Metrics.calibrationError, baselineMetrics.calibrationError),
    strikeoutsBrierDelta: delta(v2Metrics.brierScore, baselineMetrics.brierScore),
    strikeoutsLogLossDelta: delta(v2Metrics.logLoss, baselineMetrics.logLoss),
    marketCoverage,
    settlementOrProvenanceRegressionDetected: opts.settlementOrProvenanceRegressionDetected,
  };
}

/** Convenience combinator — still just evidence + a verdict; nothing here writes/applies a promotion. */
export function buildAndEvaluateMoundV2Promotion(
  v2Rows: readonly MoundV2ComparisonRow[],
  opts: MoundV2PromotionEvidenceOpts,
): { evidence: MoundV2PromotionEvidence; verdict: MoundV2PromotionVerdict } {
  const evidence = buildMoundV2PromotionEvidence(v2Rows, opts);
  return { evidence, verdict: evaluateMoundV2PromotionReadiness(evidence) };
}
