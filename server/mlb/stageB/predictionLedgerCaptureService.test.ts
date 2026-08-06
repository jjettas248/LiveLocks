// MLB Stage B — capture service (hot-path adapter) invariants.
//
// Run: npx tsx server/mlb/stageB/predictionLedgerCaptureService.test.ts

import {
  captureAllLanesToStageB,
  __resetStageBCaptureCountersForTest,
} from "./predictionLedgerCaptureService";
import type { MlbLanePrediction } from "@shared/mlbPredictionLedger";
import type { MLBQualifiedSignal } from "../types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function sig(o: Partial<MLBQualifiedSignal> = {}): MLBQualifiedSignal {
  return {
    id: "mlb:g1:p1:hits:OVER", gameId: "g1", playerId: "p1", playerName: "B",
    market: "hits", side: "OVER", line: 1.5, engineProbability: 58, projection: 1.7,
    overOdds: -115, underOdds: -105, oddsTimestamp: 1_700_000_000_000, oddsAgeMs: 5000,
    inning: 5, currentStat: 1, currentStatKnown: true, signalScore: 41,
    sportsbook: "draftkings", dataQuality: "full", lane: "shadow", laneReasons: [],
    modelEdgePctPoints: 6, noVigBookProbability: 52, edgeVersion: "novig_v1",
    outcomeProbabilitySemantics: "raw_provisional", calibratedCandidateProbability: null,
    finalizedTier: "watch", officialEligibility: { eligible: false, reasons: [], version: "v1" },
    ...o,
  } as unknown as MLBQualifiedSignal;
}

const NOW = 1_700_000_005_000;

// Builds + appends fresh all-lane rows; HR excluded; returns inserted count
{
  __resetStageBCaptureCountersForTest();
  let appended: MlbLanePrediction[] = [];
  const n = await captureAllLanesToStageB(
    "g1",
    [sig({ id: "a", lane: "official" }), sig({ id: "b", market: "home_runs" }), sig({ id: "c", lane: "shadow" })],
    { appendMlbLanePredictions: async (rows) => { appended = rows; return rows.length; }, now: () => NOW },
  );
  ok(n === 2, "returns inserted count (HR excluded ⇒ 2 of 3)");
  ok(appended.length === 2 && appended[0].signalId === "a" && appended[1].signalId === "c", "appended the two non-HR rows in order");
  ok(appended.every((r) => r.capturedAt === new Date(NOW).toISOString()), "capturedAt stamped from injected clock");
  ok(appended.every((r) => r.finalizerVersion != null && r.laneVersion != null && r.goldmasterVersion != null), "real version provenance stamped");
}

// NEVER throws when the storage append rejects — returns 0
{
  __resetStageBCaptureCountersForTest();
  let threw = false;
  let result = -1;
  try {
    result = await captureAllLanesToStageB("g1", [sig()], {
      appendMlbLanePredictions: async () => { throw new Error("db down"); },
      now: () => NOW,
    });
  } catch { threw = true; }
  ok(!threw, "a storage failure never propagates out of the capture service");
  ok(result === 0, "returns 0 on failure");
}

// Empty / all-skipped input ⇒ append never called, returns 0
{
  __resetStageBCaptureCountersForTest();
  let appendCalls = 0;
  const n1 = await captureAllLanesToStageB("g1", [], {
    appendMlbLanePredictions: async (rows) => { appendCalls++; return rows.length; }, now: () => NOW,
  });
  const n2 = await captureAllLanesToStageB("g1", [sig({ market: "home_runs" })], {
    appendMlbLanePredictions: async (rows) => { appendCalls++; return rows.length; }, now: () => NOW,
  });
  ok(n1 === 0 && n2 === 0, "empty and all-HR batches capture nothing");
  ok(appendCalls === 0, "append is not called when there is nothing to write");
}

console.log(`\npredictionLedgerCaptureService.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
