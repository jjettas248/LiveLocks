// Plate HR V2 — two-layer append-only snapshot contract + point-in-time
// eligibility + training-read integrity (plan §7.1, PR1 / PR4.2 / PR4.3 / PR4.3.1).
//
// PURE: no DB / network I/O. It DOES use node:crypto for deterministic content
// hashing — pure computation (same input → same digest), the single canonical
// hasher shared by the write builder and the training reader.
//
// Two layers (persisted in shared/schema.ts, created by
// server/dbMigrations/plateHrV2SnapshotPersistence.ts):
//   • SourceEvidenceSnapshot   — one immutable provider-fetch of an entity's
//     evidence. Identical canonical descriptors (content AND provenance) are
//     idempotent (one row); any change mints a distinct immutable row.
//   • PredictionSnapshot        — one (batter-game, moment); references source
//     snapshots by id. A late change is a NEW prediction snapshot, never a mutate.
//
// PR4.3.1 hardening: `reconstructed` is derived from `fetchedAt` (not availableAt)
// and re-verified at read; the write payload + the strict reader both validate a
// TYPED, semantically-non-empty authorized payload; and the training gateway
// runtime-parses untrusted persisted DTOs (JSONB columns may hold anything) so a
// malformed row produces a deterministic rejection, never a throw.

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
  // PR4.3: the source's real availability could NOT be established → null
  // timestamps + provenanceIncomplete=true, always training-INELIGIBLE.
  "unverified",
] as const;
export type AvailabilitySource = (typeof AVAILABILITY_SOURCES)[number];

// ── Strict canonical serialization + hashing ──────────────────────────────────
// Rejects (throws) any value the JSON serializer could silently collapse —
// undefined, NaN, Infinity, functions, symbols, bigint, non-plain objects
// (Date/Map/Set/class instances), AND sparse-array holes — so a content hash is a
// genuine integrity check, not a lossy fingerprint.

export class PlateHrV2NonCanonicalValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlateHrV2NonCanonicalValueError";
  }
}

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
    if (Array.isArray(v)) {
      // Reject sparse arrays: a hole silently collapses to empty on join.
      for (let i = 0; i < v.length; i++) {
        if (!(i in v)) throw new PlateHrV2NonCanonicalValueError(`sparse array hole at index ${i}`);
      }
      return `[${v.map(writeCanonical).join(",")}]`;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const name = (proto as { constructor?: { name?: string } })?.constructor?.name ?? "unknown";
      throw new PlateHrV2NonCanonicalValueError(`non-plain object is not canonical JSON: ${name}`);
    }
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    // writeCanonical(obj[k]) throws on an explicit `undefined` value, so
    // `{a: undefined}` can never silently collapse to `{}`.
    return `{${keys.map((k) => `${JSON.stringify(k)}:${writeCanonical(obj[k])}`).join(",")}}`;
  }
  throw new PlateHrV2NonCanonicalValueError(`unsupported value type: ${t}`);
}

export function canonicalHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex").slice(0, 40);
}

/** Normalize a timestamp (ISO string OR Date OR null) to a canonical ISO string,
 * so the write side (ISO strings) and the training reader (DB Date objects)
 * content-address identically. Invalid/absent → null. */
export function normalizeTimestamp(x: string | Date | null | undefined): string | null {
  if (x == null) return null;
  const d = x instanceof Date ? x : new Date(x);
  const msVal = d.getTime();
  return Number.isFinite(msVal) ? d.toISOString() : null;
}

// ── Authorized sufficient-stat payload: closed allowlists + typed validation ──
// (Shared by the write projection and the strict read validator — PR4.3.1 #2.)

