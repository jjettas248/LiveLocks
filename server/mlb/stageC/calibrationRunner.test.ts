// MLB Live Edge Stage C — offline calibration runner invariants (injected fakes).
//
// Run: npx tsx server/mlb/stageC/calibrationRunner.test.ts

import {
  runCalibrationFit,
  artifactToInsertRow,
  latestArtifactPerSegment,
  type CalibrationRunnerDeps,
} from "./calibrationRunner";
import { MLB_CALIBRATION_ARTIFACT_VERSION, type MlbCalibrationArtifact } from "@shared/mlbCalibration";
import { MLB_PREDICTION_LEDGER_CONTRACT_VERSION, type MlbLanePrediction, type MlbLedgerSettlementResult } from "@shared/mlbPredictionLedger";
import type { InsertMlbCalibrationArtifact, MlbCalibrationArtifactRow } from "@shared/schema";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const NOW = 1_700_000_000_000;

let seq = 0;
function pred(market: string, probPct: number, result: MlbLedgerSettlementResult, dayIdx: number): MlbLanePrediction {
  seq++;
  return {
    predictionId: `p${seq}`, signalId: `s${seq}`, sport: "MLB", gameId: "g1", playerId: "p1",
    playerName: "B", market, side: "OVER", lane: "shadow", line: 1.5, overOdds: null, underOdds: null,
    sideOdds: null, sportsbook: null, oddsFetchedAt: null, oddsAgeMs: null,
    capturedAt: new Date(NOW - dayIdx * 24 * 3600 * 1000).toISOString(),
    inning: null, gamePhase: null, statAtCapture: null, candidateProbabilityPct: probPct,
    calibratedProbabilityPct: null, probabilitySemantics: "raw_provisional", modelEdgePctPoints: null,
    noVigBookProbability: null, edgeVersion: null, finalizedTier: null, modelMethod: null, dataQuality: null,
    baseEligible: null, signalScore: null, laneReasons: [], finalizerVersion: null, laneVersion: null,
    goldmasterVersion: null, contractVersion: MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
    status: "settled", settlementResult: result, finalStat: null, settledAt: null, voidReason: null,
  };
}

function makeLedger(): MlbLanePrediction[] {
  const rows: MlbLanePrediction[] = [];
  // hits: overconfident 80% that cash ~50%, across 4 days
  for (let i = 0; i < 40; i++) rows.push(pred("hits", 80, i % 2 === 0 ? "cashed" : "missed", i % 4));
  // total_bases: some settled too
  for (let i = 0; i < 20; i++) rows.push(pred("total_bases", 60, i % 2 === 0 ? "cashed" : "missed", i % 3));
  return rows;
}

// Fits per segment, saves append rows, returns summary
{
  const rows = makeLedger();
  let saved: InsertMlbCalibrationArtifact[] = [];
  const deps: CalibrationRunnerDeps = {
    listLedgerRows: async () => rows,
    saveArtifacts: async (r) => { saved = r; return r.length; },
    now: () => NOW,
  };
  const s = await runCalibrationFit(deps);
  ok(!s.error && s.segments === 2 && s.artifactsSaved === 2, "fits + saves one artifact per market segment");
  ok(s.observationsScanned === rows.length, "reports rows scanned");
  ok(saved.map((r) => r.segment).sort().join(",") === "hits,total_bases", "saved rows keyed by market segment");
  const hits = saved.find((r) => r.segment === "hits")!;
  ok(hits.artifactId === `hits:${NOW}`, "artifactId = segment:builtAtMs");
  ok(hits.promotionReady === false, "in-sample fit is never promotion-ready");
  ok(Array.isArray(hits.promotionReasons) && (hits.promotionReasons as string[]).includes("in_sample_only"), "reasons include in_sample_only");
  ok(hits.sampleSize === 40 && hits.distinctSlateDates === 4, "sampleSize + distinct ET dates carried");
  ok(typeof hits.rawBrier === "string" && typeof hits.calibratedBrier === "string", "numeric fit stats stored as strings");
  ok(Number(hits.calibratedBrier) < Number(hits.rawBrier), "stored calibrated Brier improves on raw");
}

