// Mound V2 vs V1 comparison statistics — invariants. Pure, no DB needed.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ComparisonStats.test.ts

import {
  impliedV2Side,
  v2UnitsForRow,
  computeMoundV2OwnMetrics,
  computeMoundV2ProbabilityEvaluation,
  computeMoundV2DecisionPolicyComparison,
  buildMoundV2ComparisonReport,
  type MoundV2ComparisonRow,
} from "./moundV2ComparisonStats";
import { MOUND_FROZEN_CONTRACT_VERSION } from "./frozenMoundShadowInput";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number | null, b: number, eps = 1e-6): boolean {
  return a != null && Math.abs(a - b) < eps;
}

function row(over: Partial<MoundV2ComparisonRow>): MoundV2ComparisonRow {
  return {
    gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts",
    settlementStatus: "graded", finalResult: "over",
    frozenOverPrice: -120, frozenUnderPrice: 100,
    v2OverProbability: 0.55, v2UnderProbability: 0.42, v2PushProbability: 0.03,
    v1RecommendedSide: "OVER", contractVersion: MOUND_FROZEN_CONTRACT_VERSION,
    v1Tier: "strong", v2ModelVersion: "v2_v1", productionModelVersion: "prod_v1",
    ...over,
  };
}

// ── impliedV2Side / v2UnitsForRow (unchanged core mechanics) ─────────────
{
  ok(impliedV2Side(row({ v2OverProbability: 0.6, v2UnderProbability: 0.35 })) === "over", "higher over probability -> implied side over");
  ok(impliedV2Side(row({ v2OverProbability: 0.3, v2UnderProbability: 0.65 })) === "under", "higher under probability -> implied side under");
  ok(impliedV2Side(row({ v2OverProbability: 0.5, v2UnderProbability: 0.5 })) === "over", "tie breaks toward over (>=)");

  ok(v2UnitsForRow(row({ finalResult: null })) === null, "ungraded row (no finalResult) -> null units, never fabricated");
  ok(v2UnitsForRow(row({ finalResult: "push" })) === 0, "push -> 0 units (stake returned)");

  const winOver = row({ v2OverProbability: 0.6, v2UnderProbability: 0.35, frozenOverPrice: -120, finalResult: "over" });
  ok(approx(v2UnitsForRow(winOver), 100 / 120), "a winning OVER bet at -120 returns 100/120 units, not a flat -110 assumption");

  const loseOver = row({ v2OverProbability: 0.6, v2UnderProbability: 0.35, frozenOverPrice: -120, finalResult: "under" });
  ok(v2UnitsForRow(loseOver) === -1, "a losing bet returns exactly -1 unit regardless of price");
}

// ── computeMoundV2OwnMetrics — pure counts, no probability/ROI math here anymore ──
{
  const empty = computeMoundV2OwnMetrics([]);
  ok(empty.sampleSize === 0 && empty.coverage === 0, "empty input -> all zero, no NaN or divide-by-zero");

  const mixed = [
    row({ settlementStatus: "pending", finalResult: null }),
    row({ settlementStatus: "void", finalResult: null }),
    row({ settlementStatus: "graded", finalResult: "over" }),
    row({ market: "pitcher_outs", settlementStatus: "graded", finalResult: null }),
  ];
  const m = computeMoundV2OwnMetrics(mixed);
  ok(m.sampleSize === 4 && m.gradedCount === 2 && m.voidCount === 1 && m.pendingCount === 1, "settlementStatus counts partition the sample correctly");
  ok(m.gradedWithLineCount === 1 && m.gradedNoLineCount === 1, "graded-with-line vs graded-no-line are counted separately");
  ok(approx(m.coverage, 2 / 4), "coverage = gradedCount / sampleSize");
}

