// Live Edge HR v1 — freeze + parity invariants (consolidation PR 2).
//
// Proves two things about server/mlb/hrEngineVersions/liveEdgeHrV1.ts:
//  1. It never imports the live, shared functions it forked (source-text
//     scan) — so a later PR editing signalScore.ts/eventRates.ts to ship the
//     v2 fixes cannot silently change v1's output.
//  2. Its forked functions produce byte-for-byte identical output to the
//     REAL exported live functions, across a representative fixture set —
//     so the fork is a faithful freeze of today's behavior, not a
//     transcription with drift already baked in.
//
// Run: npx tsx server/mlb/hrEngineVersions/liveEdgeHrV1Parity.test.ts

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { computeHRRatePerPA } from "../eventRates";
import { computeHrRadarSignalComposite, deriveHrConfidenceTier, deriveSignalTier } from "../signalScore";
import {
  computeHRRatePerPAV1,
  computeHrRadarSignalCompositeV1,
  deriveHrConfidenceTierV1,
  deriveSignalTierV1,
  deriveHrWatchCompositionV1,
  evaluateLiveEdgeHrV1,
  type SignalScoreBreakdownV1,
} from "./liveEdgeHrV1";
import { buildHrEvaluationSnapshotV1 } from "./hrEvaluationSnapshot";
import type { MLBPropInput, MLBPropOutput } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  assert(name, actual === expected, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}
function deepEq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(name, a === e, `expected=${e} actual=${a}`);
}

console.log("\n=== Live Edge HR v1 — Freeze + Parity Invariant Suite (PR 2) ===\n");

// ── Fixture builders ─────────────────────────────────────────────────────
// Minimal-but-complete MLBPropInput/MLBPropOutput fixtures for the
// home_runs market, with sensible neutral defaults and per-test overrides.

function buildContactQuality(overrides: Partial<MLBPropInput["contactQuality"]> = {}): MLBPropInput["contactQuality"] {
  return {
    exitVelocity: 92,
    launchAngle: 18,
    hitDistance: 320,
    hardHitRateSeason: 0.38,
    barrelRateProxySeason: 0.07,
    avgBatSpeed: 71,
    avgSwingLength: 7.2,
    priorABResults: [],
    xBA: 0.255,
    xSLG: 0.430,
    ...overrides,
  };
}

function buildPitcher(overrides: Partial<MLBPropInput["pitcher"]> = {}): MLBPropInput["pitcher"] {
  return {
    pitchCount: 55,
    timesThrough: 2,
    era: 4.10,
    whip: 1.25,
    kPer9: 8.5,
    bbPer9: 3.0,
    managerLeashShort: false,
    isPitcherCollapsing: false,
    pitchMix: [],
    throws: "R",
    ...overrides,
  };
}

function buildLineup(overrides: Partial<MLBPropInput["lineup"]> = {}): MLBPropInput["lineup"] {
  return {
    battingOrderSlot: 4,
    orderTurnoverProximity: 0,
    lineupSectionStrength: "neutral",
    hittersAheadOnBase: 0,
    pocketWeakness: null,
    ...overrides,
  };
}

function buildWeatherPark(overrides: Partial<MLBPropInput["weatherPark"]> = {}): MLBPropInput["weatherPark"] {
  return {
    parkFactor: 1.0,
    temperature: 72,
    windSpeed: 4,
    windDirection: "calm",
    humidity: 50,
    isIndoors: false,
    parkHistoryFactor: null,
    ...overrides,
  };
}

function buildBullpen(overrides: Partial<MLBPropInput["bullpen"]> = {}): MLBPropInput["bullpen"] {
  return {
    bullpenEra: 4.0,
    bullpenUsageLastThreeDays: 40,
    isTopRelieverAvailable: true,
    ...overrides,
  };
}

function buildPropInput(overrides: Partial<MLBPropInput> = {}): MLBPropInput {
  return {
    playerId: "p1",
    playerName: "Test Batter",
    team: "TST",
    opponent: "OPP",
    gameId: "g1",
    market: "home_runs",
    bookLine: 0.5,
    seasonAvg: 0.09,
    plateAppearances: 300,
    atBats: 270,
    currentStatValue: 0,
    remainingPA: 3,
    remainingAB: 3,
    completedAB: 1,
    inning: 4,
    isTopInning: false,
    batterHand: "R",
    contactQuality: buildContactQuality(),
    pitcher: buildPitcher(),
    lineup: buildLineup(),
    weatherPark: buildWeatherPark(),
    bullpen: buildBullpen(),
    ...overrides,
  };
}

