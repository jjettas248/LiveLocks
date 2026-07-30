// Mound V2 promotion evidence adapter — invariants. Pure, no DB needed.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2PromotionEvidenceAdapter.test.ts

import {
  buildMoundV2PromotionEvidence,
  buildAndEvaluateMoundV2Promotion,
} from "./moundV2PromotionEvidenceAdapter";
import { MOUND_V2_PROMOTION_THRESHOLDS } from "./moundV2PromotionGate";
import { MOUND_FROZEN_CONTRACT_VERSION } from "./frozenMoundShadowInput";
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
    v1RecommendedSide: "OVER", contractVersion: MOUND_FROZEN_CONTRACT_VERSION,
    v1Tier: "strong", v2ModelVersion: "v2_v1", productionModelVersion: "prod_v1",
    ...over,
  };
}

const baseOpts = { probabilityComparator: "climatology" as const, shadowEvaluationTotal: 0, shadowEvaluationFailures: 0, settlementOrProvenanceRegressionDetected: false };

// ── Fail-closed on missing data ──────────────────────────────────────────
{
  const evidence = buildMoundV2PromotionEvidence([], baseOpts);
  ok(evidence.sampleSize === 0, "empty input -> sampleSize 0");
  ok(evidence.calibrationErrorDelta === Number.POSITIVE_INFINITY, "no data at all -> calibration delta reads as +Infinity (blocks), never 0 (would wrongly pass)");
  ok(evidence.brierDelta === Number.POSITIVE_INFINITY, "no data at all -> Brier delta reads as +Infinity");
  ok(evidence.logLossDelta === Number.POSITIVE_INFINITY, "no data at all -> log-loss delta reads as +Infinity");
  ok(evidence.marketCoverage === 0, "zero shadow evaluations -> marketCoverage 0 (fail-closed, not undefined/NaN)");
  ok(evidence.decisionPolicyPairedN === 0, "no data -> zero paired decision-policy sample");
  ok(evidence.winRateDelta === null && evidence.roiDelta === null, "no data -> null win-rate/roi deltas, never a fabricated number");
  ok(evidence.probabilityComparator === "climatology", "the comparator is always explicitly named on the evidence");

  const verdict = buildAndEvaluateMoundV2Promotion([], baseOpts).verdict;
  ok(!verdict.readyForPromotion, "empty evidence never reads as ready for promotion");
  ok(verdict.blockers.includes("INSUFFICIENT_SAMPLE_SIZE") && verdict.blockers.includes("CALIBRATION_NOT_IMPROVED") && verdict.blockers.includes("INSUFFICIENT_PAIRED_DECISION_POLICY_SAMPLE"), "empty evidence trips multiple independent blockers from BOTH criteria families at once");
}

// ── Outs-market rows never contribute (no real line to score against) ────
{
  const outsOnly = Array.from({ length: 500 }, (_, i) => row({ market: "pitcher_outs", gameId: `g${i}`, finalResult: null }));
  const evidence = buildMoundV2PromotionEvidence(outsOnly, baseOpts);
  ok(evidence.sampleSize === 0, "outs-market rows (no real line) never contribute to the strikeouts-scoped sample size, however many there are");
  ok(evidence.decisionPolicyPairedN === 0, "outs-market rows never contribute to decision-policy pairing either");
}

// ── Legacy rows (predate v1RecommendedSide) are excluded from decision-policy, with an explicit count ──
{
  const legacyRows = Array.from({ length: 150 }, (_, i) => row({
    gameId: `legacy${i}`, finalResult: i % 10 === 0 ? "under" : "over",
    contractVersion: "mound_frozen_input_v1", v1RecommendedSide: null,
  }));
  const evidence = buildMoundV2PromotionEvidence(legacyRows, baseOpts);
  ok(evidence.decisionPolicyPairedN === 0, "legacy rows never enter the paired decision-policy sample");
  ok(evidence.decisionPolicyLegacyIncompleteCount === 150, `every legacy row is counted explicitly as incomplete (got ${evidence.decisionPolicyLegacyIncompleteCount})`);
}

