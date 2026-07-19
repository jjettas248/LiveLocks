// Pre-Game Power Radar — graded-state preservation invariants.
//
// Guards the regressions that blanked the daily win card:
//   1. A snapshot rebuild (outcomes=null, becameLive*=false) must carry forward
//      the shadow grader's / live bridge's already-stamped state for the same
//      slate day (carryForwardGradedState).
//   2. The runtime service must never serve a previous slate's snapshot as the
//      current one (getRadarSnapshot / peekRadarSnapshot wrong-date guard is
//      exercised here via the store's date-scoped accessor).
//   3. A batter subbed out of the live batting order (pinch hit/run, defensive
//      sub, injury) must not simply vanish from the rebuilt Map — his prior
//      signal (score/tier/outcomes) must be carried forward with only the
//      game-status-derived fields refreshed (carryForwardDroppedFromLineup),
//      but only once the game is already live/final — a pre-first-pitch
//      scratch must still disappear.
//   4. `everPubliclyFlagged` freezes "was this ever a legitimate publicly-
//      flagged pregame target" and ORs forward across rebuilds, so a later
//      dip in re-fetched mutable eligibility fields can't erase an earlier
//      true evaluation — but never leaks across slate days.
//
// Run: npx tsx server/mlb/pregamePowerRadar/gradedStatePreservation.test.ts

import { carryForwardGradedState, carryForwardDroppedFromLineup } from "./gradedStateCarry";
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
    drivers: [], warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
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

// ── 7. everPubliclyFlagged ORs forward across same-slate rebuilds ────────────
{
  // sig({})'s default drivers: [] intrinsically fails wasPubliclyFlaggedPregame
  // (needs >=2 positive drivers), isolating the carry-forward OR from the
  // live intrinsic recompute.
  const prev = sig({ everPubliclyFlagged: true });
  const fresh = sig({});
  carryForwardGradedState(fresh, prev);
  ok(fresh.everPubliclyFlagged === true, "everPubliclyFlagged ORs forward across rebuilds");
}

// ── 8. everPubliclyFlagged never leaks across slate days ────────────────────
{
  const prevDay = sig({
    signalId: "mlb-pregame:2026-06-30:g1:b1", sessionDate: "2026-06-30",
    everPubliclyFlagged: true,
  });
  const fresh = sig({});
  carryForwardGradedState(fresh, prevDay);
  ok(fresh.everPubliclyFlagged === false, "everPubliclyFlagged does not leak across slate days");
}

// ── 9. Store never serves a snapshot for a different slate date ──────────────
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

// ── 10. Batter dropped from the live lineup carries his signal forward ───────
{
  const prev = sig({
    signalId: "mlb-pregame:2026-07-01:g1:b1", gameId: "g1", batterId: "b1",
    gameStatus: "live", status: "active", lockedAt: null, buildId: "b-old",
  });
  const carried = carryForwardDroppedFromLineup(
    "g1",
    new Set(["b2", "b3"]), // b1 no longer in the fetched lineup
    [prev],
    "live",
    false,
    "2026-07-01T20:00:00.000Z",
    "b-new",
  );
  ok(carried.length === 1, "dropped batter is carried forward");
  ok(carried[0]?.batterId === "b1", "carried signal keeps the original batterId");
  ok(carried[0]?.status === "locked", "live game locks the carried signal");
  ok(carried[0]?.lockedAt === "2026-07-01T20:00:00.000Z", "lockedAt is stamped on first carry into a locked game");
  ok(carried[0]?.buildId === "b-new", "carried signal is stamped with the current build id, not the stale one");
}

// ── 11. Dropped batter's already-graded HR outcome survives the carry ───────
{
  const prev = sig({
    signalId: "mlb-pregame:2026-07-01:g1:b1", gameId: "g1", batterId: "b1",
    gameStatus: "final", status: "graded", outcomes: gradedWin, lockedAt: "2026-07-01T22:00:00.000Z", buildId: "b-old",
  });
  const carried = carryForwardDroppedFromLineup(
    "g1",
    new Set(["b2"]),
    [prev],
    "final",
    false,
    "2026-07-01T23:00:00.000Z",
    "b-new",
  );
  ok(carried.length === 1, "graded dropped batter is still carried forward");
  ok(carried[0]?.outcomes === gradedWin, "already-stamped HR outcome is preserved verbatim");
  ok(carried[0]?.status === "graded", "terminal graded status is never downgraded by the carry");
  ok(carried[0]?.lockedAt === "2026-07-01T22:00:00.000Z", "existing lockedAt is not overwritten");
  ok(carried[0]?.buildId === "b-new", "graded carried signal is also restamped with the current build id");
}

// ── 12. Batter still in the lineup is not duplicated by the carry pass ──────
{
  const prev = sig({ signalId: "mlb-pregame:2026-07-01:g1:b1", gameId: "g1", batterId: "b1" });
  const carried = carryForwardDroppedFromLineup(
    "g1",
    new Set(["b1"]), // still in the fetched lineup — a fresh signal is built for him
    [prev],
    "live",
    false,
    "2026-07-01T20:00:00.000Z",
    "b-new",
  );
  ok(carried.length === 0, "batter still in the lineup is not carried forward (already rebuilt)");
}

