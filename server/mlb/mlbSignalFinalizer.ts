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
  version: string;
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
export function stampMlbSignalFinalization(signals: MLBQualifiedSignal[]): void {
  for (const sig of signals) {
    const finalized = finalizeMlbSignal(sig);
    sig.officialEligibility = { eligible: finalized.officialEligibility.eligible, reasons: finalized.officialEligibility.reasons, version: finalized.officialEligibility.version };
    sig.isBettable = finalized.isBettable;
    sig.lifecycleClassification = finalized.lifecycleClassification;
    sig.decisionReasons = finalized.decisionReasons;
  }
}
