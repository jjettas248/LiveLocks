// MLB Stage C — walk-forward (out-of-sample) evaluation invariants.
//
// Run: npx tsx server/mlb/stageC/walkForwardEvaluation.test.ts

import {
  evaluateSegmentWalkForward,
  toWalkForwardObservations,
  evaluateWalkForwardFromLedger,
  type WalkForwardOptions,
} from "./walkForwardEvaluation";
import { MLB_PREDICTION_LEDGER_CONTRACT_VERSION, type MlbLanePrediction } from "@shared/mlbPredictionLedger";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps: number, msg: string) {
  ok(Math.abs(a - b) <= eps, `${msg} (got ${a}, want ~${b})`);
}

const BUILT = 1_700_000_000_000;
const OPTS: WalkForwardOptions = {
  builtAtMs: BUILT,
  bins: 10,
  pseudoCount: 5,
  minTrainSlateDates: 2,
  minTrainObs: 10,
  minEdgePctPoints: 2,
  minTierBandCount: 5,
};

// Deterministic per-slate observation generator. `slateNoonEtIso` fixes a time
// safely inside a single ET slate day (noon ET is never near the 6am rollover).
function slateNoonEtIso(dayIndex: number): string {
  // 2026-08-01 + dayIndex, at 16:00Z (~noon ET) — comfortably one slate day.
  const day = String(1 + dayIndex).padStart(2, "0");
  return `2026-08-${day}T16:00:00.000Z`;
}

function pred(o: Partial<MlbLanePrediction>): MlbLanePrediction {
  return {
    predictionId: "pid", signalId: "sid", sport: "MLB", gameId: "g1", playerId: "p1",
    playerName: "B", market: "hits", side: "OVER", lane: "shadow", line: 1.5,
    overOdds: -110, underOdds: -110, sideOdds: -110, sportsbook: "draftkings",
    oddsFetchedAt: null, oddsAgeMs: null, capturedAt: slateNoonEtIso(0),
    inning: 5, gamePhase: null, statAtCapture: 1, candidateProbabilityPct: 58,
    calibratedProbabilityPct: null, probabilitySemantics: "raw_provisional",
    modelEdgePctPoints: 6, noVigBookProbability: 50, edgeVersion: "novig_v1",
    finalizedTier: "watch", modelMethod: "hit_distribution", dataQuality: "full",
    baseEligible: false, signalScore: 41, laneReasons: [], finalizerVersion: null,
    laneVersion: null, goldmasterVersion: null, contractVersion: MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
    status: "settled", settlementResult: "cashed", finalStat: 2, settledAt: null, voidReason: null,
    ...o,
  };
}

// toWalkForwardObservations only keeps settled cashed/missed rows.
{
  const rows = [
    pred({ status: "settled", settlementResult: "cashed" }),
    pred({ status: "settled", settlementResult: "missed" }),
    pred({ status: "settled", settlementResult: "push" }),
    pred({ status: "void", settlementResult: "void" }),
    pred({ status: "captured", settlementResult: null }),
  ];
  const obs = toWalkForwardObservations(rows);
  ok(obs.length === 2, "only settled cashed/missed rows become observations (push/void/captured excluded)");
  ok(obs[0].y === 1 && obs[1].y === 0, "cashed→y=1, missed→y=0");
}

// Not enough slate history ⇒ no held-out evidence (fail-closed).
{
  const rows: MlbLanePrediction[] = [];
  for (let s = 0; s < 2; s++) {
    for (let i = 0; i < 20; i++) {
      rows.push(pred({ predictionId: `s${s}i${i}`, capturedAt: slateNoonEtIso(s), settlementResult: i % 2 ? "cashed" : "missed" }));
    }
  }
  // minTrainSlateDates=2 needs ≥3 slates total (2 train + ≥1 validation).
  const r = evaluateSegmentWalkForward("hits", toWalkForwardObservations(rows), OPTS);
  ok(!r.hasHeldOutEvidence && r.validationSampleSize === 0, "fewer than minTrainSlates+1 slates ⇒ no held-out evidence");
}

// Enough forward history ⇒ produces held-out evidence over strictly-future slates.
{
  const rows: MlbLanePrediction[] = [];
  // 6 slate days, 30 obs each. Miscalibrated raw: p=0.75 but true rate ~0.55, so
  // calibration should lower the held-out Brier vs raw.
  for (let s = 0; s < 6; s++) {
    for (let i = 0; i < 30; i++) {
      const cashed = i < 17; // ~0.567 empirical
      rows.push(pred({
        predictionId: `s${s}i${i}`,
        capturedAt: slateNoonEtIso(s),
        candidateProbabilityPct: 75,
        settlementResult: cashed ? "cashed" : "missed",
        finalStat: cashed ? 2 : 0,
      }));
    }
  }
  const r = evaluateSegmentWalkForward("hits", toWalkForwardObservations(rows), OPTS);
  ok(r.hasHeldOutEvidence, "≥minTrainSlates+1 slates ⇒ held-out evidence produced");
  ok(r.folds >= 1 && r.validationDistinctSlateDates >= 1, "at least one forward fold with a validation slate");
  ok(r.heldOutRawBrier != null && r.heldOutCalibratedBrier != null, "both held-out Briers computed");
  ok((r.heldOutCalibratedBrier as number) < (r.heldOutRawBrier as number), "calibration IMPROVES held-out Brier on miscalibrated data");
  ok(r.heldOutEcePct != null && (r.heldOutEcePct as number) >= 0, "held-out ECE computed");
}

