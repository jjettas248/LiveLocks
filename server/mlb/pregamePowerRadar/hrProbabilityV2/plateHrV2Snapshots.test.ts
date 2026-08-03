// Plate HR V2 snapshot contract — evidenceKind-specific point-in-time eligibility
// (§7.1) + PR4.3 training-read integrity: strict canonical hashing, full-descriptor
// source identity, full immutable prediction-envelope hash, and the single training
// admission gateway with deterministic authoritative selection.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2Snapshots.test.ts

import {
  isSourceEvidenceEligible,
  isPredictionSnapshotEligible,
  predictionSnapshotCompositeKey,
  sourceEvidenceSnapshotSchema,
  predictionSnapshotSchema,
  canonicalJson,
  canonicalHash,
  computeSourceSnapshotId,
  computePredictionSnapshotId,
  computePredictionEnvelopeHash,
  evaluatePredictionRowIntegrity,
  evaluateTrainingReadIntegrity,
  PlateHrV2NonCanonicalValueError,
  type SourceEvidenceSnapshot,
  type PredictionSnapshot,
  type SourceIdFields,
} from "./plateHrV2Snapshots";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const FIRST_PITCH = "2026-07-01T23:05:00Z";
const PREDICTION = "2026-07-01T18:00:00Z"; // ~5h before first pitch

type EvArgs = Pick<SourceEvidenceSnapshot, "evidenceKind" | "dataThroughAt" | "availableAt" | "validForAt" | "reconstructed">;
const ev = (o: Partial<EvArgs> & Pick<EvArgs, "evidenceKind">): EvArgs => ({
  dataThroughAt: null, availableAt: "2026-07-01T12:00:00Z", validForAt: null, reconstructed: false, ...o,
});

// ── historical_stat ───────────────────────────────────────────────────────────
ok(
  isSourceEvidenceEligible(ev({ evidenceKind: "historical_stat", dataThroughAt: "2026-06-30T23:59:00Z" }), PREDICTION, FIRST_PITCH).eligible,
  "historical stat covering only prior days is eligible",
);
ok(
  !isSourceEvidenceEligible(ev({ evidenceKind: "historical_stat", dataThroughAt: null }), PREDICTION, FIRST_PITCH).eligible,
  "historical stat without dataThroughAt is ineligible",
);
{
  const r = isSourceEvidenceEligible(ev({ evidenceKind: "historical_stat", dataThroughAt: "2026-07-01T20:00:00Z" }), PREDICTION, FIRST_PITCH);
  ok(!r.eligible && r.reason === "data_not_strictly_before_prediction", "historical stat with cutoff after prediction is excluded (leakage)");
}

// ── weather_forecast: the key regression ──────────────────────────────────────
{
  const r = isSourceEvidenceEligible(
    ev({ evidenceKind: "weather_forecast", availableAt: "2026-07-01T15:00:00Z", validForAt: FIRST_PITCH, dataThroughAt: null }),
    PREDICTION, FIRST_PITCH,
  );
  ok(r.eligible, "valid pregame forecast (issued-before, valid-for-future) is eligible");
}
{
  const r = isSourceEvidenceEligible(
    ev({ evidenceKind: "weather_forecast", availableAt: "2026-07-02T02:00:00Z", validForAt: FIRST_PITCH }),
    PREDICTION, FIRST_PITCH,
  );
  ok(!r.eligible && r.reason === "available_after_prediction", "observed post-game weather (available after prediction) is excluded");
}

// ── lineup / probable / park ──────────────────────────────────────────────────
ok(isSourceEvidenceEligible(ev({ evidenceKind: "lineup" }), PREDICTION, FIRST_PITCH).eligible, "lineup available before prediction is eligible");
ok(
  !isSourceEvidenceEligible(ev({ evidenceKind: "probable", availableAt: "2026-07-01T20:00:00Z" }), PREDICTION, FIRST_PITCH).eligible,
  "probable available after prediction is ineligible",
);
ok(isSourceEvidenceEligible(ev({ evidenceKind: "park" }), PREDICTION, FIRST_PITCH).eligible, "park factor is eligible");

