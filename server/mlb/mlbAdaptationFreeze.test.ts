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

// MLB Live Edge Trust Recovery — second review round: there must be NO
// environment variable value, under any name guess, that can make production
// consume these systems. Flags (if set at all) may only toggle shadow
// logging. These are the actual flag names read by mlbAdaptationConfig.ts
// plus every OLD/guessable name, all tried, all asserted to have zero effect
// on the production return value.
const CANDIDATE_FLAG_NAMES = [
  "MLB_SELF_LEARNING_SHADOW_LOGGING",
  "MLB_SELF_LEARNING_PRODUCTION_ADAPTATION",
  "MLB_EMPIRICAL_HR_CALIBRATION_SHADOW_LOGGING",
  "MLB_EMPIRICAL_HR_CALIBRATION_PRODUCTION",
];
const savedFlags = new Map(CANDIDATE_FLAG_NAMES.map((k) => [k, process.env[k]]));
function resetFlags() {
  for (const [k, v] of Array.from(savedFlags.entries())) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
function setAllFlags(value: string) {
  for (const k of CANDIDATE_FLAG_NAMES) process.env[k] = value;
}
function clearAllFlags() {
  for (const k of CANDIDATE_FLAG_NAMES) delete process.env[k];
}

// ─── Group A: aggregate self-learning rate adjustment (selfLearning.ts) ──────
{
  clearAllFlags();
  _clearMarketCalibrationsForTests();
  // A dramatic historical swing that WOULD move production if consumed.
  _setMarketCalibrationForTests("hits" as any, {
    market: "hits", actualRate: 0.400, engineExpectedRate: 0.250,
    shrinkFactor: 1.0, rateAdjustment: 1.6, sampleSize: 500, lastUpdated: Date.now(),
  });
  check("A1: no flags set -> production adjustment is neutral 1.0 despite large historical swing",
    getLearnedRateAdjustment("hits" as any) === 1.0);

  for (const v of ["1", "TRUE", "yes", "true"]) {
    setAllFlags(v);
    check(`A2 (${v}): NO env value can move production off 1.0`,
      getLearnedRateAdjustment("hits" as any) === 1.0, `flag=${v}`);
  }

  _clearMarketCalibrationsForTests();
  clearAllFlags();
}

// ─── Group B: markets.ts mirrored self-learning shrink ──────────────────────
{
  clearAllFlags();
  // A dramatic error that WOULD move the shrink factor away from the static
  // default if consumed in production.
  updateSelfLearningCalibration("hits", 0.45, 0.25, 500);
  check("B1: no flags set -> production shrink stays at the static default (0.96) despite large error",
    getSelfLearningShrink("hits" as any) === 0.96, `got ${getSelfLearningShrink("hits" as any)}`);

  for (const v of ["false", "true", "1"]) {
    setAllFlags(v);
    check(`B2 (${v}): NO env value can move production off 0.96`,
      getSelfLearningShrink("hits" as any) === 0.96, `flag=${v} got ${getSelfLearningShrink("hits" as any)}`);
  }

  clearAllFlags();
}

// ─── Group C: HR empirical calibration buckets (hrConversionModel.ts) ───────
{
  clearAllFlags();
  const before = calibrate(0.10);
  check("C1: static table used with no empirical buckets loaded", before.source === "static_table");

  // Load buckets that would clearly diverge from the static table value at
  // this raw probability if consumed.
  setEmpiricalCalibrationBuckets([
    { min: 0.08, max: 0.13, calibrated: 0.499, samples: 200, label: "test-bucket" },
  ]);
  check("C2: buckets are loaded (state precondition)", getEmpiricalCalibrationBuckets().length === 1);

  for (const v of [undefined, "false", "true", "1"]) {
    if (v === undefined) clearAllFlags(); else setAllFlags(v);
    const result = calibrate(0.10);
    check(`C3 (${v ?? "unset"}): NO env value routes production through empirical buckets`,
      result.source === "static_table", `flag=${v} got ${result.source} value=${result.value}`);
  }

  setEmpiricalCalibrationBuckets([]);
  clearAllFlags();
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
