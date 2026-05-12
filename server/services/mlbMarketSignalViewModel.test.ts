// Regression test: pure assertions on the surfacing rules. Run via:
//   npx tsx server/services/mlbMarketSignalViewModel.test.ts

import {
  toMarketSignalViewModel,
  deriveMarketActionability,
  actionabilityToDisplayGroup,
  sortMarketSignals,
  groupByDisplayGroup,
  summarizeUnknownInning,
} from "./mlbMarketSignalViewModel";
import {
  getMlbInningWindow,
  getMlbInningWindowPriority,
} from "../../shared/mlbInningWindow";
import type { MLBSignal } from "../../shared/mlbSignal";
import type { CanonicalSignal } from "../../shared/canonicalSignal";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; return; }
  failed++;
  console.log(`[FAIL] ${name}` + (detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""));
}

function makeSig(over: Partial<MLBSignal> = {}): MLBSignal {
  return {
    playerId: "p1",
    playerName: "Test Player",
    gameId: "g1",
    market: "hits",
    sportsbook: null,
    bookLine: 0.5,
    projection: 0.6,
    enginePct: 60,
    edge: 5,
    evPct: null,
    recommendedSide: "OVER",
    signalScore: 7.5,
    confidenceTier: "STRONG",
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

function makeCanonical(over: Partial<CanonicalSignal> = {}): CanonicalSignal {
  return {
    signalId: "mlb:g1:p1:hits:OVER",
    sport: "mlb",
    gameId: "g1",
    actorId: "p1",
    actorName: "Test Player",
    market: "hits",
    side: "OVER",
    displayProbability: 60,
    overProbability: 60,
    underProbability: 40,
    edge: 5,
    projection: 0.6,
    bookLine: 0.5,
    signalTier: "strong",
    signalScore: 7.5,
    drivers: [],
    triggerSummary: null,
    lifecycleState: "strong",
    lifecycleHistory: [],
    engineGeneratedAt: Date.now(),
    surfacedAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: null,
    ...over,
  } as CanonicalSignal;
}

// ── Inning window mapping ─────────────────────────────────────────────
check("inning 1 → early", getMlbInningWindow(1) === "early");
check("inning 3 → early", getMlbInningWindow(3) === "early");
check("inning 4 → mid",   getMlbInningWindow(4) === "mid");
check("inning 6 → mid",   getMlbInningWindow(6) === "mid");
check("inning 7 → late",  getMlbInningWindow(7) === "late");
check("inning 12 → late", getMlbInningWindow(12) === "late");
check("inning null → unknown",      getMlbInningWindow(null) === "unknown");
check("inning undefined → unknown", getMlbInningWindow(undefined) === "unknown");
check("inning 0 → unknown",         getMlbInningWindow(0) === "unknown");
check("inning NaN → unknown",       getMlbInningWindow(Number.NaN) === "unknown");
check("inning 5.7 → mid (floor)",   getMlbInningWindow(5.7) === "mid");

// ── Window priority ──────────────────────────────────────────────────
check("late > early",   getMlbInningWindowPriority("late")   > getMlbInningWindowPriority("early"));
check("early > mid",    getMlbInningWindowPriority("early")  > getMlbInningWindowPriority("mid"));
check("mid > unknown",  getMlbInningWindowPriority("mid")    > getMlbInningWindowPriority("unknown"));

// ── Actionability mapping (max-of rule) ──────────────────────────────
check("watch+watch → monitor",     deriveMarketActionability("watch", "watch") === "monitor");
check("lean+watch → forming",      deriveMarketActionability("lean", "watch") === "forming");
check("watch+build → forming",     deriveMarketActionability("watch", "build") === "forming");
check("strong+watch → actionable", deriveMarketActionability("strong", "watch") === "actionable");
check("watch+strong → actionable", deriveMarketActionability("watch", "strong") === "actionable");
check("elite+watch → urgent",      deriveMarketActionability("elite", "watch") === "urgent");
check("watch+elite → urgent",      deriveMarketActionability("watch", "elite") === "urgent");
check("strong+elite → urgent",     deriveMarketActionability("strong", "elite") === "urgent");
check("elite+strong → urgent",     deriveMarketActionability("elite", "strong") === "urgent");

// ── Terminal lifecycles always force resolved ───────────────────────
check("elite+cashed → resolved",  deriveMarketActionability("elite", "cashed") === "resolved");
check("strong+missed → resolved", deriveMarketActionability("strong", "missed") === "resolved");
check("watch+expired → resolved", deriveMarketActionability("watch", "expired") === "resolved");

// ── Display group routing ────────────────────────────────────────────
check("urgent → ACTION_NOW",     actionabilityToDisplayGroup("urgent") === "ACTION_NOW");
check("actionable → ACTION_NOW", actionabilityToDisplayGroup("actionable") === "ACTION_NOW");
check("forming → BUILDING",      actionabilityToDisplayGroup("forming") === "BUILDING");
check("monitor → MONITOR",       actionabilityToDisplayGroup("monitor") === "MONITOR");
check("resolved → RESOLVED",     actionabilityToDisplayGroup("resolved") === "RESOLVED");

// ── View model end-to-end (with canonical) ──────────────────────────
{
  const sig = makeSig({ inning: 8 });
  const can = makeCanonical({ lifecycleState: "elite", signalTier: "elite" });
  const vm = toMarketSignalViewModel(sig, { canonical: can, silent: true });
  check("vm window=late",            vm.inningWindow === "late");
  check("vm action=urgent",          vm.marketActionability === "urgent");
  check("vm group=ACTION_NOW",       vm.displayGroup === "ACTION_NOW");
  check("vm inningSource=signal",    vm.inningSource === "signal");
  check("vm primaryLabel late+urgent", vm.primarySignalLabel === "LATE · ACTION");
}

// ── Unknown-inning never throws and is labeled unknown ──────────────
{
  const sig = makeSig({ inning: undefined as any, gameStatus: "pregame", hrAlert: null });
  const vm = toMarketSignalViewModel(sig, { silent: true });
  check("vm inning null",      vm.inning === null);
  check("vm window=unknown",   vm.inningWindow === "unknown");
  check("vm inningSource=unknown", vm.inningSource === "unknown");
}

// ── HR Radar inning fallback ────────────────────────────────────────
{
  const sig = makeSig({
    inning: 0 as any,
    market: "home_runs",
    hrAlert: {
      currentInning: 6,
      detectedInning: 4,
      currentState: "BET_NOW",
      hrReadinessScore: 9,
      hrConversionProbabilityRaw: 12,
      hrConversionProbabilityCalibrated: 12,
      remainingPAExpectation: 1.5,
      positiveDrivers: [],
      negativeSuppressors: [],
      cooldownReason: null,
      lastStateChangeAt: 0,
      dataFreshnessMs: 0,
      peakScore: 9,
      peakState: "BET_NOW",
      peakAt: 0,
      pitcherHrVulnerability: 0,
      decayFactor: 1,
      tickCount: 1,
      lastRecomputeAt: 0,
    } as any,
  });
  const vm = toMarketSignalViewModel(sig, { silent: true });
  check("hr inning=6",            vm.inning === 6);
  check("hr window=mid",          vm.inningWindow === "mid");
  check("hr inningSource=hr_radar", vm.inningSource === "hr_radar");
}

// ── Sort: late+urgent outranks mid+urgent outranks late+monitor ─────
{
  const lateUrgent = toMarketSignalViewModel(
    makeSig({ playerId: "lu", inning: 8 }),
    { canonical: makeCanonical({ signalId: "lu", lifecycleState: "elite", signalTier: "elite" }), silent: true },
  );
  const midUrgent = toMarketSignalViewModel(
    makeSig({ playerId: "mu", inning: 5 }),
    { canonical: makeCanonical({ signalId: "mu", lifecycleState: "elite", signalTier: "elite" }), silent: true },
  );
  const lateMonitor = toMarketSignalViewModel(
    makeSig({ playerId: "lm", inning: 8 }),
    { canonical: makeCanonical({ signalId: "lm", lifecycleState: "watch", signalTier: "watch" }), silent: true },
  );
  const sorted = sortMarketSignals([lateMonitor, midUrgent, lateUrgent]);
  check("sort: late+urgent first",  sorted[0].signalId === "lu");
  check("sort: mid+urgent second",  sorted[1].signalId === "mu");
  check("sort: late+monitor last",  sorted[2].signalId === "lm");
}

// ── Sort: probability NEVER outranks actionability ──────────────────
{
  const monitorHighProb = toMarketSignalViewModel(
    makeSig({ playerId: "hp", inning: 5, enginePct: 95 }),
    { canonical: makeCanonical({ signalId: "hp", lifecycleState: "watch", signalTier: "watch", displayProbability: 95 }), silent: true },
  );
  const urgentLowProb = toMarketSignalViewModel(
    makeSig({ playerId: "lp", inning: 5, enginePct: 51 }),
    { canonical: makeCanonical({ signalId: "lp", lifecycleState: "elite", signalTier: "elite", displayProbability: 51 }), silent: true },
  );
  const sorted = sortMarketSignals([monitorHighProb, urgentLowProb]);
  check("sort: urgent low-prob still beats monitor high-prob", sorted[0].signalId === "lp");
}

// ── Resolved sinks to bottom ────────────────────────────────────────
{
  const live = toMarketSignalViewModel(
    makeSig({ playerId: "live" }),
    { canonical: makeCanonical({ signalId: "live", lifecycleState: "watch", signalTier: "watch" }), silent: true },
  );
  const resolved = toMarketSignalViewModel(
    makeSig({ playerId: "res" }),
    { canonical: makeCanonical({ signalId: "res", lifecycleState: "cashed", signalTier: "elite" }), silent: true },
  );
  const sorted = sortMarketSignals([resolved, live]);
  check("sort: resolved sinks below monitor", sorted[0].signalId === "live");
  check("sort: resolved last",                sorted[1].signalId === "res");
}

// ── Unknown inning de-prioritized but not dropped ───────────────────
{
  const knownLate = toMarketSignalViewModel(
    makeSig({ playerId: "kl", inning: 8 }),
    { canonical: makeCanonical({ signalId: "kl", lifecycleState: "strong", signalTier: "strong" }), silent: true },
  );
  const unknownStrong = toMarketSignalViewModel(
    makeSig({ playerId: "us", inning: undefined as any, gameStatus: "pregame", hrAlert: null }),
    { canonical: makeCanonical({ signalId: "us", lifecycleState: "strong", signalTier: "strong" }), silent: true },
  );
  const sorted = sortMarketSignals([unknownStrong, knownLate]);
  check("unknown inning de-prioritized vs known-late at same actionability", sorted[0].signalId === "kl");
  check("unknown inning still present (not dropped)",                          sorted.length === 2);
}

// ── Grouping ────────────────────────────────────────────────────────
{
  const a = toMarketSignalViewModel(
    makeSig({ playerId: "a" }),
    { canonical: makeCanonical({ signalId: "a", lifecycleState: "elite", signalTier: "elite" }), silent: true },
  );
  const b = toMarketSignalViewModel(
    makeSig({ playerId: "b" }),
    { canonical: makeCanonical({ signalId: "b", lifecycleState: "build", signalTier: "lean" }), silent: true },
  );
  const c = toMarketSignalViewModel(
    makeSig({ playerId: "c" }),
    { canonical: makeCanonical({ signalId: "c", lifecycleState: "watch", signalTier: "watch" }), silent: true },
  );
  const d = toMarketSignalViewModel(
    makeSig({ playerId: "d" }),
    { canonical: makeCanonical({ signalId: "d", lifecycleState: "missed", signalTier: "strong" }), silent: true },
  );
  const grouped = groupByDisplayGroup([a, b, c, d]);
  check("group ACTION_NOW=1", grouped.ACTION_NOW.length === 1);
  check("group BUILDING=1",   grouped.BUILDING.length === 1);
  check("group MONITOR=1",    grouped.MONITOR.length === 1);
  check("group RESOLVED=1",   grouped.RESOLVED.length === 1);
}

// ── Unknown inning summary ──────────────────────────────────────────
{
  const u1 = toMarketSignalViewModel(
    makeSig({ playerId: "u1", inning: undefined as any, gameStatus: "pregame", hrAlert: null }),
    { silent: true },
  );
  const u2 = toMarketSignalViewModel(
    makeSig({ playerId: "u2", inning: undefined as any, gameStatus: "live", hrAlert: null }),
    { silent: true },
  );
  const known = toMarketSignalViewModel(
    makeSig({ playerId: "k", inning: 5 }),
    { silent: true },
  );
  const summary = summarizeUnknownInning([u1, u2, known]);
  check("unknown count = 2", summary.unknownInningCount === 2);
  check("unknown reason includes 'unknown'", typeof summary.unknownInningReasons["unknown"] === "number");
}

console.log(`[MLB_MARKET_VIEWMODEL_TEST] passed=${passed} failed=${failed}`);
if (failed > 0) {
  console.log("[MLB_MARKET_VIEWMODEL_TEST] FAIL");
  process.exit(1);
}
console.log("[MLB_MARKET_VIEWMODEL_TEST] OK");