// ── reconstructed ─────────────────────────────────────────────────────────────
{
  const base = ev({ evidenceKind: "historical_stat", dataThroughAt: "2026-06-30T23:59:00Z", reconstructed: true });
  ok(!isSourceEvidenceEligible(base, PREDICTION, FIRST_PITCH).eligible, "reconstructed without verified as-of is excluded");
  ok(isSourceEvidenceEligible(base, PREDICTION, FIRST_PITCH, { verifiedAsOfRetrieval: true }).eligible, "reconstructed WITH verified as-of is eligible");
}

// ── PR4.3: provenance-incomplete source is always ineligible ──────────────────
{
  const r = isSourceEvidenceEligible(
    { evidenceKind: "historical_stat", dataThroughAt: null, availableAt: null, validForAt: null, reconstructed: false, provenanceIncomplete: true },
    PREDICTION, FIRST_PITCH,
  );
  ok(!r.eligible && r.reason === "provenance_incomplete", "provenance-incomplete source is ineligible (honest null, not fabricated)");
}
{
  const r = isSourceEvidenceEligible(
    { evidenceKind: "lineup", dataThroughAt: null, availableAt: null, validForAt: null, reconstructed: false },
    PREDICTION, FIRST_PITCH,
  );
  ok(!r.eligible && r.reason === "missing_available_at", "null availableAt (no provenance) is ineligible");
}

// ── prediction after first pitch ──────────────────────────────────────────────
ok(
  !isSourceEvidenceEligible(ev({ evidenceKind: "lineup" }), "2026-07-01T23:30:00Z", FIRST_PITCH).eligible,
  "prediction after first pitch is ineligible (lineup)",
);

// ── prediction-level: as-of completeness (write-side helper) ──────────────────
{
  const sources = new Map<string, EvArgs>([
    ["s1", ev({ evidenceKind: "historical_stat", dataThroughAt: "2026-06-30T23:59:00Z" })],
    ["s2", ev({ evidenceKind: "weather_forecast", availableAt: "2026-07-01T15:00:00Z", validForAt: FIRST_PITCH })],
  ]);
  const good = isPredictionSnapshotEligible(
    { predictionAsOf: PREDICTION, firstPitchTime: FIRST_PITCH, sourceSnapshotIds: ["s1", "s2"] }, sources,
  );
  ok(good.eligible, "prediction with all eligible resolvable sources is eligible");
  const missing = isPredictionSnapshotEligible(
    { predictionAsOf: PREDICTION, firstPitchTime: FIRST_PITCH, sourceSnapshotIds: ["s1", "s3"] }, sources,
  );
  ok(!missing.eligible && missing.reasons.some((r) => r.startsWith("missing_source_evidence:s3")), "missing source evidence → ineligible");
  const empty = isPredictionSnapshotEligible(
    { predictionAsOf: PREDICTION, firstPitchTime: FIRST_PITCH, sourceSnapshotIds: [] }, sources,
  );
  ok(!empty.eligible && empty.reasons.includes("no_source_evidence"), "no source evidence → ineligible");
}

// ── composite key ─────────────────────────────────────────────────────────────
ok(
  predictionSnapshotCompositeKey({ gamePk: "g1", batterId: "b1", featureVersion: "v2", predictionAsOf: PREDICTION }) === `g1|b1|v2|${PREDICTION}`,
  "composite key matches the DB unique index tuple",
);

