// ── MLB Live Edge Trust Recovery (Phase 5) — the single finalized-signal ────
// contract. ONE typed function, positioned after all probability/cap/
// suppression/family/lifecycle/pricing/matchup/live-state/resolution logic
// has already run, that every consumer downstream reads without
// reclassification: orchestrator persistence, route safety-net persistence,
// API serialization (normalizeSignal.ts), canonical mapper, analytics, and
// UI grouping. No consumer may independently alter or re-derive side,
// probability, projection, tier, isBettable, official eligibility,
// sportsbook provenance, lifecycle/public classification, or the reasons
// behind that classification after this function has run.
//
// Pure, no I/O. Does not mutate its input.

import type { MLBQualifiedSignal } from "./types";
import {
  evaluateMlbOfficialEligibility,
  computeMlbIsBettable,
  MLB_OFFICIAL_ELIGIBILITY_VERSION,
  type MlbOfficialEligibilityResult,
} from "./mlbOfficialEligibility";
import {
  evaluateMlbProductionLane,
  deriveFinalizedTier,
  type MlbProductionLaneResult,
  type MlbFinalizedTier,
} from "./mlbProductionLane";
import type { MlbLane } from "./productionPolicy";
import { MLB_EDGE_VERSION } from "./oddsProbability";
import { lookupCalibratedProbability } from "./stageC/activeCalibratorRegistry";

export const MLB_FINALIZATION_VERSION = "mlb_signal_finalizer_v1";

export type MlbLifecycleClassification =
  | "official"        // eligible === true this tick — may become/remain an official persisted play
  | "resolved"         // already-hit / terminal — never re-enters any active classification
  | "occurrence_only"   // HR-specific: real detection, no real sportsbook line yet
  | "stale_price"       // missing/expired real sportsbook source-timestamp provenance
  | "degraded"          // isDegraded or currentStatKnown===false — input quality too low to trust
  | "watch"             // watchlist/early-signal/not-yet-bettable
  | "suppressed"         // family suppression (non-flagship, penalty applied) or engine-flagged suppression
  | "ineligible_other";  // catches any other eligibility failure not covered above

export interface MlbFinalizedSignal {
  signalId: string;
  gameId: string;
  playerId: string;
  market: string;
  side: "OVER" | "UNDER" | null;
  probability: number;
  projection: number;
  signalTier: string;
  sportsbook: string | null;
  oddsSourceUpdatedAt: number | null;
  isBettable: boolean;
  isWatchOnly: boolean;
  lifecycleClassification: MlbLifecycleClassification;
  officialEligibility: MlbOfficialEligibilityResult;
  decisionReasons: string[];
  // ── MLB Live Edge safety-core (Stage A part 2) ─────────────────────────────
  // Authoritative production lane + canonical no-vig edge + calibration
  // semantics. `lane === "official"` is strictly NARROWER than
  // officialEligibility.eligible (base current-tick eligibility): official
  // additionally requires the market rollout mode, inning band, hard evidence
  // invariants, no-vig price floor, probability floor, integer-line-push, and
  // calibration/provisional gates — see mlbProductionLane.ts. home_runs is
  // excluded from that matrix and keeps its base-eligibility lane.
  lane: MlbLane;
  laneReasons: string[];
  modelEdgePctPoints: number | null;
  noVigBookProbability: number | null;
  rawBookImpliedProbability: number | null;
  edgeVersion: string;
  outcomeProbabilitySemantics: "raw_provisional" | "outcome_calibrated";
  calibratedCandidateProbability: number | null;
  lineIsInteger: boolean;
  inningBand: string;
  // Finalizer-owned user-facing tier — a pure function of lane + calibration
  // semantics + candidate probability, NEVER signalScore. Non-official or
  // provisional signals are hard-capped below Strong/Elite.
  finalizedTier: MlbFinalizedTier;
  version: string;
}

