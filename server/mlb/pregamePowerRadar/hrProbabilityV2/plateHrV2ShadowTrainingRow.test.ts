// Plate HR Probability V2 — training-row bridge invariants (PR 2).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2ShadowTrainingRow.test.ts

import {
  PLATE_HR_V2_SHADOW_TERM_KEYS,
  derivedFeatureVectorToPregameMathInputs,
  buildShadowTermsFromDerivedFeatures,
  buildShadowHrTrainingRow,
} from "./plateHrV2ShadowTrainingRow";
import { PLATE_HR_V2_FEATURES_V1, type PlateHrV2DerivedFeatureVectorV1 } from "./plateHrV2FeatureContract";
import { scorePitchTypeInteraction } from "../math/scorePitchTypeInteraction";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const emptyExtra = { extra: {} };
const family = { usageShare: null, batterXslg: null, batterWhiffPct: null, batterSampleSwings: null };

function richFixture(): PlateHrV2DerivedFeatureVectorV1 {
  return {
    featureVersion: PLATE_HR_V2_FEATURES_V1,
    batterPower: {
      xISO: 0.18, xSLG: 0.42, xwOBAcon: 0.37, barrelRatePct: 8.5, hardHitRatePct: 40,
      exitVelocity: 90, maxEV: 108, flyBallPct: 35, hrFBRatioPct: 15, pullRatePct: 42,
      sweetSpotPct: 33, hrPerPaSeason: null, paSample: 210, ...emptyExtra,
    },
    batTracking: {
      avgBatSpeed: 76, fastSwingRatePct: 32, avgSwingLength: 7.2, avgAttackAngle: 12,
      idealAttackAngleRatePct: 28, attackAngleStdDev: 9, avgSwingPathTilt: 22,
      squaredUpPerSwingPct: 24, blastPerSwingPct: 8, swingSample: 300, ...emptyExtra,
    },
    pitcherVulnerability: {
      pitcherKnown: true, batterHand: "R", pitcherThrows: "L", hrPer9VsHand: 1.2,
      hrPer9Overall: 1.1, barrelAllowedPct: 7.5, hardHitAllowedPct: 38, flyBallAllowedPct: 34,
      bfSample: 400, ...emptyExtra,
    },
    pitchType: {
      fastball: { usageShare: 0.55, batterXslg: 0.48, batterWhiffPct: 18, batterSampleSwings: 120 },
      breaking: { usageShare: 0.30, batterXslg: 0.32, batterWhiffPct: 30, batterSampleSwings: 60 },
      offspeed: { usageShare: 0.15, batterXslg: 0.40, batterWhiffPct: 22, batterSampleSwings: 25 },
      ...emptyExtra,
    },
    zoneLocation: {
      batterHeartXslg: 0.55, batterElevatedFbXslg: 0.50, batterLowBreakingXslg: 0.30,
      pitcherHeartRate: 0.20, pitcherMiddleMiddleRate: 0.12, pitcherHangerRate: 0.10, ...emptyExtra,
    },
    parkWeatherSpray: {
      parkHrFactor: 1.05, parkHrFactorHand: 1.1, isIndoors: false, weatherAvailable: true,
      temperatureF: 75, windSpeedMph: 8, windDirection: "out", batterPullAirShare: 0.4,
      pullFenceDistanceFt: 330, pullFenceHeightFt: 8, avgFenceDistanceFt: 375,
      avgFenceHeightFt: 9, avgHrDistanceFt: 395, ...emptyExtra,
    },
    lineupOpportunity: { battingOrderSlot: 3, teamImpliedRuns: 4.6, obpAhead: 0.34, lineupConfirmed: true, ...emptyExtra },
    starterBullpen: {
      starterConfirmed: true, projectedPaVsStarter: 2.5, projectedPaVsBullpen: 1.5,
      bullpenHrPer9: 1.4, bullpenBarrelAllowedPct: 9, ...emptyExtra,
    },
    market: { hrOddsAvailable: true, impliedHrProbability: 0.15, noVigImpliedHrProbability: 0.14, ...emptyExtra },
    availability: { confirmedActive: true, lateScratchRisk: false, restDayRisk: true, platoonSubRisk: false, ...emptyExtra },
    contactOpportunity: {
      kRatePct: null, bbRatePct: null, whiffRatePct: null, contactRatePct: null,
      zoneContactRatePct: null, chaseRatePct: null, ...emptyExtra,
    },
    dataQuality: {
      savantQuality: "full", venueResolved: true, pitcherHandResolved: true,
      batterPowerFullyAvailable: true, missingInputs: [], overallQuality: "full",
    },
    slateBaselineGameHrProbability: 0.12,
  };
}

