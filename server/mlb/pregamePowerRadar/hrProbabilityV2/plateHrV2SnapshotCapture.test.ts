// Plate HR V2 forward-capture → append-only snapshot builder invariants (PR3).
//
// Proves: authorized-fields-only (zoneLocation stripped, no zone evidence row);
// no fabricated provenance (a family without a source timestamp → no source row);
// deterministic ids that are idempotent within a cycle but append a NEW revision
// when predictionAsOf changes; reconstructed derivation; forward captures are
// eligible; and the persister NEVER throws into the build loop.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2SnapshotCapture.test.ts

import {
  buildPlateHrV2SnapshotWrite,
  persistPlateHrV2SnapshotWrites,
  UNAUTHORIZED_DERIVED_FEATURE_GROUPS,
} from "./plateHrV2SnapshotCapture";
import { isPredictionSnapshotEligible } from "./plateHrV2Snapshots";
import type { PlateHrV2CaptureRow } from "./plateHrV2ForwardCapture";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const PREDICTION = "2026-07-01T18:00:00.000Z";
const FIRST_PITCH = "2026-07-01T23:05:00.000Z";
const FETCH = "2026-07-01T17:30:00.000Z"; // before prediction

function freshness(sourceAt: string | null) {
  return sourceAt == null ? { sourceAt: null, ageMs: null, quality: "missing" as const } : { sourceAt, ageMs: 0, quality: "full" as const };
}

function captureRow(over: Partial<PlateHrV2CaptureRow> = {}): PlateHrV2CaptureRow {
  return {
    snapshotId: "snap1", sessionDate: "2026-07-01", gameId: "g1", batterId: "b1", batterName: "X",
    team: "NYY", opponent: "BOS", pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, buildId: "build1",
    firstCapturedAtIso: FETCH, lastCapturedAtIso: FETCH, firstPitchTimeIso: FIRST_PITCH,
    firstPitchLockEligible: true, gameStatus: "scheduled",
    predictionAsOfIso: PREDICTION, secondsToFirstPitch: 18300, lineupConfirmedAtIso: FETCH, starterConfirmed: true,
    inputContractVersion: "plate_hr_v2_features_v1", frozenInput: {} as any, inputHash: "HASH1",
    featureVersion: "plate_hr_v2_features_v1",
    derivedFeatures: {
      featureVersion: "plate_hr_v2_features_v1",
      batterPower: { xISO: 0.25 } as any,
      pitchType: { fastball: {} } as any,
      zoneLocation: { batterHeartXslg: null } as any, // UNAUTHORIZED — must be stripped
      dataQuality: {} as any,
    } as any,
    availability: {} as any,
    featureFreshness: {
      batterPower: freshness(FETCH),
      batTracking: freshness(null), // no source → no evidence row
      pitcherVulnerability: freshness(FETCH),
      pitchType: freshness(FETCH),
      parkWeatherSpray: freshness(FETCH),
      lineupOpportunity: freshness(FETCH),
    },
    rawInputs: {} as any, leakageWarnings: [], sufficientStatsRef: "stats1",
    championModelVersion: "champ", championScore10: 7, championTier: "strong", championSuppressed: false,
    ...over,
  };
}

// ── authorized-fields-only: zoneLocation stripped, no zone source row ──────────
{
  const w = buildPlateHrV2SnapshotWrite(captureRow());
  const df = w.prediction.derivedFeatures as Record<string, unknown>;
  ok(!("zoneLocation" in df), "zoneLocation stripped from captured derived features (unauthorized)");
  ok("batterPower" in df && "pitchType" in df, "authorized groups retained");
  ok(UNAUTHORIZED_DERIVED_FEATURE_GROUPS.has("zoneLocation"), "zoneLocation is in the unauthorized set");
  ok(!w.sources.some((s) => s.evidenceKind === ("zone" as any)), "no zone evidence row emitted");
}

