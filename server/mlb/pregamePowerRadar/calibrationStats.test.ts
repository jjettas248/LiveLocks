// Pre-Game Power Radar — public stats + calibration stats invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/calibrationStats.test.ts

import { buildPublicStats, buildCalibrationStats, buildAttackEnvironmentEliminationStats } from "./calibrationStats";
import { wasPubliclyFlaggedPregame } from "./diagnostics";
import { carryForwardGradedState } from "./gradedStateCarry";
import type { PregameOutcome, PregamePowerSignal } from "./types";
import { ATTACK_ENVIRONMENT_HOSTILE_SUPPRESSION_REASON, type AttackEnvironmentTier, type AttackEnvironmentCohort } from "./attackEnvironment";

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
  suppressedReasons?: string[];
  attackEnvironmentTier?: AttackEnvironmentTier;
  attackEnvironmentCohort?: AttackEnvironmentCohort;
  everAttackEnvironmentSuppressed?: boolean;
  attackEnvironmentSuppressedScore10?: number | null;
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
    suppressedReasons: over.suppressedReasons ?? [],
    outcomes: over.outcome ?? null,
    everPubliclyFlagged: false, // placeholder — computed below from the real predicate
    // Mirrors buildPregamePowerRadar.ts's own initial-construction default:
    // derived from suppressedReasons unless the test explicitly overrides it
    // (used to simulate a later rebuild where the live reason already dropped).
    everAttackEnvironmentSuppressed:
      over.everAttackEnvironmentSuppressed ?? (over.suppressedReasons ?? []).includes(ATTACK_ENVIRONMENT_HOSTILE_SUPPRESSION_REASON),
    attackEnvironmentSuppressedScore10:
      over.attackEnvironmentSuppressedScore10 !== undefined
        ? over.attackEnvironmentSuppressedScore10
        : (over.suppressedReasons ?? []).includes(ATTACK_ENVIRONMENT_HOSTILE_SUPPRESSION_REASON)
          ? over.score10
          : null,
    becameLiveReady: over.becameLiveReady ?? false,
    becameLiveFire: over.becameLiveFire ?? false,
    convertedLiveAt: null,
    diagnostics: {
      dataCoverageScore: 0.9,
      rawInputsAvailable: { batterPower: true, lineup: true, pitcherProfile: true, park: true, weather: true, bvp: false },
      attackEnvironmentTier: over.attackEnvironmentTier,
      attackEnvironmentCohort: over.attackEnvironmentCohort,
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
// flaggedBeforeFirstPitchToday now reads the durable frozen flag
// (everPubliclyFlagged), a stable historical count of "targets genuinely
// flagged before first pitch today" — so it includes resolved MISSES
// (firstAbWin + normalWin + miss + pending = 4) which are now retained/visible
// on the board too, and still excludes suppressed (never flagged).
ok(publicStats.flaggedBeforeFirstPitchToday === 4, "flaggedBeforeFirstPitchToday counts every durably-flagged target (wins + misses + still-live), excluding only suppressed/never-flagged");
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

// ── Attack Environment: byAttackEnvironmentTier / byAttackEnvironmentCohort ───
const aeEliteWin = makeSignal({
  signalId: "s-ae-elite", score10: 8.5, tier: "elite", everPubliclyFlagged: true,
  attackEnvironmentTier: "ELITE", attackEnvironmentCohort: "pitcher_and_environment",
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true },
});
const aeNeutralMiss = makeSignal({
  signalId: "s-ae-neutral", score10: 6.5, tier: "strong", everPubliclyFlagged: true,
  attackEnvironmentTier: "NEUTRAL", attackEnvironmentCohort: "neither",
  outcome: { hitHr: false, outcome: "calibration_miss", userVisible: false },
});
const aeStats = buildCalibrationStats([aeEliteWin, aeNeutralMiss], { startET: "2026-06-29", endET: "2026-06-29" });
ok(aeStats.byAttackEnvironmentTier.ELITE?.targets === 1 && aeStats.byAttackEnvironmentTier.ELITE?.wins === 1, "byAttackEnvironmentTier.ELITE bucket correct");
ok(aeStats.byAttackEnvironmentTier.NEUTRAL?.targets === 1 && aeStats.byAttackEnvironmentTier.NEUTRAL?.misses === 1, "byAttackEnvironmentTier.NEUTRAL bucket correct");
ok(aeStats.byAttackEnvironmentCohort.pitcher_and_environment?.wins === 1, "byAttackEnvironmentCohort.pitcher_and_environment bucket correct");
ok(aeStats.byAttackEnvironmentCohort.neither?.misses === 1, "byAttackEnvironmentCohort.neither bucket correct");

