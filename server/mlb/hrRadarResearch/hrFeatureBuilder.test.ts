// HR Radar research pure feature builder — determinism, canonical hash,
// missing-data preservation, ablation-only isolation, leakage guards, and
// the one-BBE-one-event invariant.
//
// Run: npx tsx server/mlb/hrRadarResearch/hrFeatureBuilder.test.ts

import { buildHrFeatureSnapshot, type HrFeatureBuilderInput, type HrFeatureBuilderBbe } from "./hrFeatureBuilder";
import { computeHrFeatureHash, canonicalJsonStringify } from "./hrFeatureHash";
import { hrDerivedFeatureVectorV1Schema } from "./hrFeatureContract";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const BBE_SEQUENCE: HrFeatureBuilderBbe[] = [
  { exitVelocity: 92, launchAngle: 15, distance: 320, outcome: "out", hitType: null, hrProbability: 0.05, inning: 1, half: "top" },
  { exitVelocity: 101, launchAngle: 28, distance: 380, outcome: "hit", hitType: "double", hrProbability: 0.22, inning: 3, half: "top" },
  { exitVelocity: 97, launchAngle: 20, distance: 350, outcome: "out", hitType: null, hrProbability: 0.14, inning: 5, half: "bottom" },
];

function fullInput(overrides: Partial<HrFeatureBuilderInput> = {}): HrFeatureBuilderInput {
  return {
    statsAsOfMs: 1_700_000_000_000,

    batterHand: "R",
    seasonHRRate: 0.045,
    careerHRRate: 0.04,
    barrelRateSeasonal: 0.11,
    hardHitRateSeasonal: 0.42,
    flyBallPercent: 0.35,
    hrFBRatio: 0.18,
    xSlg: 0.51,
    xIso: 0.21,
    sweetSpotPercent: 0.36,
    pullRatePercent: 0.4,
    batterPriorMeta: { fetchedAtMs: 1_699_999_000_000 },

    liveBbeSequence: BBE_SEQUENCE,
    gameBarrelCount: 1,
    gameAvgXBaToday: 0.31,
    seasonXBaForDelta: 0.27,
    parkHrFactorForDistance: 1.05,
    liveFormMeta: { fetchedAtMs: 1_700_000_000_000 },

    pitcherHrRateAllowedSeasonal: 0.033,
    pitcherFatigueScore: 1.2,
    pitchCountToday: 78,
    timesThroughOrder: 3,
    battersFacedToday: 22,
    velocityTrendSlope: -0.4,
    velocityDropFromSeason: 1.1,
    pitchMixShiftScore: 0.08,
    pitcherHand: "L",
    pitcherEraSeasonal: 4.1,
    pitcherRemovalProbability: 0.3,
    pitcherStateMeta: { fetchedAtMs: 1_700_000_000_000 },

    handednessSplitFactor: 1.08,
    platoonAdvantage: true,
    shrunkBatterVsHandHrRate: 0.05,
    shrunkPitcherVsHandHrRateAllowed: 0.035,
    pitchFamilyPowerFitScore: 0.48,
    arsenalProfileFitScore: 0.44,
    matchupMeta: { fetchedAtMs: 1_700_000_000_000 },

    battingOrderSlot: 3,
    lineupDistanceToNextPa: 2,
    remainingPaEstimate: 2,
    remainingPaP25: 1,
    remainingPaP50: 2,
    remainingPaP75: 3,
    inning: 5,
    scoreDifferential: -1,
    substitutionRiskScore: 0.1,
    pitcherSurvivalUncertaintyScore: 0.2,
    opportunityMeta: { fetchedAtMs: 1_700_000_000_000 },

    windOutFactor: 1.02,
    temperatureF: 78,
    parkHrFactor: 1.05,
    handednessParkHrFactor: 1.1,
    wallDistanceFitScore: 0.9,
    windVectorDegrees: 200,
    windSpeedMph: 8,
    humidityPercent: 55,
    pressureHpa: 1012,
    roofState: "na",
    environmentMeta: { fetchedAtMs: 1_700_000_000_000 },

    rawBvpHrRate: 0.1,
    rawBvpPlateAppearances: 12,
    atBatsSinceLastHr: 9,
    seasonIbbRate: 0.02,
    genericHotLabel: "hot",
    leverageIndex: 1.4,

    identityConfidence: "confirmed",
    feedDegradationFlags: [],
    ...overrides,
  };
}

