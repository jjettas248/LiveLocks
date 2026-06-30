// Pre-Game Power Radar — public stats + calibration stats invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/calibrationStats.test.ts

import { buildPublicStats, buildCalibrationStats } from "./calibrationStats";
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
    lineupStatus: over.lineupStatus ?? "confirmed",
    weatherStatus: "confirmed",
    gameStatus: "final",
    firstPitchLockEligible: true,
    lockedAt: "2026-06-29T17:00:00Z",
    hasMarketLine: false,
    isOfficialPlay: false,
    isPregameTarget: true,
    status: over.outcome ? "graded" : "locked",
    suppressed: over.suppressed ?? false,
    suppressedReasons: [],
    outcomes: over.outcome ?? null,
    becameLiveReady: over.becameLiveReady ?? false,
    becameLiveFire: over.becameLiveFire ?? false,
    convertedLiveAt: null,
    diagnostics: {
      dataCoverageScore: 0.9,
      rawInputsAvailable: { batterPower: true, lineup: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
  } as PregamePowerSignal;
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

const pending = makeSignal({ signalId: "s-pending", score10: 6.4, tier: "strong", outcome: null });
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
ok(publicStats.flaggedBeforeFirstPitchToday === 4, "flagged count includes public targets, including pending, excluding suppressed");
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

console.log(`\ncalibrationStats.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
