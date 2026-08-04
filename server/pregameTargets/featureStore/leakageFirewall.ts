// PR1 — Leakage firewall (temporal data foundation).
//
// A projection may only consume a feature reading that was genuinely knowable at
// the decision instant. This module is the pure gate that every reading must
// clear before it can enter a projection input set. It encodes the temporal
// safety assertions the program's build spec (§9A.11) requires, as a set of
// deterministic, side-effect-free predicates.
//
// The firewall NEVER "fixes" a reading — it accepts or rejects. A rejected
// reading is dropped from the input set (and surfaces as `missing`), never
// silently coerced. All comparisons are absolute-instant (epoch ms) comparisons.

import { normalizeGameKey } from "../../../shared/pregameTargets/canonicalEntities";
import {
  type AsOfFeatureRow,
  instantMs,
  isStructurallyValidFeatureRow,
} from "../../../shared/pregameTargets/featureStore";

export const LEAKAGE_VIOLATIONS = [
  "malformed_instants", // validAt/knownAt do not parse to finite instants
  "structural_invalid", // state↔value pairing or required fields are broken
  "knownAt_before_validAt", // observed before it became true — impossible
  "future_knownAt", // knownAt > predictionAt — not knowable at decision time
  "same_game_self_update", // provenance includes the game being predicted
  "outcome_in_input", // a declared-outcome feature key used as an input
] as const;
export type LeakageViolation = (typeof LEAKAGE_VIOLATIONS)[number];

export interface LeakageContext {
  /** The decision instant. A reading is usable only if knownAt <= this. */
  predictionAt: string;
  /** Canonical id of the game being predicted (enables self-update detection). */
  targetGameId?: string;
  /**
   * Feature keys that represent OUTCOMES (the thing being predicted). Such a key
   * must never appear as an input for the same decision, regardless of instants.
   */
  outcomeFeatureKeys?: ReadonlySet<string>;
}

export type LeakageResult =
  | { ok: true }
  | { ok: false; violations: LeakageViolation[] };

/**
 * Pure predicate: may this reading enter the input set for a decision at
 * `predictionAt`? Returns ALL violations (not just the first) so callers can log
 * a complete diagnosis. Deterministic; no I/O; never throws on well-typed input.
 */
export function checkFeatureLeakage(
  row: AsOfFeatureRow,
  ctx: LeakageContext,
): LeakageResult {
  const violations: LeakageViolation[] = [];

  const validMs = instantMs(row.validAt);
  const knownMs = instantMs(row.knownAt);
  const predMs = instantMs(ctx.predictionAt);

  const instantsOk =
    Number.isFinite(validMs) && Number.isFinite(knownMs) && Number.isFinite(predMs);
  if (!instantsOk) violations.push("malformed_instants");

  if (!isStructurallyValidFeatureRow(row)) violations.push("structural_invalid");

  // Instant-ordering checks only run when all instants parsed (else meaningless).
  if (instantsOk) {
    if (knownMs < validMs) violations.push("knownAt_before_validAt");
    if (knownMs > predMs) violations.push("future_knownAt");
  }

  // Guard with Array.isArray: the same-game check runs independently of the
  // structural check above, so it must never throw (or apply string-substring
  // semantics) on a malformed, non-array `derivedFromGameIds`. Normalize BOTH
  // the context target id and each provenance entry before the membership test:
  // an incidental format variant (e.g. `"nba:game:TARGET "`) on either side must
  // never let a self-update slip through the exact match, mirroring
  // `updatePosterior`'s normalized key comparison.
  if (ctx.targetGameId != null && Array.isArray(row.derivedFromGameIds)) {
    const target = normalizeGameKey(ctx.targetGameId);
    // Guard `typeof g === "string"` before normalizing: this check runs
    // independently of the structural check, so a non-string element (e.g. a
    // jsonb `[123]`) must be skipped, not passed to `normalizeGameKey` — whose
    // `id.trim()` fallback would throw on a non-string and abort the input build
    // instead of the row being cleanly rejected as `structural_invalid`.
    if (row.derivedFromGameIds.some((g) => typeof g === "string" && normalizeGameKey(g) === target)) {
      violations.push("same_game_self_update");
    }
  }

  if (ctx.outcomeFeatureKeys?.has(row.featureKey)) {
    violations.push("outcome_in_input");
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** Convenience: true iff the reading clears the firewall. */
export function isLeakageSafe(row: AsOfFeatureRow, ctx: LeakageContext): boolean {
  return checkFeatureLeakage(row, ctx).ok === true;
}

/**
 * Partition a batch of readings into the leakage-safe input set and a rejected
 * set (with reasons). This is the intended entry point for building a projection
 * input: the engine sees only `safe`, and `rejected` feeds observability. A
 * dropped reading is a genuine absence — the caller must treat a feature with no
 * safe reading as `missing`, never substitute a rejected one.
 */
export function partitionByLeakage(
  rows: readonly AsOfFeatureRow[],
  ctx: LeakageContext,
): {
  safe: AsOfFeatureRow[];
  rejected: Array<{ row: AsOfFeatureRow; violations: LeakageViolation[] }>;
} {
  const safe: AsOfFeatureRow[] = [];
  const rejected: Array<{ row: AsOfFeatureRow; violations: LeakageViolation[] }> = [];
  for (const row of rows) {
    const res = checkFeatureLeakage(row, ctx);
    if (res.ok) safe.push(row);
    else rejected.push({ row, violations: res.violations });
  }
  return { safe, rejected };
}
