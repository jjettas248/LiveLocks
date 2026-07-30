// Mound V2 shadow — V1 qualification lifecycle & immutability (Final
// Pre-Push Integrity Pass, Section 3). Runs the REAL production chain
// end-to-end against a real database:
//
//   evaluateMoundV2Shadow -> buildMoundV2ShadowPredictionRows ->
//   storage.createMoundV2ShadowPrediction -> storage.gradeMoundV2ShadowPrediction ->
//   gatherMoundV2ComparisonReport (real DB read + the pure comparison engine)
//
// Proves the three properties Section 3 requires, together, honestly (no
// hand-rolled shortcut logic duplicating what production code already
// decides):
//
//   1. A NON-qualified V1 signal (v1QualificationStatus: "not_recommended",
//      v1RecommendedSide: null — exactly what buildMlbMoundRadar.ts passes
//      for a pitcher whose moundDirection lean was never publicly flagged)
//      is never counted as a V1 wager: it must NOT appear in
//      decisionPolicy.v1's recommendationsProduced/wins/losses/units, and
//      must land in the dedicated v1NoRecommendationCount bucket, not
//      legacyIncompleteDataCount (which is reserved for pre-capture
//      contract versions) and not pairedN (paired requires a real V1 side).
//   2. A publicly-QUALIFIED V1 signal (v1QualificationStatus: "recommended",
//      v1RecommendedSide: "OVER") is captured correctly and DOES count:
//      it lands in pairedN, recommendationsProduced, and — since it is
//      graded a winner below — v1.wins.
//   3. Once persisted, grading (a real storage.gradeMoundV2ShadowPrediction
//      call, run twice to also cover re-grading/correction) NEVER rewrites
//      the captured V1 policy decision (v1RecommendedSide,
//      v1QualificationStatus), V2's own MODEL decision
//      (v2ModelPolicyVersion/v2ModelSide/v2ModelQualified/
//      v2ModelQualificationReason), or V2's separate executability verdict
//      (v2ExecutabilityPolicyVersion/v2Executable/v2ExecutablePrice) —
//      re-fetched values after grading are byte-identical to what was
//      captured at evaluation time. A duplicate
//      insert attempt with a deliberately DIFFERENT v1RecommendedSide (a
//      stand-in for a hypothetical future "re-capture" bug) is also proven
//      to be silently dropped (ON CONFLICT DO NOTHING) rather than
//      overwriting the original captured decision.
//
// Requires DATABASE_URL to point at a disposable database (schema already
// present via ensureMoundV2ShadowPersistenceSchema / drizzle-kit push).
//
// Run: DATABASE_URL=postgresql://... npx tsx server/mlb/pregame/mound/v2/moundV2V1QualificationLifecycle.integration.test.ts

import { storage } from "../../../../storage";
import { db, pool } from "../../../../db";
import { moundV2ShadowPredictions } from "@shared/schema";
import { eq } from "drizzle-orm";
import { evaluateMoundV2Shadow, MOUND_V1_MODEL_VERSION, MOUND_V2_MODEL_VERSION, type EvaluateMoundV2ShadowArgs, type MoundV1QualificationStatus } from "./moundV2ShadowEvaluation";
import { buildMoundV2ShadowPredictionRows } from "./moundV2ShadowPersistenceBuilder";
import { gatherMoundV2ComparisonReport } from "./moundV2ComparisonGatherer";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const TEST_PREFIX = "itest_mv2_qual_";
const GAME_ID = `${TEST_PREFIX}game_1`;
const WINDOW = "2026-07-30";

function nineBatterLineup() {
  return Array.from({ length: 9 }, (_, i) => ({
    playerId: `${TEST_PREFIX}batter_${i}`,
    playerName: `Batter ${i}`,
    battingOrderSlot: i + 1,
    handedness: (i % 2 === 0 ? "L" : "R") as "L" | "R",
    kRateVsThrowHand: 0.22,
    kRateSamplePa: 200,
    bvpAtBats: 0,
    bvpStrikeouts: 0,
  }));
}

