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
  validateAuthorizedPayload,
  validateSourcePayload,
  normalizeTimestamp,
  isValidIsoTimestamp,
  PlateHrV2NonCanonicalValueError,
  type SourceEvidenceSnapshot,
  type PredictionSnapshot,
  type SourceIdFields,
} from "./plateHrV2Snapshots";
import { assemblePlateHrV2FeatureSnapshot } from "./plateHrV2FeatureBuilder";
import { PLATE_HR_V2_FEATURES_V1, PLATE_HR_V2_FEATURES_V2 } from "./plateHrV2FeatureContract";
import { buildRecentContactFormEvidence } from "./recentContactFormEvidence";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const FIRST_PITCH = "2026-07-01T23:05:00Z";
const PREDICTION = "2026-07-01T18:00:00Z"; // ~5h before first pitch
const PREDICTION_MS = Date.parse(PREDICTION);

// A genuinely-valid V2 AUTHORIZED PROJECTION (built by the real feature builder,
// with market + zoneLocation dropped as capture does), carrying a NEUTRAL
// recentContactForm leaf — so a prediction using it needs no contact_events source.
function buildProjection(over: Record<string, unknown> = {}): Record<string, unknown> {
  const built = assemblePlateHrV2FeatureSnapshot({
    asOfMs: PREDICTION_MS, firstPitchAtMs: Date.parse(FIRST_PITCH), lineupConfirmedAtMs: null, starterConfirmed: false,
    sessionDate: "2026-07-01", gameId: "g1", batterId: "b1", pitcherId: null, batterHand: "R", sufficientStatsRef: null,
    batterPower: { xISO: null, xSLG: null, xwOBAcon: null, barrelRatePct: null, hardHitRatePct: null, exitVelocity: null, maxEV: null, flyBallPct: null, hrFBRatioPct: null, pullRatePct: null, sweetSpotPct: null, hrPerPaSeason: null, paSample: null },
    batTracking: { avgBatSpeed: null, fastSwingRatePct: null, avgSwingLength: null, squaredUpPerSwingPct: null, blastPerSwingPct: null, swingSample: null },
    pitcherVulnerability: { pitcherKnown: false, batterHand: null, pitcherThrows: null, hrPer9VsHand: null, hrPer9Overall: null, barrelAllowedPct: null, hardHitAllowedPct: null, flyBallAllowedPct: null, bfSample: null },
    pitchType: { families: [] },
    zoneLocation: { batterHeartXslg: null, batterElevatedFbXslg: null, batterLowBreakingXslg: null, pitcherHeartRate: null, pitcherMiddleMiddleRate: null, pitcherHangerRate: null },
    parkWeatherSpray: { parkHrFactor: null, parkHrFactorHand: null, isIndoors: false, weatherAvailable: false, temperatureF: null, windSpeedMph: null, windDirection: null, batterPullAirShare: null },
    lineupOpportunity: { battingOrderSlot: null, teamImpliedRuns: null, obpAhead: null, lineupConfirmed: false },
    starterBullpen: { starterConfirmed: false, projectedPaVsStarter: null, projectedPaVsBullpen: null, bullpenHrPer9: null, bullpenBarrelAllowedPct: null },
    market: { hrOddsAvailable: false, impliedHrProbability: null, noVigImpliedHrProbability: null },
    availability: { confirmedActive: null, lateScratchRisk: null, restDayRisk: null, platoonSubRisk: null },
    contactOpportunity: { kRatePct: null, bbRatePct: null, whiffRatePct: null, contactRatePct: null, zoneContactRatePct: null, chaseRatePct: null },
    slateBaselineGameHrProbability: null,
    savantQuality: "missing", venueResolved: false, pitcherHandResolved: false, batterPowerFullyAvailable: false,
  });
  const { market, zoneLocation, ...projection } = built.derivedFeatures as Record<string, unknown>;
  return { ...projection, ...over };
}
const V2_PROJECTION = buildProjection();
/** A valid V1 authorized projection = V2 projection minus recentContactForm, V1 version. */
function buildV1Projection(): Record<string, unknown> {
  const { recentContactForm, ...v1 } = buildProjection();
  return { ...v1, featureVersion: PLATE_HR_V2_FEATURES_V1 };
}

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

