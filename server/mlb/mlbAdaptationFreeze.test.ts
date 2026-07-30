// MLB Live Edge Trust Recovery (Phase 1) — production-adaptation freeze.
// Proves: (1) aggregate self-learning outcome-ratio systems (selfLearning.ts,
// markets.ts's mirrored shrink, hrConversionModel.ts's empirical HR buckets)
// cannot alter production probability/projection regardless of what historical
// outcome data says; (2) the fail-closed config gate defaults OFF for any
// missing/invalid value and only "true" turns a system on; (3) shadow
// diagnostics remain observable; (4) HR contact evidence is not double-counted
// between the conversion model and edge.
// Run: npx tsx server/mlb/mlbAdaptationFreeze.test.ts

import {
  getLearnedRateAdjustment,
  _setMarketCalibrationForTests,
  _clearMarketCalibrationsForTests,
} from "./selfLearning";
import {
  getSelfLearningShrink,
  updateSelfLearningCalibration,
  calculateHREdge,
} from "./markets";
import {
  calibrate,
  setEmpiricalCalibrationBuckets,
  getEmpiricalCalibrationBuckets,
} from "./hrConversionModel";
import type { MLBPropInput } from "./types";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[MLB_ADAPTATION_FREEZE_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

const FLAG_A = "MLB_SELF_LEARNING_PRODUCTION_ADAPTATION";
const FLAG_B = "MLB_EMPIRICAL_HR_CALIBRATION_PRODUCTION";
const savedA = process.env[FLAG_A];
const savedB = process.env[FLAG_B];
function resetFlags() {
  if (savedA === undefined) delete process.env[FLAG_A]; else process.env[FLAG_A] = savedA;
  if (savedB === undefined) delete process.env[FLAG_B]; else process.env[FLAG_B] = savedB;
}

// ─── Group A: aggregate self-learning rate adjustment (selfLearning.ts) ──────
{
  delete process.env[FLAG_A];
  _clearMarketCalibrationsForTests();
  // A dramatic historical swing that WOULD move production if consumed.
  _setMarketCalibrationForTests("hits" as any, {
    market: "hits", actualRate: 0.400, engineExpectedRate: 0.250,
    shrinkFactor: 1.0, rateAdjustment: 1.6, sampleSize: 500, lastUpdated: Date.now(),
  });
  check("A1: missing flag -> production adjustment is neutral 1.0 despite large historical swing",
    getLearnedRateAdjustment("hits" as any) === 1.0);

  process.env[FLAG_A] = "1";
  check("A2: truthy-but-wrong value ('1') stays OFF", getLearnedRateAdjustment("hits" as any) === 1.0);
  process.env[FLAG_A] = "TRUE";
  check("A3: wrong case ('TRUE') stays OFF", getLearnedRateAdjustment("hits" as any) === 1.0);
  process.env[FLAG_A] = "yes";
  check("A4: arbitrary truthy string stays OFF", getLearnedRateAdjustment("hits" as any) === 1.0);

  process.env[FLAG_A] = "true";
  const enabledAdj = getLearnedRateAdjustment("hits" as any);
  check("A5: exact 'true' actually flips the gate (shadow computation is real, not dead code)",
    enabledAdj !== 1.0, `got ${enabledAdj}`);

  _clearMarketCalibrationsForTests();
  delete process.env[FLAG_A];
}

// ─── Group B: markets.ts mirrored self-learning shrink ──────────────────────
{
  delete process.env[FLAG_A];
  // A dramatic error that WOULD move the shrink factor away from the static
  // default if consumed in production.
  updateSelfLearningCalibration("hits", 0.45, 0.25, 500);
  check("B1: missing flag -> production shrink stays at the static default (0.96) despite large error",
    getSelfLearningShrink("hits" as any) === 0.96, `got ${getSelfLearningShrink("hits" as any)}`);

  process.env[FLAG_A] = "false";
  check("B2: explicit 'false' stays OFF", getSelfLearningShrink("hits" as any) === 0.96);

  process.env[FLAG_A] = "true";
  const enabledShrink = getSelfLearningShrink("hits" as any);
  check("B3: exact 'true' flips the gate (shrink moves off the static default)",
    enabledShrink !== 0.96, `got ${enabledShrink}`);

  delete process.env[FLAG_A];
}

// ─── Group C: HR empirical calibration buckets (hrConversionModel.ts) ───────
{
  delete process.env[FLAG_B];
  const before = calibrate(0.10);
  check("C1: static table used with no empirical buckets loaded", before.source === "static_table");

  // Load buckets that would clearly diverge from the static table value at
  // this raw probability if consumed.
  setEmpiricalCalibrationBuckets([
    { min: 0.08, max: 0.13, calibrated: 0.499, samples: 200, label: "test-bucket" },
  ]);
  check("C2: buckets are loaded (state precondition)", getEmpiricalCalibrationBuckets().length === 1);

  const withBucketsFlagOff = calibrate(0.10);
  check("C3: missing/false flag -> static table used even though empirical buckets are loaded",
    withBucketsFlagOff.source === "static_table", `got ${withBucketsFlagOff.source} value=${withBucketsFlagOff.value}`);

  process.env[FLAG_B] = "true";
  const withBucketsFlagOn = calibrate(0.10);
  check("C4: exact 'true' flips the gate (empirical buckets take over)",
    withBucketsFlagOn.source === "empirical_buckets" && Math.abs(withBucketsFlagOn.value - 0.499) < 1e-6,
    `got ${withBucketsFlagOn.source} value=${withBucketsFlagOn.value}`);

  setEmpiricalCalibrationBuckets([]);
  delete process.env[FLAG_B];
}

// ─── Group D: HR edge no longer double-counts contact evidence ─────────────
// hrBuild.score (fed once into the conversion model as hrBuildScore/factors)
// must not ALSO be re-added as a flat boost on top of the resulting edge.
// Assert edge is exactly the model probability minus book-implied — no
// leftover bolt-on term — for a fixture with real elite contact evidence
// (which would previously have produced a nonzero hrBuild.boost).
{
  function makeInput(overrides: Partial<MLBPropInput> = {}): MLBPropInput {
    return {
      playerId: "p1", playerName: "Test Batter", team: "TST", opponent: "OPP", gameId: "g1",
      market: "home_runs", bookLine: 0.5, overOdds: -120, underOdds: 100,
      seasonAvg: 0.260, plateAppearances: 400, atBats: 350, currentStatValue: 0,
      remainingPA: 2, remainingAB: 2, completedAB: 2, inning: 5, isTopInning: false,
      batterHand: "R",
      contactQuality: {
        exitVelocity: 108, launchAngle: 28, hitDistance: 430,
        hardHitRateSeason: 0.52, barrelRateProxySeason: 0.18,
        avgBatSpeed: 76, avgSwingLength: 7.4,
        priorABResults: [
          { exitVelocity: 108, launchAngle: 28, distance: 430, outcome: "flyout" },
          { exitVelocity: 105, launchAngle: 26, distance: 405, outcome: "double" },
        ] as any,
        xBA: 0.30, xSLG: 0.560,
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
      hrTrend: {
        abSinceLastHR: 3, hrRateLast7: 0.15, hrRateLast15: 0.12, hrRateLast30: 0.09,
        seasonTotalHR: 32, seasonTotalAB: 420,
      },
      ...overrides,
    };
  }

  const output = calculateHREdge(makeInput());
  const expectedEdge = Math.round((output.calibratedProbabilityOver - output.bookImplied) * 100) / 100;
  check(
    "D1: HR edge equals calibratedProbability - bookImplied exactly (no leftover boost term)",
    Math.abs(output.edge - expectedEdge) < 0.02,
    `edge=${output.edge} expected=${expectedEdge} calibrated=${output.calibratedProbabilityOver} bookImplied=${output.bookImplied}`,
  );
}

resetFlags();
console.log(`[MLB_ADAPTATION_FREEZE_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[MLB_ADAPTATION_FREEZE_TEST] OK");
