// Mound Radar PR 2/5 — raw contact snapshot lifecycle invariants.
// Pre-lock refresh, first-lock freeze, post-lock immutability, repeated-call
// non-duplication, cross-slate-day non-fabrication, pre-lock carried/dropped
// signal fallback, and the genuinely-legacy-stays-undefined case. Exercises
// the REAL applyMoundEvaluationSnapshots orchestrator (evaluationSnapshot.ts),
// not a re-derived copy of its logic.
// Run: npx tsx server/mlb/pregame/mound/rawContactSnapshotLifecycle.test.ts

import { buildMoundEvaluationSnapshot, applyMoundEvaluationSnapshots } from "./evaluationSnapshot";
import type { MoundSignal, MoundEvaluationRecord } from "./types";
import type { RawPitcherContactSnapshot } from "./rawPitcherContactSnapshot";

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
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, marketEdgeContext: null,
    projectedStrikeouts: 5, matchupAdjustedStrikeouts: 5.5,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, everPubliclyFlaggedFade: false,
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
  };
}

function contactSnap(overrides: Partial<RawPitcherContactSnapshot> = {}): RawPitcherContactSnapshot {
  return {
    schemaVersion: 1,
    hr9Allowed: 1.2, barrelAllowedPct: 8.5, hardHitAllowedPct: 38.2, flyBallAllowedPct: 30.1,
    xSLGAllowed: 0.41, xwOBAAllowed: 0.32, bb9: 2.8, ipVariance: 1.1,
    sampleSizes: {
      inningsPitched: 100, homeRunsAllowed: 13, hardHitEligibleBbe: 200,
      barrelEligibleBbe: 200, bbTypeEligibleBbe: 200, xSLGEligibleBbe: 200, xwOBAEligibleBbe: 200,
    },
    availability: {
      hr9Allowed: "available", barrelAllowedPct: "available", hardHitAllowedPct: "available",
      flyBallAllowedPct: "available", xSLGAllowed: "available", xwOBAAllowed: "available",
      bb9: "available", ipVariance: "available",
    },
    ...overrides,
  };
}

const rates = new Map([["p1", { seasonKPer9: 9, seasonAvgInningsPerStart: 6 }]]);

// ── 1. Pre-lock refresh — updates every cycle while still legitimately pregame ──
{
  const signals1 = new Map<string, MoundSignal>();
  signals1.set("s1", sig({ signalId: "s1", pitcherId: "p1", status: "active", firstPitchLockEligible: true }));
  applyMoundEvaluationSnapshots(signals1, null, "build-1", rates, new Map([["s1", contactSnap({ hr9Allowed: 1.0 })]]));
  const cycle1 = signals1.get("s1")!;
  ok(cycle1.diagnostics.evaluation!.finalPregameSnapshot!.champion.rawContactSnapshot!.hr9Allowed === 1.0, "pre-lock cycle 1 stamps the fresh snapshot (1.0)");

  const signals2 = new Map<string, MoundSignal>();
  signals2.set("s1", sig({ signalId: "s1", pitcherId: "p1", status: "active", firstPitchLockEligible: true }));
  applyMoundEvaluationSnapshots(signals2, new Map([["s1", cycle1]]), "build-2", rates, new Map([["s1", contactSnap({ hr9Allowed: 2.0 })]]));
  const cycle2 = signals2.get("s1")!;
  ok(cycle2.diagnostics.evaluation!.finalPregameSnapshot!.champion.rawContactSnapshot!.hr9Allowed === 2.0, "pre-lock cycle 2 refreshes to the new value (2.0) — not yet frozen");
}

// ── 2/3. First-lock freeze + post-lock immutability across multiple later cycles ──
{
  const signals1 = new Map<string, MoundSignal>();
  signals1.set("s1", sig({ signalId: "s1", pitcherId: "p1", status: "active", firstPitchLockEligible: true, gameStatus: "scheduled" }));
  applyMoundEvaluationSnapshots(signals1, null, "build-1", rates, new Map([["s1", contactSnap({ hr9Allowed: 1.0 })]]));
  const cycle1 = signals1.get("s1")!;

  const signals2 = new Map<string, MoundSignal>();
  signals2.set("s1", sig({ signalId: "s1", pitcherId: "p1", status: "locked", firstPitchLockEligible: false, gameStatus: "live" }));
  applyMoundEvaluationSnapshots(signals2, new Map([["s1", cycle1]]), "build-2", rates, new Map([["s1", contactSnap({ hr9Allowed: 2.0 })]]));
  const cycle2 = signals2.get("s1")!;
  ok(
    cycle2.diagnostics.evaluation!.finalPregameSnapshot!.champion.rawContactSnapshot!.hr9Allowed === 1.0,
    "first locked cycle FREEZES at the last pregame value (1.0), ignoring this cycle's fresh 2.0",
  );

  const signals3 = new Map<string, MoundSignal>();
  signals3.set("s1", sig({ signalId: "s1", pitcherId: "p1", status: "locked", firstPitchLockEligible: false, gameStatus: "final" }));
  applyMoundEvaluationSnapshots(signals3, new Map([["s1", cycle2]]), "build-3", rates, new Map([["s1", contactSnap({ hr9Allowed: 3.0 })]]));
  const cycle3 = signals3.get("s1")!;
  ok(
    cycle3.diagnostics.evaluation!.finalPregameSnapshot!.champion.rawContactSnapshot!.hr9Allowed === 1.0,
    "post-lock rebuild cannot mutate the frozen snapshot — stays 1.0 a cycle later, despite a third distinct fresh value (3.0)",
  );
}

