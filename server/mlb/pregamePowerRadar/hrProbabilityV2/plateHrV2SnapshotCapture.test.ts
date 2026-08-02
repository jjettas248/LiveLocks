// Plate HR V2 forward-capture → append-only snapshot invariants (PR3.1).
//
// Exercises the REAL path shape: descriptors assembled by
// assemblePlateHrV2EvidenceDescriptors() → buildPlateHrV2SnapshotWrite() →
// persistence. Covers: real gamePk (not ESPN gameId); per-provider/entity source
// rows; two batters sharing game evidence (dedup); source-specific content hashes
// (unrelated batter change never alters a game-level source id); CLOSED allowlist
// (market/zone excluded, unknown group rejected); absent-provenance fail-closed;
// known-first-pitch required for eligibility; never-throws persistence.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2SnapshotCapture.test.ts

import {
  assemblePlateHrV2EvidenceDescriptors,
  buildPlateHrV2SnapshotWrite,
  persistPlateHrV2SnapshotWrites,
  canonicalHash,
  startOfUtcDay,
  AUTHORIZED_DERIVED_FEATURE_GROUPS,
} from "./plateHrV2SnapshotCapture";
import type { PlateHrV2CaptureRow } from "./plateHrV2ForwardCapture";
import type { PlateHrV2EvidenceDescriptor } from "./plateHrV2Snapshots";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const CAPTURED = "2026-07-01T18:00:00.000Z";
const FIRST_PITCH = "2026-07-01T23:05:00.000Z";
const GAME_PK = "777001";
const GAME_ID = "espn-abc"; // ESPN id — must NOT be used as gamePk

function assemblyInput(over: Partial<Parameters<typeof assemblePlateHrV2EvidenceDescriptors>[0]> = {}) {
  return {
    gamePk: GAME_PK, batterId: "b1", pitcherId: "p1",
    capturedAtIso: CAPTURED, firstPitchIso: FIRST_PITCH, schemaVersion: "v1",
    batterSufficientStats: { bbe: 40, barrels: 6 }, batterStatsRef: "stats:b1",
    pitcherSufficientStats: { bf: 300 }, pitcherStatsRef: "stats:p1",
    weather: { available: true, temperatureF: 78, windSpeedMph: 8, windDirection: "out", isIndoors: false },
    lineupPosted: true,
    park: { venueResolved: true, payload: { parkHrFactorGeneric: 1.1 } },
    ...over,
  };
}

function captureRow(over: Partial<PlateHrV2CaptureRow> = {}, evidence?: PlateHrV2EvidenceDescriptor[]): PlateHrV2CaptureRow {
  return {
    snapshotId: "snap1", sessionDate: "2026-07-01", gameId: GAME_ID, gamePk: GAME_PK,
    evidence: evidence ?? assemblePlateHrV2EvidenceDescriptors(assemblyInput()),
    batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS", pitcherId: "p1", pitcherName: "P",
    battingOrderSlot: 3, buildId: "build1", firstCapturedAtIso: CAPTURED, lastCapturedAtIso: CAPTURED,
    firstPitchTimeIso: FIRST_PITCH, firstPitchLockEligible: true, gameStatus: "scheduled",
    predictionAsOfIso: CAPTURED, secondsToFirstPitch: 18300, lineupConfirmedAtIso: CAPTURED, starterConfirmed: true,
    inputContractVersion: "plate_hr_v2_features_v1", frozenInput: {} as any, inputHash: "HASH1",
    featureVersion: "plate_hr_v2_features_v1",
    derivedFeatures: {
      featureVersion: "plate_hr_v2_features_v1",
      batterPower: { xISO: 0.25 },
      pitchType: { fastball: {} },
      zoneLocation: { batterHeartXslg: null }, // UNAUTHORIZED
      market: { impliedHrProbability: 0.1 },   // UNAUTHORIZED (odds)
      dataQuality: {},
    } as any,
    availability: {} as any, featureFreshness: {} as any, rawInputs: {} as any,
    leakageWarnings: [], sufficientStatsRef: "stats:b1",
    championModelVersion: "champ", championScore10: 7, championTier: "strong", championSuppressed: false,
    ...over,
  };
}

