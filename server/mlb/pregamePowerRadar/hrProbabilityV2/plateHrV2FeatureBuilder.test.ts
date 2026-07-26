// Plate HR Probability V2 — as-of-date feature builder invariants (PR 1).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2FeatureBuilder.test.ts

import { assemblePlateHrV2FeatureSnapshot, type PlateHrV2FeatureBuilderInput } from "./plateHrV2FeatureBuilder";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const EMPTY_BATTER_POWER = {
  xISO: null, xSLG: null, xwOBAcon: null, barrelRatePct: null, hardHitRatePct: null,
  exitVelocity: null, maxEV: null, flyBallPct: null, hrFBRatioPct: null, pullRatePct: null,
  sweetSpotPct: null, hrPerPaSeason: null, paSample: null,
};
const EMPTY_BAT_TRACKING = {
  avgBatSpeed: null, fastSwingRatePct: null, avgSwingLength: null, squaredUpPerSwingPct: null,
  blastPerSwingPct: null, swingSample: null,
};
const EMPTY_PITCHER_VULN = {
  pitcherKnown: false, batterHand: null, pitcherThrows: null, hrPer9VsHand: null,
  hrPer9Overall: null, barrelAllowedPct: null, hardHitAllowedPct: null, flyBallAllowedPct: null, bfSample: null,
};
const EMPTY_ZONE = {
  batterHeartXslg: null, batterElevatedFbXslg: null, batterLowBreakingXslg: null,
  pitcherHeartRate: null, pitcherMiddleMiddleRate: null, pitcherHangerRate: null,
};
const EMPTY_PARK_WEATHER = {
  parkHrFactor: null, parkHrFactorHand: null, isIndoors: false, weatherAvailable: false,
  temperatureF: null, windSpeedMph: null, windDirection: null, batterPullAirShare: null,
};
const EMPTY_LINEUP = { battingOrderSlot: null, teamImpliedRuns: null, obpAhead: null, lineupConfirmed: false };
const EMPTY_STARTER_BULLPEN = { starterConfirmed: false, projectedPaVsStarter: null, projectedPaVsBullpen: null, bullpenHrPer9: null, bullpenBarrelAllowedPct: null };
const EMPTY_MARKET = { hrOddsAvailable: false, impliedHrProbability: null, noVigImpliedHrProbability: null };
const EMPTY_AVAILABILITY = { confirmedActive: null, lateScratchRisk: null, restDayRisk: null, platoonSubRisk: null };
const EMPTY_CONTACT_OPP = { kRatePct: null, bbRatePct: null, whiffRatePct: null, contactRatePct: null, zoneContactRatePct: null, chaseRatePct: null };

function baseInput(overrides: Partial<PlateHrV2FeatureBuilderInput> = {}): PlateHrV2FeatureBuilderInput {
  return {
    asOfMs: Date.parse("2026-07-26T10:00:00.000Z"),
    firstPitchAtMs: Date.parse("2026-07-26T19:00:00.000Z"),
    lineupConfirmedAtMs: null,
    starterConfirmed: false,
    sessionDate: "2026-07-26",
    gameId: "game-1",
    batterId: "batter-1",
    pitcherId: null,
    batterHand: "R",
    sufficientStatsRef: null,
    batterPower: EMPTY_BATTER_POWER,
    batTracking: EMPTY_BAT_TRACKING,
    pitcherVulnerability: EMPTY_PITCHER_VULN,
    pitchType: { families: [] },
    zoneLocation: EMPTY_ZONE,
    parkWeatherSpray: EMPTY_PARK_WEATHER,
    lineupOpportunity: EMPTY_LINEUP,
    starterBullpen: EMPTY_STARTER_BULLPEN,
    market: EMPTY_MARKET,
    availability: EMPTY_AVAILABILITY,
    contactOpportunity: EMPTY_CONTACT_OPP,
    slateBaselineGameHrProbability: null,
    savantQuality: "missing",
    venueResolved: false,
    pitcherHandResolved: false,
    batterPowerFullyAvailable: false,
    ...overrides,
  };
}

