// Mound Radar — graded-state preservation invariants.
// Mirrors pregamePowerRadar/gradedStatePreservation.test.ts's role for pitcher signals.
//
// Guards the regression that blanked the Mound win card:
//   1. A snapshot rebuild (outcomes=null, becameLive*=false) must carry forward
//      the shadow grader's / live bridge's already-stamped state for the same
//      slate day (carryForwardMoundGradedState).
//   2. A starter dropped from resolution (rotation change, scratch, or a
//      whole-game gamePk resolution failure) must not simply vanish from the
//      rebuilt Map — his prior signal (score/tier/outcomes) must be carried
//      forward with only the game-status-derived fields refreshed
//      (carryForwardDroppedFromMound), but only once the game is already
//      live/final — a pre-first-pitch resolution gap must still disappear.
//   3. `everPubliclyFlagged` freezes "was this ever a legitimate publicly-
//      flagged mound target" and ORs forward across rebuilds, so a later dip
//      in re-fetched mutable eligibility fields can't erase an earlier true
//      evaluation — but never leaks across slate days.
//
// Run: npx tsx server/mlb/pregame/mound/moundGradedStatePreservation.test.ts

import { carryForwardMoundGradedState, carryForwardDroppedFromMound } from "./moundGradedStateCarry";
import type { MoundOutcome, MoundSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function sig(over: Partial<MoundSignal>): MoundSignal {
  return {
    signalId: "mlb-mound:2026-07-01:g1:p1", sport: "mlb", engine: "mound_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b", pitcherId: "p1", pitcherName: "X", team: "NYY", opponent: "BOS",
    throws: "R",
    opposingLineupConfirmed: true, opposingLineupLabel: "vs BOS confirmed lineup",
    primaryMarket: "pitcher_strikeouts", marketTags: ["pitcher_strikeouts"], marketScores: { pitcher_strikeouts: 7 },
    marketSetups: [],
    parkContext: null,
    score10: 7, tier: "strong", moundDirection: null,
    drivers: [], warnings: [], tags: [],
    lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    marketEdgeContext: null, projectedStrikeouts: 6,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, everPubliclyFlaggedFade: false, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      pitcherSkillScore: 8, opponentKProfileScore: 7, workloadScore: 6, runEnvironmentScore: 6,
      recentFormScore: 6, marketFitScore: 7, contactRiskScore: 5, riskPenalty: 0,
      appliedDrivers: [], appliedWarnings: [],
      dataCoverageScore: 0.95, finalScoreBeforeCaps: 7, finalScoreAfterCaps: 7, publicTier: "strong",
      suppressed: false, suppressedReasons: [],
      sourceFreshness: {},
      rawInputsAvailable: {
        confirmedStarter: true, confirmedOpposingLineup: true, pitcherSeasonStats: true,
        pitcherHandednessSplits: true, pitcherRecentStarts: true, pitcherStuffMetrics: true,
        park: true, weather: true,
      },
    },
    ...over,
  };
}

const gradedWin: MoundOutcome = {
  finalStrikeouts: 8, finalOutsRecorded: null, finalBaseOnBalls: 2, finalEarnedRuns: 1,
  resolvedAt: "2026-07-01T23:30:00.000Z",
  outcome: "mound_win", userVisible: true, seasonBaselineValue: 6.0,
};

// ── 1. Rebuild copy inherits graded outcome + terminal status ─────────────────
{
  const prev = sig({ status: "graded", outcomes: gradedWin, gameStatus: "final" });
  const fresh = sig({ gameStatus: "final", status: "locked", lockedAt: "2026-07-01T22:00:00.000Z" });
  carryForwardMoundGradedState(fresh, prev);
  ok(fresh.outcomes === gradedWin, "graded outcome carried into rebuilt signal");
  ok(fresh.status === "graded", "terminal 'graded' status carried into rebuilt signal");
}

// ── 2. Live-bridge flags OR across rebuilds; convertedLiveAt preserved ────────
{
  const prev = sig({ becameLiveReady: true, becameLiveFire: true, convertedLiveAt: "2026-07-01T21:00:00.000Z" });
  const fresh = sig({});
  carryForwardMoundGradedState(fresh, prev);
  ok(fresh.becameLiveReady === true && fresh.becameLiveFire === true, "live-bridge flags survive rebuild");
  ok(fresh.convertedLiveAt === "2026-07-01T21:00:00.000Z", "convertedLiveAt survives rebuild");
}