export const AUTHORIZED_SUFFICIENT_STAT_SCALAR_KEYS: ReadonlySet<string> = new Set([
  "pitchesSeen", "swings", "whiffs", "calledStrikes", "balls",
  "paCount", "strikeouts", "walks", "battedBallEvents",
  "pulledBip", "sprayClassifiedBip", "sourceRowCount",
]);
export const AUTHORIZED_PITCH_FAMILY_STAT_KEYS: ReadonlySet<string> = new Set([
  "pitches", "swings", "whiffs", "xslgSum", "xslgN",
]);
export const AUTHORIZED_PITCH_TYPE_EXACT_STAT_KEYS: ReadonlySet<string> = new Set([
  "pitchCount", "swingCount", "whiffCount", "contactCount", "bbeCount",
  "qualityBbeCount", "paEndedCount", "barrelCount", "hrCount",
  "xslgContactSum", "xslgContactN", "xwobaContactSum", "xwobaContactN",
]);
export const AUTHORIZED_PERCENTILE_KEYS: ReadonlySet<string> = new Set([
  "p10", "p25", "p50", "p75", "p90",
]);
/** All authorized top-level keys (scalars + nested groups). */
export const AUTHORIZED_SUFFICIENT_STAT_KEYS: ReadonlySet<string> = new Set<string>([
  ...Array.from(AUTHORIZED_SUFFICIENT_STAT_SCALAR_KEYS),
  "pitchFamilyStats", "pitchTypeExactStats", "evPercentiles", "laPercentiles",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Project a `Record<key, statObject>` — each entry filtered to a closed numeric
 * allowlist; ENTRIES that end up empty are dropped (PR4.3.1). */
function projectRecordOfStats(v: unknown, allowed: ReadonlySet<string>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (!isPlainObject(v)) return out;
  for (const [k, entry] of Object.entries(v)) {
    if (!isPlainObject(entry)) continue;
    const projected: Record<string, number> = {};
    for (const [ek, ev] of Object.entries(entry)) {
      if (allowed.has(ek) && typeof ev === "number" && Number.isFinite(ev)) projected[ek] = ev;
    }
    if (Object.keys(projected).length > 0) out[k] = projected;
  }
  return out;
}

/** Project a single stat object — allowlisted keys, allowing null (percentiles). */
function projectFlatStat(v: unknown, allowed: ReadonlySet<string>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!isPlainObject(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (!allowed.has(k)) continue;
    if (val === null) out[k] = null;
    else if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
  }
  return out;
}

/** Project a sufficient-stats payload through the CLOSED top-level allowlist AND
 * closed nested projections, dropping empty nested groups. Scalars kept only when
 * a finite number (so `{pitchesSeen:{arbitrary:1}}` cannot ride along). The result
 * is a fresh deep structure — no live reference survives. */
export function authorizedSufficientStatsPayload(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!AUTHORIZED_SUFFICIENT_STAT_KEYS.has(k)) continue;
    if (k === "pitchFamilyStats") {
      const p = projectRecordOfStats(v, AUTHORIZED_PITCH_FAMILY_STAT_KEYS);
      if (Object.keys(p).length > 0) out[k] = p;
    } else if (k === "pitchTypeExactStats") {
      const p = projectRecordOfStats(v, AUTHORIZED_PITCH_TYPE_EXACT_STAT_KEYS);
      if (Object.keys(p).length > 0) out[k] = p;
    } else if (k === "evPercentiles" || k === "laPercentiles") {
      const p = projectFlatStat(v, AUTHORIZED_PERCENTILE_KEYS);
      if (Object.keys(p).length > 0) out[k] = p;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out;
}

export interface PayloadValidation { ok: boolean; reasons: string[]; numericLeafCount: number; }

/** Validate a historical sufficient-stats payload against the typed, closed
 * schema; require ≥1 authorized numeric leaf (PR4.3.1 #2). Rejects unauthorized
 * keys, wrong scalar types, non-numeric leaves, and semantically-empty payloads
 * (`{}`, `{pitchFamilyStats:{}}`, `{pitchFamilyStats:{fastball:{}}}`). */
export function validateAuthorizedPayload(payload: unknown): PayloadValidation {
  const reasons: string[] = [];
  let leaves = 0;
  if (!isPlainObject(payload)) return { ok: false, reasons: ["payload_not_object"], numericLeafCount: 0 };
  for (const [k, v] of Object.entries(payload)) {
    if (!AUTHORIZED_SUFFICIENT_STAT_KEYS.has(k)) { reasons.push(`unauthorized_key:${k}`); continue; }
    if (k === "pitchFamilyStats" || k === "pitchTypeExactStats") {
      const allowed = k === "pitchFamilyStats" ? AUTHORIZED_PITCH_FAMILY_STAT_KEYS : AUTHORIZED_PITCH_TYPE_EXACT_STAT_KEYS;
      if (!isPlainObject(v)) { reasons.push(`bad_nested:${k}`); continue; }
      for (const [ek, entry] of Object.entries(v)) {
        if (!isPlainObject(entry)) { reasons.push(`bad_nested_entry:${k}.${ek}`); continue; }
        let entryLeaves = 0;
        for (const [lk, lv] of Object.entries(entry)) {
          if (!allowed.has(lk)) { reasons.push(`unauthorized_leaf:${k}.${ek}.${lk}`); continue; }
          if (typeof lv !== "number" || !Number.isFinite(lv)) { reasons.push(`non_numeric_leaf:${k}.${ek}.${lk}`); continue; }
          entryLeaves++; leaves++;
        }
        if (entryLeaves === 0) reasons.push(`empty_nested_entry:${k}.${ek}`);
      }
    } else if (k === "evPercentiles" || k === "laPercentiles") {
      if (!isPlainObject(v)) { reasons.push(`bad_nested:${k}`); continue; }
      let present = 0;
      for (const [lk, lv] of Object.entries(v)) {
        if (!AUTHORIZED_PERCENTILE_KEYS.has(lk)) { reasons.push(`unauthorized_leaf:${k}.${lk}`); continue; }
        if (lv === null) { present++; continue; }
        if (typeof lv !== "number" || !Number.isFinite(lv)) { reasons.push(`non_numeric_leaf:${k}.${lk}`); continue; }
        present++; leaves++;
      }
      if (present === 0) reasons.push(`empty_nested_entry:${k}`);
    } else if (typeof v !== "number" || !Number.isFinite(v)) {
      reasons.push(`non_numeric_scalar:${k}`);
    } else {
      leaves++;
    }
  }
  if (reasons.length === 0 && leaves < 1) reasons.push("payload_semantically_empty");
  return { ok: reasons.length === 0 && leaves >= 1, reasons, numericLeafCount: leaves };
}

function hasGenuineLeaf(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === "number") return Number.isFinite(v as number);
  if (t === "string" || t === "boolean") return true;
  if (t === "object") {
    if (Array.isArray(v)) return v.some(hasGenuineLeaf);
    if (isPlainObject(v)) return Object.values(v).some(hasGenuineLeaf);
  }
  return false;
}

/** Validate a non-historical source payload (weather/park/lineup): a genuine,
 * canonically-serializable, semantically-non-empty plain object. */
function validateGenericPayload(payload: unknown): { ok: boolean; reasons: string[] } {
  if (!isPlainObject(payload)) return { ok: false, reasons: ["payload_not_object"] };
  if (Object.keys(payload).length === 0) return { ok: false, reasons: ["payload_empty"] };
  try { canonicalJson(payload); } catch { return { ok: false, reasons: ["payload_noncanonical"] }; }
  if (!hasGenuineLeaf(payload)) return { ok: false, reasons: ["payload_semantically_empty"] };
  return { ok: true, reasons: [] };
}

/** Evidence-kind-aware payload validation used at BOTH write and strict read. */
export function validateSourcePayload(kind: EvidenceKind, payload: unknown): { ok: boolean; reasons: string[] } {
  if (kind === "historical_stat") {
    const r = validateAuthorizedPayload(payload);
    return { ok: r.ok, reasons: r.reasons };
  }
  return validateGenericPayload(payload);
}

// ── Zod contracts ─────────────────────────────────────────────────────────────

// ISO 8601 timestamp string (matches the DB `timestamp` serialization).
const isoTimestamp = z.string().min(1);

export const sourceEvidenceSnapshotSchema = z.object({
  sourceSnapshotId: z.string().min(1),
  provider: z.string().min(1),
  entityId: z.string().min(1),
  entityType: z.enum(["batter", "pitcher", "game", "venue"]),
  evidenceKind: z.enum(EVIDENCE_KINDS),
  dataThroughAt: isoTimestamp.nullable(),
  availableAt: isoTimestamp.nullable(),
  availabilitySource: z.enum(AVAILABILITY_SOURCES),
  validForAt: isoTimestamp.nullable(),
  reconstructed: z.boolean(),
  provenanceIncomplete: z.boolean(),
  fetchedAt: isoTimestamp.nullable(),
  schemaVersion: z.string().min(1),
  contentHash: z.string().min(1),
  payloadRef: z.string().nullable(),
  authorizedPayload: z.unknown(),
});
export type SourceEvidenceSnapshot = z.infer<typeof sourceEvidenceSnapshotSchema>;

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
  contentHash: z.string().min(1),
  payloadRef: z.string().nullable(),
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
  trainingEligible: z.boolean(),
  authoritative: z.boolean(),
  trainingBlockReasons: z.array(z.string()),
});
export type PredictionSnapshot = z.infer<typeof predictionSnapshotSchema>;

