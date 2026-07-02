// Pre-Game Power Radar — Win Attribution invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/winAttribution.test.ts
//
// Product rule under test:
//   • A publicly-flagged pre-game target who homers → pregame_win (userVisible).
//   • A pre-game target who does NOT homer → calibration_miss (internal only).
//   • A homer that was NOT publicly flagged → pregame_win, NOT userVisible.
// Misses must NEVER surface as public losses or decrement a public record.

import {
  deriveWinAttribution,
  locateHrInPlayerABs,
  buildPregameRadarWinItem,
  buildDailyPregameWins,
  buildPregameWinsSectionMeta,
  type PlayerAbResult,
} from "./winAttribution";
import {
  FIRST_AB_PREGAME_WIN_LABEL,
  PREGAME_WIN_LABEL,
  FIRST_AB_PREGAME_WIN_COPY,
} from "../../../shared/pregameRadarWin";
import type { PregameOutcome, PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── locateHrInPlayerABs ───────────────────────────────────────────────────────
const abs3: PlayerAbResult[] = [
  { hitType: "single", inning: 1, half: "top" },
  { hitType: "home_run", inning: 4, half: "top" },
  { hitType: null, inning: 7, half: "top" },
];
const loc = locateHrInPlayerABs(abs3);
ok(loc != null, "locate finds the HR AB");
ok(loc?.plateAppearanceNumber === 2, "HR is the player's 2nd PA");
ok(loc?.firstAb === false, "2nd-PA HR is not a first-AB");
ok(loc?.inning === 4, "HR inning read from the AB feed");

const firstAbLoc = locateHrInPlayerABs([{ hitType: "home_run", inning: 1, half: "bottom" }]);
ok(firstAbLoc?.plateAppearanceNumber === 1, "first-PA HR → PA #1");
ok(firstAbLoc?.firstAb === true, "first-PA HR → firstAb true");

ok(locateHrInPlayerABs([]) === null, "empty ABs → null");
ok(locateHrInPlayerABs(null) === null, "null ABs → null (no-op)");
ok(locateHrInPlayerABs([{ hitType: "double" }]) === null, "no HR AB → null");

// ── deriveWinAttribution — miss is always calibration, never public ───────────
const miss = deriveWinAttribution({ hitHr: false, wasPubliclyFlagged: true });
ok(miss.outcome === "calibration_miss", "no HR → calibration_miss");
ok(miss.userVisible === false, "calibration_miss is NEVER userVisible (no public loss)");
ok(miss.hrInning === null && miss.plateAppearanceNumber === null, "miss carries no HR detail");
ok(miss.firstAbPregameWin === false, "miss is never a first-AB win");

// ── deriveWinAttribution — flagged hit is a public win ────────────────────────
const win = deriveWinAttribution({
  hitHr: true,
  wasPubliclyFlagged: true,
  priorABResults: [{ hitType: "home_run", inning: 1, half: "top" }],
});
ok(win.outcome === "pregame_win", "flagged HR → pregame_win");
ok(win.userVisible === true, "flagged HR win is userVisible");
ok(win.firstAbPregameWin === true, "1st-PA HR → firstAbPregameWin");
ok(win.plateAppearanceNumber === 1, "win carries PA number");
ok(win.hrInning === 1, "win carries HR inning");

// ── deriveWinAttribution — unflagged hit is internal, not public ──────────────
const internalWin = deriveWinAttribution({
  hitHr: true,
  wasPubliclyFlagged: false,
  priorABResults: [{ hitType: "home_run", inning: 3, half: "top" }],
});
ok(internalWin.outcome === "pregame_win", "unflagged HR still records pregame_win");
ok(internalWin.userVisible === false, "unflagged HR is NOT userVisible (won't leak to public log)");

// ── inning fallback chain: AB → play feed → canonical (with T/B normalize) ────
const fbPlay = deriveWinAttribution({
  hitHr: true,
  wasPubliclyFlagged: true,
  priorABResults: null,
  hrPlayInning: 6,
  hrPlayHalf: "bottom",
});
ok(fbPlay.hrInning === 6 && fbPlay.hrHalf === "bottom", "inning falls back to play feed");
ok(fbPlay.plateAppearanceNumber === null, "no AB feed → PA number unknown (null, not invented)");
ok(fbPlay.firstAbPregameWin === false, "no AB feed → cannot claim first-AB");

const fbCanon = deriveWinAttribution({
  hitHr: true,
  wasPubliclyFlagged: true,
  priorABResults: null,
  hrPlayInning: null,
  canonicalHitInning: 8,
  canonicalHitHalf: "T",
});
ok(fbCanon.hrInning === 8, "inning falls back to canonical hit");
ok(fbCanon.hrHalf === "top", "canonical half 'T' normalized → 'top'");

// ── Signal factory for builder tests ──────────────────────────────────────────
function makeSignal(over: {
  signalId: string;
  score10: number;
  outcome?: PregameOutcome;
  batterName?: string;
}): PregamePowerSignal {
  return {
    signalId: over.signalId,
    sport: "mlb",
    engine: "pregame_power_radar",
    sessionDate: "2026-06-29",
    gameId: "g1",
    gameDate: "2026-06-29",
    startsAt: null,
    generatedAt: "2026-06-29T12:00:00Z",
    buildId: "ppr_test",
    batterId: over.signalId,
    batterName: over.batterName ?? "Test Batter",
    team: "NYY",
    opponent: "BOS",
    pitcherId: "p1",
    pitcherName: "Opposing Ace",
    battingOrderSlot: 3,
    handednessMatchup: "R vs L",
    primaryMarket: "home_runs",
    marketTags: ["home_runs"],
    marketScores: {},
    marketSetups: [],
    parkContext: { venueName: "Yankee Stadium", temperatureF: 85, windMph: 12, windDirectionLabel: "Out", carryLabel: "HR Carry", carryType: "boost", driverText: null },
    score10: over.score10,
    tier: "strong",
    drivers: [
      { key: "power", label: "Elite raw power", direction: "positive" },
      { key: "park", label: "HR park boost", direction: "positive" },
      { key: "neg", label: "Tough lefty", direction: "negative" },
    ],
    warnings: [],
    tags: [],
    lineupStatus: "confirmed",
    weatherStatus: "confirmed",
    gameStatus: "final",
    firstPitchLockEligible: true,
    lockedAt: "2026-06-29T17:00:00Z",
    hasMarketLine: false,
    isOfficialPlay: false,
    isPregameTarget: true,
    status: "graded",
    suppressed: false,
    suppressedReasons: [],
    outcomes: over.outcome ?? null,
    becameLiveReady: false,
    becameLiveFire: false,
    convertedLiveAt: null,
    diagnostics: {} as any,
  } as PregamePowerSignal;
}

// ── buildPregameRadarWinItem — label/copy + null gating ───────────────────────
const firstAbSig = makeSignal({
  signalId: "s-first",
  score10: 9.1,
  batterName: "Aaron Judge",
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true, hrInning: 1, hrHalf: "bottom", plateAppearanceNumber: 1, firstAbPregameWin: true, resolvedAt: "2026-06-29T20:00:00Z" },
});
const firstItem = buildPregameRadarWinItem(firstAbSig, 1);
ok(firstItem != null, "userVisible win → item built");
ok(firstItem?.label === FIRST_AB_PREGAME_WIN_LABEL, "first-AB win → FIRST-AB PREGAME WIN label");
ok(firstItem?.cardCopy === FIRST_AB_PREGAME_WIN_COPY, "first-AB win → first-AB copy");
ok(firstItem?.pregamePowerScore === 9.1, "win item carries pregame power score");
ok(firstItem?.opposingPitcher === "Opposing Ace", "win item carries opposing pitcher");
ok(firstItem?.parkWeatherBoost === "HR Carry", "win item carries park/weather boost");
ok((firstItem?.pregameDrivers.length ?? 0) === 2, "win item carries only positive drivers");
ok(firstItem?.pregameRank === 1, "win item carries rank");

