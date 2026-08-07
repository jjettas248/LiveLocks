// MLB Stage C — fit-calibrator-from-ledger invariants.
//
// Run: npx tsx server/mlb/stageC/fitCalibrator.test.ts

import {
  toCalibrationObservations,
  fitSegmentCalibrator,
  fitCalibratorsFromLedger,
} from "./fitCalibrator";
import { MLB_PREDICTION_LEDGER_CONTRACT_VERSION, type MlbLanePrediction, type MlbLedgerStatus, type MlbLedgerSettlementResult } from "@shared/mlbPredictionLedger";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

let seq = 0;
function pred(o: {
  market?: string; lane?: string; probPct: number; status: MlbLedgerStatus;
  result: MlbLedgerSettlementResult | null; capturedAt?: string;
}): MlbLanePrediction {
  seq++;
  return {
    predictionId: `p${seq}`, signalId: `s${seq}`, sport: "MLB", gameId: "g1", playerId: "p1",
    playerName: "B", market: o.market ?? "hits", side: "OVER", lane: (o.lane as any) ?? "shadow", line: 1.5,
    overOdds: null, underOdds: null, sideOdds: null, sportsbook: null, oddsFetchedAt: null, oddsAgeMs: null,
    capturedAt: o.capturedAt ?? "2026-08-05T18:00:00.000Z", inning: null, gamePhase: null, statAtCapture: null,
    candidateProbabilityPct: o.probPct, calibratedProbabilityPct: null, probabilitySemantics: "raw_provisional",
    modelEdgePctPoints: null, noVigBookProbability: null, edgeVersion: null, finalizedTier: null, modelMethod: null,
    dataQuality: null, baseEligible: null, signalScore: null, laneReasons: [], finalizerVersion: null, laneVersion: null,
    goldmasterVersion: null, contractVersion: MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
    status: o.status, settlementResult: o.result, finalStat: null, settledAt: null, voidReason: null,
  };
}

// Observation extraction: only settled cashed/missed; push/void/captured excluded
{
  const rows = [
    pred({ probPct: 70, status: "settled", result: "cashed" }),
    pred({ probPct: 60, status: "settled", result: "missed" }),
    pred({ probPct: 55, status: "settled", result: "push" }),   // excluded
    pred({ probPct: 80, status: "void", result: "void" }),      // excluded
    pred({ probPct: 65, status: "captured", result: null }),    // excluded
  ];
  const obs = toCalibrationObservations(rows);
  ok(obs.length === 2, "only settled cashed/missed become observations (push/void/captured excluded)");
  ok(obs[0].y === 1 && obs[1].y === 0, "cashed→1, missed→0");
  ok(Math.abs(obs[0].p - 0.7) < 1e-9, "prob converted 0..100 → 0..1");
}

// Fit improves Brier on an overconfident sample + bins monotonic + honest stats
{
  const rows: MlbLanePrediction[] = [];
  // 60 predictions all at 80% that actually cash only ~50% ⇒ overconfident.
  for (let i = 0; i < 60; i++) {
    rows.push(pred({
      probPct: 80,
      status: "settled",
      result: i % 2 === 0 ? "cashed" : "missed",
      capturedAt: `2026-08-0${(i % 3) + 1}T18:00:00.000Z`, // 3 distinct ET dates
    }));
  }
  const art = fitSegmentCalibrator("hits", toCalibrationObservations(rows), { builtAtMs: 42 });
  ok(art !== null, "fit produces an artifact");
  if (art) {
    ok(art.fitStats.calibratedBrier < art.fitStats.rawBrier, "calibration IMPROVES Brier vs raw on a miscalibrated sample");
    ok(art.fitStats.sampleSize === 60, "sampleSize = decided obs");
    ok(art.fitStats.distinctSlateDates === 3, "distinct ET slate dates counted");
    ok(art.fitStats.inSample === true, "fitStats flagged in-sample (honesty)");
    ok(art.builtAtMs === 42 && art.artifactVersion === "mlb_calibration_v1", "builtAt/version stamped");
    ok(art.ledgerContractVersion === MLB_PREDICTION_LEDGER_CONTRACT_VERSION, "ledger contract version recorded");
    // bins calibratedRate non-decreasing by center
    let mono = true;
    for (let i = 1; i < art.bins.length; i++) if (art.bins[i].calibratedRate < art.bins[i - 1].calibratedRate - 1e-9) mono = false;
    ok(mono, "artifact bins calibratedRate is monotonic non-decreasing");
    // overconfident 0.8 predictions pulled down toward ~0.5
    ok(art.bins.every((b) => b.calibratedRate <= 0.8 + 1e-9), "overconfident bin(s) calibrated down");
  }
}

// Per-segment fit: two markets ⇒ two artifacts, keyed by market
{
  const rows = [
    pred({ market: "hits", probPct: 70, status: "settled", result: "cashed" }),
    pred({ market: "hits", probPct: 60, status: "settled", result: "missed" }),
    pred({ market: "total_bases", probPct: 65, status: "settled", result: "cashed" }),
  ];
  const map = fitCalibratorsFromLedger(rows, { builtAtMs: 1 });
  ok(Object.keys(map).sort().join(",") === "hits,total_bases", "one artifact per market segment");
  ok(map.hits.segment === "hits" && map.total_bases.segment === "total_bases", "segment labels correct");
}

// Lane-split segment key
{
  const rows = [
    pred({ market: "hits", lane: "official", probPct: 70, status: "settled", result: "cashed" }),
    pred({ market: "hits", lane: "shadow", probPct: 60, status: "settled", result: "missed" }),
  ];
  const map = fitCalibratorsFromLedger(rows, { builtAtMs: 1, segmentKey: (p) => `${p.market}:${p.lane}` });
  ok("hits:official" in map && "hits:shadow" in map, "lane-split segment key produces per-lane artifacts");
}

// distinctSlateDates uses the 6am-ET SLATE day, not the ET calendar date.
// Two captures on the same ET calendar date (2026-08-10) straddling 6am ET
// (05:00 ET and 07:00 ET, i.e. 09:00Z and 11:00Z in EDT) belong to DIFFERENT
// slates (Aug 9 vs Aug 10) ⇒ 2 distinct slate dates. (toEtDateKey would give 1.)
{
  const rows = [
    pred({ probPct: 70, status: "settled", result: "cashed", capturedAt: "2026-08-10T09:00:00.000Z" }), // 05:00 ET → slate Aug 9
    pred({ probPct: 60, status: "settled", result: "missed", capturedAt: "2026-08-10T11:00:00.000Z" }), // 07:00 ET → slate Aug 10
  ];
  const art = fitSegmentCalibrator("hits", toCalibrationObservations(rows), { builtAtMs: 1 });
  ok(art !== null && art.fitStats.distinctSlateDates === 2, "6am-ET slate rollover ⇒ 2 distinct slates from one ET calendar date");
}

// Empty / no-decided ⇒ no artifact
{
  ok(fitSegmentCalibrator("hits", [], { builtAtMs: 1 }) === null, "empty observations ⇒ null");
  const map = fitCalibratorsFromLedger([pred({ probPct: 70, status: "captured", result: null })], { builtAtMs: 1 });
  ok(Object.keys(map).length === 0, "only-captured ledger ⇒ no artifacts");
}

console.log(`\nfitCalibrator.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