// STORED DTO schemas (PR4.3.1 #3) — tolerant of DB Date objects and used to
// runtime-parse UNTRUSTED persisted rows in the training reader before any array
// or field is touched, so a malformed JSONB value becomes a rejection, not a throw.
const storedTimestamp = z.union([z.string(), z.date()]).nullable();
export const storedSourceEvidenceSchema = z.object({
  sourceSnapshotId: z.string(),
  provider: z.string(),
  entityId: z.string(),
  entityType: z.enum(["batter", "pitcher", "game", "venue"]),
  evidenceKind: z.enum(EVIDENCE_KINDS),
  dataThroughAt: storedTimestamp,
  availableAt: storedTimestamp,
  availabilitySource: z.string(),
  validForAt: storedTimestamp,
  reconstructed: z.boolean(),
  provenanceIncomplete: z.boolean(),
  fetchedAt: storedTimestamp,
  schemaVersion: z.string(),
  contentHash: z.string(),
  payloadRef: z.string().nullable().optional(),
  authorizedPayload: z.unknown(),
});
export type StoredSourceEvidence = z.infer<typeof storedSourceEvidenceSchema>;

export const storedPredictionSnapshotSchema = z.object({
  predictionSnapshotId: z.string(),
  gamePk: z.string(),
  batterId: z.string(),
  featureVersion: z.string(),
  predictionAsOf: z.union([z.string(), z.date()]),
  firstPitchTime: storedTimestamp,
  sourceSnapshotIds: z.array(z.string()),
  derivedFeatures: z.record(z.string(), z.unknown()),
  contentHash: z.string(),
  trainingEligible: z.boolean().nullable(),
  authoritative: z.boolean(),
  trainingBlockReasons: z.array(z.string()),
});
export type StoredPredictionSnapshot = z.infer<typeof storedPredictionSnapshotSchema>;

