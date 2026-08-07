// MLB Stage B — settlement decision invariants.
//
// Run: npx tsx server/mlb/stageB/predictionLedgerSettlement.test.ts

import {
  decideLanePredictionSettlement,
  DEFAULT_MLB_LEDGER_SETTLEMENT_POLICY,
  type MlbLedgerOutcomeResolution,
} from "./predictionLedgerSettlement";
import {
  settleMlbLanePrediction,
  voidMlbLanePrediction,
  MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
  type MlbLanePrediction,
} from "@shared/mlbPredictionLedger";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function pred(o: Partial<MlbLanePrediction> = {}): MlbLanePrediction {
  return {
    predictionId: "pid", signalId: "sid", sport: "MLB", gameId: "g1", playerId: "p1",
    playerName: "B", market: "hits", side: "OVER", lane: "shadow", line: 1.5,
    overOdds: -115, underOdds: -105, sideOdds: -115, sportsbook: "draftkings",
    oddsFetchedAt: null, oddsAgeMs: null, capturedAt: "2026-08-05T18:00:00.000Z",
    inning: 5, gamePhase: null, statAtCapture: 1, candidateProbabilityPct: 58,
    calibratedProbabilityPct: null, probabilitySemantics: "raw_provisional",
    modelEdgePctPoints: 6, noVigBookProbability: 52, edgeVersion: "novig_v1",
    finalizedTier: "watch", modelMethod: "hit_distribution", dataQuality: "full",
    baseEligible: false, signalScore: 41, laneReasons: [], finalizerVersion: null,
    laneVersion: null, goldmasterVersion: null, contractVersion: MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
    status: "captured", settlementResult: null, finalStat: null, settledAt: null, voidReason: null,
    ...o,
  };
}
function res(o: Partial<MlbLedgerOutcomeResolution> = {}): MlbLedgerOutcomeResolution {
  return { gameState: "final", finalStat: null, playerFoundInFinalBox: false, playerHasAnyStats: false, ageHours: 3, ...o };
}

// Not final (young) ⇒ hold (never void on transient)
{
  ok(decideLanePredictionSettlement(pred(), res({ gameState: "live" })).action === "hold", "live game ⇒ hold");
  ok(decideLanePredictionSettlement(pred(), res({ gameState: "scheduled" })).action === "hold", "scheduled ⇒ hold");
  ok(decideLanePredictionSettlement(pred(), res({ gameState: "unknown" })).action === "hold", "unknown ⇒ hold");
}

// Not final but TERMINAL-OLD ⇒ neutral line_unresolvable void (never synthesized
// "postponed" — a genuinely-final game whose box was unavailable must not be
// mislabeled). Bounds pending growth.
{
  const d = decideLanePredictionSettlement(pred(), res({ gameState: "unknown", ageHours: 100 }));
  ok(d.action === "void" && d.voidReason === "line_unresolvable", "old not-final ⇒ terminal void line_unresolvable (neutral, not postponed)");
  const live = decideLanePredictionSettlement(pred(), res({ gameState: "live", ageHours: 100 }));
  ok(live.action === "void" && live.voidReason === "line_unresolvable", "old-but-live ⇒ terminal void line_unresolvable");
}

// Final + finite stat ⇒ settle graded
{
  const d1 = decideLanePredictionSettlement(pred({ side: "OVER", line: 1.5 }), res({ finalStat: 2 }));
  ok(d1.action === "settle" && d1.result === "cashed" && d1.finalStat === 2, "final OVER 1.5 vs 2 ⇒ settle cashed");
  const d2 = decideLanePredictionSettlement(pred({ side: "UNDER", line: 1.5 }), res({ finalStat: 2 }));
  ok(d2.action === "settle" && d2.result === "missed", "final UNDER 1.5 vs 2 ⇒ settle missed");
  const d3 = decideLanePredictionSettlement(pred({ side: "OVER", line: 2 }), res({ finalStat: 2 }));
  ok(d3.action === "settle" && d3.result === "push", "final OVER 2 vs 2 ⇒ settle push");
  const d4 = decideLanePredictionSettlement(pred({ side: "OVER", line: 1.5 }), res({ finalStat: 0 }));
  ok(d4.action === "settle" && d4.result === "missed", "final OVER 1.5 vs 0 ⇒ settle missed (0 is a real stat, not void)");
}

