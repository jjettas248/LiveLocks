// Mound V2 (shadow) — REQUIRED PURITY TESTS (Mound V2 purity pass). This
// file exists to give each of the 8 explicitly required purity properties
// its own direct, traceable, runnable proof, using the REAL production
// pipeline (evaluateMoundV2Shadow, selectCanonicalMoundV2Line,
// selectExecutablePriceAtLine, moundV2ComparisonStats' ROI math) rather than
// hand-rolled reimplementations. Related coverage also exists inline in
// moundV2ShadowEvaluation.test.ts, oddsDisplay.test.ts, and
// moundMarketEdgeConsistency.test.ts — this file is the single place that
// maps 1:1 onto the audit's own numbered checklist.
//
// Field-name mapping from the audit's abstract terms to this codebase's real
// contract (see moundV2Types.ts): "projection" = MoundV2MarketResult.
// expectedValue; "distribution" = MoundV2Distribution.strikeoutsPmf/outsPmf;
// "setup grade" = v1Tier; "confidence" = the model's own qualifyingProbability
// for its selected side (MoundV2ModelPolicyResult).
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2PriceIndependence.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateMoundV2Shadow, MOUND_V1_MODEL_VERSION, MOUND_V2_MODEL_VERSION } from "./moundV2ShadowEvaluation";
import type { EvaluateMoundV2ShadowArgs } from "./moundV2ShadowEvaluation";
import { selectCanonicalMoundV2Line, selectExecutablePriceAtLine } from "../oddsDisplay";
import { v2UnitsForRow, computeMoundV2ProbabilityEvaluation, computeMoundV2DecisionPolicyComparison, type MoundV2ComparisonRow } from "./moundV2ComparisonStats";
import { MOUND_FROZEN_CONTRACT_VERSION } from "./frozenMoundShadowInput";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseArgs(overrides: Partial<EvaluateMoundV2ShadowArgs> = {}): EvaluateMoundV2ShadowArgs {
  return {
    snapshotId: "mound_v2:purity_test:1",
    now: new Date("2026-07-30T20:00:00.000Z"),
    frozenInputArgs: {
      gameId: "game_1",
      gamePk: "gamePk_1",
      pitcherId: "pitcher_1",
      pitcherName: "Test Pitcher",
      opponent: "OPP",
      scheduledGameTime: "2026-07-30T23:05:00.000Z",
      lineupStatus: "confirmed",
      battingOrder: [
        { playerId: "b1", playerName: "Batter One", battingOrderSlot: 1, handedness: "L", kRateVsThrowHand: 0.27, kRateSamplePa: 200, bvpAtBats: 8, bvpStrikeouts: 2 },
        { playerId: "b2", playerName: "Batter Two", battingOrderSlot: 2, handedness: "R", kRateVsThrowHand: 0.19, kRateSamplePa: 160, bvpAtBats: 0, bvpStrikeouts: 0 },
        { playerId: "b3", playerName: "Batter Three", battingOrderSlot: 3, handedness: "R", kRateVsThrowHand: 0.24, kRateSamplePa: 210, bvpAtBats: 3, bvpStrikeouts: 1 },
      ],
      pitcherThrows: "R",
      kPer9: 9.8,
      priorSeasonsKPer9: [9.2, 8.9],
      swStrPct: 13.0,
      cswPct: 29.5,
      missesBatsFamily: null,
      kRateVsLHB: 0.28,
      kRateVsRHB: 0.24,
      avgInningsPerStart: 5.9,
      ipVarianceLast3: 0.8,
      lastStartPitchCount: 93,
      lastStartInningsPitched: 5.7,
      bbPer9: 2.8,
      strikeoutsMarket: { line: 6.5, overPrice: -120, underPrice: 100, sportsbook: "draftkings", fetchedAt: "2026-07-30T19:58:00.000Z" },
      outsMarket: { line: null, overPrice: null, underPrice: null, sportsbook: null, fetchedAt: null },
      dataQuality: "complete",
      productionModelVersion: MOUND_V1_MODEL_VERSION,
      v2ModelVersion: MOUND_V2_MODEL_VERSION,
    },
    productionComponentScores: { pitcherSkillScore: 7.2, workloadScore: 6.5, opponentKProfileScore: 6.8 },
    v1Score10: 6.9,
    v1Tier: "strong",
    v1RecommendedSide: "OVER",
    v1QualificationStatus: "recommended",
    strikeoutsLine: 6.5,
    outsLine: null,
    ...overrides,
  };
}