/** The full canonical descriptor that content-addresses a source-evidence row —
 * ALL eligibility-critical provenance participates, so provenance can never
 * change without changing identity. The id is a canonical OBJECT hash. */
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

export function computePredictionSnapshotId(f: {
  gamePk: string;
  batterId: string;
  featureVersion: string;
  predictionAsOf: string | Date;
}): string {
  return `plate-hr-v2-pred:${f.gamePk}:${f.batterId}:${f.featureVersion}:${normalizeTimestamp(f.predictionAsOf)}`;
}

/** The COMPLETE immutable prediction envelope covered by contentHash — every
 * immutable field plus the authorized feature vector and sorted source ids.
 * Mutable lifecycle state is excluded and verified separately. */
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

/** Append-only composite identity (matches the DB unique index). */
export function predictionSnapshotCompositeKey(p: {
  gamePk: string;
  batterId: string;
  featureVersion: string;
  predictionAsOf: string;
}): string {
  return `${p.gamePk}|${p.batterId}|${p.featureVersion}|${p.predictionAsOf}`;
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
 * Evidence-kind-specific point-in-time eligibility for ONE source row.
 *   historical_stat  : dataThroughAt < predictionAsOf ≤ firstPitch
 *   lineup | probable: availableAt ≤ predictionAsOf ≤ firstPitch
 *   weather_forecast : availableAt(issuedAt) ≤ predictionAsOf ; validForAt MAY be future
 *   park             : availableAt ≤ predictionAsOf
 *   reconstructed    : eligible ONLY with verified reproducible as-of retrieval
 */
export function isSourceEvidenceEligible(
  ev: {
    evidenceKind: EvidenceKind;
    dataThroughAt: string | Date | null;
    availableAt: string | Date | null;
    validForAt: string | Date | null;
    reconstructed: boolean;
    provenanceIncomplete?: boolean;
  },
  predictionAsOf: string | Date,
  firstPitch: string | Date | null,
  opts: { verifiedAsOfRetrieval?: boolean } = {},
): EligibilityResult {
  if (ev.provenanceIncomplete) return { eligible: false, reason: "provenance_incomplete" };

  const pAsOf = ms(predictionAsOf);
  const avail = ms(ev.availableAt);
  const fp = ms(firstPitch);
  if (pAsOf == null) return { eligible: false, reason: "unparseable_prediction_as_of" };
  if (avail == null) return { eligible: false, reason: "missing_available_at" };

  if (ev.reconstructed && !opts.verifiedAsOfRetrieval) {
    return { eligible: false, reason: "reconstructed_without_verified_as_of" };
  }
  if (avail > pAsOf) return { eligible: false, reason: "available_after_prediction" };

  const predictionBeforeFirstPitch = fp == null || pAsOf <= fp;

  switch (ev.evidenceKind) {
    case "historical_stat": {
      const dta = ms(ev.dataThroughAt);
      if (dta == null) return { eligible: false, reason: "missing_data_through_at" };
      if (!(dta < pAsOf)) return { eligible: false, reason: "data_not_strictly_before_prediction" };
      if (!predictionBeforeFirstPitch) return { eligible: false, reason: "prediction_after_first_pitch" };
      return { eligible: true, reason: "ok" };
    }
    case "lineup":
    case "probable": {
      if (!predictionBeforeFirstPitch) return { eligible: false, reason: "prediction_after_first_pitch" };
      return { eligible: true, reason: "ok" };
    }
    case "weather_forecast":
    case "park": {
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

export type ResolvedEligibilitySource = Pick<
  SourceEvidenceSnapshot,
  "evidenceKind" | "dataThroughAt" | "availableAt" | "validForAt" | "reconstructed"
> & { authorizedPayload?: unknown; contentHash?: string; provenanceIncomplete?: boolean };

export type ResolvedSourceMap = ReadonlyMap<string, ResolvedEligibilitySource>;

/**
 * WRITE-SIDE eligibility helper — computes the `trainingEligible` decision +
 * `trainingBlockReasons` persisted with a new prediction. The AUTHORITY at
 * training time is `evaluateTrainingReadIntegrity`, which recomputes everything.
 */
export function isPredictionSnapshotEligible(
  prediction: Pick<PredictionSnapshot, "predictionAsOf" | "firstPitchTime" | "sourceSnapshotIds">,
  resolvedSources: ResolvedSourceMap,
  opts: {
    verifiedAsOfRetrieval?: boolean;
    requireKnownFirstPitch?: boolean;
    hashPayload?: (payload: unknown) => string;
  } = {},
): PredictionEligibilityResult {
  const reasons: string[] = [];
  const pAsOf = ms(prediction.predictionAsOf);
  const fp = ms(prediction.firstPitchTime);
  if (pAsOf == null) return { eligible: false, reasons: ["unparseable_prediction_as_of"] };
  if (opts.requireKnownFirstPitch && fp == null) reasons.push("unknown_first_pitch");
  if (fp != null && pAsOf > fp) reasons.push("prediction_after_first_pitch");

  if (prediction.sourceSnapshotIds.length === 0) reasons.push("no_source_evidence");
  for (const id of prediction.sourceSnapshotIds) {
    const src = resolvedSources.get(id);
    if (!src) { reasons.push(`missing_source_evidence:${id}`); continue; }
    const r = isSourceEvidenceEligible(src, prediction.predictionAsOf, prediction.firstPitchTime, opts);
    if (!r.eligible) reasons.push(`source_ineligible:${id}:${r.reason}`);
    if (opts.hashPayload) {
      if (src.authorizedPayload == null) reasons.push(`source_payload_missing:${id}`);
      else if (src.contentHash == null || opts.hashPayload(src.authorizedPayload) !== src.contentHash) reasons.push(`source_payload_hash_mismatch:${id}`);
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

// ── Strict training-read integrity + authoritative selection ──────────────────

export interface TrainingReadResult {
  readable: boolean;
  reasons: string[];
  prediction: StoredPredictionSnapshot | null;
}

/** True `reconstructed` value from real fetch provenance (PR4.3.1 #1). */
function expectedReconstructed(fetchedAt: string | Date | null, predictionAsOf: string | Date): boolean {
  const f = ms(fetchedAt);
  const p = ms(predictionAsOf);
  return f != null && p != null && f > p;
}

/** Provenance/timestamp/availabilitySource/reconstructed consistency (PR4.3.1 #1). */
function checkProvenanceConsistency(src: StoredSourceEvidence, predictionAsOf: string | Date): string[] {
  const reasons: string[] = [];
  if (src.provenanceIncomplete) {
    if (src.fetchedAt != null || src.availableAt != null) reasons.push("provenance_incomplete_has_timestamps");
    if (src.availabilitySource !== "unverified") reasons.push("provenance_incomplete_source_not_unverified");
    if (src.reconstructed) reasons.push("provenance_incomplete_reconstructed");
  } else {
    if (src.fetchedAt == null) reasons.push("provenance_missing_fetched_at");
    if (src.availableAt == null) reasons.push("provenance_missing_available_at");
    if (src.availabilitySource === "unverified") reasons.push("provenance_complete_but_unverified_source");
    if (src.reconstructed !== expectedReconstructed(src.fetchedAt, predictionAsOf)) reasons.push("reconstructed_flag_inconsistent");
  }
  return reasons;
}

/**
 * Per-row integrity verification. UNCONDITIONAL and NEVER-THROWING: it accepts an
 * untrusted persisted DTO (`unknown`) and runtime-parses it before touching any
 * field, so a malformed JSONB value yields a rejection reason, not a crash. It
 * recomputes every id/hash from the row's own stored fields, requires
 * `mapKey === stored sourceSnapshotId === recomputed sourceSnapshotId`, derives
 * `reconstructed` from `fetchedAt`, validates a typed non-empty payload, and never
 * trusts a cached decision.
 */
export function evaluatePredictionRowIntegrity(
  rawPrediction: unknown,
  sourceRows: ReadonlyMap<string, unknown>,
): TrainingReadResult {
  const parsed = storedPredictionSnapshotSchema.safeParse(rawPrediction);
  if (!parsed.success) {
    const fallbackId = isPlainObject(rawPrediction) && typeof rawPrediction.predictionSnapshotId === "string"
      ? rawPrediction.predictionSnapshotId : "unknown";
    return { readable: false, reasons: [`prediction_shape_invalid:${fallbackId}`], prediction: null };
  }
  const prediction = parsed.data;
  const reasons: string[] = [];

  if (prediction.trainingEligible !== true) reasons.push("stored_not_training_eligible");
  if (prediction.trainingBlockReasons.length > 0) reasons.push(`persisted_block_reasons:${prediction.trainingBlockReasons.join(",")}`);

  const recomputedPredId = computePredictionSnapshotId(prediction);
  if (recomputedPredId !== prediction.predictionSnapshotId) reasons.push("prediction_id_mismatch");

  const pAsOf = ms(prediction.predictionAsOf);
  const fp = ms(prediction.firstPitchTime);
  if (pAsOf == null) reasons.push("unparseable_prediction_as_of");
  if (fp == null) reasons.push("unknown_first_pitch");
  else if (pAsOf != null && pAsOf > fp) reasons.push("prediction_after_first_pitch");

  const ids = prediction.sourceSnapshotIds;
  if (ids.length === 0) reasons.push("no_source_evidence");
  if (new Set(ids).size !== ids.length) reasons.push("duplicate_source_ids");
  const sorted = [...ids].sort();
  if (ids.some((v, i) => v !== sorted[i])) reasons.push("source_ids_not_sorted");

  for (const id of ids) {
    const raw = sourceRows.get(id);
    if (raw === undefined) { reasons.push(`missing_source_evidence:${id}`); continue; }
    const sp = storedSourceEvidenceSchema.safeParse(raw);
    if (!sp.success) { reasons.push(`source_shape_invalid:${id}`); continue; }
    const src = sp.data;

    // Triple identity: map key === stored id === recomputed id.
    if (src.sourceSnapshotId !== id) reasons.push(`source_stored_id_mismatch:${id}`);
    let recomputedId: string;
    try {
      recomputedId = computeSourceSnapshotId(src);
    } catch { reasons.push(`source_noncanonical:${id}`); continue; }
    if (recomputedId !== id) reasons.push(`source_id_mismatch:${id}`);

    // Provenance/reconstructed consistency (fetchedAt-derived).
    for (const r of checkProvenanceConsistency(src, prediction.predictionAsOf)) reasons.push(`source_provenance:${id}:${r}`);

    // Point-in-time rules (recomputed, strict).
    const e = isSourceEvidenceEligible(src, prediction.predictionAsOf, prediction.firstPitchTime, {});
    if (!e.eligible) reasons.push(`source_ineligible:${id}:${e.reason}`);

    // Typed, semantically-non-empty payload + payload↔hash agreement.
    const pv = validateSourcePayload(src.evidenceKind, src.authorizedPayload);
    if (!pv.ok) reasons.push(`source_payload_invalid:${id}:${pv.reasons.join("|")}`);
    if (src.authorizedPayload == null) {
      reasons.push(`source_payload_missing:${id}`);
    } else {
      let h: string;
      try { h = canonicalHash(src.authorizedPayload); }
      catch { reasons.push(`source_payload_noncanonical:${id}`); continue; }
      if (h !== src.contentHash) reasons.push(`source_payload_hash_mismatch:${id}`);
    }
  }

  let envHash: string | null = null;
  try { envHash = computePredictionEnvelopeHash(prediction); }
  catch { reasons.push("prediction_features_noncanonical"); }
  if (envHash != null && envHash !== prediction.contentHash) reasons.push("prediction_hash_mismatch");

  return { readable: reasons.length === 0, reasons, prediction };
}

export interface TrainingReadOutcome {
  /** Exactly one authoritative, integrity-valid revision per (gamePk, batterId,
   * featureVersion) — safe to use as training observations. */
  admitted: StoredPredictionSnapshot[];
  /** Every row that did NOT enter training, with the reasons why. */
  rejected: { predictionSnapshotId: string; reasons: string[] }[];
}

/**
 * THE single training-data admission gateway. Never throws. Given untrusted
 * persisted rows + a source-row resolver, it runs unconditional per-row integrity
 * then deterministically selects ONE authoritative revision per (gamePk, batterId,
 * featureVersion): the latest integrity-valid `predictionAsOf` (≤ firstPitch is
 * enforced in integrity), tiebroken by `predictionSnapshotId`. Every other
 * revision is rejected as `superseded_by_authoritative_revision`.
 */
export function evaluateTrainingReadIntegrity(
  predictions: readonly unknown[],
  sourceRows: ReadonlyMap<string, unknown>,
): TrainingReadOutcome {
  const rejected: { predictionSnapshotId: string; reasons: string[] }[] = [];
  const valid: StoredPredictionSnapshot[] = [];

  if (!Array.isArray(predictions)) return { admitted: [], rejected: [] };

  for (const raw of predictions) {
    const r = evaluatePredictionRowIntegrity(raw, sourceRows);
    if (r.readable && r.prediction) valid.push(r.prediction);
    else {
      const id = r.prediction?.predictionSnapshotId
        ?? (isPlainObject(raw) && typeof raw.predictionSnapshotId === "string" ? raw.predictionSnapshotId : "unknown");
      rejected.push({ predictionSnapshotId: id, reasons: r.reasons });
    }
  }

  const groups = new Map<string, StoredPredictionSnapshot[]>();
  for (const p of valid) {
    const key = `${p.gamePk}|${p.batterId}|${p.featureVersion}`;
    const g = groups.get(key);
    if (g) g.push(p); else groups.set(key, [p]);
  }

  const admitted: StoredPredictionSnapshot[] = [];
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