// NEVER throws when save rejects ⇒ error summary
{
  const deps: CalibrationRunnerDeps = {
    listLedgerRows: async () => makeLedger(),
    saveArtifacts: async () => { throw new Error("db down"); },
    now: () => NOW,
  };
  let threw = false;
  let s: any;
  try { s = await runCalibrationFit(deps); } catch { threw = true; }
  ok(!threw, "runner never throws when save fails");
  ok(s.error === true && s.artifactsSaved === 0, "failure ⇒ error summary");
}

// Empty / no-settled ledger ⇒ no fit, save not called
{
  let saveCalls = 0;
  const deps: CalibrationRunnerDeps = {
    listLedgerRows: async () => [],
    saveArtifacts: async (r) => { saveCalls++; return r.length; },
    now: () => NOW,
  };
  const s = await runCalibrationFit(deps);
  ok(s.segments === 0 && s.artifactsSaved === 0, "empty ledger ⇒ nothing fit");
  ok(saveCalls === 0, "save not called when there is nothing to persist");
}

// window bound is applied to the ledger read
{
  let capturedAfter = -1;
  let limitSeen = -1;
  const deps: CalibrationRunnerDeps = {
    listLedgerRows: async (o) => { capturedAfter = o.capturedAfterMs; limitSeen = o.limit; return []; },
    saveArtifacts: async (r) => r.length,
    now: () => NOW,
  };
  const s = await runCalibrationFit(deps, { windowDays: 30, maxRows: 100, bins: 10, pseudoCount: 20, segmentByLane: false });
  ok(capturedAfter === NOW - 30 * 24 * 3600 * 1000, "reads ledger with the policy window bound");
  ok(limitSeen === 100, "passes maxRows as the read limit");
  ok(s.truncated === false, "empty read ⇒ not truncated");
}

// Truncation is reported (not silent) when the read hits maxRows
{
  const rows = makeLedger().slice(0, 2); // exactly maxRows=2
  const deps: CalibrationRunnerDeps = {
    listLedgerRows: async () => rows,
    saveArtifacts: async (r) => r.length,
    now: () => NOW,
  };
  const s = await runCalibrationFit(deps, { windowDays: 120, maxRows: 2, bins: 10, pseudoCount: 20, segmentByLane: false });
  ok(s.truncated === true, "rows.length >= maxRows ⇒ summary.truncated true (window truncation surfaced)");
}

// artifactToInsertRow — numeric→string, jsonb passthrough, id format
{
  const artifact: MlbCalibrationArtifact = {
    segment: "hits", method: "reliability_isotonic_v1",
    bins: [{ lo: 0, hi: 1, center: 0.5, count: 10, empiricalRate: 0.5, calibratedRate: 0.5 }],
    fitStats: { sampleSize: 100, distinctSlateDates: 10, basePositiveRate: 0.5, rawBrier: 0.3, calibratedBrier: 0.2, rawLogLoss: 0.7, calibratedLogLoss: 0.6, rawEcePct: 8, calibratedEcePct: 2, inSample: true },
    builtAtMs: NOW, ledgerContractVersion: "mlb_prediction_ledger_v1", artifactVersion: MLB_CALIBRATION_ARTIFACT_VERSION,
  };
  const row = artifactToInsertRow(artifact, { ready: false, reasons: ["in_sample_only"] });
  ok(row.artifactId === `hits:${NOW}` && row.calibratedBrier === "0.2" && row.rawBrier === "0.3", "row id + numeric strings");
  ok((row.artifact as any).bins.length === 1 && (row.artifact as any).fitStats.sampleSize === 100, "full artifact stored as jsonb");
}

// latestArtifactPerSegment — dedupe newest-first
{
  const mk = (segment: string, id: string): MlbCalibrationArtifactRow => ({ artifactId: id, segment } as unknown as MlbCalibrationArtifactRow);
  const rows = [mk("hits", "hits:3"), mk("hits", "hits:2"), mk("total_bases", "tb:5"), mk("hits", "hits:1")];
  const latest = latestArtifactPerSegment(rows);
  ok(latest.length === 2, "one row per segment");
  ok(latest.find((r) => r.segment === "hits")!.artifactId === "hits:3", "keeps the first (newest) hits row");
}

console.log(`\ncalibrationRunner.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