// Computes the production lane for a signal. home_runs bypasses the market
// rollout matrix entirely (it is governed by the HR Radar lifecycle, not this
// module): its lane mirrors base eligibility so the existing FIRE→official path
// is preserved untouched. Every other market flows through the full production
// gate in evaluateMlbProductionLane.
function computeLane(sig: MLBQualifiedSignal, baseEligible: boolean): {
  lane: MlbLane;
  laneReasons: string[];
  modelEdgePctPoints: number | null;
  noVigBookProbability: number | null;
  rawBookImpliedProbability: number | null;
  outcomeProbabilitySemantics: "raw_provisional" | "outcome_calibrated";
  calibratedCandidateProbability: number | null;
  // The probability the lane/tier/edge DECISIONS use: the calibrated value when a
  // promoted calibrator applies, else the raw engine probability. The raw
  // engineProbability is never mutated — this is a decision input only.
  effectiveCandidateProbabilityPct: number;
  lineIsInteger: boolean;
  inningBand: string;
} {
  const side = sig.side === "OVER" || sig.side === "UNDER" ? sig.side : "OVER";

  if (sig.market === "home_runs") {
    // HR keeps its own lifecycle — no production-matrix gate, no no-vig edge, no
    // calibrator (HR Radar owns its probability path).
    return {
      lane: baseEligible ? "official" : "shadow",
      laneReasons: baseEligible ? ["hr_lifecycle_official"] : ["hr_lifecycle_non_official"],
      modelEdgePctPoints: null,
      noVigBookProbability: null,
      rawBookImpliedProbability: null,
      outcomeProbabilitySemantics: "raw_provisional",
      calibratedCandidateProbability: null,
      effectiveCandidateProbabilityPct: sig.engineProbability,
      lineIsInteger: false,
      inningBand: "n/a",
    };
  }

  // Stage C PR3: consult the in-memory active-calibrator registry (cache-only,
  // pure, flag-gated — returns null unless MLB_CALIBRATION_PROMOTION_ENABLED is
  // on AND a compatible in-support calibrator is active). null ⇒ uncalibrated
  // (raw_provisional), exactly the Stage A semantics. Never an identity copy of
  // the raw probability. The registry default segmentation is per-market.
  const calibrated = lookupCalibratedProbability(sig.market, null, sig.engineProbability);
  // Decisions (edge / floor / tier / ranking) use the calibrated value when it
  // exists; the raw engineProbability is preserved untouched as provenance.
  const effectiveCandidateProbabilityPct = calibrated ?? sig.engineProbability;

  const bothOdds = sig.overOdds != null && sig.underOdds != null;
  const result: MlbProductionLaneResult = evaluateMlbProductionLane({
    market: sig.market,
    side,
    line: sig.line,
    inning: sig.inning ?? 0,
    gameStatus: sig.gameStatus ?? "live",
    baseEligible,
    candidateProbabilityPct: effectiveCandidateProbabilityPct,
    calibratedProbabilityPct: calibrated,
    quote: {
      book: sig.sportsbook,
      line: sig.line,
      overOdds: sig.overOdds,
      underOdds: sig.underOdds,
      sourceTimestamp: sig.oddsTimestamp,
      ageMs: sig.oddsAgeMs ?? null,
    },
    evidence: {
      market: sig.market,
      side,
      currentStatKnown: sig.currentStatKnown === true,
      // Derived from fields already on the signal by finalization time — no
      // qualify-time pre-stamp needed (currentStatKnown is set by the caller
      // AFTER qualifySignal returns, so it can only be read here).
      liveStateComplete: sig.currentStatKnown === true && sig.isDegraded !== true,
      liveStateFresh: sig.currentStatKnown === true,
      modelMethod: sig.modelMethod ?? null,
      fallbackUsed: sig.fallbackUsed === true,
      capApplied: sig.safetyCeilingApplied === true,
      remainingOpportunity: sig.remainingOpportunity ?? null,
      neededOutcomes:
        side === "OVER" && Number.isFinite(sig.line)
          ? Math.max(0, Math.ceil(sig.line) - (Number.isFinite(sig.currentStat) ? sig.currentStat : 0))
          : null,
      hasFreshTwoSidedOdds: bothOdds,
    },
  });

  return {
    lane: result.lane,
    laneReasons: result.actionabilityReasons,
    modelEdgePctPoints: result.modelEdgePctPoints,
    noVigBookProbability: result.noVigBookProbability,
    rawBookImpliedProbability: result.rawBookImpliedProbability,
    outcomeProbabilitySemantics: result.probabilitySemantics,
    calibratedCandidateProbability: result.calibratedProbabilityPct,
    effectiveCandidateProbabilityPct,
    lineIsInteger: result.lineIsInteger,
    inningBand: result.inningBand,
  };
}

