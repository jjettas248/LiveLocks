// Pre-Game Power Radar — v2 SHADOW PR6/PR6.1: corrected starter/bullpen joint PA-path.
// Run: npx tsx server/mlb/pregamePowerRadar/math/starterBullpenPath.test.ts
//
// §18 probability block for the joint decomposition + PR6.1 path/input invariants:
//   • joint game prob = brute-force enumeration on small fixtures
//   • monotone ↑ in p_s, p_b, and total PA
//   • starter-only opponent terms NEVER enter p_b; hitter/form/park ALWAYS enter p_b
//   • BOTH projected-PA fields move the path (bullpen-only change, starter-only change)
//   • opener signal INDEPENDENTLY moves mass to the bullpen (flag-only change; opener-no-split)
//   • no exposure evidence → path UNAVAILABLE + missing_pa_path (never fabricated all-starter)
//   • market odds AND market-derived team totals cannot alter p_s/p_b/path/joint prob
//   • exposure applied exactly once (in the PA-path, not the per-PA rate)
//   • Σ joint = 1 for available paths; all outputs finite + bounded

import { buildSegmentedHrPerPa, MIN_HR_PER_PA, MAX_HR_PER_PA } from "./buildPregameHrPerPa";
import { estimatePregamePaPath } from "./estimatePregamePaPath";
import { gameHrProbability, jointGameHrProbability } from "./gameHrProbability";
import { scoreBullpenVulnerability } from "./scoreStarterBullpenPath";
import { runPregameMathModel } from "./mathDiagnostics";
import type { PaPathJointDistribution, PregameMathInputs, StarterBullpenPathInputs } from "./mathTypes";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps = 1e-9) { return Math.abs(a - b) <= eps; }

/** Manual joint (available) for enumeration/monotonicity tests. */
function jointOf(joint: Record<string, number>): PaPathJointDistribution {
  let sMean = 0, bMean = 0;
  for (const [k, m] of Object.entries(joint)) {
    const [ns, nb] = k.split(":").map(Number);
    sMean += ns * m; bMean += nb * m;
  }
  return {
    joint, starterMean: sMean, bullpenMean: bMean, totalMean: sMean + bMean,
    allStarter: bMean === 0, available: true, unavailableReason: null, usedOpenerExposurePrior: false,
  };
}

/** Assert non-null joint prob and return the number. */
function jg(ps: number | null, pb: number | null, path: PaPathJointDistribution): number {
  const v = jointGameHrProbability(ps, pb, path);
  if (v == null) { failed++; console.error("  ✗ expected non-null joint prob"); return NaN; }
  return v;
}

function sb(over: Partial<StarterBullpenPathInputs> = {}): StarterBullpenPathInputs {
  return {
    starterConfirmed: true, projectedPaVsStarter: 3, projectedPaVsBullpen: 1.2,
    bullpenHrPer9: 1.4, bullpenBarrelAllowedPct: 9, ...over,
  };
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
    starterBullpen: sb(),
    market: { hrOddsAvailable: false, impliedHrProbability: null, noVigImpliedHrProbability: null },
    availability: { confirmedActive: true, lateScratchRisk: false, restDayRisk: false, platoonSubRisk: false },
    recentContactForm: {
      recentFormBarrelPct: 14, recentFormAvgEv: 92, recentFormEv90: 108, recentFormAirPct: 45, effectiveBbe: 40,
    },
    slateBaselineGameHrProbability: 0.09,
    ...over,
  };
}

// ── A. Joint game prob = brute-force enumeration ──────────────────────────────
{
  const ps = 0.05, pb = 0.08;
  const path = jointOf({ "2:1": 0.5, "3:0": 0.5 });
  const expected = 1 - (0.5 * Math.pow(1 - ps, 2) * Math.pow(1 - pb, 1) + 0.5 * Math.pow(1 - ps, 3));
  ok(approx(jg(ps, pb, path), expected, 1e-12), "joint prob matches enumeration (2:1 / 3:0)");

  const path2 = jointOf({ "1:2": 0.2, "2:2": 0.5, "4:0": 0.3 });
  const exp2 = 1 - (
    0.2 * Math.pow(1 - ps, 1) * Math.pow(1 - pb, 2) +
    0.5 * Math.pow(1 - ps, 2) * Math.pow(1 - pb, 2) +
    0.3 * Math.pow(1 - ps, 4)
  );
  ok(approx(jg(ps, pb, path2), exp2, 1e-12), "joint prob matches enumeration (3-point)");
}

