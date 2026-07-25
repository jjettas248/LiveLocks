// The Plate — champion vs challenger outcome analytics.
//
// Guards:
//   1. Exposure is compared sticky-to-sticky (everPubliclyFlagged vs
//      everPubliclyEligible), never per-build publicEligible, never !suppressed.
//   2. HR and Total Bases are counted separately and never blended.
//   3. Rows without a frozen comparison are reported as unavailable, never
//      silently scored as "the challenger declined".
//   4. Winner/loss buckets and recall math.
//
// Run: npx tsx server/mlb/pregamePowerRadar/plateModelComparisonStats.test.ts

import { buildPlateModelComparisonReport } from "./plateModelComparisonStats";
import type { PregamePowerSignal } from "./types";
import type { PlateModelComparisonRecord } from "./plateModelComparison";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const RANGE = { startET: "2026-07-20", endET: "2026-07-24" };

function comparison(over: {
  challengerPublicEligible?: boolean;
  challengerEverPubliclyEligible?: boolean;
  challengerMarket?: string;
  tierChanged?: boolean;
  marketChanged?: boolean;
  attribution?: string[];
} = {}): PlateModelComparisonRecord {
  return {
    championVersion: "plate_jul20_restored_v1",
    challengerVersion: "plate_current_shadow_v1",
    frozenInputHash: "abc123",
    champion: {
      score10: 7.2, tier: "strong", suppressed: false, suppressedReasons: [],
      primaryMarket: "home_runs", pitcherVulnerabilityScore: 7, batterPowerScore: 8,
      positiveDriverCount: 3, evidenceFamilyCount: 3,
      publicEligible: true, publicIneligibleReasons: [],
    },
    challenger: {
      score10: 6.4, tier: over.tierChanged ? "watch" : "strong", suppressed: false, suppressedReasons: [],
      primaryMarket: over.challengerMarket ?? "home_runs",
      pitcherVulnerabilityScore: 6, batterPowerScore: 7,
      positiveDriverCount: 3, evidenceFamilyCount: 2,
      publicEligible: over.challengerPublicEligible ?? true,
      publicIneligibleReasons: [],
      everPubliclyEligible: over.challengerEverPubliclyEligible ?? over.challengerPublicEligible ?? true,
      firstPublicEligibleAt: "2026-07-24T16:00:00.000Z",
    },
    delta: {
      score10: -0.8,
      publicDecisionChanged: (over.challengerPublicEligible ?? true) === false,
      tierChanged: over.tierChanged ?? false,
      marketChanged: over.marketChanged ?? false,
    },
    attribution: (over.attribution ?? ["batter_sample_shrinkage"]) as any,
  };
}

function sig(over: Partial<PregamePowerSignal> & { comparison?: PlateModelComparisonRecord | null }): PregamePowerSignal {
  const { comparison: cmp, ...rest } = over;
  return {
    signalId: "mlb-pregame:2026-07-24:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-24", gameId: "g1", gameDate: "2026-07-24", startsAt: null,
    generatedAt: "", buildId: "b", batterId: "b1", batterName: "Batter", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    score10: 7.2, tier: "strong",
    drivers: [
      { key: "power_iso", label: "Elite Isolated Power", direction: "positive" },
      { key: "pv_hr9", label: "Pitcher Yields HR vs RHB", direction: "positive" },
    ],
    warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "final", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "graded", suppressed: false, suppressedReasons: [],
    outcomes: null, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    everPubliclyFlagged: true,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
      modelComparison: cmp === undefined ? comparison() : cmp,
    } as any,
    ...rest,
  } as PregamePowerSignal;
}

