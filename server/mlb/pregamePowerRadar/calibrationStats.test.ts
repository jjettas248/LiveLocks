// Pre-Game Power Radar — public stats + calibration stats invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/calibrationStats.test.ts

import { buildPublicStats, buildCalibrationStats } from "./calibrationStats";
import { wasPubliclyFlaggedPregame } from "./diagnostics";
import type { PregameOutcome, PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function makeSignal(over: {
  signalId: string;
  score10: number;
  tier?: PregamePowerSignal["tier"];
  outcome?: PregameOutcome | null;
  batterName?: string;
  drivers?: PregamePowerSignal["drivers"];
  becameLiveReady?: boolean;
  becameLiveFire?: boolean;
  suppressed?: boolean;
  lineupStatus?: PregamePowerSignal["lineupStatus"];
  gameStatus?: PregamePowerSignal["gameStatus"];
  everPubliclyFlagged?: boolean;
}): PregamePowerSignal {
  const signal = {
    signalId: over.signalId,
    sport: "mlb",
    engine: "pregame_power_radar",
    sessionDate: "2026-06-29",
    gameId: "g1",
    gameDate: "2026-06-29",
    startsAt: null,
    generatedAt: "2026-06-29T12:00:00Z",
    buildId: "ppr_stats_test",
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
    parkContext: null,
    score10: over.score10,
    tier: over.tier ?? "strong",
    drivers: over.drivers ?? [
      { key: "power", label: "Elite raw power", direction: "positive" },
      { key: "park", label: "HR park boost", direction: "positive" },
    ],
    warnings: [],
    tags: [],
    lineupStatus: over.lineupStatus ?? "posted",
    weatherStatus: "confirmed",
    gameStatus: over.gameStatus ?? "final",
    firstPitchLockEligible: true,
    lockedAt: "2026-06-29T17:00:00Z",
    hasMarketLine: false,
    isOfficialPlay: false,
    isPregameTarget: true,
    status: over.outcome ? "graded" : "locked",
    suppressed: over.suppressed ?? false,
    suppressedReasons: [],
    outcomes: over.outcome ?? null,
    everPubliclyFlagged: false, // placeholder — computed below from the real predicate
    becameLiveReady: over.becameLiveReady ?? false,
    becameLiveFire: over.becameLiveFire ?? false,
    convertedLiveAt: null,
    diagnostics: {
      dataCoverageScore: 0.9,
      rawInputsAvailable: { batterPower: true, lineup: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
  } as PregamePowerSignal;
  // Mirror `carryForwardGradedState`'s freeze: everPubliclyFlagged reflects
  // whether the intrinsic predicate was ever true, not a flat default — a
  // flat `false` would silently zero out every assertion below since
  // `rankedWinItems`/`buildCalibrationStats` now read this field directly.
  signal.everPubliclyFlagged = over.everPubliclyFlagged ?? wasPubliclyFlaggedPregame(signal);
  return signal;
}

const firstAbWin = makeSignal({
  signalId: "s-first",
  score10: 9.2,
  tier: "nuclear",
  batterName: "Aaron Judge",
  becameLiveReady: true,
  becameLiveFire: true,
  outcome: {
    hitHr: true,
    outcome: "pregame_win",
    userVisible: true,
    firstAbPregameWin: true,
    hrInning: 1,
    plateAppearanceNumber: 1,
  },
});

const normalWin = makeSignal({
  signalId: "s-win",
  score10: 8.4,
  tier: "elite",
  batterName: "Juan Soto",
  becameLiveReady: true,
  outcome: {
    hitHr: true,
    outcome: "pregame_win",
    userVisible: true,
    firstAbPregameWin: false,
    hrInning: 5,
    plateAppearanceNumber: 3,
  },
});

const miss = makeSignal({
  signalId: "s-miss",
  score10: 7.1,
  tier: "strong",
  outcome: { hitHr: false, outcome: "calibration_miss", userVisible: false },
});

// Still-live target: game hasn't gone final yet, so it stays on the visible
// radar (unlike `miss`, whose game already resolved and dropped out of view).
const pending = makeSignal({ signalId: "s-pending", score10: 6.4, tier: "strong", outcome: null, gameStatus: "live" });
const suppressedMiss = makeSignal({
  signalId: "s-hidden-miss",
  score10: 8.1,
  tier: "elite",
  suppressed: true,
  outcome: { hitHr: false, outcome: "calibration_miss", userVisible: false },
});

const today = [firstAbWin, normalWin, miss, pending, suppressedMiss];
const yesterdayWin = makeSignal({
  signalId: "s-yday",
  score10: 8.8,
  tier: "elite",
  batterName: "Shohei Ohtani",
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true, firstAbPregameWin: false },
});
yesterdayWin.sessionDate = "2026-06-28";

const publicStats = buildPublicStats(today, [...today, yesterdayWin], "2026-06-29");
ok(publicStats.pregameWinsToday === 2, "public stats count wins only today");
ok(publicStats.firstAbPregameWinsToday === 1, "public stats count first-AB subset today");
ok(publicStats.pregameWinsLast7Days === 3, "public stats count last-7 public wins");
ok(publicStats.flaggedBeforeFirstPitchToday === 3, "flagged count matches the visible/live radar total (wins + still-live), excluding resolved misses and suppressed");
ok(publicStats.topPregameWinPlayers.length === 2, "top players include public wins only");
ok(publicStats.topPregameWinPlayers.every((w) => !/miss/i.test(w.label) && !/loss/i.test(w.label)), "public win rows do not expose miss/loss labels");

const calibration = buildCalibrationStats(today, { startET: "2026-06-23", endET: "2026-06-29" });
ok(calibration.targets === 4, "calibration denominator includes all public targets");
ok(calibration.wins === 2, "calibration stats include public wins");
ok(calibration.calibrationMisses === 1, "calibration stats include calibration misses");
ok(calibration.hitRate === 66.7, "hitRate is wins over resolved public targets");
ok(calibration.firstAbWins === 1, "firstAbWins counted");
ok(calibration.firstAbWinRate === 33.3, "firstAbWinRate is first-AB wins over resolved public targets");
ok(calibration.byTier.nuclear.targets === 1 && calibration.byTier.nuclear.wins === 1, "byTier nuclear bucket correct");
ok(calibration.byTier.strong.targets === 2 && calibration.byTier.strong.misses === 1, "byTier strong bucket includes pending + miss");
ok(calibration.byScoreBand["9-10"].wins === 1, "byScoreBand 9-10 bucket correct");
ok(calibration.byScoreBand["7-8"].misses === 1, "byScoreBand 7-8 miss bucket correct");
ok(calibration.byDriver.power.targets === 4 && calibration.byDriver.power.wins === 2 && calibration.byDriver.power.misses === 1, "byDriver bucket correct");
ok(calibration.targetToLiveReadyRate === 50, "targetToLiveReadyRate math correct");
ok(calibration.targetToLiveFireRate === 25, "targetToLiveFireRate math correct");
ok(calibration.targetToHrRate === 66.7, "targetToHrRate matches resolved HR conversion");

const missPublic = buildPublicStats([miss], [miss], "2026-06-29");
ok(missPublic.pregameWinsToday === 0 && missPublic.topPregameWinPlayers.length === 0, "calibration_miss absent from public stats");
const missAdmin = buildCalibrationStats([miss], { startET: "2026-06-29", endET: "2026-06-29" });
ok(missAdmin.targets === 1 && missAdmin.calibrationMisses === 1, "calibration_miss contributes to admin stats");

// Regression: a target that was legitimately publicly flagged pregame, then
// had a mutable eligibility field (dataCoverageScore) dip below threshold by
// the time stats are read, must still count — this is the exact "Wins Today"
// undercount bug. wasPubliclyFlaggedPregame would evaluate false against the
// drifted diagnostics below; everPubliclyFlagged freezes the earlier true
// evaluation and must be what rankedWinItems/buildCalibrationStats read.
const driftedWin = makeSignal({
  signalId: "s-drifted",
  score10: 8.0,
  tier: "elite",
  batterName: "Drifted Win",
  everPubliclyFlagged: true,
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true, firstAbPregameWin: false },
});
(driftedWin.diagnostics as any).dataCoverageScore = 0.2;

const driftedStats = buildPublicStats([driftedWin], [driftedWin], "2026-06-29");
ok(driftedStats.pregameWinsToday === 1, "everPubliclyFlagged survives a later dataCoverageScore dip (Wins Today)");
ok(driftedStats.topPregameWinPlayers.length === 1, "drifted-but-flagged win still appears in the drawer's win list");

const driftedCalibration = buildCalibrationStats([driftedWin], { startET: "2026-06-29", endET: "2026-06-29" });
ok(driftedCalibration.targets === 1 && driftedCalibration.wins === 1, "drifted-but-flagged win still counts in admin calibration");

// Regression: an "unknown"-order win (AB-sequencing data was unavailable at
// grading time) must be excluded from firstAbWinRate's denominator entirely —
// it is neither a confirmed first-AB win nor a confirmed later-AB win, so
// counting it as if it were a confirmed non-first-AB result would silently
// understate the true rate whenever AB data is incomplete. Ordinary misses
// remain in the denominator exactly as before (they are never ambiguous).
const unknownOrderWin = makeSignal({
  signalId: "s-unknown-order",
  score10: 7.6,
  tier: "elite",
  batterName: "Unknown Order Win",
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true, firstAbPregameWin: "unknown" as any },
});
const knownFirstAbOrderWin = makeSignal({
  signalId: "s-known-first",
  score10: 7.4,
  tier: "elite",
  batterName: "Known First AB Win",
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true, firstAbPregameWin: true },
});
const knownLaterAbOrderWin = makeSignal({
  signalId: "s-known-later",
  score10: 7.2,
  tier: "elite",
  batterName: "Known Later AB Win",
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true, firstAbPregameWin: false },
});
const orderMiss = makeSignal({
  signalId: "s-order-miss",
  score10: 7.0,
  tier: "elite",
  outcome: { hitHr: false, outcome: "calibration_miss", userVisible: false, firstAbPregameWin: false },
});

const orderStats = buildCalibrationStats(
  [unknownOrderWin, knownFirstAbOrderWin, knownLaterAbOrderWin, orderMiss],
  { startET: "2026-06-29", endET: "2026-06-29" },
);
ok(orderStats.targets === 4, "unknown-order regression: all four targets counted");
ok(orderStats.wins === 3, "unknown-order regression: three wins (unknown + known-first + known-later)");
ok(orderStats.calibrationMisses === 1, "unknown-order regression: one miss");
ok(orderStats.firstAbWins === 1, "unknown-order regression: only the confirmed first-AB win counts as firstAbWins");
ok(orderStats.laterAbWins === 2, "unknown-order regression: known-later win + the miss both count as laterAbWins (miss is always definitively false)");
ok(orderStats.unknownOrderWins === 1, "unknown-order regression: exactly the one ambiguous win is tracked separately");
// resolvedCount = wins(3) + misses(1) = 4; knownOrderResolvedCount = 4 - unknownOrderWins(1) = 3
ok(orderStats.firstAbWinRate === 33.3, "unknown-order regression: rate excludes the unknown win from the denominator entirely, not just the numerator");

console.log(`\ncalibrationStats.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