// ── B. All-starter collapse: equals single-path, pb irrelevant ────────────────
{
  const ps = 0.06, pbA = 0.02, pbB = 0.15;
  const path = jointOf({ "3:0": 0.4, "4:0": 0.6 });
  const single = 1 - (0.4 * Math.pow(1 - ps, 3) + 0.6 * Math.pow(1 - ps, 4));
  ok(approx(jg(ps, pbA, path), single, 1e-12), "all-starter joint == single path");
  ok(approx(jg(ps, pbA, path), jg(ps, pbB, path), 1e-12), "all-starter: p_b irrelevant");
  ok(approx(jg(ps, pbA, path), gameHrProbability(ps, { "3": 0.4, "4": 0.6 }), 1e-12),
    "all-starter joint == gameHrProbability(p_s, totalDist)");
  // A projected split of b=0 collapses to all-starter through the real estimator.
  const realAllStarter = estimatePregamePaPath({ battingOrderSlot: 3, starterBullpen: sb({ projectedPaVsStarter: 5, projectedPaVsBullpen: 0 }) });
  ok(realAllStarter.available && approx(realAllStarter.bullpenMean, 0, 1e-9), "b=0 projection → all-starter path");
}

// ── C/D. Monotone in p_s and p_b (with bullpen PA mass present) ────────────────
{
  const path = jointOf({ "2:2": 0.5, "3:1": 0.5 });
  ok(jg(0.03, 0.05, path) < jg(0.09, 0.05, path), "joint ↑ in p_s");
  ok(jg(0.05, 0.02, path) < jg(0.05, 0.11, path), "joint ↑ in p_b");
}

// ── E. Monotone in total PA (slot only; teamImpliedRuns excluded) ─────────────
{
  const lead = estimatePregamePaPath({ battingOrderSlot: 1, starterBullpen: sb() });
  const tail = estimatePregamePaPath({ battingOrderSlot: 9, starterBullpen: sb() });
  ok(lead.totalMean > tail.totalMean, "leadoff path has more total PA than #9");
  ok(jg(0.05, 0.05, lead) > jg(0.05, 0.05, tail), "joint ↑ with total PA (leadoff > #9)");
}

// ── F. Bounded + finite over a wide grid ──────────────────────────────────────
{
  const path = estimatePregamePaPath({ battingOrderSlot: 4, starterBullpen: sb({ projectedPaVsStarter: 2.5, projectedPaVsBullpen: 1.5 }) });
  let allBounded = true;
  for (const ps of [0, 0.001, 0.05, 0.12, 1]) {
    for (const pb of [0, 0.001, 0.05, 0.12, 1]) {
      const g = jointGameHrProbability(ps, pb, path);
      if (g == null || !Number.isFinite(g) || g < 0 || g > 1) allBounded = false;
    }
  }
  ok(allBounded, "joint prob finite + bounded [0,1] over grid");
  ok(jointGameHrProbability(null, 0.05, path) != null, "null p_s handled (no throw)");
  ok(jointGameHrProbability(0.05, 0.05, null) === null, "null path → null");
}

// ── G. Σ joint = 1 for available paths ────────────────────────────────────────
{
  const configs = [
    estimatePregamePaPath({ battingOrderSlot: 1, starterBullpen: sb({ projectedPaVsStarter: 3, projectedPaVsBullpen: 1.2 }) }),
    estimatePregamePaPath({ battingOrderSlot: 9, starterBullpen: sb({ projectedPaVsStarter: 1, projectedPaVsBullpen: 3 }) }),
    estimatePregamePaPath({ battingOrderSlot: 6, starterBullpen: sb({ projectedPaVsStarter: 0.5, projectedPaVsBullpen: 3.5, isOpenerLikely: true }) }),
    estimatePregamePaPath({ battingOrderSlot: 4, starterBullpen: sb({ projectedPaVsStarter: null, projectedPaVsBullpen: null, isOpenerLikely: true }) }),
  ];
  let allSumOne = true;
  for (const p of configs) {
    ok(p.available, "config path available");
    const sum = Object.values(p.joint).reduce((a, b) => a + b, 0);
    if (!approx(sum, 1, 1e-9)) allSumOne = false;
  }
  ok(allSumOne, "every available PA-path joint sums to 1");
}