// ── contact_events: same point-in-time rule as historical_stat ────────────────
ok(
  isSourceEvidenceEligible(ev({ evidenceKind: "contact_events", dataThroughAt: "2026-06-30T23:59:00Z" }), PREDICTION, FIRST_PITCH).eligible,
  "contact_events covering only prior days is eligible",
);
{
  const r = isSourceEvidenceEligible(ev({ evidenceKind: "contact_events", dataThroughAt: "2026-07-01T20:00:00Z" }), PREDICTION, FIRST_PITCH);
  ok(!r.eligible && r.reason === "data_not_strictly_before_prediction", "contact_events with data at/after prediction is excluded (leakage)");
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
  const gamePk = over.gamePk ?? "g1", batterId = over.batterId ?? "b1", featureVersion = over.featureVersion ?? PLATE_HR_V2_FEATURES_V2;
  const predictionAsOf = over.predictionAsOf ?? PREDICTION;
  const firstPitchTime = "firstPitchTime" in over ? (over.firstPitchTime ?? null) : FIRST_PITCH;
  const sorted = [...(over.sourceSnapshotIds ?? sourceIds)].sort();
  const derivedFeatures = over.derivedFeatures ?? V2_PROJECTION;
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
  const V2 = PLATE_HR_V2_FEATURES_V2;
  const out = evaluateTrainingReadIntegrity([early, late], rows);
  ok((out.admittedByVersion[V2] ?? []).length === 1, "exactly one authoritative revision admitted per batter-game (partitioned by version)");
  ok(out.admittedByVersion[V2][0].predictionSnapshotId === late.predictionSnapshotId, "the latest predictionAsOf ≤ first pitch is the authoritative revision");
  ok(out.rejected.some((r) => r.predictionSnapshotId === early.predictionSnapshotId && r.reasons.includes("superseded_by_authoritative_revision")), "earlier revision rejected as superseded (never a duplicate training row)");

  // A corrupt revision never displaces a valid one.
  const corrupt = mkPrediction({ predictionAsOf: "2026-07-01T19:00:00Z", contentHash: "bad" }, [src.sourceSnapshotId]);
  const out2 = evaluateTrainingReadIntegrity([late, corrupt], rows);
  ok((out2.admittedByVersion[V2] ?? []).length === 1 && out2.admittedByVersion[V2][0].predictionSnapshotId === late.predictionSnapshotId, "a later-but-corrupt revision is not admitted; the valid one is");

  // Distinct batter-games each get their own authoritative row.
  const src2 = mkSource({ entityId: "b2" });
  const rows2 = new Map(rows); rows2.set(src2.sourceSnapshotId, src2);
  const other = mkPrediction({ batterId: "b2" }, [src2.sourceSnapshotId]);
  const out3 = evaluateTrainingReadIntegrity([late, other], rows2);
  ok((out3.admittedByVersion[V2] ?? []).length === 2, "distinct batter-games each admit one authoritative row");
  // PR5.2 gap 1: admitted is partitioned by version — never one mixed array.
  const src3 = mkSource({ entityId: "b3" });
  const v1Pred = mkPrediction({ batterId: "b3", featureVersion: PLATE_HR_V2_FEATURES_V1, derivedFeatures: buildV1Projection() }, [src3.sourceSnapshotId]);
  const rows3 = new Map(rows); rows3.set(src3.sourceSnapshotId, src3);
  const outMixed = evaluateTrainingReadIntegrity([late, v1Pred], rows3);
  ok((outMixed.admittedByVersion[V2] ?? []).length === 1 && (outMixed.admittedByVersion[PLATE_HR_V2_FEATURES_V1] ?? []).length === 1, "V1 and V2 admitted rows are returned in separate version partitions");
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
  ok(!batchThrew && out != null && Object.values(out.admittedByVersion).flat().length === 1 && out.rejected.length === malformed.length, "batch gateway admits the one valid row and rejects all malformed rows without throwing");

  // Source under a wrong stored id (map key != stored sourceSnapshotId).
  const wrong = { ...src, sourceSnapshotId: "plate-hr-v2-src:some-other-key" };
  const m2 = new Map<string, SourceEvidenceSnapshot>([[src.sourceSnapshotId, wrong]]);
  ok(evaluatePredictionRowIntegrity(mkPrediction({}, [src.sourceSnapshotId]), m2).reasons.some((r) => r.startsWith("source_stored_id_mismatch")), "map key must equal the stored sourceSnapshotId");
  // Malformed persisted source (not the contract shape) → deterministic rejection.
  const m3 = new Map<string, unknown>([[src.sourceSnapshotId, { junk: true }]]);
  ok(evaluatePredictionRowIntegrity(mkPrediction({}, [src.sourceSnapshotId]), m3).reasons.some((r) => r.startsWith("source_shape_invalid")), "malformed persisted source rejected without throwing");
}