function classify(
  sig: MLBQualifiedSignal,
  isBettable: boolean,
  eligibility: MlbOfficialEligibilityResult
): { classification: MlbLifecycleClassification; reasons: string[] } {
  if (eligibility.eligible) {
    const positiveReasons = [
      "market_supported",
      "identity_stable",
      "side_canonical",
      "actionable",
      "not_watchlist",
      "not_early_signal",
      "not_suppressed",
      "not_already_resolved",
      "sportsbook_approved",
      "odds_source_timestamp_present",
      "odds_valid_for_side",
      "probability_valid",
      "projection_valid",
      "current_stat_known",
      "bettable",
    ];
    if (sig.market === "home_runs") {
      positiveReasons.push("hr_fire_confirmed", "hr_real_line_confirmed");
    }
    return { classification: "official", reasons: positiveReasons };
  }

  // Priority order — most specific/severe classification wins when multiple
  // eligibility reasons are present simultaneously.
  if (sig.alreadyHit) {
    return { classification: "resolved", reasons: eligibility.reasons };
  }
  if (sig.market === "home_runs" && sig.hasRealSportsbookLine !== true) {
    return { classification: "occurrence_only", reasons: eligibility.reasons };
  }
  if (eligibility.reasons.includes("missing_odds_source_timestamp")) {
    return { classification: "stale_price", reasons: eligibility.reasons };
  }
  if (sig.isDegraded || sig.currentStatKnown === false) {
    return { classification: "degraded", reasons: eligibility.reasons };
  }
  if (eligibility.reasons.includes("suppressed") || eligibility.reasons.includes("family_suppressed")) {
    return { classification: "suppressed", reasons: eligibility.reasons };
  }
  if (sig.watchlist || sig.isEarlySignal || !isBettable) {
    return { classification: "watch", reasons: eligibility.reasons };
  }
  return { classification: "ineligible_other", reasons: eligibility.reasons };
}

/**
 * The single finalization boundary for MLB signals. Called once per signal,
 * after all upstream engine/lifecycle/pricing/suppression logic has run.
 * Every field on the returned object is authoritative — no consumer may
 * recompute any of them independently.
 */
export function finalizeMlbSignal(sig: MLBQualifiedSignal): MlbFinalizedSignal {
  const isBettable = computeMlbIsBettable(sig);
  const tier = (sig.signalTier ?? "watch") as string;
  const isWatchOnly = !isBettable || tier === "watch";

  const officialEligibility = evaluateMlbOfficialEligibility(sig);
  const { classification, reasons } = classify(sig, isBettable, officialEligibility);
  const laneInfo = computeLane(sig, officialEligibility.eligible);
  // Finalizer-owned tier. HR keeps its own lifecycle tier (signalScore never
  // set HR tiers), so only non-HR markets get the capped production tier.
  const finalizedTier: MlbFinalizedTier =
    sig.market === "home_runs"
      ? ((sig.signalTier as MlbFinalizedTier) ?? "watch")
      : deriveFinalizedTier({
          lane: laneInfo.lane,
          semantics: laneInfo.outcomeProbabilitySemantics,
          // Tier uses the effective (calibrated when promoted, else raw) prob —
          // the Strong/Elite bands only unlock for outcome_calibrated signals.
          candidateProbabilityPct: laneInfo.effectiveCandidateProbabilityPct,
        });

  return {
    signalId: sig.id,
    gameId: sig.gameId,
    playerId: sig.playerId,
    market: sig.market,
    side: sig.side === "OVER" || sig.side === "UNDER" ? sig.side : null,
    probability: sig.engineProbability,
    projection: sig.projection,
    signalTier: tier,
    sportsbook: sig.sportsbook,
    oddsSourceUpdatedAt: sig.oddsTimestamp,
    isBettable,
    isWatchOnly,
    lifecycleClassification: classification,
    officialEligibility,
    decisionReasons: reasons,
    lane: laneInfo.lane,
    laneReasons: laneInfo.laneReasons,
    modelEdgePctPoints: laneInfo.modelEdgePctPoints,
    noVigBookProbability: laneInfo.noVigBookProbability,
    rawBookImpliedProbability: laneInfo.rawBookImpliedProbability,
    edgeVersion: MLB_EDGE_VERSION,
    outcomeProbabilitySemantics: laneInfo.outcomeProbabilitySemantics,
    calibratedCandidateProbability: laneInfo.calibratedCandidateProbability,
    lineIsInteger: laneInfo.lineIsInteger,
    inningBand: laneInfo.inningBand,
    finalizedTier,
    version: MLB_FINALIZATION_VERSION,
  };
}