// ── 1. Sticky-to-sticky exposure ──────────────────────────────────────────────
{
  // The challenger is NOT eligible on this final build, but WAS earlier. It must
  // count as called — this is the whole reason everPubliclyEligible exists.
  const s = sig({
    signalId: "s1",
    outcomes: { hitHr: true, totalBases: 4 } as any,
    comparison: comparison({ challengerPublicEligible: false, challengerEverPubliclyEligible: true }),
  });
  const r = buildPlateModelComparisonReport([s], RANGE);
  ok(r.challenger.publicCandidates === 1, "[1] a challenger that dipped by the final build still counts as called");
  ok(r.recall.challengerCalledHrs === 1, "[1] its HR counts toward challenger recall");
  ok(r.winnerLossAnalysis.bothCalled === 1, "[1] both models called it");
  ok(r.disagreements.total === 0, "[1] no exposure disagreement — the sticky flags agree");
}
{
  // Genuinely never eligible → genuinely not called.
  const s = sig({
    signalId: "s2",
    outcomes: { hitHr: true, totalBases: 4 } as any,
    comparison: comparison({ challengerPublicEligible: false, challengerEverPubliclyEligible: false }),
  });
  const r = buildPlateModelComparisonReport([s], RANGE);
  ok(r.challenger.publicCandidates === 0, "[1] a never-eligible challenger is not counted");
  ok(r.winnerLossAnalysis.championKeptChallengerRemoved === 1, "[1] champion kept a winner the challenger removed");
  ok(r.lostWinners.length === 1 && r.lostWinners[0].signalId === "s2", "[1] the lost winner is itemized");
  ok(r.lostWinners[0].attribution.includes("batter_sample_shrinkage" as any), "[1] the lost winner carries its attribution");
}
{
  // Champion hidden, challenger called, and it homered → a gained winner.
  const s = sig({
    signalId: "s3",
    everPubliclyFlagged: false,
    outcomes: { hitHr: true, totalBases: 4 } as any,
    comparison: comparison({ challengerPublicEligible: true }),
  });
  const r = buildPlateModelComparisonReport([s], RANGE);
  ok(r.champion.publicCandidates === 0 && r.challenger.publicCandidates === 1, "[1] exposure read independently per model");
  ok(r.winnerLossAnalysis.challengerAddedChampionMissed === 1, "[1] challenger added a winner the champion missed");
  ok(r.gainedWinners.length === 1, "[1] the gained winner is itemized");
  ok(r.recall.uncalledHrs === 0, "[1] an HR called by either model is not 'uncalled'");
}
{
  // Champion hidden, challenger called, and it did NOT homer → an added loser.
  const s = sig({
    signalId: "s4",
    everPubliclyFlagged: false,
    outcomes: { hitHr: false, totalBases: 0 } as any,
    comparison: comparison({ challengerPublicEligible: true }),
  });
  const r = buildPlateModelComparisonReport([s], RANGE);
  ok(r.addedLosers.length === 1, "[1] a non-homering challenger-only call is an added loser");
  ok(r.winnerLossAnalysis.challengerAddedChampionMissed === 0, "[1] it is not counted as a gained winner");
}

// ── 2. HR and TB never blended ────────────────────────────────────────────────
{
  const hrWin = sig({ signalId: "hr1", primaryMarket: "home_runs", outcomes: { hitHr: true, tbOutcome: "tb_success" } as any });
  const tbCard = sig({
    signalId: "tb1", primaryMarket: "total_bases",
    outcomes: { hitHr: false, tbOutcome: "tb_success" } as any,
    comparison: comparison({ challengerMarket: "total_bases" }),
  });
  const r = buildPlateModelComparisonReport([hrWin, tbCard], RANGE);
  ok(r.champion.hr.calls === 1 && r.champion.hr.hits === 1, "[2] HR bucket counts only the HR-primary card");
  ok(r.champion.tb.calls === 1 && r.champion.tb.hits === 1, "[2] TB bucket counts only the TB-primary card");
  ok(r.champion.hr.hitRate === 100 && r.champion.tb.hitRate === 100, "[2] rates computed per market");
  // The HR card's tb_success must NOT leak into the TB bucket.
  ok(r.champion.tb.calls === 1, "[2] an HR-primary card's tbOutcome never inflates TB calls");
  ok(r.champion.publicCandidates === 2, "[2] both count once toward public candidates");
}
{
  // A TB-primary card that homered: the HR still counts for recall, but the
  // card's market record stays TB.
  const s = sig({ signalId: "tb2", primaryMarket: "total_bases", outcomes: { hitHr: true, tbOutcome: "tb_success" } as any, comparison: comparison({ challengerMarket: "total_bases" }) });
  const r = buildPlateModelComparisonReport([s], RANGE);
  ok(r.champion.hr.calls === 0, "[2] a TB-primary card is not an HR call");
  ok(r.recall.championCalledHrs === 1, "[2] but its HR still counts toward recall");
}

