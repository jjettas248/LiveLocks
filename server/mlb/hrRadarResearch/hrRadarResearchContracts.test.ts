// HR Radar research Zod contracts + fail-closed flag parsing — invariants.
//
// Run: npx tsx server/mlb/hrRadarResearch/hrRadarResearchContracts.test.ts

import {
  parseHrResearchBooleanFlag,
  parseHrResearchGamePercent,
  parseHrResearchModelVersion,
  hrRadarResearchFlagsSnapshot,
} from "./hrRadarResearchFlags";
import {
  HR_FEATURES_V1,
  hrDerivedFeatureVectorV1Schema,
  hrFeatureAvailabilityVectorV1Schema,
  hrRawInputEnvelopeSchema,
} from "./hrFeatureContract";
import {
  HR_RADAR_PREDICTION_SCOPE,
  hrPredictionScopeSchema,
  HR_RADAR_EXCLUSION_REASONS,
  hrExclusionReasonSchema,
} from "./hrEligibilityContract";
import { hrTriggerTypeSchema, hrEvaluationEpochContractSchema } from "./hrTriggerContract";
import { hrEvaluationLabelContractSchema, hrLabelDispositionSchema } from "./hrLabelContract";
import { hrModelArtifactSchema } from "./hrModelArtifactContract";
import { hrStagePolicySchema, hrShadowDecisionRecordSchema, type HrStageGate } from "./hrStagePolicyContract";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── (a) Fail-closed flag parsing ────────────────────────────────────────────
// Must run before any other section touches process.env, so the "defaults
// with nothing set" check below is meaningful. This process sets no HR_RADAR_*
// env vars anywhere, so hrRadarResearchFlagsSnapshot() reflects true defaults.
{
  // Boolean parser: only exact "true" | "1" | "on" | "yes" (case-insensitive,
  // trimmed) enable; everything else — including garbage — fails closed.
  const trueLike = ["true", "TRUE", " true ", "True", "1", "on", "ON", "yes", "Yes", " yes "];
  for (const raw of trueLike) {
    ok(parseHrResearchBooleanFlag(raw) === true, `boolean flag parses "${raw}" as true`);
  }
  const falseLike = ["false", "0", "off", "no", "banana", "", "  ", "TRUE ish", "2", "yes please", undefined];
  for (const raw of falseLike) {
    ok(parseHrResearchBooleanFlag(raw) === false, `boolean flag fails closed to false for "${raw}"`);
  }

  // Percent parser: valid 0-100 passes through; anything invalid or
  // out-of-range fails closed to 0 (never clamped into range).
  ok(parseHrResearchGamePercent("0") === 0, "percent flag parses \"0\" as 0");
  ok(parseHrResearchGamePercent("50") === 50, "percent flag parses \"50\" as 50");
  ok(parseHrResearchGamePercent("100") === 100, "percent flag parses \"100\" as 100");
  ok(parseHrResearchGamePercent("100.5") === 0, "percent flag fails closed to 0 for out-of-range \"100.5\" (not clamped to 100)");
  const invalidPercents = ["banana", "-5", "150", "NaN", "Infinity", "-Infinity", "", undefined, "1e999"];
  for (const raw of invalidPercents) {
    const result = parseHrResearchGamePercent(raw);
    ok(result === 0, `percent flag fails closed to 0 (not clamped) for "${raw}" — got ${result}`);
  }

  // Model version parser: trims; empty stays empty; never fabricates a default.
  ok(parseHrResearchModelVersion(" v3 ") === "v3", "model version flag trims whitespace");
  ok(parseHrResearchModelVersion("") === "", "model version flag stays empty for empty input");
  ok(parseHrResearchModelVersion(undefined) === "", "model version flag stays empty for missing input");

  // Module-level consts must default inert with nothing set in process.env
  // for this process.
  const snapshot = hrRadarResearchFlagsSnapshot();
  ok(snapshot.HR_RADAR_EVAL_CAPTURE_ENABLED === false, "HR_RADAR_EVAL_CAPTURE_ENABLED defaults false");
  ok(snapshot.HR_RADAR_SHADOW_MODEL_ENABLED === false, "HR_RADAR_SHADOW_MODEL_ENABLED defaults false");
  ok(snapshot.HR_RADAR_SHADOW_ADMIN_ENABLED === false, "HR_RADAR_SHADOW_ADMIN_ENABLED defaults false");
  ok(snapshot.HR_RADAR_CHALLENGER_POLICY_ENABLED === false, "HR_RADAR_CHALLENGER_POLICY_ENABLED defaults false");
  ok(snapshot.HR_RADAR_CHALLENGER_GAME_PERCENT === 0, "HR_RADAR_CHALLENGER_GAME_PERCENT defaults 0");
  ok(snapshot.HR_RADAR_MODEL_VERSION === "", "HR_RADAR_MODEL_VERSION defaults empty string");
  ok(snapshot.HR_RADAR_EVAL_CAPTURE_GAME_PERCENT === 0, "HR_RADAR_EVAL_CAPTURE_GAME_PERCENT defaults 0");

  // HR_RADAR_EVAL_CAPTURE_GAME_PERCENT (PR 2) — separate flag/parse call from
  // HR_RADAR_CHALLENGER_GAME_PERCENT; same fail-closed percent parser.
  ok(parseHrResearchGamePercent("10") === 10, "eval-capture percent flag parses \"10\" as 10");
  for (const raw of invalidPercents) {
    ok(parseHrResearchGamePercent(raw) === 0, `eval-capture percent flag fails closed to 0 for "${raw}"`);
  }
}

