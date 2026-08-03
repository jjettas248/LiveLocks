// Plate HR V2 — two-layer append-only snapshot contract + point-in-time
// eligibility + training-read integrity (plan §7.1, PR1 / PR4.2 / PR4.3).
//
// PURE: no DB / network I/O. It DOES use node:crypto for deterministic content
// hashing — that is pure computation (same input → same digest), the single
// canonical hasher shared by the write builder and the training reader so a hash
// can never diverge between the two sides.
//
// Two layers (persisted in shared/schema.ts, created by
// server/dbMigrations/plateHrV2SnapshotPersistence.ts):
//   • SourceEvidenceSnapshot   — one immutable provider-fetch of an entity's
//     evidence. Two fetches with the SAME canonical descriptor (content AND
//     provenance) are idempotent (one row); any change to content or provenance
//     mints a distinct immutable row (see computeSourceSnapshotId).
//   • PredictionSnapshot        — one (batter-game, moment); references source
//     snapshots by id. A late change is a NEW prediction snapshot, never a mutate.
//
// The eligibility rules are EVIDENCE-KIND-SPECIFIC so a valid pregame weather
// forecast (issued before the prediction, valid for a future game time) is not
// wrongly rejected by the historical-stat `dataThroughAt` guard, and observed
// post-game weather / a stat whose cutoff is at-or-after the prediction can never
// leak into training. Nothing writes these tables yet (forward capture is PR3).

import { createHash } from "node:crypto";
import { z } from "zod";

export const EVIDENCE_KINDS = [
  "historical_stat",
  "lineup",
  "probable",
  "weather_forecast",
  "park",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const AVAILABILITY_SOURCES = [
  "fetched_at",
  "provider_published_at",
  "provider_issued_at",
  "verified_as_of",
  // PR4.3: the source's real availability could NOT be established. A source
  // stamped "unverified" carries null timestamps + provenanceIncomplete=true and
  // is always training-INELIGIBLE — honest, never a fabricated capture moment.
  "unverified",
] as const;
export type AvailabilitySource = (typeof AVAILABILITY_SOURCES)[number];

// ── Strict canonical serialization + hashing (PR4.3) ──────────────────────────
// The single canonical hasher used at BOTH write time and training-read time.
// It REJECTS (throws) any value the JSON serializer could silently collapse —
// undefined, NaN, Infinity, functions, symbols, bigint, and non-plain objects
// (Date, Map, Set, class instances). This is what makes a content hash a genuine
// integrity check rather than a lossy fingerprint.

export class PlateHrV2NonCanonicalValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlateHrV2NonCanonicalValueError";
  }
}

/** Deterministic, sorted-key JSON string. Throws on any non-canonical value. */
export function canonicalJson(value: unknown): string {
  return writeCanonical(value);
}

function writeCanonical(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v as number)) {
      throw new PlateHrV2NonCanonicalValueError(`non-finite number: ${String(v)}`);
    }
    return JSON.stringify(v);
  }
  if (t === "undefined") throw new PlateHrV2NonCanonicalValueError("undefined is not canonical JSON");
  if (t === "bigint") throw new PlateHrV2NonCanonicalValueError("bigint is not canonical JSON");
  if (t === "function") throw new PlateHrV2NonCanonicalValueError("function is not canonical JSON");
  if (t === "symbol") throw new PlateHrV2NonCanonicalValueError("symbol is not canonical JSON");
  if (t === "object") {
    if (Array.isArray(v)) return `[${v.map(writeCanonical).join(",")}]`;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const name = (proto as { constructor?: { name?: string } })?.constructor?.name ?? "unknown";
      throw new PlateHrV2NonCanonicalValueError(`non-plain object is not canonical JSON: ${name}`);
    }
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    // writeCanonical(obj[k]) throws on an explicit `undefined` property value, so
    // `{a: undefined}` can never silently collapse to `{}` (they are distinct).
    return `{${keys.map((k) => `${JSON.stringify(k)}:${writeCanonical(obj[k])}`).join(",")}}`;
  }
  throw new PlateHrV2NonCanonicalValueError(`unsupported value type: ${t}`);
}