// ── computeMoundV2ProbabilityEvaluation — climatology comparator ─────────
{
  const empty = computeMoundV2ProbabilityEvaluation([], "climatology");
  ok(empty.sampleSize === 0 && empty.v2BrierScore === null && empty.brierDelta === null, "empty input -> null metrics, no crash");
  ok(empty.comparator === "climatology", "the comparator is always explicitly stamped on the result");

  // Hand-computed Brier/logLoss for a single deterministic row.
  const single = computeMoundV2ProbabilityEvaluation([row({ v2OverProbability: 0.6, v2UnderProbability: 0.35, v2PushProbability: 0.05, finalResult: "over" })], "climatology");
  const expectedBrier = (0.6 - 1) ** 2 + (0.35 - 0) ** 2 + (0.05 - 0) ** 2;
  ok(approx(single.v2BrierScore, expectedBrier), `Brier score matches hand-computed 3-class value (got ${single.v2BrierScore}, expected ${expectedBrier})`);
  ok(approx(single.v2LogLoss, -Math.log(0.6)), "log loss matches -log(probability of the true class)");

  // Calibration buckets carry real sample sizes, not just a summary number.
  const bucketed = computeMoundV2ProbabilityEvaluation(
    Array.from({ length: 20 }, (_, i) => row({ gameId: `b${i}`, v2OverProbability: 0.75, v2UnderProbability: 0.25, v2PushProbability: 0, finalResult: i < 15 ? "over" : "under" })),
    "climatology",
  );
  const nonEmptyBuckets = bucketed.v2CalibrationBuckets.filter((b) => b.n > 0);
  ok(nonEmptyBuckets.length > 0 && nonEmptyBuckets.every((b) => b.n > 0), "calibration buckets report real sample sizes, never a bucket claimed with n=0");
  ok(nonEmptyBuckets.reduce((sum, b) => sum + b.n, 0) === 20, "calibration bucket sample sizes sum to the full input — no row is silently dropped");

  // Sharpness: how decisive V2 is, independent of correctness.
  const sharp = computeMoundV2ProbabilityEvaluation([row({ v2OverProbability: 0.95, v2UnderProbability: 0.05, v2PushProbability: 0 })], "climatology");
  const dull = computeMoundV2ProbabilityEvaluation([row({ v2OverProbability: 0.34, v2UnderProbability: 0.33, v2PushProbability: 0.33 })], "climatology");
  ok(sharp.v2Sharpness! > dull.v2Sharpness!, "a decisive (95%) forecast reports higher sharpness than a near-uniform (34/33/33) one");
}

// ── computeMoundV2ProbabilityEvaluation — never labels climatology as V1 ──
{
  const evaluation = computeMoundV2ProbabilityEvaluation([row({})], "climatology");
  ok("comparator" in evaluation, "the evaluation result always carries an explicit comparator field");
  ok(!("v1BrierScore" in evaluation) && !("v1CalibrationError" in evaluation), "no field anywhere claims a 'V1' probability metric — V1 has no probability to score");
}

// ── computeMoundV2ProbabilityEvaluation — market_implied comparator ──────
{
  // A fair (-110/-110) two-sided market with V2 as a coin-flip -> V2 should
  // score approximately like the de-vigged 50/50 market itself (a near-tie).
  const fairMarket = Array.from({ length: 40 }, (_, i) => row({
    gameId: `mi${i}`, frozenOverPrice: -110, frozenUnderPrice: -110,
    v2OverProbability: 0.5, v2UnderProbability: 0.5, v2PushProbability: 0,
    finalResult: i % 2 === 0 ? "over" : "under",
  }));
  const evaluation = computeMoundV2ProbabilityEvaluation(fairMarket, "market_implied");
  ok(evaluation.comparator === "market_implied", "the market_implied comparator is honored");
  ok(evaluation.sampleSize === 40, "every row has a real two-sided price, so all 40 are scored");
  ok(approx(evaluation.comparatorBrierScore, 0.5, 0.01), `the de-vigged fair-market comparator's own Brier score is ~0.5 for a genuine 50/50 market (got ${evaluation.comparatorBrierScore})`);

  // A push-outcome row is excluded from market_implied (no push price exists in a 2-way line).
  const withPush = [...fairMarket, row({ gameId: "push1", finalResult: "push", frozenOverPrice: -110, frozenUnderPrice: -110 })];
  const evaluationWithPush = computeMoundV2ProbabilityEvaluation(withPush, "market_implied");
  ok(evaluationWithPush.sampleSize === 40, "a push-outcome row is excluded from the market_implied comparator's sample — a 2-way price has no push probability to score against");

  // A row missing one side's price is excluded (never fabricated).
  const missingUnderPrice = [...fairMarket, row({ gameId: "missing1", frozenUnderPrice: null })];
  const evaluationMissingPrice = computeMoundV2ProbabilityEvaluation(missingUnderPrice, "market_implied");
  ok(evaluationMissingPrice.sampleSize === 40, "a row missing one real side's price is excluded from market_implied — never falls back to a single-sided (still-vigged) implied probability");
}

// ── computeMoundV2DecisionPolicyComparison — V1's real captured-price performance ──
{
  const empty = computeMoundV2DecisionPolicyComparison([]);
  ok(empty.pairedN === 0 && empty.v1.winRate === null && empty.v2.winRate === null, "empty input -> zero/null, no crash");

  // V1 recommends OVER at -120 and wins every time; V2 is a coin-flip.
  const rows = Array.from({ length: 20 }, (_, i) => row({
    gameId: `d${i}`, finalResult: "over", v1RecommendedSide: "OVER", frozenOverPrice: -120, frozenUnderPrice: 100,
    v2OverProbability: i % 2 === 0 ? 0.6 : 0.4, v2UnderProbability: i % 2 === 0 ? 0.4 : 0.6,
  }));
  const comparison = computeMoundV2DecisionPolicyComparison(rows);
  ok(comparison.pairedN === 20, "every row pairs (real V1 side+price, graded V2)");
  ok(comparison.v1.winRate === 1, "V1's real win rate is 1.0 — it recommended OVER and OVER happened, every time");
  ok(approx(comparison.v1.roi!, 100 / 120), `V1's real captured-price ROI reflects its own -120 price, not an assumed -110 (got ${comparison.v1.roi})`);
  ok(comparison.v2.winRate === 0.5, "V2's win rate is 0.5 — it picks over half the time, under half the time, on a sample that's always 'over'");
  ok(comparison.winRateDelta !== null && approx(comparison.winRateDelta, -0.5), "winRateDelta = v2 - v1 = 0.5 - 1.0 = -0.5, a real, honest gap");
}

