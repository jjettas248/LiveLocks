// Mound Radar — market-outcome historical backfill planner invariants.
// Run: npx tsx server/mlb/pregame/mound/moundMarketOutcomeBackfill.test.ts

import { planMoundMarketOutcomeBackfill, type MoundMarketOutcomeBackfillRow } from "./moundMarketOutcomeBackfill";
import { buildMoundEvaluationSnapshot } from "./evaluationSnapshot";
import type { MoundSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function sig(over: Partial<MoundSignal>): MoundSignal {
  return {
    signalId: "mlb-mound:2026-07-01:g1:p1", sport: "mlb", engine: "mound_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b1", pitcherId: "p1", pitcherName: "P", team: "NYY", opponent: "BOS",
    throws: "R", opposingLineupConfirmed: true, opposingLineupLabel: "vs BOS confirmed lineup",
    primaryMarket: "pitcher_strikeouts", marketTags: ["pitcher_strikeouts", "pitcher_outs"],
    marketScores: { pitcher_strikeouts: 7, pitcher_outs: 6 }, marketSetups: [],
    kStuffScore: 7, kStuffLabel: "Strong", platoonKFitScore: 6, platoonKFitLabel: "Solid",
    kProjectionLabel: null, kLineValue: null, parkContext: null,
    score10: 7, tier: "strong", moundDirection: "follow",
    drivers: [], warnings: [], tags: [], lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "final", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, marketEdgeContext: null,
    projectedStrikeouts: 5, matchupAdjustedStrikeouts: 5.5,
    status: "graded", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: true, everPubliclyFlaggedFade: false,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      pitcherSkillScore: 7, opponentKProfileScore: 6, workloadScore: 6, runEnvironmentScore: 5,
      recentFormScore: 6, marketFitScore: 0, contactRiskScore: null, riskPenalty: 0,
      appliedDrivers: [], appliedWarnings: [], dataCoverageScore: 0.9,
      finalScoreBeforeCaps: 7, finalScoreAfterCaps: 7, publicTier: "strong",
      suppressed: false, suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: {
        confirmedStarter: true, confirmedOpposingLineup: true, pitcherSeasonStats: true,
        pitcherHandednessSplits: true, pitcherRecentStarts: true, pitcherStuffMetrics: true,
        park: true, weather: true,
      },
    },
    ...over,
  } as MoundSignal;
}