// ── Determinism ──────────────────────────────────────────────────────────────
{
  const a = buildHrFeatureSnapshot(fullInput());
  const b = buildHrFeatureSnapshot(fullInput());
  ok(computeHrFeatureHash(a.derivedFeatures) === computeHrFeatureHash(b.derivedFeatures), "identical input twice produces an identical feature hash");
  ok(JSON.stringify(a.derivedFeatures) === JSON.stringify(b.derivedFeatures), "identical input twice produces an identical derived-feature vector");
}

// ── Canonical hash — key-order independence ─────────────────────────────────
{
  const objA = { z: 1, a: { y: 2, b: 1 }, arr: [3, 1, 2] };
  const objB = { arr: [3, 1, 2], a: { b: 1, y: 2 }, z: 1 };
  ok(canonicalJsonStringify(objA) === canonicalJsonStringify(objB), "canonicalJsonStringify is independent of object key insertion order");
  const objC = { arr: [1, 2, 3] }; // different ARRAY order is meaningful and must NOT collapse
  const objD = { arr: [3, 2, 1] };
  ok(canonicalJsonStringify(objC) !== canonicalJsonStringify(objD), "canonicalJsonStringify preserves array element order (order is meaningful, e.g. the BBE sequence)");
}
{
  const result = buildHrFeatureSnapshot(fullInput());
  ok(hrDerivedFeatureVectorV1Schema.safeParse(result.derivedFeatures).success, "a fully-populated builder result validates against the frozen hr_features_v1 contract");
}

// ── Missing-data preservation — explicit null, never a dropped key ─────────
{
  const result = buildHrFeatureSnapshot(fullInput({ seasonHRRate: null, barrelRateSeasonal: null }));
  ok("hrRatePriorSeasonal" in result.derivedFeatures.batterPrior, "a missing input is still present as an explicit key");
  ok(result.derivedFeatures.batterPrior.hrRatePriorSeasonal === null, "a missing input serializes as explicit null, not a dropped key");
  ok(result.derivedFeatures.dataQuality.missingInputs.includes("batterPrior.hrRatePriorSeasonal"), "a null leaf is recorded in missingInputs");
  ok(result.derivedFeatures.dataQuality.missingInputs.includes("batterPrior.barrelRatePriorSeasonal"), "a second null leaf is also recorded in missingInputs");
  ok(result.derivedFeatures.dataQuality.overallQuality !== "full", "overallQuality reflects missing inputs (not full)");
}
{
  // Two liveForm/pitcherState leaves (sprayPullFactorToday,
  // dangerousAerialContactAllowedToday) have no upstream source yet and are
  // always null regardless of input — everything else supplied should be
  // present.
  const result = buildHrFeatureSnapshot(fullInput());
  const missing = new Set(result.derivedFeatures.dataQuality.missingInputs);
  ok(missing.size === 2 && missing.has("liveForm.sprayPullFactorToday") && missing.has("pitcherState.dangerousAerialContactAllowedToday"),
    `a fully-populated input's only missingInputs are the two known not-yet-sourced leaves (got: ${Array.from(missing).join(", ")})`);
  ok(result.derivedFeatures.dataQuality.overallQuality === "degraded", "a mostly-complete input with 2 known-missing leaves reports overallQuality=degraded, not full");
}
{
  const noMetaResult = buildHrFeatureSnapshot(fullInput({ environmentMeta: undefined }));
  ok(noMetaResult.featureFreshness.environment.quality === "missing", "a missing freshness meta reports quality=missing, not fabricated freshness");
  const staleResult = buildHrFeatureSnapshot(fullInput({ environmentMeta: { fetchedAtMs: 1_700_000_000_000 - 20 * 60 * 1000 } }));
  ok(staleResult.featureFreshness.environment.quality === "degraded", "data older than the staleness threshold reports quality=degraded");
}

