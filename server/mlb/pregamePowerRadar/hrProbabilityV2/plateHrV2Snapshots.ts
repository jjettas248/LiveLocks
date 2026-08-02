// Plate HR V2 — two-layer append-only snapshot contract + point-in-time
// eligibility (plan §7.1, PR1). PURE: no I/O, no DB, no engine imports.
//
// Two layers (persisted in shared/schema.ts, created by
// server/dbMigrations/plateHrV2SnapshotPersistence.ts):
//   • SourceEvidenceSnapshot   — one provider fetch of an entity's evidence.
//   • PredictionSnapshot        — one (batter-game, moment); references source
//     snapshots by id. A late change is a NEW prediction snapshot, never a mutate.
//
// The eligibility rules are EVIDENCE-KIND-SPECIFIC so a valid pregame weather
// forecast (issued before the prediction, valid for a future game time) is not
// wrongly rejected by the historical-stat `dataThroughAt` guard, and observed
// post-game weather / a stat whose cutoff is at-or-after the prediction can never
// leak into training. Nothing writes these tables yet (forward capture is PR3).

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
] as const;
export type AvailabilitySource = (typeof AVAILABILITY_SOURCES)[number];

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
  availableAt: isoTimestamp,
  availabilitySource: z.enum(AVAILABILITY_SOURCES),
  // Weather forecast game time — legitimately in the future.
  validForAt: isoTimestamp.nullable(),
  reconstructed: z.boolean(),
  fetchedAt: isoTimestamp,
  schemaVersion: z.string().min(1),
  contentHash: z.string().min(1),
  payloadRef: z.string().nullable(),
});
export type SourceEvidenceSnapshot = z.infer<typeof sourceEvidenceSnapshotSchema>;

// An explicit, real provider/entity evidence descriptor assembled at the fetch
// site (PR3.1). One descriptor == one real source payload (a Savant CSV for an
// entity, an Open-Meteo forecast for a game, a confirmed lineup, park geometry).
// Every field is real — nothing is synthesized. The builder maps a descriptor to
// a SourceEvidenceSnapshot verbatim; it never invents provenance.
export const plateHrV2EvidenceDescriptorSchema = z.object({
  provider: z.string().min(1),
  entityType: z.enum(["batter", "pitcher", "game", "venue"]),
  entityId: z.string().min(1),
  evidenceKind: z.enum(EVIDENCE_KINDS),
  fetchedAt: isoTimestamp,
  availableAt: isoTimestamp,
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

function ms(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const t = Date.parse(iso);
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
  >,
  predictionAsOf: string,
  firstPitch: string | null,
  opts: { verifiedAsOfRetrieval?: boolean } = {},
): EligibilityResult {
  const pAsOf = ms(predictionAsOf);
  const avail = ms(ev.availableAt);
  const fp = ms(firstPitch);
  if (pAsOf == null) return { eligible: false, reason: "unparseable_prediction_as_of" };
  if (avail == null) return { eligible: false, reason: "unparseable_available_at" };

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

/**
 * A PredictionSnapshot is training/label-eligible only if:
 *   1. its predictionAsOf is ≤ first pitch (when known),
 *   2. every referenced source-evidence id resolves (as-of completeness — a
 *      missing source is never silently ignored), and
 *   3. every resolved source is itself eligible (per evidenceKind).
 */
export function isPredictionSnapshotEligible(
  prediction: Pick<PredictionSnapshot, "predictionAsOf" | "firstPitchTime" | "sourceSnapshotIds">,
  resolvedSources: ReadonlyMap<
    string,
    Pick<SourceEvidenceSnapshot, "evidenceKind" | "dataThroughAt" | "availableAt" | "validForAt" | "reconstructed">
  >,
  opts: { verifiedAsOfRetrieval?: boolean; requireKnownFirstPitch?: boolean } = {},
): PredictionEligibilityResult {
  const reasons: string[] = [];
  const pAsOf = ms(prediction.predictionAsOf);
  const fp = ms(prediction.firstPitchTime);
  if (pAsOf == null) return { eligible: false, reasons: ["unparseable_prediction_as_of"] };
  // Rev. 4.1: training eligibility requires a KNOWN first-pitch boundary so the
  // predictionAsOf ≤ firstPitch invariant is verifiable, not assumed.
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
  }

  return { eligible: reasons.length === 0, reasons };
}