/** Stable content hash of a canonical payload. sha256 of canonicalJson, 40 hex. */
export function canonicalHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex").slice(0, 40);
}

/** Normalize a timestamp (ISO string OR Date OR null) to a canonical ISO string,
 * so the write side (ISO strings) and the training reader (DB Date objects)
 * content-address identically. Invalid/absent → null. */
export function normalizeTimestamp(x: string | Date | null | undefined): string | null {
  if (x == null) return null;
  const d = x instanceof Date ? x : new Date(x);
  const ms = d.getTime();
  return Number.isFinite(ms) ? d.toISOString() : null;
}

// ISO 8601 timestamp string (matches the DB `timestamp` serialization).
const isoTimestamp = z.string().min(1);

export const sourceEvidenceSnapshotSchema = z.object({
  sourceSnapshotId: z.string().min(1),
  provider: z.string().min(1),
  entityId: z.string().min(1),
  entityType: z.enum(["batter", "pitcher", "game", "venue"]),
  evidenceKind: z.enum(EVIDENCE_KINDS),
  // Only historical_stat requires it; null for lineup/probable/weather/park.
  dataThroughAt: isoTimestamp.nullable(),
  // PR4.3: NULLABLE. A provenance-incomplete source has null timestamps — the
  // capture moment is NEVER substituted as if it were a real fetch time.
  availableAt: isoTimestamp.nullable(),
  availabilitySource: z.enum(AVAILABILITY_SOURCES),
  // Weather forecast game time — legitimately in the future.
  validForAt: isoTimestamp.nullable(),
  reconstructed: z.boolean(),
  // PR4.3: true when the source's real fetch time / cutoff was unavailable. Such
  // a source is always training-INELIGIBLE (honest, not fabricated).
  provenanceIncomplete: z.boolean(),
  fetchedAt: isoTimestamp.nullable(),
  schemaVersion: z.string().min(1),
  contentHash: z.string().min(1),
  payloadRef: z.string().nullable(),
  // The immutable authorized payload this row hashes over (PR4.3: part of the
  // contract, matching the DB column, so a training reader can re-verify it).
  authorizedPayload: z.unknown(),
});
export type SourceEvidenceSnapshot = z.infer<typeof sourceEvidenceSnapshotSchema>;

/** The full canonical descriptor that content-addresses a source-evidence row.
 * PR4.3: it includes ALL eligibility-critical provenance (fetchedAt/availableAt/
 * availabilitySource/validForAt/reconstructed/provenanceIncomplete), not just the
 * payload content — otherwise provenance could change WITHOUT changing identity,
 * and a re-keyed/tampered row would pass the reader's recompute check. The id is a
 * canonical OBJECT hash, never colon-delimited concatenation. Used at write time
 * AND at training-read time so a row filed under the wrong key is detectable. */
export interface SourceIdFields {
  provider: string;
  entityType: string;
  entityId: string;
  evidenceKind: string;
  dataThroughAt: string | Date | null;
  availableAt: string | Date | null;
  fetchedAt: string | Date | null;
  availabilitySource: string;
  validForAt: string | Date | null;
  reconstructed: boolean;
  provenanceIncomplete: boolean;
  schemaVersion: string;
  contentHash: string;
}

