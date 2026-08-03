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
    batterSufficientStats: { battedBallEvents: 40, sourceRowCount: 200 }, batterStatsRef: "stats:b1",
    // Real Savant provenance (required for historical evidence to be eligible).
    batterFetchedAtMs: Date.parse(CAPTURED), batterDataThroughDate: "2026-07-01",
    pitcherSufficientStats: { battedBallEvents: 120, sourceRowCount: 500 }, pitcherStatsRef: "stats:p1",
    pitcherFetchedAtMs: Date.parse(CAPTURED), pitcherDataThroughDate: "2026-07-01",
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

// ── PR4.1: zone stripped from hashed/stored evidence payload ─────────────────
{
  const withZone = { battedBallEvents: 40, sourceRowCount: 200, zoneSwings: 12, zoneTakes: 3, chaseSwings: 5, chaseTakes: 8, zoneDataAvailable: true };
  const d = assemblePlateHrV2EvidenceDescriptors(assemblyInput({ batterSufficientStats: withZone }));
  const hist = d.find((x) => x.entityType === "batter")!;
  const payload = hist.authorizedPayload as Record<string, unknown>;
  ok(!("zoneSwings" in payload) && !("chaseSwings" in payload) && !("zoneDataAvailable" in payload), "zone/chase fields stripped from evidence payload");
  ok("battedBallEvents" in payload && "sourceRowCount" in payload, "authorized fields retained in evidence payload");
  ok(hist.contentHash === canonicalHash(payload), "contentHash is over the AUTHORIZED (zone-stripped) payload");
}

// ── PR4.1: real Savant fetch provenance used (not the capture moment) ─────────
{
  const realFetchMs = Date.parse("2026-07-01T09:00:00.000Z"); // earlier than capture
  const d = assemblePlateHrV2EvidenceDescriptors(assemblyInput({
    batterFetchedAtMs: realFetchMs, batterDataThroughDate: "2026-07-01",
  }));
  const hist = d.find((x) => x.entityType === "batter")!;
  ok(hist.fetchedAt === "2026-07-01T09:00:00.000Z", "historical fetchedAt uses the real Savant fetch time, not capture moment");
  ok(hist.dataThroughAt === "2026-07-01T00:00:00.000Z", "dataThroughAt uses the real query cutoff date");
}

// ── PR4.2: payload present but provenance MISSING → prediction ineligible ─────
{
  // Batter historical payload exists, but no real fetchedAt / cutoff.
  const d = assemblePlateHrV2EvidenceDescriptors(assemblyInput({
    batterFetchedAtMs: null, batterDataThroughDate: null,
  }));
  const hist = d.find((x) => x.entityType === "batter");
  ok(hist != null, "historical source is still emitted (not silently omitted)");
  ok(hist!.dataThroughAt == null, "provenance-less historical source has no dataThroughAt (marked ineligible)");
  const w = buildPlateHrV2SnapshotWrite(captureRow({}, d));
  ok(w.prediction.trainingEligible === false, "a historical payload without real provenance INVALIDATES the prediction");
}

// ── PR4.2: source id is cutoff- and schema-sensitive ─────────────────────────
{
  const base = assemblyInput();
  const idFor = (over: Partial<typeof base>) => {
    const d = assemblePlateHrV2EvidenceDescriptors({ ...base, ...over });
    return buildPlateHrV2SnapshotWrite(captureRow({}, d)).sources.find((s) => s.entityType === "batter")!.sourceSnapshotId;
  };
  const idA = idFor({});
  const idSame = idFor({});
  const idCutoff = idFor({ batterDataThroughDate: "2026-06-30" });
  const idSchema = idFor({ schemaVersion: "v2" });
  ok(idA === idSame, "same descriptor → same source id (idempotent)");
  ok(idA !== idCutoff, "same payload, different cutoff → different source id");
  ok(idA !== idSchema, "same payload, different schema version → different source id");
}

// ── PR4.2: authorized payload is closed (unknown fields excluded) + deep-cloned ─
{
  const raw: Record<string, unknown> = { bbe: 40, barrels: 6, zoneSwings: 9, someFutureField: 1, pitchFamilyStats: { fastball: { pitches: 10 } } };
  const d = assemblePlateHrV2EvidenceDescriptors(assemblyInput({ batterSufficientStats: raw }));
  const payload = d.find((x) => x.entityType === "batter")!.authorizedPayload as Record<string, unknown>;
  ok(!("zoneSwings" in payload), "zone field excluded (closed allowlist)");
  ok(!("someFutureField" in payload), "unknown/future top-level field excluded (closed, not deny)");
  ok(!("bbe" in payload) && !("barrels" in payload), "non-allowlisted scalar keys excluded (bbe/barrels are not sufficient-stat keys)");
  ok("pitchFamilyStats" in payload, "allowlisted nested structure retained");
  // Deep-clone immutability: mutating the original nested input cannot change the payload.
  (raw.pitchFamilyStats as any).fastball.pitches = 999;
  ok(((payload.pitchFamilyStats as any).fastball.pitches) === 10, "mutating original nested input after assembly cannot change the authorized payload");
}

// ── PR4.2: builder recomputes hash; a mismatched supplied hash is overridden ──
{
  const d = assemblePlateHrV2EvidenceDescriptors(assemblyInput());
  const tampered = d.map((x) => ({ ...x, contentHash: "WRONGHASH" }));
  const w = buildPlateHrV2SnapshotWrite(captureRow({}, tampered));
  const src = w.sources.find((s) => s.entityType === "batter")!;
  ok(src.contentHash === canonicalHash(src.authorizedPayload), "builder recomputes contentHash from the stored payload (ignores a wrong supplied hash)");
  ok(w.prediction.trainingEligible === true, "recomputed-hash sources remain eligible");
}

// ── PR4.1: same content idempotent; changed content → new immutable id ────────
{
  const a = assemblePlateHrV2EvidenceDescriptors(assemblyInput({ batterSufficientStats: { battedBallEvents: 40 } }));
  const aSame = assemblePlateHrV2EvidenceDescriptors(assemblyInput({ batterSufficientStats: { battedBallEvents: 40 } }));
  const aDiff = assemblePlateHrV2EvidenceDescriptors(assemblyInput({ batterSufficientStats: { battedBallEvents: 41 } }));
  const w = (d: PlateHrV2EvidenceDescriptor[]) => buildPlateHrV2SnapshotWrite(captureRow({}, d)).sources.find((s) => s.entityType === "batter")!.sourceSnapshotId;
  ok(w(a) === w(aSame), "same content → same immutable source id (idempotent)");
  ok(w(a) !== w(aDiff), "changed same-day content → new immutable source id");
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
