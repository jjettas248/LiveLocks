// MLB Stage B — All-Lane Prediction Ledger contract invariants.
//
// Run: npx tsx shared/mlbPredictionLedger.test.ts

import {
  applyMlbLanePredictionLifecycleEvent,
  gradeMlbLanePredictionOutcome,
  settleMlbLanePrediction,
  voidMlbLanePrediction,
  isTerminalMlbLedgerStatus,
  MlbLanePredictionMutationError,
  MlbLanePredictionTerminalError,
  MlbLanePredictionTransitionError,
  MLB_LANE_PREDICTION_FROZEN_FIELDS,
  MLB_LANE_PREDICTION_MUTABLE_FIELDS,
  MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
  type MlbLanePrediction,
} from "./mlbPredictionLedger";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function throws(fn: () => unknown, ctor: Function, msg: string) {
  try { fn(); failed++; console.error(`  ✗ ${msg} (did not throw)`); }
  catch (e) { if (e instanceof ctor) { passed++; } else { failed++; console.error(`  ✗ ${msg} (wrong error: ${(e as Error).name})`); } }
}

function base(overrides: Partial<MlbLanePrediction> = {}): MlbLanePrediction {
  return {
    predictionId: "mlb:g1:p1:hits:OVER:1700000000000",
    signalId: "mlb:g1:p1:hits:OVER",
    sport: "MLB",
    gameId: "g1",
    playerId: "p1",
    playerName: "Test Batter",
    market: "hits",
    side: "OVER",
    lane: "shadow",
    line: 1.5,
    overOdds: -115,
    underOdds: -105,
    sideOdds: -115,
    sportsbook: "draftkings",
    oddsFetchedAt: "2026-08-05T18:00:00.000Z",
    oddsAgeMs: 5000,
    capturedAt: "2026-08-05T18:00:05.000Z",
    inning: 5,
    gamePhase: null,
    statAtCapture: 1,
    candidateProbabilityPct: 58,
    calibratedProbabilityPct: null,
    probabilitySemantics: "raw_provisional",
    modelEdgePctPoints: 6,
    noVigBookProbability: 52,
    edgeVersion: "novig_v1",
    finalizedTier: "lean",
    modelMethod: "hit_distribution",
    dataQuality: "full",
    baseEligible: true,
    signalScore: 41,
    laneReasons: ["market_shadow"],
    finalizerVersion: "mlb_signal_finalizer_v1",
    laneVersion: "mlb_production_lane_v1",
    goldmasterVersion: "v27",
    contractVersion: MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
    status: "captured",
    settlementResult: null,
    finalStat: null,
    settledAt: null,
    voidReason: null,
    ...overrides,
  };
}

// Frozen/mutable field partition is exhaustive + disjoint
{
  const frozen = new Set<string>(MLB_LANE_PREDICTION_FROZEN_FIELDS);
  const mutable = new Set<string>(MLB_LANE_PREDICTION_MUTABLE_FIELDS);
  const allKeys = Object.keys(base());
  const overlap = [...frozen].filter((f) => mutable.has(f));
  ok(overlap.length === 0, "frozen and mutable field sets are disjoint");
  const covered = allKeys.every((k) => frozen.has(k) || mutable.has(k));
  ok(covered, "every field is classified frozen or mutable");
  ok(frozen.size + mutable.size === allKeys.length, "partition is exhaustive (no unclassified field)");
}

// Grading — OVER/UNDER + push
{
  ok(gradeMlbLanePredictionOutcome("OVER", 1.5, 2) === "cashed", "OVER 1.5, final 2 → cashed");
  ok(gradeMlbLanePredictionOutcome("OVER", 1.5, 1) === "missed", "OVER 1.5, final 1 → missed");
  ok(gradeMlbLanePredictionOutcome("UNDER", 1.5, 1) === "cashed", "UNDER 1.5, final 1 → cashed");
  ok(gradeMlbLanePredictionOutcome("UNDER", 1.5, 2) === "missed", "UNDER 1.5, final 2 → missed");
  ok(gradeMlbLanePredictionOutcome("OVER", 2, 2) === "push", "OVER 2, final 2 → push (integer line)");
  ok(gradeMlbLanePredictionOutcome("UNDER", 6, 6) === "push", "UNDER 6, final 6 → push");
  throws(() => gradeMlbLanePredictionOutcome("OVER", 1.5, NaN), RangeError, "NaN final stat throws (never guesses)");
  throws(() => gradeMlbLanePredictionOutcome("OVER", NaN, 2), RangeError, "NaN line throws");
}