// ── assembler: 5 real descriptors, correct providers/entities/kinds ───────────
{
  const d = assemblePlateHrV2EvidenceDescriptors(assemblyInput());
  ok(d.length === 5, `5 descriptors when all sources present (got ${d.length})`);
  ok(d.some((x) => x.evidenceKind === "historical_stat" && x.entityType === "batter" && x.entityId === "b1"), "batter historical descriptor");
  ok(d.some((x) => x.evidenceKind === "historical_stat" && x.entityType === "pitcher" && x.entityId === "p1"), "pitcher historical descriptor");
  ok(d.some((x) => x.evidenceKind === "weather_forecast" && x.entityId === GAME_PK && x.validForAt === FIRST_PITCH), "weather descriptor keyed by gamePk, validFor=first pitch");
  ok(d.some((x) => x.evidenceKind === "park" && x.entityType === "venue"), "park descriptor (split from weather)");
  ok(d.some((x) => x.evidenceKind === "lineup" && x.entityId === GAME_PK), "lineup descriptor keyed by gamePk");
  const hist = d.find((x) => x.evidenceKind === "historical_stat")!;
  ok(hist.dataThroughAt === startOfUtcDay(CAPTURED), "historical dataThroughAt derived from real fetch day");
  ok(d.every((x) => x.provider !== "" && x.contentHash.length > 0), "every descriptor has provider + real content hash");
}

// ── absent provenance → fail-closed (no descriptor) ───────────────────────────
{
  const d = assemblePlateHrV2EvidenceDescriptors(assemblyInput({
    batterSufficientStats: null, pitcherSufficientStats: null, weather: { available: false } as any, park: { venueResolved: false, payload: {} }, lineupPosted: false,
  }));
  ok(d.length === 0, "no descriptors when no real source payloads (fail-closed)");
}

// ── real gamePk stored, not ESPN gameId ───────────────────────────────────────
{
  const w = buildPlateHrV2SnapshotWrite(captureRow());
  ok(w.prediction.gamePk === GAME_PK, "prediction uses real MLB gamePk");
  ok(w.prediction.gamePk !== GAME_ID, "prediction does NOT use ESPN gameId");
  ok((w.prediction.predictionSnapshotId as string).includes(GAME_PK), "prediction id keyed by gamePk");
}

// ── closed allowlist: zone AND market excluded; only authorized kept ──────────
{
  const w = buildPlateHrV2SnapshotWrite(captureRow());
  const df = w.prediction.derivedFeatures as Record<string, unknown>;
  ok(!("zoneLocation" in df), "zoneLocation excluded");
  ok(!("market" in df), "market/odds excluded");
  ok("batterPower" in df && "pitchType" in df, "authorized groups retained");
  ok(!AUTHORIZED_DERIVED_FEATURE_GROUPS.has("zoneLocation") && !AUTHORIZED_DERIVED_FEATURE_GROUPS.has("market"), "allowlist excludes zone + market");
  // Unknown/new group is rejected (closed, not deny).
  const withUnknown = captureRow({ derivedFeatures: { featureVersion: "v", batterPower: {}, brandNewGroup: { x: 1 } } as any });
  const w2 = buildPlateHrV2SnapshotWrite(withUnknown);
  ok(!("brandNewGroup" in (w2.prediction.derivedFeatures as Record<string, unknown>)), "unknown group rejected by closed allowlist");
}