// ── (b) Derived feature vector — additiveness rule ──────────────────────────
{
  const allNullFixture = {
    featureVersion: HR_FEATURES_V1,
    batterPrior: {
      hrRatePriorSeasonal: null, hrRateCareer: null, barrelRatePriorSeasonal: null, hardHitRatePriorSeasonal: null, pullRatePrior: null,
      hardHitAirBallRatePriorSeasonal: null, flyBallRatePrior: null, hrPerFlyBallRatePrior: null, xSlgPrior: null, xIsoPrior: null, sweetSpotRatePrior: null,
      extra: {},
    },
    liveForm: {
      exitVeloTodayAvg: null, barrelsToday: null, hardHitRateToday: null, recentFormStreakScore: null,
      maxExitVeloToday: null, evLaInteractionScore: null, estimatedHrQualityToday: null, maxEstimatedHrQualityToday: null,
      avgBattedBallDistanceToday: null, parkAdjustedContactQualityToday: null, sprayPullFactorToday: null,
      recencyWeightedContactScore: null, dangerousContactCountToday: null, contactQualityDeltaVsPrior: null, contactTrendSlope: null,
      extra: {},
    },
    pitcherState: {
      pitcherHrRateAllowedSeasonal: null, pitcherFatigueScore: null, pitchCountToday: null, timesThroughOrder: null,
      battersFacedToday: null, velocityTrendSlope: null, velocityDropFromSeason: null, pitchMixShiftScore: null,
      dangerousAerialContactAllowedToday: null, pitcherRemovalProbability: null,
      extra: {},
    },
    matchup: {
      handednessSplitFactor: null, platoonAdvantage: null,
      shrunkBatterVsHandHrRate: null, shrunkPitcherVsHandHrRateAllowed: null, pitchFamilyPowerFitScore: null, arsenalProfileFitScore: null,
      extra: {},
    },
    opportunity: {
      battingOrderSlot: null, remainingPaEstimate: null, inning: null,
      lineupDistanceToNextPa: null, remainingPaP25: null, remainingPaP50: null, remainingPaP75: null,
      scoreDifferential: null, substitutionRiskScore: null, pitcherSurvivalUncertaintyScore: null,
      extra: {},
    },
    environment: {
      windOutFactor: null, temperatureF: null, parkHrFactor: null, roofState: null,
      handednessParkHrFactor: null, wallDistanceFitScore: null, windVectorDegrees: null, windSpeedMph: null, humidityPercent: null, pressureHpa: null,
      extra: {},
    },
    dataQuality: {
      missingInputs: ["batterPrior.hrRatePriorSeasonal"], overallQuality: "missing" as const,
      feedDegradationFlags: [], identityConfidence: null,
    },
    ablationInputs: {
      xBaSeasonal: null, pitcherEraSeasonal: null, rawBvpHrRate: null, rawBvpPlateAppearances: null,
      atBatsSinceLastHr: null, seasonIbbRate: null, genericHotLabel: null, leverageIndex: null,
      extra: {},
    },
  };
  ok(hrDerivedFeatureVectorV1Schema.safeParse(allNullFixture).success, "derived feature vector accepts an all-null-leaf fixture (null-but-present is allowed)");

  const missingBlockFixture: any = { ...allNullFixture };
  delete missingBlockFixture.matchup;
  ok(!hrDerivedFeatureVectorV1Schema.safeParse(missingBlockFixture).success, "derived feature vector rejects a fixture missing a required block key (omission is not allowed)");

  const fullyPopulatedFixture = {
    ...allNullFixture,
    batterPrior: { ...allNullFixture.batterPrior, hrRatePriorSeasonal: 0.045, barrelRatePriorSeasonal: 0.09 },
    liveForm: { ...allNullFixture.liveForm, exitVeloTodayAvg: 94.2, barrelsToday: 1 },
    dataQuality: { missingInputs: [], overallQuality: "full" as const, feedDegradationFlags: [], identityConfidence: "confirmed" as const },
  };
  ok(hrDerivedFeatureVectorV1Schema.safeParse(fullyPopulatedFixture).success, "derived feature vector accepts a fully-populated fixture");
}

