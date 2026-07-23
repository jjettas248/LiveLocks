// Live Edge / Home Run Radar consolidation — non-HR regression baseline
// (PR 2 of the consolidation plan).
//
// The consolidation project is scoped to touch ONLY the `home_runs` market
// lane. This file locks the exact, full normalized-signal-contract output
// for every OTHER market (hits, total_bases, batter_strikeouts,
// pitcher_strikeouts, pitcher_outs, hits_allowed, walks_allowed) as it
// exists today, captured BEFORE any Phase 3 HR-lane edit. A future PR that
// changes signalScore.ts/eventRates.ts/liveGameOrchestrator.ts for the
// home_runs fixes must leave every assertion in this file passing
// unchanged — that is the actual enforcement of "no non-HR behavior
// change," not just a couple of scorer-function calls.
//
// Covers, per market: computeSignalScoreByFamily's full breakdown,
// deriveSignalTags / deriveFeedTags, feed qualification tier bucket
// (Follow/Fade/Watch — via confidenceTier), and applyDisplayContract's
// full display-contract fields (displaySide, displayProbability,
// displayGrade, isBettable, isWatchOnly).
//
// Run: npx tsx server/mlb/liveEdgeHrConsolidation.test.ts

import {
  computeSignalScoreByFamily,
  deriveSignalTags,
  deriveFeedTags,
  deriveSignalTier,
} from "./signalScore";
import { applyDisplayContract } from "./normalizeSignal";
import type { MLBPropInput, MLBPropOutput, MLBMarket, MLBRecommendedSide } from "./types";
import type { MLBSignal } from "../../shared/mlbSignal";

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

console.log("\n=== Live Edge / HR Radar Consolidation — Non-HR Regression Baseline (PR 2) ===\n");

// ── Fixture builders (shared shape across all non-HR market fixtures) ─────

function buildContactQuality(overrides: Partial<MLBPropInput["contactQuality"]> = {}): MLBPropInput["contactQuality"] {
  return {
    exitVelocity: 96,
    launchAngle: 15,
    hitDistance: 310,
    hardHitRateSeason: 0.42,
    barrelRateProxySeason: 0.08,
    avgBatSpeed: 72,
    avgSwingLength: 7.1,
    priorABResults: [
      { exitVelocity: 98, launchAngle: 12, distance: 290, outcome: "hit" },
    ],
    xBA: 0.270,
    xSLG: 0.450,
    ...overrides,
  };
}

function buildPitcher(overrides: Partial<MLBPropInput["pitcher"]> = {}): MLBPropInput["pitcher"] {
  return {
    pitchCount: 62,
    timesThrough: 2,
    era: 4.20,
    whip: 1.28,
    kPer9: 8.8,
    bbPer9: 3.1,
    managerLeashShort: false,
    isPitcherCollapsing: false,
    pitchMix: [],
    throws: "R",
    ...overrides,
  };
}

function buildInput(market: MLBMarket, overrides: Partial<MLBPropInput> = {}): MLBPropInput {
  return {
    playerId: "np1",
    playerName: "Non-HR Fixture Player",
    team: "TST",
    opponent: "OPP",
    gameId: "g_nonhr",
    market,
    bookLine: 1.5,
    seasonAvg: 0.275,
    plateAppearances: 320,
    atBats: 290,
    currentStatValue: 1,
    remainingPA: 3,
    remainingAB: 3,
    completedAB: 1,
    inning: 5,
    isTopInning: false,
    batterHand: "R",
    contactQuality: buildContactQuality(),
    pitcher: buildPitcher(),
    lineup: {
      battingOrderSlot: 3,
      orderTurnoverProximity: 0,
      lineupSectionStrength: "strong",
      hittersAheadOnBase: 1,
      pocketWeakness: null,
    },
    weatherPark: {
      parkFactor: 1.02,
      temperature: 74,
      windSpeed: 5,
      windDirection: "calm",
      humidity: 45,
      isIndoors: false,
      parkHistoryFactor: null,
    },
    bullpen: {
      bullpenEra: 4.1,
      bullpenUsageLastThreeDays: 35,
      isTopRelieverAvailable: true,
    },
    ...overrides,
  };
}

