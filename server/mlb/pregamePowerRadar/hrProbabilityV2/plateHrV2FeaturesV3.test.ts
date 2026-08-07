// PR7A stage 4 — plate_hr_v2_features_v3 contract invariants (shadow/additive).
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2FeaturesV3.test.ts

import {
  PLATE_HR_V2_FEATURES_V2,
  PLATE_HR_V2_FEATURES_V3,
  PLATE_HR_V2_FEATURES_CURRENT,
  plateHrV2DerivedFeatureVectorV3Schema,
  plateHrV2DerivedFeatureVectorV2Schema,
  plateHrV2DerivedFeatureVectorAnySchema,
  plateHrV2AuthorizedProjectionV3Schema,
  plateHrV2ZoneLocationV3FeaturesSchema,
  plateHrV2ContactOpportunityV3FeaturesSchema,
  plateHrV2PitcherDisciplineFeaturesSchema,
  plateHrV2FeatureAvailabilityVectorV3Schema,
  plateHrV2UnavailableZoneLocationV3,
  parseAuthorizedProjection,
} from "./plateHrV2FeatureContract";

let passed = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }

const nulls = (...keys: string[]): Record<string, null> => Object.fromEntries(keys.map((k) => [k, null]));
const withExtra = (o: Record<string, unknown>) => ({ ...o, extra: {} });

const pitchFamily = () => ({ usageShare: null, batterXslg: null, batterWhiffPct: null, batterSampleSwings: null, batterDamageBbeSample: null, batterWhiffSwingSample: null });

const contactOppV3 = () => withExtra({
  ...nulls("kRatePct", "bbRatePct", "whiffRatePct", "contactRatePct", "zoneContactRatePct", "chaseRatePct",
    "foulStrikeRatePct", "firstPitchStrikeRatePct", "twoStrikeSurvivalRatePct", "inPlayRatePct",
    "batterPa", "codedPitchPa", "pitchSequenceCoverage",
    "kRatePctVsL", "kRatePctVsR", "bbRatePctVsL", "bbRatePctVsR",
    "contactRatePctVsL", "contactRatePctVsR", "whiffRatePctVsL", "whiffRatePctVsR", "paVsL", "paVsR"),
});

const pitcherDiscipline = () => withExtra({
  pitcherKnown: false, batterHand: null, pitcherThrows: null,
  ...nulls("pitcherKRatePct", "pitcherBbRatePct", "pitcherWhiffRatePct", "pitcherCalledStrikeRatePct",
    "pitcherFirstPitchStrikeRatePct", "pitcherKRatePctVsHand", "pitcherBbRatePctVsHand", "pitcherBf", "pitcherBfVsHand"),
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
    dataQuality: { savantQuality: "missing", venueResolved: false, pitcherHandResolved: false, batterPowerFullyAvailable: false, missingInputs: [], overallQuality: "missing" },
    slateBaselineGameHrProbability: null,
  };
}

// 1. CURRENT is still V2 — this stage must NOT flip the default.
ok(PLATE_HR_V2_FEATURES_CURRENT === PLATE_HR_V2_FEATURES_V2, "CURRENT must remain V2 (additive, no default flip)");
ok(PLATE_HR_V2_FEATURES_V3 === "plate_hr_v2_features_v3", "V3 literal");

// 2. A well-formed V3 vector parses; the discriminated union routes it to V3.
const v3 = buildV3();
ok(plateHrV2DerivedFeatureVectorV3Schema.safeParse(v3).success, "valid V3 vector parses");
const anyParsed = plateHrV2DerivedFeatureVectorAnySchema.safeParse(v3);
ok(anyParsed.success && (anyParsed as any).data.featureVersion === PLATE_HR_V2_FEATURES_V3, "any-union routes V3");

// 3. STRICT: an extra top-level group is rejected.
ok(!plateHrV2DerivedFeatureVectorV3Schema.safeParse({ ...v3, bogusGroup: {} }).success, "extra group rejected (strict)");

// 4. STRICT: V3 missing pitcherDiscipline is rejected; V2 carrying pitcherDiscipline is rejected.
const { pitcherDiscipline: _pd, ...v3NoPd } = v3 as any;
ok(!plateHrV2DerivedFeatureVectorV3Schema.safeParse(v3NoPd).success, "V3 without pitcherDiscipline rejected");
ok(!plateHrV2DerivedFeatureVectorV2Schema.safeParse({ ...v3, featureVersion: PLATE_HR_V2_FEATURES_V2 }).success, "V2 carrying pitcherDiscipline/v3 shapes rejected");