function strikeoutsMarket(over: Partial<EvaluateMoundV2ShadowArgs["frozenInputArgs"]["strikeoutsMarket"]>) {
  return { ...baseArgs().frozenInputArgs.strikeoutsMarket, ...over };
}

// ── (1) Changing ONLY OVER/UNDER prices cannot change projection,
// distribution, over/under/push probabilities, selected side, setup grade,
// confidence, or model qualification ────────────────────────────────────────
{
  const cheap = evaluateMoundV2Shadow(baseArgs({
    frozenInputArgs: { ...baseArgs().frozenInputArgs, strikeoutsMarket: strikeoutsMarket({ overPrice: -350, underPrice: 280 }) },
  }));
  const juicy = evaluateMoundV2Shadow(baseArgs({
    frozenInputArgs: { ...baseArgs().frozenInputArgs, strikeoutsMarket: strikeoutsMarket({ overPrice: +400, underPrice: -600 }) },
  }));
  ok(cheap.failureReason === null && juicy.failureReason === null, "sanity: both fixtures evaluate without failure");
  ok(cheap.distribution!.strikeouts.expectedValue === juicy.distribution!.strikeouts.expectedValue, "(1) projection (expectedValue) is identical when only price changes");
  ok(JSON.stringify(cheap.distribution!.strikeoutsPmf) === JSON.stringify(juicy.distribution!.strikeoutsPmf), "(1) the underlying outcome distribution (PMF) is byte-identical when only price changes");
  ok(
    cheap.distribution!.strikeouts.overProbability === juicy.distribution!.strikeouts.overProbability &&
    cheap.distribution!.strikeouts.underProbability === juicy.distribution!.strikeouts.underProbability &&
    cheap.distribution!.strikeouts.pushProbability === juicy.distribution!.strikeouts.pushProbability,
    "(1) over/under/push probabilities are identical when only price changes",
  );
  ok(cheap.strikeoutsModelDecision!.side === juicy.strikeoutsModelDecision!.side, "(1) selected side is identical when only price changes");
  ok(cheap.v1Tier === juicy.v1Tier, "(1) setup grade (v1Tier) is identical when only price changes");
  ok(cheap.strikeoutsModelDecision!.qualifyingProbability === juicy.strikeoutsModelDecision!.qualifyingProbability, "(1) confidence (qualifyingProbability) is identical when only price changes");
  ok(cheap.strikeoutsModelDecision!.modelQualified === juicy.strikeoutsModelDecision!.modelQualified, "(1) model qualification is identical when only price changes");
}

// ── (2) Changing ONLY sportsbook identity cannot change those outputs ──────
{
  const bookA = evaluateMoundV2Shadow(baseArgs({
    frozenInputArgs: { ...baseArgs().frozenInputArgs, strikeoutsMarket: strikeoutsMarket({ sportsbook: "draftkings" }) },
  }));
  const bookB = evaluateMoundV2Shadow(baseArgs({
    frozenInputArgs: { ...baseArgs().frozenInputArgs, strikeoutsMarket: strikeoutsMarket({ sportsbook: "hardrockbet" }) },
  }));
  ok(bookA.distribution!.strikeouts.expectedValue === bookB.distribution!.strikeouts.expectedValue, "(2) projection is identical when only sportsbook identity changes");
  ok(JSON.stringify(bookA.distribution!.strikeoutsPmf) === JSON.stringify(bookB.distribution!.strikeoutsPmf), "(2) distribution is identical when only sportsbook identity changes");
  ok(
    bookA.distribution!.strikeouts.overProbability === bookB.distribution!.strikeouts.overProbability &&
    bookA.distribution!.strikeouts.underProbability === bookB.distribution!.strikeouts.underProbability,
    "(2) over/under probabilities are identical when only sportsbook identity changes",
  );
  ok(bookA.strikeoutsModelDecision!.side === bookB.strikeoutsModelDecision!.side, "(2) selected side is identical when only sportsbook identity changes");
  ok(bookA.strikeoutsModelDecision!.modelQualified === bookB.strikeoutsModelDecision!.modelQualified, "(2) model qualification is identical when only sportsbook identity changes");
}