// ── 3. First lock time sticks ─────────────────────────────────────────────────
{
  const prev = sig({ lockedAt: "2026-07-01T20:05:00.000Z" });
  const fresh = sig({ lockedAt: "2026-07-01T21:10:00.000Z" });
  carryForwardMoundGradedState(fresh, prev);
  ok(fresh.lockedAt === "2026-07-01T20:05:00.000Z", "earliest lockedAt wins across rebuilds");
}

// ── 4. No prior copy / ungraded prior copy → fresh signal untouched ──────────
{
  const fresh1 = sig({});
  carryForwardMoundGradedState(fresh1, undefined);
  ok(fresh1.outcomes === null && fresh1.status === "active", "no prior copy → no-op");

  const fresh2 = sig({});
  carryForwardMoundGradedState(fresh2, sig({}));
  ok(fresh2.outcomes === null && fresh2.status === "active", "ungraded prior copy → no-op");
}

// ── 5. A previous SLATE DAY's graded copy never leaks into a new slate ────────
{
  const prevDay = sig({
    signalId: "mlb-mound:2026-06-30:g1:p1", sessionDate: "2026-06-30",
    status: "graded", outcomes: gradedWin, becameLiveFire: true,
  });
  const fresh = sig({});
  carryForwardMoundGradedState(fresh, prevDay);
  ok(fresh.outcomes === null && fresh.status === "active" && fresh.becameLiveFire === false,
    "cross-slate carry-forward is refused (yesterday's win can't mint a today win)");
}

// ── 6. Grader's fresh outcome is never overwritten by a stale prior copy ─────
{
  const newerOutcome: MoundOutcome = { ...gradedWin, finalStrikeouts: 10 };
  const fresh = sig({ status: "graded", outcomes: newerOutcome });
  carryForwardMoundGradedState(fresh, sig({ status: "graded", outcomes: gradedWin }));
  ok(fresh.outcomes === newerOutcome, "already-graded rebuilt copy keeps its own outcome");
}

// Public-quality flagging now counts independent predictive-evidence families
// (diagnostics component scores), not raw positive driver chips. A signal whose
// families all fall below their thresholds intrinsically fails
// wasPubliclyFlaggedMound, isolating the carry-forward OR from the live intrinsic
// recompute. sig({})'s rich default diagnostics WOULD qualify on their own, so
// starve them here.
function starveEvidence(s: MoundSignal): MoundSignal {
  s.diagnostics.pitcherSkillScore = 0;
  s.diagnostics.opponentKProfileScore = 0;
  s.diagnostics.workloadScore = 0;
  s.diagnostics.runEnvironmentScore = 0;
  s.diagnostics.recentFormScore = 0;
  return s;
}

// ── 7. everPubliclyFlagged ORs forward across same-slate rebuilds ────────────
{
  const prev = sig({ everPubliclyFlagged: true });
  const fresh = starveEvidence(sig({}));
  carryForwardMoundGradedState(fresh, prev);
  ok(fresh.everPubliclyFlagged === true, "everPubliclyFlagged ORs forward across rebuilds");
}

// ── 8. everPubliclyFlagged never leaks across slate days ────────────────────
{
  const prevDay = sig({
    signalId: "mlb-mound:2026-06-30:g1:p1", sessionDate: "2026-06-30",
    everPubliclyFlagged: true,
  });
  const fresh = starveEvidence(sig({}));
  carryForwardMoundGradedState(fresh, prevDay);
  ok(fresh.everPubliclyFlagged === false, "everPubliclyFlagged does not leak across slate days");
}

// ── 9. Starter dropped from resolution carries his signal forward ───────────
{
  const prev = sig({
    signalId: "mlb-mound:2026-07-01:g1:p1", gameId: "g1", pitcherId: "p1",
    gameStatus: "live", status: "active", lockedAt: null, buildId: "b-old",
  });
  const carried = carryForwardDroppedFromMound(
    "g1",
    new Set(["p2", "p3"]), // p1 no longer resolved this cycle
    [prev],
    "live",
    false,
    "2026-07-01T20:00:00.000Z",
    "b-new",
  );
  ok(carried.length === 1, "dropped starter is carried forward");
  ok(carried[0]?.pitcherId === "p1", "carried signal keeps the original pitcherId");
  ok(carried[0]?.status === "locked", "live game locks the carried signal");
  ok(carried[0]?.lockedAt === "2026-07-01T20:00:00.000Z", "lockedAt is stamped on first carry into a locked game");
  ok(carried[0]?.buildId === "b-new", "carried signal is stamped with the current build id, not the stale one");
}

