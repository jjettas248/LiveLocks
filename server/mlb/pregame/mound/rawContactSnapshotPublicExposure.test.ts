// Mound Radar PR 2/5 — public-response exposure gating invariants.
// includeResearchInstrumentation=false strips ONLY champion.rawContactSnapshot
// from both evaluation snapshots — every other pre-existing evaluation field
// (drivers, componentScores, frozenProductionBaseline, postedLine,
// predictionTimeProjections, firstPublicDirection, etc.) stays intact,
// exactly as it already is pre-PR. includeResearchInstrumentation=true
// retains it. Never mutates the shared in-memory signal.
// Run: npx tsx server/mlb/pregame/mound/rawContactSnapshotPublicExposure.test.ts

import { buildMoundResponse, type MoundCoverageCounters } from "./diagnostics";
import { buildMoundEvaluationSnapshot } from "./evaluationSnapshot";
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
    drivers: [{ key: "ps_k9", label: "Pitcher High K%", direction: "positive" }], warnings: [], tags: [],
    lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, marketEdgeContext: null,
    projectedStrikeouts: 5, matchupAdjustedStrikeouts: 5.5,
    status: "active", suppressed: false, suppressedReasons: [],
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
  };
}

function contactSnap(): RawPitcherContactSnapshot {
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
  };
}

function containsKey(obj: unknown, key: string): boolean {
  if (obj == null || typeof obj !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
  return Object.values(obj as Record<string, unknown>).some((v) => containsKey(v, key));
}

const baseSignal = sig({});
const snapshotWithContact = buildMoundEvaluationSnapshot(
  baseSignal, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", 9, 6, contactSnap(),
);
const evaluation: MoundEvaluationRecord = {
  firstPublicSnapshot: snapshotWithContact,
  firstPublicUnavailableReason: null,
  firstPublicDirection: "follow",
  directionConflict: false,
  finalPregameSnapshot: snapshotWithContact,
  finalPregameUnavailableReason: null,
};
const signalWithEvaluation: MoundSignal = { ...baseSignal, diagnostics: { ...baseSignal.diagnostics, evaluation } };

const counters: MoundCoverageCounters = {
  gamesScanned: 1, pitchersEvaluated: 1, starterCoverage: 1, weatherCoverage: 1, pitcherCoverage: 1, lineupCoverage: 1,
};

const publicResp = buildMoundResponse("2026-07-01", "b1", "2026-07-01T00:00:00Z", "memory", [signalWithEvaluation], counters, true, false);
const adminResp = buildMoundResponse("2026-07-01", "b1", "2026-07-01T00:00:00Z", "memory", [signalWithEvaluation], counters, true, true);

const publicSignal = publicResp.signals[0];
const adminSignal = adminResp.signals[0];

// ── Public response: strips ONLY rawContactSnapshot, keeps everything else ──
ok(publicSignal.diagnostics.evaluation !== undefined, "public response still contains the evaluation object (not stripped wholesale)");
ok(publicSignal.diagnostics.evaluation!.firstPublicSnapshot!.champion.rawContactSnapshot === undefined, "public response strips rawContactSnapshot from firstPublicSnapshot");
ok(publicSignal.diagnostics.evaluation!.finalPregameSnapshot!.champion.rawContactSnapshot === undefined, "public response strips rawContactSnapshot from finalPregameSnapshot");
ok(publicSignal.diagnostics.evaluation!.firstPublicDirection === "follow", "public response preserves firstPublicDirection (pre-existing field)");
ok(publicSignal.diagnostics.evaluation!.finalPregameSnapshot!.champion.score10 === baseSignal.score10, "public response preserves champion.score10");
ok(publicSignal.diagnostics.evaluation!.finalPregameSnapshot!.champion.tier === baseSignal.tier, "public response preserves champion.tier");
ok(
  JSON.stringify(publicSignal.diagnostics.evaluation!.finalPregameSnapshot!.champion.drivers) === JSON.stringify(snapshotWithContact.champion.drivers),
  "public response preserves champion.drivers verbatim",
);
ok(
  publicSignal.diagnostics.evaluation!.finalPregameSnapshot!.champion.frozenProductionBaseline.strikeouts.value ===
    snapshotWithContact.champion.frozenProductionBaseline.strikeouts.value,
  "public response preserves frozenProductionBaseline",
);
ok(
  publicSignal.diagnostics.evaluation!.finalPregameSnapshot!.champion.predictionTimeProjections.matchupAdjustedStrikeouts ===
    snapshotWithContact.champion.predictionTimeProjections.matchupAdjustedStrikeouts,
  "public response preserves predictionTimeProjections",
);
ok(!containsKey(publicResp, "rawContactSnapshot"), "public response JSON contains no rawContactSnapshot key anywhere");

// ── Admin response: retains the full instrumentation, including rawContactSnapshot ──
ok(adminSignal.diagnostics.evaluation!.firstPublicSnapshot!.champion.rawContactSnapshot !== undefined, "admin response retains rawContactSnapshot in firstPublicSnapshot");
ok(
  adminSignal.diagnostics.evaluation!.finalPregameSnapshot!.champion.rawContactSnapshot!.hr9Allowed === contactSnap().hr9Allowed,
  "admin response retains the actual rawContactSnapshot value",
);
ok(containsKey(adminResp, "rawContactSnapshot"), "admin response JSON does contain the rawContactSnapshot key");

// ── Never mutates the shared in-memory signal ──
ok(
  signalWithEvaluation.diagnostics.evaluation!.finalPregameSnapshot!.champion.rawContactSnapshot !== undefined,
  "the original in-memory signal's rawContactSnapshot is untouched after building the public (stripped) response — no shared-object mutation",
);

console.log(`\nrawContactSnapshotPublicExposure.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
