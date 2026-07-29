// Mound V2 promotion evidence adapter — invariants. Pure, no DB needed.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2PromotionEvidenceAdapter.test.ts

import {
  buildMoundV2PromotionEvidence,
  buildAndEvaluateMoundV2Promotion,
} from "./moundV2PromotionEvidenceAdapter";
import { MOUND_V2_PROMOTION_THRESHOLDS } from "./moundV2PromotionGate";
import type { MoundV2ComparisonRow } from "./moundV2ComparisonStats";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function row(over: Partial<MoundV2ComparisonRow>): MoundV2ComparisonRow {
  return {
    gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts",
    settlementStatus: "graded", finalResult: "over",
    frozenOverPrice: -120, frozenUnderPrice: 100,
    v2OverProbability: 0.6, v2UnderProbability: 0.37, v2PushProbability: 0.03,
    v1Tier: "strong", v2ModelVersion: "v2_v1", productionModelVersion: "prod_v1",
    ...over,
  };
}

// ── Fail-closed on missing data ──────────────────────────────────────────
{
  const evidence = buildMoundV2PromotionEvidence([], { shadowEvaluationTotal: 0, shadowEvaluationFailures: 0, settlementOrProvenanceRegressionDetected: false });
  ok(evidence.sampleSize === 0, "empty input -> sampleSize 0");
  ok(evidence.strikeoutsCalibrationErrorDelta === Number.POSITIVE_INFINITY, "no data at all -> calibration delta reads as +Infinity (blocks), never 0 (would wrongly pass)");
  ok(evidence.strikeoutsBrierDelta === Number.POSITIVE_INFINITY, "no data at all -> Brier delta reads as +Infinity");
  ok(evidence.strikeoutsLogLossDelta === Number.POSITIVE_INFINITY, "no data at all -> log-loss delta reads as +Infinity");
  ok(evidence.marketCoverage === 0, "zero shadow evaluations -> marketCoverage 0 (fail-closed, not undefined/NaN)");

  const verdict = buildAndEvaluateMoundV2Promotion([], { shadowEvaluationTotal: 0, shadowEvaluationFailures: 0, settlementOrProvenanceRegressionDetected: false }).verdict;
  ok(!verdict.readyForPromotion, "empty evidence never reads as ready for promotion");
  ok(verdict.blockers.includes("INSUFFICIENT_SAMPLE_SIZE") && verdict.blockers.includes("CALIBRATION_NOT_IMPROVED"), "empty evidence trips multiple independent blockers at once");
}

// ── Outs-market rows never contribute (no real line to score against) ────
{
  const outsOnly = Array.from({ length: 500 }, (_, i) => row({ market: "pitcher_outs", gameId: `g${i}`, finalResult: null }));
  const evidence = buildMoundV2PromotionEvidence(outsOnly, { shadowEvaluationTotal: 500, shadowEvaluationFailures: 0, settlementOrProvenanceRegressionDetected: false });
  ok(evidence.sampleSize === 0, "outs-market rows (no real line) never contribute to the strikeouts-scoped sample size, however many there are");
}

// ── Regression flag always blocks, independent of every other criterion ──
{
  // A climatology baseline computed as the sample's own empirical rate is
  // ALWAYS near-perfectly "calibrated" against that same sample by
  // construction (a global single-confidence-level tautology) — so
  // beating it on calibration specifically requires V2 to ALSO be
  // well-calibrated at each of ITS OWN confidence levels, not merely
  // sharper. Two symmetric, individually-well-calibrated 90%-confidence
  // buckets (90% hit rate at 90% stated confidence, each direction)
  // satisfy that: V2 ties or beats climatology's near-0 calibration error
  // while still beating it decisively on Brier/log loss, because
  // climatology can't adapt its flat 50/50 guess to the real per-row
  // signal the way V2's per-bucket confidence does.
  const great = [
    ...Array.from({ length: 90 }, (_, i) => row({ gameId: `ga${i}`, finalResult: "over", v2OverProbability: 0.9, v2UnderProbability: 0.1, v2PushProbability: 0 })),
    ...Array.from({ length: 10 }, (_, i) => row({ gameId: `gb${i}`, finalResult: "under", v2OverProbability: 0.9, v2UnderProbability: 0.1, v2PushProbability: 0 })),
    ...Array.from({ length: 10 }, (_, i) => row({ gameId: `gc${i}`, finalResult: "over", v2OverProbability: 0.1, v2UnderProbability: 0.9, v2PushProbability: 0 })),
    ...Array.from({ length: 90 }, (_, i) => row({ gameId: `gd${i}`, finalResult: "under", v2OverProbability: 0.1, v2UnderProbability: 0.9, v2PushProbability: 0 })),
  ];
  const cleanVerdict = buildAndEvaluateMoundV2Promotion(great, { shadowEvaluationTotal: 300, shadowEvaluationFailures: 0, settlementOrProvenanceRegressionDetected: false }).verdict;
  ok(cleanVerdict.readyForPromotion, "a large, well-calibrated, fully-covered sample with no regression IS ready for promotion (sanity check the happy path works)");

  const regressionVerdict = buildAndEvaluateMoundV2Promotion(great, { shadowEvaluationTotal: 300, shadowEvaluationFailures: 0, settlementOrProvenanceRegressionDetected: true }).verdict;
  ok(!regressionVerdict.readyForPromotion && regressionVerdict.blockers.includes("SETTLEMENT_OR_PROVENANCE_REGRESSION"), "a detected regression blocks promotion even when every statistical criterion is otherwise perfect");
}