// ── 10. Dropped starter's already-graded mound_win outcome survives the carry ──
{
  const prev = sig({
    signalId: "mlb-mound:2026-07-01:g1:p1", gameId: "g1", pitcherId: "p1",
    gameStatus: "final", status: "graded", outcomes: gradedWin, lockedAt: "2026-07-01T22:00:00.000Z", buildId: "b-old",
  });
  const carried = carryForwardDroppedFromMound(
    "g1",
    new Set(["p2"]),
    [prev],
    "final",
    false,
    "2026-07-01T23:00:00.000Z",
    "b-new",
  );
  ok(carried.length === 1, "graded dropped starter is still carried forward");
  ok(carried[0]?.outcomes === gradedWin, "already-stamped mound_win outcome is preserved verbatim");
  ok(carried[0]?.status === "graded", "terminal graded status is never downgraded by the carry");
  ok(carried[0]?.lockedAt === "2026-07-01T22:00:00.000Z", "existing lockedAt is not overwritten");
  ok(carried[0]?.buildId === "b-new", "graded carried signal is also restamped with the current build id");
}

// ── 11. Starter still resolved is not duplicated by the carry pass ──────────
{
  const prev = sig({ signalId: "mlb-mound:2026-07-01:g1:p1", gameId: "g1", pitcherId: "p1" });
  const carried = carryForwardDroppedFromMound(
    "g1",
    new Set(["p1"]), // still resolved this cycle — a fresh signal is built for him
    [prev],
    "live",
    false,
    "2026-07-01T20:00:00.000Z",
    "b-new",
  );
  ok(carried.length === 0, "starter still resolved is not carried forward (already rebuilt)");
}