// ── A row with a real, resolvable frozen line + actual → backfillable ────────
{
  const signal = sig({ marketEdgeContext: { line: 5.5, oddsUpdatedAt: "2026-07-01T18:00:00Z", sportsbook: "DraftKings" } });
  const finalPregameSnapshot = buildMoundEvaluationSnapshot(signal, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T18:00:00Z", 9, 6);

  const rows: MoundMarketOutcomeBackfillRow[] = [
    {
      signalId: "row-cashed",
      primaryMarket: "pitcher_strikeouts",
      moundDirection: "follow",
      finalStrikeouts: 7,
      finalOutsRecorded: null,
      alreadyHasMarketOutcome: false,
      finalPregameSnapshot,
    },
  ];
  const plan = planMoundMarketOutcomeBackfill(rows);
  ok(plan.length === 1, "a row with a real frozen line + actual is backfillable");
  ok(plan[0].patch.marketOutcome === "cashed", "resolves the correct market outcome (7 over 5.5)");
  ok(plan[0].patch.sportsbookLine === 5.5, "backfills the frozen sportsbook line");
  ok(plan[0].patch.recommendedSide === "OVER", "backfills recommendedSide from moundDirection");
  ok(plan[0].patch.lineSnapshotType === "final_pregame", "backfills lineSnapshotType");
  ok(plan[0].patch.lineFrozenAt != null, "backfills lineFrozenAt from the snapshot's own frozenAt");
  ok(plan[0].patch.lineSource === "DraftKings", "backfills lineSource when the persisted snapshot already captured it");
}

// ── A row snapshotted BEFORE the sportsbook-capture field existed — line/side
// backfill, but lineSource honestly stays absent (never fabricated) ────────
{
  const signal = sig({ marketEdgeContext: { line: 5.5, oddsUpdatedAt: "2026-07-01T18:00:00Z" } }); // no `sportsbook` field
  const finalPregameSnapshot = buildMoundEvaluationSnapshot(signal, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T18:00:00Z", 9, 6);

  const rows: MoundMarketOutcomeBackfillRow[] = [
    {
      signalId: "row-pre-capture",
      primaryMarket: "pitcher_strikeouts",
      moundDirection: "follow",
      finalStrikeouts: 4,
      finalOutsRecorded: null,
      alreadyHasMarketOutcome: false,
      finalPregameSnapshot,
    },
  ];
  const plan = planMoundMarketOutcomeBackfill(rows);
  ok(plan.length === 1, "still backfillable without a captured sportsbook name");
  ok(plan[0].patch.marketOutcome === "missed", "market outcome still resolves correctly (4 under 5.5, Follow)");
  ok(plan[0].patch.lineFrozenAt != null, "lineFrozenAt still backfills — always existed on the snapshot type");
  ok(plan[0].patch.lineSource === null, "lineSource honestly stays null for a pre-capture row — never fabricated");
}

// ── A row with no resolvable frozen line (pitcher_outs — no fetch path exists) → left untouched ──
{
  const signal = sig({ primaryMarket: "pitcher_outs" });
  const finalPregameSnapshot = buildMoundEvaluationSnapshot(signal, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T18:00:00Z", 9, 6);

  const rows: MoundMarketOutcomeBackfillRow[] = [
    {
      signalId: "row-no-line",
      primaryMarket: "pitcher_outs",
      moundDirection: "follow",
      finalStrikeouts: null,
      finalOutsRecorded: 18,
      alreadyHasMarketOutcome: false,
      finalPregameSnapshot,
    },
  ];
  const plan = planMoundMarketOutcomeBackfill(rows);
  ok(plan.length === 0, "pitcher_outs has no fetch path — nothing provable, never fabricated, row left untouched");
}

// ── A row with no finalPregameSnapshot at all (legacy row, predates instrumentation) → left untouched ──
{
  const rows: MoundMarketOutcomeBackfillRow[] = [
    {
      signalId: "row-legacy",
      primaryMarket: "pitcher_strikeouts",
      moundDirection: "follow",
      finalStrikeouts: 7,
      finalOutsRecorded: null,
      alreadyHasMarketOutcome: false,
      finalPregameSnapshot: null,
    },
  ];
  const plan = planMoundMarketOutcomeBackfill(rows);
  ok(plan.length === 0, "no finalPregameSnapshot evidence at all → nothing to backfill, never guessed");
}

// ── Idempotent: a row already carrying a market outcome is skipped ───────────
{
  const signal = sig({ marketEdgeContext: { line: 5.5, oddsUpdatedAt: "2026-07-01T18:00:00Z" } });
  const finalPregameSnapshot = buildMoundEvaluationSnapshot(signal, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T18:00:00Z", 9, 6);

  const rows: MoundMarketOutcomeBackfillRow[] = [
    {
      signalId: "row-already-done",
      primaryMarket: "pitcher_strikeouts",
      moundDirection: "follow",
      finalStrikeouts: 7,
      finalOutsRecorded: null,
      alreadyHasMarketOutcome: true,
      finalPregameSnapshot,
    },
  ];
  const plan = planMoundMarketOutcomeBackfill(rows);
  ok(plan.length === 0, "a row already carrying marketOutcome is skipped — idempotent, safe to re-run");
}

// ── Unresolved direction → never guessed, left untouched ─────────────────────
{
  const signal = sig({ marketEdgeContext: { line: 5.5, oddsUpdatedAt: "2026-07-01T18:00:00Z" }, moundDirection: null });
  const finalPregameSnapshot = buildMoundEvaluationSnapshot(signal, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T18:00:00Z", 9, 6);

  const rows: MoundMarketOutcomeBackfillRow[] = [
    {
      signalId: "row-no-direction",
      primaryMarket: "pitcher_strikeouts",
      moundDirection: null,
      finalStrikeouts: 7,
      finalOutsRecorded: null,
      alreadyHasMarketOutcome: false,
      finalPregameSnapshot,
    },
  ];
  const plan = planMoundMarketOutcomeBackfill(rows);
  ok(plan.length === 0, "unresolved moundDirection → unavailable, never a guessed side, row left untouched");
}

console.log(`\nmoundMarketOutcomeBackfill.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