// ── PR4.3.2 #1: full provenance matrix ────────────────────────────────────────
{
  const reasonsWith = (over: Partial<SourceEvidenceSnapshot>) => {
    const s = mkSource(over);
    const m = new Map<string, SourceEvidenceSnapshot>([[s.sourceSnapshotId, s]]);
    return evaluatePredictionRowIntegrity(mkPrediction({}, [s.sourceSnapshotId]), m).reasons;
  };
  ok(
    reasonsWith({ availabilitySource: "fetched_at", availableAt: "2026-07-01T08:00:00.000Z", fetchedAt: "2026-07-01T09:00:00.000Z" })
      .some((r) => r.includes("fetched_at_available_ne_fetched")),
    "fetched_at requires availableAt === fetchedAt",
  );
  ok(
    reasonsWith({ availabilitySource: "provider_issued_at", availableAt: "2026-07-01T10:00:00.000Z", fetchedAt: "2026-07-01T09:00:00.000Z" })
      .some((r) => r.includes("available_after_fetched")),
    "provider-issued requires availableAt <= fetchedAt",
  );
  ok(
    reasonsWith({ availabilitySource: "fetched_at", reconstructed: true, availableAt: "2026-07-01T20:00:00.000Z", fetchedAt: "2026-07-01T20:00:00.000Z" })
      .some((r) => r.includes("reconstructed_requires_verified_as_of")),
    "reconstructed is permitted only for the verified_as_of class",
  );
  // A reconstructed verified_as_of source (available before, fetched after) IS admissible.
  {
    const vao = mkSource({ availabilitySource: "verified_as_of", reconstructed: true, availableAt: "2026-07-01T09:00:00.000Z", fetchedAt: "2026-07-01T20:00:00.000Z", dataThroughAt: "2026-06-30T23:59:00Z" });
    const m = new Map<string, SourceEvidenceSnapshot>([[vao.sourceSnapshotId, vao]]);
    ok(evaluatePredictionRowIntegrity(mkPrediction({}, [vao.sourceSnapshotId]), m).readable, "a reconstructed verified_as_of source (published before, fetched after) is admitted");
  }
  // Bad availabilitySource enum value + unparseable timestamp → shape-invalid (no throw).
  {
    const s = mkSource();
    const p = mkPrediction({}, [s.sourceSnapshotId]);
    for (const bad of [{ ...s, availabilitySource: "made_up" }, { ...s, fetchedAt: "not-a-date" }]) {
      const m = new Map<string, unknown>([[s.sourceSnapshotId, bad]]);
      let threw = false; let reasons: string[] = [];
      try { reasons = evaluatePredictionRowIntegrity(p, m).reasons; } catch { threw = true; }
      ok(!threw && reasons.some((r) => r.startsWith("source_shape_invalid")), "invalid availabilitySource / unparseable timestamp rejected as shape-invalid (no throw)");
    }
  }
}

// ── PR4.3.2 #2: null-as-absence + impossible historical counts ────────────────
{
  ok(!validateSourcePayload("park", { parkFactor: null }).ok, "{parkFactor:null} is not genuine evidence (null is absence)");
  ok(!validateSourcePayload("weather_forecast", { forecast: [null] }).ok, "{forecast:[null]} is not genuine evidence");
  ok(validateSourcePayload("park", { parkHrFactor: 1.1 }).ok, "a real park factor is genuine evidence");
  ok(!validateAuthorizedPayload({ pitchesSeen: -1 }).ok, "negative count rejected");
  ok(!validateAuthorizedPayload({ pitchesSeen: 1.5 }).ok, "non-integer count rejected");
  ok(!validateAuthorizedPayload({ pitchTypeExactStats: { FF: { pitchCount: 1.5 } } }).ok, "non-integer nested count rejected");
  ok(!validateAuthorizedPayload({ pitchTypeExactStats: { FF: { swingCount: 1, whiffCount: 8 } } }).ok, "whiffCount>swingCount rejected (monotonic)");
  ok(!validateAuthorizedPayload({ pitchTypeExactStats: { FF: { qualityBbeCount: 5, bbeCount: 2 } } }).ok, "qualityBbeCount>bbeCount rejected (monotonic)");
  ok(!validateAuthorizedPayload({ pitchTypeExactStats: { FF: { xslgContactN: 4, qualityBbeCount: 2 } } }).ok, "xslgContactN>qualityBbeCount rejected (monotonic)");
  ok(!validateAuthorizedPayload({ evPercentiles: { p50: 300 } }).ok, "out-of-domain EV percentile rejected");
  ok(!validateAuthorizedPayload({ laPercentiles: { p50: -200 } }).ok, "out-of-domain LA percentile rejected");
  ok(
    validateAuthorizedPayload({ pitchTypeExactStats: { FF: { pitchCount: 10, swingCount: 6, whiffCount: 2, contactCount: 4, bbeCount: 3, qualityBbeCount: 3, barrelCount: 1, paEndedCount: 3, hrCount: 1, xslgContactSum: 2.4, xslgContactN: 3, xwobaContactSum: 1.2, xwobaContactN: 3 } } }).ok,
    "a coherent exact-pitch entry is valid",
  );
}

