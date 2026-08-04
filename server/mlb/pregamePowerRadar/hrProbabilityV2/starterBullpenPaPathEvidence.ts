// Plate HR V2 — content-addressed `starter_bullpen` evidence descriptor (PR6.2).
// Split out of starterBullpenPaPath.ts so the pure derivation + payload type +
// re-derivation can be imported by the training reader (plateHrV2Snapshots.ts)
// without an import cycle; this file is the one place that reaches the snapshot
// module for the canonical hasher + descriptor type. Mirrors recentContactFormEvidence.ts.

import { canonicalHash, type PlateHrV2EvidenceDescriptor } from "./plateHrV2Snapshots";
import {
  deriveStarterBullpenPaPath,
  hasUsableExposure,
  canonicalizeStarterBullpenSources,
  type StarterBullpenPaPathSources,
  type StarterBullpenPaPathProjection,
  type StarterBullpenPaPathEvidencePayload,
} from "./starterBullpenPaPath";

export interface BuildStarterBullpenPaPathEvidenceArgs {
  batterId: string;
  sources: StarterBullpenPaPathSources | null | undefined;
  /** When the sources were fetched (fetched_at ⇒ availableAt === fetchedAt). */
  retrievalAtMs: number;
  /** MUST equal the prediction's featureVersion (bound at read time). */
  schemaVersion: string;
}

/**
 * Compute the projection AND build the content-addressed `starter_bullpen` evidence
 * descriptor it is EXACTLY reproducible from. Returns `evidence: null` (fail-closed)
 * when the retrieval time is non-finite OR the projection carries no usable exposure
 * (nothing worth content-addressing — the PA-path stays unavailable → missing_pa_path).
 * Pure.
 */
export function buildStarterBullpenPaPathEvidence(
  args: BuildStarterBullpenPaPathEvidenceArgs,
): { projection: StarterBullpenPaPathProjection; evidence: PlateHrV2EvidenceDescriptor | null } {
  const projection = deriveStarterBullpenPaPath(args.sources);
  if (!Number.isFinite(args.retrievalAtMs)) return { projection, evidence: null };
  // Only content-address a projection that actually carries exposure — a null-split
  // projection has no evidence to bind and must degrade to missing_pa_path.
  if (!hasUsableExposure(projection)) return { projection, evidence: null };

  const payload: StarterBullpenPaPathEvidencePayload = {
    sources: canonicalizeStarterBullpenSources(args.sources),
    projection,
  };
  const retrievalIso = new Date(args.retrievalAtMs).toISOString();

  const evidence: PlateHrV2EvidenceDescriptor = {
    provider: "mlb_stats_live",
    entityType: "batter",
    entityId: args.batterId,
    evidenceKind: "starter_bullpen",
    fetchedAt: retrievalIso,
    availableAt: retrievalIso,
    availabilitySource: "fetched_at",
    provenanceIncomplete: false,
    // As-of pregame projection: the sources are known as of the fetch moment.
    dataThroughAt: retrievalIso,
    validForAt: null,
    schemaVersion: args.schemaVersion,
    contentHash: canonicalHash(payload),
    payloadRef: null,
    authorizedPayload: payload as unknown as Record<string, unknown>,
  };
  return { projection, evidence };
}