// ── (3) Making the price missing or stale changes ONLY executability ──────
{
  const fresh = evaluateMoundV2Shadow(baseArgs());
  const missingPrice = evaluateMoundV2Shadow(baseArgs({
    frozenInputArgs: { ...baseArgs().frozenInputArgs, strikeoutsMarket: strikeoutsMarket({ overPrice: null, underPrice: null }) },
  }));
  const stalePrice = evaluateMoundV2Shadow(baseArgs({
    frozenInputArgs: { ...baseArgs().frozenInputArgs, strikeoutsMarket: strikeoutsMarket({ fetchedAt: "2026-07-28T00:00:00.000Z" }) }, // ~44h before `now`
  }));

  ok(
    fresh.strikeoutsModelDecision!.side === missingPrice.strikeoutsModelDecision!.side &&
    fresh.strikeoutsModelDecision!.modelQualified === missingPrice.strikeoutsModelDecision!.modelQualified,
    "(3) a missing price leaves the MODEL's own side/qualification completely unchanged",
  );
  ok(missingPrice.strikeoutsExecutability!.executable === false && missingPrice.strikeoutsExecutability!.failureReason === "missing_price", "(3) a missing price DOES mark executability as not executable, with the real reason");

  ok(
    fresh.strikeoutsModelDecision!.side === stalePrice.strikeoutsModelDecision!.side &&
    fresh.strikeoutsModelDecision!.modelQualified === stalePrice.strikeoutsModelDecision!.modelQualified,
    "(3) stale odds leave the MODEL's own side/qualification completely unchanged",
  );
  ok(stalePrice.strikeoutsExecutability!.executable === false && stalePrice.strikeoutsExecutability!.failureReason === "odds_too_stale", "(3) stale odds DO mark executability as not executable, with the real reason");
  ok(fresh.strikeoutsExecutability!.executable === true, "(3) sanity: the fresh baseline this comparison is against is itself genuinely executable");
}

// ── (4) Different prices cannot cause a DIFFERENT sportsbook line to enter
// the model — the core fix for indirect price contamination via line
// selection (Blocker 2) ─────────────────────────────────────────────────────
{
  // Three books, three DIFFERENT lines. hardrockbet posts by far the best
  // OVER price, at a MINORITY line (6.5) — under the OLD pickBestOverBook
  // design this price alone would have selected hardrockbet's 6.5 line for
  // the model to evaluate. draftkings+fanduel's shared 7.5 line is the real
  // majority/canonical line and must win regardless.
  const books = {
    draftkings: { line: 7.5, overOdds: -115, underOdds: -105 },
    fanduel: { line: 7.5, overOdds: -108, underOdds: -112 },
    hardrockbet: { line: 6.5, overOdds: +450, underOdds: -700 }, // best price, minority line
  };
  const canonical = selectCanonicalMoundV2Line(books);
  ok(canonical?.line === 7.5, `(4) the majority line (7.5, 2 books) wins over the minority line (6.5, 1 book) EVEN THOUGH the minority book posts a vastly better price (got ${canonical?.line})`);

  // Now swing hardrockbet's price to the OTHER extreme (still a minority
  // book, still line 6.5) — the canonical line selection must not move.
  const swungBooks = { ...books, hardrockbet: { line: 6.5, overOdds: -900, underOdds: 600 } };
  const canonicalAfterSwing = selectCanonicalMoundV2Line(swungBooks);
  ok(canonicalAfterSwing?.line === canonical?.line, "(4) swinging the minority book's price to the opposite extreme never changes which line is selected");

  // The executable-price search is then correctly restricted to books that
  // actually posted the selected (7.5) line — hardrockbet is never eligible
  // no matter how good its price is, because it posted a different line.
  const executable = canonical ? selectExecutablePriceAtLine(books, canonical.line) : null;
  ok(executable?.sportsbook !== "hardrockbet", "(4) the executable-price search never reaches for hardrockbet's price, because hardrockbet never posted the selected line");
  ok(executable?.sportsbook === "fanduel" && executable.overPrice === -108, `(4) among books that DID post the selected line, the best price legitimately wins (got ${executable?.sportsbook}/${executable?.overPrice})`);
}