// byDriver already iterates only positive-direction drivers — this locks that
// an atkenv_* positive tag is picked up for free, while the negative
// "Hostile Attack Environment" driver key is excluded, with no new code path.
const aePositiveTagWin = makeSignal({
  signalId: "s-ae-tag-win", score10: 8.6, tier: "elite", everPubliclyFlagged: true,
  attackEnvironmentTier: "ELITE",
  drivers: [
    { key: "power", label: "Elite raw power", direction: "positive" },
    { key: "atkenv_power_env", label: "Power Environment", direction: "positive", weight: 0 },
    { key: "atkenv_hostile", label: "Hostile Attack Environment", direction: "negative", weight: 0 },
  ],
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true },
});
const aeDriverStats = buildCalibrationStats([aePositiveTagWin], { startET: "2026-06-29", endET: "2026-06-29" });
ok(aeDriverStats.byDriver.atkenv_power_env?.targets === 1 && aeDriverStats.byDriver.atkenv_power_env?.wins === 1, "byDriver picks up atkenv_power_env (positive) for free");
ok(aeDriverStats.byDriver.atkenv_hostile === undefined, "byDriver never buckets atkenv_hostile (negative direction, excluded by the existing positive-only filter)");

// ── buildAttackEnvironmentEliminationStats: matched comparison, HR-named fields ─
// All five signals below carry an attackEnvironmentTier (evaluated=5). Only
// three land in the matched [6.0, borderlineScore) band with no OTHER
// suppression reason (comparisonEligible=3) — the out-of-band elite win and
// the reason-unrelated suppression are both excluded from the comparison.
const suppressedBorderlineMiss = makeSignal({
  signalId: "s-elim-sup-miss", score10: 6.2, tier: "watch", everPubliclyFlagged: false,
  suppressedReasons: ["attack_environment_hostile_borderline"], attackEnvironmentTier: "HOSTILE",
  outcome: { hitHr: false, outcome: "calibration_miss", userVisible: false },
});
const suppressedBorderlineWin = makeSignal({
  signalId: "s-elim-sup-win", score10: 6.3, tier: "watch", everPubliclyFlagged: false,
  suppressedReasons: ["attack_environment_hostile_borderline"], attackEnvironmentTier: "HOSTILE",
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: false },
});
const retainedBorderlineWin = makeSignal({
  signalId: "s-elim-retained-win", score10: 6.1, tier: "strong", everPubliclyFlagged: true,
  suppressedReasons: [], attackEnvironmentTier: "NEUTRAL",
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true },
});
const outOfBandEliteWin = makeSignal({
  signalId: "s-elim-out-of-band", score10: 9.0, tier: "elite", everPubliclyFlagged: true,
  suppressedReasons: [], attackEnvironmentTier: "ELITE",
  outcome: { hitHr: true, outcome: "pregame_win", userVisible: true },
});
const unrelatedSuppressionInBand = makeSignal({
  signalId: "s-elim-unrelated", score10: 6.2, tier: "watch", everPubliclyFlagged: false,
  suppressedReasons: ["insufficient_drivers"], attackEnvironmentTier: "NEUTRAL",
  outcome: { hitHr: false, outcome: "calibration_miss", userVisible: false },
});

