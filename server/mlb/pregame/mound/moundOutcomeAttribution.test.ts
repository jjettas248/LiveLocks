// Mound Radar — outcome attribution invariants (season-baseline settlement rule).
// Run: npx tsx server/mlb/pregame/mound/moundOutcomeAttribution.test.ts

import {
  deriveMoundOutcome,
  deriveMoundMarketOutcome,
  deriveModelOutcomeLabel,
  buildMoundSettlementView,
  isMoundOutcomeGradeableNow,
  hasPitcherBeenPulled,
  buildMoundWinItem,
  buildMoundFadeWinItem,
  buildDailyMoundWins,
} from "./moundOutcomeAttribution";
import { MOUND_FADE_WIN_LABEL, MOUND_WIN_COPY, MOUND_FADE_WIN_COPY } from "../../../../shared/moundRadarWin";
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

// ── deriveMoundMarketOutcome: market settlement, SIBLING to deriveMoundOutcome ──
// Follow + real frozen line: cashes when actual clears OVER, missed when it doesn't, push on exact tie.
const followCash = deriveMoundMarketOutcome({
  moundDirection: "follow",
  frozenLine: { line: 5.5, lineUnavailableReason: null, sportsbook: "DraftKings" },
  lineFrozenAt: "2026-07-03T18:00:00Z",
  actual: 7,
});
ok(followCash.marketOutcome === "cashed", "Follow + actual 7 over line 5.5 → cashed");
ok(followCash.recommendedSide === "OVER", "Follow → recommendedSide OVER");
ok(followCash.sportsbookLine === 5.5, "sportsbookLine passed through");
ok(followCash.lineSnapshotType === "final_pregame", "lineSnapshotType stamped when a real line resolves");
ok(followCash.lineFrozenAt === "2026-07-03T18:00:00Z", "lineFrozenAt passed through");
ok(followCash.lineSource === "DraftKings", "lineSource passed through from frozen postedLine.sportsbook");

const followMiss = deriveMoundMarketOutcome({
  moundDirection: "follow",
  frozenLine: { line: 5.5, lineUnavailableReason: null },
  lineFrozenAt: "2026-07-03T18:00:00Z",
  actual: 4,
});
ok(followMiss.marketOutcome === "missed", "Follow + actual 4 under line 5.5 → missed");
ok(followMiss.lineSource === null, "lineSource null when frozenLine has no sportsbook field");

const followPush = deriveMoundMarketOutcome({
  moundDirection: "follow",
  frozenLine: { line: 6, lineUnavailableReason: null },
  lineFrozenAt: "2026-07-03T18:00:00Z",
  actual: 6,
});
ok(followPush.marketOutcome === "push", "Follow + actual === line (exact tie) → push (real market push)");

// Fade: opposite comparison — cashes when actual lands UNDER the line.
const fadeCash = deriveMoundMarketOutcome({
  moundDirection: "fade",
  frozenLine: { line: 6.5, lineUnavailableReason: null },
  lineFrozenAt: "2026-07-03T18:00:00Z",
  actual: 4,
});
ok(fadeCash.marketOutcome === "cashed", "Fade + actual 4 under line 6.5 → cashed");
ok(fadeCash.recommendedSide === "UNDER", "Fade → recommendedSide UNDER");

const fadeMiss = deriveMoundMarketOutcome({
  moundDirection: "fade",
  frozenLine: { line: 6.5, lineUnavailableReason: null },
  lineFrozenAt: "2026-07-03T18:00:00Z",
  actual: 8,
});
ok(fadeMiss.marketOutcome === "missed", "Fade + actual 8 over line 6.5 (wrong fade call) → missed");

const fadePush = deriveMoundMarketOutcome({
  moundDirection: "fade",
  frozenLine: { line: 6, lineUnavailableReason: null },
  lineFrozenAt: "2026-07-03T18:00:00Z",
  actual: 6,
});
ok(fadePush.marketOutcome === "push", "Fade + exact tie → push");

// Unavailable: no line, no direction, no actual — never fabricated, never a guessed side.
const noLine = deriveMoundMarketOutcome({
  moundDirection: "follow",
  frozenLine: { line: null, lineUnavailableReason: "no_line_posted" },
  lineFrozenAt: null,
  actual: 7,
});
ok(noLine.marketOutcome === "unavailable", "no posted line → unavailable");
ok(noLine.lineSnapshotType === null, "no provenance stamped when line is unavailable");

const noDirection = deriveMoundMarketOutcome({
  moundDirection: null,
  frozenLine: { line: 5.5, lineUnavailableReason: null },
  lineFrozenAt: "2026-07-03T18:00:00Z",
  actual: 7,
});
ok(noDirection.marketOutcome === "unavailable", "unresolved direction → unavailable (never guesses a side, stricter than deriveMoundOutcome's Follow-default)");
ok(noDirection.recommendedSide === null, "unresolved direction → null recommendedSide");