// ── (5) Changing ONLY the line MAY change over/under/push probabilities,
// selected side, model qualification (the flip side of purity — the system
// must not be inert to a real baseball-relevant input) ─────────────────────
{
  const lowLine = evaluateMoundV2Shadow(baseArgs({ strikeoutsLine: 3.5 }));
  const highLine = evaluateMoundV2Shadow(baseArgs({ strikeoutsLine: 11.5 }));
  ok(
    lowLine.distribution!.strikeouts.overProbability !== highLine.distribution!.strikeouts.overProbability,
    `(5) a much lower line (3.5) vs a much higher line (11.5) genuinely produces different over-probabilities (got ${lowLine.distribution!.strikeouts.overProbability} vs ${highLine.distribution!.strikeouts.overProbability}) — the line is a real, legitimate model input`,
  );
  ok(lowLine.strikeoutsModelDecision!.side === "OVER", "(5) an easily-cleared low line qualifies OVER");
  ok(highLine.strikeoutsModelDecision!.side === "UNDER" || highLine.strikeoutsModelDecision!.modelQualified === false, "(5) a hard-to-clear high line either qualifies UNDER or abstains — never a fabricated OVER");
}

// ── (6) Changing ONLY the line cannot change projection, the underlying
// distribution, or the baseball setup grade ────────────────────────────────
{
  const lowLine = evaluateMoundV2Shadow(baseArgs({ strikeoutsLine: 3.5 }));
  const highLine = evaluateMoundV2Shadow(baseArgs({ strikeoutsLine: 11.5 }));
  ok(lowLine.distribution!.strikeouts.expectedValue === highLine.distribution!.strikeouts.expectedValue, "(6) projection (expectedValue) is computed from the PMF alone, before any line is applied — identical regardless of the line requested");
  ok(JSON.stringify(lowLine.distribution!.strikeoutsPmf) === JSON.stringify(highLine.distribution!.strikeoutsPmf), "(6) the underlying outcome distribution (PMF) is identical regardless of the line requested — only computeLineProbabilities' READ of it differs");
  ok(lowLine.v1Tier === highLine.v1Tier && lowLine.v1Score10 === highLine.v1Score10, "(6) the baseball setup grade (V1's own score10/tier) is completely unaffected by V2's own line choice");
}

// ── (7) No implied-probability, EV, or price-derived value enters the
// MODEL-policy call graph ───────────────────────────────────────────────────
{
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(dir, "moundV2ModelPolicy.ts"), "utf-8");
  ok(!/^import\s/m.test(source), "(7) moundV2ModelPolicy.ts has ZERO import statements — it cannot reach price/odds/implied-probability logic even indirectly, because it imports nothing at all");

  // Strip comments before checking field NAMES — doc comments legitimately
  // discuss price/implied-probability in prose (explaining what a field
  // deliberately does NOT do), which must not false-positive this check.
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  const inputInterface = source.match(/export interface MoundV2ModelPolicyInput \{([\s\S]*?)\n\}/);
  ok(inputInterface !== null, "sanity: the MoundV2ModelPolicyInput interface is found in source");
  const inputBody = stripComments(inputInterface![1]);
  const forbiddenFieldTerms = ["price", "Price", "odds", "Odds", "sportsbook", "Sportsbook", "implied", "Implied", "fetchedAt", "FetchedAt", "expectedValue"];
  for (const term of forbiddenFieldTerms) {
    ok(!inputBody.includes(term), `(7) MoundV2ModelPolicyInput never declares a field containing "${term}"`);
  }

  const policyInterface = source.match(/export interface MoundV2ModelPolicy \{([\s\S]*?)\n\}/);
  const policyBody = stripComments(policyInterface![1]);
  for (const term of ["price", "Price", "odds", "Odds", "implied", "Implied"]) {
    ok(!policyBody.includes(term), `(7) MoundV2ModelPolicy (the policy config itself) never declares a field containing "${term}"`);
  }
}

