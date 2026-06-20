// SlateRadar gaps #6/#7 — pull rate + pregame HR-form prior.
// Run with: npx tsx server/mlb/pullAndPregame.test.ts

import {
  computeHRConversionProbability,
  computePregameHrFormScore,
  computePregameSeed,
  type HRConversionInput,
} from "./hrConversionModel";
import { PREGAME_SEED_CAP } from "@shared/hrRadarConviction";

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function baseInput(over: Partial<HRConversionInput> = {}): HRConversionInput {
  return {
    hrBuildScore: 0,
    factors: { contactClasses: [] } as any,
    inning: 1, isTopInning: true, battingOrderSlot: 4,
    currentRuns: 0, leagueAvgRuns: 4.5,
    pitchCount: 10, timesThrough: 1, isPitcherCollapsing: false,
    era: 4.0, parkFactor: 1.0,
    windDirection: null, windSpeed: null, temperature: 72, isIndoors: false,
    batterHand: "R", pitcherThrows: "R",
    seasonHRRate: 0.033, barrelRate: 0.065, hardHitRate: 0.4, xSLG: 0.4,
    ...over,
  };
}

console.log("\n[SlateRadar #6/#7 — pull rate + pregame prior] running cases\n");

// ── Pregame HR-form score ────────────────────────────────────────────────
{
  const elite = computePregameHrFormScore(baseInput({ pullRatePercent: 50, hrFBRatio: 20, flyBallPercent: 44, xISO: 0.24, xwOBA: 0.39, parkFactor: 1.12 }));
  assert("Elite profile → form score > 50", elite > 50, `got ${elite}`);
  const cold = computePregameHrFormScore(baseInput({ pullRatePercent: 28, hrFBRatio: 6, flyBallPercent: 26, xISO: 0.09, xwOBA: 0.29, parkFactor: 0.9 }));
  assert("Cold profile → form score < 50", cold < 50, `got ${cold}`);
  const neutral = computePregameHrFormScore(baseInput({ hrFBRatio: null, flyBallPercent: null, pullRatePercent: null, xISO: null, xwOBA: null }));
  assert("No profile data → neutral 50", neutral === 50, `got ${neutral}`);
}

// ── Pregame seed (presence-floor / pre-contact rows) ─────────────────────
{
  const eliteProfile = { pullRatePercent: 50, hrFBRatio: 20, flyBallPercent: 44, xISO: 0.24, xwOBA: 0.39, parkFactor: 1.12 };
  const elite = computePregameSeed(baseInput(eliteProfile), {
    lineupSlot: 2, seasonHRRate: 0.05, hrRateLast30: 0.06, barrelRate: 0.13, isHotHitter: true,
  });
  assert("Elite profile+eligibility → seed score well above base", elite.seedScore > 30, `got ${elite.seedScore}`);
  assert("Elite seed never exceeds PREGAME_SEED_CAP", elite.seedScore <= PREGAME_SEED_CAP, `got ${elite.seedScore}`);
  assert("Elite seed surfaces drivers", elite.drivers.length > 0, `got ${JSON.stringify(elite.drivers)}`);
  assert("Drivers capped at 4 for chip display", elite.drivers.length <= 4, `got ${elite.drivers.length}`);
  assert("Drivers are de-duplicated", new Set(elite.drivers).size === elite.drivers.length);

  const neutral = computePregameSeed(baseInput({ hrFBRatio: null, flyBallPercent: null, pullRatePercent: null, xISO: null, xwOBA: null }), {});
  assert("Neutral profile, no eligibility → modest seed (~base 25)", neutral.seedScore >= 20 && neutral.seedScore <= 30, `got ${neutral.seedScore}`);

  const cold = computePregameSeed(baseInput({ pullRatePercent: 28, hrFBRatio: 6, flyBallPercent: 26, xISO: 0.09, xwOBA: 0.29, parkFactor: 0.9 }), {});
  assert("Cold profile → seed below neutral", cold.seedScore < neutral.seedScore, `cold=${cold.seedScore} neutral=${neutral.seedScore}`);
  assert("Seed never negative", cold.seedScore >= 0, `got ${cold.seedScore}`);
}

// ── Pull rate raises HR probability (else equal) ─────────────────────────
{
  const common = { hrFBRatio: 16, flyBallPercent: 40, xISO: 0.2, xwOBA: 0.36 };
  const hi = computeHRConversionProbability(baseInput({ ...common, pullRatePercent: 50 }));
  const lo = computeHRConversionProbability(baseInput({ ...common, pullRatePercent: 28 }));
  assert("High pull rate → higher HR probability", hi.hrConversionProbability > lo.hrConversionProbability,
    `hi=${hi.hrConversionProbability} lo=${lo.hrConversionProbability}`);
}