// ── PR4.3: strict canonical serialization rejects lossy values ────────────────
{
  const rejects = (v: unknown, label: string) => {
    let threw = false;
    try { canonicalJson(v); } catch (e) { threw = e instanceof PlateHrV2NonCanonicalValueError; }
    ok(threw, `canonicalJson rejects ${label}`);
  };
  rejects(NaN, "NaN");
  rejects(Infinity, "Infinity");
  rejects(-Infinity, "-Infinity");
  rejects(undefined, "undefined");
  rejects({ a: undefined }, "an undefined property (cannot collapse to {})");
  rejects(10n, "bigint");
  rejects(() => 1, "function");
  rejects(new Date(), "Date (non-plain object)");
  rejects(new Map(), "Map (non-plain object)");
  rejects({ a: NaN }, "nested NaN");
  rejects([1, NaN], "NaN in array");
  rejects([1, , 3], "sparse array hole (would silently collapse on join)");
  ok(canonicalJson({ b: 2, a: 1 }) === canonicalJson({ a: 1, b: 2 }), "canonicalJson is key-order independent");
  ok(canonicalJson({ a: null, b: [1, 2] }) === '{"a":null,"b":[1,2]}', "canonicalJson accepts null + nested arrays");
  ok(canonicalHash({ a: 1 }) !== canonicalHash({ a: 2 }), "canonicalHash changes with content");
}

// ── PR4.3: full-descriptor source identity ────────────────────────────────────
{
  const base: SourceIdFields = {
    provider: "baseball_savant", entityType: "batter", entityId: "b1", evidenceKind: "historical_stat",
    dataThroughAt: "2026-07-01T00:00:00.000Z", availableAt: "2026-07-01T09:00:00.000Z",
    fetchedAt: "2026-07-01T09:00:00.000Z", availabilitySource: "fetched_at", validForAt: null,
    reconstructed: false, provenanceIncomplete: false, schemaVersion: "v1", contentHash: "abc",
  };
  const id = computeSourceSnapshotId(base);
  ok(id.startsWith("plate-hr-v2-src:") && id.length > "plate-hr-v2-src:".length, "source id is a tagged canonical hash (not colon-concat of fields)");
  ok(computeSourceSnapshotId(base) === id, "identical descriptor → identical id (idempotent)");
  // Date vs equivalent ISO string normalize to the same id.
  ok(computeSourceSnapshotId({ ...base, fetchedAt: new Date("2026-07-01T09:00:00.000Z") }) === id, "Date and equivalent ISO fetchedAt normalize to the same id");
  // EVERY eligibility-critical provenance field participates in identity.
  const changes: Array<[string, Partial<SourceIdFields>]> = [
    ["contentHash", { contentHash: "def" }],
    ["dataThroughAt", { dataThroughAt: "2026-06-30T00:00:00.000Z" }],
    ["schemaVersion", { schemaVersion: "v2" }],
    ["fetchedAt", { fetchedAt: "2026-07-01T10:00:00.000Z" }],
    ["availableAt", { availableAt: "2026-07-01T10:00:00.000Z" }],
    ["availabilitySource", { availabilitySource: "verified_as_of" }],
    ["validForAt", { validForAt: FIRST_PITCH }],
    ["reconstructed", { reconstructed: true }],
    ["provenanceIncomplete", { provenanceIncomplete: true }],
    ["entityId", { entityId: "b2" }],
  ];
  for (const [name, patch] of changes) {
    ok(computeSourceSnapshotId({ ...base, ...patch }) !== id, `changing ${name} changes the source id (provenance-protecting)`);
  }
}

