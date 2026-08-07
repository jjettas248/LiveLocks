// PR7A.2 — plate_hr_v2_features_v3 contract invariants (shadow/additive).
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2FeaturesV3.test.ts

import {
  PLATE_HR_V2_FEATURES_V2,
  PLATE_HR_V2_FEATURES_V3,
  PLATE_HR_V2_FEATURES_CURRENT,
  PLATE_DISCIPLINE_FLOOR_NULL_REASONS,
  plateHrV2DerivedFeatureVectorV3Schema,
  plateHrV2DerivedFeatureVectorV2Schema,
  plateHrV2DerivedFeatureVectorAnySchema,
  plateHrV2AuthorizedProjectionV3Schema,
  plateHrV2ZoneLocationV3FeaturesSchema,
  plateHrV2ContactOpportunityV3FeaturesSchema,
  plateHrV2PitcherDisciplineFeaturesSchema,
  plateHrV2DataQualityV3FeaturesSchema,
  plateHrV2FeatureAvailabilityVectorV3Schema,
  plateHrV2UnavailableZoneLocationV3,
  parseAuthorizedProjection,
} from "./plateHrV2FeatureContract";

let passed = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }

const nulls = (...keys: string[]): Record<string, null> => Object.fromEntries(keys.map((k) => [k, null]));
const withExtra = (o: Record<string, unknown>) => ({ ...o, extra: {} });
const del = (o: any, k: string) => { const c = JSON.parse(JSON.stringify(o)); delete c[k]; return c; };

const pitchFamily = () => ({ usageShare: null, batterXslg: null, batterWhiffPct: null, batterSampleSwings: null, batterDamageBbeSample: null, batterWhiffSwingSample: null });

const contactOppV3 = () => withExtra({
  ...nulls("kRatePct", "bbRatePct", "whiffRatePct", "contactRatePct", "foulStrikeRatePct", "firstPitchStrikeRatePct",
    "twoStrikeSurvivalRatePct", "inPlayRatePct", "batterPa", "codedPitchPa", "pitchSequenceCoverage",
    "kRatePctVsL", "kRatePctVsR", "bbRatePctVsL", "bbRatePctVsR",
    "contactRatePctVsL", "contactRatePctVsR", "whiffRatePctVsL", "whiffRatePctVsR", "paVsL", "paVsR"),
  chaseRatePct: null, zoneContactRatePct: null,
});

const pitcherDiscipline = () => withExtra({
  pitcherKnown: false, pitcherThrows: null,
  ...nulls("pitcherKRatePct", "pitcherBbRatePct", "pitcherWhiffRatePct", "pitcherCalledStrikeRatePct", "pitcherFirstPitchStrikeRatePct",
    "pitcherKRatePctVsL", "pitcherKRatePctVsR", "pitcherBbRatePctVsL", "pitcherBbRatePctVsR",
    "pitcherPitches", "pitcherBf", "pitcherBfVsL", "pitcherBfVsR"),
});

const dataQualityV3 = () => ({
  savantQuality: "missing", venueResolved: false, pitcherHandResolved: false, batterPowerFullyAvailable: false, missingInputs: [], overallQuality: "missing",
  retrosheetDiscipline: { datasetVersion: "rs_2019_v1", dataThroughDate: "2019-09-14", pitchSequenceCoverage: null, sequenceFloorMet: false, overallQuality: "missing", nullReasons: [] as string[] },
});

function buildV3(): Record<string, unknown> {
  return {
    featureVersion: PLATE_HR_V2_FEATURES_V3,
    batterPower: withExtra(nulls("xISO", "xSLG", "xwOBAcon", "barrelRatePct", "hardHitRatePct", "exitVelocity", "maxEV", "flyBallPct", "hrFBRatioPct", "pullRatePct", "sweetSpotPct", "hrPerPaSeason", "paSample")),
    batTracking: withExtra(nulls("avgBatSpeed", "fastSwingRatePct", "avgSwingLength", "avgAttackAngle", "idealAttackAngleRatePct", "attackAngleStdDev", "avgSwingPathTilt", "squaredUpPerSwingPct", "blastPerSwingPct", "swingSample")),
    pitcherVulnerability: withExtra({ pitcherKnown: false, batterHand: null, pitcherThrows: null, ...nulls("hrPer9VsHand", "hrPer9Overall", "barrelAllowedPct", "hardHitAllowedPct", "flyBallAllowedPct", "bfSample") }),
    pitchType: { fastball: pitchFamily(), breaking: pitchFamily(), offspeed: pitchFamily(), extra: {} },
    zoneLocation: plateHrV2UnavailableZoneLocationV3(),
    parkWeatherSpray: withExtra({ ...nulls("parkHrFactor", "parkHrFactorHand"), isIndoors: false, weatherAvailable: false, temperatureF: null, windSpeedMph: null, windDirection: null, ...nulls("batterPullAirShare", "pullFenceDistanceFt", "pullFenceHeightFt", "avgFenceDistanceFt", "avgFenceHeightFt", "avgHrDistanceFt") }),
    lineupOpportunity: withExtra({ battingOrderSlot: null, teamImpliedRuns: null, obpAhead: null, lineupConfirmed: false }),
    starterBullpen: withExtra({ starterConfirmed: false, ...nulls("projectedPaVsStarter", "projectedPaVsBullpen", "bullpenHrPer9", "bullpenBarrelAllowedPct") }),
    market: withExtra({ hrOddsAvailable: false, impliedHrProbability: null, noVigImpliedHrProbability: null }),
    availability: withExtra({ confirmedActive: null, lateScratchRisk: null, restDayRisk: null, platoonSubRisk: null }),
    contactOpportunity: contactOppV3(),
    recentContactForm: withExtra(nulls("recentFormEv", "recentFormEv90", "recentFormAirBallPct", "recentFormBarrelPct", "recentFormPulledAirShare", "recentFormXHrPerContact", "effectiveBbe", "last15Bbe", "reliabilityWeight")),
    pitcherDiscipline: pitcherDiscipline(),
    dataQuality: dataQualityV3(),
    slateBaselineGameHrProbability: null,
  };
}

