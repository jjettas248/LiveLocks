// ── MLB Live Edge — Production Lane Authority ───────────────────────────────
// The single place that decides an MLB signal's LANE (official | watch |
// shadow) and computes its canonical no-vig edge + calibration semantics.
//
// This layers ON TOP of evaluateMlbOfficialEligibility (base current-tick
// eligibility — identity/side/approved-book/odds-provenance/bettable) WITHOUT
// changing it. `lane === "official"` is strictly NARROWER than base-eligible:
// a candidate reaches the official lane only when it is base-eligible AND
// clears every production gate:
//   - market rollout mode is `official` (productionPolicy)
//   - inning band allows official (innings 1-3 never do, by default)
//   - the market's hard evidence invariants all pass (marketEvidenceInvariants)
//   - a fresh two-sided no-vig price exists and model edge ≥ price floor
//   - candidate probability ≥ the probability floor
//   - a pushable (integer) line is only official if a win/push/loss model backs
//     it (until modeled, integer lines fail closed)
//   - an active compatible calibrator produced calibratedProbability, OR the
//     market is `hits` under the provisional-uncalibrated compat switch (stamped
//     raw_provisional, never labeled calibrated/Elite/Strong)
//
// signalScore is NOT an input anywhere here. Pure, no I/O. `nowMs` and
// `gameStatus` are passed in explicitly so the module stays deterministic.

import type { MLBMarket } from "./types";
import type { MlbGameStatus } from "../oddsService";
import {
  getMlbLivePolicy,
  resolveMarketMode,
  resolveMarketOfficialGate,
  resolveMlbLane,
  classifyInningBand,
  HITS_PROVISIONAL_UNCALIBRATED_DEFAULT,
  PROVISIONAL_UNCALIBRATED_TAG,
  type MlbLane,
  type MlbLaneReasonCode,
  type MlbInningBand,
  type MlbLivePolicy,
} from "./productionPolicy";
import {
  noVigTwoWay,
  noVigForSide,
  rawImpliedForSide,
  modelEdgePctPoints,
  MLB_EDGE_VERSION,
  type PairedTwoSidedQuote,
} from "./oddsProbability";
import {
  evaluateMarketEvidenceInvariants,
  type MarketEvidenceInput,
  type MarketEvidenceInvariantId,
} from "./marketEvidenceInvariants";

export const MLB_PRODUCTION_LANE_VERSION = "mlb_production_lane_v1";

export type ProbabilitySemantics = "raw_provisional" | "outcome_calibrated";

export interface MlbProductionLaneInput {
  market: MLBMarket;
  side: "OVER" | "UNDER";
  line: number;
  inning: number;
  gameStatus: MlbGameStatus;
  baseEligible: boolean;
  // Candidate-side probability in 0..100. When a compatible calibrator exists
  // this is the calibrated value; otherwise it is the raw engine probability
  // and `calibratedProbability` stays null.
  candidateProbabilityPct: number;
  // Calibrated candidate probability (0..100) or null when no compatible active
  // calibrator exists. NEVER an identity copy of raw — null means uncalibrated.
  calibratedProbabilityPct: number | null;
  // The paired two-sided quote (same book, same line) for de-vigging.
  quote: PairedTwoSidedQuote;
  // Market-specific hard evidence (marketEvidenceInvariants).
  evidence: MarketEvidenceInput;
}

export type MlbActionabilityReason =
  | MlbLaneReasonCode
  | `evidence:${MarketEvidenceInvariantId}`
  | "base_ineligible"
  | "novig_unavailable"
  | "calibrated"
  | "provisional_uncalibrated";

export interface MlbProductionLaneResult {
  lane: MlbLane;
  actionabilityReasons: MlbActionabilityReason[];
  inningBand: MlbInningBand;
  lineIsInteger: boolean;
  candidateSide: "OVER" | "UNDER";
  candidateProbabilityPct: number;
  calibratedProbabilityPct: number | null;
  probabilitySemantics: ProbabilitySemantics;
  provisionalTag: typeof PROVISIONAL_UNCALIBRATED_TAG | null;
  rawBookImpliedProbability: number | null;
  noVigBookProbability: number | null;
  modelEdgePctPoints: number | null;
  edgeVersion: typeof MLB_EDGE_VERSION;
  version: string;
}

