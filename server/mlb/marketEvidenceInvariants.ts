// ── MLB Live Edge — Market-Specific Hard Evidence Invariants ────────────────
// Replaces signalScore-led official qualification with a set of typed,
// market-specific HARD invariants. Each is a conjunctive requirement: an
// official candidate must satisfy EVERY invariant for its market. A weighted
// score (signalScore/opportunityScore/liveScore) is NOT an input here and can
// never compensate for a failed invariant — missing/stale live state, an
// unsupported distribution, a prohibited fallback/cap, an incomplete
// remaining-opportunity projection, or invalid odds each hard-fail the gate.
//
// Pure, no I/O. Deterministic. `signalScore` deliberately does not appear.

import type { MLBMarket } from "./types";
import type { DistributionModelMethod } from "./types";

// A real outcome-distribution method — the calculator produced a PMF / count
// distribution, not an ad-hoc rate fallback. Kept in sync with the distribution
// methods the market calculators emit (server/mlb/markets.ts).
const SUPPORTED_DISTRIBUTION_METHODS: ReadonlySet<DistributionModelMethod> = new Set([
  "hit_distribution",
  "tb_distribution",
  "pitcher_k_distribution",
  "hr_distribution",
  "negative_binomial",
  "binomial",
] as unknown as DistributionModelMethod[]);

export type MarketEvidenceInvariantId =
  | "live_state_known"
  | "live_state_complete"
  | "live_state_fresh"
  | "distribution_supported"
  | "no_prohibited_fallback"
  | "no_prohibited_cap"
  | "remaining_opportunity_present"
  | "remaining_opportunity_sufficient"
  | "two_sided_fresh_odds";

export interface MarketEvidenceInput {
  market: MLBMarket;
  side: "OVER" | "UNDER";
  // Typed live-state provenance (from liveGameStateContract): the current stat
  // was read from a real box-score/pitching-box-score row, is complete, and is
  // within the freshness window.
  currentStatKnown: boolean;
  liveStateComplete: boolean;
  liveStateFresh: boolean;
  // The calculator emitted a real outcome distribution, not an ad-hoc rate.
  modelMethod: DistributionModelMethod | null | undefined;
  // A prohibited fallback path (baseline_only / fallback_static) or a
  // probability cap/ceiling was applied — either disqualifies an official
  // candidate.
  fallbackUsed: boolean;
  capApplied: boolean;
  // Remaining opportunity (PA for batter markets, BF for pitcher markets) and
  // the count of additional outcomes the OVER needs. Null when the projection
  // could not be completed.
  remainingOpportunity: number | null;
  neededOutcomes: number | null;
  // A fresh two-sided (over+under) price from one approved book at one line.
  hasFreshTwoSidedOdds: boolean;
}

export interface MarketEvidenceResult {
  passed: boolean;
  failedInvariants: MarketEvidenceInvariantId[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Evaluates the market's hard evidence invariants. Every invariant fails
 * CLOSED: an absent/unknown input is a failure, never a pass. Returns the full
 * list of failed invariants (not just the first) so diagnostics can show every
 * missing piece of evidence at once.
 */
export function evaluateMarketEvidenceInvariants(input: MarketEvidenceInput): MarketEvidenceResult {
  const failed: MarketEvidenceInvariantId[] = [];

  if (input.currentStatKnown !== true) failed.push("live_state_known");
  if (input.liveStateComplete !== true) failed.push("live_state_complete");
  if (input.liveStateFresh !== true) failed.push("live_state_fresh");

  if (!input.modelMethod || !SUPPORTED_DISTRIBUTION_METHODS.has(input.modelMethod)) {
    failed.push("distribution_supported");
  }

  if (input.fallbackUsed === true) failed.push("no_prohibited_fallback");
  if (input.capApplied === true) failed.push("no_prohibited_cap");

  if (!isFiniteNumber(input.remainingOpportunity) || input.remainingOpportunity <= 0) {
    failed.push("remaining_opportunity_present");
  } else if (
    // For an OVER, there must be at least as many remaining opportunities as
    // outcomes still needed to clear the line. When neededOutcomes is unknown
    // we cannot assert sufficiency → fail closed. (UNDER has no minimum-needed
    // requirement, but still requires a completed projection, checked above.)
    input.side === "OVER" &&
    (!isFiniteNumber(input.neededOutcomes) || input.remainingOpportunity < input.neededOutcomes)
  ) {
    failed.push("remaining_opportunity_sufficient");
  }

  if (input.hasFreshTwoSidedOdds !== true) failed.push("two_sided_fresh_odds");

  return { passed: failed.length === 0, failedInvariants: failed };
}
