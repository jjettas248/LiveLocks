// Mound Radar — public-visibility predicate invariants (isPublicMoundSignal).
// Mirrors pregamePowerRadar/diagnostics.test.ts. Follow-only public retention;
// Fade stays publicly absent (eligibility flag ≠ actual public delivery).
//
// Run: npx tsx server/mlb/pregame/mound/diagnostics.test.ts

import { isPublicMoundSignal, flaggedBeforeFirstPitchMound } from "./diagnostics";
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
    kStuffScore: 8, kStuffLabel: "Strong", platoonKFitScore: 7, platoonKFitLabel: "Strong",
    kProjectionLabel: "Good", kLineValue: null,
    parkContext: null,
    score10: 7, tier: "strong", moundDirection: "follow",
    drivers: [
      { key: "d1", label: "D1", direction: "positive" },
      { key: "d2", label: "D2", direction: "positive" },
    ],
    warnings: [], tags: [],
    lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    marketEdgeContext: null, projectedStrikeouts: 6, matchupAdjustedStrikeouts: null,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, everPubliclyFlaggedFade: false,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
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
    } as any,
    ...over,
  };
}

const followWin: MoundOutcome = {
  finalStrikeouts: 8, finalOutsRecorded: null, finalBaseOnBalls: 2, finalEarnedRuns: 1,
  resolvedAt: "2026-07-01T23:30:00.000Z", outcome: "mound_win", userVisible: true, seasonBaselineValue: 6.0,
};
const followMiss: MoundOutcome = {
  finalStrikeouts: 3, resolvedAt: "2026-07-01T23:30:00.000Z",
  outcome: "mound_calibration_miss", userVisible: false, seasonBaselineValue: 6.0,
};
const fadeWin: MoundOutcome = {
  finalStrikeouts: 2, resolvedAt: "2026-07-01T23:30:00.000Z",
  outcome: "mound_fade_win", userVisible: true, seasonBaselineValue: 6.0,
};

// ── 1. Scheduled Follow target → visible via initial eligibility ────────────
ok(isPublicMoundSignal(sig({ gameStatus: "scheduled", status: "active" })) === true,
  "scheduled Follow target is visible (initial eligibility)");

// ── 2. Final + locked + flagged → visible (retention) ───────────────────────
ok(isPublicMoundSignal(sig({ gameStatus: "final", status: "locked", everPubliclyFlagged: true })) === true,
  "final-but-ungraded locked flagged Follow signal stays visible");

// ── 3. Graded Follow win + flagged → visible ────────────────────────────────
ok(isPublicMoundSignal(sig({ gameStatus: "final", status: "graded", outcomes: followWin, everPubliclyFlagged: true })) === true,
  "graded Follow win stays visible after grading");

// ── 4. Graded Follow MISS + flagged → STAYS VISIBLE (the retention fix) ──────
ok(isPublicMoundSignal(sig({ gameStatus: "final", status: "graded", outcomes: followMiss, everPubliclyFlagged: true })) === true,
  "graded Follow miss STAYS visible through the slate (completed, not erased)");

// ── 5. Postponed → hidden ───────────────────────────────────────────────────
ok(isPublicMoundSignal(sig({ gameStatus: "postponed", status: "locked", everPubliclyFlagged: true })) === false,
  "postponed games are never public");

// ── 6. Live + locked + flagged → visible ────────────────────────────────────
ok(isPublicMoundSignal(sig({ gameStatus: "live", status: "locked", everPubliclyFlagged: true })) === true,
  "live locked flagged Follow signal stays visible");

// ── 7. Live + active → hidden ───────────────────────────────────────────────
ok(isPublicMoundSignal(sig({ gameStatus: "live", status: "active", everPubliclyFlagged: true })) === false,
  "live game not yet locked is hidden");

// ── 8. Expired → hidden ─────────────────────────────────────────────────────
ok(isPublicMoundSignal(sig({ gameStatus: "final", status: "expired", everPubliclyFlagged: true })) === false,
  "expired status is hidden");

// ── 9. Cold-start never-flagged final/live locked → hidden ──────────────────
ok(isPublicMoundSignal(sig({ gameStatus: "final", status: "locked", everPubliclyFlagged: false })) === false,
  "cold-start final locked never-flagged Follow signal is hidden");
ok(isPublicMoundSignal(sig({ gameStatus: "live", status: "locked", everPubliclyFlagged: false })) === false,
  "cold-start live locked never-flagged Follow signal is hidden");

// ── 10. Fade is publicly ABSENT — pre-first-pitch AND after grading ─────────
// everPubliclyFlaggedFade reflects Fade *eligibility*, not actual public
// delivery, so it must NEVER grant visibility (that would surface a card the
// product never publicly showed — a candidate-volume change).
{
  const fadePre = sig({
    gameStatus: "scheduled", status: "active", moundDirection: "fade", tier: "track",
    everPubliclyFlagged: false, everPubliclyFlaggedFade: true, suppressed: true,
  });
  ok(isPublicMoundSignal(fadePre) === false, "a Fade candidate is never publicly surfaced pre-first-pitch");

  const fadeGradedWin = sig({
    gameStatus: "final", status: "graded", moundDirection: "fade", tier: "track",
    everPubliclyFlagged: false, everPubliclyFlaggedFade: true, outcomes: fadeWin,
  });
  ok(isPublicMoundSignal(fadeGradedWin) === false,
    "even a graded Fade WIN stays publicly absent — everPubliclyFlaggedFade never grants public retention");
}

// ── 11. flaggedBeforeFirstPitchMound reads the Follow flag only ─────────────
ok(flaggedBeforeFirstPitchMound(sig({ everPubliclyFlagged: true })) === true,
  "flaggedBeforeFirstPitchMound true when the Follow flag is set");
ok(flaggedBeforeFirstPitchMound(sig({ everPubliclyFlagged: false, everPubliclyFlaggedFade: true })) === false,
  "flaggedBeforeFirstPitchMound ignores everPubliclyFlaggedFade (Fade eligibility ≠ public delivery)");

console.log(`\nmound diagnostics.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