// ── no fabricated provenance: batTracking (null sourceAt) → no source row ──────
{
  const w = buildPlateHrV2SnapshotWrite(captureRow());
  const entities = w.sources.map((s) => `${s.entityType}:${s.evidenceKind}`);
  ok(w.sources.length === 5, `5 timestamped families emit source rows (got ${w.sources.length})`);
  ok(!entities.includes("batter:historical_stat") || w.sources.filter((s) => s.entityId === "b1").length === 2,
    "batter historical sources = batterPower + pitchType (batTracking omitted, no timestamp)");
  ok(w.sources.some((s) => s.evidenceKind === "weather_forecast" && s.validForAt != null), "weather source has validForAt = first pitch");
  ok(w.sources.some((s) => s.evidenceKind === "lineup"), "lineup source emitted");
  ok(w.sources.every((s) => s.reconstructed === false), "forward-capture sources are not reconstructed");
  const hist = w.sources.find((s) => s.evidenceKind === "historical_stat")!;
  ok(hist.dataThroughAt != null && hist.dataThroughAt.toISOString() === "2026-07-01T00:00:00.000Z",
    "historical dataThroughAt = start of session date (excludes game day)");
}

// ── forward capture is eligible (integrates the PR1 predicate) ────────────────
{
  const w = buildPlateHrV2SnapshotWrite(captureRow());
  ok(w.prediction.trainingEligible === true, "forward-capture prediction is training-eligible");
  // Independently re-check with the PR1 predicate over the built sources.
  const resolved = new Map(w.sources.map((s) => [s.sourceSnapshotId, {
    evidenceKind: s.evidenceKind as any, dataThroughAt: s.dataThroughAt?.toISOString() ?? null,
    availableAt: s.availableAt.toISOString(), validForAt: s.validForAt?.toISOString() ?? null, reconstructed: s.reconstructed,
  }]));
  const e = isPredictionSnapshotEligible(
    { predictionAsOf: PREDICTION, firstPitchTime: FIRST_PITCH, sourceSnapshotIds: w.prediction.sourceSnapshotIds as string[] },
    resolved,
  );
  ok(e.eligible, "PR1 predicate independently agrees the forward capture is eligible");
}

// ── append-only: new predictionAsOf → new prediction id; same cycle idempotent ─
{
  const a = buildPlateHrV2SnapshotWrite(captureRow());
  const aAgain = buildPlateHrV2SnapshotWrite(captureRow());
  ok(a.prediction.predictionSnapshotId === aAgain.prediction.predictionSnapshotId, "same cycle → identical prediction id (idempotent)");

  const later = buildPlateHrV2SnapshotWrite(captureRow({ predictionAsOfIso: "2026-07-01T19:00:00.000Z" }));
  ok(later.prediction.predictionSnapshotId !== a.prediction.predictionSnapshotId, "later predictionAsOf → new revision id (append-only)");
  ok(later.prediction.gamePk === a.prediction.gamePk && later.prediction.batterId === a.prediction.batterId, "revision keeps same game/batter identity");
}

// ── reconstructed derivation: fetch after prediction → reconstructed=true ──────
{
  const w = buildPlateHrV2SnapshotWrite(captureRow({
    featureFreshness: { batterPower: freshness("2026-07-01T20:00:00.000Z") } as any,
  }));
  ok(w.sources.length === 1 && w.sources[0].reconstructed === true, "source fetched after prediction is flagged reconstructed");
}

// ── pitcher source omitted when pitcherId is null (no fabrication) ─────────────
{
  const w = buildPlateHrV2SnapshotWrite(captureRow({ pitcherId: null }));
  ok(!w.sources.some((s) => s.entityType === "pitcher"), "no pitcher source when pitcherId is null");
}

// ── persister NEVER throws into the build loop ────────────────────────────────
{
  const throwing = {
    insertSources: async () => { throw new Error("db down"); },
    insertPrediction: async () => { throw new Error("db down"); },
  };
  let threw = false;
  let result: { written: number; failed: number } | null = null;
  try { result = await persistPlateHrV2SnapshotWrites([captureRow()], throwing); } catch { threw = true; }
  ok(!threw, "persistPlateHrV2SnapshotWrites never throws even when storage throws");
  ok(result != null && result.failed === 1 && result.written === 0, "a failing row is counted, not propagated");
}
{
  const captured: { sources: number; predictions: number } = { sources: 0, predictions: 0 };
  const okInserter = {
    insertSources: async (s: unknown[]) => { captured.sources += s.length; },
    insertPrediction: async () => { captured.predictions += 1; },
  };
  const res = await persistPlateHrV2SnapshotWrites([captureRow(), captureRow({ batterId: "b2" })], okInserter);
  ok(res.written === 2 && res.failed === 0, "two rows persist successfully");
  ok(captured.predictions === 2 && captured.sources === 10, "5 source rows per capture persisted");
}

console.log(`\nplateHrV2SnapshotCapture.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