// ── 13. Signals from a different game are never carried into this game ──────
{
  const otherGame = sig({ signalId: "mlb-pregame:2026-07-01:g2:b9", gameId: "g2", batterId: "b9" });
  const carried = carryForwardDroppedFromLineup(
    "g1",
    new Set([]),
    [otherGame],
    "live",
    false,
    "2026-07-01T20:00:00.000Z",
    "b-new",
  );
  ok(carried.length === 0, "a different game's prior signals are never carried into this game");
}

// ── 14. Pre-first-pitch lineup scratch is NOT carried forward ───────────────
// A confirmed-lineup batter dropped before first pitch (a late scratch) never
// played — he must disappear like before, not linger as a stale "confirmed"
// pregame target that later becomes an ungradable final row.
{
  const prev = sig({
    signalId: "mlb-pregame:2026-07-01:g1:b1", gameId: "g1", batterId: "b1",
    gameStatus: "scheduled", status: "active", lineupStatus: "posted",
  });
  const scheduledCarry = carryForwardDroppedFromLineup(
    "g1", new Set(["b2"]), [prev], "scheduled", true, "2026-07-01T18:00:00.000Z", "b-new",
  );
  ok(scheduledCarry.length === 0, "scratched-before-first-pitch batter (scheduled) is not carried forward");

  const preCarry = carryForwardDroppedFromLineup(
    "g1", new Set(["b2"]), [prev], "pre", true, "2026-07-01T18:00:00.000Z", "b-new",
  );
  ok(preCarry.length === 0, "scratched-before-first-pitch batter (pre) is not carried forward");
}

// ── 15. Suspended game preserves a dropped batter (grouped with live/final) ──
{
  const prev = sig({
    signalId: "mlb-pregame:2026-07-01:g1:b1", gameId: "g1", batterId: "b1",
    gameStatus: "suspended", status: "active", lockedAt: null, buildId: "b-old",
  });
  const carried = carryForwardDroppedFromLineup(
    "g1",
    new Set(["b2"]), // b1 no longer in the fetched lineup
    [prev],
    "suspended",
    false,
    "2026-07-01T20:00:00.000Z",
    "b-new",
  );
  ok(carried.length === 1, "dropped batter is carried forward during a suspended game");
  ok(carried[0]?.status === "locked", "suspended game locks the carried signal, same as live/final");
}

// ── 16. A brand-new signal can never mint a fresh public flag after first pitch ─
{
  // Drivers/tier/score/coverage all otherwise clear wasPubliclyFlaggedPregame's
  // gates — isolates that the first-pitch guard itself is what blocks minting,
  // not some other unrelated gate failing. A suspended game has already started,
  // so firstPitchLockEligible is false (as it is for live/final), and the mint
  // guard requires firstPitchLockEligible === true.
  const fresh = sig({
    gameStatus: "suspended",
    firstPitchLockEligible: false,
    drivers: [
      { key: "d1", label: "Driver 1", direction: "positive" },
      { key: "d2", label: "Driver 2", direction: "positive" },
    ],
  });
  carryForwardGradedState(fresh, undefined);
  ok(fresh.everPubliclyFlagged === false, "post-first-pitch (suspended) blocks a brand-new signal from newly minting a public flag");
}

// ── 18. Cold-start live/final: a never-flagged signal built for the first time
// AFTER first pitch cannot mint a public flag (no prior copy to inherit from) ──
{
  const freshLive = sig({
    gameStatus: "live", firstPitchLockEligible: false,
    drivers: [
      { key: "d1", label: "Driver 1", direction: "positive" },
      { key: "d2", label: "Driver 2", direction: "positive" },
    ],
  });
  carryForwardGradedState(freshLive, undefined);
  ok(freshLive.everPubliclyFlagged === false, "cold-start LIVE first build cannot mint a public flag with no prior copy");

  const freshFinal = sig({
    gameStatus: "final", firstPitchLockEligible: false,
    drivers: [
      { key: "d1", label: "Driver 1", direction: "positive" },
      { key: "d2", label: "Driver 2", direction: "positive" },
    ],
  });
  carryForwardGradedState(freshFinal, undefined);
  ok(freshFinal.everPubliclyFlagged === false, "cold-start FINAL first build cannot mint a public flag with no prior copy");

  // Sanity: a legitimate pre-first-pitch build DOES mint it.
  const freshPre = sig({
    gameStatus: "scheduled", firstPitchLockEligible: true,
    drivers: [
      { key: "d1", label: "Driver 1", direction: "positive" },
      { key: "d2", label: "Driver 2", direction: "positive" },
    ],
  });
  carryForwardGradedState(freshPre, undefined);
  ok(freshPre.everPubliclyFlagged === true, "a legitimate pre-first-pitch first build still mints the public flag");
}

// ── 17. An already-flagged target's everPubliclyFlagged survives suspension ──
{
  const prev = sig({ everPubliclyFlagged: true });
  // drivers: [] fails wasPubliclyFlaggedPregame's own gate on its own, isolating
  // the OR-preserve from suspended's fresh-evaluation block — a suspended
  // game must never REVOKE an already-true flag, only block minting a new one.
  const fresh = sig({ gameStatus: "suspended", drivers: [] });
  carryForwardGradedState(fresh, prev);
  ok(fresh.everPubliclyFlagged === true, "already-flagged target stays flagged/preserved through a suspension, not revoked");
}

console.log(`\ngradedStatePreservation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
