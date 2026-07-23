// Regression test for the HR Radar → CanonicalSignal lifecycle bridge in
// deriveMlbLifecycleState(). Locks in the 2026-07 consolidation fix: the
// bridge used to check a `.tier` field that MLBSignal.hrAlert never had
// (always undefined), so every home_runs signal fell through to the fully
// generic signalTier+isBettable derivation regardless of the HR alert
// engine's real dynamic state. It now reads the real
// hrAlert.currentState (WATCH/PREPARE/BET_NOW/COOLED_OFF/CLOSED).
//
// Run: npx tsx server/services/canonicalMapper.test.ts

import { deriveMlbLifecycleState } from "./canonicalMapper";
import type { MLBSignal } from "../../shared/mlbSignal";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); return; }
  failed++;
  console.log(`  ✗ ${name}` + (detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""));
}

function makeSig(over: Partial<MLBSignal> = {}): MLBSignal {
  return {
    playerId: "p1",
    playerName: "Test Player",
    gameId: "g1",
    market: "home_runs",
    sportsbook: null,
    bookLine: 0.5,
    projection: 0.3,
    enginePct: 8,
    edge: 1.5,
    evPct: null,
    recommendedSide: "OVER",
    signalScore: 60,
    confidenceTier: "LEAN",
    signalTier: "lean",
    isBettable: true,
    awayAbbr: "AWAY",
    homeAbbr: "HOME",
    gameStatus: "live",
    inning: 5,
    isTopInning: true,
    homeScore: 2,
    awayScore: 3,
    alreadyHit: false,
    actionable: true,
    stale: false,
    watchlist: false,
    isEarlySignal: false,
    isDegraded: false,
    fallbackUsed: false,
    overOdds: -110,
    underOdds: -110,
    bookImplied: null,
    oddsTimestamp: null,
    signalTags: [],
    feedTags: [],
    badges: [],
    riskFlags: [],
    playerGlowEligible: false,
    formIndicator: null,
    reasons: [],
    explanationBullets: [],
    drivers: {},
    currentStats: null,
    currentStat: 0,
    completedAB: 0,
    lastABContact: null,
    priorABResults: [],
    pitcherName: null,
    pitcherHand: null,
    pitcherPitchCount: null,
    pitcherTimesThrough: null,
    pitchMix: null,
    batterArchetype: null,
    pitcherArchetype: null,
    thesis: null,
    matchupTag: null,
    bvp: null,
    isFlagship: false,
    familyPenaltyFactor: null,
    safetyCeilingApplied: false,
    dataQuality: null,
    signalTimestamp: Date.now(),
    mode: null,
    hrFactors: null,
    hrBuildScore: null,
    hrIntensity: null,
    hrAlert: null,
    rollingForm: null,
    pitcherSignals: null,
    opportunityScore: 0,
    liveScore: 0,
    eventBoost: 0,
    smartTags: [],
    primaryReason: "",
    pitchMatchupRatings: null,
    ...over,
  } as MLBSignal;
}

function makeHrAlert(over: Partial<NonNullable<MLBSignal["hrAlert"]>>): NonNullable<MLBSignal["hrAlert"]> {
  return {
    currentState: "WATCH",
    hrReadinessScore: 40,
    hrConversionProbabilityRaw: 0.08,
    hrConversionProbabilityCalibrated: 0.08,
    remainingPAExpectation: 2,
    positiveDrivers: [],
    negativeSuppressors: [],
    cooldownReason: null,
    lastStateChangeAt: Date.now(),
    dataFreshnessMs: 0,
    peakScore: 40,
    peakState: "WATCH",
    peakAt: Date.now(),
    detectedInning: 3,
    currentInning: 5,
    pitcherHrVulnerability: 50,
    decayFactor: 1,
    tickCount: 3,
    lastRecomputeAt: Date.now(),
    ...over,
  };
}

console.log("\n=== canonicalMapper.deriveMlbLifecycleState — hrAlert bridge ===\n");

// ── The bridge now fires on real hrAlert.currentState values ───────────────
check(
  "BET_NOW -> elite",
  deriveMlbLifecycleState(makeSig({ hrAlert: makeHrAlert({ currentState: "BET_NOW" }) })) === "elite",
);
check(
  "PREPARE -> strong",
  deriveMlbLifecycleState(makeSig({ hrAlert: makeHrAlert({ currentState: "PREPARE" }) })) === "strong",
);
check(
  "WATCH -> watch",
  deriveMlbLifecycleState(makeSig({ hrAlert: makeHrAlert({ currentState: "WATCH" }) })) === "watch",
);
check(
  "COOLED_OFF -> watch (not terminal — can re-promote)",
  deriveMlbLifecycleState(makeSig({ hrAlert: makeHrAlert({ currentState: "COOLED_OFF" }) })) === "watch",
);
check(
  "CLOSED -> expired",
  deriveMlbLifecycleState(makeSig({ hrAlert: makeHrAlert({ currentState: "CLOSED" }) })) === "expired",
);

// ── alreadyHit still short-circuits to cashed, even with a live hrAlert ────
check(
  "alreadyHit=true beats hrAlert.currentState entirely",
  deriveMlbLifecycleState(makeSig({
    alreadyHit: true,
    hrAlert: makeHrAlert({ currentState: "WATCH" }),
  })) === "cashed",
);

// ── No hrAlert (non-HR market, or HR market with no alert state yet) falls
//    through to the fully generic signalTier + isBettable derivation ───────
check(
  "no hrAlert, tier=elite + bettable -> elite (generic path)",
  deriveMlbLifecycleState(makeSig({ hrAlert: null, signalTier: "elite", isBettable: true })) === "elite",
);
check(
  "no hrAlert, tier=lean + bettable -> build (generic path)",
  deriveMlbLifecycleState(makeSig({ hrAlert: null, signalTier: "lean", isBettable: true })) === "build",
);
check(
  "no hrAlert, tier=strong + NOT bettable -> watch (generic path)",
  deriveMlbLifecycleState(makeSig({ hrAlert: null, signalTier: "strong", isBettable: false })) === "watch",
);
check(
  "non-HR market (hits) is unaffected by the hrAlert bridge",
  deriveMlbLifecycleState(makeSig({ market: "hits", hrAlert: null, signalTier: "elite", isBettable: true })) === "elite",
);

console.log(`\n=== Result: ${passed} pass, ${failed} fail ===`);
if (failed > 0) process.exit(1);
process.exit(0);