export function computeSourceSnapshotId(f: SourceIdFields): string {
  const descriptor = {
    provider: f.provider,
    entityType: f.entityType,
    entityId: f.entityId,
    evidenceKind: f.evidenceKind,
    dataThroughAt: normalizeTimestamp(f.dataThroughAt),
    availableAt: normalizeTimestamp(f.availableAt),
    fetchedAt: normalizeTimestamp(f.fetchedAt),
    availabilitySource: f.availabilitySource,
    validForAt: normalizeTimestamp(f.validForAt),
    reconstructed: f.reconstructed,
    provenanceIncomplete: f.provenanceIncomplete,
    schemaVersion: f.schemaVersion,
    contentHash: f.contentHash,
  };
  return `plate-hr-v2-src:${canonicalHash(descriptor)}`;
}

// An explicit, real provider/entity evidence descriptor assembled at the fetch
// site (PR3.1). One descriptor == one real source payload (a Savant CSV for an
// entity, an Open-Meteo forecast for a game, a confirmed lineup, park geometry).
// Every field is real — nothing is synthesized. The builder maps a descriptor to
// a SourceEvidenceSnapshot verbatim; it never invents provenance. PR4.3: a
// provenance-incomplete source carries NULL fetchedAt/availableAt + availability
// source "unverified" + provenanceIncomplete=true (never a substituted moment).
export const plateHrV2EvidenceDescriptorSchema = z.object({
  provider: z.string().min(1),
  entityType: z.enum(["batter", "pitcher", "game", "venue"]),
  entityId: z.string().min(1),
  evidenceKind: z.enum(EVIDENCE_KINDS),
  fetchedAt: isoTimestamp.nullable(),
  availableAt: isoTimestamp.nullable(),
  availabilitySource: z.enum(AVAILABILITY_SOURCES),
  provenanceIncomplete: z.boolean(),
  dataThroughAt: isoTimestamp.nullable(),
  validForAt: isoTimestamp.nullable(),
  schemaVersion: z.string().min(1),
  // Canonical hash of THIS source's authorized payload — not the whole frozen
  // batter-game input. Shared game/venue evidence hashes identically across
  // batters, so it dedupes to a single append-only row.
  contentHash: z.string().min(1),
  payloadRef: z.string().nullable(),
  // The immutable authorized payload this source hashes over (zone fields
  // stripped). Stored inline in the append-only source-evidence row so the
  // evidence is self-contained and content-addressed — it never depends on a
  // mutable sufficient-stats row that could be replaced same-day (PR4.1 #5).
  authorizedPayload: z.unknown(),
});
export type PlateHrV2EvidenceDescriptor = z.infer<typeof plateHrV2EvidenceDescriptorSchema>;

export const predictionSnapshotSchema = z.object({
  predictionSnapshotId: z.string().min(1),
  gamePk: z.string().min(1),
  batterId: z.string().min(1),
  featureVersion: z.string().min(1),
  predictionAsOf: isoTimestamp,
  firstPitchTime: isoTimestamp.nullable(),
  sourceSnapshotIds: z.array(z.string().min(1)),
  derivedFeatures: z.record(z.string(), z.unknown()),
  contentHash: z.string().min(1),
  // PR4.3: persisted so a training reader can cross-check the stored decision +
  // reasons, but the reader RECOMPUTES eligibility as the authority (never trusts
  // these blindly).
  trainingEligible: z.boolean(),
  authoritative: z.boolean(),
  trainingBlockReasons: z.array(z.string()),
});
export type PredictionSnapshot = z.infer<typeof predictionSnapshotSchema>;

/** Append-only composite identity (matches the DB unique index). */
export function predictionSnapshotCompositeKey(p: {
  gamePk: string;
  batterId: string;
  featureVersion: string;
  predictionAsOf: string;
}): string {
  return `${p.gamePk}|${p.batterId}|${p.featureVersion}|${p.predictionAsOf}`;
}

/** Deterministic prediction-snapshot id — the append-only identity, recomputed by
 * the training reader from the row's own immutable key fields. */
export function computePredictionSnapshotId(f: {
  gamePk: string;
  batterId: string;
  featureVersion: string;
  predictionAsOf: string | Date;
}): string {
  return `plate-hr-v2-pred:${f.gamePk}:${f.batterId}:${f.featureVersion}:${normalizeTimestamp(f.predictionAsOf)}`;
}