const noActual = deriveMoundMarketOutcome({
  moundDirection: "follow",
  frozenLine: { line: 5.5, lineUnavailableReason: null },
  lineFrozenAt: "2026-07-03T18:00:00Z",
  actual: null,
});
ok(noActual.marketOutcome === "unavailable", "no final actual stat → unavailable");

// ── deriveModelOutcomeLabel: additive display-only relabel, never mutates deriveMoundOutcome ──
ok(deriveModelOutcomeLabel(7, 6.0, "follow") === "confirmed", "Follow + actual over baseline → confirmed");
ok(deriveModelOutcomeLabel(4, 6.0, "follow") === "not_confirmed", "Follow + actual under baseline → not_confirmed");
ok(deriveModelOutcomeLabel(6.0, 6.0, "follow") === "push", "Follow + exact baseline tie → push (baseline-tie, renders as 'Matched Engine Baseline' at the label layer, never literal 'Push')");
ok(deriveModelOutcomeLabel(4, 6.0, "fade") === "confirmed", "Fade + actual under baseline → confirmed");
ok(deriveModelOutcomeLabel(7, 6.0, "fade") === "not_confirmed", "Fade + actual over baseline → not_confirmed");
ok(deriveModelOutcomeLabel(null, 6.0, "follow") === null, "missing actual → null, never guessed");
ok(deriveModelOutcomeLabel(7, null, "follow") === null, "missing baseline → null");
ok(deriveModelOutcomeLabel(7, 6.0, null) === null, "unresolved direction → null");

// ── buildMoundSettlementView: the public contract, computed from persisted outcomes ──
const settledCashed = buildMoundSettlementView(
  {
    outcome: "mound_win",
    userVisible: true,
    seasonBaselineValue: 6.0,
    finalStrikeouts: 7,
    marketOutcome: "cashed",
    sportsbookLine: 6.5,
    recommendedSide: "OVER",
  },
  "pitcher_strikeouts",
  "follow",
  /* everPubliclyFlagged */ true,
  /* everPubliclyFlaggedFade */ false,
);
ok(settledCashed.modelOutcome === "confirmed", "settlement view: modelOutcome derived independently of persisted `outcome`/`userVisible`");
ok(settledCashed.modelBaseline === 6.0, "settlement view: modelBaseline mirrors seasonBaselineValue");
ok(settledCashed.marketOutcome === "cashed", "settlement view: marketOutcome passed through");
ok(settledCashed.sportsbookLine === 6.5, "settlement view: sportsbookLine passed through");
ok(settledCashed.finalStat === 7, "settlement view: finalStat resolves finalStrikeouts for pitcher_strikeouts");
ok(settledCashed.isPublicRecommendation === true, "settlement view: isPublicRecommendation true for a flagged Follow signal");

const settledOutsUnavailable = buildMoundSettlementView(
  { seasonBaselineValue: 18, finalOutsRecorded: 21 },
  "pitcher_outs",
  "follow",
  false,
  false,
);
ok(settledOutsUnavailable.marketOutcome === "unavailable", "settlement view: absent persisted marketOutcome defaults to unavailable — never fabricated");
ok(settledOutsUnavailable.finalStat === 21, "settlement view: finalStat resolves finalOutsRecorded for pitcher_outs");
ok(settledOutsUnavailable.modelOutcome === "confirmed", "settlement view: modelOutcome still computable from baseline alone when market is unavailable");

const ungraded = buildMoundSettlementView(null, "pitcher_strikeouts", "follow", false, false);
ok(ungraded.modelOutcome === null, "settlement view: null outcomes → null modelOutcome, never fabricated");
ok(ungraded.marketOutcome === "unavailable", "settlement view: null outcomes → unavailable marketOutcome");
ok(ungraded.finalStat === null, "settlement view: null outcomes → null finalStat");
ok(ungraded.isPublicRecommendation === false, "settlement view: never-flagged signal → isPublicRecommendation false");

// ── Codex-flagged fix #1: isPublicRecommendation is independent of outcomes.userVisible ──
// A genuinely public Follow recommendation whose FINAL stat beats the real
// market line (cashed) but MISSES the season baseline is exactly the case
// deriveMoundOutcome stamps userVisible=false for (mound_calibration_miss is
// never userVisible, regardless of wasPubliclyFlagged) — the settlement view
// must still report this as a public, settled result so the card renders the
// market result instead of silently reverting to an unfinished-setup look.
const publicButBaselineMissed = buildMoundSettlementView(
  {
    outcome: "mound_calibration_miss", // baseline missed → deriveMoundOutcome always stamps userVisible false here
    userVisible: false,
    seasonBaselineValue: 7.0,
    finalStrikeouts: 6,
    marketOutcome: "cashed", // but the real market line (5.5) was cleared
    sportsbookLine: 5.5,
    recommendedSide: "OVER",
  },
  "pitcher_strikeouts",
  "follow",
  /* everPubliclyFlagged */ true, // this WAS a genuine public Follow recommendation
  false,
);
ok(
  publicButBaselineMissed.isPublicRecommendation === true,
  "isPublicRecommendation stays true for a publicly-flagged signal even when the internal baseline comparison missed (userVisible=false on the model outcome)",
);
ok(publicButBaselineMissed.marketOutcome === "cashed", "the market result (cashed) is preserved and readable even though the model outcome missed its baseline");
ok(publicButBaselineMissed.modelOutcome === "not_confirmed", "the model-side view still honestly reports the baseline miss — the two concepts diverge without either being suppressed");