// ── Ablation-only isolation ──────────────────────────────────────────────────
{
  const result = buildHrFeatureSnapshot(fullInput());
  ok(result.derivedFeatures.ablationInputs.xBaSeasonal === 0.27, "xBA lives in ablationInputs, not any scored block");
  ok(result.derivedFeatures.ablationInputs.pitcherEraSeasonal === 4.1, "ERA lives in ablationInputs, not any scored block");
  ok(result.derivedFeatures.ablationInputs.rawBvpHrRate === 0.1, "raw BvP lives in ablationInputs, not any scored block");
  ok(result.derivedFeatures.ablationInputs.atBatsSinceLastHr === 9, "ABs-since-last-HR lives in ablationInputs, not any scored block");
  ok(result.derivedFeatures.ablationInputs.seasonIbbRate === 0.02, "IBB context lives in ablationInputs, not any scored block");
  ok(result.derivedFeatures.ablationInputs.genericHotLabel === "hot", "generic hot label lives in ablationInputs, not any scored block");
  ok(result.derivedFeatures.ablationInputs.leverageIndex === 1.4, "leverage lives in ablationInputs, not any scored block");

  const scoredBlocksJson = JSON.stringify({
    batterPrior: result.derivedFeatures.batterPrior,
    liveForm: result.derivedFeatures.liveForm,
    pitcherState: result.derivedFeatures.pitcherState,
    matchup: result.derivedFeatures.matchup,
    opportunity: result.derivedFeatures.opportunity,
    environment: result.derivedFeatures.environment,
  });
  ok(!scoredBlocksJson.includes("0.1") || !scoredBlocksJson.match(/\brawBvp/), "no ablation-only field name leaks into a scored block's own keys");
  ok(!("xBaSeasonal" in result.derivedFeatures.batterPrior), "xBaSeasonal is not a batterPrior key");
  ok(!("pitcherEraSeasonal" in result.derivedFeatures.pitcherState), "pitcherEraSeasonal is not a pitcherState key");
}

// ── No odds/EV/future-outcome leakage ────────────────────────────────────────
{
  const result = buildHrFeatureSnapshot(fullInput());
  const leakageTokens = ["odds", "impliedProbability", "expectedValue", "americanOdds", "lineMovement", "bookLine", "payout"];
  const fullJson = JSON.stringify(result.derivedFeatures).toLowerCase();
  for (const token of leakageTokens) {
    ok(!fullJson.includes(token.toLowerCase()), `derived feature vector contains no "${token}" key or value token`);
  }
}

// ── One BBE = one independent contact event, even with a multi-measurement
// play (the caller collapses multi-measurement plays to one array entry
// before calling this function — see dataPullService.ts syncContactData —
// this test verifies the builder itself counts strictly per-array-entry). ──
{
  const singleEntryButRichBbe: HrFeatureBuilderBbe = {
    exitVelocity: 103, launchAngle: 22, distance: 400, outcome: "out", hitType: null, hrProbability: 0.3, inning: 4, half: "top",
  };
  const result = buildHrFeatureSnapshot(fullInput({ liveBbeSequence: [singleEntryButRichBbe] }));
  ok(result.derivedFeatures.liveForm.dangerousContactCountToday === 1, "a single rich BBE array entry counts as exactly one dangerous-contact increment, never more than one per entry");
  ok(result.rawInputs.families.liveContactBBE.length === 1, "the preserved raw BBE family has exactly one entry per array entry supplied");
}
{
  // The batter's own HR BBEs must already be filtered out by the caller
  // before this function runs — this test verifies the builder does not
  // itself need special-case HR filtering (the sequence it receives here
  // deliberately contains no home_run hitType entries) and that a
  // hypothetical unfiltered HR entry, if it somehow slipped through, would
  // still just be treated as one ordinary BBE rather than double-counted.
  const withStrayHr: HrFeatureBuilderBbe = { exitVelocity: 108, launchAngle: 30, distance: 420, outcome: "hit", hitType: "home_run", hrProbability: 0.9 };
  const resultA = buildHrFeatureSnapshot(fullInput({ liveBbeSequence: [...BBE_SEQUENCE] }));
  const resultB = buildHrFeatureSnapshot(fullInput({ liveBbeSequence: [...BBE_SEQUENCE, withStrayHr] }));
  ok(resultB.rawInputs.families.liveContactBBE.length === resultA.rawInputs.families.liveContactBBE.length + 1, "the builder counts exactly what it's given — HR-filtering is the caller's contract, not re-applied here");
}

console.log(`hrFeatureBuilder.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