// 1. CURRENT stays V2 (no default flip).
ok(PLATE_HR_V2_FEATURES_CURRENT === PLATE_HR_V2_FEATURES_V2, "CURRENT must remain V2");
ok(PLATE_HR_V2_FEATURES_V3 === "plate_hr_v2_features_v3", "V3 literal");

// 2. Valid V3 parses; union routes it to V3.
const v3 = buildV3();
ok(plateHrV2DerivedFeatureVectorV3Schema.safeParse(v3).success, "valid V3 vector parses");
const anyParsed = plateHrV2DerivedFeatureVectorAnySchema.safeParse(v3);
ok(anyParsed.success && (anyParsed as any).data.featureVersion === PLATE_HR_V2_FEATURES_V3, "any-union routes V3");

// 3. STRICT: extra group rejected; V3 missing pitcherDiscipline/dataQuality-block rejected; V2 carrying V3 shapes rejected.
ok(!plateHrV2DerivedFeatureVectorV3Schema.safeParse({ ...v3, bogusGroup: {} }).success, "extra group rejected");
ok(!plateHrV2DerivedFeatureVectorV3Schema.safeParse(del(v3, "pitcherDiscipline")).success, "V3 without pitcherDiscipline rejected");
ok(!plateHrV2DerivedFeatureVectorV2Schema.safeParse({ ...v3, featureVersion: PLATE_HR_V2_FEATURES_V2 }).success, "V2 carrying V3 shapes rejected");

// 4. contactOpportunity v3: new leaves required; legacy chase/zoneContact retained but pinned to literal null.
ok(plateHrV2ContactOpportunityV3FeaturesSchema.safeParse(contactOppV3()).success, "v3 contactOpportunity parses");
ok(!plateHrV2ContactOpportunityV3FeaturesSchema.safeParse(del(contactOppV3(), "foulStrikeRatePct")).success, "requires foulStrikeRatePct");
ok(!plateHrV2ContactOpportunityV3FeaturesSchema.safeParse(del(contactOppV3(), "chaseRatePct")).success, "retains chaseRatePct leaf");
ok(!plateHrV2ContactOpportunityV3FeaturesSchema.safeParse({ ...contactOppV3(), chaseRatePct: 0.25 }).success, "non-null chaseRatePct rejected (no zone proxy)");
ok(!plateHrV2ContactOpportunityV3FeaturesSchema.safeParse({ ...contactOppV3(), zoneContactRatePct: 80 }).success, "non-null zoneContactRatePct rejected (no zone proxy)");
// count leaves are non-negative-integer-or-null.
ok(plateHrV2ContactOpportunityV3FeaturesSchema.safeParse({ ...contactOppV3(), batterPa: 150, codedPitchPa: 140, paVsL: 60, paVsR: 90 }).success, "integer count leaves accepted");
ok(!plateHrV2ContactOpportunityV3FeaturesSchema.safeParse({ ...contactOppV3(), batterPa: 2.5 }).success, "non-integer batterPa rejected");
ok(!plateHrV2ContactOpportunityV3FeaturesSchema.safeParse({ ...contactOppV3(), codedPitchPa: -1 }).success, "negative codedPitchPa rejected");
ok(!plateHrV2ContactOpportunityV3FeaturesSchema.safeParse({ ...contactOppV3(), paVsL: 1.5 }).success, "non-integer paVsL rejected");

