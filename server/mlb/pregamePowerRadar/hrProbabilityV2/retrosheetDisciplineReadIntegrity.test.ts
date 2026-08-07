// PR7A.2 — retrosheet_discipline strict-read integrity (training-read gate).
// Non-vacuous: builds shape-valid stored rows and asserts the SPECIFIC rejection
// reason appears in evaluatePredictionRowIntegrity's reasons (other id/hash reasons
// from the deliberately-minimal fixtures are ignored).
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/retrosheetDisciplineReadIntegrity.test.ts

import { evaluatePredictionRowIntegrity } from "./plateHrV2Snapshots";
import { RETROSHEET_ATTRIBUTION_NOTICE } from "./retrosheetDisciplineEvidence";
import { PLATE_HR_V2_FEATURES_V3 } from "./plateHrV2FeatureContract";

let passed = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }

const nulls = (...k: string[]): Record<string, null> => Object.fromEntries(k.map((x) => [x, null]));
const withExtra = (o: Record<string, unknown>) => ({ ...o, extra: {} });

function retroBatterPayload(): any {
  return {
    actorType: "batter",
    provenance: {
      datasetVersion: "retrosheet_2019_v1", dataThroughDate: "2019-09-14", seasonsCovered: [2019],
      window: { from: "2019-03-20", to: "2019-09-14" }, gameIds: ["G1", "G2"], gameCount: 2,
      attributionNotice: RETROSHEET_ATTRIBUTION_NOTICE, sequenceFloorMet: true, overallQuality: "full", nullReasons: [],
    },
    batter: {
      counts: { pa: 100, k: 22, bb: 10, ibb: 1, hbp: 2, pitches: 380, swings: 180, whiffs: 40, contacts: 140, fouls: 90,
        calledStrikes: 70, takenPitches: 200, inPlay: 50, firstPitchStrikes: 55, twoStrikePa: 45, twoStrikeK: 22, twoStrikeSurvived: 23, codedPitchPa: 96 },
      handSplits: { paVsL: 30, paVsR: 70, kVsL: 7, kVsR: 15, bbVsL: 3, bbVsR: 7,
        contactsVsL: 40, contactsVsR: 100, swingsVsL: 55, swingsVsR: 125, whiffsVsL: 12, whiffsVsR: 28 },
    },
  };
}

function srcRow(overrides: Record<string, unknown> = {}): any {
  return {
    sourceSnapshotId: "s1", provider: "retrosheet", entityId: "b1", entityType: "batter",
    evidenceKind: "retrosheet_discipline", dataThroughAt: "2019-09-14T00:00:00.000Z",
    availableAt: "2020-01-01T00:00:00.000Z", availabilitySource: "verified_as_of", validForAt: null,
    reconstructed: true, provenanceIncomplete: false, fetchedAt: null,
    schemaVersion: PLATE_HR_V2_FEATURES_V3, contentHash: "h", payloadRef: null,
    authorizedPayload: retroBatterPayload(), ...overrides,
  };
}
function predRow(overrides: Record<string, unknown> = {}): any {
  return {
    predictionSnapshotId: "p1", gamePk: "g1", batterId: "b1", featureVersion: PLATE_HR_V2_FEATURES_V3,
    predictionAsOf: "2021-05-01T00:00:00.000Z", firstPitchTime: "2021-05-01T23:00:00.000Z",
    sourceSnapshotIds: ["s1"], derivedFeatures: {}, contentHash: "h",
    trainingEligible: true, authoritative: false, trainingBlockReasons: [], ...overrides,
  };
}
function run(pred: any, srcs: any[]): string[] {
  const map = new Map<string, unknown>(srcs.map((s) => [s.sourceSnapshotId, s]));
  return evaluatePredictionRowIntegrity(pred, map).reasons;
}
const has = (reasons: string[], needle: string) => reasons.some((r) => r.includes(needle));

// 6. unauthorized provider.
ok(has(run(predRow(), [srcRow({ provider: "mlb_stats_live" })]), "retrosheet_discipline_provider_unauthorized"), "unauthorized provider rejected");

// 7. non-verified_as_of Retrosheet evidence.
ok(has(run(predRow(), [srcRow({ availabilitySource: "fetched_at" })]), "retrosheet_discipline_not_verified_as_of"), "non-verified_as_of rejected");

// 5. wrong entityType vs payload actorType (payload is batter; entityType pitcher).
ok(has(run(predRow(), [srcRow({ entityType: "pitcher" })]), "retrosheet_discipline_entity_actor_mismatch"), "entityType/actor mismatch rejected");
// batter-actor source must be for THIS batter.
ok(has(run(predRow(), [srcRow({ entityId: "someone_else" })]), "retrosheet_discipline_batter_mismatch"), "wrong batter id rejected");
// schemaVersion must match feature version.
ok(has(run(predRow(), [srcRow({ schemaVersion: "plate_hr_v2_features_v2" })]), "retrosheet_discipline_schema_version_mismatch"), "schema/version mismatch rejected");

// 8. Retrosheet evidence attached to V1/V2.
ok(has(run(predRow({ featureVersion: "plate_hr_v2_features_v2" }), [srcRow({ schemaVersion: "plate_hr_v2_features_v2" })]), "retrosheet_discipline_on_non_v3"), "retrosheet evidence on V2 rejected");
ok(has(run(predRow({ featureVersion: "plate_hr_v2_features_v1" }), [srcRow({ schemaVersion: "plate_hr_v2_features_v1" })]), "retrosheet_discipline_on_non_v3"), "retrosheet evidence on V1 rejected");