// ── 4. Repeated initialization with identical inputs does not duplicate/drift ──
{
  const signals = new Map<string, MoundSignal>();
  signals.set("s1", sig({ signalId: "s1", pitcherId: "p1", status: "active", firstPitchLockEligible: true }));
  const rawMap = new Map([["s1", contactSnap({ hr9Allowed: 1.5 })]]);
  applyMoundEvaluationSnapshots(signals, null, "build-1", rates, rawMap);
  const first = signals.get("s1")!.diagnostics.evaluation!.finalPregameSnapshot!.champion.rawContactSnapshot;
  applyMoundEvaluationSnapshots(signals, null, "build-1", rates, rawMap);
  const second = signals.get("s1")!.diagnostics.evaluation!.finalPregameSnapshot!.champion.rawContactSnapshot;
  ok(JSON.stringify(first) === JSON.stringify(second), "repeated initialization with identical inputs does not duplicate or drift the frozen value");
}

// ── 5. Cross-slate-day / cold-start: no current entry + no prev → stays undefined, never fabricated ──
{
  const signals = new Map<string, MoundSignal>();
  signals.set("s1", sig({ signalId: "s1", pitcherId: "p1", status: "active", firstPitchLockEligible: true }));
  applyMoundEvaluationSnapshots(signals, null, "build-1", rates, new Map());
  const evaluation = signals.get("s1")!.diagnostics.evaluation!;
  ok(evaluation.finalPregameSnapshot!.champion.rawContactSnapshot === undefined, "no current entry + no prev (new slate day / cold start) → stays undefined, never fabricated");
}

// ── 6. Pre-lock carried/dropped signal (not re-evaluated this cycle) falls back to its previously-frozen value ──
{
  const signals1 = new Map<string, MoundSignal>();
  signals1.set("s1", sig({ signalId: "s1", pitcherId: "p1", status: "active", firstPitchLockEligible: true }));
  applyMoundEvaluationSnapshots(signals1, null, "build-1", rates, new Map([["s1", contactSnap({ hr9Allowed: 1.0 })]]));
  const prior = signals1.get("s1")!;

  const signals2 = new Map<string, MoundSignal>();
  signals2.set("s1", { ...prior, status: "active" }); // carried forward, still pre-lock
  applyMoundEvaluationSnapshots(signals2, new Map([["s1", prior]]), "build-2", rates, new Map()); // no fresh entry this cycle
  const carried = signals2.get("s1")!.diagnostics.evaluation!;
  ok(
    carried.finalPregameSnapshot!.champion.rawContactSnapshot!.hr9Allowed === 1.0,
    "a pre-lock signal carried forward with no current-cycle map entry preserves its previously-frozen value, not erased",
  );
}

// ── 7. Genuinely legacy signal (never had a snapshot, no current entry) stays undefined ──
{
  const legacySignal = sig({ signalId: "s1", pitcherId: "p1", status: "active" });
  const legacyEvaluation: MoundEvaluationRecord = {
    firstPublicSnapshot: null, firstPublicUnavailableReason: "not_yet_public", firstPublicDirection: null, directionConflict: false,
    finalPregameSnapshot: buildMoundEvaluationSnapshot(legacySignal, { holistic: 1, byMarket: {} }, "b0", 1, "2026-06-01T00:00:00Z", 9, 6),
    finalPregameUnavailableReason: null,
  };
  const legacyPrev: MoundSignal = { ...legacySignal, diagnostics: { ...legacySignal.diagnostics, evaluation: legacyEvaluation } };
  ok(legacyPrev.diagnostics.evaluation!.finalPregameSnapshot!.champion.rawContactSnapshot === undefined, "sanity: legacy fixture genuinely has no rawContactSnapshot recorded");

  const signals = new Map<string, MoundSignal>();
  signals.set("s1", { ...legacyPrev, status: "active" });
  applyMoundEvaluationSnapshots(signals, new Map([["s1", legacyPrev]]), "build-1", rates, new Map());
  const evaluation = signals.get("s1")!.diagnostics.evaluation!;
  ok(evaluation.finalPregameSnapshot!.champion.rawContactSnapshot === undefined, "genuinely legacy signal (no prior + no current entry) stays undefined, never fabricated");
}

console.log(`\nrawContactSnapshotLifecycle.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