// ── V2 must beat climatology, not just be non-degenerate ─────────────────
{
  // The sample is 90% "over" in reality, but V2 is a coin-flip (50/50) —
  // a naive "always predict the 90% base rate" baseline would out-score
  // this V2, so the delta should be POSITIVE (worse than climatology),
  // correctly blocking promotion on calibration/Brier even with a large N.
  const mostlyOver: MoundV2ComparisonRow[] = [
    ...Array.from({ length: 270 }, (_, i) => row({ gameId: `go${i}`, finalResult: "over", v2OverProbability: 0.5, v2UnderProbability: 0.5, v2PushProbability: 0 })),
    ...Array.from({ length: 30 }, (_, i) => row({ gameId: `gu${i}`, finalResult: "under", v2OverProbability: 0.5, v2UnderProbability: 0.5, v2PushProbability: 0 })),
  ];
  const evidence = buildMoundV2PromotionEvidence(mostlyOver, { shadowEvaluationTotal: 300, shadowEvaluationFailures: 0, settlementOrProvenanceRegressionDetected: false });
  ok(evidence.sampleSize === 300, "sample size reflects the full graded-with-line strikeouts sample");
  ok(evidence.strikeoutsBrierDelta > 0, `a coin-flip V2 scores WORSE than a 90/10 climatology baseline on a 90/10 sample — Brier delta must be positive (got ${evidence.strikeoutsBrierDelta})`);
  ok(evidence.strikeoutsLogLossDelta > 0, "same for log loss — V2 underperforms the naive base-rate baseline");

  const verdict = buildAndEvaluateMoundV2Promotion(mostlyOver, { shadowEvaluationTotal: 300, shadowEvaluationFailures: 0, settlementOrProvenanceRegressionDetected: false }).verdict;
  ok(!verdict.readyForPromotion && verdict.blockers.includes("BRIER_NOT_IMPROVED"), "failing to beat climatology blocks promotion on its own, independent of sample size or coverage");
}

// ── Floating-point noise around an exact theoretical tie never trips the gate ──
// A climatology baseline is tautologically ~perfectly calibrated against its
// own generating sample, so a well-calibrated V2 (the fixture above) ties it
// in theory — but summing many small floating-point terms can leave a
// +/-1e-14-ish residue on either side of that exact 0. This must never read
// as a real regression (or a real improvement) on its own.
{
  const great = [
    ...Array.from({ length: 90 }, (_, i) => row({ gameId: `ga${i}`, finalResult: "over", v2OverProbability: 0.9, v2UnderProbability: 0.1, v2PushProbability: 0 })),
    ...Array.from({ length: 10 }, (_, i) => row({ gameId: `gb${i}`, finalResult: "under", v2OverProbability: 0.9, v2UnderProbability: 0.1, v2PushProbability: 0 })),
    ...Array.from({ length: 10 }, (_, i) => row({ gameId: `gc${i}`, finalResult: "over", v2OverProbability: 0.1, v2UnderProbability: 0.9, v2PushProbability: 0 })),
    ...Array.from({ length: 90 }, (_, i) => row({ gameId: `gd${i}`, finalResult: "under", v2OverProbability: 0.1, v2UnderProbability: 0.9, v2PushProbability: 0 })),
  ];
  const evidence = buildMoundV2PromotionEvidence(great, { shadowEvaluationTotal: 200, shadowEvaluationFailures: 0, settlementOrProvenanceRegressionDetected: false });
  ok(evidence.strikeoutsCalibrationErrorDelta === 0, `an exact theoretical calibration tie snaps to precisely 0, not a floating-point-noise epsilon (got ${evidence.strikeoutsCalibrationErrorDelta})`);
}

// ── Market coverage from real shadow-evaluation counters ─────────────────
{
  const rows = Array.from({ length: 250 }, (_, i) => row({ gameId: `g${i}`, finalResult: i % 2 === 0 ? "over" : "under" }));
  const evidence = buildMoundV2PromotionEvidence(rows, { shadowEvaluationTotal: 1000, shadowEvaluationFailures: 200, settlementOrProvenanceRegressionDetected: false });
  ok(Math.abs(evidence.marketCoverage - 0.8) < 1e-9, `marketCoverage = (total - failures) / total = 800/1000 = 0.8 (got ${evidence.marketCoverage})`);
  ok(evidence.marketCoverage >= MOUND_V2_PROMOTION_THRESHOLDS.minMarketCoverage, "0.8 coverage exactly meets the 0.8 threshold (>=, not >)");
}

console.log(`\nmoundV2PromotionEvidenceAdapter.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