// ── H. Starter-only opponent terms NEVER enter p_b ────────────────────────────
{
  const base = buildSegmentedHrPerPa(makeInputs());
  const starterChanged = buildSegmentedHrPerPa(makeInputs({
    pitcherVulnerability: {
      pitcherKnown: true, batterHand: "R", pitcherThrows: "L", hrPer9VsHand: 0.6,
      hrPer9Overall: 0.7, barrelAllowedPct: 3, hardHitAllowedPct: 30, flyBallAllowedPct: 28, bfSample: 400,
    },
    pitchType: { families: [
      { family: "fastball", usageShare: 0.6, batterXslg: 0.28, batterWhiffPct: 35, batterSample: 300 },
      { family: "breaking", usageShare: 0.4, batterXslg: 0.26, batterWhiffPct: 40, batterSample: 200 },
    ] },
    zoneLocation: {
      batterHeartXslg: 0.28, batterElevatedFbXslg: 0.27, batterLowBreakingXslg: 0.26,
      pitcherHeartRate: 0.1, pitcherMiddleMiddleRate: 0.05, pitcherHangerRate: 0.05,
    },
  }));
  ok(approx(base.bullpenHrPerPa, starterChanged.bullpenHrPerPa, 1e-12),
    "changing starter opponent terms leaves p_b unchanged");
  ok(base.starterHrPerPa !== starterChanged.starterHrPerPa, "changing starter opponent terms moves p_s");
}

// ── I. Hitter / form / park ALWAYS enter p_b ──────────────────────────────────
{
  const base = buildSegmentedHrPerPa(makeInputs());
  const powerDrop = buildSegmentedHrPerPa(makeInputs({
    batterPower: {
      xISO: 0.09, xSLG: 0.31, xwOBAcon: 0.30, barrelRatePct: 2, hardHitRatePct: 26,
      exitVelocity: 85, maxEV: 101, flyBallPct: 24, hrFBRatioPct: 4, pullRatePct: 32,
      sweetSpotPct: 27, hrPerPaSeason: 0.012, paSample: 600,
    },
  }));
  ok(powerDrop.bullpenHrPerPa < base.bullpenHrPerPa, "weaker hitter lowers p_b");
  const formDrop = buildSegmentedHrPerPa(makeInputs({
    recentContactForm: { recentFormBarrelPct: 2, recentFormAvgEv: 85, recentFormEv90: 98, recentFormAirPct: 25, effectiveBbe: 40 },
  }));
  ok(formDrop.bullpenHrPerPa < base.bullpenHrPerPa, "cold recent form lowers p_b");
  const parkDrop = buildSegmentedHrPerPa(makeInputs({
    parkWeatherSpray: {
      parkHrFactor: 0.85, parkHrFactorHand: 0.82, isIndoors: false, weatherAvailable: true,
      temperatureF: 52, windSpeedMph: 15, windDirection: "in", batterPullAirShare: 0.3,
    },
  }));
  ok(parkDrop.bullpenHrPerPa < base.bullpenHrPerPa, "poor park/weather lowers p_b");
}

// ── PR6.1 defect 1: no exposure evidence → UNAVAILABLE (never fabricated) ──────
{
  const noExposure = estimatePregamePaPath({ battingOrderSlot: 3, starterBullpen: sb({ projectedPaVsStarter: null, projectedPaVsBullpen: null, isOpenerLikely: null }) });
  ok(!noExposure.available, "no exposure evidence → path unavailable");
  ok(noExposure.unavailableReason === "missing_pa_path", "unavailable reason = missing_pa_path");
  ok(Object.keys(noExposure.joint).length === 0, "unavailable path has empty joint (not all-starter)");

  // End-to-end: current real-capture shape (all exposure fields null).
  const m = runPregameMathModel(makeInputs({
    starterBullpen: { starterConfirmed: true, projectedPaVsStarter: null, projectedPaVsBullpen: null, bullpenHrPer9: null, bullpenBarrelAllowedPct: null },
  }));
  ok(m.jointGameHrProbability === null, "no exposure → jointGameHrProbability null");
  ok(m.calibratedJointGameHrProbability === null, "no exposure → calibrated joint null");
  ok(m.projectedStarterPA === null && m.projectedBullpenPA === null, "no exposure → projected PA null");
  ok(m.missingDataWarnings.includes("missing_pa_path"), "no exposure → missing_pa_path warning");
  // Missing bullpen VULN with exposure PRESENT is NOT unavailable (exposure is what matters).
  const withExposureNoVuln = runPregameMathModel(makeInputs({
    starterBullpen: { starterConfirmed: true, projectedPaVsStarter: 3, projectedPaVsBullpen: 1.2, bullpenHrPer9: null, bullpenBarrelAllowedPct: null },
  }));
  ok(withExposureNoVuln.jointGameHrProbability != null, "exposure present, bullpen vuln absent → joint still available");
  ok(!withExposureNoVuln.missingDataWarnings.includes("missing_pa_path"), "exposure present → no missing_pa_path");
}

