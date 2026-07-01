// Pre-Game Power Radar — graded-state preservation invariants.
//
// Guards the two regressions that blanked the daily win card:
//   1. A snapshot rebuild (outcomes=null, becameLive*=false) must carry forward
//      the shadow grader's / live bridge's already-stamped state for the same
//      slate day (carryForwardGradedState).
//   2. The runtime service must never serve a previous slate's snapshot as the
//      current one (getRadarSnapshot / peekRadarSnapshot wrong-date guard is
//      exercised here via the store's date-scoped accessor).
//
// Run: npx tsx server/mlb/pregamePowerRadar/gradedStatePreservation.test.ts

import { carryForwardGradedState } from "./gradedStateCarry";
import {
  setSnapshot,
  getSnapshotForDate,
  _resetForTests,
  type PregamePowerSnapshot,
} from "./pregamePowerRadarStore";
import type { PregameOutcome, PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function sig(over: Partial<PregamePowerSignal>): PregamePowerSignal {
  return {
    signalId: "mlb-pregame:2026-07-01:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b", batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    score10: 7, tier: "strong",
    drivers: [], warnings: [], tags: [], lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    },
    ...over,
  };
}

const gradedWin: PregameOutcome = {
  hitHr: true, totalBases: 4, hitRecorded: true, rbiRecorded: 2,
  resolvedAt: "2026-07-01T23:30:00.000Z",
  outcome: "pregame_win", userVisible: true,
  hrInning: 4, hrHalf: "bottom", plateAppearanceNumber: 2, firstAbPregameWin: false,
};

// ── 1. Rebuild copy inherits graded outcome + terminal status ─────────────────
{
  const prev = sig({ status: "graded", outcomes: gradedWin, gameStatus: "final" });
  const fresh = sig({ gameStatus: "final", status: "locked", lockedAt: "2026-07-01T22:00:00.000Z" });
  carryForwardGradedState(fresh, prev);
  ok(fresh.outcomes === gradedWin, "graded outcome carried into rebuilt signal");
  ok(fresh.status === "graded", "terminal 'graded' status carried into rebuilt signal");
}

// ── 2. Live-bridge flags OR across rebuilds; convertedLiveAt preserved ────────
{
  const prev = sig({ becameLiveReady: true, becameLiveFire: true, convertedLiveAt: "2026-07-01T21:00:00.000Z" });
  const fresh = sig({});
  carryForwardGradedState(fresh, prev);
  ok(fresh.becameLiveReady === true && fresh.becameLiveFire === true, "live-bridge flags survive rebuild");
  ok(fresh.convertedLiveAt === "2026-07-01T21:00:00.000Z", "convertedLiveAt survives rebuild");
}

// ── 3. First lock time sticks ─────────────────────────────────────────────────
{
  const prev = sig({ lockedAt: "2026-07-01T20:05:00.000Z" });
  const fresh = sig({ lockedAt: "2026-07-01T21:10:00.000Z" });
  carryForwardGradedState(fresh, prev);
  ok(fresh.lockedAt === "2026-07-01T20:05:00.000Z", "earliest lockedAt wins across rebuilds");
}

// ── 4. No prior copy / ungraded prior copy → fresh signal untouched ──────────
{
  const fresh1 = sig({});
  carryForwardGradedState(fresh1, undefined);
  ok(fresh1.outcomes === null && fresh1.status === "active", "no prior copy → no-op");

  const fresh2 = sig({});
  carryForwardGradedState(fresh2, sig({}));
  ok(fresh2.outcomes === null && fresh2.status === "active", "ungraded prior copy → no-op");
}

// ── 5. A previous SLATE DAY's graded copy never leaks into a new slate ────────
{
  const prevDay = sig({
    signalId: "mlb-pregame:2026-06-30:g1:b1", sessionDate: "2026-06-30",
    status: "graded", outcomes: gradedWin, becameLiveFire: true,
  });
  const fresh = sig({});
  carryForwardGradedState(fresh, prevDay);
  ok(fresh.outcomes === null && fresh.status === "active" && fresh.becameLiveFire === false,
    "cross-slate carry-forward is refused (yesterday's win can't mint a today win)");
}

// ── 6. Grader's fresh outcome is never overwritten by a stale prior copy ─────
{
  const newerOutcome: PregameOutcome = { ...gradedWin, hrInning: 7 };
  const fresh = sig({ status: "graded", outcomes: newerOutcome });
  carryForwardGradedState(fresh, sig({ status: "graded", outcomes: gradedWin }));
  ok(fresh.outcomes === newerOutcome, "already-graded rebuilt copy keeps its own outcome");
}

// ── 7. Store never serves a snapshot for a different slate date ──────────────
{
  _resetForTests();
  const snapshot: PregamePowerSnapshot = {
    buildId: "b-old", sessionDate: "2026-06-30", generatedAt: "", builtAtMs: Date.now(),
    gamesScanned: 1, battersEvaluated: 1,
    signals: new Map([["mlb-pregame:2026-06-30:g1:b1", sig({ sessionDate: "2026-06-30", status: "graded", outcomes: gradedWin })]]),
    coverage: { lineupCoverage: 1, weatherCoverage: 1, batterCoverage: 1, pitcherCoverage: 1 },
  };
  setSnapshot(snapshot);
  ok(getSnapshotForDate("2026-07-01") === null, "date-scoped store read refuses a previous slate's snapshot");
  ok(getSnapshotForDate("2026-06-30") === snapshot, "date-scoped store read serves the matching slate");
  _resetForTests();
}

console.log(`\ngradedStatePreservation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