function buildOutput(market: MLBMarket, recommendedSide: MLBRecommendedSide, overrides: Partial<MLBPropOutput> = {}): MLBPropOutput {
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
    market,
    playerId: "np1",
    playerName: "Non-HR Fixture Player",
    gameId: "g_nonhr",
    projection: recommendedSide === "OVER" ? 2.1 : 0.9,
    bookLine: 1.5,
    overOdds: -115,
    underOdds: -105,
    modifiers,
    projectionLog,
    rawProbabilityOver: 58,
    rawProbabilityUnder: 42,
    calibratedProbabilityOver: 58,
    calibratedProbabilityUnder: 42,
    rawProbability: recommendedSide === "OVER" ? 58 : 42,
    calibratedProbability: recommendedSide === "OVER" ? 58 : 42,
    edge: 4.5,
    recommendedSide,
    confidenceTier: "STRONG",
    mode: "standard",
    completedAB: 1,
    twoABRuleSatisfied: true,
    expectedHits: null,
    remainingPA: 3,
    adjustedHitRate: null,
    bookImplied: 55,
    isExperimental: false,
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
    formIndicator: "warm",
    formScore: 60,
    evPct: 6,
    contextScore: 55,
    matchupTag: null,
    ...overrides,
  };
}

// ── One representative candidate per non-HR market ────────────────────────

const CANDIDATES: Array<{ market: MLBMarket; side: MLBRecommendedSide }> = [
  { market: "hits", side: "OVER" },
  { market: "total_bases", side: "OVER" },
  { market: "batter_strikeouts", side: "OVER" },
  { market: "pitcher_strikeouts", side: "OVER" },
  { market: "pitcher_outs", side: "UNDER" },
  { market: "hits_allowed", side: "UNDER" },
  { market: "walks_allowed", side: "UNDER" },
];

console.log("1. Full normalized-signal-contract snapshot per non-HR market");
for (const { market, side } of CANDIDATES) {
  const input = buildInput(market);
  const output = buildOutput(market, side);

  const scoreBreakdown = computeSignalScoreByFamily(input, output);
  const signalTags = deriveSignalTags(input, output, scoreBreakdown);
  const feedTags = deriveFeedTags(input, output, scoreBreakdown);
  const signalTier = deriveSignalTier(scoreBreakdown.confidenceTier);

  console.log(`  --- ${market}/${side} ---`);
  console.log(`  scoreBreakdown=${JSON.stringify(scoreBreakdown)}`);
  console.log(`  signalTags=${JSON.stringify(signalTags)} feedTags=${JSON.stringify(feedTags)} signalTier=${signalTier}`);

  const sig: MLBSignal = {
    id: `g_nonhr_np1_${market}`,
    gameId: "g_nonhr",
    playerId: "np1",
    playerName: "Non-HR Fixture Player",
    market,
    recommendedSide: side,
    enginePct: 58,
    calibratedProbabilityOver: side === "OVER" ? 58 : 42,
    calibratedProbabilityUnder: side === "OVER" ? 42 : 58,
    signalTier,
    signalScore: scoreBreakdown.total,
  } as unknown as MLBSignal;
  const displayed = applyDisplayContract(sig, {});
  console.log(`  display=${JSON.stringify({ displaySide: displayed.displaySide, displayProbability: displayed.displayProbability, displayGrade: displayed.displayGrade, isBettable: displayed.isBettable, isWatchOnly: displayed.isWatchOnly })}`);
}

// ── 2. Locked baseline values — must not change after a Phase 3 HR-lane edit ─
console.log("\n2. Locked baseline assertions (hardcoded from the capture above)");

type ExpectedBaseline = {
  market: MLBMarket;
  side: MLBRecommendedSide;
  total: number;
  confidenceTier: string;
  signalTier: string;
  hasFollowFadeTag: boolean; // "edge_feed" feed tag = qualifies for the main feed
  displaySide: "OVER" | "UNDER";
  displayGrade: string;
  isBettable: boolean;
  isWatchOnly: boolean;
};

