// Pre-Game Power Radar — v2 SHADOW end-to-end model + ranking invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/math/modelAndRank.test.ts

import { runPregameMathModel } from "./mathDiagnostics";
import {
  confidenceScore, probabilityScore, rawSetupScore, recommendTier,
} from "./rankPregameCandidatesV2";
import { MIN_HR_PER_PA, MAX_HR_PER_PA } from "./buildPregameHrPerPa";
import type { PregameMathInputs } from "./mathTypes";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function makeInputs(over: Partial<PregameMathInputs> = {}): PregameMathInputs {
  return {
    playerId: "p1",
    gameId: "g1",
    batterHand: "R",
    batterPower: {
      xISO: 0.24, xSLG: 0.55, xwOBAcon: 0.43, barrelRatePct: 15, hardHitRatePct: 50,
      exitVelocity: 92, maxEV: 115, flyBallPct: 42, hrFBRatioPct: 24, pullRatePct: 48,
      sweetSpotPct: 36, hrPerPaSeason: 0.06, paSample: 600,
    },
    batTracking: {
      avgBatSpeed: 75, fastSwingRatePct: 40, avgSwingLength: 7.6, squaredUpPerSwingPct: 30,
      blastPerSwingPct: 18, swingSample: 300,
    },
    pitcherVulnerability: {
      pitcherKnown: true, batterHand: "R", pitcherThrows: "L", hrPer9VsHand: 1.9,
      hrPer9Overall: 1.7, barrelAllowedPct: 11, hardHitAllowedPct: 44, flyBallAllowedPct: 42, bfSample: 400,
    },
    pitchType: {
      families: [
        { family: "fastball", usageShare: 0.6, batterXslg: 0.6, batterWhiffPct: 16, batterSample: 300 },
        { family: "breaking", usageShare: 0.3, batterXslg: 0.36, batterWhiffPct: 30, batterSample: 200 },
        { family: "offspeed", usageShare: 0.1, batterXslg: 0.34, batterWhiffPct: 28, batterSample: 80 },
      ],
    },
    zoneLocation: {
      batterHeartXslg: 0.58, batterElevatedFbXslg: 0.52, batterLowBreakingXslg: 0.3,
      pitcherHeartRate: 0.7, pitcherMiddleMiddleRate: 0.4, pitcherHangerRate: 0.2,
    },
    parkWeatherSpray: {
      parkHrFactor: 1.2, parkHrFactorHand: 1.25, isIndoors: false, weatherAvailable: true,
      temperatureF: 85, windSpeedMph: 12, windDirection: "out", batterPullAirShare: 0.7,
    },
    lineupOpportunity: { battingOrderSlot: 3, teamImpliedRuns: 5.2, obpAhead: 0.35, lineupConfirmed: true },
    starterBullpen: {
      starterConfirmed: true, projectedPaVsStarter: 3, projectedPaVsBullpen: 1.2,
      bullpenHrPer9: 1.4, bullpenBarrelAllowedPct: 9,
    },
    market: { hrOddsAvailable: false, impliedHrProbability: null, noVigImpliedHrProbability: null },
    availability: { confirmedActive: true, lateScratchRisk: false, restDayRisk: false, platoonSubRisk: false },
    slateBaselineGameHrProbability: 0.09,
    ...over,
  };
}

// ── Full model: bounded, structured output ────────────────────────────────────
const elite = runPregameMathModel(makeInputs());
ok(elite.calibratedGameHrProbability! >= 0 && elite.calibratedGameHrProbability! <= 1, "game prob bounded [0,1]");
ok(elite.matchupAdjustedHrPerPa! >= MIN_HR_PER_PA && elite.matchupAdjustedHrPerPa! <= MAX_HR_PER_PA,
  "per-PA HR clamped to [MIN,MAX]");
ok(Math.abs(Object.values(elite.paDistribution).reduce((a, b) => a + b, 0) - 1) < 1e-9, "PA dist sums to 1");
ok(elite.candidateRankScore100 >= 0 && elite.candidateRankScore100 <= 100, "rank score 0-100");
ok(elite.drivers.length > 0, "elite setup yields drivers");