// ── 1. Total-function sweep: never throws on an all-null/all-false/empty input ──
{
  let threw = false;
  let result: ReturnType<typeof assemblePlateHrV2FeatureSnapshot> | null = null;
  try {
    result = assemblePlateHrV2FeatureSnapshot(baseInput());
  } catch {
    threw = true;
  }
  ok(!threw, "assemblePlateHrV2FeatureSnapshot never throws on an all-null/all-false/empty-array input");
  ok(result != null && result.derivedFeatures.featureVersion === "plate_hr_v2_features_v1", "still produces a valid-shaped result on empty input");
}

// ── 2. Builder boundary: asOf before first pitch ────────────────────────────
{
  const result = assemblePlateHrV2FeatureSnapshot(baseInput({
    asOfMs: Date.parse("2026-07-26T10:00:00.000Z"),
    firstPitchAtMs: Date.parse("2026-07-26T19:00:00.000Z"),
  }));
  ok(result.boundaryOk === true, "asOfMs strictly before firstPitchAtMs -> boundaryOk true");
  ok(result.leakageWarnings.length === 0, "no leakage warnings when the boundary holds and no live-only feature names are present");
}

// ── 3. Builder boundary: asOf after first pitch ─────────────────────────────
{
  const result = assemblePlateHrV2FeatureSnapshot(baseInput({
    asOfMs: Date.parse("2026-07-26T20:00:00.000Z"),
    firstPitchAtMs: Date.parse("2026-07-26T19:00:00.000Z"),
  }));
  ok(result.boundaryOk === false, "asOfMs strictly after firstPitchAtMs -> boundaryOk false");
  ok(result.leakageWarnings.includes("prediction_locked_after_first_pitch"), "a post-first-pitch capture is flagged with an explicit warning, not silently accepted");
}

// ── 4. Missing firstPitchAtMs degrades to a warning, not a throw ───────────
{
  const result = assemblePlateHrV2FeatureSnapshot(baseInput({ firstPitchAtMs: null }));
  ok(result.boundaryOk === false, "a null firstPitchAtMs cannot be proven pregame -> boundaryOk false, never assumed true");
  ok(result.leakageWarnings.some((w) => w.includes("first_pitch_timestamp")), "missing first-pitch timestamp produces an explicit warning");
}

// ── 5. Fully-populated input reports full availability and full data quality ──
{
  const result = assemblePlateHrV2FeatureSnapshot(baseInput({
    batterPower: { ...EMPTY_BATTER_POWER, xISO: 0.18, xSLG: 0.42, paSample: 200 },
    savantQuality: "full", venueResolved: true, pitcherHandResolved: true, batterPowerFullyAvailable: true,
  }));
  ok(result.availability.batterPower.xISO.present === true, "a populated leaf reports present:true in the availability vector");
  ok(result.availability.batterPower.hrPerPaSeason.present === false, "a null leaf reports present:false");
  ok(result.derivedFeatures.dataQuality.overallQuality === "full", "fully-available quality flags -> overallQuality full");
  ok(result.derivedFeatures.dataQuality.missingInputs.length === 0, "no missingInputs recorded when everything is available");
}

// ── 6. Degraded quality flags surface in missingInputs ──────────────────────
{
  const result = assemblePlateHrV2FeatureSnapshot(baseInput({ venueResolved: false }));
  ok(result.derivedFeatures.dataQuality.overallQuality !== "full", "an unresolved venue prevents overallQuality from reporting full");
  ok(result.derivedFeatures.dataQuality.missingInputs.includes("parkWeatherSpray.venue"), "unresolved venue is named in missingInputs, not silently dropped");
}

// ── 7. contactOpportunity stays fully null (PR1 contract slot only) ────────
{
  const result = assemblePlateHrV2FeatureSnapshot(baseInput());
  ok(
    Object.entries(result.derivedFeatures.contactOpportunity).every(([k, v]) => k === "extra" || v === null),
    "contactOpportunity is all-null in PR1 — no fabricated producer",
  );
}

console.log(`\nplateHrV2FeatureBuilder.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