// Held-out metrics are OUT-OF-SAMPLE: validation size < total (earliest train
// slates are never scored as validation).
{
  const rows: MlbLanePrediction[] = [];
  for (let s = 0; s < 5; s++) {
    for (let i = 0; i < 20; i++) {
      rows.push(pred({ predictionId: `s${s}i${i}`, capturedAt: slateNoonEtIso(s), settlementResult: i % 2 ? "cashed" : "missed" }));
    }
  }
  const total = toWalkForwardObservations(rows).length;
  const r = evaluateSegmentWalkForward("hits", toWalkForwardObservations(rows), OPTS);
  ok(r.validationSampleSize > 0 && r.validationSampleSize < total, "validation set is a strict subset (earliest train slates never validated)");
}

// Forward ROI: winning bets at +100 net positive; no qualifying edge ⇒ null.
{
  // Calibrated prob will be high (~win rate); no-vig book pinned low so edge clears.
  const rows: MlbLanePrediction[] = [];
  for (let s = 0; s < 5; s++) {
    for (let i = 0; i < 20; i++) {
      const cashed = i < 14; // 70% win rate
      rows.push(pred({
        predictionId: `s${s}i${i}`,
        capturedAt: slateNoonEtIso(s),
        candidateProbabilityPct: 68,
        noVigBookProbability: 50,       // big calibrated edge ⇒ bets qualify
        sideOdds: 100,                  // +100: win = +1u
        settlementResult: cashed ? "cashed" : "missed",
      }));
    }
  }
  const r = evaluateSegmentWalkForward("hits", toWalkForwardObservations(rows), OPTS);
  ok(r.forwardBetsPlaced > 0, "bets are placed when the calibrated edge clears the floor");
  ok(r.forwardRoiUnits != null && (r.forwardRoiUnits as number) > 0, "profitable held-out sample ⇒ positive forward ROI units");

  // No-vig book prob pinned ABOVE calibrated prob ⇒ no edge ⇒ no bets ⇒ ROI null.
  const rows2 = rows.map((row) => pred({ ...row, noVigBookProbability: 99 }));
  const r2 = evaluateSegmentWalkForward("hits", toWalkForwardObservations(rows2), OPTS);
  ok(r2.forwardBetsPlaced === 0 && r2.forwardRoiUnits === null, "no qualifying edge ⇒ zero bets ⇒ ROI null (honest unknown, not 0)");
}

// Missing odds on every row ⇒ ROI null even though held-out metrics exist.
{
  const rows: MlbLanePrediction[] = [];
  for (let s = 0; s < 5; s++) {
    for (let i = 0; i < 20; i++) {
      rows.push(pred({
        predictionId: `s${s}i${i}`,
        capturedAt: slateNoonEtIso(s),
        noVigBookProbability: null,
        sideOdds: null,
        settlementResult: i % 2 ? "cashed" : "missed",
      }));
    }
  }
  const r = evaluateSegmentWalkForward("hits", toWalkForwardObservations(rows), OPTS);
  ok(r.hasHeldOutEvidence && r.forwardRoiUnits === null, "no captured odds ⇒ ROI null, metrics still produced");
}

// evaluateWalkForwardFromLedger splits by segment key.
{
  const rows: MlbLanePrediction[] = [];
  for (let s = 0; s < 5; s++) {
    for (let i = 0; i < 20; i++) {
      rows.push(pred({ predictionId: `h${s}i${i}`, market: "hits", capturedAt: slateNoonEtIso(s), settlementResult: i % 2 ? "cashed" : "missed" }));
      rows.push(pred({ predictionId: `tb${s}i${i}`, market: "total_bases", capturedAt: slateNoonEtIso(s), settlementResult: i % 3 ? "cashed" : "missed" }));
    }
  }
  const byMarket = evaluateWalkForwardFromLedger(rows, (p) => p.market, OPTS);
  ok(Object.keys(byMarket).sort().join(",") === "hits,total_bases", "segments split by market key");
  ok(byMarket.hits.hasHeldOutEvidence && byMarket.total_bases.hasHeldOutEvidence, "each segment evaluated independently");
}

console.log(`\nwalkForwardEvaluation.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
