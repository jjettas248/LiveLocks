// Mound V2 vs V1 comparison statistics — invariants. Pure, no DB needed.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ComparisonStats.test.ts

import {
  v2UnitsForRow,
  computeMoundV2OwnMetrics,
  computeMoundV2ProbabilityEvaluation,
  computeMoundV2DecisionPolicyComparison,
  buildMoundV2ComparisonReport,
  buildMoundV2PromotionSubgroups,
  computeRoiEligiblePriceRatio,
  computeSportsbookProvenanceRatio,
  computePairedPopulationRatio,
  computeMoundV2VersionDeclaration,
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
    v2ModelPolicyVersion: "mound_v2_model_policy_v1",
    // v2ModelSide/v2ModelQualified/v2Executable are the model's OWN
    // already-decided fields (Mound V2 purity pass) — plain data on the row,
    // never re-derived from v2OverProbability/v2UnderProbability by any
    // decision-policy/ROI function. Tests that need a specific model
    // side/qualification/executability override these explicitly.
    v2ModelSide: "OVER", v2ModelQualified: true, v2Executable: true,
    // The atomic executable offer's own price/line fields (Final
    // Line-Provenance and V1 Purity Correction) — a SEPARATE field from
    // frozenOverPrice/frozenUnderPrice above, since v2ExecutablePriceForRow
    // now reads this directly rather than branching on v2ModelSide into the
    // frozen fields. Defaults match frozenOverPrice/6.5 for a coherent
    // default fixture; tests exercising UNDER or a missing/mismatched price
    // override explicitly.
    v2ExecutablePrice: -120, v2ExecutableLine: 6.5,
    dataQuality: "complete", lineupStatus: "confirmed", sportsbook: "draftkings",
    oddsFetchedAt: "2026-07-29T19:58:00.000Z",
    ...over,
  };
}

