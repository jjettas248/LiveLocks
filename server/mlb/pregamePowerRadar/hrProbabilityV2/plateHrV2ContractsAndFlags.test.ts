// Plate HR Probability V2 — contract + flag invariants (PR 1).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2ContractsAndFlags.test.ts

import {
  PLATE_HR_V2_FEATURES_V1,
  PLATE_HR_V2_FEATURES_V2,
  PLATE_HR_V2_FEATURES_CURRENT,
  plateHrV2DerivedFeatureVectorV1Schema,
  plateHrV2DerivedFeatureVectorV2Schema,
  plateHrV2DerivedFeatureVectorAnySchema,
  plateHrV2FeatureAvailabilityVectorV1Schema,
  plateHrV2FeatureAvailabilityVectorV2Schema,
  plateHrV2RawInputEnvelopeSchema,
  resolveSingleFeatureVersion,
} from "./plateHrV2FeatureContract";
import {
  plateHrV2LabelDispositionSchema,
  plateHrV2EvaluationLabelContractSchema,
} from "./plateHrV2LabelContract";
import { plateHrV2ModelArtifactSchema } from "./plateHrV2ModelArtifactContract";
import {
  PLATE_HR_V2_FORBIDDEN_TRAINING_FEATURES,
  assertNoForbiddenTrainingFeatures,
} from "./plateHrV2TrainingFeatureGuard";
import {
  PLATE_HR_V2_FORWARD_CAPTURE_ENV,
  parsePlateHrV2ForwardCaptureFlag,
} from "./plateHrV2CaptureFlags";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const numericGroup = { extra: {} };
const family = { usageShare: null, batterXslg: null, batterWhiffPct: null, batterSampleSwings: null, batterDamageBbeSample: null, batterWhiffSwingSample: null };

function fullFeatureVectorFixture() {
  return {
    featureVersion: PLATE_HR_V2_FEATURES_V1,
    batterPower: {
      xISO: 0.18, xSLG: 0.42, xwOBAcon: 0.37, barrelRatePct: 8.5, hardHitRatePct: 40,
      exitVelocity: 90, maxEV: 108, flyBallPct: 35, hrFBRatioPct: 15, pullRatePct: 42,
      sweetSpotPct: 33, hrPerPaSeason: null, paSample: 210, ...numericGroup,
    },
    batTracking: {
      avgBatSpeed: 72, fastSwingRatePct: null, avgSwingLength: 7.2, avgAttackAngle: null,
      idealAttackAngleRatePct: null, attackAngleStdDev: null, avgSwingPathTilt: null,
      squaredUpPerSwingPct: null, blastPerSwingPct: null, swingSample: null, ...numericGroup,
    },
    pitcherVulnerability: {
      pitcherKnown: true, batterHand: "R", pitcherThrows: "L", hrPer9VsHand: 1.2,
      hrPer9Overall: null, barrelAllowedPct: null, hardHitAllowedPct: null,
      flyBallAllowedPct: null, bfSample: null, ...numericGroup,
    },
    pitchType: { fastball: family, breaking: family, offspeed: family, ...numericGroup },
    zoneLocation: {
      batterHeartXslg: null, batterElevatedFbXslg: null, batterLowBreakingXslg: null,
      pitcherHeartRate: null, pitcherMiddleMiddleRate: null, pitcherHangerRate: null, ...numericGroup,
    },
    parkWeatherSpray: {
      parkHrFactor: 1.05, parkHrFactorHand: 1.1, isIndoors: false, weatherAvailable: true,
      temperatureF: 75, windSpeedMph: 8, windDirection: "out", batterPullAirShare: 0.4,
      pullFenceDistanceFt: 330, pullFenceHeightFt: 8, avgFenceDistanceFt: 375,
      avgFenceHeightFt: 9, avgHrDistanceFt: 395, ...numericGroup,
    },
    lineupOpportunity: { battingOrderSlot: 3, teamImpliedRuns: null, obpAhead: null, lineupConfirmed: true, ...numericGroup },
    starterBullpen: {
      starterConfirmed: true, projectedPaVsStarter: null, projectedPaVsBullpen: null,
      bullpenHrPer9: null, bullpenBarrelAllowedPct: null, ...numericGroup,
    },
    market: { hrOddsAvailable: false, impliedHrProbability: null, noVigImpliedHrProbability: null, ...numericGroup },
    availability: { confirmedActive: true, lateScratchRisk: null, restDayRisk: null, platoonSubRisk: null, ...numericGroup },
    contactOpportunity: {
      kRatePct: null, bbRatePct: null, whiffRatePct: null, contactRatePct: null,
      zoneContactRatePct: null, chaseRatePct: null, ...numericGroup,
    },
    dataQuality: {
      savantQuality: "full", venueResolved: true, pitcherHandResolved: true,
      batterPowerFullyAvailable: true, missingInputs: [], overallQuality: "full",
    },
    slateBaselineGameHrProbability: null,
  };
}

