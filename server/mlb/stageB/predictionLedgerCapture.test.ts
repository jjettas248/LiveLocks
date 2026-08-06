// MLB Stage B — all-lane capture builder invariants.
//
// Run: npx tsx server/mlb/stageB/predictionLedgerCapture.test.ts

import {
  buildLanePredictionFromSignal,
  buildStageBCapturePredictions,
  type StageBCaptureContext,
} from "./predictionLedgerCapture";
import { MLB_PREDICTION_LEDGER_CONTRACT_VERSION } from "@shared/mlbPredictionLedger";
import type { MLBQualifiedSignal } from "../types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const CAP_MS = 1_700_000_005_000;
const ctx = (o: Partial<StageBCaptureContext> = {}): StageBCaptureContext => ({
  gameId: "g1",
  capturedAtMs: CAP_MS,
  finalizerVersion: "mlb_signal_finalizer_v1",
  laneVersion: "mlb_production_lane_v1",
  goldmasterVersion: "v27",
  captureEnabled: true,
  ...o,
});

// Minimal finalized signal — only the fields the builder reads matter; the rest
// are cast away (the real MLBQualifiedSignal has many unrelated fields).
function sig(o: Partial<MLBQualifiedSignal> = {}): MLBQualifiedSignal {
  return {
    id: "mlb:g1:p1:hits:OVER",
    gameId: "g1",
    playerId: "p1",
    playerName: "Test Batter",
    market: "hits",
    side: "OVER",
    line: 1.5,
    engineProbability: 58,
    projection: 1.7,
    overOdds: -115,
    underOdds: -105,
    oddsTimestamp: 1_700_000_000_000,
    oddsAgeMs: 5000,
    inning: 5,
    currentStat: 1,
    currentStatKnown: true,
    signalScore: 41,
    sportsbook: "draftkings",
    dataQuality: "full",
    lane: "shadow",
    laneReasons: ["market_shadow"],
    modelEdgePctPoints: 6,
    noVigBookProbability: 52,
    edgeVersion: "novig_v1",
    outcomeProbabilitySemantics: "raw_provisional",
    calibratedCandidateProbability: null,
    finalizedTier: "watch",
    officialEligibility: { eligible: false, reasons: [], version: "v1" },
    ...o,
  } as unknown as MLBQualifiedSignal;
}

// All three lanes are captured (not just official)
{
  const official = buildLanePredictionFromSignal(sig({ id: "s-off", lane: "official", market: "hits" }), ctx());
  const watch = buildLanePredictionFromSignal(sig({ id: "s-watch", lane: "watch" }), ctx());
  const shadow = buildLanePredictionFromSignal(sig({ id: "s-shadow", lane: "shadow", market: "total_bases" }), ctx());
  ok(official?.lane === "official", "official lane captured");
  ok(watch?.lane === "watch", "watch lane captured");
  ok(shadow?.lane === "shadow", "shadow lane captured");
}

// home_runs excluded (HR Radar owns its lifecycle)
{
  const hr = buildLanePredictionFromSignal(sig({ market: "home_runs" }), ctx());
  ok(hr === null, "home_runs signal is not captured");
}

// Capture gate off ⇒ nothing captured
{
  const off = buildLanePredictionFromSignal(sig(), ctx({ captureEnabled: false }));
  ok(off === null, "captureEnabled:false ⇒ null");
}

// Fail-closed: unstamped lane / bad line / bad prob / bad side skipped
{
  ok(buildLanePredictionFromSignal(sig({ lane: null as any }), ctx()) === null, "unstamped lane skipped");
  ok(buildLanePredictionFromSignal(sig({ lane: "nonsense" as any }), ctx()) === null, "unknown lane skipped");
  ok(buildLanePredictionFromSignal(sig({ line: NaN as any }), ctx()) === null, "non-finite line skipped");
  ok(buildLanePredictionFromSignal(sig({ engineProbability: NaN as any }), ctx()) === null, "non-finite probability skipped");
  ok(buildLanePredictionFromSignal(sig({ side: "NEITHER" as any }), ctx()) === null, "invalid side skipped");
}

// Field mapping fidelity + frozen provenance stamped
{
  const p = buildLanePredictionFromSignal(sig(), ctx())!;
  ok(p.predictionId === `mlb:g1:p1:hits:OVER:${CAP_MS}`, "predictionId = signalId:capturedAtMs");
  ok(p.signalId === "mlb:g1:p1:hits:OVER", "signalId carried");
  ok(p.candidateProbabilityPct === 58, "candidate prob = engineProbability (0..100 preserved)");
  ok(p.sideOdds === -115, "sideOdds = OVER odds for an OVER signal");
  ok(p.oddsFetchedAt === new Date(1_700_000_000_000).toISOString(), "oddsFetchedAt = real provider ts (ISO)");
  ok(p.capturedAt === new Date(CAP_MS).toISOString(), "capturedAt = injected clock");
  ok(p.modelEdgePctPoints === 6 && p.edgeVersion === "novig_v1", "no-vig edge + edge_version carried");
  ok(p.contractVersion === MLB_PREDICTION_LEDGER_CONTRACT_VERSION, "contractVersion stamped");
  ok(p.finalizerVersion === "mlb_signal_finalizer_v1" && p.goldmasterVersion === "v27", "version provenance stamped");
  ok(p.status === "captured" && p.settlementResult === null && p.finalStat === null, "starts unsettled");
  ok(p.signalScore === 41, "signalScore captured as a research feature (no authority)");
}

// UNDER signal picks the UNDER price
{
  const p = buildLanePredictionFromSignal(sig({ side: "UNDER" }), ctx())!;
  ok(p.side === "UNDER" && p.sideOdds === -105, "UNDER signal → sideOdds = UNDER odds");
}

// calibrated null is preserved (never identity-copied) + semantics
{
  const raw = buildLanePredictionFromSignal(sig({ calibratedCandidateProbability: null, outcomeProbabilitySemantics: "raw_provisional" }), ctx())!;
  ok(raw.calibratedProbabilityPct === null && raw.probabilitySemantics === "raw_provisional", "uncalibrated → null + raw_provisional");
  const cal = buildLanePredictionFromSignal(sig({ calibratedCandidateProbability: 60, outcomeProbabilitySemantics: "outcome_calibrated" }), ctx())!;
  ok(cal.calibratedProbabilityPct === 60 && cal.probabilitySemantics === "outcome_calibrated", "calibrated value carried");
}

// statAtCapture respects currentStatKnown
{
  const known = buildLanePredictionFromSignal(sig({ currentStat: 2, currentStatKnown: true }), ctx())!;
  ok(known.statAtCapture === 2, "known current stat captured");
  const unknown = buildLanePredictionFromSignal(sig({ currentStat: 2, currentStatKnown: false }), ctx())!;
  ok(unknown.statAtCapture === null, "unknown current stat ⇒ null (never a guessed value)");
}

// Batch builder drops skipped signals, preserves order
{
  const batch = buildStageBCapturePredictions(
    [sig({ id: "a", lane: "official" }), sig({ id: "b", market: "home_runs" }), sig({ id: "c", lane: "watch" })],
    ctx(),
  );
  ok(batch.length === 2, "batch drops the home_runs signal");
  ok(batch[0].signalId === "a" && batch[1].signalId === "c", "batch preserves order of surviving signals");
}

console.log(`\npredictionLedgerCapture.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