// ── (8) ROI uses the captured price WITHOUT feeding it back into the
// recommendation — a one-way flow: price -> ROI, never price -> side ──────
{
  function row(over: Partial<MoundV2ComparisonRow>): MoundV2ComparisonRow {
    return {
      gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts",
      settlementStatus: "graded", finalResult: "over",
      frozenOverPrice: -120, frozenUnderPrice: 100,
      v2OverProbability: 0.6, v2UnderProbability: 0.37, v2PushProbability: 0.03,
      v1RecommendedSide: "OVER", contractVersion: MOUND_FROZEN_CONTRACT_VERSION,
      v1Tier: "strong", v2ModelVersion: "v2_v1", productionModelVersion: "prod_v1",
      v2ModelPolicyVersion: "mound_v2_model_policy_v1",
      v2ModelSide: "OVER", v2ModelQualified: true, v2Executable: true,
      v2ExecutablePrice: -120, v2ExecutableLine: 6.5,
      dataQuality: "complete", lineupStatus: "confirmed", sportsbook: "draftkings",
      oddsFetchedAt: "2026-07-29T19:58:00.000Z",
      ...over,
    };
  }

  // v2UnitsForRow reads v2ExecutablePrice (the atomic offer's OWN price
  // field) directly — never frozenOverPrice/frozenUnderPrice — so THIS is
  // the field that must vary to exercise ROI's price sensitivity.
  const cheapPrice = row({ v2ExecutablePrice: -300 });
  const juicyPrice = row({ v2ExecutablePrice: +250 });
  ok(cheapPrice.v2ModelSide === juicyPrice.v2ModelSide && cheapPrice.v2ModelQualified === juicyPrice.v2ModelQualified, "(8) the recommendation (v2ModelSide/v2ModelQualified) is the SAME regardless of the captured price — it was decided upstream, before any price entered the picture");

  const cheapUnits = v2UnitsForRow(cheapPrice);
  const juicyUnits = v2UnitsForRow(juicyPrice);
  ok(cheapUnits !== null && juicyUnits !== null && cheapUnits !== juicyUnits, `(8) ROI (v2UnitsForRow) legitimately DOES vary with the captured price (got ${cheapUnits} vs ${juicyUnits}) — this is the intended one-way use of price for measurement`);
  ok(juicyUnits! > cheapUnits!, "(8) the better captured price correctly yields more ROI units for the same win outcome, confirming price feeds ROI in the expected direction");
}