function evaluateArgsFor(opts: {
  pitcherId: string;
  v1RecommendedSide: "OVER" | "UNDER" | null;
  v1QualificationStatus: MoundV1QualificationStatus;
}): EvaluateMoundV2ShadowArgs {
  return {
    snapshotId: `mound_v2:${TEST_PREFIX}:${opts.pitcherId}:build1`,
    now: new Date(`${WINDOW}T20:00:00.000Z`),
    frozenInputArgs: {
      gameId: GAME_ID,
      gamePk: `${TEST_PREFIX}gamePk_1`,
      pitcherId: opts.pitcherId,
      pitcherName: `Pitcher ${opts.pitcherId}`,
      opponent: "OPP",
      scheduledGameTime: `${WINDOW}T23:05:00.000Z`,
      lineupStatus: "confirmed",
      battingOrder: nineBatterLineup(),
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
      strikeoutsMarket: { line: 6.5, overPrice: -120, underPrice: 100, sportsbook: "draftkings", fetchedAt: `${WINDOW}T19:58:00.000Z` },
      outsMarket: { line: null, overPrice: null, underPrice: null, sportsbook: null, fetchedAt: null },
      dataQuality: "complete",
      productionModelVersion: MOUND_V1_MODEL_VERSION,
      v2ModelVersion: MOUND_V2_MODEL_VERSION,
    },
    productionComponentScores: { pitcherSkillScore: 7.2, workloadScore: 6.5, opponentKProfileScore: 6.8 },
    v1Score10: 6.9,
    v1Tier: "strong",
    v1RecommendedSide: opts.v1RecommendedSide,
    v1QualificationStatus: opts.v1QualificationStatus,
    strikeoutsLine: 6.5,
    outsLine: null,
  };
}

async function cleanup() {
  await db.delete(moundV2ShadowPredictions).where(eq(moundV2ShadowPredictions.gameId, GAME_ID));
}