// 5. contactOpportunity v3: keeps legacy null-forever leaves AND has the new discipline leaves.
const coParsed = plateHrV2ContactOpportunityV3FeaturesSchema.safeParse(contactOppV3());
ok(coParsed.success, "v3 contactOpportunity parses");
ok(!(plateHrV2ContactOpportunityV3FeaturesSchema.safeParse((() => { const c: any = contactOppV3(); delete c.foulStrikeRatePct; return c; })()).success), "v3 contactOpportunity requires foulStrikeRatePct");
ok(!(plateHrV2ContactOpportunityV3FeaturesSchema.safeParse((() => { const c: any = contactOppV3(); delete c.chaseRatePct; return c; })()).success), "v3 contactOpportunity retains legacy chaseRatePct leaf");
// zone-dependent leaves are pinned to literal null — a populated value is rejected (no proxy).
ok(!plateHrV2ContactOpportunityV3FeaturesSchema.safeParse({ ...contactOppV3(), chaseRatePct: 0.25 }).success, "non-null chaseRatePct rejected (no zone proxy)");
ok(!plateHrV2ContactOpportunityV3FeaturesSchema.safeParse({ ...contactOppV3(), zoneContactRatePct: 80 }).success, "non-null zoneContactRatePct rejected (no zone proxy)");

// 6. zoneLocation v3 = explicit unavailable record; location values MUST be null.
const zl = plateHrV2UnavailableZoneLocationV3();
ok(plateHrV2ZoneLocationV3FeaturesSchema.safeParse(zl).success, "canonical unavailable zoneLocation parses");
ok(zl.status === "unavailable" && zl.reason === "licensed_source_unavailable", "zoneLocation reason is licensed_source_unavailable");
ok(!plateHrV2ZoneLocationV3FeaturesSchema.safeParse({ ...zl, plateX: 0.5 }).success, "populated plateX rejected (location-blind)");
ok(!plateHrV2ZoneLocationV3FeaturesSchema.safeParse({ ...zl, reason: "some_other_reason" }).success, "unknown zone reason rejected");
ok(!plateHrV2ZoneLocationV3FeaturesSchema.safeParse({ ...zl, status: "available" }).success, "non-unavailable status rejected");

// 7. pitcherDiscipline shape.
ok(plateHrV2PitcherDisciplineFeaturesSchema.safeParse(pitcherDiscipline()).success, "pitcherDiscipline parses");
ok(!plateHrV2PitcherDisciplineFeaturesSchema.safeParse({ ...pitcherDiscipline(), kRatePct: null }).success, "pitcherDiscipline rejects a batter K leaf (no duplication)");
ok(plateHrV2PitcherDisciplineFeaturesSchema.safeParse({ ...pitcherDiscipline(), batterHand: "R" }).success, "pitcherDiscipline accepts resolved hand R");
ok(!plateHrV2PitcherDisciplineFeaturesSchema.safeParse({ ...pitcherDiscipline(), batterHand: "S" }).success, "pitcherDiscipline rejects 'S' as a resolved batter hand");

// 8. Authorized projection V3 strips market + zoneLocation; parseAuthorizedProjection routes V3.
const proj: any = { ...v3 };
delete proj.market; delete proj.zoneLocation;
ok(plateHrV2AuthorizedProjectionV3Schema.safeParse(proj).success, "v3 authorized projection (no market/zoneLocation) parses");
ok(!plateHrV2AuthorizedProjectionV3Schema.safeParse(v3).success, "authorized projection rejects a vector still carrying market/zoneLocation");
ok(parseAuthorizedProjection(PLATE_HR_V2_FEATURES_V3, proj).ok, "parseAuthorizedProjection accepts V3 projection");
const mism = parseAuthorizedProjection(PLATE_HR_V2_FEATURES_V2, proj);
ok(!mism.ok, "parseAuthorizedProjection rejects V3 projection under V2 version");

// 9. Availability vector V3 requires pitcherDiscipline.
const avail: any = {
  featureVersion: PLATE_HR_V2_FEATURES_V3,
  batterPower: {}, batTracking: {}, pitcherVulnerability: {}, pitchType: {}, zoneLocation: {},
  parkWeatherSpray: {}, lineupOpportunity: {}, starterBullpen: {}, market: {}, availability: {},
  contactOpportunity: {}, recentContactForm: {}, pitcherDiscipline: {},
};
ok(plateHrV2FeatureAvailabilityVectorV3Schema.safeParse(avail).success, "v3 availability vector parses");
const { pitcherDiscipline: _a, ...availNoPd } = avail;
ok(!plateHrV2FeatureAvailabilityVectorV3Schema.safeParse(availNoPd).success, "v3 availability vector requires pitcherDiscipline");

console.log(`plateHrV2FeaturesV3.test: ${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL:", f);
process.exit(fails.length ? 1 : 0);