// ── (c) Availability + raw input envelope ───────────────────────────────────
{
  const availabilityFixture = {
    featureVersion: HR_FEATURES_V1,
    batterPrior: { hrRatePriorSeasonal: { present: true, quality: "full" } },
    liveForm: { exitVeloTodayAvg: { present: false, quality: "missing" } },
    pitcherState: {},
    matchup: {},
    opportunity: {},
    environment: {},
  };
  ok(hrFeatureAvailabilityVectorV1Schema.safeParse(availabilityFixture).success, "availability vector accepts a valid per-leaf fixture");

  const rawInputFixture = {
    inputContractVersion: "hr_raw_inputs_v1",
    capturedAt: "2026-07-21T18:00:00.000Z",
    families: { statcast: { exitVelo: 98.1, launchAngle: 27 }, weather: { windMph: 8, windDir: "out" }, arbitraryUpstreamShape: [1, 2, { nested: true }] },
  };
  ok(hrRawInputEnvelopeSchema.safeParse(rawInputFixture).success, "raw input envelope accepts an arbitrary families payload");
  ok(!hrRawInputEnvelopeSchema.safeParse({ capturedAt: "x", families: {} }).success, "raw input envelope rejects a missing inputContractVersion");
}

// ── (d) Trigger enum + epoch contract ───────────────────────────────────────
{
  const validTriggers = [
    "live_state_entry_with_lineup", "pa_complete", "pitching_change", "lineup_substitution",
    "lineup_removal", "inning_half_transition", "weather_roof_change", "pitcher_state_change",
  ];
  ok(validTriggers.length === 8, "test fixture lists exactly 8 trigger types");
  for (const t of validTriggers) {
    ok(hrTriggerTypeSchema.safeParse(t).success, `trigger type schema accepts "${t}"`);
  }
  ok(!hrTriggerTypeSchema.safeParse("something_made_up").success, "trigger type schema rejects an arbitrary string");

  const epochFixture = {
    evaluationEpochId: "epoch-abc123",
    sourceRevision: 0,
    triggerType: "pa_complete",
    sourceEventAt: "2026-07-21T18:05:00.000Z",
    sourceEventId: "play-42",
    gameId: "game-1",
    playSequence: 42,
  };
  ok(hrEvaluationEpochContractSchema.safeParse(epochFixture).success, "epoch contract accepts a valid fixture with evaluationEpochId + sourceRevision");
  ok(!hrEvaluationEpochContractSchema.safeParse({ ...epochFixture, evaluationEpochId: undefined }).success, "epoch contract rejects a missing evaluationEpochId");
}