const laterSig = makeSignal({
  signalId: "s-later",
  score10: 7.5,
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true, hrInning: 5, hrHalf: "top", plateAppearanceNumber: 3, firstAbPregameWin: false, resolvedAt: "2026-06-29T21:00:00Z" },
});
const laterItem = buildPregameRadarWinItem(laterSig, 2);
ok(laterItem?.label === PREGAME_WIN_LABEL, "non-first-AB win → PREGAME RADAR WIN label");
ok(laterItem?.firstAbPregameWin === false, "non-first-AB win flagged false");

const missSig = makeSignal({
  signalId: "s-miss",
  score10: 8.0,
  outcome: { hitHr: false, outcome: "calibration_miss", userVisible: false },
});
ok(buildPregameRadarWinItem(missSig, 3) === null, "calibration_miss → no public item");

const internalSig = makeSignal({
  signalId: "s-internal",
  score10: 8.0,
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: false },
});
ok(buildPregameRadarWinItem(internalSig, 4) === null, "internal (unflagged) win → no public item");

// ── buildDailyPregameWins — grouping + rank order ─────────────────────────────
const grouped = buildDailyPregameWins([laterSig, firstAbSig, missSig, internalSig]);
ok(grouped.pregameRadarWins.length === 2, "only userVisible wins grouped (miss + internal excluded)");
ok(grouped.firstAbPregameWins.length === 1, "first-AB subset isolated");
ok(grouped.firstAbPregameWins[0].signalId === "s-first", "first-AB subset is the first-AB win");
ok(grouped.pregameRadarWins[0].signalId === "s-first", "wins ranked by pregame score desc");
ok(grouped.pregameRadarWins[0].pregameRank === 1 && grouped.pregameRadarWins[1].pregameRank === 2, "ranks assigned by score order");