// ── Pregame prior: applies pre-AB, decays once live contact exists ───────
{
  const eliteProfile = { hrFBRatio: 20, flyBallPercent: 44, xISO: 0.24, xwOBA: 0.39, pullRatePercent: 50, parkFactor: 1.12 };
  const preAB = computeHRConversionProbability(baseInput({ hrBuildScore: 0, ...eliteProfile }));
  assert("Pre-AB elite → pregame prior multiplier > 1.0", preAB.components.pregamePriorMult > 1.0,
    `mult=${preAB.components.pregamePriorMult}`);
  assert("Pre-AB elite → form score recorded", preAB.components.pregameFormScore > 50,
    `score=${preAB.components.pregameFormScore}`);

  const live = computeHRConversionProbability(baseInput({ hrBuildScore: 8, ...eliteProfile }));
  assert("Strong live contact → prior fully faded (mult ≈ 1.0)", Math.abs(live.components.pregamePriorMult - 1.0) < 1e-9,
    `mult=${live.components.pregamePriorMult}`);
  assert("Prior weight decays with live contact", live.components.pregamePriorMult < preAB.components.pregamePriorMult);
}

// ── Lane 3.1 — humidity (additive, no-op when null, capped) ──────────────
{
  const dry = computeHRConversionProbability(baseInput({ humidity: 25 }));
  const humid = computeHRConversionProbability(baseInput({ humidity: 90 }));
  const none = computeHRConversionProbability(baseInput({ humidity: null }));
  assert("Humid air → higher env multiplier than dry", humid.environmentMultiplier > dry.environmentMultiplier,
    `humid=${humid.environmentMultiplier} dry=${dry.environmentMultiplier}`);
  assert("Humidity null → no-op vs no-humidity baseline", none.environmentMultiplier === computeHRConversionProbability(baseInput({})).environmentMultiplier);
  assert("Indoors suppresses humidity effect",
    computeHRConversionProbability(baseInput({ humidity: 90, isIndoors: true })).environmentMultiplier ===
    computeHRConversionProbability(baseInput({ humidity: 25, isIndoors: true })).environmentMultiplier);
}

// ── Lane 3.2 — barometric pressure (additive, no-op when null, capped) ────
{
  const low = computeHRConversionProbability(baseInput({ pressure: 995 }));
  const high = computeHRConversionProbability(baseInput({ pressure: 1030 }));
  const none = computeHRConversionProbability(baseInput({ pressure: null }));
  assert("Low pressure → higher env multiplier than high pressure", low.environmentMultiplier > high.environmentMultiplier,
    `low=${low.environmentMultiplier} high=${high.environmentMultiplier}`);
  assert("Pressure null → no-op vs baseline", none.environmentMultiplier === computeHRConversionProbability(baseInput({})).environmentMultiplier);
  assert("Env multiplier stays within 1.35 cap with all density boosts",
    computeHRConversionProbability(baseInput({ humidity: 95, pressure: 990, temperature: 95, windDirection: "out", windSpeed: 15, parkFactor: 1.2 })).environmentMultiplier <= 1.35);
}

// ── Lane 3.3 — in-game velocity-decay trend (slope) ──────────────────────
{
  const det = (veloTrendSlope: number | null) => ({
    velocityDrop: null, avgVelocity: 93, seasonAvgVelocity: 94,
    isReliever: false, relieverEra: null, starterEra: 4.0,
    bullpenEra: null, bullpenUsageLast3Days: null, relieversUsedCount: 0,
    veloTrendSlope,
  });
  const falling = computeHRConversionProbability(baseInput({ pitcherDeterioration: det(-2.5) }));
  const stable = computeHRConversionProbability(baseInput({ pitcherDeterioration: det(0) }));
  const none = computeHRConversionProbability(baseInput({ pitcherDeterioration: det(null) }));
  assert("Falling velo trend → higher pitcher multiplier than stable", falling.pitcherMultiplier > stable.pitcherMultiplier,
    `falling=${falling.pitcherMultiplier} stable=${stable.pitcherMultiplier}`);
  assert("Velo trend null → no-op vs stable", none.pitcherMultiplier === stable.pitcherMultiplier);
  assert("Pitcher multiplier stays within 2.0 cap",
    computeHRConversionProbability(baseInput({ pitchCount: 110, timesThrough: 3, isPitcherCollapsing: true, era: 7, pitcherDeterioration: det(-3) })).pitcherMultiplier <= 2.0);
}

console.log(`\n[SlateRadar #6/#7] ${passed}/${passed + failed} cases passed${failed > 0 ? ` (${failed} FAILED)` : ""}\n`);
if (failed > 0) process.exit(1);
