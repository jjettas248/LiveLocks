// MLB Stage B — ledger summary (pure) invariants.
//
// Run: npx tsx server/mlb/stageB/predictionLedgerSummary.test.ts

import { summarizeStageBLedger } from "./predictionLedgerSummary";
import { MLB_PREDICTION_LEDGER_CONTRACT_VERSION, type MlbLanePrediction, type MlbPredictionLane, type MlbLedgerStatus, type MlbLedgerSettlementResult } from "@shared/mlbPredictionLedger";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

let seq = 0;
function pred(lane: MlbPredictionLane, status: MlbLedgerStatus, result: MlbLedgerSettlementResult | null): MlbLanePrediction {
  seq++;
  return {
    predictionId: `p${seq}`, signalId: `s${seq}`, sport: "MLB", gameId: "g1", playerId: "p1",
    playerName: "B", market: "hits", side: "OVER", lane, line: 1.5,
    overOdds: null, underOdds: null, sideOdds: null, sportsbook: null, oddsFetchedAt: null,
    oddsAgeMs: null, capturedAt: new Date().toISOString(), inning: null, gamePhase: null,
    statAtCapture: null, candidateProbabilityPct: 58, calibratedProbabilityPct: null,
    probabilitySemantics: "raw_provisional", modelEdgePctPoints: null, noVigBookProbability: null,
    edgeVersion: null, finalizedTier: null, modelMethod: null, dataQuality: null, baseEligible: null,
    signalScore: null, laneReasons: [], finalizerVersion: null, laneVersion: null,
    goldmasterVersion: null, contractVersion: MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
    status, settlementResult: result, finalStat: null, settledAt: null, voidReason: null,
  };
}

// A mixed ledger across lanes/statuses/results
{
  const preds: MlbLanePrediction[] = [
    // shadow: 3 cashed, 1 missed, 1 push, 1 void, 1 captured (pending)
    pred("shadow", "settled", "cashed"),
    pred("shadow", "settled", "cashed"),
    pred("shadow", "settled", "cashed"),
    pred("shadow", "settled", "missed"),
    pred("shadow", "settled", "push"),
    pred("shadow", "void", "void"),
    pred("shadow", "captured", null),
    // official: 1 cashed, 1 missed
    pred("official", "settled", "cashed"),
    pred("official", "settled", "missed"),
  ];
  const s = summarizeStageBLedger(preds, 123);

  ok(s.total === 9 && s.generatedAtMs === 123, "total + generatedAtMs");
  const sh = s.byLane.shadow;
  ok(sh.total === 7 && sh.captured === 1 && sh.settled === 5 && sh.void === 1, "shadow status counts");
  ok(sh.cashed === 3 && sh.missed === 1 && sh.push === 1, "shadow result counts");
  // hit rate excludes push AND void: 3 / (3+1) = 75.0
  ok(sh.hitRatePct === 75, "shadow hit rate = cashed/(cashed+missed), excludes push+void");
  // coverage = (settled+void+expired)/total = (5+1+0)/7 = 85.7
  ok(sh.coveragePct === 85.7, "shadow coverage = resolved/total");

  const off = s.byLane.official;
  ok(off.cashed === 1 && off.missed === 1 && off.hitRatePct === 50, "official hit rate = 50");

  // watch lane present but empty
  ok(s.byLane.watch.total === 0 && s.byLane.watch.hitRatePct === null, "empty lane ⇒ zeroed + null hit rate");

  // overall aggregates every lane
  ok(s.overall.total === 9 && s.overall.cashed === 4 && s.overall.missed === 2, "overall aggregates all lanes");
  ok(s.overall.hitRatePct === Math.round((4 / 6) * 1000) / 10, "overall hit rate = 4/6");
}

// No decided results ⇒ null hit rate (never divide by zero)
{
  const s = summarizeStageBLedger([pred("shadow", "captured", null), pred("shadow", "void", "void")], 1);
  ok(s.byLane.shadow.hitRatePct === null, "no cashed+missed ⇒ hit rate null");
  ok(s.byLane.shadow.coveragePct === 50, "1 void of 2 ⇒ 50% coverage");
}

// Empty ledger ⇒ all zero, null hit rates
{
  const s = summarizeStageBLedger([], 1);
  ok(s.total === 0 && s.overall.hitRatePct === null && s.overall.coveragePct === 0, "empty ledger ⇒ zeroed");
}

console.log(`\npredictionLedgerSummary.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