// ── (e) Eligibility contract ─────────────────────────────────────────────────
{
  ok(hrPredictionScopeSchema.safeParse(HR_RADAR_PREDICTION_SCOPE).success, "prediction scope literal accepts \"first_hr_of_game\"");
  ok(!hrPredictionScopeSchema.safeParse("any_hr_of_game").success, "prediction scope literal rejects any other string");
  for (const reason of HR_RADAR_EXCLUSION_REASONS) {
    ok(hrExclusionReasonSchema.safeParse(reason).success, `exclusion reason schema accepts "${reason}"`);
  }
  ok(hrExclusionReasonSchema.safeParse("already_homered_this_game").success, "exclusion reason schema accepts the already-homered scope-qualified reason");
  ok(!hrExclusionReasonSchema.safeParse("unranked_reason").success, "exclusion reason schema rejects an arbitrary string");
}

// ── (f) Label contract — disposition + censoring ────────────────────────────
{
  const resolvedFixture = {
    labelVersion: "v1", snapshotId: "snap-1", labelDisposition: "resolved" as const,
    resolvedAt: "2026-07-21T22:00:00.000Z", resolutionReason: "game_final" as const,
    hrRemainderGame: false, hrNextPa: false, nextPaOccurred: true,
    hrNextTwoPa: false, secondPaOccurred: true, remainingPaObserved: 3,
    nextPaId: "pa-2", secondPaId: "pa-3", hrEventId: null, hrPlaySequence: null,
    hrAt: null, hrInning: null, hrPaOrdinal: null, labelSource: "engine" as const, dataQuality: null,
  };
  ok(hrEvaluationLabelContractSchema.safeParse(resolvedFixture).success, "label contract accepts a fully-resolved fixture");

  const censoredFixture = {
    ...resolvedFixture,
    labelDisposition: "resolved" as const,
    resolutionReason: "substitution" as const,
    hrRemainderGame: false,
    hrNextPa: null,
    nextPaOccurred: false,
    hrNextTwoPa: null,
    secondPaOccurred: false,
    remainingPaObserved: 0,
    nextPaId: null,
    secondPaId: null,
  };
  ok(
    hrEvaluationLabelContractSchema.safeParse(censoredFixture).success,
    "label contract accepts a censored-but-valid fixture (nextPaOccurred=false, hrNextPa=null, hrRemainderGame still a resolved false)",
  );

  const unresolvedFixture = {
    ...resolvedFixture,
    labelDisposition: "manual_review" as const,
    resolvedAt: null,
    resolutionReason: "suspended_manual_review" as const,
    hrRemainderGame: null,
    hrNextPa: null,
    nextPaOccurred: null,
    hrNextTwoPa: null,
    secondPaOccurred: null,
    remainingPaObserved: null,
    nextPaId: null,
    secondPaId: null,
  };
  ok(hrEvaluationLabelContractSchema.safeParse(unresolvedFixture).success, "label contract accepts an unresolved-but-valid (manual_review) fixture");

  ok(!hrLabelDispositionSchema.safeParse("negative").success, "label disposition schema rejects an invalid disposition value");
  ok(!hrEvaluationLabelContractSchema.safeParse({ ...resolvedFixture, labelDisposition: "negative" }).success, "label contract rejects a bad disposition value");
}

// ── (g) Model artifact contract ─────────────────────────────────────────────
{
  const validArtifact = {
    modelVersion: "hr-challenger-v1-2026-07-21",
    modelType: "elastic_net_logistic",
    featureVersion: HR_FEATURES_V1,
    featureOrder: ["batterPrior.hrRatePriorSeasonal", "liveForm.exitVeloTodayAvg"],
    missingValueBehavior: "neutral_marker" as const,
    baseline: { kind: "logistic" as const, coefficients: { intercept: -3.1, hrRatePriorSeasonal: 12.4 }, knots: null, treeNodes: null },
    live: { kind: "logistic" as const, coefficients: { intercept: -3.0, exitVeloTodayAvg: 0.08 }, knots: null, treeNodes: null },
    calibration: { method: "platt" as const, params: { a: 1.02, b: -0.01 } },
    policy: { policyVersion: "policy-v1", thresholds: { watch: 0.02, build: 0.04, ready: 0.07, fire: 0.12 } },
    training: {
      trainedAt: "2026-07-20T00:00:00.000Z", trainingWindowStart: "2026-04-01", trainingWindowEnd: "2026-06-30",
      holdoutWindowStart: "2026-07-01", holdoutWindowEnd: "2026-07-15", sampleSize: 120000,
      metrics: { logLoss: 0.041, brier: 0.038 },
    },
    status: "candidate" as const,
    checksum: "sha256:abc123",
  };
  ok(hrModelArtifactSchema.safeParse(validArtifact).success, "model artifact schema accepts a valid fixture");
  const { checksum, ...missingChecksum } = validArtifact;
  ok(!hrModelArtifactSchema.safeParse(missingChecksum).success, "model artifact schema rejects a missing checksum");
  ok(!hrModelArtifactSchema.safeParse({ ...validArtifact, featureVersion: "hr_features_v2" }).success, "model artifact schema rejects a mismatched feature version");
}