// ── PR4.3: full immutable prediction-envelope hash ────────────────────────────
{
  const envelope = {
    gamePk: "g1", batterId: "b1", featureVersion: "v2", predictionAsOf: PREDICTION, firstPitchTime: FIRST_PITCH,
    derivedFeatures: { batterPower: { xISO: 0.25 } }, sourceSnapshotIds: ["a", "b"],
  };
  const h = computePredictionEnvelopeHash(envelope);
  ok(computePredictionEnvelopeHash({ ...envelope, sourceSnapshotIds: ["b", "a"] }) === h, "envelope hash is source-id order independent (sorted)");
  const mutations: Array<[string, Partial<typeof envelope>]> = [
    ["gamePk", { gamePk: "g2" }],
    ["batterId", { batterId: "b2" }],
    ["featureVersion", { featureVersion: "v3" }],
    ["predictionAsOf", { predictionAsOf: "2026-07-01T18:30:00Z" }],
    ["firstPitchTime", { firstPitchTime: "2026-07-01T23:10:00Z" }],
    ["derivedFeatures", { derivedFeatures: { batterPower: { xISO: 0.26 } } }],
    ["sourceSnapshotIds", { sourceSnapshotIds: ["a", "c"] }],
  ];
  for (const [name, patch] of mutations) {
    ok(computePredictionEnvelopeHash({ ...envelope, ...patch }) !== h, `mutating ${name} changes the prediction envelope hash`);
  }
}

// ── PR4.3: strict training-read gateway ───────────────────────────────────────
// Build genuinely-valid rows via the real compute functions, then corrupt.
function mkSource(over: Partial<SourceEvidenceSnapshot> = {}): SourceEvidenceSnapshot {
  // Honor explicit null for nullable fields (`??` would swallow it).
  const pick = <K extends keyof SourceEvidenceSnapshot>(k: K, dflt: SourceEvidenceSnapshot[K]) =>
    (k in over ? (over[k] as SourceEvidenceSnapshot[K]) : dflt);
  const payload = "authorizedPayload" in over ? over.authorizedPayload : { battedBallEvents: 40 };
  const contentHash = over.contentHash ?? canonicalHash(payload);
  const fields: SourceIdFields = {
    provider: over.provider ?? "baseball_savant", entityType: over.entityType ?? "batter", entityId: over.entityId ?? "b1",
    evidenceKind: over.evidenceKind ?? "historical_stat", dataThroughAt: pick("dataThroughAt", "2026-06-30T23:59:00Z"),
    availableAt: pick("availableAt", "2026-07-01T09:00:00.000Z"), fetchedAt: pick("fetchedAt", "2026-07-01T09:00:00.000Z"),
    availabilitySource: over.availabilitySource ?? "fetched_at", validForAt: pick("validForAt", null),
    reconstructed: over.reconstructed ?? false, provenanceIncomplete: over.provenanceIncomplete ?? false,
    schemaVersion: over.schemaVersion ?? "v1", contentHash,
  };
  return {
    sourceSnapshotId: over.sourceSnapshotId ?? computeSourceSnapshotId(fields),
    provider: fields.provider, entityId: fields.entityId, entityType: fields.entityType as SourceEvidenceSnapshot["entityType"],
    evidenceKind: fields.evidenceKind as SourceEvidenceSnapshot["evidenceKind"],
    dataThroughAt: fields.dataThroughAt as string | null, availableAt: fields.availableAt as string | null,
    availabilitySource: fields.availabilitySource as SourceEvidenceSnapshot["availabilitySource"],
    validForAt: fields.validForAt as string | null, reconstructed: fields.reconstructed,
    provenanceIncomplete: fields.provenanceIncomplete, fetchedAt: fields.fetchedAt as string | null,
    schemaVersion: fields.schemaVersion, contentHash, payloadRef: over.payloadRef ?? null, authorizedPayload: payload,
  };
}

