// PR2 — Projection-blind contract fields (contract layer, migration plan C6; §5/§8A).
//
// The projection CORE is blind to price/EV. It emits a calibrated probability and
// a projection-quality margin — `confidenceMarginPp = 100 × (p − 0.5)` — and
// NEVER an edge or expected value against a sportsbook line. Any captured
// American odds are settlement / ROI REPORTING metadata that live on the
// separate line-decision layer; they never enter the projection.
//
// This module makes that boundary a first-class, testable CONTRACT. It contains
// no projection/simulation/calibration math and no persistence — PR3+ produces
// the real values and wires them in. `confidenceMarginPp` is a pure transform of
// the projection's OWN probability (independent of any price), deliberately NOT
// EV: two projections with the same probability have the same margin regardless
// of the line or odds attached downstream.

import type { Sport } from "../canonicalSignal";

/** The side a projection is expressed for. */
export type ProjectionSide = "over" | "under";

/** confidenceMarginPp domain bound: 100 × (p − 0.5) for p ∈ [0,1] ⇒ [-50, +50]. */
export const CONFIDENCE_MARGIN_PP_BOUND = 50;

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return NaN;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/**
 * `confidenceMarginPp = 100 × (p − 0.5)` — a projection-quality margin in
 * percentage points, in [-50, +50]. This is NOT EV / edge: it is a pure
 * transform of the projection's own calibrated probability and is completely
 * independent of any sportsbook line or price. A non-finite probability fails
 * safe to `0` (neutral — no confidence either way), never NaN.
 */
export function confidenceMarginPp(probability: number): number {
  const p = clamp01(probability);
  if (!Number.isFinite(p)) return 0;
  return 100 * (p - 0.5);
}

/**
 * Captured market context for the LINE-DECISION layer — settlement / ROI
 * REPORTING ONLY. These values are never an input to the projection core; they
 * exist so a graded target can compute realized ROI from the price it was
 * actually offered at. Kept structurally separate from `BlindProjection`.
 */
export interface CapturedMarketContext {
  sportsbook: string;
  /** The posted line the decision was taken against. */
  line: number;
  /** American odds captured at decision time (for ROI reporting, not EV). */
  americanOdds: number;
  /** ISO-8601 instant (with offset) the odds were captured. */
  capturedAt: string;
}

/**
 * The BLIND projection contract. Carries the calibrated side probability, the
 * derived `confidenceMarginPp`, an optional projected stat central value, and
 * model/contract versions — and, by construction, NO price / odds / EV / edge /
 * line / sportsbook field. The line-decision layer holds market context
 * separately (`CapturedMarketContext`).
 */
export interface BlindProjection {
  sport: Sport;
  side: ProjectionSide;
  /** Calibrated P(side) in [0,1]. */
  probability: number;
  /** 100 × (probability − 0.5) for the emitted side; NOT EV. */
  confidenceMarginPp: number;
  /** Projected stat central value (blind), or null when not modeled. */
  projection?: number | null;
  /** Semantic version of the projection MODEL that produced this. */
  modelVersion: string;
  /** Semantic version of THIS contract shape. */
  contractVersion: string;
}

/**
 * Price / EV keys that must NEVER appear on a blind projection object. The type
 * already forbids them at compile time; this list backs a RUNTIME guard for
 * untyped data crossing the boundary (a persisted row, a provider payload) so a
 * price/EV leak into the projection core is caught rather than trusted.
 */
export const FORBIDDEN_PROJECTION_KEYS: readonly string[] = [
  "odds",
  "americanOdds",
  "price",
  "ev",
  "expectedValue",
  "edge",
  "edgeGap",
  "bookImplied",
  "impliedProb",
  "line",
  "sportsbook",
  "clv",
];

export type ProjectionBlindnessViolation =
  | "carries_price_or_ev_field" // a forbidden price/EV key is present
  | "probability_not_in_unit_interval" // probability missing / non-finite / outside [0,1]
  | "margin_inconsistent"; // confidenceMarginPp != 100×(probability−0.5)

/**
 * Runtime blindness check for an untyped projection-shaped object. Returns ALL
 * violations (not just the first) so callers can log a complete diagnosis. A
 * blind projection: carries no forbidden price/EV key, has a finite probability
 * in [0,1], and a `confidenceMarginPp` that exactly matches the probability.
 * Deterministic; never throws.
 */
export function checkProjectionBlindness(obj: Record<string, unknown>): ProjectionBlindnessViolation[] {
  const violations: ProjectionBlindnessViolation[] = [];

  if (FORBIDDEN_PROJECTION_KEYS.some((k) => Object.prototype.hasOwnProperty.call(obj, k))) {
    violations.push("carries_price_or_ev_field");
  }

  const p = obj.probability;
  const probOk = typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;
  if (!probOk) violations.push("probability_not_in_unit_interval");

  // Margin must equal the pure transform of the probability (no independent
  // value that could smuggle in an EV/edge under a "margin" label).
  const m = obj.confidenceMarginPp;
  if (probOk) {
    const expected = confidenceMarginPp(p as number);
    if (typeof m !== "number" || !Number.isFinite(m) || Math.abs(m - expected) > 1e-9) {
      violations.push("margin_inconsistent");
    }
  }

  return violations;
}

/** Convenience: true iff the object clears the blindness contract. */
export function isBlindProjection(obj: Record<string, unknown>): boolean {
  return checkProjectionBlindness(obj).length === 0;
}