/** The COMPLETE immutable prediction envelope covered by contentHash (PR4.3 #5).
 * Covers every immutable field — gamePk/batterId/featureVersion/predictionAsOf/
 * firstPitchTime — plus the authorized feature vector and the sorted source ids.
 * Mutable lifecycle state (authoritative/trainingEligible/trainingBlockReasons)
 * is deliberately EXCLUDED and verified separately. */
export interface PredictionEnvelopeFields {
  gamePk: string;
  batterId: string;
  featureVersion: string;
  predictionAsOf: string | Date;
  firstPitchTime: string | Date | null;
  derivedFeatures: Record<string, unknown>;
  sourceSnapshotIds: readonly string[];
}

export function computePredictionEnvelopeHash(f: PredictionEnvelopeFields): string {
  return canonicalHash({
    gamePk: f.gamePk,
    batterId: f.batterId,
    featureVersion: f.featureVersion,
    predictionAsOf: normalizeTimestamp(f.predictionAsOf),
    firstPitchTime: normalizeTimestamp(f.firstPitchTime),
    derivedFeatures: f.derivedFeatures,
    sourceSnapshotIds: [...f.sourceSnapshotIds].sort(),
  });
}

function ms(iso: string | Date | null | undefined): number | null {
  if (iso == null) return null;
  const t = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: string; // "ok" when eligible; otherwise a stable machine code
}

/**
 * Evidence-kind-specific point-in-time eligibility for ONE source-evidence row,
 * relative to a prediction moment and (optionally) first pitch.
 *
 * Universal necessary condition: `availableAt ≤ predictionAsOf` (we cannot have
 * known evidence we only fetched later — this is what excludes observed
 * post-game weather). Then per kind:
 *   historical_stat  : dataThroughAt < predictionAsOf ≤ firstPitch
 *   lineup | probable: availableAt ≤ predictionAsOf ≤ firstPitch
 *   weather_forecast : availableAt(issuedAt) ≤ predictionAsOf ; validForAt MAY be future
 *   park             : availableAt ≤ predictionAsOf
 *   reconstructed    : eligible ONLY with verified reproducible as-of retrieval
 */
export function isSourceEvidenceEligible(
  ev: Pick<
    SourceEvidenceSnapshot,
    "evidenceKind" | "dataThroughAt" | "availableAt" | "validForAt" | "reconstructed"
  > & { provenanceIncomplete?: boolean },
  predictionAsOf: string | Date,
  firstPitch: string | Date | null,
  opts: { verifiedAsOfRetrieval?: boolean } = {},
): EligibilityResult {
  // PR4.3: a provenance-incomplete source (no real fetch time / cutoff) is
  // ALWAYS ineligible — its timestamps are honestly null, never the capture moment.
  if (ev.provenanceIncomplete) return { eligible: false, reason: "provenance_incomplete" };

  const pAsOf = ms(predictionAsOf);
  const avail = ms(ev.availableAt);
  const fp = ms(firstPitch);
  if (pAsOf == null) return { eligible: false, reason: "unparseable_prediction_as_of" };
  if (avail == null) return { eligible: false, reason: "missing_available_at" };

  // A record fetched after the prediction cannot be a genuine historical snapshot
  // unless the provider supports reproducible as-of retrieval (PR2 feasibility).
  if (ev.reconstructed && !opts.verifiedAsOfRetrieval) {
    return { eligible: false, reason: "reconstructed_without_verified_as_of" };
  }

  // Universal: the evidence must have been knowable at prediction time. This is
  // the guard that excludes observed post-game weather (availableAt > prediction).
  if (avail > pAsOf) return { eligible: false, reason: "available_after_prediction" };

  const predictionBeforeFirstPitch = fp == null || pAsOf <= fp;

  switch (ev.evidenceKind) {
    case "historical_stat": {
      const dta = ms(ev.dataThroughAt);
      if (dta == null) return { eligible: false, reason: "missing_data_through_at" };
      // Excludes a stat whose coverage runs to/after the prediction (leakage).
      if (!(dta < pAsOf)) return { eligible: false, reason: "data_not_strictly_before_prediction" };
      if (!predictionBeforeFirstPitch) return { eligible: false, reason: "prediction_after_first_pitch" };
      return { eligible: true, reason: "ok" };
    }
    case "lineup":
    case "probable": {
      if (!predictionBeforeFirstPitch) return { eligible: false, reason: "prediction_after_first_pitch" };
      return { eligible: true, reason: "ok" };
    }
    case "weather_forecast": {
      // availableAt(issuedAt) ≤ predictionAsOf already enforced above.
      // validForAt is intentionally NOT constrained — a forecast legitimately
      // describes a future game time and must never be failed by a dataThroughAt
      // rule it does not have.
      return { eligible: true, reason: "ok" };
    }
    case "park": {
      // Static/seasonal; availableAt ≤ predictionAsOf is sufficient.
      return { eligible: true, reason: "ok" };
    }
    default: {
      return { eligible: false, reason: "unknown_evidence_kind" };
    }
  }
}