function allNullFixture(): PlateHrV2DerivedFeatureVectorV1 {
  return {
    featureVersion: PLATE_HR_V2_FEATURES_V1,
    batterPower: {
      xISO: null, xSLG: null, xwOBAcon: null, barrelRatePct: null, hardHitRatePct: null,
      exitVelocity: null, maxEV: null, flyBallPct: null, hrFBRatioPct: null, pullRatePct: null,
      sweetSpotPct: null, hrPerPaSeason: null, paSample: null, ...emptyExtra,
    },
    batTracking: {
      avgBatSpeed: null, fastSwingRatePct: null, avgSwingLength: null, avgAttackAngle: null,
      idealAttackAngleRatePct: null, attackAngleStdDev: null, avgSwingPathTilt: null,
      squaredUpPerSwingPct: null, blastPerSwingPct: null, swingSample: null, ...emptyExtra,
    },
    pitcherVulnerability: {
      pitcherKnown: false, batterHand: null, pitcherThrows: null, hrPer9VsHand: null,
      hrPer9Overall: null, barrelAllowedPct: null, hardHitAllowedPct: null, flyBallAllowedPct: null,
      bfSample: null, ...emptyExtra,
    },
    pitchType: { fastball: family, breaking: family, offspeed: family, ...emptyExtra },
    zoneLocation: {
      batterHeartXslg: null, batterElevatedFbXslg: null, batterLowBreakingXslg: null,
      pitcherHeartRate: null, pitcherMiddleMiddleRate: null, pitcherHangerRate: null, ...emptyExtra,
    },
    parkWeatherSpray: {
      parkHrFactor: null, parkHrFactorHand: null, isIndoors: false, weatherAvailable: false,
      temperatureF: null, windSpeedMph: null, windDirection: null, batterPullAirShare: null,
      pullFenceDistanceFt: null, pullFenceHeightFt: null, avgFenceDistanceFt: null,
      avgFenceHeightFt: null, avgHrDistanceFt: null, ...emptyExtra,
    },
    lineupOpportunity: { battingOrderSlot: null, teamImpliedRuns: null, obpAhead: null, lineupConfirmed: false, ...emptyExtra },
    starterBullpen: {
      starterConfirmed: false, projectedPaVsStarter: null, projectedPaVsBullpen: null,
      bullpenHrPer9: null, bullpenBarrelAllowedPct: null, ...emptyExtra,
    },
    market: { hrOddsAvailable: false, impliedHrProbability: null, noVigImpliedHrProbability: null, ...emptyExtra },
    availability: { confirmedActive: null, lateScratchRisk: null, restDayRisk: null, platoonSubRisk: null, ...emptyExtra },
    contactOpportunity: {
      kRatePct: null, bbRatePct: null, whiffRatePct: null, contactRatePct: null,
      zoneContactRatePct: null, chaseRatePct: null, ...emptyExtra,
    },
    dataQuality: {
      savantQuality: "missing", venueResolved: false, pitcherHandResolved: false,
      batterPowerFullyAvailable: false, missingInputs: ["batterPower"], overallQuality: "missing",
    },
    slateBaselineGameHrProbability: null,
  };
}

const IDS = { playerId: "p1", gameId: "g1" };

// ── 1. derivedFeatureVectorToPregameMathInputs shape ────────────────────────
{
  const inputs = derivedFeatureVectorToPregameMathInputs(richFixture(), IDS);
  ok(inputs.playerId === "p1" && inputs.gameId === "g1", "ids pass through");
  ok(inputs.batterHand === "R", "batterHand recovered from pitcherVulnerability.batterHand");
  ok(inputs.pitchType.families.length === 3, "pitchType reprojected to 3-element families array");
  const fb = inputs.pitchType.families.find((f) => f.family === "fastball");
  ok(fb?.batterSample === 120, "batterSampleSwings renamed to batterSample on reprojection");
  ok((inputs.batterPower as any).extra === undefined, "extra dropped from batterPower");
  ok((inputs.availability as any).extra === undefined, "extra dropped from availability");
}