// ── Regression flag always blocks, independent of every other criterion ──
{
  // A climatology baseline is tautologically ~perfectly calibrated against
  // its own generating sample, so beating it on calibration requires V2 to
  // ALSO be well-calibrated at each of its own confidence levels — two
  // symmetric, individually-well-calibrated 90%-confidence buckets satisfy
  // that. Each row also carries a real V1 decision that agrees with V2's own
  // implied side on every row (so both models genuinely tie at a 90% win
  // rate on this sample, rather than one being artificially perfect) — a
  // fair, fully-clean happy path for BOTH criteria families.
  const great: MoundV2ComparisonRow[] = [
    ...Array.from({ length: 90 }, (_, i) => row({ gameId: `ga${i}`, finalResult: "over", v2OverProbability: 0.9, v2UnderProbability: 0.1, v2PushProbability: 0, v1RecommendedSide: "OVER" })),
    ...Array.from({ length: 10 }, (_, i) => row({ gameId: `gb${i}`, finalResult: "under", v2OverProbability: 0.9, v2UnderProbability: 0.1, v2PushProbability: 0, v1RecommendedSide: "OVER" })),
    ...Array.from({ length: 10 }, (_, i) => row({ gameId: `gc${i}`, finalResult: "over", v2OverProbability: 0.1, v2UnderProbability: 0.9, v2PushProbability: 0, v1RecommendedSide: "UNDER" })),
    ...Array.from({ length: 90 }, (_, i) => row({ gameId: `gd${i}`, finalResult: "under", v2OverProbability: 0.1, v2UnderProbability: 0.9, v2PushProbability: 0, v1RecommendedSide: "UNDER" })),
  ];
  const cleanVerdict = buildAndEvaluateMoundV2Promotion(great, { ...baseOpts, shadowEvaluationTotal: 300 }).verdict;
  ok(cleanVerdict.readyForPromotion, `a large, well-calibrated, fully-covered, paired-decision-policy-clean sample with no regression IS ready for promotion (blockers: ${cleanVerdict.blockers.join(", ")})`);

  const regressionVerdict = buildAndEvaluateMoundV2Promotion(great, { ...baseOpts, shadowEvaluationTotal: 300, settlementOrProvenanceRegressionDetected: true }).verdict;
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
  const evidence = buildMoundV2PromotionEvidence(mostlyOver, { ...baseOpts, shadowEvaluationTotal: 300 });
  ok(evidence.sampleSize === 300, "sample size reflects the full graded-with-line strikeouts sample");
  ok(evidence.brierDelta > 0, `a coin-flip V2 scores WORSE than a 90/10 climatology baseline on a 90/10 sample — Brier delta must be positive (got ${evidence.brierDelta})`);
  ok(evidence.logLossDelta > 0, "same for log loss — V2 underperforms the naive base-rate baseline");

  const verdict = buildAndEvaluateMoundV2Promotion(mostlyOver, { ...baseOpts, shadowEvaluationTotal: 300 }).verdict;
  ok(!verdict.readyForPromotion && verdict.blockers.includes("BRIER_NOT_IMPROVED"), "failing to beat climatology blocks promotion on its own, independent of sample size or coverage");
}

// ── Decision-policy: V1's real captured-price performance now feeds the gate ──
{
  // V1 recommends OVER on every row at -120 and wins every time (finalResult
  // always "over") — a real, decisive, profitable V1 policy on this sample.
  // V2, meanwhile, is a coin-flip that only wins half the time.
  const rows: MoundV2ComparisonRow[] = Array.from({ length: 150 }, (_, i) => row({
    gameId: `d${i}`, finalResult: "over",
    v1RecommendedSide: "OVER", frozenOverPrice: -120, frozenUnderPrice: 100,
    v2OverProbability: i % 2 === 0 ? 0.51 : 0.49, v2UnderProbability: i % 2 === 0 ? 0.49 : 0.51, v2PushProbability: 0,
  }));
  const evidence = buildMoundV2PromotionEvidence(rows, { ...baseOpts, shadowEvaluationTotal: 150 });
  ok(evidence.decisionPolicyPairedN === 150, "every row pairs (V1 has a real side+price, V2 graded with a line)");
  ok(evidence.decisionPolicyLegacyIncompleteCount === 0, "no legacy rows in this fixture");
  ok(evidence.winRateDelta !== null && evidence.winRateDelta < 0, `V2's coin-flip win rate trails V1's perfect record — winRateDelta must be negative (got ${evidence.winRateDelta})`);

  const verdict = buildAndEvaluateMoundV2Promotion(rows, { ...baseOpts, shadowEvaluationTotal: 150 }).verdict;
  ok(!verdict.readyForPromotion && verdict.blockers.includes("DECISION_POLICY_WIN_RATE_NOT_NON_INFERIOR"), "V2 meaningfully underperforming V1's real captured-price decision policy blocks promotion, independent of probability-quality criteria");
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
  const evidence = buildMoundV2PromotionEvidence(great, { ...baseOpts, shadowEvaluationTotal: 200 });
  ok(evidence.calibrationErrorDelta === 0, `an exact theoretical calibration tie snaps to precisely 0, not a floating-point-noise epsilon (got ${evidence.calibrationErrorDelta})`);
}

// ── Market coverage from real shadow-evaluation counters ─────────────────
{
  const rows = Array.from({ length: 250 }, (_, i) => row({ gameId: `g${i}`, finalResult: i % 2 === 0 ? "over" : "under" }));
  const evidence = buildMoundV2PromotionEvidence(rows, { ...baseOpts, shadowEvaluationTotal: 1000, shadowEvaluationFailures: 200 });
  ok(Math.abs(evidence.marketCoverage - 0.8) < 1e-9, `marketCoverage = (total - failures) / total = 800/1000 = 0.8 (got ${evidence.marketCoverage})`);
  ok(evidence.marketCoverage >= MOUND_V2_PROMOTION_THRESHOLDS.minMarketCoverage, "0.8 coverage exactly meets the 0.8 threshold (>=, not >)");
}

// ── The market_implied comparator is honored end to end ──────────────────
{
  const rows: MoundV2ComparisonRow[] = Array.from({ length: 150 }, (_, i) => row({
    gameId: `mi${i}`, finalResult: i % 2 === 0 ? "over" : "under",
    frozenOverPrice: -110, frozenUnderPrice: -110,
    v2OverProbability: 0.5, v2UnderProbability: 0.5, v2PushProbability: 0,
  }));
  const evidence = buildMoundV2PromotionEvidence(rows, { ...baseOpts, probabilityComparator: "market_implied", shadowEvaluationTotal: 150 });
  ok(evidence.probabilityComparator === "market_implied", "the requested comparator is honored, not silently defaulted to climatology");
}

console.log(`\nmoundV2PromotionEvidenceAdapter.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