// ── 1. Derived feature vector: valid fixture parses ─────────────────────────
{
  const result = plateHrV2DerivedFeatureVectorV1Schema.safeParse(fullFeatureVectorFixture());
  ok(result.success, `full fixture parses cleanly${result.success ? "" : `: ${JSON.stringify((result as any).error?.issues?.[0])}`}`);
}

// ── 2. Every leaf is required (never optional) — a dropped key must fail ───
{
  const fixture: any = fullFeatureVectorFixture();
  delete fixture.batterPower.xISO;
  const result = plateHrV2DerivedFeatureVectorV1Schema.safeParse(fixture);
  ok(!result.success, "a dropped (not merely null) leaf key fails validation — every leaf must be present, explicit null or a value");
}

// ── PR5.1 gap 1: V1 preserved; V2 = V1 + recentContactForm; no shape collision ─
{
  const RECENT_FORM = {
    recentFormEv: null, recentFormEv90: null, recentFormAirBallPct: null, recentFormBarrelPct: null,
    recentFormPulledAirShare: null, recentFormXHrPerContact: null, effectiveBbe: null, last15Bbe: null,
    reliabilityWeight: null, ...numericGroup,
  };
  // Historical V1 rows (no recentContactForm) still parse against V1.
  const v1 = fullFeatureVectorFixture();
  ok(plateHrV2DerivedFeatureVectorV1Schema.safeParse(v1).success, "a historical V1 row (no recentContactForm) still parses as V1");
  // A V2 row = V1 body + recentContactForm + featureVersion V2.
  const v2 = { ...fullFeatureVectorFixture(), featureVersion: PLATE_HR_V2_FEATURES_V2, recentContactForm: RECENT_FORM };
  ok(plateHrV2DerivedFeatureVectorV2Schema.safeParse(v2).success, "a V2 row (with recentContactForm) parses as V2");
  // V2 REQUIRES the new group.
  const v2Missing: any = { ...v2 }; delete v2Missing.recentContactForm;
  ok(!plateHrV2DerivedFeatureVectorV2Schema.safeParse(v2Missing).success, "V2 rejects a row missing recentContactForm");
  // A V1-versioned row must NOT validate as V2 (version discipline).
  ok(!plateHrV2DerivedFeatureVectorV2Schema.safeParse(v1).success, "a V1-versioned row does not validate as V2");
  // The discriminated-union reader accepts BOTH shapes.
  ok(plateHrV2DerivedFeatureVectorAnySchema.safeParse(v1).success && plateHrV2DerivedFeatureVectorAnySchema.safeParse(v2).success, "the any-version reader parses both V1 and V2");
  ok(PLATE_HR_V2_FEATURES_CURRENT === PLATE_HR_V2_FEATURES_V2, "new snapshots are written as V2 (CURRENT === V2)");
  // Availability V2 requires recentContactForm too.
  const availV2 = {
    featureVersion: PLATE_HR_V2_FEATURES_V2,
    batterPower: {}, batTracking: {}, pitcherVulnerability: {}, pitchType: {}, zoneLocation: {},
    parkWeatherSpray: {}, lineupOpportunity: {}, starterBullpen: {}, market: {}, availability: {},
    contactOpportunity: {}, recentContactForm: {},
  };
  ok(plateHrV2FeatureAvailabilityVectorV2Schema.safeParse(availV2).success, "availability V2 parses");
  const availV2Missing: any = { ...availV2 }; delete availV2Missing.recentContactForm;
  ok(!plateHrV2FeatureAvailabilityVectorV2Schema.safeParse(availV2Missing).success, "availability V2 requires recentContactForm");
  // Mixed feature versions must never enter one training artifact.
  ok(resolveSingleFeatureVersion([PLATE_HR_V2_FEATURES_V2, PLATE_HR_V2_FEATURES_V2]).ok, "a single-version set resolves");
  const mixed = resolveSingleFeatureVersion([PLATE_HR_V2_FEATURES_V1, PLATE_HR_V2_FEATURES_V2]);
  ok(!mixed.ok, "a mixed-version set is rejected (no mixed versions in one training artifact)");
}