// ── 2. pitchType round-trip matches math/'s own scorer on equivalent native input ──
{
  const inputs = derivedFeatureVectorToPregameMathInputs(richFixture(), IDS);
  const viaBridge = scorePitchTypeInteraction(inputs.pitchType);
  const nativeEquivalent = scorePitchTypeInteraction({
    families: [
      { family: "fastball", usageShare: 0.55, batterXslg: 0.48, batterWhiffPct: 18, batterSample: 120 },
      { family: "breaking", usageShare: 0.30, batterXslg: 0.32, batterWhiffPct: 30, batterSample: 60 },
      { family: "offspeed", usageShare: 0.15, batterXslg: 0.40, batterWhiffPct: 22, batterSample: 25 },
    ],
  });
  ok(viaBridge.logOdds === nativeEquivalent.logOdds, "pitchType reprojection produces byte-identical logOdds to the native shape");
  ok(viaBridge.available === true, "pitchType is available with rich data");
}

// ── 3. buildShadowTermsFromDerivedFeatures: rich fixture ────────────────────
{
  const terms = buildShadowTermsFromDerivedFeatures(richFixture(), IDS);
  const keys = Object.keys(terms).sort();
  ok(
    keys.length === PLATE_HR_V2_SHADOW_TERM_KEYS.length &&
      PLATE_HR_V2_SHADOW_TERM_KEYS.every((k) => k in terms),
    "terms dict has exactly the 10 expected keys",
  );
  ok(typeof terms.batterPower === "number" && terms.batterPower !== 0, "batterPower is a nonzero number with rich data");
  ok(typeof terms.marketConfirmation === "number" && terms.marketConfirmation !== 0, "marketConfirmation is nonzero when hrOddsAvailable + implied prob are set");
  ok(typeof terms.starterBullpenPath === "number" && terms.starterBullpenPath !== 0, "starterBullpenPath is nonzero with bullpen data");
  // restDayRisk:true alone contributes a 0.25 penalty (SUPPRESSOR_MAX_PENALTY=0.8, no other suppressor flags set) — sign-flipped.
  ok(terms.availabilitySuppressors === -0.25, "availabilitySuppressors is sign-flipped (negative) when a real suppressor fires");
  const nonZeroCount = Object.values(terms).filter((v) => typeof v === "number" && v !== 0).length;
  ok(nonZeroCount >= 8, `at least 8 of 10 terms are nonzero with rich, fully-populated data (got ${nonZeroCount})`);
}

// ── 4. buildShadowTermsFromDerivedFeatures: all-null fixture degrades gracefully ──
{
  const terms = buildShadowTermsFromDerivedFeatures(allNullFixture(), IDS);
  const keys = Object.keys(terms).sort();
  ok(
    keys.length === PLATE_HR_V2_SHADOW_TERM_KEYS.length &&
      PLATE_HR_V2_SHADOW_TERM_KEYS.every((k) => k in terms),
    "terms dict still has all 10 keys on all-null input",
  );
  ok(
    Object.values(terms).every((v) => v === 0),
    "every term is exactly 0 when every leaf is null (no fabricated signal)",
  );
}

// ── 5. buildShadowHrTrainingRow: homered mapping + frozenAt passthrough ─────
{
  const winRow = buildShadowHrTrainingRow({
    derivedFeatures: richFixture(), playerId: "p1", gameId: "g1",
    frozenAt: "2026-07-20T23:10:00.000Z", hitHrToday: true,
  });
  ok(winRow.homered === 1, "hitHrToday:true maps to homered:1");
  ok(winRow.frozenAt === "2026-07-20T23:10:00.000Z", "frozenAt passes through verbatim");

  const lossRow = buildShadowHrTrainingRow({
    derivedFeatures: richFixture(), playerId: "p1", gameId: "g1",
    frozenAt: "2026-07-20T23:10:00.000Z", hitHrToday: false,
  });
  ok(lossRow.homered === 0, "hitHrToday:false maps to homered:0");
}

// ── 6. Never throws on either fixture, or on a mixed partial fixture ────────
{
  let threw = false;
  try {
    buildShadowHrTrainingRow({ derivedFeatures: richFixture(), playerId: "", gameId: "", frozenAt: "not-a-date", hitHrToday: false });
    buildShadowHrTrainingRow({ derivedFeatures: allNullFixture(), playerId: "p2", gameId: "g2", frozenAt: "2026-01-01T00:00:00.000Z", hitHrToday: true });
  } catch {
    threw = true;
  }
  ok(!threw, "buildShadowHrTrainingRow never throws, even on malformed ids/timestamps");
}

console.log(`\nplateHrV2ShadowTrainingRow.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