// ── PR6.1 defect 2: BOTH projected-PA fields move the path ─────────────────────
{
  // Bullpen projection changes while starter fixed.
  const bLow = estimatePregamePaPath({ battingOrderSlot: 3, starterBullpen: sb({ projectedPaVsStarter: 3, projectedPaVsBullpen: 0.2 }) });
  const bHigh = estimatePregamePaPath({ battingOrderSlot: 3, starterBullpen: sb({ projectedPaVsStarter: 3, projectedPaVsBullpen: 3.0 }) });
  ok(bHigh.bullpenMean > bLow.bullpenMean + 1e-6, "higher projectedPaVsBullpen → more bullpen PA (starter fixed)");
  ok(bHigh.starterMean < bLow.starterMean - 1e-6, "higher projectedPaVsBullpen → fewer starter PA (starter fixed)");

  // Starter projection changes while bullpen fixed.
  const sLow = estimatePregamePaPath({ battingOrderSlot: 3, starterBullpen: sb({ projectedPaVsStarter: 1, projectedPaVsBullpen: 2 }) });
  const sHigh = estimatePregamePaPath({ battingOrderSlot: 3, starterBullpen: sb({ projectedPaVsStarter: 4, projectedPaVsBullpen: 2 }) });
  ok(sHigh.starterMean > sLow.starterMean + 1e-6, "higher projectedPaVsStarter → more starter PA (bullpen fixed)");
  ok(sHigh.bullpenMean < sLow.bullpenMean - 1e-6, "higher projectedPaVsStarter → fewer bullpen PA (bullpen fixed)");
}

// ── PR6.1 defect 2: opener signal INDEPENDENTLY moves mass to the bullpen ──────
{
  // Only isOpenerLikely changes (split held fixed).
  const noOpener = estimatePregamePaPath({ battingOrderSlot: 3, starterBullpen: sb({ projectedPaVsStarter: 3, projectedPaVsBullpen: 1.2, isOpenerLikely: false }) });
  const opener = estimatePregamePaPath({ battingOrderSlot: 3, starterBullpen: sb({ projectedPaVsStarter: 3, projectedPaVsBullpen: 1.2, isOpenerLikely: true }) });
  ok(opener.bullpenMean > noOpener.bullpenMean + 1e-6, "opener flag alone → more bullpen PA");
  ok(opener.starterMean < noOpener.starterMean - 1e-6, "opener flag alone → fewer starter PA");

  // Opener true with NO explicit split → available, bullpen-weighted (frozen prior).
  const openerNoSplit = estimatePregamePaPath({ battingOrderSlot: 3, starterBullpen: sb({ projectedPaVsStarter: null, projectedPaVsBullpen: null, isOpenerLikely: true }) });
  ok(openerNoSplit.available, "opener with no split → path available (frozen prior)");
  ok(openerNoSplit.usedOpenerExposurePrior, "opener no-split flagged usedOpenerExposurePrior");
  ok(openerNoSplit.bullpenMean > openerNoSplit.starterMean, "opener no-split → bullpen-weighted path");
}