// ── 3. featureVersion is a locked literal ───────────────────────────────────
{
  const fixture: any = fullFeatureVectorFixture();
  fixture.featureVersion = "some_other_version";
  const result = plateHrV2DerivedFeatureVectorV1Schema.safeParse(fixture);
  ok(!result.success, "featureVersion must equal PLATE_HR_V2_FEATURES_V1 exactly");
}

// ── 4. Availability + raw-envelope schemas parse their own shapes ───────────
{
  const availability = {
    featureVersion: PLATE_HR_V2_FEATURES_V1,
    batterPower: { xISO: { present: true, quality: "full" } },
    batTracking: {}, pitcherVulnerability: {}, pitchType: {}, zoneLocation: {},
    parkWeatherSpray: {}, lineupOpportunity: {}, starterBullpen: {}, market: {},
    availability: {}, contactOpportunity: {},
  };
  ok(plateHrV2FeatureAvailabilityVectorV1Schema.safeParse(availability).success, "availability vector parses");

  const rawEnvelope = { inputContractVersion: "plate_hr_v2_raw_inputs_v1", capturedAt: new Date().toISOString(), families: { batterPower: { xISO: 0.18 } } };
  ok(plateHrV2RawInputEnvelopeSchema.safeParse(rawEnvelope).success, "raw input envelope parses (loosely-typed families record)");
}

// ── 5. Label contract: disposition enum + nullable hitHrToday ──────────────
{
  ok(plateHrV2LabelDispositionSchema.options.length === 4, "exactly 4 label disposition values");
  ok(
    JSON.stringify(plateHrV2LabelDispositionSchema.options.slice().sort()) ===
      JSON.stringify(["censored", "excluded", "manual_review", "resolved"]),
    "disposition values are exactly resolved/censored/excluded/manual_review",
  );

  const resolvedNegative = {
    labelVersion: "plate_hr_v2_label_v1", snapshotId: "snap-1", labelDisposition: "resolved",
    resolvedAt: new Date().toISOString(), resolutionReason: "game_final",
    hitHrToday: false, paCountObserved: 4, hrCountToday: 0, hrEventId: null,
    hrInning: null, hrHalf: null, hrPlateAppearanceNumber: null, hrFirstAb: null,
    labelSource: "engine", dataQuality: null,
  };
  ok(plateHrV2EvaluationLabelContractSchema.safeParse(resolvedNegative).success, "resolved+false is a valid, fully-parseable negative label — whole-game rule, unconditional on PA count");

  const excludedNoPa = { ...resolvedNegative, labelDisposition: "excluded", resolutionReason: "no_pa_recorded", hitHrToday: null };
  ok(plateHrV2EvaluationLabelContractSchema.safeParse(excludedNoPa).success, "no_pa_recorded excluded label (schema allows hitHrToday:null here — app-level enforces the disposition/nullability pairing)");
}