/** Integer (pushable) lines: e.g. 1.0, 6.0. Half-point lines (1.5) can't push. */
export function isIntegerLine(line: number): boolean {
  return Number.isFinite(line) && Number.isInteger(line);
}

export type MlbFinalizedTier = "watch" | "lean" | "strong" | "elite";

/**
 * The finalizer-owned user-facing tier. signalScore is NOT an input — the tier
 * is a pure function of (lane, calibration semantics, candidate probability).
 * HARD CAP: a non-official lane OR a raw_provisional (uncalibrated) official
 * signal can NEVER render Elite or Strong — it is capped at "lean". Only a
 * calibrated (outcome_calibrated) official signal can reach Strong/Elite, via
 * calibrated-probability bands.
 */
export function deriveFinalizedTier(args: {
  lane: MlbLane;
  semantics: ProbabilitySemantics;
  candidateProbabilityPct: number;
}): MlbFinalizedTier {
  const p = Number.isFinite(args.candidateProbabilityPct) ? args.candidateProbabilityPct : 0;
  const capped = args.lane !== "official" || args.semantics !== "outcome_calibrated";
  if (capped) {
    // watch / shadow / provisional-official — never Elite/Strong.
    return p >= 57 ? "lean" : "watch";
  }
  if (p >= 70) return "elite";
  if (p >= 63) return "strong";
  if (p >= 57) return "lean";
  return "watch";
}

/**
 * The canonical ordering for OFFICIAL MLB candidates. signalScore, opportunity
 * score, and HIGH_PROB_BYPASS are NOT inputs. Order:
 *   1. candidate probability (desc)
 *   2. no-vig model edge in pp (desc; null sorts last)
 *   3. evidence freshness — smaller odds observation age first (null last)
 *   4. data quality (full > partial > degraded)
 * Returns <0 if `a` ranks ahead of `b`.
 */
export interface MlbOfficialRankKey {
  candidateProbabilityPct: number;
  modelEdgePctPoints: number | null;
  oddsAgeMs: number | null;
  dataQualityRank: number; // higher is better
}

export function compareMlbOfficialRank(a: MlbOfficialRankKey, b: MlbOfficialRankKey): number {
  const pa = Number.isFinite(a.candidateProbabilityPct) ? a.candidateProbabilityPct : -Infinity;
  const pb = Number.isFinite(b.candidateProbabilityPct) ? b.candidateProbabilityPct : -Infinity;
  if (pa !== pb) return pb - pa;

  const ea = a.modelEdgePctPoints == null ? -Infinity : a.modelEdgePctPoints;
  const eb = b.modelEdgePctPoints == null ? -Infinity : b.modelEdgePctPoints;
  if (ea !== eb) return eb - ea;

  const fa = a.oddsAgeMs == null ? Infinity : a.oddsAgeMs;
  const fb = b.oddsAgeMs == null ? Infinity : b.oddsAgeMs;
  if (fa !== fb) return fa - fb;

  return (b.dataQualityRank ?? 0) - (a.dataQualityRank ?? 0);
}

export function dataQualityRank(q: string | null | undefined): number {
  switch (q) {
    case "full": return 3;
    case "partial": return 2;
    case "degraded": return 1;
    default: return 0;
  }
}