// ── buildPregameRadarWinItem — canonical date attribution ─────────────────
// sessionDate is authoritative (already slateDateET()-stamped at build time);
// it must never be re-derived from the HR/settlement timestamp.
ok(firstItem?.slateDateET === "2026-06-29", "win item's slateDateET mirrors the signal's sessionDate, not resolvedAt");
ok(firstItem?.displayDateLabel === "Mon, Jun 29", "win item carries a pre-formatted display label");
ok(firstItem?.detectedBeforeFirstPitch === true, "win item marks detectedBeforeFirstPitch true (userVisible win implies pregame flag)");
ok(firstItem?.homeredInGame === true, "win item marks homeredInGame true");
ok(firstItem?.gameStartTimeET === null, "gameStartTimeET is null when the signal has no startsAt (test fixture)");

const withStart = makeSignal({
  signalId: "s-with-start",
  score10: 6.5,
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true, hrInning: 2, hrHalf: "top", plateAppearanceNumber: 1, firstAbPregameWin: true, resolvedAt: "2026-06-29T22:00:00Z" },
});
(withStart as any).startsAt = "2026-06-29T23:05:00.000Z";
const withStartItem = buildPregameRadarWinItem(withStart, 3);
ok(withStartItem?.gameStartTimeET != null, "gameStartTimeET is populated when startsAt is present");

// ── buildPregameWinsSectionMeta — dashboard title never implies "today" for a stale slate ──
const todayMeta = buildPregameWinsSectionMeta("2026-07-01", "2026-07-01");
ok(todayMeta.isToday === true, "same-day query is flagged isToday");
ok(todayMeta.titleLabel === "Pregame Radar Wins", "today's slate uses the plain 'Pregame Radar Wins' title");

const yesterdayMeta = buildPregameWinsSectionMeta("2026-06-30", "2026-07-01");
ok(yesterdayMeta.isToday === false, "prior-day query is not flagged isToday");
ok(yesterdayMeta.titleLabel === "Tue, Jun 30 Pregame Radar Wins", "stale slate's title is explicitly dated, never implying today");

console.log(`\nwinAttribution.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
