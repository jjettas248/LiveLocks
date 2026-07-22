// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — canonical feature hash (PR 2).
//
// `feature_hash` (shared/schema.ts hr_radar_evaluation_snapshots) must be
// independent of the literal property-insertion order used inside
// hrFeatureBuilder.ts — canonicalJsonStringify recursively sorts object keys
// (array element order is preserved, since array order is meaningful — e.g.
// the ordered non-HR BBE sequence). Pure, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import type { HrDerivedFeatureVectorV1 } from "./hrFeatureContract";

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function computeHrFeatureHash(derivedFeatures: HrDerivedFeatureVectorV1): string {
  return crypto.createHash("sha256").update(canonicalJsonStringify(derivedFeatures)).digest("hex");
}