// positive control: a clean V3 retrosheet source raises NO retrosheet_discipline_* reason.
{ const reasons = run(predRow(), [srcRow()]); ok(!reasons.some((r) => r.startsWith("retrosheet_discipline_")), `clean retrosheet source raises no retrosheet_discipline_* reason (got: ${reasons.filter((r) => r.startsWith("retrosheet_discipline_")).join("|")})`); }

// 11. V3 recentContactForm without valid contact_events evidence remains unreadable.
function v3ProjectionWithNonNeutralRecentForm(): Record<string, unknown> {
  const pf = () => nulls("usageShare", "batterXslg", "batterWhiffPct", "batterSampleSwings", "batterDamageBbeSample", "batterWhiffSwingSample");
  return {
    featureVersion: PLATE_HR_V2_FEATURES_V3,
    batterPower: withExtra(nulls("xISO", "xSLG", "xwOBAcon", "barrelRatePct", "hardHitRatePct", "exitVelocity", "maxEV", "flyBallPct", "hrFBRatioPct", "pullRatePct", "sweetSpotPct", "hrPerPaSeason", "paSample")),
    batTracking: withExtra(nulls("avgBatSpeed", "fastSwingRatePct", "avgSwingLength", "avgAttackAngle", "idealAttackAngleRatePct", "attackAngleStdDev", "avgSwingPathTilt", "squaredUpPerSwingPct", "blastPerSwingPct", "swingSample")),
    pitcherVulnerability: withExtra({ pitcherKnown: false, batterHand: null, pitcherThrows: null, ...nulls("hrPer9VsHand", "hrPer9Overall", "barrelAllowedPct", "hardHitAllowedPct", "flyBallAllowedPct", "bfSample") }),
    pitchType: { fastball: pf(), breaking: pf(), offspeed: pf(), extra: {} },
    parkWeatherSpray: withExtra({ ...nulls("parkHrFactor", "parkHrFactorHand"), isIndoors: false, weatherAvailable: false, temperatureF: null, windSpeedMph: null, windDirection: null, ...nulls("batterPullAirShare", "pullFenceDistanceFt", "pullFenceHeightFt", "avgFenceDistanceFt", "avgFenceHeightFt", "avgHrDistanceFt") }),
    lineupOpportunity: withExtra({ battingOrderSlot: null, teamImpliedRuns: null, obpAhead: null, lineupConfirmed: false }),
    starterBullpen: withExtra({ starterConfirmed: false, ...nulls("projectedPaVsStarter", "projectedPaVsBullpen", "bullpenHrPer9", "bullpenBarrelAllowedPct") }),
    availability: withExtra({ confirmedActive: null, lateScratchRisk: null, restDayRisk: null, platoonSubRisk: null }),
    contactOpportunity: withExtra({ chaseRatePct: null, zoneContactRatePct: null, ...nulls("kRatePct", "bbRatePct", "whiffRatePct", "contactRatePct", "foulStrikeRatePct", "firstPitchStrikeRatePct", "twoStrikeSurvivalRatePct", "inPlayRatePct", "batterPa", "codedPitchPa", "pitchSequenceCoverage", "kRatePctVsL", "kRatePctVsR", "bbRatePctVsL", "bbRatePctVsR", "contactRatePctVsL", "contactRatePctVsR", "whiffRatePctVsL", "whiffRatePctVsR", "paVsL", "paVsR") }),
    // NON-neutral recent-contact form (recentFormEv populated) with NO contact_events source.
    recentContactForm: withExtra({ recentFormEv: 100, ...nulls("recentFormEv90", "recentFormAirBallPct", "recentFormBarrelPct", "recentFormPulledAirShare", "recentFormXHrPerContact", "effectiveBbe", "last15Bbe", "reliabilityWeight") }),
    pitcherDiscipline: withExtra({ pitcherKnown: false, batterHand: null, pitcherThrows: null, ...nulls("pitcherKRatePct", "pitcherBbRatePct", "pitcherWhiffRatePct", "pitcherCalledStrikeRatePct", "pitcherFirstPitchStrikeRatePct", "pitcherKRatePctVsHand", "pitcherBbRatePctVsHand", "pitcherBf", "pitcherBfVsHand") }),
    dataQuality: { savantQuality: "missing", venueResolved: false, pitcherHandResolved: false, batterPowerFullyAvailable: false, missingInputs: [], overallQuality: "missing" },
    slateBaselineGameHrProbability: null,
  };
}
{
  const reasons = run(predRow({ derivedFeatures: v3ProjectionWithNonNeutralRecentForm(), sourceSnapshotIds: [] }), []);
  ok(!has(reasons, "derived_projection:"), `V3 authorized projection is valid (no projection error; got: ${reasons.filter((r) => r.startsWith("derived_projection")).join("|")})`);
  ok(has(reasons, "contact_events_missing"), "V3 non-neutral recentContactForm with no contact_events => unreadable (contact_events_missing)");
}

console.log(`retrosheetDisciplineReadIntegrity.test: ${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL:", f);
process.exit(fails.length ? 1 : 0);
