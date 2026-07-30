// Mound Radar V2 (shadow) — sportsbook EXECUTABILITY (Mound V2 purity
// pass). The counterpart to moundV2ModelPolicy.ts: that module decides
// WHETHER and on WHICH SIDE the model recommends, using baseball evidence
// only. This module answers a completely separate, downstream question:
// "is there a real, fresh, provenanced sportsbook price to actually EXECUTE
// that already-decided side?"
//
// Strict one-way data flow: this module reads the model's OWN `side`
// output and price/provenance data, and produces ONLY `executable` +
// price/book/timestamp/failureReason. It has no mechanism to write back
// into the model decision — there is no field on MoundV2ExecutabilityResult
// that a caller could feed into moundV2ModelPolicy.ts, and
// applyMoundV2Executability never recomputes or overrides `side`. Missing
// or stale odds can only ever set `executable: false`; they can never
// change the model's projection, distribution, probability, selected side,
// setup grade, confidence, or modelQualified — see
// moundV2Executability.test.ts's behavioral proof.

export type MoundV2ExecutabilityFailureReason =
  | "not_applicable"
  | "missing_price"
  | "missing_provenance"
  | "odds_too_stale";

export const MOUND_V2_EXECUTABILITY_POLICY_VERSION = "mound_v2_executability_policy_v1";

export interface MoundV2ExecutabilityPolicy {
  policyVersion: string;
  /** A price older than this (relative to the evaluation moment) is treated as stale — not executable, since it may no longer reflect a real, tradeable market. */
  maximumOddsAgeMs: number;
}

export const MOUND_V2_DEFAULT_EXECUTABILITY_POLICY: MoundV2ExecutabilityPolicy = {
  policyVersion: MOUND_V2_EXECUTABILITY_POLICY_VERSION,
  maximumOddsAgeMs: 6 * 60 * 60 * 1000,
};

export interface MoundV2ExecutabilityResult {
  policyVersion: string;
  executable: boolean;
  sportsbook: string | null;
  price: number | null;
  fetchedAt: string | null;
  /** null only when executable is true. "not_applicable" means the model itself abstained (side is null) — executability was never a live question for this snapshot. */
  failureReason: MoundV2ExecutabilityFailureReason | null;
}

export interface MoundV2ExecutabilityInput {
  /** The MODEL's own already-decided side — read-only input from moundV2ModelPolicy.ts's result. null when the model abstained. */
  side: "OVER" | "UNDER" | null;
  overPrice: number | null;
  underPrice: number | null;
  sportsbook: string | null;
  oddsFetchedAt: string | null;
  now: Date;
}

/**
 * Never throws. Every return path names a real, distinct reason — no
 * "assume executable" fallback anywhere in this function.
 */
export function applyMoundV2Executability(
  policy: MoundV2ExecutabilityPolicy,
  input: MoundV2ExecutabilityInput,
): MoundV2ExecutabilityResult {
  const notExecutable = (
    reason: MoundV2ExecutabilityFailureReason,
    fields: Partial<Pick<MoundV2ExecutabilityResult, "sportsbook" | "price" | "fetchedAt">> = {},
  ): MoundV2ExecutabilityResult => ({
    policyVersion: policy.policyVersion,
    executable: false,
    sportsbook: fields.sportsbook ?? null,
    price: fields.price ?? null,
    fetchedAt: fields.fetchedAt ?? null,
    failureReason: reason,
  });

  if (input.side == null) {
    return notExecutable("not_applicable");
  }

  const price = input.side === "OVER" ? input.overPrice : input.underPrice;
  if (price == null) {
    return notExecutable("missing_price", { sportsbook: input.sportsbook, fetchedAt: input.oddsFetchedAt });
  }
  if (input.sportsbook == null || input.oddsFetchedAt == null) {
    return notExecutable("missing_provenance", { sportsbook: input.sportsbook, price, fetchedAt: input.oddsFetchedAt });
  }

  const ageMs = input.now.getTime() - new Date(input.oddsFetchedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > policy.maximumOddsAgeMs) {
    return notExecutable("odds_too_stale", { sportsbook: input.sportsbook, price, fetchedAt: input.oddsFetchedAt });
  }

  return {
    policyVersion: policy.policyVersion,
    executable: true,
    sportsbook: input.sportsbook,
    price,
    fetchedAt: input.oddsFetchedAt,
    failureReason: null,
  };
}