// ── 6. Model artifact contract: standardization nullable + additive ────────
{
  const artifact = {
    modelVersion: "plate_hr_probability_v2_shadow_candidate_1",
    modelType: "logistic",
    featureVersion: PLATE_HR_V2_FEATURES_V1,
    featureOrder: ["batterPower.xISO"],
    missingValueBehavior: "neutral_marker",
    standardization: null,
    baseline: { kind: "constant", intercept: null, coefficients: null, knots: null, treeNodes: null },
    live: { kind: "constant", intercept: null, coefficients: null, knots: null, treeNodes: null },
    calibration: { method: "none", params: null },
    training: {
      trainedAt: new Date().toISOString(), trainingWindowStart: null, trainingWindowEnd: null,
      holdoutWindowStart: null, holdoutWindowEnd: null, sampleSize: null, metrics: null,
    },
    status: "candidate",
    checksum: "deadbeef",
  };
  ok(plateHrV2ModelArtifactSchema.safeParse(artifact).success, "model artifact with null standardization parses (no fitter exists yet in PR1)");

  const withStandardization = { ...artifact, standardization: { featureMeans: { "batterPower.xISO": 0.16 }, featureStddevs: { "batterPower.xISO": 0.04 } } };
  ok(plateHrV2ModelArtifactSchema.safeParse(withStandardization).success, "model artifact with populated standardization also parses");

  ok(!("policy" in artifact), "no policy/stage-policy block on the artifact contract (deliberate omission — no promotion policy exists yet)");

  // PR2: a logistic component's coefficients alone can't reproduce its
  // fitted probabilities (predictTermModel needs intercept + Σcoef*term) —
  // intercept is a required (nullable, not optional) leaf on every component.
  const withIntercept = { ...artifact, baseline: { kind: "logistic", intercept: -2.9, coefficients: { "batterPower.xISO": 0.4 }, knots: null, treeNodes: null } };
  ok(plateHrV2ModelArtifactSchema.safeParse(withIntercept).success, "a logistic baseline component with a real intercept parses");
  const { intercept, ...baselineWithoutIntercept } = withIntercept.baseline;
  const missingIntercept = { ...artifact, baseline: baselineWithoutIntercept };
  ok(!plateHrV2ModelArtifactSchema.safeParse(missingIntercept).success, "a component missing intercept entirely fails validation — it is required, not optional");
}

// ── 7. Forbidden training-feature guard ─────────────────────────────────────
{
  ok(PLATE_HR_V2_FORBIDDEN_TRAINING_FEATURES.includes("championScore10"), "championScore10 is forbidden");
  ok(PLATE_HR_V2_FORBIDDEN_TRAINING_FEATURES.includes("hitHrToday"), "hitHrToday (the label itself) is forbidden as a feature");
  ok(PLATE_HR_V2_FORBIDDEN_TRAINING_FEATURES.includes("marketOdds"), "marketOdds is forbidden");

  let threw = false;
  try { assertNoForbiddenTrainingFeatures(["batterPower.xISO", "championScore10"]); } catch { threw = true; }
  ok(threw, "assertNoForbiddenTrainingFeatures throws when a forbidden name is present");

  threw = false;
  try { assertNoForbiddenTrainingFeatures(["batterPower.xISO", "pitcherVulnerability.hrPer9VsHand"]); } catch { threw = true; }
  ok(!threw, "assertNoForbiddenTrainingFeatures does not throw on a clean feature-leaf list");
}

// ── 8. Forward-capture flag parsing — fail-closed ───────────────────────────
{
  ok(PLATE_HR_V2_FORWARD_CAPTURE_ENV === "PLATE_HR_V2_FORWARD_CAPTURE_ENABLED", "flag env var name is stable");
  for (const v of ["true", "1", "on", "yes", "TRUE", " yes "]) {
    ok(parsePlateHrV2ForwardCaptureFlag(v) === true, `"${v}" parses as enabled`);
  }
  for (const v of [undefined, null, "", "false", "0", "off", "no", "enabled", "TRU"]) {
    ok(parsePlateHrV2ForwardCaptureFlag(v as any) === false, `"${v}" parses as disabled (fail-closed)`);
  }
}

console.log(`\nplateHrV2ContractsAndFlags.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
