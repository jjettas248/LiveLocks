// Recent form (hot/cold streak) + IBB feared-slugger prior.
// Run with: npx tsx server/mlb/ibbAndRecentForm.test.ts

import {
  computeHRConversionProbability,
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

console.log("\n[Recent form + IBB feared-slugger] running cases\n");

// ── Recent form: hot streak raises probability, cold lowers it ───────────
{
  const baseline = computeHRConversionProbability(baseInput());
  const hot = computeHRConversionProbability(baseInput({
    hrRateLast7: 0.09, hrRateLast15: 0.07, recentOps: 1.05, seasonOps: 0.800,
  }));
  const cold = computeHRConversionProbability(baseInput({
    hrRateLast7: 0.005, hrRateLast15: 0.008, recentOps: 0.600, seasonOps: 0.800,
  }));
  assert("Hot streak → higher prob than baseline", hot.hrConversionProbability > baseline.hrConversionProbability,
    `hot=${hot.hrConversionProbability} base=${baseline.hrConversionProbability}`);
  assert("Cold streak → lower prob than baseline", cold.hrConversionProbability < baseline.hrConversionProbability,
    `cold=${cold.hrConversionProbability} base=${baseline.hrConversionProbability}`);
  // Overlay delta component captures recency signal (replaced recentFormMult).
  assert("Hot streak → overlay delta positive", hot.overlay.components.delta.score > 0,
    `delta=${hot.overlay.components.delta.score}`);
  assert("Cold streak → overlay delta negative", cold.overlay.components.delta.score < 0,
    `delta=${cold.overlay.components.delta.score}`);
  assert("Overlay delta winsorized ≤ 1.0", hot.overlay.components.delta.score <= 1.0,
    `delta=${hot.overlay.components.delta.score}`);
  assert("Overlay delta winsorized ≥ -1.0", cold.overlay.components.delta.score >= -1.0,
    `delta=${cold.overlay.components.delta.score}`);
}

// ── IBB feared-slugger season prior raises probability (positive-only) ────
{
  const baseline = computeHRConversionProbability(baseInput());
  const feared = computeHRConversionProbability(baseInput({ seasonIBBRate: 0.035 }));
  assert("High season IBB rate → higher prob (feared slugger)",
    feared.hrConversionProbability > baseline.hrConversionProbability,
    `feared=${feared.hrConversionProbability} base=${baseline.hrConversionProbability}`);
  assert("ibbRespectMult capped <= 1.10", feared.components.ibbRespectMult <= 1.10, `mult=${feared.components.ibbRespectMult}`);
  assert("ibbRespectMult never < 1.0 (positive-only)", feared.components.ibbRespectMult >= 1.0, `mult=${feared.components.ibbRespectMult}`);
  // A low IBB rate should not move the multiplier.
  const low = computeHRConversionProbability(baseInput({ seasonIBBRate: 0.002 }));
  assert("Negligible IBB rate → neutral multiplier", low.components.ibbRespectMult === 1.0, `mult=${low.components.ibbRespectMult}`);
}

// ── In-game IBB-risk respect context lifts a real threat in the spot ──────
{
  const ctx = {
    seasonIBBRate: 0.015, inning: 8, battingOrderSlot: 4,
    firstBaseOpen: true, runnerInScoringPosition: true, scoreDifferential: 1,
  };
  const inSpot = computeHRConversionProbability(baseInput(ctx));
  const firstOccupied = computeHRConversionProbability(baseInput({ ...ctx, firstBaseOpen: false }));
  const blowout = computeHRConversionProbability(baseInput({ ...ctx, scoreDifferential: 9 }));
  assert("Feared bat, first base open + RISP + close/late → context lift",
    inSpot.components.ibbRespectMult > firstOccupied.components.ibbRespectMult,
    `inSpot=${inSpot.components.ibbRespectMult} firstOccupied=${firstOccupied.components.ibbRespectMult}`);
  assert("Blowout → smaller (or no) late-game context lift",
    blowout.components.ibbRespectMult < inSpot.components.ibbRespectMult,
    `blowout=${blowout.components.ibbRespectMult} inSpot=${inSpot.components.ibbRespectMult}`);
}

// ── No-op: absent recent-form/IBB inputs match baseline exactly ──────────
{
  const baseline = computeHRConversionProbability(baseInput());
  assert("Absent recent form → overlay delta score = 0",
    baseline.overlay.components.delta.score === 0,
    `delta=${baseline.overlay.components.delta.score}`);
  assert("Absent IBB context → ibbRespectMult == 1.0", baseline.components.ibbRespectMult === 1.0,
    `mult=${baseline.components.ibbRespectMult}`);
}

// ── Phase 1.5 final cap still binds above the new multipliers ────────────
{
  const extreme = computeHRConversionProbability(baseInput({
    seasonHRRate: 0.12, barrelRate: 0.2, xwOBA: 0.45, xISO: 0.30,
    hrFBRatio: 25, flyBallPercent: 50, pullRatePercent: 55, parkFactor: 1.2,
    pitchCount: 100, timesThrough: 3, isPitcherCollapsing: true, era: 7,
    hrRateLast7: 0.12, hrRateLast15: 0.10, recentOps: 1.3, seasonOps: 0.8,
    seasonIBBRate: 0.05, inning: 9, firstBaseOpen: true, runnerInScoringPosition: true, scoreDifferential: 0,
  }));
  assert("Final per-PA rate still capped at 0.12", extreme.components.finalPerPARate <= 0.12,
    `finalPerPA=${extreme.components.finalPerPARate}`);
}

console.log(`\n[Recent form + IBB] ${passed}/${passed + failed} cases passed${failed > 0 ? ` (${failed} FAILED)` : ""}\n`);
if (failed > 0) process.exit(1);