// ── 12. Signals from a different game are never carried into this game ──────
{
  const otherGame = sig({ signalId: "mlb-mound:2026-07-01:g2:p9", gameId: "g2", pitcherId: "p9" });
  const carried = carryForwardDroppedFromMound(
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

// ── 13. Pre-first-pitch resolution gap is NOT carried forward ──────────────
// A confirmed starter dropped before first pitch (rotation still TBD) never
// started — he must disappear like before, not linger as a stale "confirmed"
// mound target that later becomes an ungradable final row.
{
  const prev = sig({
    signalId: "mlb-mound:2026-07-01:g1:p1", gameId: "g1", pitcherId: "p1",
    gameStatus: "scheduled", status: "active",
  });
  const scheduledCarry = carryForwardDroppedFromMound(
    "g1", new Set(["p2"]), [prev], "scheduled", true, "2026-07-01T18:00:00.000Z", "b-new",
  );
  ok(scheduledCarry.length === 0, "resolution gap before first pitch (scheduled) is not carried forward");

  const preCarry = carryForwardDroppedFromMound(
    "g1", new Set(["p2"]), [prev], "pre", true, "2026-07-01T18:00:00.000Z", "b-new",
  );
  ok(preCarry.length === 0, "resolution gap before first pitch (pre) is not carried forward");
}

// ── 14. A publicly-flagged Fade direction is pinned across same-slate rebuilds ──
// Regression (Codex review, PR #105): the grader branches on
// signal.moundDirection, so a later pregame rebuild recomputing a fresh
// direction (e.g. lineup confirms, tier moves off "track") must not silently
// flip a signal the UI already showed as "Fade (Under)" into Follow/Over
// settlement logic.
{
  const prev = sig({ moundDirection: "fade", everPubliclyFlaggedFade: true, tier: "track" });
  // Fresh rebuild recomputes this cycle as "follow" (e.g. tier moved to
  // "strong" as data firmed up) — sig({})'s defaults (tier: "strong",
  // everPubliclyFlagged: false) mean the fresh signal's own intrinsic
  // moundDirection would be "follow" if not pinned.
  const fresh = sig({ moundDirection: "follow", tier: "strong" });
  carryForwardMoundGradedState(fresh, prev);
  ok(fresh.moundDirection === "fade", "previously-flagged Fade direction is pinned, not silently flipped to the freshly-recomputed Follow");
}

// ── 15. A publicly-flagged Follow direction is pinned across same-slate rebuilds ──
{
  const prev = sig({ moundDirection: "follow", everPubliclyFlagged: true, tier: "strong" });
  const fresh = sig({ moundDirection: "fade", tier: "track" });
  carryForwardMoundGradedState(fresh, prev);
  ok(fresh.moundDirection === "follow", "previously-flagged Follow direction is pinned, not silently flipped to the freshly-recomputed Fade");
}

// ── 16. An UNFLAGGED prior direction is not pinned (never shown publicly, safe to let it move) ──
{
  const prev = sig({ moundDirection: "fade", everPubliclyFlaggedFade: false, tier: "track" });
  const fresh = sig({ moundDirection: "follow", tier: "strong" });
  carryForwardMoundGradedState(fresh, prev);
  ok(fresh.moundDirection === "follow", "a prior direction that was never publicly flagged is free to move on rebuild");
}

// ── 17. A game's first-ever build happening AFTER first pitch never mints a Fade flag ──
// Regression (Codex review, PR #105): a server restart, delayed build, or
// earlier unresolved gamePk can mean the FIRST successful build for a game
// happens once it's already live/final — with no `prev` signal to carry a
// legitimate flag forward. Without a pre-first-pitch guard, that first-ever
// evaluation would flag a Fade candidate using hindsight (final box score)
// data, even though nothing was ever shown to a user before first pitch.
// suppressed: true throughout — a REAL track-tier signal is always
// suppressed under composeMoundScore's Follow-oriented quality bar (score10
// < 4.0 is always < MOUND_PUBLISH_MIN_SCORE 5.5), so these fixtures must
// reflect that to actually exercise the realistic case (see test 19 below).
{
  const fresh = sig({
    moundDirection: "fade", tier: "track", suppressed: true,
    gameStatus: "final", firstPitchLockEligible: false,
  });
  carryForwardMoundGradedState(fresh, undefined);
  ok(fresh.everPubliclyFlaggedFade === false, "a Fade signal first evaluated after first pitch (no prior flag to inherit) is never flagged");
}

// ── 18. A legitimate pre-first-pitch Fade flag still survives into a live/final rebuild ──
{
  const prev = sig({ moundDirection: "fade", everPubliclyFlaggedFade: true, tier: "track", suppressed: true });
  const fresh = sig({
    moundDirection: "fade", tier: "track", suppressed: true,
    gameStatus: "final", firstPitchLockEligible: false,
  });
  carryForwardMoundGradedState(fresh, prev);
  ok(fresh.everPubliclyFlaggedFade === true, "a Fade flag legitimately set pre-game survives into a post-first-pitch rebuild via the OR carry-forward");
}

// ── 19. A real (always-suppressed) track-tier Fade signal CAN still be flagged ──
// Regression (Codex review, PR #105): composeMoundScore suppresses every
// score below MOUND_PUBLISH_MIN_SCORE (5.5), and "track" tier is DEFINED as
// score10 < 4.0 — so a real Fade signal is unconditionally suppressed under
// that Follow-oriented quality bar. wasPubliclyFlaggedMoundFade must NOT
// check !suppressed, or the Fade flag can never fire for any real signal.
{
  const fresh = sig({ moundDirection: "fade", tier: "track", suppressed: true });
  carryForwardMoundGradedState(fresh, undefined);
  ok(fresh.everPubliclyFlaggedFade === true, "a real (suppressed) track-tier Fade signal is flagged pre-game — suppressed is never checked for Fade");
}

// ── 20. Follow cold-start: a never-flagged Follow signal first built AFTER first
// pitch (no prior copy) cannot mint everPubliclyFlagged — mirrors Plate's guard
// and the Fade guard (tests 17-19), now applied to the Follow flag too. ──
{
  const followDrivers = [
    { key: "d1", label: "D1", direction: "positive" as const },
    { key: "d2", label: "D2", direction: "positive" as const },
  ];
  const freshLive = sig({ gameStatus: "live", firstPitchLockEligible: false, drivers: followDrivers });
  carryForwardMoundGradedState(freshLive, undefined);
  ok(freshLive.everPubliclyFlagged === false, "cold-start LIVE Follow build cannot mint everPubliclyFlagged with no prior copy");

  const freshFinal = sig({ gameStatus: "final", firstPitchLockEligible: false, drivers: followDrivers });
  carryForwardMoundGradedState(freshFinal, undefined);
  ok(freshFinal.everPubliclyFlagged === false, "cold-start FINAL Follow build cannot mint everPubliclyFlagged with no prior copy");

  const freshPre = sig({ gameStatus: "scheduled", firstPitchLockEligible: true, drivers: followDrivers });
  carryForwardMoundGradedState(freshPre, undefined);
  ok(freshPre.everPubliclyFlagged === true, "a legitimate pre-first-pitch Follow build still mints everPubliclyFlagged");
}

// ── 21. A publicly-flagged (Follow) primaryMarket is pinned across same-slate
// rebuilds — Production regression (Sugano, COL vs MIL): computeMarketTags
// recomputes primaryMarket every cycle from live pitcherSkill/opponentKProfile/
// workloadScore, exactly like moundDirection. A post-first-pitch rebuild with
// degraded data can flip which of the two scores wins, silently swapping a
// pitcher shown publicly on the REAL-ODDS strikeout market onto the Outs
// market — which has no sportsbook line source at all — permanently losing a
// real Cashed/Missed/Push to the model-review baseline fallback. ──
{
  const prev = sig({
    primaryMarket: "pitcher_strikeouts",
    marketTags: ["pitcher_strikeouts", "pitcher_outs"],
    marketScores: { pitcher_strikeouts: 6.5, pitcher_outs: 6.0 },
    marketSetups: [
      { market: "pitcher_strikeouts", setupScore: 6.5, setupLabel: "Strong", isPrimary: true },
      { market: "pitcher_outs", setupScore: 6.0, setupLabel: "Solid", isPrimary: false },
    ],
    everPubliclyFlagged: true,
  });
  // Fresh rebuild recomputes this cycle as "pitcher_outs" (e.g. degraded
  // post-game workload/opponent-K inputs flip the kScore-vs-outsScore
  // comparison) — must not silently become the signal's settlement market.
  const fresh = sig({
    primaryMarket: "pitcher_outs",
    marketTags: ["pitcher_strikeouts", "pitcher_outs"],
    marketScores: { pitcher_strikeouts: 5.0, pitcher_outs: 5.8 },
    marketSetups: [
      { market: "pitcher_strikeouts", setupScore: 5.0, setupLabel: "Solid", isPrimary: false },
      { market: "pitcher_outs", setupScore: 5.8, setupLabel: "Solid", isPrimary: true },
    ],
  });
  carryForwardMoundGradedState(fresh, prev);
  ok(fresh.primaryMarket === "pitcher_strikeouts", "previously-flagged primaryMarket is pinned, not silently flipped to the freshly-recomputed Outs market");
  const ksSetup = fresh.marketSetups.find((m) => m.market === "pitcher_strikeouts");
  const outsSetup = fresh.marketSetups.find((m) => m.market === "pitcher_outs");
  ok(ksSetup?.isPrimary === true, "marketSetups' isPrimary flag is repointed to the pinned market");
  ok(outsSetup?.isPrimary === false, "the non-pinned market's isPrimary flag is cleared to stay consistent");
}

// ── 22. A publicly-flagged (Fade-only) primaryMarket is pinned too — the pin
// is symmetric across both durable flags, not Follow-only. ──
{
  const prev = sig({
    primaryMarket: "pitcher_strikeouts",
    everPubliclyFlagged: false,
    everPubliclyFlaggedFade: true,
    moundDirection: "fade",
    tier: "track",
  });
  const fresh = sig({ primaryMarket: "pitcher_outs", moundDirection: "fade", tier: "track" });
  carryForwardMoundGradedState(fresh, prev);
  ok(fresh.primaryMarket === "pitcher_strikeouts", "a Fade-only publicly-flagged primaryMarket is pinned, not silently flipped to Outs");
}

// ── 23. An UNFLAGGED prior primaryMarket is not pinned (never shown publicly, safe to let it move) ──
{
  const prev = sig({ primaryMarket: "pitcher_strikeouts", everPubliclyFlagged: false, everPubliclyFlaggedFade: false });
  const fresh = sig({ primaryMarket: "pitcher_outs" });
  carryForwardMoundGradedState(fresh, prev);
  ok(fresh.primaryMarket === "pitcher_outs", "a prior primaryMarket that was never publicly flagged is free to move on rebuild");
}

console.log(`\nmoundGradedStatePreservation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