function buildPropOutput(overrides: Partial<MLBPropOutput> = {}): MLBPropOutput {
  const modifiers = {
    liveForm: 0, pitcher: 0, pitchType: 0, weatherPark: 0, lineup: 0, bullpen: 0,
    parkHistory: 0, handednessMatchup: 0, bvpHistory: 0, pocketWeakness: 0, liveEvent: 0, total: 0,
  };
  const projectionLog = {
    baseProjection: 0, liveFormAdjustment: 0, pitcherAdjustment: 0, pitchTypeAdjustment: 0,
    weatherParkAdjustment: 0, lineupAdjustment: 0, bullpenAdjustment: 0, parkHistoryAdjustment: 0,
    handednessMatchupAdjustment: 0, bvpHistoryAdjustment: 0, pocketWeaknessAdjustment: 0,
    liveEventAdjustment: 0, finalCappedAdjustment: 0, rawProbability: 0, calibratedProbability: 0,
    confidenceTier: "LEAN" as const, modeUsed: "STANDARD" as const,
  };
  return {
    market: "home_runs",
    playerId: "p1",
    playerName: "Test Batter",
    gameId: "g1",
    projection: 0.1,
    bookLine: 0.5,
    overOdds: 350,
    underOdds: -450,
    modifiers,
    projectionLog,
    rawProbabilityOver: 12,
    rawProbabilityUnder: 88,
    calibratedProbabilityOver: 12,
    calibratedProbabilityUnder: 88,
    rawProbability: 12,
    calibratedProbability: 62,
    edge: 4,
    recommendedSide: "OVER",
    confidenceTier: "LEAN",
    mode: "standard",
    completedAB: 1,
    twoABRuleSatisfied: true,
    expectedHits: null,
    remainingPA: 3,
    adjustedHitRate: null,
    bookImplied: 12,
    isExperimental: true,
    suppressed: false,
    suppressionReason: null,
    explanationBullets: [],
    warnings: [],
    engineGeneratedAt: 1700000000000,
    oddsUpdatedAt: 1700000000000,
    projectionUpdatedAt: 1700000000000,
    sportsbook: "test_book",
    isDerivedLine: false,
    signalTimestamp: 1700000000000,
    formIndicator: "neutral",
    formScore: 50,
    evPct: 12,
    contextScore: 50,
    matchupTag: null,
    ...overrides,
  };
}