// ── PR4.3.3: strict ISO/RFC3339 timestamps (write + read + normalize) ─────────
{
  // normalizeTimestamp: null is genuine absence; valid ISO/Date normalize;
  // a non-null malformed value THROWS (never conflated with null).
  ok(normalizeTimestamp(null) === null, "null timestamp is genuine absence");
  ok(normalizeTimestamp(undefined) === null, "undefined timestamp is genuine absence");
  ok(normalizeTimestamp("2026-07-01T18:00:00Z") === "2026-07-01T18:00:00.000Z", "ISO Z normalizes");
  ok(normalizeTimestamp("2026-07-01T20:00:00+02:00") === "2026-07-01T18:00:00.000Z", "ISO offset normalizes");
  ok(normalizeTimestamp(new Date("2026-07-01T18:00:00Z")) === "2026-07-01T18:00:00.000Z", "valid Date normalizes");
  const NON_ISO = ["07/01/2026", "2026-07-01 09:00:00", "July 1, 2026", "not-a-date"];
  for (const bad of NON_ISO) {
    let threw = false;
    try { normalizeTimestamp(bad); } catch (e) { threw = e instanceof PlateHrV2NonCanonicalValueError; }
    ok(threw, `normalizeTimestamp rejects non-ISO "${bad}" (malformed != null)`);
  }
  ok(isValidIsoTimestamp("2026-07-01T18:00:00Z") && isValidIsoTimestamp("2026-07-01T20:00:00+02:00"), "isValidIsoTimestamp accepts ISO Z + offset");
  ok(!isValidIsoTimestamp("07/01/2026") && !isValidIsoTimestamp("2026-07-01 09:00:00"), "isValidIsoTimestamp rejects Date.parse-lax strings");

  // Read: a stored source carrying a non-ISO timestamp is shape-invalid (no throw)
  // — it cannot collide with a genuine null provenance.
  const s = mkSource();
  const p = mkPrediction({}, [s.sourceSnapshotId]);
  for (const bad of NON_ISO) {
    const m = new Map<string, unknown>([[s.sourceSnapshotId, { ...s, fetchedAt: bad }]]);
    let threw = false; let reasons: string[] = [];
    try { reasons = evaluatePredictionRowIntegrity(p, m).reasons; } catch { threw = true; }
    ok(!threw && reasons.some((r) => r.startsWith("source_shape_invalid")), `read rejects non-ISO stored fetchedAt "${bad}" without throwing`);
  }
}