// ── (h) Stage policy contract ────────────────────────────────────────────────
{
  const gate = (stage: HrStageGate["stage"]): HrStageGate => ({
    stage, minProbability: 0.05, minLiveLift: 0.01, minRankInGame: null, requiresDataQuality: "any",
  });
  const validPolicy = { policyVersion: "policy-v1", gates: [gate("watch"), gate("build"), gate("ready"), gate("fire")], notes: null };
  ok(hrStagePolicySchema.safeParse(validPolicy).success, "stage policy schema accepts a valid 4-gate fixture");

  const threeGatePolicy = { ...validPolicy, gates: [gate("watch"), gate("build"), gate("ready")] };
  ok(!hrStagePolicySchema.safeParse(threeGatePolicy).success, "stage policy schema rejects a 3-gate fixture");

  const duplicateStagePolicy = { ...validPolicy, gates: [gate("watch"), gate("fire"), gate("fire"), gate("build")] };
  const parsedDuplicate = hrStagePolicySchema.safeParse(duplicateStagePolicy);
  ok(parsedDuplicate.success, "stage policy schema itself accepts 4 gates even with a duplicate stage (schema-level check is count-only)");
  if (parsedDuplicate.success) {
    const stageSet = new Set(parsedDuplicate.data.gates.map((g) => g.stage));
    ok(
      stageSet.size !== 4,
      "test-side check (not the schema) catches a fixture with a duplicate stage and a missing stage — deferred to the future runtime policy evaluator",
    );
  }
}

// ── (i) Shadow decision record + first-Fire-transition worked example ──────
{
  const validDecision = {
    snapshotId: "snap-1", modelVersion: "hr-challenger-v1", policyVersion: "policy-v1",
    proposedStage: "ready" as const, previousProposedStage: "build" as const, stageTransitioned: true,
  };
  ok(hrShadowDecisionRecordSchema.safeParse(validDecision).success, "shadow decision record accepts a valid fixture");

  // Three decisions for the same game/player/model/policy lineage across
  // epochs: build -> ready -> fire. Only the transition INTO fire should be
  // counted as "first Fire" for evaluation purposes.
  const decisionSequence = [
    { snapshotId: "snap-1", modelVersion: "m1", policyVersion: "p1", proposedStage: "build" as const, previousProposedStage: "watch" as const, stageTransitioned: true },
    { snapshotId: "snap-2", modelVersion: "m1", policyVersion: "p1", proposedStage: "ready" as const, previousProposedStage: "build" as const, stageTransitioned: true },
    { snapshotId: "snap-3", modelVersion: "m1", policyVersion: "p1", proposedStage: "fire" as const, previousProposedStage: "ready" as const, stageTransitioned: true },
    { snapshotId: "snap-4", modelVersion: "m1", policyVersion: "p1", proposedStage: "fire" as const, previousProposedStage: "fire" as const, stageTransitioned: false },
    { snapshotId: "snap-5", modelVersion: "m1", policyVersion: "p1", proposedStage: "fire" as const, previousProposedStage: "fire" as const, stageTransitioned: false },
  ];
  for (const d of decisionSequence) {
    ok(hrShadowDecisionRecordSchema.safeParse(d).success, `decision sequence fixture ${d.snapshotId} parses`);
  }
  const firstFireTransitions = decisionSequence.filter((d) => d.proposedStage === "fire" && d.stageTransitioned === true);
  ok(firstFireTransitions.length === 1, "exactly one row in the sequence counts as a first-Fire transition, not all three Fire-stage rows");
  ok(firstFireTransitions[0].snapshotId === "snap-3", "the first-Fire transition is the row where the stage actually changed into fire");
}

console.log(`\nhrRadarResearchContracts.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