/**
 * Stamps finalizeMlbSignal()'s result onto every signal in `signals`
 * in-place (officialEligibility, isBettable, lifecycleClassification,
 * decisionReasons). Mutating these specific stamp fields is intentional and
 * safe — they are additive classification metadata, not any of the
 * IMMUTABLE_FIELDS values (probability, side, market, signalTier,
 * signalScore, drivers) governed by shared/canonicalSignal.ts. Call this
 * ONCE per orchestrator cycle over the full `allSignals` array (a superset
 * of `qualifiedSignals`) so every signal — including watch-only ones that
 * never reach autoPersistMLBSignals — carries the same finalized values by
 * the time it is written to mlbEdgeCache.
 */
export function stampMlbSignalFinalization(signals: MLBQualifiedSignal[], nowMs: number = Date.now()): void {
  for (const sig of signals) {
    // Stamp odds observation age + game status here (the one place with a
    // clock) so finalizeMlbSignal itself stays pure/deterministic. gameStatus
    // is "live" — this orchestrator only processes in-progress games.
    if (sig.gameStatus == null) sig.gameStatus = "live";
    sig.oddsAgeMs = sig.oddsTimestamp != null ? Math.max(0, nowMs - sig.oddsTimestamp) : null;
    const finalized = finalizeMlbSignal(sig);
    sig.officialEligibility = { eligible: finalized.officialEligibility.eligible, reasons: finalized.officialEligibility.reasons, version: finalized.officialEligibility.version };
    sig.isBettable = finalized.isBettable;
    sig.lifecycleClassification = finalized.lifecycleClassification;
    sig.decisionReasons = finalized.decisionReasons;
    // Stage A part 2 — stamp the authoritative production lane + canonical
    // no-vig edge + calibration semantics. Additive metadata (not an
    // IMMUTABLE_FIELDS value); every downstream consumer reads these rather
    // than recomputing.
    sig.lane = finalized.lane;
    sig.laneReasons = finalized.laneReasons;
    sig.modelEdgePctPoints = finalized.modelEdgePctPoints;
    sig.noVigBookProbability = finalized.noVigBookProbability;
    sig.rawBookImpliedProbability = finalized.rawBookImpliedProbability;
    sig.edgeVersion = finalized.edgeVersion;
    sig.outcomeProbabilitySemantics = finalized.outcomeProbabilitySemantics;
    sig.calibratedCandidateProbability = finalized.calibratedCandidateProbability;
    sig.lineIsInteger = finalized.lineIsInteger;
    sig.inningBand = finalized.inningBand;
    // Finalizer-owned tier becomes the authoritative user-facing signalTier for
    // non-HR markets — this is what removes signalScore's authority over the
    // rendered tier. A non-official or provisional signal can never carry a
    // Strong/Elite signalTier past this point, no matter its signalScore. HR
    // markets keep their own lifecycle tier untouched.
    sig.finalizedTier = finalized.finalizedTier;
    if (sig.market !== "home_runs") {
      sig.signalTier = finalized.finalizedTier;
    }
  }
}