function mkPrediction(over: Partial<PredictionSnapshot> = {}, sourceIds: string[] = []): PredictionSnapshot {
  const gamePk = over.gamePk ?? "g1", batterId = over.batterId ?? "b1", featureVersion = over.featureVersion ?? "v2";
  const predictionAsOf = over.predictionAsOf ?? PREDICTION;
  const firstPitchTime = "firstPitchTime" in over ? (over.firstPitchTime ?? null) : FIRST_PITCH;
  const sorted = [...(over.sourceSnapshotIds ?? sourceIds)].sort();
  const derivedFeatures = over.derivedFeatures ?? { batterPower: { xISO: 0.25 } };
  return {
    predictionSnapshotId: over.predictionSnapshotId ?? computePredictionSnapshotId({ gamePk, batterId, featureVersion, predictionAsOf }),
    gamePk, batterId, featureVersion, predictionAsOf, firstPitchTime, sourceSnapshotIds: sorted, derivedFeatures,
    contentHash: over.contentHash ?? computePredictionEnvelopeHash({ gamePk, batterId, featureVersion, predictionAsOf, firstPitchTime, derivedFeatures, sourceSnapshotIds: sorted }),
    trainingEligible: over.trainingEligible ?? true, authoritative: over.authoritative ?? false,
    trainingBlockReasons: over.trainingBlockReasons ?? [],
  };
}

{
  const src = mkSource();
  const rows = new Map<string, SourceEvidenceSnapshot>([[src.sourceSnapshotId, src]]);
  const valid = mkPrediction({}, [src.sourceSnapshotId]);

  ok(evaluatePredictionRowIntegrity(valid, rows).readable, "a genuinely valid row passes per-row integrity");

  const reasonsFor = (p: PredictionSnapshot, m = rows) => evaluatePredictionRowIntegrity(p, m).reasons;

  // Corruptions — each must be caught.
  ok(reasonsFor(mkPrediction({ predictionSnapshotId: "wrong-id" }, [src.sourceSnapshotId])).includes("prediction_id_mismatch"), "wrong stored prediction id rejected");
  ok(reasonsFor(mkPrediction({ contentHash: "tampered" }, [src.sourceSnapshotId])).includes("prediction_hash_mismatch"), "tampered prediction contentHash rejected");
  {
    // Mutate derivedFeatures without recomputing the hash → mismatch.
    const p = mkPrediction({}, [src.sourceSnapshotId]);
    const bad = { ...p, derivedFeatures: { batterPower: { xISO: 0.99 } } };
    ok(reasonsFor(bad).includes("prediction_hash_mismatch"), "mutated derivedFeatures (stale hash) rejected");
  }
  ok(reasonsFor(mkPrediction({ trainingEligible: false }, [src.sourceSnapshotId])).includes("stored_not_training_eligible"), "stored trainingEligible=false rejected");
  ok(reasonsFor(mkPrediction({ trainingBlockReasons: ["x"] }, [src.sourceSnapshotId])).some((r) => r.startsWith("persisted_block_reasons")), "persisted block reasons rejected");
  ok(reasonsFor(mkPrediction({ firstPitchTime: null }, [src.sourceSnapshotId])).includes("unknown_first_pitch"), "missing first pitch rejected (no option can relax it)");
  ok(reasonsFor(mkPrediction({ predictionAsOf: "2026-07-02T00:00:00Z" }, [src.sourceSnapshotId])).includes("prediction_after_first_pitch"), "predictionAsOf after first pitch rejected");
  {
    const dup = mkPrediction({ sourceSnapshotIds: [src.sourceSnapshotId, src.sourceSnapshotId] });
    ok(reasonsFor(dup).includes("duplicate_source_ids"), "duplicate source ids rejected");
  }
  {
    // Two real sources; break the stored order AFTER construction so only the
    // sort guard trips. The envelope hash sorts internally, so it still matches.
    const s2 = mkSource({ entityId: "p1", entityType: "pitcher" });
    const m = new Map(rows); m.set(s2.sourceSnapshotId, s2);
    const twoIds = [src.sourceSnapshotId, s2.sourceSnapshotId].sort();
    const p = mkPrediction({}, twoIds); // valid: stored sorted, hash over sorted
    (p as { sourceSnapshotIds: string[] }).sourceSnapshotIds = [...twoIds].reverse();
    const res = evaluatePredictionRowIntegrity(p, m).reasons;
    ok(res.includes("source_ids_not_sorted") && !res.includes("prediction_hash_mismatch"), "unsorted source ids rejected (envelope hash is order-independent — a separate guard)");
  }
  ok(reasonsFor(mkPrediction({}, ["plate-hr-v2-src:nonexistent"]), rows).some((r) => r.startsWith("missing_source_evidence")), "missing source id rejected");
  {
    // Source stored under a wrong key (its id no longer matches its own fields).
    const wrongKey = { ...src, sourceSnapshotId: "plate-hr-v2-src:not-its-own-hash" };
    const m = new Map<string, SourceEvidenceSnapshot>([[wrongKey.sourceSnapshotId, wrongKey]]);
    const p = mkPrediction({}, [wrongKey.sourceSnapshotId]);
    ok(evaluatePredictionRowIntegrity(p, m).reasons.some((r) => r.startsWith("source_id_mismatch")), "source filed under a wrong key rejected");
  }
  {
    // Payload hash mismatch (contentHash lies about the payload).
    const s = mkSource({ contentHash: "lying-hash" });
    const m = new Map<string, SourceEvidenceSnapshot>([[s.sourceSnapshotId, s]]);
    const p = mkPrediction({}, [s.sourceSnapshotId]);
    // The wrong contentHash also perturbs the id — recompute the prediction over the actual id.
    ok(evaluatePredictionRowIntegrity(p, m).reasons.some((r) => r.startsWith("source_payload_hash_mismatch")), "source payload↔hash mismatch rejected");
  }
  {
    // Provenance-incomplete source → source_ineligible:provenance_incomplete.
    const s = mkSource({ provenanceIncomplete: true, availableAt: null, fetchedAt: null, availabilitySource: "unverified" });
    const m = new Map<string, SourceEvidenceSnapshot>([[s.sourceSnapshotId, s]]);
    const p = mkPrediction({}, [s.sourceSnapshotId]);
    ok(evaluatePredictionRowIntegrity(p, m).reasons.some((r) => r.includes("provenance_incomplete")), "provenance-incomplete source blocks the prediction");
  }
}

