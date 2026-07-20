// Coexistence regression — PR #119 `diagnostics.powerProfile` (display snapshot)
// and PR #116 `diagnostics.evaluation` (research instrumentation) must live on the
// same signal without clobbering each other, and neither may affect scoring,
// eligibility, ranking, or primaryMarket.
//
// Run: npx tsx server/mlb/pregamePowerRadar/coexistenceDiagnostics.test.ts

import { carryForwardGradedState } from "./gradedStateCarry";
import { applyEvaluationSnapshots } from "./evaluationSnapshot";
import { signalToRow, rowToSignal } from "./pregamePersistence";
import { isPublicPregameSignal, wasPubliclyFlaggedPregame } from "./diagnostics";
import type { PregameEvaluationRecord, PregamePowerProfileSnapshot, PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const PROFILE_A: PregamePowerProfileSnapshot = { xISO: 0.24, hrFBRatioPct: 18.5, barrelRatePct: 14.2, hardHitRatePct: 48.1, maxEV: 112.4, pullRatePct: 49 };
const PROFILE_B: PregamePowerProfileSnapshot = { xISO: 0.10, hrFBRatioPct: 5.0, barrelRatePct: 3.0, hardHitRatePct: 30.0, maxEV: 100.0, pullRatePct: 20 };
const EVAL_A: PregameEvaluationRecord = {
  firstPublicSnapshot: null, firstPublicUnavailableReason: "not_yet_public",
  finalPregameSnapshot: null, finalPregameUnavailableReason: null,
};

function sig(over: Partial<PregamePowerSignal>, profile?: PregamePowerProfileSnapshot, evaluation?: PregameEvaluationRecord): PregamePowerSignal {
  const s: PregamePowerSignal = {
    signalId: over.signalId ?? "mlb-pregame:2026-07-01:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b", batterId: over.batterId ?? "b1", batterName: over.batterName ?? "X", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    score10: over.score10 ?? 7, tier: over.tier ?? "strong",
    drivers: [
      { key: "power", label: "Elite raw power", direction: "positive" },
      { key: "park", label: "HR park boost", direction: "positive" },
    ],
    warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
    ...over,
  };
  if (profile) (s.diagnostics as any).powerProfile = profile;
  if (evaluation) (s.diagnostics as any).evaluation = evaluation;
  return s;
}

// ── 1. Locked rebuild preserves the frozen powerProfile even with evaluation present ─
{
  const prev = sig({ everPubliclyFlagged: true }, PROFILE_A, EVAL_A);
  const fresh = sig({ gameStatus: "final", status: "locked", firstPitchLockEligible: false }, PROFILE_B, EVAL_A);
  carryForwardGradedState(fresh, prev);
  ok((fresh.diagnostics as any).powerProfile.xISO === PROFILE_A.xISO,
    "locked rebuild freezes powerProfile to A even though diagnostics also carries an evaluation field");
}

// ── 2. applyEvaluationSnapshots preserves powerProfile while setting evaluation ──
{
  const s = sig({ everPubliclyFlagged: true, gameStatus: "scheduled", status: "active" }, PROFILE_A);
  ok((s.diagnostics as any).evaluation === undefined, "precondition: no evaluation yet");
  const map = new Map<string, PregamePowerSignal>([[s.signalId, s]]);
  applyEvaluationSnapshots(map, null, "build-1");
  const after = map.get(s.signalId)!;
  ok((after.diagnostics as any).powerProfile?.xISO === PROFILE_A.xISO,
    "applyEvaluationSnapshots leaves powerProfile intact (spread { ...diagnostics, evaluation })");
  ok((after.diagnostics as any).evaluation != null,
    "applyEvaluationSnapshots writes the evaluation record");
}

// ── 3. signalToRow → rowToSignal retains BOTH fields ────────────────────────
{
  const original = sig({ everPubliclyFlagged: true, status: "graded",
    outcomes: { hitHr: true, totalBases: 4, outcome: "pregame_win", userVisible: true } as any }, PROFILE_A, EVAL_A);
  const hydrated = rowToSignal(signalToRow(original) as any);
  const d = hydrated.diagnostics as any;
  ok(d.powerProfile?.xISO === PROFILE_A.xISO, "hydration retains powerProfile");
  ok(d.evaluation != null && d.evaluation.firstPublicUnavailableReason === "not_yet_public", "hydration retains evaluation");
}

// ── 4. Neither field changes score/tier/drivers/eligibility/ranking/primaryMarket ─
{
  const withBoth = [
    sig({ signalId: "a", batterId: "a", score10: 8.1, tier: "elite" }, PROFILE_A, EVAL_A),
    sig({ signalId: "b", batterId: "b", score10: 7.0, tier: "strong" }, PROFILE_B, EVAL_A),
    sig({ signalId: "c", batterId: "c", score10: 6.2, tier: "strong" }, PROFILE_A, EVAL_A),
  ];
  const without = [
    sig({ signalId: "a", batterId: "a", score10: 8.1, tier: "elite" }),
    sig({ signalId: "b", batterId: "b", score10: 7.0, tier: "strong" }),
    sig({ signalId: "c", batterId: "c", score10: 6.2, tier: "strong" }),
  ];
  ok(withBoth.every((s, i) => wasPubliclyFlaggedPregame(s) === wasPubliclyFlaggedPregame(without[i])), "eligibility identical with vs without both fields");
  ok(withBoth.filter(isPublicPregameSignal).length === without.filter(isPublicPregameSignal).length, "candidate count identical");
  const rank = (a: PregamePowerSignal[]) => a.slice().sort((x, y) => y.score10 - x.score10).map((s) => s.signalId).join(",");
  ok(rank(withBoth) === rank(without), "ranking order identical");
  ok(withBoth.every((s, i) =>
    s.score10 === without[i].score10 && s.tier === without[i].tier && s.primaryMarket === without[i].primaryMarket &&
    JSON.stringify(s.drivers) === JSON.stringify(without[i].drivers) && JSON.stringify(s.marketScores) === JSON.stringify(without[i].marketScores)),
    "score/tier/drivers/marketScores/primaryMarket identical with vs without both fields");
}

console.log(`\ncoexistenceDiagnostics.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