// settleMlbLanePrediction — single write, grades own frozen side/line
{
  const p = base({ side: "OVER", line: 1.5 });
  const s = settleMlbLanePrediction(p, 2, "2026-08-05T22:00:00.000Z");
  ok(s.status === "settled" && s.settlementResult === "cashed", "settle OVER 1.5 vs final 2 → settled/cashed");
  ok(s.finalStat === 2 && s.settledAt === "2026-08-05T22:00:00.000Z", "settle stamps finalStat + settledAt");
  ok(p.status === "captured" && p.settlementResult === null, "settle does not mutate input in place");
  // Re-settling a settled row is rejected (single-write, terminal)
  throws(() => settleMlbLanePrediction(s, 1, "2026-08-06T00:00:00.000Z"), MlbLanePredictionTerminalError, "re-settle terminal row rejected");
}

// voidMlbLanePrediction — terminal, excluded-from-rate result
{
  const p = base();
  const v = voidMlbLanePrediction(p, "game_postponed", "2026-08-06T02:00:00.000Z");
  ok(v.status === "void" && v.settlementResult === "void" && v.voidReason === "game_postponed", "void sets status/result/reason");
  ok(isTerminalMlbLedgerStatus(v.status), "void is terminal");
  throws(() => voidMlbLanePrediction(v, "market_voided", "x"), MlbLanePredictionTerminalError, "re-void terminal row rejected");
  throws(() => settleMlbLanePrediction(v, 2, "x"), MlbLanePredictionTerminalError, "settle after void rejected");
}

// Frozen-field mutation guard
{
  const p = base();
  throws(
    () => applyMlbLanePredictionLifecycleEvent(p, { candidateProbabilityPct: 99 } as any),
    MlbLanePredictionMutationError,
    "mutating candidateProbabilityPct (frozen) throws",
  );
  throws(
    () => applyMlbLanePredictionLifecycleEvent(p, { line: 9.5 } as any),
    MlbLanePredictionMutationError,
    "mutating line (frozen) throws",
  );
  throws(
    () => applyMlbLanePredictionLifecycleEvent(p, { signalScore: 100 } as any),
    MlbLanePredictionMutationError,
    "mutating signalScore (frozen research feature) throws",
  );
  // A legal mutable-only patch succeeds
  const patched = applyMlbLanePredictionLifecycleEvent(p, { status: "expired" });
  ok(patched.status === "expired", "mutable-only patch (status→expired) succeeds");
}

// Invalid status transition guard
{
  // settled is terminal; captured→captured is a no-op (allowed, same status)
  const p = base();
  const noop = applyMlbLanePredictionLifecycleEvent(p, { status: "captured" });
  ok(noop.status === "captured", "captured→captured no-op allowed");
  // There is no legal transition INTO captured from a terminal state; and a
  // direct settled-with-no-transition patch on a terminal row is blocked.
  const settled = settleMlbLanePrediction(base(), 2, "t");
  throws(
    () => applyMlbLanePredictionLifecycleEvent(settled, { settledAt: "later" }),
    MlbLanePredictionTerminalError,
    "any patch to a terminal row throws",
  );
}

// Terminal-status helper
{
  ok(!isTerminalMlbLedgerStatus("captured"), "captured not terminal");
  ok(isTerminalMlbLedgerStatus("settled") && isTerminalMlbLedgerStatus("void") && isTerminalMlbLedgerStatus("expired"), "settled/void/expired terminal");
}

console.log(`\nmlbPredictionLedger.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