// A signal that was NEVER a public recommendation must stay non-public even
// if its (never-shown) market/baseline numbers would have cashed — only the
// durable flag decides visibility, not any grading outcome.
const neverPublicButWouldHaveCashed = buildMoundSettlementView(
  { outcome: "mound_win", userVisible: false, seasonBaselineValue: 6.0, finalStrikeouts: 8, marketOutcome: "cashed", sportsbookLine: 6.5, recommendedSide: "OVER" },
  "pitcher_strikeouts",
  "follow",
  /* everPubliclyFlagged */ false,
  false,
);
ok(neverPublicButWouldHaveCashed.isPublicRecommendation === false, "a signal never flagged publicly stays non-public regardless of how favorably it would have graded");

// ── Codex-flagged fix #2: recommendedSide falls back to moundDirection for legacy/non-backfilled rows ──
// A legacy Fade row that predates the market-settlement feature (or one the
// backfill couldn't resolve, no frozen line ever existed) has no persisted
// outcomes.recommendedSide at all — the fallback must still read Fade, never
// silently default to Follow wording.
const legacyFadeNoRecommendedSide = buildMoundSettlementView(
  {
    outcome: "mound_fade_win",
    userVisible: true,
    seasonBaselineValue: 6.0,
    finalStrikeouts: 4,
    // marketOutcome/sportsbookLine/recommendedSide all absent — legacy row
  },
  "pitcher_strikeouts",
  "fade",
  false,
  /* everPubliclyFlaggedFade */ true,
);
ok(legacyFadeNoRecommendedSide.recommendedSide === "UNDER", "legacy Fade row with no persisted recommendedSide falls back to UNDER via the pinned moundDirection, never defaults to Follow/OVER");
ok(legacyFadeNoRecommendedSide.marketOutcome === "unavailable", "legacy row still correctly reports market data as unavailable — only the side fallback is fixed, not fabricated market data");
ok(legacyFadeNoRecommendedSide.isPublicRecommendation === true, "legacy Fade row's public status still resolves correctly via everPubliclyFlaggedFade");

// A legacy FOLLOW row with no persisted recommendedSide must fall back to OVER (the symmetric case).
const legacyFollowNoRecommendedSide = buildMoundSettlementView(
  { outcome: "mound_win", userVisible: true, seasonBaselineValue: 6.0, finalStrikeouts: 8 },
  "pitcher_strikeouts",
  "follow",
  true,
  false,
);
ok(legacyFollowNoRecommendedSide.recommendedSide === "OVER", "legacy Follow row with no persisted recommendedSide falls back to OVER via the pinned moundDirection");

// ── No regression to internal baseline calibration semantics ─────────────────
// The two fixes above (isPublicRecommendation, recommendedSide fallback) are
// purely additive to the NEW settlement-view contract — they must never
// change modelOutcome/modelBaseline, which are derived solely from
// seasonBaselineValue/finalStat/moundDirection, untouched by either fix.
ok(publicButBaselineMissed.modelBaseline === 7.0, "modelBaseline is untouched by the isPublicRecommendation fix — still mirrors seasonBaselineValue exactly");
ok(legacyFadeNoRecommendedSide.modelOutcome === "confirmed", "modelOutcome (4 Ks under 6.0 baseline, Fade) is untouched by the recommendedSide fallback fix");

// ── Locked product rule: model-only aggregate copy never says "Cashed" ──────
// "Cashed" is reserved exclusively for a real market-graded result — these
// two constants back the model-baseline daily win/fade-win log copy, which
// must never use that word (see MoundWinCard.tsx for the client-side
// equivalent check).
ok(!/cashed/i.test(MOUND_WIN_COPY), `MOUND_WIN_COPY never contains "cashed" (got: "${MOUND_WIN_COPY}")`);
ok(!/cashed/i.test(MOUND_FADE_WIN_COPY), `MOUND_FADE_WIN_COPY never contains "cashed" (got: "${MOUND_FADE_WIN_COPY}")`);

console.log(`\nmoundOutcomeAttribution.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