// ── Elite setup beats weak setup on probability + rank ────────────────────────
const weak = runPregameMathModel(makeInputs({
  batterPower: {
    xISO: 0.09, xSLG: 0.31, xwOBAcon: 0.30, barrelRatePct: 2, hardHitRatePct: 26,
    exitVelocity: 85, maxEV: 101, flyBallPct: 24, hrFBRatioPct: 4, pullRatePct: 32,
    sweetSpotPct: 27, hrPerPaSeason: 0.012, paSample: 600,
  },
  pitcherVulnerability: {
    pitcherKnown: true, batterHand: "R", pitcherThrows: "L", hrPer9VsHand: 0.7,
    hrPer9Overall: 0.8, barrelAllowedPct: 4, hardHitAllowedPct: 33, flyBallAllowedPct: 30, bfSample: 400,
  },
  parkWeatherSpray: {
    parkHrFactor: 0.85, parkHrFactorHand: 0.83, isIndoors: false, weatherAvailable: true,
    temperatureF: 55, windSpeedMph: 12, windDirection: "in", batterPullAirShare: 0.3,
  },
}));
ok(elite.calibratedGameHrProbability! > weak.calibratedGameHrProbability!, "elite game prob > weak");
ok(elite.candidateRankScore100 > weak.candidateRankScore100, "elite rank > weak rank");
ok(elite.matchupAdjustedHrPerPa! > weak.matchupAdjustedHrPerPa!, "elite per-PA > weak per-PA");

// ── Tier monotonicity: elite tier ranks above weak tier ───────────────────────
const order = { suppressed: 0, neutral: 1, watch: 2, strong: 3, elite: 4 };
ok(order[elite.recommendedTier] >= order[weak.recommendedTier], "elite tier ≥ weak tier");

// ── Lift vs slate baseline computed ───────────────────────────────────────────
ok(elite.hrLiftVsSlateBaseline != null && elite.hrLiftVsSlateBaseline > 1, "elite lift vs slate > 1");
ok(elite.slateBaselineGameHrProbability === 0.09, "slate baseline echoed");

// ── Confidence falls with missing lineup / weather / sample ───────────────────
const missing = runPregameMathModel(makeInputs({
  batterPower: {
    xISO: null, xSLG: null, xwOBAcon: null, barrelRatePct: null, hardHitRatePct: null,
    exitVelocity: null, maxEV: null, flyBallPct: null, hrFBRatioPct: null, pullRatePct: null,
    sweetSpotPct: null, hrPerPaSeason: null, paSample: null,
  },
  pitcherVulnerability: {
    pitcherKnown: false, batterHand: "R", pitcherThrows: null, hrPer9VsHand: null,
    hrPer9Overall: null, barrelAllowedPct: null, hardHitAllowedPct: null, flyBallAllowedPct: null, bfSample: null,
  },
  parkWeatherSpray: {
    parkHrFactor: null, parkHrFactorHand: null, isIndoors: false, weatherAvailable: false,
    temperatureF: null, windSpeedMph: null, windDirection: null, batterPullAirShare: null,
  },
  lineupOpportunity: { battingOrderSlot: null, teamImpliedRuns: null, obpAhead: null, lineupConfirmed: false },
}));
ok(missing.confidenceScore100 < elite.confidenceScore100, "missing data → lower confidence");
ok(missing.missingDataWarnings.includes("missing_batter_power"), "warns missing batter power");
ok(missing.missingDataWarnings.includes("lineup_not_confirmed"), "warns lineup not confirmed");
ok(missing.statCoverage.batterPower === "missing", "coverage marks batter power missing");
ok(missing.statCoverage.marketConfirmation === "not_available", "coverage marks market not_available (no source)");
// Missing core families collapse toward neutral/league baseline.
ok(Math.abs(missing.matchupAdjustedHrPerPa! - 0.0335) < 0.02, "missing data → near league baseline per-PA");

// ── Suppressor forces suppressed tier regardless of setup ─────────────────────
const scratched = runPregameMathModel(makeInputs({
  availability: { confirmedActive: false, lateScratchRisk: true, restDayRisk: false, platoonSubRisk: false },
}));
ok(scratched.recommendedTier === "suppressed", "confirmed-not-active → suppressed tier");
ok(scratched.suppressors.includes("not_confirmed_active"), "scratch suppressor surfaced");