// ── 3. Missing comparisons are reported, never inferred ───────────────────────
{
  const none = sig({ signalId: "n1", comparison: null, outcomes: { hitHr: true } as any });
  const disabled = sig({
    signalId: "n2", outcomes: { hitHr: true } as any,
    comparison: { championVersion: "c", challengerVersion: "x", frozenInputHash: "h", challengerUnavailable: "disabled" },
  });
  const failedRow = sig({
    signalId: "n3", outcomes: { hitHr: true } as any,
    comparison: { championVersion: "c", challengerVersion: "x", frozenInputHash: "h", challengerUnavailable: "failed" },
  });
  const r = buildPlateModelComparisonReport([none, disabled, failedRow], RANGE);
  ok(r.challengerUnavailable.total === 3, "[3] all three unavailable rows are counted");
  ok(r.challengerUnavailable.noRecord === 1, "[3] a missing record is distinguished");
  ok(r.challengerUnavailable.disabled === 1, "[3] shadow-disabled is distinguished");
  ok(r.challengerUnavailable.failed === 1, "[3] shadow-failed is distinguished");
  ok(r.challenger.publicCandidates === 0, "[3] no challenger exposure is invented from missing data");
  ok(r.winnerLossAnalysis.championKeptChallengerRemoved === 0, "[3] missing data never becomes a champion win");
  ok(r.lostWinners.length === 0, "[3] missing data never becomes a lost winner");
  ok(r.champion.publicCandidates === 3, "[3] the champion side is still fully reported");
  ok(r.recall.championCalledHrs === 3, "[3] champion recall unaffected by challenger unavailability");
}

// ── 4. Recall + disagreement math ─────────────────────────────────────────────
{
  const called = sig({ signalId: "r1", outcomes: { hitHr: true } as any });
  const uncalled = sig({
    signalId: "r2", everPubliclyFlagged: false,
    outcomes: { hitHr: true } as any,
    comparison: comparison({ challengerPublicEligible: false, challengerEverPubliclyEligible: false }),
  });
  const r = buildPlateModelComparisonReport([called, uncalled], RANGE);
  ok(r.recall.allSlateHrs === 2, "[4] all slate HRs counted regardless of exposure");
  ok(r.recall.championCalledHrs === 1, "[4] champion-called HRs counted");
  ok(r.recall.uncalledHrs === 1, "[4] the HR neither model called is uncalled");
  ok(r.winnerLossAnalysis.neitherCalled === 1, "[4] neither-called bucket");
}
{
  const tierChange = sig({ signalId: "d1", comparison: comparison({ tierChanged: true }) });
  const marketChange = sig({ signalId: "d2", comparison: comparison({ marketChanged: true, challengerMarket: "total_bases" }) });
  const r = buildPlateModelComparisonReport([tierChange, marketChange], RANGE);
  ok(r.disagreements.tierChanges === 1, "[4] tier changes counted");
  ok(r.disagreements.marketChanges === 1, "[4] market changes counted");
  ok(r.attributionBreakdown["batter_sample_shrinkage"] === 2, "[4] attribution breakdown aggregates across rows");
  ok(r.rowsScanned === 2, "[4] rowsScanned reflects the full input");
}

console.log(`\nplateModelComparisonStats.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
