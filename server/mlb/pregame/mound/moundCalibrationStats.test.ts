// Mound Radar — public record + admin calibration stats invariants.
//
// Locks that a mound_fade_win signal (a) is fully separate from the
// Follow/Over win counters (buildMoundPublicStats' existing moundWinsToday/
// pitcherPropsCashedToday fields must never move when a Fade cashes), (b)
// lands in its own moundFadeWinsToday/fadePropsCashedToday fields, and (c)
// is excluded from the Follow-only top-line wins/hitRate and
// byTier/byScoreBand/byDriver/byMarket breakdowns in buildMoundCalibrationStats,
// surfacing only in the admin-only byDirection breakdown.
// Run: npx tsx server/mlb/pregame/mound/moundCalibrationStats.test.ts

import { buildMoundPublicStats, buildMoundCalibrationStats } from "./moundCalibrationStats";
import type { MoundSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseSignal(overrides: Partial<MoundSignal> = {}): MoundSignal {
  return {
    signalId: "mlb-mound:2026-07-03:1:100",
    sport: "mlb",
    engine: "mound_radar",
    sessionDate: "2026-07-03",
    gameId: "1",
    gameDate: "2026-07-03",
    startsAt: "2026-07-03T23:05:00Z",
    generatedAt: "2026-07-03T20:00:00Z",
    buildId: "b1",
    pitcherId: "100",
    pitcherName: "Test Pitcher",
    team: "DET",
    opponent: "CLE",
    throws: "R",
    opposingLineupConfirmed: true,
    opposingLineupLabel: "vs CLE confirmed lineup",
    primaryMarket: "pitcher_strikeouts",
    marketTags: ["pitcher_strikeouts", "pitcher_outs"],
    marketScores: {},
    marketSetups: [],
    parkContext: null,
    score10: 8.0,
    tier: "elite",
    moundDirection: "follow",
    drivers: [],
    warnings: [],
    tags: [],
    lineupStatus: "confirmed",
    weatherStatus: "estimated",
    gameStatus: "final",
    firstPitchLockEligible: false,
    lockedAt: null,
    hasMarketLine: false,
    isOfficialPlay: false,
    isPregameTarget: true,
    status: "graded",
    suppressed: false,
    suppressedReasons: [],
    outcomes: null,
    everPubliclyFlagged: true,
    everPubliclyFlaggedFade: false,
    becameLiveReady: false,
    becameLiveFire: false,
    convertedLiveAt: null,
    diagnostics: {} as MoundSignal["diagnostics"],
    ...overrides,
  };
}

// ── buildMoundPublicStats: a Fade win never moves the Follow/Over counters ──
const followWin = baseSignal({
  signalId: "s-follow-win", moundDirection: "follow", everPubliclyFlagged: true,
  outcomes: { outcome: "mound_win", userVisible: true },
});
const fadeWin = baseSignal({
  signalId: "s-fade-win", tier: "track", moundDirection: "fade",
  everPubliclyFlagged: false, everPubliclyFlaggedFade: true,
  outcomes: { outcome: "mound_fade_win", userVisible: true },
});

const publicStats = buildMoundPublicStats([followWin, fadeWin], [followWin, fadeWin], "2026-07-03");
ok(publicStats.moundWinsToday === 1, `moundWinsToday counts only the Follow win, not the Fade win (got ${publicStats.moundWinsToday})`);
ok(publicStats.pitcherPropsCashedToday === 1, "pitcherPropsCashedToday unaffected by the Fade win");
ok(publicStats.moundFadeWinsToday === 1, `moundFadeWinsToday counts the Fade win separately (got ${publicStats.moundFadeWinsToday})`);
ok(publicStats.fadePropsCashedToday === 1, "fadePropsCashedToday counts the Fade win");
ok(publicStats.moundWinsLast7Days === 1, "moundWinsLast7Days stays Follow-only");
ok(publicStats.moundFadeWinsLast7Days === 1, "moundFadeWinsLast7Days is the separate Fade 7-day count");
ok(publicStats.topMoundWinPlayers.length === 1 && publicStats.topMoundWinPlayers[0].signalId === "s-follow-win", "topMoundWinPlayers contains only the Follow win");
ok(publicStats.topMoundFadeWinPlayers.length === 1 && publicStats.topMoundFadeWinPlayers[0].signalId === "s-fade-win", "topMoundFadeWinPlayers contains only the Fade win");

// A Fade win with everPubliclyFlaggedFade=false must never appear even if userVisible somehow is true —
// rankedItems' flagging gate for "fade_win" must be everPubliclyFlaggedFade, not everPubliclyFlagged.
const fadeWinUnflagged = baseSignal({
  signalId: "s-fade-unflagged", tier: "track", moundDirection: "fade",
  everPubliclyFlagged: false, everPubliclyFlaggedFade: false,
  outcomes: { outcome: "mound_fade_win", userVisible: true },
});
const publicStats2 = buildMoundPublicStats([fadeWinUnflagged], [fadeWinUnflagged], "2026-07-03");
ok(publicStats2.topMoundFadeWinPlayers.length === 0, "a Fade win that was never everPubliclyFlaggedFade does not appear in topMoundFadeWinPlayers");

// ── buildMoundCalibrationStats: Fade signals never pollute the Follow-only breakdowns ──
const fadeMiss = baseSignal({
  signalId: "s-fade-miss", tier: "track", moundDirection: "fade",
  everPubliclyFlagged: false, everPubliclyFlaggedFade: true,
  outcomes: { outcome: "mound_calibration_miss", userVisible: false },
});
const calStats = buildMoundCalibrationStats([followWin, fadeWin, fadeMiss], { startET: "2026-07-01", endET: "2026-07-03" });

ok(calStats.targets === 1, `top-line targets stays Follow-only, excluding both Fade signals (got ${calStats.targets})`);
ok(calStats.wins === 1, "top-line wins stays Follow-only");
ok(calStats.calibrationMisses === 0, "the Fade miss is not counted in the Follow-only top-line calibrationMisses");
ok(!("track" in calStats.byTier), "byTier never gains a 'track' bucket from Fade signals (they are never everPubliclyFlagged)");

ok(calStats.byDirection.fade.targets === 2, `byDirection.fade counts both fade-flagged signals (got ${calStats.byDirection.fade.targets})`);
ok(calStats.byDirection.fade.wins === 1, "byDirection.fade.wins counts the fade win");
ok(calStats.byDirection.fade.misses === 1, "byDirection.fade.misses counts the fade miss");
ok(calStats.byDirection.fade.hitRate === 50, `byDirection.fade.hitRate is 1/2 = 50% (got ${calStats.byDirection.fade.hitRate})`);
ok(calStats.byDirection.follow.targets === 1, "byDirection.follow mirrors the top-line Follow-only targets");
ok(calStats.byDirection.follow.wins === 1, "byDirection.follow mirrors the top-line Follow-only wins");

console.log(`\nmoundCalibrationStats.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