export function evaluateMlbProductionLane(
  input: MlbProductionLaneInput,
  policy: MlbLivePolicy = getMlbLivePolicy(),
): MlbProductionLaneResult {
  const reasons: MlbActionabilityReason[] = [];
  const inningBand = classifyInningBand(input.inning, policy);
  const lineIsInteger = isIntegerLine(input.line);

  // Calibration semantics — null calibrated ⇒ raw_provisional (never Elite/Strong).
  const isCalibrated = input.calibratedProbabilityPct != null;
  const probabilitySemantics: ProbabilitySemantics = isCalibrated ? "outcome_calibrated" : "raw_provisional";

  // No-vig de-vig from the matched pair.
  const noVig = noVigTwoWay(input.quote, input.gameStatus);
  let noVigBookProbability: number | null = null;
  let rawBookImpliedProbability: number | null = null;
  let edge: number | null = null;
  if (noVig.ok) {
    noVigBookProbability = noVigForSide(noVig.result, input.side);
    rawBookImpliedProbability = rawImpliedForSide(noVig.result, input.side);
    edge = modelEdgePctPoints(input.candidateProbabilityPct, noVigBookProbability);
  }

  const base: Omit<MlbProductionLaneResult, "lane" | "actionabilityReasons"> = {
    inningBand,
    lineIsInteger,
    candidateSide: input.side,
    candidateProbabilityPct: input.candidateProbabilityPct,
    calibratedProbabilityPct: input.calibratedProbabilityPct,
    probabilitySemantics,
    provisionalTag: null,
    rawBookImpliedProbability,
    noVigBookProbability,
    modelEdgePctPoints: edge,
    edgeVersion: MLB_EDGE_VERSION,
    version: MLB_PRODUCTION_LANE_VERSION,
  };

  const mode = resolveMarketMode(input.market, policy);
  // Shadow/off markets never reach official/watch — they land shadow regardless.
  if (mode === "shadow" || mode === "off") {
    reasons.push(mode === "off" ? "market_off" : "market_shadow");
    return { ...base, lane: "shadow", actionabilityReasons: reasons };
  }

  // From here the market is `official`-mode. Collect every failed gate (so
  // diagnostics show all reasons), then land official only if none failed.
  if (!input.baseEligible) reasons.push("base_ineligible");

  const marketGate = resolveMarketOfficialGate(input.market, input.inning, policy);
  if (!marketGate.officialAllowed && marketGate.reason) reasons.push(marketGate.reason);

  const evidence = evaluateMarketEvidenceInvariants(input.evidence);
  for (const f of evidence.failedInvariants) reasons.push(`evidence:${f}`);

  if (!noVig.ok) {
    reasons.push("novig_unavailable");
    reasons.push("price_ineligible");
  } else if (edge == null || edge < policy.thresholds.minNoVigEdgePctPoints) {
    reasons.push("price_ineligible");
  }

  if (!(input.candidateProbabilityPct >= policy.thresholds.minCandidateProbabilityPct)) {
    reasons.push("probability_below_floor");
  }

  // Pushable integer line ⇒ non-official unless a win/push/loss model backs it.
  // Stage A models no push explicitly, so integer lines fail closed here.
  if (lineIsInteger) reasons.push("integer_line_push_unmodeled");

  // Calibration gate: official requires an active compatible calibrator, EXCEPT
  // `hits` under the provisional-uncalibrated compat switch.
  let provisionalTag: typeof PROVISIONAL_UNCALIBRATED_TAG | null = null;
  if (!isCalibrated) {
    if (input.market === "hits" && HITS_PROVISIONAL_UNCALIBRATED_DEFAULT) {
      provisionalTag = PROVISIONAL_UNCALIBRATED_TAG;
      reasons.push("provisional_uncalibrated");
    } else {
      reasons.push("no_active_calibrator");
    }
  } else {
    reasons.push("calibrated");
  }

  // Failure = any reason that is NOT a positive/informational tag.
  const positiveTags = new Set<MlbActionabilityReason>(["calibrated", "provisional_uncalibrated"]);
  const blockingReasons = reasons.filter((r) => !positiveTags.has(r));
  const cleared = blockingReasons.length === 0;
  const lane = resolveMlbLane(input.market, cleared, policy);

  return { ...base, provisionalTag, lane, actionabilityReasons: reasons };
}