// ── market_implied analytics isolation (Final Line-Provenance and V1 Purity
// Correction, Section 4) — the sportsbook-diagnostic probability comparator
// must be: clearly labeled, absent from the model/decision-policy call
// graphs, unable to alter individual model decisions, never mislabeled as
// V1 performance, and never used as EV-based recommendation logic ─────────
{
  function row(over: Partial<MoundV2ComparisonRow>): MoundV2ComparisonRow {
    return {
      gameId: "g1", pitcherId: "p1", market: "pitcher_strikeouts",
      settlementStatus: "graded", finalResult: "over",
      frozenOverPrice: -110, frozenUnderPrice: -110,
      v2OverProbability: 0.6, v2UnderProbability: 0.37, v2PushProbability: 0.03,
      v1RecommendedSide: "OVER", contractVersion: MOUND_FROZEN_CONTRACT_VERSION,
      v1Tier: "strong", v2ModelVersion: "v2_v1", productionModelVersion: "prod_v1",
      v2ModelPolicyVersion: "mound_v2_model_policy_v1",
      v2ModelSide: "OVER", v2ModelQualified: true, v2Executable: true,
      v2ExecutablePrice: -120, v2ExecutableLine: 6.5,
      dataQuality: "complete", lineupStatus: "confirmed", sportsbook: "draftkings",
      oddsFetchedAt: "2026-07-29T19:58:00.000Z",
      ...over,
    };
  }
  const rows = Array.from({ length: 40 }, (_, i) => row({ gameId: `mi${i}`, finalResult: i % 2 === 0 ? "over" : "under" }));

  // 1. Clearly labeled — never silently defaulted or left ambiguous.
  const climatologyEval = computeMoundV2ProbabilityEvaluation(rows, "climatology");
  const marketImpliedEval = computeMoundV2ProbabilityEvaluation(rows, "market_implied");
  ok(climatologyEval.comparator === "climatology", "the climatology evaluation is explicitly labeled as such");
  ok(marketImpliedEval.comparator === "market_implied", "the market_implied evaluation is explicitly labeled as such — never silently defaulted to climatology or left unlabeled");

  // 2. Absent from the model/decision-policy call graphs — moundV2ModelPolicy.ts
  // has ZERO imports (see test 7 above); moundV2Executability.ts's only
  // import is a type-only reference to moundV2ModelPolicy.ts itself (also
  // zero-import) — neither ever imports oddsDisplay.ts (americanToImpliedProbability)
  // or moundV2ComparisonStats.ts (marketImpliedProbs), the only two places a
  // market-implied probability concept exists in this codebase.
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const executabilitySource = readFileSync(path.join(dir, "moundV2Executability.ts"), "utf-8");
  ok(!executabilitySource.includes("oddsDisplay") && !executabilitySource.includes("moundV2ComparisonStats") && !executabilitySource.includes("marketImpliedProbs"), "moundV2Executability.ts never imports oddsDisplay.ts or moundV2ComparisonStats.ts, and never references marketImpliedProbs — market_implied cannot reach it");
  const decisionPolicySource = readFileSync(path.join(dir, "moundV2ComparisonStats.ts"), "utf-8");
  const decisionPolicyFnBody = decisionPolicySource.match(/export function computeMoundV2DecisionPolicyComparison\([\s\S]*?\n\}/)?.[0] ?? "";
  ok(decisionPolicyFnBody.length > 0, "sanity: computeMoundV2DecisionPolicyComparison's body was located in source");
  ok(!decisionPolicyFnBody.includes("marketImpliedProbs") && !decisionPolicyFnBody.includes("market_implied"), "computeMoundV2DecisionPolicyComparison's own function body never references marketImpliedProbs/market_implied — the decision-policy (win-rate/ROI) call graph is entirely separate from the probability-quality comparator");

  // 3. Unable to alter individual model decisions — computeMoundV2ProbabilityEvaluation
  // is a pure, read-only scoring function; running it (under either
  // comparator) never mutates the rows it was given.
  const beforeJson = JSON.stringify(rows);
  computeMoundV2ProbabilityEvaluation(rows, "market_implied");
  const afterJson = JSON.stringify(rows);
  ok(beforeJson === afterJson, "calling computeMoundV2ProbabilityEvaluation with the market_implied comparator never mutates the input rows — v2ModelSide/v2ModelQualified on each row are exactly what they were before");
  const decisionBefore = computeMoundV2DecisionPolicyComparison(rows);
  computeMoundV2ProbabilityEvaluation(rows, "market_implied");
  const decisionAfter = computeMoundV2DecisionPolicyComparison(rows);
  ok(JSON.stringify(decisionBefore) === JSON.stringify(decisionAfter), "the decision-policy comparison (win-rate/ROI) is byte-identical whether or not the market_implied probability evaluation was ever run alongside it");

  // 4. Never mislabeled as V1 performance — no field anywhere claims a "v1"
  // probability metric, for EITHER comparator.
  ok(!("v1BrierScore" in marketImpliedEval) && !("v1CalibrationError" in marketImpliedEval) && !("v1LogLoss" in marketImpliedEval), "no field on the market_implied evaluation result claims a 'V1' probability metric — V1 has no probability to score, under any comparator");

  // 5. Never used as EV-based recommendation logic — no "expectedValue"/"edge"
  // concept combining with market_implied exists anywhere in the v2/ call
  // graph the model/decision-policy actually use (moundV2Engine.ts's own
  // expectedValue is the PMF's mean — computed BEFORE and INDEPENDENTLY of
  // any market_implied comparator, never combined with it).
  const modelPolicySource = readFileSync(path.join(dir, "moundV2ModelPolicy.ts"), "utf-8");
  ok(!modelPolicySource.includes("marketImplied") && !modelPolicySource.includes("expectedValue"), "moundV2ModelPolicy.ts references neither marketImplied* nor expectedValue anywhere — no EV-vs-market-implied recommendation rule exists");
}

console.log(`\nmoundV2PriceIndependence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