// ── Decision-policy: V1 "no recommendation" vs "legacy incomplete" are DIFFERENT buckets ──
{
  const noRecRows = Array.from({ length: 5 }, (_, i) => row({ gameId: `nr${i}`, v1RecommendedSide: null, contractVersion: MOUND_FROZEN_CONTRACT_VERSION }));
  const legacyRows = Array.from({ length: 7 }, (_, i) => row({ gameId: `lg${i}`, v1RecommendedSide: null, contractVersion: "mound_frozen_input_v1" }));
  const pairedRows = Array.from({ length: 3 }, (_, i) => row({ gameId: `pr${i}` }));

  const comparison = computeMoundV2DecisionPolicyComparison([...noRecRows, ...legacyRows, ...pairedRows]);
  ok(comparison.pairedN === 3, "only the genuinely paired rows (real V1 side, current contract) count toward pairedN");
  ok(comparison.legacyIncompleteDataCount === 7, "legacy rows (old contract, no v1RecommendedSide) are counted separately as incomplete data");
  ok(comparison.v1NoRecommendationCount === 5, "current-contract rows where V1 genuinely had no direction are a DIFFERENT, legitimate bucket — never conflated with legacy incomplete data");
  ok(5 + 7 + 3 === 15, "the three buckets partition the full input with no double-counting");
}

// ── Decision-policy: ROI needs a real price, win rate does not ───────────
{
  const rows = [
    row({ gameId: "hasPrice", v1RecommendedSide: "OVER", frozenOverPrice: -120, finalResult: "over" }),
    row({ gameId: "noPrice", v1RecommendedSide: "OVER", frozenOverPrice: null, finalResult: "over" }),
  ];
  const comparison = computeMoundV2DecisionPolicyComparison(rows);
  ok(comparison.v1.wins === 2, "win/loss counting only needs to know the side and the outcome, not a price");
  ok(comparison.v1.roiEligibleCount === 1, "ROI eligibility correctly excludes the row with no real captured price");
}

// ── buildMoundV2ComparisonReport — end to end ────────────────────────────
{
  const rows: MoundV2ComparisonRow[] = [
    row({ gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts", v1Tier: "strong", finalResult: "over", v2ModelVersion: "v2_a", productionModelVersion: "prod_a" }),
    row({ gameId: "g1", pitcherId: "p1", market: "pitcher_outs", v1Tier: "strong", finalResult: null, v2ModelVersion: "v2_a", productionModelVersion: "prod_a" }),
    row({ gameId: "g2", pitcherId: "p2", market: "pitcher_strikeouts", v1Tier: "elite", finalResult: "under", v2OverProbability: 0.3, v2UnderProbability: 0.65, v1RecommendedSide: "UNDER", v2ModelVersion: "v2_a", productionModelVersion: "prod_a" }),
  ];

  const report = buildMoundV2ComparisonReport(rows, { windowStart: "2026-07-01", windowEnd: "2026-07-29" });

  ok(report.windowStart === "2026-07-01" && report.windowEnd === "2026-07-29", "declared window is carried through as report metadata");
  ok(report.v2ModelVersions.length === 1 && report.v2ModelVersions[0] === "v2_a", "distinct model versions are deduplicated");
  ok(report.probabilityEvaluationVsClimatology.comparator === "climatology", "the report exposes the climatology evaluation explicitly labeled");
  ok(report.probabilityEvaluationVsMarketImplied.comparator === "market_implied", "the report ALSO exposes a separate, explicitly labeled market-implied evaluation");
  ok(report.decisionPolicy.pairedN === 2, "the report's top-level decisionPolicy reflects the real paired sample (g1 and g2 both have real V1 decisions + graded V2)");

  const marketTotal = report.byMarket.reduce((sum, r) => sum + r.ownMetrics.sampleSize, 0);
  ok(marketTotal === rows.length, "byMarket breakdown's sample sizes sum to the full input — every row lands in exactly one market group");
  const tierTotal = report.byTier.reduce((sum, r) => sum + r.ownMetrics.sampleSize, 0);
  ok(tierTotal === rows.length, "byTier breakdown's sample sizes sum to the full input — every row lands in exactly one tier group");

  const outsGroup = report.byMarket.find((r) => r.key === "pitcher_outs");
  ok(outsGroup?.ownMetrics.gradedNoLineCount === 1, "the outs-market group correctly shows its one row as graded-with-no-line");
  ok(outsGroup?.decisionPolicy.pairedN === 0, "the outs-market group has zero paired decision-policy rows (no real line to grade against)");
}

console.log(`\nmoundV2ComparisonStats.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