// ── PR5.2 gaps 1+3: V2 recentContactForm leaf re-derived from evidence at read ─
{
  const recentEvents = Array.from({ length: 30 }, (_, i) => ({
    exitVelocity: 100, launchAngle: 20, isBarrel: true, result: "field_out",
    timestamp: new Date(PREDICTION_MS - (30 - i) * 3_600_000).toISOString(),
  }));
  const baseline = { avgEv: 90, ev90: 105, airBallPct: 40, barrelPct: 7 };
  const built = buildRecentContactFormEvidence({
    events: recentEvents, asOfExclusiveMs: PREDICTION_MS, retrievalAtMs: PREDICTION_MS,
    batterId: "b1", schemaVersion: PLATE_HR_V2_FEATURES_V2, seasonBaseline: baseline,
  });
  const d = built.evidence!;
  // Map the descriptor to a stored source row (reconstructed=false; fetched == prediction).
  const contactSrc: SourceEvidenceSnapshot = {
    sourceSnapshotId: computeSourceSnapshotId({ ...d, reconstructed: false }),
    provider: d.provider, entityId: d.entityId, entityType: d.entityType as SourceEvidenceSnapshot["entityType"],
    evidenceKind: d.evidenceKind, dataThroughAt: d.dataThroughAt, availableAt: d.availableAt,
    availabilitySource: d.availabilitySource, validForAt: d.validForAt, reconstructed: false,
    provenanceIncomplete: d.provenanceIncomplete, fetchedAt: d.fetchedAt, schemaVersion: d.schemaVersion,
    contentHash: d.contentHash, payloadRef: d.payloadRef, authorizedPayload: d.authorizedPayload,
  };
  const rows = new Map<string, SourceEvidenceSnapshot>([[contactSrc.sourceSnapshotId, contactSrc]]);
  const leafGroup = { ...built.inputs, extra: {} };
  const v2df = { ...buildProjection(), recentContactForm: leafGroup };
  const mkV2 = (over: Partial<PredictionSnapshot> = {}, ids = [contactSrc.sourceSnapshotId]) =>
    mkPrediction({ featureVersion: PLATE_HR_V2_FEATURES_V2, derivedFeatures: v2df, ...over }, ids);

  ok(evaluatePredictionRowIntegrity(mkV2(), rows).readable, "a V2 row whose leaf re-derives from its contact_events evidence is readable");

  // Forged-but-rehashed leaf: mutate the stored leaf + recompute the envelope hash so
  // ONLY the evidence re-derivation catches it.
  const forgedLeaf = { ...built.inputs, recentFormEv: (built.inputs.recentFormEv ?? 0) + 5, extra: {} };
  const forgedDf = { ...buildProjection(), recentContactForm: forgedLeaf };
  const forged = mkPrediction({ featureVersion: PLATE_HR_V2_FEATURES_V2, derivedFeatures: forgedDf }, [contactSrc.sourceSnapshotId]);
  ok(evaluatePredictionRowIntegrity(forged, rows).reasons.includes("recent_contact_form_evidence_mismatch"), "a forged-but-rehashed leaf is caught by read-time re-derivation");

  // Missing contact_events evidence for a non-neutral leaf.
  ok(evaluatePredictionRowIntegrity(mkV2({}, ["plate-hr-v2-src:nope"]), new Map()).reasons.some((r) => r === "contact_events_missing" || r.startsWith("missing_source_evidence")), "a non-neutral V2 leaf with no contact_events evidence is rejected");

  // Duplicate contact_events evidence.
  const contactSrc2: SourceEvidenceSnapshot = { ...contactSrc };
  // A second, distinct contact source id (different batter payload) counts as duplicate kind.
  const d2 = buildRecentContactFormEvidence({ events: recentEvents.slice(0, 20), asOfExclusiveMs: PREDICTION_MS, retrievalAtMs: PREDICTION_MS, batterId: "b1", schemaVersion: PLATE_HR_V2_FEATURES_V2, seasonBaseline: baseline }).evidence!;
  const dup: SourceEvidenceSnapshot = { ...contactSrc2, sourceSnapshotId: computeSourceSnapshotId({ ...d2, reconstructed: false }), dataThroughAt: d2.dataThroughAt, contentHash: d2.contentHash, authorizedPayload: d2.authorizedPayload };
  const rowsDup = new Map(rows); rowsDup.set(dup.sourceSnapshotId, dup);
  ok(evaluatePredictionRowIntegrity(mkV2({}, [contactSrc.sourceSnapshotId, dup.sourceSnapshotId]), rowsDup).reasons.includes("contact_events_duplicate"), "two contact_events sources for one prediction are rejected");

  // Cross-bind: a stored source with a mismatched schemaVersion.
  const badVer: SourceEvidenceSnapshot = { ...contactSrc, schemaVersion: "plate_hr_v2_features_v1" };
  const badVerId = computeSourceSnapshotId({ ...d, schemaVersion: "plate_hr_v2_features_v1", reconstructed: false });
  badVer.sourceSnapshotId = badVerId;
  const rowsBadVer = new Map<string, SourceEvidenceSnapshot>([[badVerId, badVer]]);
  ok(evaluatePredictionRowIntegrity(mkV2({}, [badVerId]), rowsBadVer).reasons.includes("contact_events_schema_version_mismatch"), "contact_events schemaVersion must match the prediction featureVersion");

  // A neutral V2 leaf must NOT carry contact_events evidence.
  const neutralDf = buildProjection(); // recentContactForm neutral
  ok(evaluatePredictionRowIntegrity(mkPrediction({ featureVersion: PLATE_HR_V2_FEATURES_V2, derivedFeatures: neutralDf }, [contactSrc.sourceSnapshotId]), rows).reasons.includes("neutral_leaf_with_contact_evidence"), "a neutral V2 leaf with contact_events evidence is rejected");

  // PR5.3 gap 1: evidence must be bound to THIS batter/entity/provider — a
  // coherently-rehashed source for a different batter/entity/provider is rejected.
  // Helper: build a stored source from the descriptor with field overrides, id recomputed.
  const srcWith = (over: Partial<SourceEvidenceSnapshot>): SourceEvidenceSnapshot => {
    const merged = { ...contactSrc, ...over };
    merged.sourceSnapshotId = computeSourceSnapshotId({ ...merged, reconstructed: false });
    return merged;
  };
  // Wrong batter: evidence built for b2 (leaf re-derives cleanly), attached to b1.
  {
    const forB2 = buildRecentContactFormEvidence({ events: recentEvents, asOfExclusiveMs: PREDICTION_MS, retrievalAtMs: PREDICTION_MS, batterId: "b2", schemaVersion: PLATE_HR_V2_FEATURES_V2, seasonBaseline: baseline });
    const d2b = forB2.evidence!;
    const s2: SourceEvidenceSnapshot = {
      sourceSnapshotId: computeSourceSnapshotId({ ...d2b, reconstructed: false }),
      provider: d2b.provider, entityId: d2b.entityId, entityType: "batter", evidenceKind: d2b.evidenceKind,
      dataThroughAt: d2b.dataThroughAt, availableAt: d2b.availableAt, availabilitySource: d2b.availabilitySource,
      validForAt: d2b.validForAt, reconstructed: false, provenanceIncomplete: d2b.provenanceIncomplete,
      fetchedAt: d2b.fetchedAt, schemaVersion: d2b.schemaVersion, contentHash: d2b.contentHash, payloadRef: d2b.payloadRef, authorizedPayload: d2b.authorizedPayload,
    };
    const df = { ...buildProjection(), recentContactForm: { ...forB2.inputs, extra: {} } };
    const pred = mkPrediction({ batterId: "b1", featureVersion: PLATE_HR_V2_FEATURES_V2, derivedFeatures: df }, [s2.sourceSnapshotId]);
    ok(evaluatePredictionRowIntegrity(pred, new Map([[s2.sourceSnapshotId, s2]])).reasons.includes("contact_events_batter_mismatch"), "a coherently-rehashed source for a DIFFERENT batter is rejected");
  }
  // Wrong entity type (coherently rehashed).
  {
    const s = srcWith({ entityType: "game" });
    ok(evaluatePredictionRowIntegrity(mkV2({}, [s.sourceSnapshotId]), new Map([[s.sourceSnapshotId, s]])).reasons.includes("contact_events_entity_type_mismatch"), "a coherently-rehashed non-batter entity type is rejected");
  }
  // Unauthorized provider (coherently rehashed).
  {
    const s = srcWith({ provider: "evil_provider" });
    ok(evaluatePredictionRowIntegrity(mkV2({}, [s.sourceSnapshotId]), new Map([[s.sourceSnapshotId, s]])).reasons.includes("contact_events_provider_unauthorized"), "a coherently-rehashed unauthorized provider is rejected");
  }
}

// ── PR5.3 gap 2: nested unauthorized fields rejected (strict nested schemas) ───
{
  // V2: an extra nested field inside an authorized group must be rejected.
  const v2Bad = { ...buildProjection(), batterPower: { ...(buildProjection().batterPower as Record<string, unknown>), unversionedFeature: 123 } };
  const pred = mkPrediction({ featureVersion: PLATE_HR_V2_FEATURES_V2, derivedFeatures: v2Bad }, []);
  ok(evaluatePredictionRowIntegrity(pred, new Map()).reasons.some((r) => r.startsWith("derived_projection")), "an unauthorized NESTED field in a V2 projection is rejected");
  // V1 likewise.
  const v1Bad = { ...buildV1Projection(), pitcherVulnerability: { ...(buildV1Projection().pitcherVulnerability as Record<string, unknown>), secretEdge: 1 } };
  const pred1 = mkPrediction({ featureVersion: PLATE_HR_V2_FEATURES_V1, derivedFeatures: v1Bad }, []);
  ok(evaluatePredictionRowIntegrity(pred1, new Map()).reasons.some((r) => r.startsWith("derived_projection")), "an unauthorized NESTED field in a V1 projection is rejected");
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