// ── source-specific hashes: game-level id stable across batters; unrelated
//    batter change never alters a game-level source id ─────────────────────────
{
  const evB1 = assemblePlateHrV2EvidenceDescriptors(assemblyInput({ batterId: "b1", batterStatsRef: "stats:b1", batterSufficientStats: { bbe: 40 } }));
  const evB2 = assemblePlateHrV2EvidenceDescriptors(assemblyInput({ batterId: "b2", batterStatsRef: "stats:b2", batterSufficientStats: { bbe: 99 } }));
  const w1 = buildPlateHrV2SnapshotWrite(captureRow({ batterId: "b1" }, evB1));
  const w2 = buildPlateHrV2SnapshotWrite(captureRow({ batterId: "b2" }, evB2));
  const gameSrc = (w: ReturnType<typeof buildPlateHrV2SnapshotWrite>, kind: string) => w.sources.find((s) => s.evidenceKind === kind)!.sourceSnapshotId;
  ok(gameSrc(w1, "weather_forecast") === gameSrc(w2, "weather_forecast"), "two batters share ONE weather source id (dedup)");
  ok(gameSrc(w1, "lineup") === gameSrc(w2, "lineup"), "two batters share ONE lineup source id");
  ok(gameSrc(w1, "park") === gameSrc(w2, "park"), "two batters share ONE park source id");
  ok(gameSrc(w1, "historical_stat") !== undefined, "pitcher/batter historical present");
  const pitcherSrc = (w: ReturnType<typeof buildPlateHrV2SnapshotWrite>) => w.sources.find((s) => s.entityType === "pitcher")!.sourceSnapshotId;
  ok(pitcherSrc(w1) === pitcherSrc(w2), "same pitcher → shared pitcher source id across batters");
  const batterSrc = (w: ReturnType<typeof buildPlateHrV2SnapshotWrite>) => w.sources.find((s) => s.entityType === "batter")!.sourceSnapshotId;
  ok(batterSrc(w1) !== batterSrc(w2), "distinct batters → distinct batter source ids");
}

// ── known first pitch required for eligibility ────────────────────────────────
{
  const eligible = buildPlateHrV2SnapshotWrite(captureRow());
  ok(eligible.prediction.trainingEligible === true, "known first pitch + eligible sources → trainingEligible");
  const noFp = buildPlateHrV2SnapshotWrite(captureRow({ firstPitchTimeIso: null, evidence: assemblePlateHrV2EvidenceDescriptors(assemblyInput({ firstPitchIso: null })) }));
  ok(noFp.prediction.trainingEligible === false, "unknown first pitch → NOT training-eligible");
}

// ── missing gamePk → build throws → persister counts, never propagates ────────
{
  const bad = captureRow({ gamePk: null });
  let threw = false;
  try { buildPlateHrV2SnapshotWrite(bad); } catch { threw = true; }
  ok(threw, "builder throws on missing gamePk");
  const res = await persistPlateHrV2SnapshotWrites([bad], {
    insertSources: async () => {}, insertPrediction: async () => {},
  });
  ok(res.failed === 1 && res.written === 0, "persister counts the missing-gamePk failure, does not throw");
}

// ── persister never throws on storage failure; counts written/failed ──────────
{
  let threw = false;
  let res: { written: number; failed: number } | null = null;
  try {
    res = await persistPlateHrV2SnapshotWrites([captureRow()], {
      insertSources: async () => { throw new Error("db down"); },
      insertPrediction: async () => { throw new Error("db down"); },
    });
  } catch { threw = true; }
  ok(!threw && res!.failed === 1, "storage failure is swallowed and counted");

  const counters = { sources: 0, predictions: 0 };
  const good = await persistPlateHrV2SnapshotWrites([captureRow(), captureRow({ batterId: "b2" })], {
    insertSources: async (s) => { counters.sources += s.length; },
    insertPrediction: async () => { counters.predictions += 1; },
  });
  ok(good.written === 2 && good.failed === 0, "two rows persisted, none failed");
  ok(counters.predictions === 2, "two prediction rows persisted");
}

// ── canonicalHash is stable + order-independent ───────────────────────────────
ok(canonicalHash({ a: 1, b: 2 }) === canonicalHash({ b: 2, a: 1 }), "canonicalHash is key-order independent");
ok(canonicalHash({ a: 1 }) !== canonicalHash({ a: 2 }), "canonicalHash changes with content");

console.log(`\nplateHrV2SnapshotCapture.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
