// SlateRadar gaps #6/#7 — pull rate + pregame HR-form prior.
// Run with: npx tsx server/mlb/pullAndPregame.test.ts

import {
  computeHRConversionProbability,
  computePregameHrFormScore,
  type HRConversionInput,
} from "./hrConversionModel";

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

console.log(`\n[SlateRadar #6/#7] ${passed}/${passed + failed} cases passed${failed > 0 ? ` (${failed} FAILED)` : ""}\n`);
if (failed > 0) process.exit(1);
