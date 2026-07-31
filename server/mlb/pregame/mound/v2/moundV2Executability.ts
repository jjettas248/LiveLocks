// Mound Radar V2 (shadow) — sportsbook EXECUTABILITY (Mound V2 purity
// pass; Final Line-Provenance and V1 Purity Correction). The counterpart to
// moundV2ModelPolicy.ts: that module decides WHETHER and on WHICH SIDE the
// model recommends, using baseball evidence only. This module answers a
// completely separate, downstream question: "is there a real, fresh,
// provenanced sportsbook price to actually EXECUTE that already-decided
// side, at the exact line the model evaluated?"
//
// Strict one-way data flow: this module reads the model's OWN `side` output
// (and the line the model's own PMF was actually conditioned on) plus raw
// price/provenance data, and produces ONLY an atomic executable offer +
// failureReason. It has no mechanism to write back into the model decision
// — there is no field on MoundV2ExecutabilityResult that a caller could feed
// into moundV2ModelPolicy.ts, and applyMoundV2Executability never
// recomputes or overrides `side`. Missing or stale odds can only ever set
// `executable: false`; they can never change the model's projection,
// distribution, probability, selected side, setup grade, confidence, or
// modelQualified — see moundV2Executability.test.ts's behavioral proof.
//
// ATOMICITY (Correction): a prior version of this contract reported
// sportsbook/price/fetchedAt as separate flat fields with NO `line` field at
// all — a caller (persistence, grading, ROI) had to reach across to a
// DIFFERENT part of the row (the frozen market quote's own `line`) to know
// which line that price belonged to. Even though today's canonical-line
// design happens to make those always equal, the TYPE didn't prove it, which
// is exactly the kind of separately-selected-fields-could-drift-apart risk
// this pass is closing. `offer` below bundles market/side/sportsbook/line/
// price/fetchedAt into ONE object, stamped together in a single return
// statement from a single source — there is no code path that assembles an
// offer from two different variables, so line/price/sportsbook/timestamp can
// never independently mismatch. `offer` is non-null if and only if
// `executable` is true; there is no partial/half-populated offer.

import type { MoundV2Market } from "./moundV2ModelPolicy";

export type MoundV2ExecutabilityFailureReason =
  | "not_applicable"
  | "missing_line"
  | "missing_price"
  | "missing_provenance"
  | "odds_too_stale";

export const MOUND_V2_EXECUTABILITY_POLICY_VERSION = "mound_v2_executability_policy_v2";

export interface MoundV2ExecutabilityPolicy {
  policyVersion: string;
  /** A price older than this (relative to the evaluation moment) is treated as stale — not executable, since it may no longer reflect a real, tradeable market. */
  maximumOddsAgeMs: number;
}

export const MOUND_V2_DEFAULT_EXECUTABILITY_POLICY: MoundV2ExecutabilityPolicy = {
  policyVersion: MOUND_V2_EXECUTABILITY_POLICY_VERSION,
  maximumOddsAgeMs: 6 * 60 * 60 * 1000,
};

/**
 * The atomic executable offer. market/side/sportsbook/line/price/fetchedAt
 * are always stamped together from ONE source in a single return statement
 * — never independently selected or reassembled from separate fields, so
 * they can never mismatch. This is the ONLY shape persistence, grading, and
 * ROI calculation may read an executed offer from — never reconstruct one by
 * combining fields from different parts of a row.
 */
export interface MoundV2ExecutableOffer {
  market: MoundV2Market;
  side: "OVER" | "UNDER";
  sportsbook: string;
  line: number;
  price: number;
  fetchedAt: string;
}

export interface MoundV2ExecutabilityResult {
  policyVersion: string;
  executable: boolean;
  /** Non-null if and only if executable is true — never a partially-populated offer. */
  offer: MoundV2ExecutableOffer | null;
  /** null only when executable is true. "not_applicable" means the model itself abstained (side is null) — executability was never a live question for this snapshot. */
  failureReason: MoundV2ExecutabilityFailureReason | null;
}

export interface MoundV2ExecutabilityInput {
  market: MoundV2Market;
  /** The MODEL's own already-decided side — read-only input from moundV2ModelPolicy.ts's result. null when the model abstained. */
  side: "OVER" | "UNDER" | null;
  /** The line the model's own PMF was actually conditioned on (the canonical, price-independent line selection) — the SAME line an executable offer must belong to. A missing line means no real market was ever posted at all. */
  line: number | null;
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
  const notExecutable = (reason: MoundV2ExecutabilityFailureReason): MoundV2ExecutabilityResult => ({
    policyVersion: policy.policyVersion,
    executable: false,
    offer: null,
    failureReason: reason,
  });

  if (input.side == null) {
    return notExecutable("not_applicable");
  }
  if (input.line == null) {
    return notExecutable("missing_line");
  }

  const price = input.side === "OVER" ? input.overPrice : input.underPrice;
  if (price == null) {
    return notExecutable("missing_price");
  }
  if (input.sportsbook == null || input.oddsFetchedAt == null) {
    return notExecutable("missing_provenance");
  }

  const ageMs = input.now.getTime() - new Date(input.oddsFetchedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > policy.maximumOddsAgeMs) {
    return notExecutable("odds_too_stale");
  }

  return {
    policyVersion: policy.policyVersion,
    executable: true,
    offer: {
      market: input.market,
      side: input.side,
      sportsbook: input.sportsbook,
      line: input.line,
      price,
      fetchedAt: input.oddsFetchedAt,
    },
    failureReason: null,
  };
}
