/**
 * Phase 2 (2026-07) — "one engine" full convergence regression lock.
 *
 * calculateHREdge() (markets.ts) computes an HRConversionResult once per
 * batter per tick. Previously, the SAME tick's evaluateHRAlert() call
 * (feeding hrAlertEngine's dynamic state) independently reconstructed its
 * own HRConversionInput via buildConversionInput() and called
 * computeHRConversionProbability() a second time — redundant work with a
 * theoretical risk of the two numbers drifting apart if either mapping
 * function changed independently.
 *
 * evaluateHRAlert now accepts an optional precomputedHrConversion param;
 * when supplied (as liveGameOrchestrator.ts's tick-loop call site now does,
 * passing calculateHREdge's own output.hrConversion), it is used AS-IS —
 * skipping the internal recomputation entirely — so there is exactly one
 * computeHRConversionProbability() call per batter per tick, not two.
 *
 * Covers:
 *   1. No precomputed result -> computes internally (unchanged fallback
 *      behavior, exercised by the contact-event-driven call site which has
 *      no same-tick calculateHREdge result to reuse).
 *   2. A precomputed result IS used verbatim (reference-equal in the
 *      returned diagnostics) — proof of reuse, not just "also accepted."
 *   3. The precomputed value actually drives the alert tier/level gating
 *      (not merely stored decoratively) — the same HRAlertInput/factors
 *      produce a materially different outcome depending on which
 *      precomputed HRConversionResult is injected.
 *
 * Run: npx tsx server/mlb/evaluateHRAlertPrecomputedConversion.test.ts
 */

import { evaluateHRAlert, type HRAlertInput } from "./evaluateHRAlert";
import { computeHRConversionProbability, type HRConversionInput, type HRConversionResult } from "./hrConversionModel";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function defaultFactors(o: Partial<HRAlertInput["factors"]> = {}): HRAlertInput["factors"] {
  return {
    avgEV: null, maxEV: null, avgLA: null,
    barrels: 0, hardHits: 0, deepFlyouts: 0, solidContactCount: 0,
    batSpeedScore: 0, pitcherFatigueBoost: 0, parkWindBoost: 0, platoonBoost: 0,
    hrShapedCount: 0, missedHrCount: 0, eliteHrCount: 0,
    qualifiedEVMean: null, maxDistance: null,
    contactClasses: [],
    batSpeedPowerScore: 0, batSpeedZ: 0, airDangerScore: 0,
    hitterPowerProfileScore: 0, hitterPowerProfileFlags: [],
    warningContactCount: 0, deadPopupCount: 0, airBallWarningCount: 0, batSpeedWarningCount: 0,
    maxXBA: null, avgXBA: null, batSpeedMph: null,
    ...o,
  } as HRAlertInput["factors"];
}

function baseAlertInput(o: Partial<HRAlertInput> = {}): HRAlertInput {
  return {
    playerId: "test-player", playerName: "Test Slugger", teamAbbr: "TST", gameId: "test-game",
    hrBuildScore: 4.0, hrIntensity: "watch",
    // 2 HR-shaped events + decent EV/distance is enough to reach PATH_A's
    // conv-gated branch (totalHrShaped>=2, qualifiedEVMean>=92, score>=3.5),
    // whose isOfficial/tier decision is directly gated on convProb — the
    // exact mechanism this test needs to exercise.
    factors: defaultFactors({ hrShapedCount: 2, qualifiedEVMean: 93, maxDistance: 360 }),
    inning: 5,
    priorABResults: [],
    battingOrderSlot: 4,
    remainingPA: 2,
    ...o,
  };
}

function baseConversionInput(o: Partial<HRConversionInput> = {}): HRConversionInput {
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
    ...o,
  };
}

console.log("\n=== evaluateHRAlert precomputed-HRConversionResult reuse ===\n");

// ── 1. No precomputed result -> falls back to internal computation ────────
const noPrecomputed = evaluateHRAlert(baseAlertInput());
assert(
  "no precomputed result -> hrConversion still computed internally (fallback unchanged)",
  !!noPrecomputed.diagnostics.hrConversion,
  `hrConversion=${JSON.stringify(noPrecomputed.diagnostics.hrConversion)}`,
);

// ── 2 & 3. A weak vs. an elite precomputed HRConversionResult, same
//    HRAlertInput/factors — proves reuse (reference-equal) AND that it
//    actually drives the gating (materially different outcome).
const weakConversion: HRConversionResult = computeHRConversionProbability(baseConversionInput({
  seasonHRRate: 0.010, barrelRate: 0.020, hardHitRate: 0.15, xSLG: 0.300,
}));
const eliteConversion: HRConversionResult = computeHRConversionProbability(baseConversionInput({
  seasonHRRate: 0.070, barrelRate: 0.180, hardHitRate: 0.55, xSLG: 0.600,
  xwOBA: 0.420, xISO: 0.280,
}));
assert(
  "sanity: weak/elite fixtures actually differ in probability",
  eliteConversion.hrOccurrenceProbability > weakConversion.hrOccurrenceProbability + 0.05,
  `weak=${weakConversion.hrOccurrenceProbability} elite=${eliteConversion.hrOccurrenceProbability}`,
);

const alertInput = baseAlertInput();
const resultWithWeak = evaluateHRAlert(alertInput, weakConversion);
const resultWithElite = evaluateHRAlert(alertInput, eliteConversion);

assert(
  "precomputed (weak) result is used verbatim — reference-equal in diagnostics, not recomputed",
  resultWithWeak.diagnostics.hrConversion === weakConversion,
);
assert(
  "precomputed (elite) result is used verbatim — reference-equal in diagnostics, not recomputed",
  resultWithElite.diagnostics.hrConversion === eliteConversion,
);
assert(
  "the SAME HRAlertInput/factors produce a materially different alertTier depending solely on which precomputed result is injected (proves it drives gating, not just decoration)",
  resultWithElite.alertTier !== resultWithWeak.alertTier || resultWithElite.level !== resultWithWeak.level,
  `weak: level=${resultWithWeak.level} tier=${resultWithWeak.alertTier} path=${resultWithWeak.diagnostics.alertPath} | ` +
  `elite: level=${resultWithElite.level} tier=${resultWithElite.alertTier} path=${resultWithElite.diagnostics.alertPath}`,
);
assert(
  "elite precomputed conversion reaches at least as promoted a tier as weak (never worse)",
  (resultWithElite.level === "ALERT" ? 1 : resultWithElite.level === "WATCH" ? 0 : -1) >=
  (resultWithWeak.level === "ALERT" ? 1 : resultWithWeak.level === "WATCH" ? 0 : -1),
  `weak level=${resultWithWeak.level} elite level=${resultWithElite.level}`,
);

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) process.exit(1);
process.exit(0);