// Final + TRUE DNP (player in box with NO participation at all) ⇒ void immediately
{
  const d = decideLanePredictionSettlement(pred(), res({ finalStat: null, playerFoundInFinalBox: true, playerHasAnyStats: false, ageHours: 1 }));
  ok(d.action === "void" && d.voidReason === "player_did_not_appear", "true DNP (found, no stats) ⇒ void immediately (even young)");
}

// Final + player PLAYED but this market's stat is null ⇒ NOT a DNP: hold young,
// terminal-void old (the key fix — preserve gradable observations).
{
  const young = decideLanePredictionSettlement(pred(), res({ finalStat: null, playerFoundInFinalBox: true, playerHasAnyStats: true, ageHours: 3 }));
  ok(young.action === "hold" && young.reason === "final_box_unresolvable", "played-but-stat-null (young) ⇒ hold, NOT DNP-void");
  const old = decideLanePredictionSettlement(pred(), res({ finalStat: null, playerFoundInFinalBox: true, playerHasAnyStats: true, ageHours: 49 }));
  ok(old.action === "void" && old.voidReason === "line_unresolvable", "played-but-stat-null (old) ⇒ terminal void line_unresolvable (not DNP)");
}

// Final + player absent from box ⇒ hold young, terminal-void when old
{
  const young = decideLanePredictionSettlement(pred(), res({ finalStat: null, playerFoundInFinalBox: false, ageHours: 3 }));
  ok(young.action === "hold" && young.reason === "final_box_unresolvable", "young unresolvable (absent) ⇒ hold");
  const old = decideLanePredictionSettlement(pred(), res({ finalStat: null, playerFoundInFinalBox: false, ageHours: 49 }));
  ok(old.action === "void" && old.voidReason === "line_unresolvable", "old unresolvable ⇒ terminal void");
  const atBoundary = decideLanePredictionSettlement(pred(), res({ finalStat: null, ageHours: DEFAULT_MLB_LEDGER_SETTLEMENT_POLICY.terminalVoidAgeHours }));
  ok(atBoundary.action === "void", "unresolvable at exactly terminalVoidAgeHours ⇒ void");
}

// Postponed / suspended ⇒ hold young, terminal-void old
{
  const pp = decideLanePredictionSettlement(pred(), res({ gameState: "postponed", ageHours: 3 }));
  ok(pp.action === "hold" && pp.reason === "awaiting_postponed", "young postponed ⇒ hold");
  const ppOld = decideLanePredictionSettlement(pred(), res({ gameState: "postponed", ageHours: 50 }));
  ok(ppOld.action === "void" && ppOld.voidReason === "game_postponed", "old postponed ⇒ void game_postponed");
  const susOld = decideLanePredictionSettlement(pred(), res({ gameState: "suspended", ageHours: 50 }));
  ok(susOld.action === "void" && susOld.voidReason === "game_suspended", "old suspended ⇒ void game_suspended");
}

// Terminal row ⇒ defensive hold (sweep should not select it)
{
  const settled = decideLanePredictionSettlement(pred({ status: "settled" }), res({ finalStat: 2 }));
  ok(settled.action === "hold" && settled.reason === "already_terminal", "terminal row ⇒ defensive hold");
}

// End-to-end: a settle decision applied via the contract produces a valid graded row
{
  const p = pred({ side: "OVER", line: 1.5 });
  const d = decideLanePredictionSettlement(p, res({ finalStat: 3 }));
  ok(d.action === "settle", "decision is settle");
  if (d.action === "settle") {
    const graded = settleMlbLanePrediction(p, d.finalStat!, "2026-08-05T23:00:00.000Z");
    ok(graded.status === "settled" && graded.settlementResult === "cashed", "applied settle ⇒ settled/cashed row");
  }
  // And a void decision applied via the contract
  const p2 = pred();
  const dv = decideLanePredictionSettlement(p2, res({ gameState: "postponed", ageHours: 60 }));
  if (dv.action === "void") {
    const voided = voidMlbLanePrediction(p2, dv.voidReason!, "2026-08-05T23:00:00.000Z");
    ok(voided.status === "void" && voided.settlementResult === "void", "applied void ⇒ void row");
  }
}

console.log(`\npredictionLedgerSettlement.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