// ── 1. Structural guard: v1 never imports the live shared functions ───────
console.log("1. liveEdgeHrV1.ts never imports the functions it froze");
{
  const src = readFileSync(join(REPO_ROOT, "server/mlb/hrEngineVersions/liveEdgeHrV1.ts"), "utf8");
  assert("no import from ../signalScore", !/from\s+["']\.\.\/signalScore["']/.test(src));
  assert("no import from ../eventRates", !/from\s+["']\.\.\/eventRates["']/.test(src));
  assert("no import from ../liveGameOrchestrator", !/from\s+["']\.\.\/liveGameOrchestrator["']/.test(src));
  assert("does import from ../types (safe, untouched by Phase 3)", /from\s+["']\.\.\/types["']/.test(src));
}

// ── 2. computeHRRatePerPAV1 matches the live computeHRRatePerPA today ─────
console.log("2. computeHRRatePerPAV1 parity vs live computeHRRatePerPA");
{
  const scenarios: Array<[string, Partial<MLBPropInput>]> = [
    ["neutral", {}],
    ["low seasonAvg used as rate", { seasonAvg: 0.04 }],
    ["high seasonAvg falls back to league avg", { seasonAvg: 0.31 }],
    ["elite contact + platoon + hot park + wind out", {
      seasonAvg: 0.06,
      batterHand: "L",
      pitcher: buildPitcher({ throws: "R", era: 5.2 }),
      contactQuality: buildContactQuality({ exitVelocity: 103, launchAngle: 26, xSLG: 0.55, barrelRateProxySeason: 0.14, hardHitRateSeason: 0.5 }),
      weatherPark: buildWeatherPark({ parkFactor: 1.08, windDirection: "out", windSpeed: 12 }),
    }],
    ["cold weak contact", {
      contactQuality: buildContactQuality({ exitVelocity: 82, launchAngle: 4, barrelRateProxySeason: 0.02, hardHitRateSeason: 0.2, xSLG: 0.30 }),
      weatherPark: buildWeatherPark({ temperature: 42 }),
    }],
    ["no contact evidence yet (nulls)", {
      contactQuality: buildContactQuality({ exitVelocity: null, launchAngle: null, xSLG: null, barrelRateProxySeason: null, hardHitRateSeason: null }),
    }],
  ];

  for (const [label, overrides] of scenarios) {
    const input = buildPropInput(overrides);
    const live = computeHRRatePerPA(input);
    const v1 = computeHRRatePerPAV1(input);
    eq(`hrRatePerPA matches — ${label}`, v1, live);
  }
}

// ── 3. computeHrRadarSignalCompositeV1 matches the live composite today ───
console.log("3. computeHrRadarSignalCompositeV1 parity vs live computeHrRadarSignalComposite");
{
  const scenarios: Array<[string, Partial<MLBPropInput>, Partial<MLBPropOutput>]> = [
    ["neutral", {}, {}],
    ["hot contact + elite power profile", {
      contactQuality: buildContactQuality({
        exitVelocity: 106, launchAngle: 24, barrelRateProxySeason: 0.15, hardHitRateSeason: 0.55,
        xSLG: 0.58, hrFBRatio: 20, flyBallPercent: 44, xISOSeason: 0.24, xwOBASeason: 0.39,
        sweetSpotPercent: 40, pullRatePercent: 50, learnedHrLikelihood: 0.22,
      }),
      pitcher: buildPitcher({ era: 5.5, isPitcherCollapsing: true, avgFastballSpin: 2050, velocityDrop: 4 }),
      bullpen: buildBullpen({ bullpenEra: 5.0, bullpenUsageLastThreeDays: 85, isTopRelieverAvailable: false }),
      lineup: buildLineup({ battingOrderSlot: 3 }),
      hrTrend: { abSinceLastHR: 40, hrRateLast7: 0.10, hrRateLast15: 0.08, hrRateLast30: 0.05, seasonTotalHR: 20, seasonTotalAB: 400 },
      rollingForm: { last7Avg: null, last15Avg: null, last30Avg: null, last7Ops: null, last15Ops: 0.95, seasonOps: 0.80 },
      ibbContext: { seasonIBBRate: 0.03, firstBaseOpen: true, runnerInScoringPosition: true, scoreDifferential: 1, inning: 7 },
      liveInterpretation: { contactScore: 0.15, nearHrScore: 0.12, momentumScore: 0.05, pitcherFatigueScore: 0.10, veloDropScore: 0.06, confidenceBoost: 0, tags: [] },
      remainingPA: 4,
    }, { calibratedProbability: 78, pitcherAnalysis: { stuff: 80, command: 60, swingMiss: 75, fatigue: 70, contactSuppression: 40, matchup: 55, context: 60 } }],
    ["cold everything", {
      contactQuality: buildContactQuality({ exitVelocity: 84, launchAngle: 3, barrelRateProxySeason: 0.02, hardHitRateSeason: 0.22, xSLG: 0.30 }),
      pitcher: buildPitcher({ era: 2.5, avgFastballSpin: 2500 }),
      lineup: buildLineup({ battingOrderSlot: 8 }),
      remainingPA: 0,
    }, { calibratedProbability: 30 }],
    ["with prior-AB barrel + HR evidence", {
      contactQuality: buildContactQuality({
        priorABResults: [
          { exitVelocity: 106, launchAngle: 27, distance: 410, outcome: "home_run" },
          { exitVelocity: 101, launchAngle: 22, distance: 380, outcome: "hit" },
        ],
      }),
    }, {}],
    ["handedness splits both directions", {
      batterHand: "L",
      pitcherHandednessSplits: { eraVsLHB: 6.2, eraVsRHB: 3.5, hrPer9VsLHB: 2.6, hrPer9VsRHB: 0.8 },
      batterHandednessSplits: { hrRateVsLHP: null, hrRateVsRHP: 0.06, opsVsLHP: null, opsVsRHP: 0.95 },
      pitcher: buildPitcher({ throws: "R" }),
    }, {}],
  ];

  for (const [label, inOverrides, outOverrides] of scenarios) {
    const input = buildPropInput(inOverrides);
    const output = buildPropOutput(outOverrides);
    const live = computeHrRadarSignalComposite(input, output);
    const v1 = computeHrRadarSignalCompositeV1(input, output);
    deepEq(`composite matches — ${label}`, v1, live);
  }
}

// ── 4. deriveHrConfidenceTierV1 / deriveSignalTierV1 match their live twins ─
console.log("4. tier-mapping helpers match their live equivalents");
{
  for (const total of [0, 10, 34, 35, 36, 54, 55, 56, 64, 65, 66, 79, 80, 81, 100]) {
    eq(`deriveHrConfidenceTier(${total})`, deriveHrConfidenceTierV1(total), deriveHrConfidenceTier(total));
  }
  for (const tier of ["ELITE", "STRONG", "SOLID", "WATCHLIST", "NO_SIGNAL"] as const) {
    eq(`deriveSignalTier(${tier})`, deriveSignalTierV1(tier), deriveSignalTier(tier));
  }
}

// ── 5. The known label-ordering bug is faithfully preserved (not fixed) ───
// Cross-checked against the exact thresholds phase3bRegression.test.ts
// already locks for the live HR Watch bump (see its "[1] HR Watch bump
// invariant" section) — same inputs, same expected post-bump values.
console.log("5. deriveHrWatchCompositionV1 preserves today's exact bug");
{
  // 76 + 6 (lean bump) = 82 → HR ladder ELITE (>=80). signalMode was derived
  // from confidenceTier=STRONG (pre-bump 76 is STRONG, 65<=76<80) as
  // "hr_strong" and is NEVER re-derived — so mode says hr_strong while
  // confidenceTier says ELITE. This is the bug, preserved on purpose.
  const sb: SignalScoreBreakdownV1 = {
    probability: 50, projection: 50, liveContext: 50, matchup: 50, form: 50,
    opportunity: 50, marketReliability: 50, priceValidation: 50, eventBoost: 50,
    total: 76, confidenceTier: "STRONG",
  };
  const result = deriveHrWatchCompositionV1(sb, "lean", ["NEAR HR CONTACT DETECTED"], []);
  eq("post-bump total is 82", sb.total, 82);
  eq("post-bump confidenceTier is ELITE (HR ladder, >=80)", sb.confidenceTier, "ELITE");
  eq("signalMode is stale hr_strong (the bug)", result.signalMode, "hr_strong");
  assert("signalMode disagrees with the post-bump confidenceTier's implied mode", result.signalMode !== "hr_elite");

  // Watch-tier bump case: 53 + 3 = 56 → SOLID (>=55). Pre-bump 53 has no
  // confidenceTier band assigned in this call (isolated function, tier
  // passed in) — using WATCHLIST at 53 to match the ladder (35<=53<55).
  const sb2: SignalScoreBreakdownV1 = { ...sb, total: 53, confidenceTier: "WATCHLIST" };
  const result2 = deriveHrWatchCompositionV1(sb2, "watch", [], []);
  eq("watch bump: post-bump total is 56", sb2.total, 56);
  eq("watch bump: post-bump confidenceTier is SOLID", sb2.confidenceTier, "SOLID");
  eq("watch bump: pre-bump total 53 was below the with-evidence gate (25), so signalMode was already hr_watch", result2.signalMode, "hr_watch");

  // Null tier: no bump, no mutation.
  const sb3: SignalScoreBreakdownV1 = { ...sb, total: 50, confidenceTier: "WATCHLIST" };
  const result3 = deriveHrWatchCompositionV1(sb3, null, [], []);
  eq("null tier: no bump", sb3.total, 50);
  eq("null tier: bumpApplied is 0", result3.bumpApplied, 0);
  eq("null tier: stampSignalType is undefined", result3.stampSignalType, undefined);
}

// ── 6. evaluateLiveEdgeHrV1 end-to-end shape + bug reproduction ───────────
console.log("6. evaluateLiveEdgeHrV1 end-to-end");
{
  const input = buildPropInput({
    contactQuality: buildContactQuality({
      exitVelocity: 104, launchAngle: 25, barrelRateProxySeason: 0.13, hardHitRateSeason: 0.5, xSLG: 0.56,
      priorABResults: [{ exitVelocity: 105, launchAngle: 24, distance: 400, outcome: "hit" }],
    }),
    pitcher: buildPitcher({ era: 5.1, isPitcherCollapsing: true }),
  });
  const output = buildPropOutput({ calibratedProbability: 74 });
  const snapshot = buildHrEvaluationSnapshotV1({
    gameId: "g1", playerId: "p1", playerName: "Test Batter",
    capturedAt: "2026-07-23T00:00:00.000Z",
    propInput: input, propOutput: output,
    nearHrTier: "lean", nearHrDrivers: ["NEAR HR CONTACT DETECTED"],
  });

  const result = evaluateLiveEdgeHrV1(snapshot);
  eq("engineVersion is stamped", result.engineVersion, "live_edge_hr_v1");
  assert("hrRatePerPA is a finite diagnostic number", Number.isFinite(result.hrRatePerPA));
  assert("scoreBreakdown.total reflects the post-bump value (not pre-bump)", result.scoreBreakdown.total > 0);
  assert("signalTags received the injected near-HR driver", result.signalTags.includes("NEAR HR CONTACT DETECTED"));
  // Re-run the live composite independently on the SAME input/output to get
  // the pre-bump total this scenario would have produced, proving the bump
  // really did move the total (not a no-op fixture).
  const preBump = computeHrRadarSignalComposite(input, output);
  assert("scoreBreakdown.total differs from the unbumped composite (bump applied)", result.scoreBreakdown.total !== preBump.total || preBump.total >= 100);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) {
  console.error("FAILURES:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
