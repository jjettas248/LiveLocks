/**
 * HR engine consolidation (2026-07) — regression lock.
 *
 * Before this change, calculateHREdge() computed home_runs probability via
 * computeHRRatePerPA + computeHRDistribution + the generic 50-centered
 * calibrateDistributionProb(), whose Math.max(5, ...) floor collapsed nearly
 * every batter's calibrated probability to exactly 5.00 (HR occurrence rates
 * are naturally low, so raw probabilities routinely landed below the point
 * the floor kicks in). calculateHREdge now sources its probability from
 * computeHRConversionProbability() — the same engine that powers the HR
 * Radar alert engine — which has its own low-range calibration table.
 *
 * Covers:
 *   1. calculateHREdge no longer floors at a flat 5% — a genuinely weak
 *      batter profile calibrates BELOW 5, which was structurally impossible
 *      under the old formula.
 *   2. Different batter profiles produce differentiated (non-flat)
 *      probabilities.
 *   3. calculateHREdge's calibrated probability is the SAME engine's number
 *      as computeHRConversionProbability's hrOccurrenceProbability for the
 *      equivalent input ("one engine" — not two independently-computed
 *      numbers that can disagree).
 *   4. The Phase 1.5 home_runs probability ceiling (90) still binds.
 *   5. Non-HR markets (hits) are untouched — still use the generic,
 *      50-centered calibration path, isolated from the home_runs branch.
 *
 * Run: npx tsx server/mlb/hrEngineConsolidation.test.ts
 */

import { calculateHREdge, calculateHitsEdge } from "./markets";
import { computeHRConversionProbability, type HRConversionInput } from "./hrConversionModel";
import type { MLBPropInput } from "./types";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function makeMinimalMlbPropInput(overrides: Partial<MLBPropInput> = {}): MLBPropInput {
  return {
    playerId: "p1", playerName: "Test Batter", team: "TST", opponent: "OPP", gameId: "g1",
    market: "home_runs", bookLine: 0.5, overOdds: -120, underOdds: 100,
    seasonAvg: 0.260, plateAppearances: 400, atBats: 350, currentStatValue: 0,
    remainingPA: 2, remainingAB: 2, completedAB: 2, inning: 5, isTopInning: false,
    batterHand: "R",
    contactQuality: {
      exitVelocity: 90, launchAngle: 15, hitDistance: 320,
      hardHitRateSeason: 0.35, barrelRateProxySeason: 0.07,
      avgBatSpeed: 70, avgSwingLength: 7.2,
      priorABResults: [], xBA: 0.25, xSLG: 0.400,
    },
    pitcher: {
      pitchCount: 60, timesThrough: 2, era: 4.2, whip: 1.25, kPer9: 8.5, bbPer9: 3.0,
      managerLeashShort: false, isPitcherCollapsing: false, pitchMix: [], throws: "R",
    },
    lineup: {
      battingOrderSlot: 4, orderTurnoverProximity: 0.5,
      lineupSectionStrength: "neutral", hittersAheadOnBase: 0, pocketWeakness: null,
    },
    weatherPark: {
      parkFactor: 1.0, temperature: 72, windSpeed: 5, windDirection: "calm",
      humidity: 50, isIndoors: false, parkHistoryFactor: null,
    },
    bullpen: {
      bullpenEra: 4.0, bullpenUsageLastThreeDays: 40, isTopRelieverAvailable: true,
    },
    currentRuns: 4.5, leagueAvgRuns: 4.5,
    ...overrides,
  };
}

// A genuinely weak power profile: low barrel/hard-hit/xSLG, no HR trend, no
// pregame prior boost — should calibrate well below the old artificial floor.
const weakBatter = makeMinimalMlbPropInput({
  playerId: "weak1", playerName: "Weak Batter",
  contactQuality: {
    exitVelocity: 82, launchAngle: 8, hitDistance: 220,
    hardHitRateSeason: 0.18, barrelRateProxySeason: 0.02,
    avgBatSpeed: 64, avgSwingLength: 6.8,
    priorABResults: [], xBA: 0.22, xSLG: 0.320,
  },
  hrTrend: {
    abSinceLastHR: 80, hrRateLast7: 0, hrRateLast15: 0, hrRateLast30: 0.005,
    seasonTotalHR: 4, seasonTotalAB: 400,
  },
});

// An elite power profile: high barrel/hard-hit/xwOBA/xISO, hot HR trend.
const eliteBatter = makeMinimalMlbPropInput({
  playerId: "elite1", playerName: "Elite Batter",
  contactQuality: {
    exitVelocity: 97, launchAngle: 24, hitDistance: 410,
    hardHitRateSeason: 0.52, barrelRateProxySeason: 0.16,
    avgBatSpeed: 76, avgSwingLength: 7.4,
    priorABResults: [], xBA: 0.30, xSLG: 0.560,
    xwOBASeason: 0.400, xISOSeason: 0.260,
  },
  hrTrend: {
    abSinceLastHR: 3, hrRateLast7: 0.15, hrRateLast15: 0.12, hrRateLast30: 0.09,
    seasonTotalHR: 32, seasonTotalAB: 420,
  },
});

