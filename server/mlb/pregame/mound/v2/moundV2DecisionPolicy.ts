// Mound Radar V2 (shadow) — versioned decision policy (Final Pre-Push
// Integrity Pass). Pure: no I/O, no storage import.
//
// A probability model and a betting/recommendation policy are different
// components. computeMoundV2Distribution (moundV2Engine.ts) answers "what
// is P(over)/P(under)/P(push)" — a pure statistical question. This module
// answers the SEPARATE question "given those probabilities plus the real
// market context (price, provenance, data quality), should V2 actually
// RECOMMEND a side, or explicitly ABSTAIN" — exactly the qualify/abstain
// distinction production Mound (V1) already makes via
// everPubliclyFlagged/everPubliclyFlaggedFade (see moundOutcomeAttribution.ts's
// resolveMoundSettlementDirection) — V2 needs its own equivalent, not "V2's
// implied side" (whichever of over/under happens to have higher probability,
// forced on every single snapshot regardless of how thin or stale the edge
// is).
//
// Every policy is named + versioned (policyVersion) and persisted alongside
// each decision so a later analysis can always answer "which exact rule
// produced this side/abstention" — never silently re-derived after the
// fact, and never retroactively changed for an already-evaluated snapshot
// (the caller must persist the input policyVersion, not recompute it later
// against a possibly-different current default).
//
// Sportsbook price is used ONLY here, downstream of the probability model —
// never as an input to computeMoundV2Distribution itself (CLAUDE.md's
// "Engine probability is never mutated by signal-composition layers"
// principle, applied to V2: the qualification/abstention layer may read
// price, but must never feed it back into the probability computation).

export type MoundV2Market = "pitcher_strikeouts" | "pitcher_outs";
export type MoundV2Side = "OVER" | "UNDER";

export const MOUND_V2_DECISION_POLICY_VERSION = "mound_v2_decision_policy_v1";

export interface MoundV2DecisionPolicy {
  policyVersion: string;
  market: MoundV2Market;
  /** The qualifying side's own probability must be >= this. */
  minimumProbability: number;
  /** The qualifying side's probability must exceed the OTHER side's by at least this margin. Omit for no advantage requirement (probability threshold alone). */
  minimumModelAdvantage?: number;
  allowedDataQuality: string[];
  allowedLineupStatuses: string[];
  /** A price older than this (relative to the evaluation moment) is treated as stale — abstain rather than grade against a price that may no longer be executable. */
  maximumOddsAgeMs: number;
  /** Always true in this contract — a policy that would silently recommend a side with no real price to grade against is not a policy this module implements. */
  abstainOnMissingPrice: true;
  /** Always true — a price with no sportsbook/fetch-time attached cannot be honestly graded later (see the provenance-pairing fix below) or trusted as genuinely executable. */
  abstainOnMissingProvenance: true;
}

export const MOUND_V2_DEFAULT_DECISION_POLICIES: Record<MoundV2Market, MoundV2DecisionPolicy> = {
  pitcher_strikeouts: {
    policyVersion: MOUND_V2_DECISION_POLICY_VERSION,
    market: "pitcher_strikeouts",
    minimumProbability: 0.55,
    minimumModelAdvantage: 0.03,
    allowedDataQuality: ["complete", "partial"],
    allowedLineupStatuses: ["confirmed", "projected"],
    maximumOddsAgeMs: 6 * 60 * 60 * 1000,
    abstainOnMissingPrice: true,
    abstainOnMissingProvenance: true,
  },
  pitcher_outs: {
    policyVersion: MOUND_V2_DECISION_POLICY_VERSION,
    market: "pitcher_outs",
    minimumProbability: 0.55,
    minimumModelAdvantage: 0.03,
    allowedDataQuality: ["complete", "partial"],
    allowedLineupStatuses: ["confirmed", "projected"],
    maximumOddsAgeMs: 6 * 60 * 60 * 1000,
    abstainOnMissingPrice: true,
    abstainOnMissingProvenance: true,
  },
};

