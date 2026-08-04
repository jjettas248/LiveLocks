// Plate HR V2 — content-addressed contact_events evidence for the recent-contact
// form leaf (§8.3, PR5.1 / PR5.2). Split out of recentContactForm.ts so the pure
// leaf + re-derivation can be imported by the training reader (plateHrV2Snapshots.ts)
// without an import cycle; this file is the one place that reaches the snapshot
// module for the canonical hasher + descriptor type.

import { canonicalHash, type PlateHrV2EvidenceDescriptor } from "./plateHrV2Snapshots";
import {
  computeRecentContactForm,
  normalizeWindowMax,
  selectContactWindow,
  tsMs,
  type ComputeRecentContactFormArgs,
  type RecentContactFormInputs,
  type RecentContactFormSeasonBaseline,
  type RecentContactFormEvidencePayload,
} from "./recentContactForm";

const finiteOrNull = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Canonicalize the baseline for a deterministic, exactly-re-derivable payload. */
function canonicalBaseline(b: RecentContactFormSeasonBaseline | null | undefined): Required<RecentContactFormSeasonBaseline> {
  return {
    avgEv: finiteOrNull(b?.avgEv),
    ev90: finiteOrNull(b?.ev90),
    airBallPct: finiteOrNull(b?.airBallPct),
    barrelPct: finiteOrNull(b?.barrelPct),
  };
}

export interface BuildRecentContactFormEvidenceArgs extends ComputeRecentContactFormArgs {
  batterId: string;
  /** When the events were fetched (fetched_at ⇒ availableAt === fetchedAt). */
  retrievalAtMs: number;
  /** MUST equal the prediction's featureVersion (bound at read time). */
  schemaVersion: string;
}

/**
 * Compute the leaf AND build the content-addressed `contact_events` evidence
 * descriptor it is EXACTLY reproducible from. Returns `evidence: null` when the
 * boundary/retrieval is non-finite or no in-window events exist (nothing to
 * content-address → the leaf is neutral). Pure.
 */
export function buildRecentContactFormEvidence(
  args: BuildRecentContactFormEvidenceArgs,
): { inputs: RecentContactFormInputs; evidence: PlateHrV2EvidenceDescriptor | null } {
  const inputs = computeRecentContactForm(args);
  const boundary = args.asOfExclusiveMs;
  if (boundary == null || !Number.isFinite(boundary)) return { inputs, evidence: null };
  if (!Number.isFinite(args.retrievalAtMs)) return { inputs, evidence: null };

  const windowMax = normalizeWindowMax(args.windowMax);
  const windowed = selectContactWindow(args.events, boundary, windowMax);
  if (windowed.length === 0) return { inputs, evidence: null };

  const payload: RecentContactFormEvidencePayload = {
    events: windowed.map(({ event, ms }) => ({
      exitVelocity: finiteOrNull(event.exitVelocity),
      launchAngle: finiteOrNull(event.launchAngle),
      isBarrel: typeof event.isBarrel === "boolean" ? event.isBarrel : null,
      timestamp: new Date(ms).toISOString(),
    })),
    seasonBaseline: canonicalBaseline(args.seasonBaseline),
    asOfExclusiveMs: boundary,
    windowMax,
  };
  const maxMs = Math.max(...windowed.map(({ ms }) => ms));
  const retrievalIso = new Date(args.retrievalAtMs).toISOString();

  const evidence: PlateHrV2EvidenceDescriptor = {
    provider: "mlb_stats_live",
    entityType: "batter",
    entityId: args.batterId,
    evidenceKind: "contact_events",
    fetchedAt: retrievalIso,
    availableAt: retrievalIso,
    availabilitySource: "fetched_at",
    provenanceIncomplete: false,
    dataThroughAt: new Date(maxMs).toISOString(),
    validForAt: null,
    schemaVersion: args.schemaVersion,
    contentHash: canonicalHash(payload),
    payloadRef: null,
    authorizedPayload: payload,
  };
  return { inputs, evidence };
}

export { tsMs };