console.log("\n=== HR engine consolidation — one engine for home_runs ===\n");

const weakOutput = calculateHREdge(weakBatter);
const eliteOutput = calculateHREdge(eliteBatter);

assert(
  "weak batter calibrates BELOW the old artificial 5.00 floor",
  weakOutput.calibratedProbabilityOver < 5,
  `got ${weakOutput.calibratedProbabilityOver}`,
);
assert(
  "elite batter calibrates well ABOVE the weak batter (differentiated, not flat)",
  eliteOutput.calibratedProbabilityOver > weakOutput.calibratedProbabilityOver + 2,
  `elite=${eliteOutput.calibratedProbabilityOver} weak=${weakOutput.calibratedProbabilityOver}`,
);
assert(
  "Phase 1.5 home_runs ceiling (90) still binds",
  eliteOutput.calibratedProbabilityOver <= 90,
  `got ${eliteOutput.calibratedProbabilityOver}`,
);
assert(
  "calculateHREdge attaches the full HRConversionResult for downstream reuse",
  !!weakOutput.hrConversion && typeof weakOutput.hrConversion.hrOccurrenceProbability === "number",
);

// ── "One engine" consistency: calculateHREdge's own attached hrConversion
//    result IS the same computation as calling computeHRConversionProbability
//    directly on an equivalent input — not two independently-diverging paths.
const equivalentInput: HRConversionInput = {
  hrBuildScore: 0,
  factors: { contactClasses: [], hrShapedCount: 0, missedHrCount: 0, eliteHrCount: 0, qualifiedEVMean: null, maxDistance: null } as any,
  inning: eliteBatter.inning,
  isTopInning: eliteBatter.isTopInning,
  battingOrderSlot: eliteBatter.lineup.battingOrderSlot,
  currentRuns: eliteBatter.currentRuns ?? 4.5,
  leagueAvgRuns: eliteBatter.leagueAvgRuns ?? 4.5,
  pitchCount: eliteBatter.pitcher.pitchCount,
  timesThrough: eliteBatter.pitcher.timesThrough,
  isPitcherCollapsing: eliteBatter.pitcher.isPitcherCollapsing,
  era: eliteBatter.pitcher.era,
  parkFactor: eliteBatter.weatherPark.parkFactor,
  windDirection: eliteBatter.weatherPark.windDirection,
  windSpeed: eliteBatter.weatherPark.windSpeed,
  temperature: eliteBatter.weatherPark.temperature,
  humidity: eliteBatter.weatherPark.humidity,
  isIndoors: eliteBatter.weatherPark.isIndoors,
  batterHand: eliteBatter.batterHand,
  pitcherThrows: eliteBatter.pitcher.throws,
  seasonHRRate: (eliteBatter.hrTrend!.seasonTotalHR) / (eliteBatter.hrTrend!.seasonTotalAB),
  barrelRate: eliteBatter.contactQuality.barrelRateProxySeason,
  hardHitRate: eliteBatter.contactQuality.hardHitRateSeason,
  xSLG: eliteBatter.contactQuality.xSLG,
  hrRateLast7: eliteBatter.hrTrend!.hrRateLast7,
  hrRateLast15: eliteBatter.hrTrend!.hrRateLast15,
  hrRateLast30: eliteBatter.hrTrend!.hrRateLast30,
  xwOBA: eliteBatter.contactQuality.xwOBASeason,
  xISO: eliteBatter.contactQuality.xISOSeason,
};
const directResult = computeHRConversionProbability(equivalentInput);
assert(
  "calculateHREdge's calibrated probability equals computeHRConversionProbability's own result for equivalent input",
  Math.abs(eliteOutput.calibratedProbabilityOver / 100 - directResult.hrOccurrenceProbability) < 0.01,
  `edge=${eliteOutput.calibratedProbabilityOver / 100} direct=${directResult.hrOccurrenceProbability}`,
);

// ── Non-HR markets stay on the generic, 50-centered calibration path,
//    fully isolated from the home_runs branch added to calibrateDistributionProb.
const hitsInput = makeMinimalMlbPropInput({ market: "hits", currentStatValue: 1 });
const hitsOutput = calculateHitsEdge(hitsInput);
assert(
  "hits market still produces a plausible (non-HR-floored) probability",
  hitsOutput.calibratedProbabilityOver > 5 && hitsOutput.calibratedProbabilityOver < 96,
  `got ${hitsOutput.calibratedProbabilityOver}`,
);
assert(
  "hits market output has no hrConversion attached (HR-only field)",
  hitsOutput.hrConversion === undefined,
);

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) process.exit(1);
process.exit(0);