const elimStats = buildAttackEnvironmentEliminationStats([
  suppressedBorderlineMiss, suppressedBorderlineWin, retainedBorderlineWin, outOfBandEliteWin, unrelatedSuppressionInBand,
]);
ok(elimStats.evaluated === 5, `all five signals carry an attackEnvironmentTier (got ${elimStats.evaluated})`);
ok(elimStats.suppressedByAttackEnvironment === 2, `two signals suppressed by the attack-environment reason regardless of band (got ${elimStats.suppressedByAttackEnvironment})`);
ok(elimStats.comparisonEligible === 3, `matched band excludes the out-of-band elite win and the unrelated-reason suppression (got ${elimStats.comparisonEligible})`);
ok(elimStats.resolvedSuppressed === 2, `both borderline-suppressed signals are resolved (got ${elimStats.resolvedSuppressed})`);
ok(elimStats.retainedResolved === 1, `exactly one matched-band retained signal (got ${elimStats.retainedResolved})`);
ok(elimStats.suppressedHrWins === 1 && elimStats.suppressedHrMisses === 1, `suppressed side: 1 win, 1 miss (got wins=${elimStats.suppressedHrWins} misses=${elimStats.suppressedHrMisses})`);
ok(elimStats.suppressedHrHitRate === 50, `suppressed HR hit rate 50% (got ${elimStats.suppressedHrHitRate})`);
ok(elimStats.retainedHrWins === 1 && elimStats.retainedHrMisses === 0, `retained side: 1 win, 0 misses (got wins=${elimStats.retainedHrWins} misses=${elimStats.retainedHrMisses})`);
ok(elimStats.retainedHrHitRate === 100, `retained HR hit rate 100% (got ${elimStats.retainedHrHitRate})`);
// The whole point: a resolved signal that was NEVER publicly flagged is still
// counted — proves this view does not rely on everPubliclyFlagged.
ok(
  !suppressedBorderlineMiss.everPubliclyFlagged && !suppressedBorderlineWin.everPubliclyFlagged,
  "sanity: both suppressed fixtures are genuinely never-publicly-flagged",
);

// ── Regression: everAttackEnvironmentSuppressed survives a later rebuild ─────
// where suppressedReasons/score10 have drifted (weather resync, updated
// season stats). This is the exact bug flagged in PR review: suppressedReasons
// is recomputed live on every rebuild, so a candidate genuinely suppressed
// pre-lock could otherwise lose the reason string on a later rebuild and be
// silently miscounted as "retained." carryForwardGradedState must OR the
// frozen flag forward and preserve the ORIGINAL score10 snapshot, never the
// drifted one.
const prevSuppressed = makeSignal({
  signalId: "s-drift", score10: 6.2, tier: "watch", everPubliclyFlagged: false,
  suppressedReasons: [ATTACK_ENVIRONMENT_HOSTILE_SUPPRESSION_REASON], attackEnvironmentTier: "HOSTILE",
});
ok(prevSuppressed.everAttackEnvironmentSuppressed === true, "sanity: prev fixture starts genuinely suppressed");
ok(prevSuppressed.attackEnvironmentSuppressedScore10 === 6.2, "sanity: prev fixture's frozen snapshot is 6.2");

// Simulate a later rebuild: the environment flipped back to non-hostile, so
// THIS build's fresh recompute no longer includes the reason and score10 has
// drifted well outside the borderline band — exactly what a naive
// live-suppressedReasons read would misclassify as "retained."
const freshRebuild = makeSignal({
  signalId: "s-drift", score10: 7.8, tier: "strong", everPubliclyFlagged: false,
  suppressedReasons: [], attackEnvironmentTier: "NEUTRAL",
  everAttackEnvironmentSuppressed: false, attackEnvironmentSuppressedScore10: null,
});
ok(freshRebuild.suppressedReasons.length === 0, "sanity: fresh rebuild's live suppressedReasons no longer include the attack reason");

const carried = carryForwardGradedState({ ...freshRebuild }, prevSuppressed);
ok(carried.everAttackEnvironmentSuppressed === true, "carryForwardGradedState ORs the frozen flag forward despite the fresh rebuild's suppressedReasons losing the reason");
ok(carried.attackEnvironmentSuppressedScore10 === 6.2, "carryForwardGradedState preserves the ORIGINAL score10 snapshot (6.2), not the drifted live score10 (7.8)");
ok(carried.score10 === 7.8, "sanity: the live/current score10 itself is NOT overwritten by the freeze — only the dedicated snapshot field is");

// Feed the carried (post-drift) row into the shadow-elimination stats: it
// must still land on the suppressed side, using its frozen 6.2 snapshot for
// band membership — never excluded or reclassified as retained just because
// the live score10 (7.8) has since drifted out of the borderline band.
const driftStats = buildAttackEnvironmentEliminationStats([carried]);
ok(driftStats.suppressedByAttackEnvironment === 1, `drifted-but-frozen row still counts as attack-suppressed (got ${driftStats.suppressedByAttackEnvironment})`);
ok(driftStats.comparisonEligible === 1, `drifted row still lands in the matched band via its frozen snapshot, not its drifted live score10 (got ${driftStats.comparisonEligible})`);

console.log(`\ncalibrationStats.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