// ── PR4.3: gateway deterministic authoritative selection ──────────────────────
{
  const src = mkSource();
  const rows = new Map<string, SourceEvidenceSnapshot>([[src.sourceSnapshotId, src]]);
  const early = mkPrediction({ predictionAsOf: "2026-07-01T15:00:00Z" }, [src.sourceSnapshotId]);
  const late = mkPrediction({ predictionAsOf: "2026-07-01T18:00:00Z" }, [src.sourceSnapshotId]);
  const out = evaluateTrainingReadIntegrity([early, late], rows);
  ok(out.admitted.length === 1, "exactly one authoritative revision admitted per batter-game");
  ok(out.admitted[0].predictionSnapshotId === late.predictionSnapshotId, "the latest predictionAsOf ≤ first pitch is the authoritative revision");
  ok(out.rejected.some((r) => r.predictionSnapshotId === early.predictionSnapshotId && r.reasons.includes("superseded_by_authoritative_revision")), "earlier revision rejected as superseded (never a duplicate training row)");

  // A corrupt revision never displaces a valid one.
  const corrupt = mkPrediction({ predictionAsOf: "2026-07-01T19:00:00Z", contentHash: "bad" }, [src.sourceSnapshotId]);
  const out2 = evaluateTrainingReadIntegrity([late, corrupt], rows);
  ok(out2.admitted.length === 1 && out2.admitted[0].predictionSnapshotId === late.predictionSnapshotId, "a later-but-corrupt revision is not admitted; the valid one is");

  // Distinct batter-games each get their own authoritative row.
  const src2 = mkSource({ entityId: "b2" });
  const rows2 = new Map(rows); rows2.set(src2.sourceSnapshotId, src2);
  const other = mkPrediction({ batterId: "b2" }, [src2.sourceSnapshotId]);
  const out3 = evaluateTrainingReadIntegrity([late, other], rows2);
  ok(out3.admitted.length === 2, "distinct batter-games each admit one authoritative row");
}