// ── PR6.1 defect 3: market inputs cannot alter p_s/p_b/path/joint prob ─────────
{
  const clean = makeInputs();
  const marketTainted = makeInputs({
    market: { hrOddsAvailable: true, impliedHrProbability: 0.25, noVigImpliedHrProbability: 0.22 },
    lineupOpportunity: { battingOrderSlot: 3, teamImpliedRuns: 9.9, obpAhead: 0.35, lineupConfirmed: true },
  });
  const segA = buildSegmentedHrPerPa(clean);
  const segB = buildSegmentedHrPerPa(marketTainted);
  ok(approx(segA.starterHrPerPa, segB.starterHrPerPa, 1e-12), "market inputs do not alter p_s");
  ok(approx(segA.bullpenHrPerPa, segB.bullpenHrPerPa, 1e-12), "market inputs do not alter p_b");

  const pathA = estimatePregamePaPath({ battingOrderSlot: clean.lineupOpportunity.battingOrderSlot, starterBullpen: clean.starterBullpen });
  const pathB = estimatePregamePaPath({ battingOrderSlot: marketTainted.lineupOpportunity.battingOrderSlot, starterBullpen: marketTainted.starterBullpen });
  ok(approx(pathA.starterMean, pathB.starterMean, 1e-12) && approx(pathA.bullpenMean, pathB.bullpenMean, 1e-12),
    "market team total does not alter the PA path");

  const mA = runPregameMathModel(clean);
  const mB = runPregameMathModel(marketTainted);
  ok(mA.jointGameHrProbability === mB.jointGameHrProbability, "market inputs do not alter joint game probability");
}

// ── K/L. scoreBullpenVulnerability carries NO exposure multiplier ─────────────
{
  const shallow = scoreBullpenVulnerability(sb({ projectedPaVsStarter: 3.5, projectedPaVsBullpen: 0.5, bullpenHrPer9: 1.6, bullpenBarrelAllowedPct: 10 }));
  const deep = scoreBullpenVulnerability(sb({ projectedPaVsStarter: 1.0, projectedPaVsBullpen: 3.0, bullpenHrPer9: 1.6, bullpenBarrelAllowedPct: 10 }));
  ok(approx(shallow.logOdds, deep.logOdds, 1e-12), "bullpen-vuln log-odds independent of projected exposure");
  const none = scoreBullpenVulnerability(sb({ bullpenHrPer9: null, bullpenBarrelAllowedPct: null }));
  ok(!none.available && none.logOdds === 0, "no bullpen data → no-op");
  const vuln = scoreBullpenVulnerability(sb({ bullpenHrPer9: 1.9, bullpenBarrelAllowedPct: 11 }));
  const stingy = scoreBullpenVulnerability(sb({ bullpenHrPer9: 0.7, bullpenBarrelAllowedPct: 4 }));
  ok(vuln.logOdds > 0 && stingy.logOdds < 0, "bullpen vuln sign tracks HR/9 + barrel allowed");
}

// ── M. runPregameMathModel exposes bounded, consistent joint fields ───────────
{
  const m = runPregameMathModel(makeInputs());
  ok(m.starterHrPerPa! >= MIN_HR_PER_PA && m.starterHrPerPa! <= MAX_HR_PER_PA, "starterHrPerPa clamped");
  ok(m.bullpenHrPerPa! >= MIN_HR_PER_PA && m.bullpenHrPerPa! <= MAX_HR_PER_PA, "bullpenHrPerPa clamped");
  ok(m.jointGameHrProbability! >= 0 && m.jointGameHrProbability! <= 1, "jointGameHrProbability bounded");
  ok(m.calibratedJointGameHrProbability! >= 0 && m.calibratedJointGameHrProbability! <= 1, "calibrated joint bounded");
  ok(approx((m.projectedStarterPA ?? 0) + (m.projectedBullpenPA ?? 0), m.projectedPA ?? 0, 0.35),
    "projected starter PA + bullpen PA ≈ total projected PA (order of magnitude)");
  const jp = (m.interactionDiagnostics as any).jointPath;
  ok(jp && jp.available === true && jp.bullpenVulnerabilityAvailable === true, "joint-path diagnostics surfaced");
}

// ── N. Elite joint prob beats weak joint prob (end-to-end) ────────────────────
{
  const elite = runPregameMathModel(makeInputs());
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
    recentContactForm: { recentFormBarrelPct: 2, recentFormAvgEv: 85, recentFormEv90: 98, recentFormAirPct: 25, effectiveBbe: 40 },
  }));
  ok(elite.jointGameHrProbability! > weak.jointGameHrProbability!, "elite joint prob > weak joint prob");
}

console.log(`\nstarterBullpenPath.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