export type MoundV2QualificationReason =
  | "qualified"
  | "data_quality_not_allowed"
  | "lineup_status_not_allowed"
  | "below_minimum_probability"
  | "below_minimum_advantage"
  | "missing_price"
  | "missing_provenance"
  | "odds_too_stale";

export interface MoundV2DecisionPolicyResult {
  policyVersion: string;
  market: MoundV2Market;
  /** null means an explicit, reasoned abstention — never a fallback/default side. */
  side: MoundV2Side | null;
  qualified: boolean;
  reason: MoundV2QualificationReason;
  qualifyingProbability: number | null;
}

export interface MoundV2DecisionPolicyInput {
  overProbability: number;
  underProbability: number;
  pushProbability: number;
  dataQuality: string;
  lineupStatus: string;
  overPrice: number | null;
  underPrice: number | null;
  /** Paired-market design (see oddsDisplay.ts's pairedUnderOddsForBook fix) — ONE sportsbook, shared by both sides, never independently re-shopped. */
  sportsbook: string | null;
  oddsFetchedAt: string | null;
  now: Date;
}

/**
 * The single function every decision-policy call site funnels through.
 * Never throws — an unexpected input (e.g. NaN probabilities) is handled by
 * the caller validating first; this function's own logic is total over its
 * declared input shape. Every return path names a real reason; there is no
 * "just pick the higher probability" fallback anywhere in this function.
 */
export function applyMoundV2DecisionPolicy(
  policy: MoundV2DecisionPolicy,
  input: MoundV2DecisionPolicyInput,
): MoundV2DecisionPolicyResult {
  const abstain = (reason: MoundV2QualificationReason): MoundV2DecisionPolicyResult => ({
    policyVersion: policy.policyVersion,
    market: policy.market,
    side: null,
    qualified: false,
    reason,
    qualifyingProbability: null,
  });

  if (!policy.allowedDataQuality.includes(input.dataQuality)) {
    return abstain("data_quality_not_allowed");
  }
  if (!policy.allowedLineupStatuses.includes(input.lineupStatus)) {
    return abstain("lineup_status_not_allowed");
  }

  const advantageOk = (side: MoundV2Side): boolean => {
    if (policy.minimumModelAdvantage == null) return true;
    const margin = side === "OVER"
      ? input.overProbability - input.underProbability
      : input.underProbability - input.overProbability;
    return margin >= policy.minimumModelAdvantage;
  };

  const overQualifiesOnProbability = input.overProbability >= policy.minimumProbability;
  const underQualifiesOnProbability = input.underProbability >= policy.minimumProbability;

  if (!overQualifiesOnProbability && !underQualifiesOnProbability) {
    return abstain("below_minimum_probability");
  }

  // In a well-formed 3-outcome distribution (over+under+push == 1), over and
  // under cannot BOTH clear the same minimumProbability threshold unless it
  // is <= 0.5 minus half the push mass — defensively pick the strictly
  // higher one if that degenerate case is ever reached, never both/neither.
  const candidateSide: MoundV2Side =
    overQualifiesOnProbability && underQualifiesOnProbability
      ? (input.overProbability >= input.underProbability ? "OVER" : "UNDER")
      : overQualifiesOnProbability ? "OVER" : "UNDER";

  if (!advantageOk(candidateSide)) {
    return abstain("below_minimum_advantage");
  }

  const price = candidateSide === "OVER" ? input.overPrice : input.underPrice;
  if (policy.abstainOnMissingPrice && price == null) {
    return abstain("missing_price");
  }
  if (policy.abstainOnMissingProvenance && (input.sportsbook == null || input.oddsFetchedAt == null)) {
    return abstain("missing_provenance");
  }
  if (input.oddsFetchedAt != null) {
    const ageMs = input.now.getTime() - new Date(input.oddsFetchedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > policy.maximumOddsAgeMs) {
      return abstain("odds_too_stale");
    }
  }

  return {
    policyVersion: policy.policyVersion,
    market: policy.market,
    side: candidateSide,
    qualified: true,
    reason: "qualified",
    qualifyingProbability: candidateSide === "OVER" ? input.overProbability : input.underProbability,
  };
}