// ── PR4.3.1 #1: reconstructed derived from fetchedAt (not availableAt) ─────────
{
  const withSource = (over: Partial<SourceEvidenceSnapshot>) => {
    const s = mkSource(over);
    const m = new Map<string, SourceEvidenceSnapshot>([[s.sourceSnapshotId, s]]);
    return evaluatePredictionRowIntegrity(mkPrediction({}, [s.sourceSnapshotId]), m).reasons;
  };
  // fetched AFTER prediction but flag says not reconstructed → inconsistent.
  ok(
    withSource({ fetchedAt: "2026-07-01T20:00:00.000Z", availableAt: "2026-07-01T09:00:00.000Z", reconstructed: false })
      .some((r) => r.includes("reconstructed_flag_inconsistent")),
    "reconstructed=false with fetchedAt>prediction is rejected (flag verified against fetchedAt)",
  );
  // Published before but fetched after (honest reconstructed:true) → excluded (no verified as-of).
  ok(
    withSource({ fetchedAt: "2026-07-01T20:00:00.000Z", availableAt: "2026-07-01T09:00:00.000Z", reconstructed: true })
      .some((r) => r.includes("reconstructed_without_verified_as_of")),
    "fetched-after-prediction (even if published before) is excluded unless verified as-of",
  );
  // provenanceIncomplete:false with a missing fetchedAt is rejected.
  ok(
    withSource({ fetchedAt: null }).some((r) => r.includes("provenance_missing_fetched_at")),
    "complete provenance with null fetchedAt is rejected",
  );
  // Inconsistent provenance-incomplete combos are rejected.
  ok(
    withSource({ provenanceIncomplete: true, availableAt: null, fetchedAt: "2026-07-01T09:00:00.000Z", availabilitySource: "unverified" })
      .some((r) => r.includes("provenance_incomplete_has_timestamps")),
    "provenance-incomplete with a non-null timestamp is rejected",
  );
}

// ── PR4.3.1 #2: typed, semantically-non-empty payloads (write + read) ─────────
{
  const payloadReasons = (payload: unknown) => {
    const s = mkSource({ authorizedPayload: payload });
    const m = new Map<string, SourceEvidenceSnapshot>([[s.sourceSnapshotId, s]]);
    return evaluatePredictionRowIntegrity(mkPrediction({}, [s.sourceSnapshotId]), m).reasons;
  };
  ok(payloadReasons({}).some((r) => r.includes("source_payload_invalid")), "empty {} historical payload rejected at read");
  ok(payloadReasons({ pitchFamilyStats: {} }).some((r) => r.includes("source_payload_invalid")), "nested-empty pitchFamilyStats rejected");
  ok(payloadReasons({ pitchFamilyStats: { fastball: {} } }).some((r) => r.includes("source_payload_invalid")), "nested-empty family entry rejected");
  ok(payloadReasons({ evPercentiles: {} }).some((r) => r.includes("source_payload_invalid")), "empty percentiles rejected");
  ok(payloadReasons({ pitchesSeen: { arbitrary: 1 } }).some((r) => r.includes("source_payload_invalid")), "wrong scalar type (object) rejected");
  ok(payloadReasons({ pitchesSeen: 42 }).every((r) => !r.startsWith("source_payload")), "a real scalar leaf is a valid payload");
}