export interface PredictionEligibilityResult {
  eligible: boolean;
  reasons: string[]; // empty when eligible
}

/** A resolved source for eligibility. Carries the stored authorized payload +
 * contentHash so the write-side check can re-verify payload↔hash agreement. */
export type ResolvedEligibilitySource = Pick<
  SourceEvidenceSnapshot,
  "evidenceKind" | "dataThroughAt" | "availableAt" | "validForAt" | "reconstructed"
> & { authorizedPayload?: unknown; contentHash?: string; provenanceIncomplete?: boolean };

export type ResolvedSourceMap = ReadonlyMap<string, ResolvedEligibilitySource>;

/**
 * WRITE-SIDE eligibility helper — computes the `trainingEligible` decision + the
 * `trainingBlockReasons` persisted alongside a new prediction snapshot. This is a
 * best-effort record of the decision at write time; the AUTHORITY at training
 * time is `evaluateTrainingReadIntegrity` below, which recomputes everything.
 */
export function isPredictionSnapshotEligible(
  prediction: Pick<PredictionSnapshot, "predictionAsOf" | "firstPitchTime" | "sourceSnapshotIds">,
  resolvedSources: ResolvedSourceMap,
  opts: {
    verifiedAsOfRetrieval?: boolean;
    requireKnownFirstPitch?: boolean;
    /** When provided, every source must have a non-null authorizedPayload whose
     * canonical hash equals its contentHash — else the source is ineligible. */
    hashPayload?: (payload: unknown) => string;
  } = {},
): PredictionEligibilityResult {
  const reasons: string[] = [];
  const pAsOf = ms(prediction.predictionAsOf);
  const fp = ms(prediction.firstPitchTime);
  if (pAsOf == null) return { eligible: false, reasons: ["unparseable_prediction_as_of"] };
  if (opts.requireKnownFirstPitch && fp == null) reasons.push("unknown_first_pitch");
  if (fp != null && pAsOf > fp) reasons.push("prediction_after_first_pitch");

  if (prediction.sourceSnapshotIds.length === 0) {
    reasons.push("no_source_evidence");
  }
  for (const id of prediction.sourceSnapshotIds) {
    const src = resolvedSources.get(id);
    if (!src) {
      reasons.push(`missing_source_evidence:${id}`);
      continue;
    }
    const r = isSourceEvidenceEligible(src, prediction.predictionAsOf, prediction.firstPitchTime, opts);
    if (!r.eligible) reasons.push(`source_ineligible:${id}:${r.reason}`);
    if (opts.hashPayload) {
      if (src.authorizedPayload == null) {
        reasons.push(`source_payload_missing:${id}`);
      } else if (src.contentHash == null || opts.hashPayload(src.authorizedPayload) !== src.contentHash) {
        reasons.push(`source_payload_hash_mismatch:${id}`);
      }
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

// ── Strict training-read integrity + authoritative selection (PR4.3) ──────────

export interface TrainingReadResult {
  readable: boolean;
  reasons: string[]; // empty when readable
}

/**
 * Per-row integrity verification. UNCONDITIONAL — accepts no options that could
 * weaken a check, and uses the module's single canonical hasher (no injectable
 * hash). It recomputes, from the row's own stored fields:
 *   • the prediction snapshot id (immutable key),
 *   • every source snapshot id (full provenance descriptor),
 *   • every source's point-in-time eligibility (never trusts cached trainingEligible),
 *   • every authorized payload ↔ contentHash agreement (rejects non-canonical values),
 *   • the complete prediction envelope hash (gamePk/batterId/featureVersion/
 *     predictionAsOf/firstPitchTime/derivedFeatures/sortedSourceIds).
 * It also requires a parseable first pitch, predictionAsOf ≤ first pitch, and
 * canonically sorted + unique source ids.
 *
 * NOTE: this is the per-row core. The ONLY training-data admission gateway is
 * `evaluateTrainingReadIntegrity` below, which additionally enforces one
 * authoritative revision per batter-game.
 */
export function evaluatePredictionRowIntegrity(
  prediction: PredictionSnapshot,
  sourceRows: ReadonlyMap<string, SourceEvidenceSnapshot>,
): TrainingReadResult {
  const reasons: string[] = [];

  // Stored decision is a cross-check ONLY (recomputation below is the authority).
  if (prediction.trainingEligible !== true) reasons.push("stored_not_training_eligible");
  if ((prediction.trainingBlockReasons?.length ?? 0) > 0) {
    reasons.push(`persisted_block_reasons:${prediction.trainingBlockReasons.join(",")}`);
  }

  // Recompute the prediction snapshot id from its immutable key fields.
  const recomputedPredId = computePredictionSnapshotId({
    gamePk: prediction.gamePk,
    batterId: prediction.batterId,
    featureVersion: prediction.featureVersion,
    predictionAsOf: prediction.predictionAsOf,
  });
  if (recomputedPredId !== prediction.predictionSnapshotId) reasons.push("prediction_id_mismatch");

  // Parseable first pitch + predictionAsOf ≤ first pitch (unconditional).
  const pAsOf = ms(prediction.predictionAsOf);
  const fp = ms(prediction.firstPitchTime);
  if (pAsOf == null) reasons.push("unparseable_prediction_as_of");
  if (fp == null) reasons.push("unknown_first_pitch");
  else if (pAsOf != null && pAsOf > fp) reasons.push("prediction_after_first_pitch");

  // Source ids: present, unique, and canonically sorted.
  const ids = prediction.sourceSnapshotIds;
  if (ids.length === 0) reasons.push("no_source_evidence");
  if (new Set(ids).size !== ids.length) reasons.push("duplicate_source_ids");
  const sorted = [...ids].sort();
  if (ids.some((v, i) => v !== sorted[i])) reasons.push("source_ids_not_sorted");

  for (const id of ids) {
    const src = sourceRows.get(id);
    if (!src) { reasons.push(`missing_source_evidence:${id}`); continue; }

    // Recompute the source id from the row's OWN full provenance descriptor — a
    // row stored under a wrong key, or whose provenance was altered without
    // changing the key, is rejected.
    let recomputedId: string;
    try {
      recomputedId = computeSourceSnapshotId(src);
    } catch {
      reasons.push(`source_noncanonical:${id}`);
      continue;
    }
    if (recomputedId !== id) reasons.push(`source_id_mismatch:${id}`);

    // Point-in-time rules (recomputed, strict — no verified-as-of relaxation).
    const e = isSourceEvidenceEligible(src, prediction.predictionAsOf, prediction.firstPitchTime, {});
    if (!e.eligible) reasons.push(`source_ineligible:${id}:${e.reason}`);

    // Authorized payload present, canonical, and hashes to the stored contentHash.
    if (src.authorizedPayload == null) {
      reasons.push(`source_payload_missing:${id}`);
    } else {
      let h: string;
      try {
        h = canonicalHash(src.authorizedPayload);
      } catch {
        reasons.push(`source_payload_noncanonical:${id}`);
        continue;
      }
      if (h !== src.contentHash) reasons.push(`source_payload_hash_mismatch:${id}`);
    }
  }

  // Prediction hash recomputes over the COMPLETE immutable envelope.
  let envHash: string | null = null;
  try {
    envHash = computePredictionEnvelopeHash(prediction);
  } catch {
    reasons.push("prediction_features_noncanonical");
  }
  if (envHash != null && envHash !== prediction.contentHash) reasons.push("prediction_hash_mismatch");

  return { readable: reasons.length === 0, reasons };
}

export interface TrainingReadOutcome {
  /** Exactly one authoritative, integrity-valid revision per (gamePk, batterId,
   * featureVersion) — safe to use as training observations. */
  admitted: PredictionSnapshot[];
  /** Every row that did NOT enter training, with the reasons why. */
  rejected: { predictionSnapshotId: string; reasons: string[] }[];
}

/**
 * THE single training-data admission gateway (PR4.3 #3, #4). Given the persisted
 * prediction rows + a source-row resolver, it:
 *   1. runs unconditional per-row integrity (evaluatePredictionRowIntegrity), then
 *   2. deterministically selects ONE authoritative revision per (gamePk, batterId,
 *      featureVersion): the latest integrity-valid predictionAsOf ≤ firstPitch
 *      (tiebroken by predictionSnapshotId). Every other revision is rejected as
 *      `superseded_by_authoritative_revision`, so multiple pregame revisions of the
 *      same batter-game can NEVER become duplicate training observations.
 *
 * Authority is established HERE, at training-read time — the write side always
 * persists `authoritative:false` (it cannot know which revision is last before
 * first pitch). The stored `authoritative` flag is not trusted.
 */
export function evaluateTrainingReadIntegrity(
  predictions: readonly PredictionSnapshot[],
  sourceRows: ReadonlyMap<string, SourceEvidenceSnapshot>,
): TrainingReadOutcome {
  const rejected: { predictionSnapshotId: string; reasons: string[] }[] = [];
  const valid: PredictionSnapshot[] = [];

  for (const p of predictions) {
    const r = evaluatePredictionRowIntegrity(p, sourceRows);
    if (r.readable) valid.push(p);
    else rejected.push({ predictionSnapshotId: p.predictionSnapshotId, reasons: r.reasons });
  }

  const groups = new Map<string, PredictionSnapshot[]>();
  for (const p of valid) {
    const key = `${p.gamePk}|${p.batterId}|${p.featureVersion}`;
    const g = groups.get(key);
    if (g) g.push(p); else groups.set(key, [p]);
  }

  const admitted: PredictionSnapshot[] = [];
  for (const group of Array.from(groups.values())) {
    let best = group[0];
    for (let i = 1; i < group.length; i++) {
      const p = group[i];
      const a = ms(p.predictionAsOf) ?? -Infinity;
      const b = ms(best.predictionAsOf) ?? -Infinity;
      if (a > b || (a === b && p.predictionSnapshotId > best.predictionSnapshotId)) best = p;
    }
    admitted.push(best);
    for (const p of group) {
      if (p !== best) rejected.push({ predictionSnapshotId: p.predictionSnapshotId, reasons: ["superseded_by_authoritative_revision"] });
    }
  }

  return { admitted, rejected };
}
