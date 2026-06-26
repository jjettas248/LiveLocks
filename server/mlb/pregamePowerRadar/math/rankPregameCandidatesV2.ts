// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: scoring + tier recommendation
//
// Pure. Turns the modelled probabilities into the four orthogonal scores and a
// shadow tier recommendation. SHADOW-ONLY — these never replace production tiers.
//
//   rawSetupScore100        — quality of the HR setup (skill lift, volume-free)
//   probabilityScore100     — from the modelled game HR probability
//   confidenceScore100      — trust in the data/model (coverage + suppressors)
//   candidateRankScore100   — board sort key (weighted blend)
//   recommendedTier         — user-facing classification (diagnostics-only)
//
// NOTE: the spec's `historicalDriverLiftScore` term needs historical outcome data
// (a backtest) and is therefore DEFERRED. When absent, its 0.10 weight is
// redistributed proportionally across the available terms (documented below).
// ─────────────────────────────────────────────────────────────────────────────

import type { PregameMathTier } from "./mathTypes";
import { clamp, clamp01, norm01, logit } from "./normalizeStats";

export interface RankInputs {
  /** Net skill lift in log-odds above the league baseline (matchupLogit − intercept). */
  setupLogitLift: number;
  calibratedGameHrProbability: number | null;
  hrLiftVsSlateBaseline: number | null;
  hrLiftVsPlayerBaseline: number | null;
  /** [0,1] coverage of core families. */
  coreCoverage: number;
  /** Multiplicative confidence damage from suppressors [0,1]. */
  suppressorConfidenceFactor: number;
  /** Effective PA sample backing batter rates. */
  effectiveSample: number;
  hasMajorSuppressor: boolean;
}

export interface RankResult {
  rawSetupScore100: number;
  probabilityScore100: number;
  confidenceScore100: number;
  candidateRankScore100: number;
  recommendedTier: PregameMathTier;
}

/** Map a net log-odds lift to a 0–100 setup score. ±1.5 log-odds → [0,100]. */
export function rawSetupScore(setupLogitLift: number): number {
  return Math.round(norm01(setupLogitLift, -1.5, 1.5) * 100);
}

/** Map a game HR probability to 0–100. Reference span [0, 0.30] (capped). */
export function probabilityScore(gameHrProbability: number | null): number {
  if (gameHrProbability == null || !Number.isFinite(gameHrProbability)) return 0;
  return Math.round(norm01(gameHrProbability, 0, 0.3) * 100);
}

/** Map an HR lift ratio (candidate/baseline) to 0–100. [1.0, 3.0]× → [0,100]. */
export function hrLiftScore(lift: number | null): number | null {
  if (lift == null || !Number.isFinite(lift)) return null;
  return Math.round(norm01(lift, 1.0, 3.0) * 100);
}

/** Confidence 0–100 from coverage, sample stabilization, and suppressor damage. */
export function confidenceScore(
  coreCoverage: number,
  effectiveSample: number,
  suppressorConfidenceFactor: number,
): number {
  const coverageComp = clamp01(coreCoverage); // 0..1
  const sampleComp = clamp01(effectiveSample / 250); // ~250 PA → full sample trust
  const base = 100 * (0.6 * coverageComp + 0.4 * sampleComp);
  return Math.round(clamp(base * clamp01(suppressorConfidenceFactor), 0, 100));
}

export function rankPregameCandidate(inp: RankInputs): RankResult {
  const rawSetupScore100 = rawSetupScore(inp.setupLogitLift);
  const probabilityScore100 = probabilityScore(inp.calibratedGameHrProbability);
  const confidenceScore100 = confidenceScore(
    inp.coreCoverage,
    inp.effectiveSample,
    inp.suppressorConfidenceFactor,
  );

  // Prefer slate-baseline lift; fall back to player-baseline lift.
  const liftScore =
    hrLiftScore(inp.hrLiftVsSlateBaseline) ?? hrLiftScore(inp.hrLiftVsPlayerBaseline);

  // Weighted blend. historicalDriverLift (0.10) is DEFERRED → redistribute its
  // weight across the present terms. liftScore may also be absent (no baseline).
  const weighted: Array<{ score: number; weight: number }> = [
    { score: probabilityScore100, weight: 0.35 },
    { score: rawSetupScore100, weight: 0.2 },
    { score: confidenceScore100, weight: 0.1 },
  ];
  if (liftScore != null) weighted.push({ score: liftScore, weight: 0.25 });

  const wsum = weighted.reduce((a, b) => a + b.weight, 0);
  const candidateRankScore100 = Math.round(
    weighted.reduce((a, b) => a + b.score * b.weight, 0) / (wsum || 1),
  );

  const recommendedTier = recommendTier({
    calibratedGameHrProbability: inp.calibratedGameHrProbability,
    confidenceScore100,
    rawSetupScore100,
    hasMajorSuppressor: inp.hasMajorSuppressor,
  });

  return {
    rawSetupScore100,
    probabilityScore100,
    confidenceScore100,
    candidateRankScore100,
    recommendedTier,
  };
}

/**
 * Shadow tier recommendation. Slate-percentile gates (top 1–5% / 5–12%) are a
 * BOARD-LEVEL concern applied by the ranking caller across a slate; this
 * single-candidate function gates on the absolute probability + confidence +
 * suppressor criteria from the spec.
 */
export function recommendTier(args: {
  calibratedGameHrProbability: number | null;
  confidenceScore100: number;
  rawSetupScore100: number;
  hasMajorSuppressor: boolean;
}): PregameMathTier {
  const p = args.calibratedGameHrProbability;
  if (args.hasMajorSuppressor) return "suppressed";
  if (p == null || !Number.isFinite(p)) return "neutral";
  if (p < 0.04) return "suppressed";

  if (p >= 0.1 && args.confidenceScore100 >= 70) return "elite";
  if (p >= 0.075 && args.confidenceScore100 >= 60) return "strong";
  if (args.rawSetupScore100 >= 55) return "watch";
  return "neutral";
}

/** Convenience for tests/diagnostics: implied game HR prob → log-odds. */
export function gameProbToLogit(p: number): number {
  return logit(p);
}