// ── PR4.3.1 #3: gateway never throws on malformed persisted JSON ──────────────
{
  const src = mkSource();
  const rows = new Map<string, SourceEvidenceSnapshot>([[src.sourceSnapshotId, src]]);
  const good = mkPrediction({}, [src.sourceSnapshotId]);

  const malformed: unknown[] = [
    { ...good, sourceSnapshotIds: null },          // JSONB could hold null
    { ...good, trainingBlockReasons: {} },         // JSONB could hold an object
    { ...good, predictionAsOf: 12345 },            // wrong type
    null,
    "not-an-object",
    { ...good, sourceSnapshotIds: [1, 2] },        // non-string ids
  ];
  for (const bad of malformed) {
    let threw = false;
    let res: ReturnType<typeof evaluatePredictionRowIntegrity> | null = null;
    try { res = evaluatePredictionRowIntegrity(bad, rows); } catch { threw = true; }
    ok(!threw && res != null && !res.readable && res.reasons.some((r) => r.startsWith("prediction_shape_invalid")), `malformed row rejected without throwing: ${JSON.stringify(bad)?.slice(0, 40)}`);
  }
  // The batch gateway also never throws and reports the rejects.
  let batchThrew = false;
  let out: ReturnType<typeof evaluateTrainingReadIntegrity> | null = null;
  try { out = evaluateTrainingReadIntegrity([good, ...malformed], rows); } catch { batchThrew = true; }
  ok(!batchThrew && out != null && out.admitted.length === 1 && out.rejected.length === malformed.length, "batch gateway admits the one valid row and rejects all malformed rows without throwing");

  // Source under a wrong stored id (map key != stored sourceSnapshotId).
  const wrong = { ...src, sourceSnapshotId: "plate-hr-v2-src:some-other-key" };
  const m2 = new Map<string, SourceEvidenceSnapshot>([[src.sourceSnapshotId, wrong]]);
  ok(evaluatePredictionRowIntegrity(mkPrediction({}, [src.sourceSnapshotId]), m2).reasons.some((r) => r.startsWith("source_stored_id_mismatch")), "map key must equal the stored sourceSnapshotId");
  // Malformed persisted source (not the contract shape) → deterministic rejection.
  const m3 = new Map<string, unknown>([[src.sourceSnapshotId, { junk: true }]]);
  ok(evaluatePredictionRowIntegrity(mkPrediction({}, [src.sourceSnapshotId]), m3).reasons.some((r) => r.startsWith("source_shape_invalid")), "malformed persisted source rejected without throwing");
}

// ── schema round-trip (full PR4.3 shape) ──────────────────────────────────────
ok(
  sourceEvidenceSnapshotSchema.safeParse({
    sourceSnapshotId: "s1", provider: "savant", entityId: "b1", entityType: "batter", evidenceKind: "historical_stat",
    dataThroughAt: "2026-06-30T23:59:00Z", availableAt: "2026-07-01T12:00:00Z", availabilitySource: "fetched_at",
    validForAt: null, reconstructed: false, provenanceIncomplete: false, fetchedAt: "2026-07-01T12:00:00Z",
    schemaVersion: "1", contentHash: "abc", payloadRef: null, authorizedPayload: { battedBallEvents: 40 },
  }).success,
  "sourceEvidenceSnapshotSchema accepts a well-formed PR4.3 row",
);
ok(
  sourceEvidenceSnapshotSchema.safeParse({
    sourceSnapshotId: "s1", provider: "savant", entityId: "b1", entityType: "batter", evidenceKind: "historical_stat",
    dataThroughAt: null, availableAt: null, availabilitySource: "unverified", validForAt: null, reconstructed: false,
    provenanceIncomplete: true, fetchedAt: null, schemaVersion: "1", contentHash: "abc", payloadRef: null, authorizedPayload: {},
  }).success,
  "sourceEvidenceSnapshotSchema accepts a provenance-incomplete (null-timestamp, unverified) row",
);
ok(
  predictionSnapshotSchema.safeParse({
    predictionSnapshotId: "p1", gamePk: "g1", batterId: "b1", featureVersion: "v2", predictionAsOf: PREDICTION,
    firstPitchTime: FIRST_PITCH, sourceSnapshotIds: ["s1"], derivedFeatures: {}, contentHash: "xyz",
    trainingEligible: true, authoritative: false, trainingBlockReasons: [],
  }).success,
  "predictionSnapshotSchema accepts a well-formed PR4.3 row",
);

console.log(`\nplateHrV2Snapshots.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
