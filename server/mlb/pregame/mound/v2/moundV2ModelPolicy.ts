// Mound Radar V2 (shadow) — versioned MODEL policy (Mound V2 purity pass;
// replaces the former moundV2DecisionPolicy.ts, which combined this with
// sportsbook executability in one struct — an ambiguity flagged as
// unacceptable even though the actual computation never read price).
//
// This module answers EXACTLY ONE question: "given the model's OWN
// probabilities plus baseball-evidence context (data quality, lineup
// status), should V2's MODEL recommend a side, or explicitly ABSTAIN?" —
// the qualify/abstain distinction production Mound (V1) already makes via
// everPubliclyFlagged/everPubliclyFlaggedFade, but for V2's own genuine
// probability output.
//
// STRUCTURAL PURITY GUARANTEE: neither MoundV2ModelPolicy nor
// MoundV2ModelPolicyInput contains a price, an implied probability, a
// sportsbook identity, an odds timestamp, or any price-derived quantity —
// not optionally, not nullably. There is no field here a future edit could
// accidentally wire a price into without TypeScript itself flagging it as
// an unknown property. Whether a recommendation is actually EXECUTABLE at a
// real, fresh, provenanced price is a completely separate question,
// answered downstream by moundV2Executability.ts from this policy's OWN
// `side` output — never the reverse. See moundV2ModelPolicy.test.ts for the
// behavioral price-invariance proof (varying price/sportsbook/odds-age
// inputs, which this module cannot even accept, provably cannot change its
// output) and moundV2Executability.test.ts for the executability side.
//
// Every policy is named + versioned (policyVersion) and persisted alongside
// each decision so a later analysis can always answer "which exact rule
// produced this side/abstention" — never silently re-derived after the
// fact, and never retroactively changed for an already-evaluated snapshot.

export type MoundV2Market = "pitcher_strikeouts" | "pitcher_outs";
export type MoundV2Side = "OVER" | "UNDER";

export const MOUND_V2_MODEL_POLICY_VERSION = "mound_v2_model_policy_v1";

export interface MoundV2ModelPolicy {
  policyVersion: string;
  market: MoundV2Market;
  /** The qualifying side's own model probability must be >= this. */
  minimumProbability: number;
  /**
   * The qualifying side's OWN model probability must exceed the OTHER
   * side's OWN model probability (both from the SAME distribution — see
   * moundV2Engine.ts's computeMoundV2Distribution) by at least this margin.
   * A pure measure of how DECISIVE the model's own distribution is between
   * the two outcomes it modeled — e.g. 0.60 vs 0.55 is barely more
   * confident than a coin flip between the two, even though 0.60 alone
   * clears a probability floor. This is NEVER a comparison against a
   * sportsbook-implied probability (no implied/de-vigged probability, no
   * price, is available to this module at all — see the file header's
   * structural purity guarantee). Omit for no margin requirement
   * (probability floor alone).
   */
  minimumProbabilityMargin?: number;
  allowedDataQuality: string[];
  allowedLineupStatuses: string[];
}

export const MOUND_V2_DEFAULT_MODEL_POLICIES: Record<MoundV2Market, MoundV2ModelPolicy> = {
  pitcher_strikeouts: {
    policyVersion: MOUND_V2_MODEL_POLICY_VERSION,
    market: "pitcher_strikeouts",
    minimumProbability: 0.55,
    minimumProbabilityMargin: 0.03,
    allowedDataQuality: ["complete", "partial"],
    allowedLineupStatuses: ["confirmed", "projected"],
  },
  pitcher_outs: {
    policyVersion: MOUND_V2_MODEL_POLICY_VERSION,
    market: "pitcher_outs",
    minimumProbability: 0.55,
    minimumProbabilityMargin: 0.03,
    allowedDataQuality: ["complete", "partial"],
    allowedLineupStatuses: ["confirmed", "projected"],
  },
};

export type MoundV2ModelQualificationReason =
  | "qualified"
  | "data_quality_not_allowed"
  | "lineup_status_not_allowed"
  | "below_minimum_probability"
  | "below_minimum_margin";

export interface MoundV2ModelPolicyResult {
  policyVersion: string;
  market: MoundV2Market;
  /** null means an explicit, reasoned MODEL abstention — never a fallback/default side, and never influenced by whether a price happens to be available (this module cannot see price at all). */
  side: MoundV2Side | null;
  modelQualified: boolean;
  qualificationReason: MoundV2ModelQualificationReason;
  qualifyingProbability: number | null;
}

/**
 * Deliberately excludes price, sportsbook, odds age/timestamp, and
 * provenance — not optionally, structurally. A caller cannot "just pass
 * price anyway"; the type has no field for it.
 */
export interface MoundV2ModelPolicyInput {
  overProbability: number;
  underProbability: number;
  pushProbability: number;
  dataQuality: string;
  lineupStatus: string;
}

/**
 * The single function every model-policy call site funnels through. Never
 * throws — an unexpected input (e.g. NaN probabilities) is handled by the
 * caller validating first; this function's own logic is total over its
 * declared input shape. Every return path names a real reason; there is no
 * "just pick the higher probability" fallback anywhere in this function.
 */
export function applyMoundV2ModelPolicy(
  policy: MoundV2ModelPolicy,
  input: MoundV2ModelPolicyInput,
): MoundV2ModelPolicyResult {
  const abstain = (reason: MoundV2ModelQualificationReason): MoundV2ModelPolicyResult => ({
    policyVersion: policy.policyVersion,
    market: policy.market,
    side: null,
    modelQualified: false,
    qualificationReason: reason,
    qualifyingProbability: null,
  });

  if (!policy.allowedDataQuality.includes(input.dataQuality)) {
    return abstain("data_quality_not_allowed");
  }
  if (!policy.allowedLineupStatuses.includes(input.lineupStatus)) {
    return abstain("lineup_status_not_allowed");
  }

  const marginOk = (side: MoundV2Side): boolean => {
    if (policy.minimumProbabilityMargin == null) return true;
    const margin = side === "OVER"
      ? input.overProbability - input.underProbability
      : input.underProbability - input.overProbability;
    return margin >= policy.minimumProbabilityMargin;
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

  if (!marginOk(candidateSide)) {
    return abstain("below_minimum_margin");
  }

  return {
    policyVersion: policy.policyVersion,
    market: policy.market,
    side: candidateSide,
    modelQualified: true,
    qualificationReason: "qualified",
    qualifyingProbability: candidateSide === "OVER" ? input.overProbability : input.underProbability,
  };
}