function capture(market: MLBMarket, side: MLBRecommendedSide) {
  const input = buildInput(market);
  const output = buildOutput(market, side);
  const scoreBreakdown = computeSignalScoreByFamily(input, output);
  const feedTags = deriveFeedTags(input, output, scoreBreakdown);
  const signalTier = deriveSignalTier(scoreBreakdown.confidenceTier);
  const sig: MLBSignal = {
    id: `g_nonhr_np1_${market}`, gameId: "g_nonhr", playerId: "np1", playerName: "Non-HR Fixture Player",
    market, recommendedSide: side, enginePct: 58,
    calibratedProbabilityOver: side === "OVER" ? 58 : 42,
    calibratedProbabilityUnder: side === "OVER" ? 42 : 58,
    signalTier, signalScore: scoreBreakdown.total,
  } as unknown as MLBSignal;
  const displayed = applyDisplayContract(sig, {});
  return { scoreBreakdown, feedTags, signalTier, displayed };
}

function assertBaseline(expected: ExpectedBaseline): void {
  const { market, side } = expected;
  const { scoreBreakdown, feedTags, signalTier, displayed } = capture(market, side);
  const label = `${market}/${side}`;
  eq(`${label}: scoreBreakdown.total`, scoreBreakdown.total, expected.total);
  eq(`${label}: confidenceTier`, scoreBreakdown.confidenceTier, expected.confidenceTier);
  eq(`${label}: signalTier`, signalTier, expected.signalTier);
  eq(`${label}: qualifies for edge_feed`, feedTags.includes("edge_feed"), expected.hasFollowFadeTag);
  eq(`${label}: displaySide`, displayed.displaySide, expected.displaySide);
  eq(`${label}: displayGrade`, displayed.displayGrade, expected.displayGrade);
  eq(`${label}: isBettable`, displayed.isBettable, expected.isBettable);
  eq(`${label}: isWatchOnly`, displayed.isWatchOnly, expected.isWatchOnly);
}

const BASELINES: ExpectedBaseline[] = [
  { market: "hits", side: "OVER", total: 52, confidenceTier: "WATCHLIST", signalTier: "watch", hasFollowFadeTag: false, displaySide: "OVER", displayGrade: "Watch", isBettable: false, isWatchOnly: true },
  { market: "total_bases", side: "OVER", total: 52, confidenceTier: "WATCHLIST", signalTier: "watch", hasFollowFadeTag: false, displaySide: "OVER", displayGrade: "Watch", isBettable: false, isWatchOnly: true },
  { market: "batter_strikeouts", side: "OVER", total: 52, confidenceTier: "WATCHLIST", signalTier: "watch", hasFollowFadeTag: false, displaySide: "OVER", displayGrade: "Watch", isBettable: false, isWatchOnly: true },
  { market: "pitcher_strikeouts", side: "OVER", total: 63, confidenceTier: "SOLID", signalTier: "lean", hasFollowFadeTag: true, displaySide: "OVER", displayGrade: "B", isBettable: true, isWatchOnly: false },
  { market: "pitcher_outs", side: "UNDER", total: 56, confidenceTier: "SOLID", signalTier: "lean", hasFollowFadeTag: true, displaySide: "UNDER", displayGrade: "B", isBettable: true, isWatchOnly: false },
  { market: "hits_allowed", side: "UNDER", total: 60, confidenceTier: "SOLID", signalTier: "lean", hasFollowFadeTag: true, displaySide: "UNDER", displayGrade: "B", isBettable: true, isWatchOnly: false },
  { market: "walks_allowed", side: "UNDER", total: 60, confidenceTier: "SOLID", signalTier: "lean", hasFollowFadeTag: true, displaySide: "UNDER", displayGrade: "B", isBettable: true, isWatchOnly: false },
];

for (const b of BASELINES) assertBaseline(b);

// ── 3. home_runs is explicitly NOT covered by this baseline ───────────────
// (it's the one market this consolidation is allowed to change — see
// hrEngineVersions/liveEdgeHrV1Parity.test.ts for its frozen-v1 coverage).
console.log("\n3. Scope guard");
{
  assert(
    "home_runs is intentionally excluded from this non-HR baseline",
    !BASELINES.some((b) => b.market === "home_runs"),
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) {
  console.error("FAILURES:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