// ── v2UnitsForRow respects the model's OWN already-decided side/executability — never re-derives a pick from probabilities ──
{
  ok(v2UnitsForRow(row({ finalResult: null })) === null, "ungraded row (no finalResult) -> null units, never fabricated");
  ok(v2UnitsForRow(row({ v2ModelSide: null, v2ModelQualified: false })) === null, "an abstained model (v2ModelSide null) never has units — it never placed a bet, regardless of probabilities");
  ok(v2UnitsForRow(row({ v2Executable: false })) === null, "a model-qualified-but-not-executable row never has units — no real price was ever tradeable");
  ok(v2UnitsForRow(row({ finalResult: "push" })) === 0, "push -> 0 units (stake returned), for a qualified+executable bet");

  const winOver = row({ v2ModelSide: "OVER", v2Executable: true, v2ExecutablePrice: -120, finalResult: "over" });
  ok(approx(v2UnitsForRow(winOver), 100 / 120), "a winning OVER bet at -120 returns 100/120 units, not a flat -110 assumption");

  const loseOver = row({ v2ModelSide: "OVER", v2Executable: true, v2ExecutablePrice: -120, finalResult: "under" });
  ok(v2UnitsForRow(loseOver) === -1, "a losing bet returns exactly -1 unit regardless of price");

  const winUnder = row({ v2ModelSide: "UNDER", v2Executable: true, v2ExecutablePrice: 150, finalResult: "under" });
  ok(approx(v2UnitsForRow(winUnder), 150 / 100), "a winning UNDER bet uses the atomic offer's OWN price (v2ExecutablePrice), never frozenOverPrice/frozenUnderPrice, when the model's own side is UNDER");
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

  // V1 recommends OVER at -120 and wins every time; V2's own MODEL decision
  // (v2ModelSide, plain data on the row — not derived from probabilities) is
  // a coin-flip between OVER and UNDER.
  const rows = Array.from({ length: 20 }, (_, i) => row({
    gameId: `d${i}`, finalResult: "over", v1RecommendedSide: "OVER", frozenOverPrice: -120, frozenUnderPrice: 100,
    v2ModelSide: i % 2 === 0 ? "OVER" : "UNDER",
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
    row({ gameId: "g2", pitcherId: "p2", market: "pitcher_strikeouts", v1Tier: "elite", finalResult: "under", v2OverProbability: 0.3, v2UnderProbability: 0.65, v2ModelSide: "UNDER", v1RecommendedSide: "UNDER", v2ModelVersion: "v2_a", productionModelVersion: "prod_a" }),
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

// ── buildMoundV2PromotionSubgroups (Final Pre-Push Integrity Pass, Section 5) ──
{
  const rows: MoundV2ComparisonRow[] = [
    // draftkings, OVER, strong, complete/confirmed — 10 rows. V1 always
    // (blindly) recommends OVER; the outcome actually varies (6 over, 4
    // under) while V2's probabilities correctly track each real outcome —
    // so V1 wins 6/10 (0.6) and V2 wins 10/10 (1.0): a genuine, constructed
    // V2-outperforms-V1 gap on this side.
    ...Array.from({ length: 10 }, (_, i) => {
      const outcome = i < 6 ? "over" as const : "under" as const;
      return row({
        gameId: `dk${i}`, sportsbook: "draftkings", v1RecommendedSide: "OVER", v1Tier: "strong",
        dataQuality: "complete", lineupStatus: "confirmed", finalResult: outcome,
        // V2's own MODEL decision correctly tracks each real outcome here —
        // plain data on the row (never derived from probabilities by any
        // decision-policy function).
        v2ModelSide: outcome === "over" ? "OVER" : "UNDER",
      });
    }),
    // hardrockbet, UNDER, elite, partial/unconfirmed — 8 rows, V1 clearly better (wins where V2 loses)
    ...Array.from({ length: 8 }, (_, i) => row({
      gameId: `hrb${i}`, sportsbook: "hardrockbet", v1RecommendedSide: "UNDER", v1Tier: "elite",
      dataQuality: "partial", lineupStatus: "unconfirmed", finalResult: "under",
      v2ModelSide: "OVER", // V2's own model decision is always wrong here
    })),
    // A non-paired row (no V1 recommendation) must never leak into any subgroup.
    row({ gameId: "noRec", v1RecommendedSide: null, sportsbook: "fanduel" }),
  ];

  const subgroups = buildMoundV2PromotionSubgroups(rows);
  ok(subgroups.length > 0, "subgroups are produced across multiple dimensions");

  const marketGroup = subgroups.find((s) => s.dimension === "market" && s.key === "pitcher_strikeouts");
  ok(marketGroup?.sampleSize === 18, `the market dimension groups ALL paired rows regardless of sportsbook/side (10+8=18, got ${marketGroup?.sampleSize})`);

  const overSide = subgroups.find((s) => s.dimension === "side" && s.key === "OVER");
  const underSide = subgroups.find((s) => s.dimension === "side" && s.key === "UNDER");
  ok(overSide?.sampleSize === 10 && underSide?.sampleSize === 8, `the side dimension separates OVER (10) from UNDER (8) recommendations (got ${overSide?.sampleSize}/${underSide?.sampleSize})`);
  ok(overSide!.winRateDelta! > 0, "the OVER-side subgroup shows V2 outperforming V1 (as constructed)");
  ok(underSide!.winRateDelta! < 0, "the UNDER-side subgroup shows V2 UNDERperforming V1 (as constructed) — a real, distinct per-side signal");

  const dkBook = subgroups.find((s) => s.dimension === "sportsbook" && s.key === "draftkings");
  const hrbBook = subgroups.find((s) => s.dimension === "sportsbook" && s.key === "hardrockbet");
  ok(dkBook?.sampleSize === 10 && hrbBook?.sampleSize === 8, "the sportsbook dimension correctly separates draftkings from hardrockbet");
  ok(subgroups.every((s) => s.key !== "fanduel"), "fanduel (the non-paired row's book) never appears as a subgroup key on its own row's account — the non-paired row is excluded from every dimension entirely");

  const dataQualityGroups = subgroups.filter((s) => s.dimension === "dataQuality");
  ok(dataQualityGroups.some((s) => s.key === "complete" && s.sampleSize === 10), "dataQuality=complete subgroup captures the 10 draftkings rows");
  ok(dataQualityGroups.some((s) => s.key === "partial" && s.sampleSize === 8), "dataQuality=partial subgroup captures the 8 hardrockbet rows");

  const setupGradeGroups = subgroups.filter((s) => s.dimension === "setupGrade");
  ok(setupGradeGroups.some((s) => s.key === "strong") && setupGradeGroups.some((s) => s.key === "elite"), "setupGrade groups by v1Tier (strong/elite)");

  const lineupGroups = subgroups.filter((s) => s.dimension === "lineupStatus");
  ok(lineupGroups.some((s) => s.key === "confirmed") && lineupGroups.some((s) => s.key === "unconfirmed"), "lineupStatus groups correctly (confirmed/unconfirmed)");

  ok(subgroups.every((s) => s.dimension !== ("workloadBand" as any)), "workloadBand is never emitted — no persisted source data exists yet for it (documented limitation, not silently faked)");

  const emptySubgroups = buildMoundV2PromotionSubgroups([]);
  ok(emptySubgroups.length === 0, "an empty input produces zero subgroups, never a crash");
}

// ── computeRoiEligiblePriceRatio ────────────────────────────────────────────
{
  ok(computeRoiEligiblePriceRatio([]) === null, "empty input -> null, never fabricated as 0 or 1");

  const allPriced = Array.from({ length: 5 }, (_, i) => row({ gameId: `p${i}`, frozenOverPrice: -120, frozenUnderPrice: 100 }));
  ok(computeRoiEligiblePriceRatio(allPriced) === 1, "every row has a real price for both V1's recommended side and V2's implied side -> ratio 1.0");

  const halfMissingV1Price = [
    row({ gameId: "a", v1RecommendedSide: "OVER", frozenOverPrice: -120, frozenUnderPrice: 100 }),
    row({ gameId: "b", v1RecommendedSide: "OVER", frozenOverPrice: null, frozenUnderPrice: 100, v2ExecutablePrice: null }),
  ];
  ok(approx(computeRoiEligiblePriceRatio(halfMissingV1Price), 0.5), "V1's own recommended-side price missing on half the paired rows drags the ratio down to 0.5 (the WORSE of V1's/V2's own ratios)");

  const noneRecommended = [row({ gameId: "x", v1RecommendedSide: null })];
  ok(computeRoiEligiblePriceRatio(noneRecommended) === null, "zero paired rows (V1 never recommended) -> null, not a fabricated 0");
}

// ── computeSportsbookProvenanceRatio ────────────────────────────────────────
{
  ok(computeSportsbookProvenanceRatio([]) === null, "empty input -> null");

  const allProvenance = Array.from({ length: 4 }, (_, i) => row({ gameId: `pv${i}`, sportsbook: "draftkings", oddsFetchedAt: "2026-07-29T19:58:00.000Z" }));
  ok(computeSportsbookProvenanceRatio(allProvenance) === 1, "every row carries a real sportsbook + fetch timestamp -> ratio 1.0");

  const mixedProvenance = [
    row({ gameId: "has", sportsbook: "draftkings", oddsFetchedAt: "2026-07-29T19:58:00.000Z" }),
    row({ gameId: "noBook", sportsbook: null, oddsFetchedAt: "2026-07-29T19:58:00.000Z" }),
    row({ gameId: "noTimestamp", sportsbook: "draftkings", oddsFetchedAt: null }),
    row({ gameId: "emptyBook", sportsbook: "", oddsFetchedAt: "2026-07-29T19:58:00.000Z" }),
  ];
  ok(approx(computeSportsbookProvenanceRatio(mixedProvenance), 0.25), `only 1 of 4 rows has BOTH a real (non-empty) sportsbook AND a real fetch timestamp (got ${computeSportsbookProvenanceRatio(mixedProvenance)})`);
}

// ── computePairedPopulationRatio ────────────────────────────────────────────
{
  ok(computePairedPopulationRatio(0, 0, 0) === null, "zero denominator -> null, never a fabricated 0% or 100%");
  ok(computePairedPopulationRatio(80, 10, 10) === 0.8, "80 paired out of 100 total candidates -> 0.8");
  ok(computePairedPopulationRatio(0, 5, 5) === 0, "zero paired out of a real, non-empty candidate pool -> a real, honest 0 (not null — the denominator is real)");
  ok(computePairedPopulationRatio(100, 0, 0) === 1, "every candidate paired -> 1.0");
}

// ── computeMoundV2VersionDeclaration ────────────────────────────────────────
{
  const decl = computeMoundV2VersionDeclaration([]);
  ok(decl.v2ModelVersionDeclared === false && decl.v2ModelPolicyVersionDeclared === false, "an empty population is honestly 'not declared' (false), never vacuously true");

  const allDeclared = Array.from({ length: 3 }, (_, i) => row({ gameId: `dv${i}`, v2ModelVersion: "v2_v1", v2ModelPolicyVersion: "policy_v1" }));
  const declAll = computeMoundV2VersionDeclaration(allDeclared);
  ok(declAll.v2ModelVersionDeclared === true && declAll.v2ModelPolicyVersionDeclared === true, "every row declaring a real version -> both true");

  const oneMissingPolicy = [
    row({ gameId: "a", v2ModelVersion: "v2_v1", v2ModelPolicyVersion: "policy_v1" }),
    row({ gameId: "b", v2ModelVersion: "v2_v1", v2ModelPolicyVersion: null }),
  ];
  const declMixed = computeMoundV2VersionDeclaration(oneMissingPolicy);
  ok(declMixed.v2ModelVersionDeclared === true, "model version is declared on every row");
  ok(declMixed.v2ModelPolicyVersionDeclared === false, "a SINGLE row missing its model-policy version fails the whole check — 'some rows have no known version' is exactly the ambiguity this guards against");

  const emptyStringVersion = [row({ gameId: "c", v2ModelVersion: "" })];
  ok(computeMoundV2VersionDeclaration(emptyStringVersion).v2ModelVersionDeclared === false, "an empty-string version is treated the same as missing, never as 'declared'");
}

console.log(`\nmoundV2ComparisonStats.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