// 5. zoneLocation v3 = explicit unavailable record; location values MUST be null.
const zl = plateHrV2UnavailableZoneLocationV3();
ok(plateHrV2ZoneLocationV3FeaturesSchema.safeParse(zl).success, "canonical unavailable zoneLocation parses");
ok(zl.status === "unavailable" && zl.reason === "licensed_source_unavailable", "reason is licensed_source_unavailable");
ok(!plateHrV2ZoneLocationV3FeaturesSchema.safeParse({ ...zl, plateX: 0.5 }).success, "populated plateX rejected");
ok(!plateHrV2ZoneLocationV3FeaturesSchema.safeParse({ ...zl, reason: "some_other_reason" }).success, "unknown reason rejected");

// 6. pitcherDiscipline: vsL/vsR history + pitches; NO prediction-specific batterHand/vsHand; int denominators.
ok(plateHrV2PitcherDisciplineFeaturesSchema.safeParse(pitcherDiscipline()).success, "pitcherDiscipline parses");
ok(!plateHrV2PitcherDisciplineFeaturesSchema.safeParse({ ...pitcherDiscipline(), kRatePct: null }).success, "rejects a batter K leaf (no duplication)");
ok(!plateHrV2PitcherDisciplineFeaturesSchema.safeParse({ ...pitcherDiscipline(), batterHand: "L" }).success, "rejects a prediction-specific batterHand field (removed)");
ok(!plateHrV2PitcherDisciplineFeaturesSchema.safeParse({ ...pitcherDiscipline(), pitcherKRatePctVsHand: null }).success, "rejects legacy vsHand leaf (removed)");
ok(!plateHrV2PitcherDisciplineFeaturesSchema.safeParse(del(pitcherDiscipline(), "pitcherBfVsL")).success, "requires pitcherBfVsL (vsL/vsR history)");
ok(!plateHrV2PitcherDisciplineFeaturesSchema.safeParse(del(pitcherDiscipline(), "pitcherPitches")).success, "requires pitcherPitches");
ok(!plateHrV2PitcherDisciplineFeaturesSchema.safeParse({ ...pitcherDiscipline(), pitcherBf: 2.5 }).success, "non-integer pitcherBf rejected");
ok(!plateHrV2PitcherDisciplineFeaturesSchema.safeParse({ ...pitcherDiscipline(), pitcherBfVsHand: 1 }).success, "extra pitcherBfVsHand rejected (strict)");

// 7. V3 dataQuality carries the retrosheetDiscipline block with typed null reasons.
ok(plateHrV2DataQualityV3FeaturesSchema.safeParse(dataQualityV3()).success, "v3 dataQuality parses");
ok(!plateHrV2DataQualityV3FeaturesSchema.safeParse(del(dataQualityV3(), "retrosheetDiscipline")).success, "v3 dataQuality requires retrosheetDiscipline block");
ok(plateHrV2DataQualityV3FeaturesSchema.safeParse((() => { const d: any = dataQualityV3(); d.retrosheetDiscipline.nullReasons = [...PLATE_DISCIPLINE_FLOOR_NULL_REASONS]; return d; })()).success, "all typed null reasons accepted");
ok(!plateHrV2DataQualityV3FeaturesSchema.safeParse((() => { const d: any = dataQualityV3(); d.retrosheetDiscipline.nullReasons = ["bogus_floor"]; return d; })()).success, "untyped null reason rejected");
ok(PLATE_DISCIPLINE_FLOOR_NULL_REASONS.length === 5, "exactly 5 floor null reasons");

// 8. Authorized projection V3 strips market + zoneLocation but KEEPS dataQuality.
const proj = del(del(v3, "market"), "zoneLocation");
ok(plateHrV2AuthorizedProjectionV3Schema.safeParse(proj).success, "v3 authorized projection parses");
ok(!plateHrV2AuthorizedProjectionV3Schema.safeParse(v3).success, "projection rejects a vector still carrying market/zoneLocation");
ok(parseAuthorizedProjection(PLATE_HR_V2_FEATURES_V3, proj).ok, "parseAuthorizedProjection accepts V3 projection");
ok(!parseAuthorizedProjection(PLATE_HR_V2_FEATURES_V2, proj).ok, "parseAuthorizedProjection rejects V3 projection under V2");

// 9. Availability vector V3 requires pitcherDiscipline.
const avail: any = { featureVersion: PLATE_HR_V2_FEATURES_V3, batterPower: {}, batTracking: {}, pitcherVulnerability: {}, pitchType: {}, zoneLocation: {}, parkWeatherSpray: {}, lineupOpportunity: {}, starterBullpen: {}, market: {}, availability: {}, contactOpportunity: {}, recentContactForm: {}, pitcherDiscipline: {} };
ok(plateHrV2FeatureAvailabilityVectorV3Schema.safeParse(avail).success, "v3 availability vector parses");
ok(!plateHrV2FeatureAvailabilityVectorV3Schema.safeParse(del(avail, "pitcherDiscipline")).success, "v3 availability vector requires pitcherDiscipline");

console.log(`plateHrV2FeaturesV3.test: ${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL:", f);
process.exit(fails.length ? 1 : 0);