async function main() {
  await cleanup();

  const qualifiedPitcherId = `${TEST_PREFIX}pitcher_qualified`;
  const notQualifiedPitcherId = `${TEST_PREFIX}pitcher_not_qualified`;

  // ── Evaluate + persist: one genuinely V1-qualified pitcher, one not ──────
  const qualifiedResult = evaluateMoundV2Shadow(evaluateArgsFor({
    pitcherId: qualifiedPitcherId,
    v1RecommendedSide: "OVER",
    v1QualificationStatus: "recommended",
  }));
  const notQualifiedResult = evaluateMoundV2Shadow(evaluateArgsFor({
    pitcherId: notQualifiedPitcherId,
    v1RecommendedSide: null,
    v1QualificationStatus: "not_recommended",
  }));

  ok(qualifiedResult.failureReason === null, "the qualified fixture evaluates without failure (sanity check on the fixture itself)");
  ok(notQualifiedResult.failureReason === null, "the not-qualified fixture evaluates without failure (sanity check on the fixture itself)");

  const qualifiedRows = buildMoundV2ShadowPredictionRows(qualifiedResult);
  const notQualifiedRows = buildMoundV2ShadowPredictionRows(notQualifiedResult);
  ok(qualifiedRows.length === 2 && notQualifiedRows.length === 2, "each evaluation builds exactly one row per market (strikeouts + outs)");

  const qualifiedKRow = qualifiedRows.find((r) => r.market === "pitcher_strikeouts")!;
  const notQualifiedKRow = notQualifiedRows.find((r) => r.market === "pitcher_strikeouts")!;

  // ── Property 2: a publicly-qualified recommendation is captured correctly ─
  ok(qualifiedKRow.v1RecommendedSide === "OVER", "the qualified pitcher's row captures v1RecommendedSide exactly as passed in (OVER)");
  ok(qualifiedKRow.v1QualificationStatus === "recommended", "the qualified pitcher's row captures v1QualificationStatus exactly as passed in (recommended)");

  // ── Property 1 (capture side): a non-qualified moundDirection captures a
  // null side, never a fabricated one ──────────────────────────────────────
  ok(notQualifiedKRow.v1RecommendedSide === null, "the not-qualified pitcher's row captures v1RecommendedSide as null — never backfilled from a raw model lean");
  ok(notQualifiedKRow.v1QualificationStatus === "not_recommended", "the not-qualified pitcher's row captures v1QualificationStatus as not_recommended");

  const insertedQualified = await storage.createMoundV2ShadowPrediction(qualifiedKRow);
  const insertedNotQualified = await storage.createMoundV2ShadowPrediction(notQualifiedKRow);
  ok(insertedQualified !== null && insertedNotQualified !== null, "both rows persist to the real database");

  // Capture the V2 decision-policy verdict actually persisted, to diff
  // against after grading below (whatever the real engine decided —
  // irrelevant WHAT it is, only that grading cannot change it).
  const beforeGrading = await storage.getMoundV2ShadowPrediction(qualifiedKRow.predictionId);
  ok(beforeGrading !== null, "the qualified row round-trips through the real database before grading");

  // ── Grade both as "over" (a real win for the qualified OVER side) ────────
  await storage.gradeMoundV2ShadowPrediction(qualifiedKRow.predictionId, {
    settlementStatus: "graded", finalResult: "over", finalStatValue: 8, gradedAt: new Date(`${WINDOW}T23:30:00.000Z`),
  });
  await storage.gradeMoundV2ShadowPrediction(notQualifiedKRow.predictionId, {
    settlementStatus: "graded", finalResult: "over", finalStatValue: 8, gradedAt: new Date(`${WINDOW}T23:30:00.000Z`),
  });

  // ── Property 1 (measurement side): confirmed via the REAL comparison
  // pipeline, not a hand-rolled reimplementation of its filtering logic ────
  const report = await gatherMoundV2ComparisonReport({ windowStart: WINDOW, windowEnd: WINDOW });
  ok(report.decisionPolicy.pairedN === 1, `exactly the qualified row is paired-eligible (got pairedN=${report.decisionPolicy.pairedN})`);
  ok(report.decisionPolicy.v1NoRecommendationCount === 1, `exactly the not-qualified row lands in the dedicated v1NoRecommendationCount bucket (got ${report.decisionPolicy.v1NoRecommendationCount})`);
  ok(report.decisionPolicy.legacyIncompleteDataCount === 0, "neither row is misclassified as legacy/pre-capture data — both have a current contractVersion");
  ok(report.decisionPolicy.v1.recommendationsProduced === 1, `V1's own metrics count exactly ONE recommendation produced across both rows (got ${report.decisionPolicy.v1.recommendationsProduced}) — the not-qualified pitcher is never counted as a wager`);
  ok(report.decisionPolicy.v1.wins === 1, "the one counted V1 recommendation (OVER) is graded a win against the real 'over' finalResult");
  // v1.eligibleSnapshots/coverage are computed on the already-`paired` subset
  // (computeMoundV2DecisionPolicyComparison calls buildV1Metrics(paired), not
  // buildV1Metrics(gradedWithLine)) — pre-existing Correction 1 behavior, not
  // touched by this pass. The exclusion of the not-qualified pitcher is
  // proven above via pairedN/v1NoRecommendationCount/recommendationsProduced,
  // which are the fields that actually carry that distinction.
  ok(report.decisionPolicy.v1.eligibleSnapshots === 1, "v1.eligibleSnapshots equals the paired count in this top-level path (a pre-existing metric-naming quirk, not a masking of the not-qualified row — which is separately and correctly bucketed via v1NoRecommendationCount above)");

  // ── Property 3: grading (and a second re-grade) never rewrites the
  // captured V1/V2 policy decision ─────────────────────────────────────────
  const afterFirstGrade = await storage.getMoundV2ShadowPrediction(qualifiedKRow.predictionId);
  ok(afterFirstGrade?.v1RecommendedSide === beforeGrading?.v1RecommendedSide, "v1RecommendedSide is byte-identical after grading");
  ok(afterFirstGrade?.v1QualificationStatus === beforeGrading?.v1QualificationStatus, "v1QualificationStatus is byte-identical after grading");
  ok(afterFirstGrade?.v2ModelPolicyVersion === beforeGrading?.v2ModelPolicyVersion, "v2ModelPolicyVersion is byte-identical after grading");
  ok(afterFirstGrade?.v2ModelSide === beforeGrading?.v2ModelSide, "v2ModelSide is byte-identical after grading");
  ok(afterFirstGrade?.v2ModelQualified === beforeGrading?.v2ModelQualified, "v2ModelQualified is byte-identical after grading");
  ok(afterFirstGrade?.v2ModelQualificationReason === beforeGrading?.v2ModelQualificationReason, "v2ModelQualificationReason is byte-identical after grading");
  ok(afterFirstGrade?.v2ExecutabilityPolicyVersion === beforeGrading?.v2ExecutabilityPolicyVersion, "v2ExecutabilityPolicyVersion is byte-identical after grading");
  ok(afterFirstGrade?.v2Executable === beforeGrading?.v2Executable, "v2Executable is byte-identical after grading");
  ok(afterFirstGrade?.v2ExecutablePrice === beforeGrading?.v2ExecutablePrice, "v2ExecutablePrice is byte-identical after grading");

  // A second grading write (a correction) must ALSO leave these untouched.
  await storage.gradeMoundV2ShadowPrediction(qualifiedKRow.predictionId, {
    settlementStatus: "graded", finalResult: "over", finalStatValue: 9, gradedAt: new Date(`${WINDOW}T23:45:00.000Z`),
  });
  const afterSecondGrade = await storage.getMoundV2ShadowPrediction(qualifiedKRow.predictionId);
  ok(afterSecondGrade?.finalStatValue === "9", "the second grading write does update the grading columns (sanity check the regrade really happened)");
  ok(afterSecondGrade?.v1RecommendedSide === beforeGrading?.v1RecommendedSide, "v1RecommendedSide survives a SECOND grading write (a correction) unchanged");
  ok(afterSecondGrade?.v1QualificationStatus === beforeGrading?.v1QualificationStatus, "v1QualificationStatus survives a second grading write unchanged");
  ok(afterSecondGrade?.v2ModelSide === beforeGrading?.v2ModelSide, "v2ModelSide survives a second grading write unchanged");
  ok(afterSecondGrade?.v2ModelQualified === beforeGrading?.v2ModelQualified, "v2ModelQualified survives a second grading write unchanged");
  ok(afterSecondGrade?.v2Executable === beforeGrading?.v2Executable, "v2Executable survives a second grading write unchanged");

  // ── A duplicate insert attempt with a DIFFERENT v1RecommendedSide must be
  // silently dropped — the ORIGINAL captured decision can never be
  // overwritten even by a well-intentioned future "re-capture" bug ────────
  const tamperedDuplicate = { ...qualifiedKRow, v1RecommendedSide: "UNDER" as const, v1QualificationStatus: "not_recommended" as const };
  const duplicateResult = await storage.createMoundV2ShadowPrediction(tamperedDuplicate);
  ok(duplicateResult === null, "a duplicate insert (same predictionId) with a DIFFERENT v1RecommendedSide/v1QualificationStatus is rejected (ON CONFLICT DO NOTHING), not merged or overwritten");
  const afterTamperAttempt = await storage.getMoundV2ShadowPrediction(qualifiedKRow.predictionId);
  ok(afterTamperAttempt?.v1RecommendedSide === "OVER", "the real persisted row still shows the ORIGINAL v1RecommendedSide (OVER) after the tampering attempt — never overwritten to UNDER");
  ok(afterTamperAttempt?.v1QualificationStatus === "recommended", "the real persisted row still shows the ORIGINAL v1QualificationStatus (recommended) after the tampering attempt");

  await cleanup();
  await pool.end();
  console.log(`\nmoundV2V1QualificationLifecycle.integration.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); await pool.end(); } catch {}
  process.exit(1);
});
