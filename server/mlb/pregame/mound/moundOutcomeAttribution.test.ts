// Mound Radar — outcome attribution invariants (season-baseline settlement rule).
// Run: npx tsx server/mlb/pregame/mound/moundOutcomeAttribution.test.ts

import { deriveMoundOutcome, isMoundOutcomeGradeableNow, hasPitcherBeenPulled, buildMoundWinItem, buildMoundFadeWinItem, buildDailyMoundWins } from "./moundOutcomeAttribution";
import { MOUND_FADE_WIN_LABEL } from "../../../../shared/moundRadarWin";
import type { MoundSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── K-market: cashes when actual Ks meet/beat the season-baseline per-start rate ──
const kWin = deriveMoundOutcome({
  primaryMarket: "pitcher_strikeouts",
  finalStrikeouts: 8,
  finalOutsRecorded: null,
  seasonKPer9: 9.0, // baseline = 9.0 * 6/9 = 6.0
  seasonAvgInningsPerStart: null,
  wasPubliclyFlagged: true,
  moundDirection: "follow",
});
ok(kWin.outcome === "mound_win", "8 Ks vs baseline 6.0 → mound_win");
ok(kWin.userVisible === true, "publicly flagged win → userVisible");
ok(kWin.seasonBaselineValue === 6.0, `baseline computed as 6.0 (got ${kWin.seasonBaselineValue})`);

const kMiss = deriveMoundOutcome({
  primaryMarket: "pitcher_strikeouts",
  finalStrikeouts: 4,
  finalOutsRecorded: null,
  seasonKPer9: 9.0,
  seasonAvgInningsPerStart: null,
  wasPubliclyFlagged: true,
  moundDirection: "follow",
});
ok(kMiss.outcome === "mound_calibration_miss", "4 Ks vs baseline 6.0 → calibration_miss");
ok(kMiss.userVisible === false, "calibration miss is never userVisible");

// ── Outs-market: cashes when actual outs meet/beat season avg-outs-per-start ──
const outsWin = deriveMoundOutcome({
  primaryMarket: "pitcher_outs",
  finalStrikeouts: null,
  finalOutsRecorded: 21, // 7 IP
  seasonKPer9: null,
  seasonAvgInningsPerStart: 6.0, // baseline = 18 outs
  wasPubliclyFlagged: true,
  moundDirection: "follow",
});
ok(outsWin.outcome === "mound_win", "21 outs vs baseline 18 → mound_win");

// ── A target that homers/cashes but was NOT publicly flagged → internal win ──
const internalWin = deriveMoundOutcome({
  primaryMarket: "pitcher_strikeouts",
  finalStrikeouts: 10,
  finalOutsRecorded: null,
  seasonKPer9: 9.0,
  seasonAvgInningsPerStart: null,
  wasPubliclyFlagged: false,
  moundDirection: "follow",
});
ok(internalWin.outcome === "mound_win", "cashed but unflagged → still mound_win");
ok(internalWin.userVisible === false, "unflagged win is never public");

// ── Missing data never fabricates a win ───────────────────────────────────────
const noData = deriveMoundOutcome({
  primaryMarket: "pitcher_strikeouts",
  finalStrikeouts: null,
  finalOutsRecorded: null,
  seasonKPer9: null,
  seasonAvgInningsPerStart: null,
  wasPubliclyFlagged: true,
  moundDirection: "follow",
});
ok(noData.outcome === "mound_calibration_miss", "no data to verify → calibration_miss, never a fabricated win");
ok(noData.seasonBaselineValue === null, "no season rate → null baseline, not a guessed number");

// ── Fade direction: cashes when actual UNDERSHOOTS the baseline (opposite of Follow) ──
const fadeWin = deriveMoundOutcome({
  primaryMarket: "pitcher_strikeouts",
  finalStrikeouts: 4,
  finalOutsRecorded: null,
  seasonKPer9: 9.0, // baseline = 6.0
  seasonAvgInningsPerStart: null,
  wasPubliclyFlagged: true,
  moundDirection: "fade",
});
ok(fadeWin.outcome === "mound_fade_win", "Fade + 4 Ks under baseline 6.0 → mound_fade_win");
ok(fadeWin.userVisible === true, "publicly flagged fade win → userVisible");
ok(fadeWin.seasonBaselineValue === 6.0, `baseline computed as 6.0 (got ${fadeWin.seasonBaselineValue})`);

// ── Fade direction: the fade call was WRONG (actual met/beat baseline) → never a public loss ──
const fadeWrong = deriveMoundOutcome({
  primaryMarket: "pitcher_strikeouts",
  finalStrikeouts: 8,
  finalOutsRecorded: null,
  seasonKPer9: 9.0,
  seasonAvgInningsPerStart: null,
  wasPubliclyFlagged: true,
  moundDirection: "fade",
});
ok(fadeWrong.outcome === "mound_calibration_miss", "Fade + 8 Ks over baseline 6.0 (wrong fade call) → calibration_miss, never mound_win");

// ── Fade direction: missing data never fabricates a fade win ────────────────
const fadeNoData = deriveMoundOutcome({
  primaryMarket: "pitcher_strikeouts",
  finalStrikeouts: null,
  finalOutsRecorded: null,
  seasonKPer9: null,
  seasonAvgInningsPerStart: null,
  wasPubliclyFlagged: true,
  moundDirection: "fade",
});
ok(fadeNoData.outcome === "mound_calibration_miss", "Fade + no data to verify → calibration_miss, never a fabricated fade win");

// ── buildMoundWinItem returns null for non-userVisible outcomes ──────────────
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

const notVisible = baseSignal({ outcomes: { outcome: "mound_win", userVisible: false } });
ok(buildMoundWinItem(notVisible, 1) === null, "non-userVisible win → null win item");

const missSignal = baseSignal({ outcomes: { outcome: "mound_calibration_miss", userVisible: false } });
ok(buildMoundWinItem(missSignal, 1) === null, "calibration miss → null win item");

const visibleWin = baseSignal({ outcomes: { outcome: "mound_win", userVisible: true } });
const item = buildMoundWinItem(visibleWin, 3);
ok(item !== null, "userVisible win → win item built");
ok(item?.moundRank === 3, "rank passed through");
ok(item?.playerName === "Test Pitcher", "playerName mapped from pitcherName");

// ── buildDailyMoundWins ranks by score10 desc, includes only visible wins ────
const s1 = baseSignal({ signalId: "s1", score10: 7.0, outcomes: { outcome: "mound_win", userVisible: true } });
const s2 = baseSignal({ signalId: "s2", score10: 9.0, outcomes: { outcome: "mound_win", userVisible: true } });
const s3 = baseSignal({ signalId: "s3", score10: 8.0, outcomes: { outcome: "mound_calibration_miss", userVisible: false } });
const daily = buildDailyMoundWins([s1, s2, s3]);
ok(daily.moundRadarWins.length === 2, "only the 2 userVisible wins appear");
ok(daily.moundRadarWins[0].signalId === "s2", "highest score ranked first");

// ── buildMoundFadeWinItem is fully separate from buildMoundWinItem ───────────
const fadeVisibleWin = baseSignal({
  moundDirection: "fade", everPubliclyFlaggedFade: true,
  outcomes: { outcome: "mound_fade_win", userVisible: true },
});
ok(buildMoundWinItem(fadeVisibleWin, 1) === null, "a mound_fade_win outcome is never picked up by buildMoundWinItem (Follow-only)");
const fadeItem = buildMoundFadeWinItem(fadeVisibleWin, 1);
ok(fadeItem !== null, "userVisible fade win → fade win item built");
ok(fadeItem?.label === MOUND_FADE_WIN_LABEL, "fade win item uses the distinct MOUND_FADE_WIN_LABEL, never the Follow/Over label");

const followWinNotFade = baseSignal({
  moundDirection: "follow",
  outcomes: { outcome: "mound_win", userVisible: true },
});
ok(buildMoundFadeWinItem(followWinNotFade, 1) === null, "a mound_win outcome is never picked up by buildMoundFadeWinItem (Fade-only)");

// ── isMoundOutcomeGradeableNow: live-grading settlement-timing gate ──────────
// A Follow/Over mound_win is monotonic-safe to grade the moment the box
// score confirms it (strikeouts/outs-recorded only climb during a start);
// everything else must wait for outingComplete (game final OR pitcher pulled).
ok(isMoundOutcomeGradeableNow(false, "mound_win") === true, "outing not complete + mound_win → gradeable now");
ok(isMoundOutcomeGradeableNow(false, "mound_fade_win") === false, "outing not complete + mound_fade_win → not yet gradeable");
ok(isMoundOutcomeGradeableNow(false, "mound_calibration_miss") === false, "outing not complete + calibration_miss → not yet gradeable");
ok(isMoundOutcomeGradeableNow(true, "mound_win") === true, "outingComplete + mound_win → gradeable");
ok(isMoundOutcomeGradeableNow(true, "mound_fade_win") === true, "outingComplete + mound_fade_win → gradeable");
ok(isMoundOutcomeGradeableNow(true, "mound_calibration_miss") === true, "outingComplete + calibration_miss → gradeable");

// ── hasPitcherBeenPulled: appearance-order-based outing-complete detection ───
ok(hasPitcherBeenPulled("100", null) === false, "no appearance order data → not pulled (never fabricate certainty)");
ok(hasPitcherBeenPulled("100", []) === false, "empty appearance order → not pulled");
ok(hasPitcherBeenPulled("100", ["100"]) === false, "sole/last entry in order → still the active pitcher, not pulled");
ok(hasPitcherBeenPulled("100", ["100", "200"]) === true, "a later pitcher appears after this one → pulled");
ok(hasPitcherBeenPulled("100", ["100", "200", "300"]) === true, "multiple relievers since → pulled");
ok(hasPitcherBeenPulled("999", ["100", "200"]) === false, "pitcher not present in order at all → not pulled (hasn't recorded a line)");
ok(hasPitcherBeenPulled("200", ["100", "200"]) === false, "most recent entry → currently active, not pulled");

console.log(`\nmoundOutcomeAttribution.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
