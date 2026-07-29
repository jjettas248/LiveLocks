// Mound V2 vs V1 comparison statistics — invariants. Pure, no DB needed.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ComparisonStats.test.ts

import {
  impliedV2Side,
  v2UnitsForRow,
  computeMoundV2OwnMetrics,
  computeMoundV1Metrics,
  computeMoundV2PairedComparison,
  computeMoundV2CoverageReport,
  buildMoundV2ComparisonReport,
  type MoundV2ComparisonRow,
  type MoundV1OutcomeSummary,
} from "./moundV2ComparisonStats";

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
    v1Tier: "strong", v2ModelVersion: "v2_v1", productionModelVersion: "prod_v1",
    ...over,
  };
}

function v1(over: Partial<MoundV1OutcomeSummary>): MoundV1OutcomeSummary {
  return { gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts", marketOutcome: "cashed", tier: "strong", ...over };
}

// ── impliedV2Side / v2UnitsForRow ────────────────────────────────────────
{
  ok(impliedV2Side(row({ v2OverProbability: 0.6, v2UnderProbability: 0.35 })) === "over", "higher over probability -> implied side over");
  ok(impliedV2Side(row({ v2OverProbability: 0.3, v2UnderProbability: 0.65 })) === "under", "higher under probability -> implied side under");
  ok(impliedV2Side(row({ v2OverProbability: 0.5, v2UnderProbability: 0.5 })) === "over", "tie breaks toward over (>=)");

  ok(v2UnitsForRow(row({ finalResult: null })) === null, "ungraded row (no finalResult) -> null units, never fabricated");
  ok(v2UnitsForRow(row({ finalResult: "push" })) === 0, "push -> 0 units (stake returned)");

  const winOver = row({ v2OverProbability: 0.6, v2UnderProbability: 0.35, frozenOverPrice: -120, finalResult: "over" });
  ok(approx(v2UnitsForRow(winOver), 100 / 120), "a winning OVER bet at -120 returns 100/120 units, not a flat -110 assumption");

  const winUnderPlus = row({ v2OverProbability: 0.3, v2UnderProbability: 0.65, frozenUnderPrice: 150, finalResult: "under" });
  ok(approx(v2UnitsForRow(winUnderPlus), 1.5), "a winning UNDER bet at +150 returns 1.5 units");

  const loseOver = row({ v2OverProbability: 0.6, v2UnderProbability: 0.35, frozenOverPrice: -120, finalResult: "under" });
  ok(v2UnitsForRow(loseOver) === -1, "a losing bet returns exactly -1 unit regardless of price");

  const noPrice = row({ v2OverProbability: 0.6, v2UnderProbability: 0.35, frozenOverPrice: null, finalResult: "over" });
  ok(v2UnitsForRow(noPrice) === null, "a winning side with no captured price -> null, never assumes -110");
}

// ── computeMoundV2OwnMetrics ──────────────────────────────────────────────
{
  const empty = computeMoundV2OwnMetrics([]);
  ok(empty.sampleSize === 0 && empty.coverage === 0 && empty.brierScore === null && empty.roi === null, "empty input -> all zero/null, no NaN or divide-by-zero");

  const mixed = [
    row({ settlementStatus: "pending", finalResult: null }),
    row({ settlementStatus: "void", finalResult: null }),
    row({ settlementStatus: "graded", finalResult: "over" }),
  ];
  const m = computeMoundV2OwnMetrics(mixed);
  ok(m.sampleSize === 3 && m.gradedCount === 1 && m.voidCount === 1 && m.pendingCount === 1, "settlementStatus counts partition the sample correctly");
  ok(approx(m.coverage, 1 / 3), "coverage = gradedCount / sampleSize");

  // Outs-market row with no real line (frozenLine null upstream => finalResult still populated
  // by grading, but no line means grading never runs the comparison — modeled here directly as
  // a graded row with finalResult null, i.e. "graded, no line").
  const noLineRow = row({ market: "pitcher_outs", settlementStatus: "graded", finalResult: null });
  const withNoLine = computeMoundV2OwnMetrics([row({ finalResult: "over" }), noLineRow]);
  ok(withNoLine.gradedCount === 2 && withNoLine.gradedWithLineCount === 1 && withNoLine.gradedNoLineCount === 1, "graded-but-no-line rows are counted separately, never blended into calibration/ROI");
  ok(withNoLine.brierScore != null, "brierScore is still computed from the 1 row that DOES have a line");

  // Hand-computed Brier/logLoss for a single deterministic row.
  const single = computeMoundV2OwnMetrics([row({ v2OverProbability: 0.6, v2UnderProbability: 0.35, v2PushProbability: 0.05, finalResult: "over" })]);
  const expectedBrier = (0.6 - 1) ** 2 + (0.35 - 0) ** 2 + (0.05 - 0) ** 2;
  ok(approx(single.brierScore, expectedBrier), `Brier score matches hand-computed 3-class value (got ${single.brierScore}, expected ${expectedBrier})`);
  ok(approx(single.logLoss, -Math.log(0.6)), "log loss matches -log(probability of the true class)");

  // Win rate excludes push from the decided denominator.
  const withPush = computeMoundV2OwnMetrics([
    row({ finalResult: "over", v2OverProbability: 0.6, v2UnderProbability: 0.35 }),
    row({ finalResult: "under", v2OverProbability: 0.6, v2UnderProbability: 0.35 }),
    row({ finalResult: "push", v2OverProbability: 0.6, v2UnderProbability: 0.35 }),
  ]);
  ok(approx(withPush.winRate, 0.5), "win rate is computed over decided (non-push) rows only: 1 win, 1 loss, 1 push -> 0.5");
  ok(withPush.roiSampleSize === 3, "ROI sample size includes the push row (it's a valid 0-unit outcome), unlike the win-rate denominator");
}

// ── computeMoundV1Metrics ─────────────────────────────────────────────────
{
  const empty = computeMoundV1Metrics([]);
  ok(empty.sampleSize === 0 && empty.winRate === null, "empty V1 outcomes -> zero/null, no crash");

  const outcomes = [v1({ marketOutcome: "cashed" }), v1({ marketOutcome: "cashed" }), v1({ marketOutcome: "missed" }), v1({ marketOutcome: "push" }), v1({ marketOutcome: "unavailable" })];
  const m = computeMoundV1Metrics(outcomes);
  ok(m.cashed === 2 && m.missed === 1 && m.push === 1 && m.unavailable === 1, "V1 outcome counts are exact");
  ok(approx(m.winRate, 2 / 3), "V1 win rate excludes push and unavailable from the decided denominator (2 cashed / (2 cashed + 1 missed))");
  ok(typeof m.roiNote === "string" && m.roiNote.length > 0, "V1 metrics always carry an explanatory roiNote instead of a fabricated ROI number");
  ok(!("roi" in m), "MoundV1Metrics has no roi field at all — not just a null one, an honest absence");
}

// ── computeMoundV2PairedComparison ────────────────────────────────────────
{
  const v2Rows = [
    row({ gameId: "g1", pitcherId: "p1", finalResult: "over", v2OverProbability: 0.6, v2UnderProbability: 0.35 }), // will pair
    row({ gameId: "g2", pitcherId: "p2", finalResult: "over" }), // no V1 match at all
    row({ gameId: "g3", pitcherId: "p3", settlementStatus: "pending", finalResult: null }), // not graded, excluded even with a V1 match
  ];
  const v1Outcomes = [
    v1({ gameId: "g1", pitcherId: "p1", marketOutcome: "cashed" }),
    v1({ gameId: "g3", pitcherId: "p3", marketOutcome: "cashed" }),
    v1({ gameId: "g4", pitcherId: "p4", marketOutcome: "unavailable" }), // no matching v2 row at all
  ];
  const paired = computeMoundV2PairedComparison(v2Rows, v1Outcomes);
  ok(paired.pairedN === 1, `only the genuinely graded-both-sides pair counts (got ${paired.pairedN})`);
  ok(paired.v1WinRate === 1 && paired.v2WinRate === 1, "the one paired case: V1 cashed, V2's implied OVER also matched -> both win rates are 1");
  ok(approx(paired.winRateDelta ?? NaN, 0), "winRateDelta is 0 when both models agree and both win");
  ok(paired.v2Roi != null, "v2Roi is computed from V2's own captured price over the paired subset");
  ok(paired.v1RoiNote.length > 0, "v1RoiNote explains why there's no V1 ROI to diff against");

  const unavailableOnly = computeMoundV2PairedComparison(
    [row({ gameId: "g5", pitcherId: "p5", finalResult: "over" })],
    [v1({ gameId: "g5", pitcherId: "p5", marketOutcome: "unavailable" })],
  );
  ok(unavailableOnly.pairedN === 0, "a V1 match with marketOutcome=unavailable never counts as a paired bet");
}

// ── computeMoundV2CoverageReport — never double-counts ────────────────────
{
  const v2Rows = [
    row({ gameId: "g1", pitcherId: "p1", finalResult: "over" }),
    row({ gameId: "g2", pitcherId: "p2", finalResult: "over" }),
    row({ gameId: "g3", pitcherId: "p3", settlementStatus: "pending", finalResult: null }),
    row({ gameId: "g6", pitcherId: "p6", settlementStatus: "void", finalResult: null }),
  ];
  const v1Outcomes = [
    v1({ gameId: "g1", pitcherId: "p1", marketOutcome: "cashed" }),
    v1({ gameId: "g3", pitcherId: "p3", marketOutcome: "unavailable" }),
  ];
  const cov = computeMoundV2CoverageReport(v2Rows, v1Outcomes);
  ok(cov.totalV2InWindow === 4, "totalV2InWindow reflects every row passed in");
  ok(cov.v2WithV1Match + cov.v2WithNoV1Match === cov.totalV2InWindow, "every row is either matched or unmatched — the two buckets partition the whole sample exactly");
  ok(cov.v2WithV1Match === 2 && cov.v2WithNoV1Match === 2, "match/no-match counts are exact (g1,g3 matched; g2,g6 unmatched)");
  ok(cov.v1MatchedWithRealBet === 1 && cov.v1MatchedUnavailableBet === 1, "of the matched rows, real-bet vs unavailable-bet is split correctly");
  ok(cov.v2Graded === 2 && cov.v2Pending === 1 && cov.v2Void === 1, "settlementStatus breakdown is exact");
  ok(cov.pairedN === 1, "pairedN in the coverage report agrees with computeMoundV2PairedComparison for the same inputs");
}

// ── buildMoundV2ComparisonReport — end to end, breakdowns partition cleanly ──
{
  const v2Rows: MoundV2ComparisonRow[] = [
    row({ gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts", v1Tier: "strong", finalResult: "over", v2ModelVersion: "v2_a", productionModelVersion: "prod_a" }),
    row({ gameId: "g1", pitcherId: "p1", market: "pitcher_outs", v1Tier: "strong", finalResult: null, v2ModelVersion: "v2_a", productionModelVersion: "prod_a" }),
    row({ gameId: "g2", pitcherId: "p2", market: "pitcher_strikeouts", v1Tier: "elite", finalResult: "under", v2OverProbability: 0.3, v2UnderProbability: 0.65, v2ModelVersion: "v2_a", productionModelVersion: "prod_a" }),
  ];
  const v1Outcomes: MoundV1OutcomeSummary[] = [
    v1({ gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts", tier: "strong", marketOutcome: "cashed" }),
    v1({ gameId: "g2", pitcherId: "p2", market: "pitcher_strikeouts", tier: "elite", marketOutcome: "cashed" }),
  ];

  const report = buildMoundV2ComparisonReport(v2Rows, v1Outcomes, { windowStart: "2026-07-01", windowEnd: "2026-07-29" });

  ok(report.windowStart === "2026-07-01" && report.windowEnd === "2026-07-29", "declared window is carried through as report metadata");
  ok(report.v2ModelVersions.length === 1 && report.v2ModelVersions[0] === "v2_a", "distinct model versions are deduplicated");

  const marketTotal = report.byMarket.reduce((sum, r) => sum + r.v2.sampleSize, 0);
  ok(marketTotal === v2Rows.length, "byMarket breakdown's v2 sample sizes sum to the full input — every row lands in exactly one market group");
  const tierTotal = report.byTier.reduce((sum, r) => sum + r.v2.sampleSize, 0);
  ok(tierTotal === v2Rows.length, "byTier breakdown's v2 sample sizes sum to the full input — every row lands in exactly one tier group");

  const strikeoutsGroup = report.byMarket.find((r) => r.key === "pitcher_strikeouts");
  const outsGroup = report.byMarket.find((r) => r.key === "pitcher_outs");
  ok(strikeoutsGroup?.v2.sampleSize === 2 && outsGroup?.v2.sampleSize === 1, "market groups contain exactly the rows for that market");
  ok(outsGroup?.v2.gradedNoLineCount === 1, "the outs-market group correctly shows its one row as graded-with-no-line");

  ok(report.overallPaired.pairedN === 2, "overall paired count reflects both games (g1 and g2 both have real V1 bets and V2 graded-with-line results)");
}

console.log(`\nmoundV2ComparisonStats.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