// ── Suppressor can never RAISE the rate via prior shrinkage (zero coverage) ───
function zeroCoverageInputs(over: Partial<PregameMathInputs> = {}): PregameMathInputs {
  return makeInputs({
    batterPower: {
      xISO: null, xSLG: null, xwOBAcon: null, barrelRatePct: null, hardHitRatePct: null,
      exitVelocity: null, maxEV: null, flyBallPct: null, hrFBRatioPct: null, pullRatePct: null,
      sweetSpotPct: null, hrPerPaSeason: null, paSample: null,
    },
    pitcherVulnerability: {
      pitcherKnown: false, batterHand: "R", pitcherThrows: null, hrPer9VsHand: null,
      hrPer9Overall: null, barrelAllowedPct: null, hardHitAllowedPct: null, flyBallAllowedPct: null, bfSample: null,
    },
    ...over,
  });
}
const zcNoSup = runPregameMathModel(zeroCoverageInputs());
const zcSup = runPregameMathModel(zeroCoverageInputs({
  availability: { confirmedActive: false, lateScratchRisk: false, restDayRisk: false, platoonSubRisk: false },
}));
ok(zcSup.matchupAdjustedHrPerPa! < zcNoSup.matchupAdjustedHrPerPa!, "suppressor lowers per-PA (zero coverage)");
ok(zcSup.calibratedGameHrProbability! < zcNoSup.calibratedGameHrProbability!,
  "suppressor lowers game prob even after shrinkage (never raised back to league)");

// ── Market alone must NOT mint a watch tier (no core data → low confidence) ────
const marketOnly = runPregameMathModel(zeroCoverageInputs({
  market: { hrOddsAvailable: true, impliedHrProbability: 0.18, noVigImpliedHrProbability: 0.16 },
  availability: { confirmedActive: true, lateScratchRisk: false, restDayRisk: false, platoonSubRisk: false },
}));
ok(marketOnly.recommendedTier !== "watch", "market-only row is not 'watch'");
ok(marketOnly.confidenceScore100 < 30, "market-only row has sub-floor confidence");

// ── Calibration is the documented identity passthrough ────────────────────────
ok((elite.calibrationDiagnostics as any).method === "identity_uncalibrated", "calibration reports identity_uncalibrated");

// ── No leakage warnings on a clean pregame row ────────────────────────────────
ok(elite.leakageWarnings.length === 0, "clean inputs → no leakage warnings");

// ── Pure rank helpers ─────────────────────────────────────────────────────────
ok(rawSetupScore(0) === 50, "rawSetupScore neutral lift → 50");
ok(rawSetupScore(1.5) === 100 && rawSetupScore(-1.5) === 0, "rawSetupScore bounds");
ok(probabilityScore(0.15) === 50, "probabilityScore midpoint (0.15→50)");
ok(probabilityScore(null) === 0, "probabilityScore null → 0");
ok(confidenceScore(0, 0, 1) < confidenceScore(1, 300, 1), "confidence rises with coverage+sample");
ok(confidenceScore(1, 300, 0.5) < confidenceScore(1, 300, 1), "suppressor confidence factor lowers confidence");
ok(recommendTier({ calibratedGameHrProbability: 0.11, confidenceScore100: 75, rawSetupScore100: 80, hasMajorSuppressor: false }) === "elite", "tier elite gate");
ok(recommendTier({ calibratedGameHrProbability: 0.08, confidenceScore100: 65, rawSetupScore100: 70, hasMajorSuppressor: false }) === "strong", "tier strong gate");
ok(recommendTier({ calibratedGameHrProbability: 0.02, confidenceScore100: 80, rawSetupScore100: 80, hasMajorSuppressor: false }) === "suppressed", "very low prob → suppressed");
ok(recommendTier({ calibratedGameHrProbability: 0.06, confidenceScore100: 45, rawSetupScore100: 60, hasMajorSuppressor: false }) === "watch", "data-backed setup → watch");
ok(recommendTier({ calibratedGameHrProbability: 0.16, confidenceScore100: 0, rawSetupScore100: 60, hasMajorSuppressor: false }) === "neutral", "high setup but zero confidence → neutral, not watch");
ok(recommendTier({ calibratedGameHrProbability: 0.11, confidenceScore100: 90, rawSetupScore100: 90, hasMajorSuppressor: true }) === "suppressed", "major suppressor overrides → suppressed");

console.log(`\nmodelAndRank.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
