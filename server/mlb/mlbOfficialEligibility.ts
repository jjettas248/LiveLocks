// ── MLB Live Edge Trust Recovery (Phase 4) ──────────────────────────────────
// Single typed finalized-eligibility contract. A signal may become an
// official persisted play ONLY when this function returns eligible:true.
// Pure, no I/O — every input is a value already present on MLBQualifiedSignal.
// This function does not mutate its input and must never be bypassed by an
// ad hoc equivalent check anywhere else in the pipeline (orchestrator
// persistence, route safety net, API view model, canonical mapper,
// analytics, UI grouping all consume this same result).

import type { MLBQualifiedSignal } from "./types";
import { DISABLED_MLB_MARKETS } from "./types";
import { isApprovedMlbBookmaker } from "../oddsService";

export const MLB_OFFICIAL_ELIGIBILITY_VERSION = "mlb_official_eligibility_v1";

export type MlbOfficialIneligibleReason =
  | "unsupported_market"
  | "missing_game_id"
  | "missing_player_id"
  | "missing_side"
  | "not_actionable"
  | "watchlist"
  | "early_signal"
  | "suppressed"
  | "already_hit"
  | "missing_sportsbook"
  | "sportsbook_not_approved"
  | "missing_odds_source_timestamp"
  | "invalid_odds_for_side"
  | "invalid_line"
  | "invalid_probability"
  | "invalid_projection"
  | "current_stat_unknown"
  | "hr_not_current_fire"
  | "hr_missing_real_line";

export interface MlbOfficialEligibilityResult {
  eligible: boolean;
  reasons: MlbOfficialIneligibleReason[];
  version: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidAmericanOdds(v: unknown): v is number {
  if (!isFiniteNumber(v)) return false;
  return v <= -100 || v >= 100;
}

/**
 * Evaluates whether a fully-qualified MLB signal, as it stands THIS tick, is
 * eligible to become (or remain) an official persisted play. This is a
 * current-tick eligibility check — it is deliberately NOT the same concept as
 * `reachedFireCommitment` (a retrospective lifetime-peak classification used
 * for grading/miss-bucket purposes).
 */
export function evaluateMlbOfficialEligibility(
  sig: MLBQualifiedSignal
): MlbOfficialEligibilityResult {
  const reasons: MlbOfficialIneligibleReason[] = [];

  if (DISABLED_MLB_MARKETS.includes(sig.market)) {
    reasons.push("unsupported_market");
  }
  if (!sig.gameId) reasons.push("missing_game_id");
  if (!sig.playerId) reasons.push("missing_player_id");
  if (sig.side !== "OVER" && sig.side !== "UNDER") reasons.push("missing_side");

  if (sig.actionable !== true) reasons.push("not_actionable");

  // No watchlist-bypass carve-out — watch/early signals are never official,
  // full stop, regardless of marketFamily/mode.
  if (sig.watchlist) reasons.push("watchlist");
  if (sig.isEarlySignal) reasons.push("early_signal");

  if ((sig as { suppressed?: boolean }).suppressed) reasons.push("suppressed");
  if (sig.alreadyHit) reasons.push("already_hit");

  if (!sig.sportsbook || sig.sportsbook.trim() === "") {
    reasons.push("missing_sportsbook");
  } else if (!isApprovedMlbBookmaker(sig.sportsbook)) {
    reasons.push("sportsbook_not_approved");
  }

  // Official freshness reads the real sportsbook quote timestamp only —
  // never engine-generation time, never cache-fetch time.
  if (sig.oddsTimestamp == null) reasons.push("missing_odds_source_timestamp");

  const sideOdds = sig.side === "OVER" ? sig.overOdds : sig.side === "UNDER" ? sig.underOdds : null;
  if (!isValidAmericanOdds(sideOdds)) reasons.push("invalid_odds_for_side");

  if (!isFiniteNumber(sig.line) || sig.line <= 0) reasons.push("invalid_line");
  if (!isFiniteNumber(sig.engineProbability) || sig.engineProbability < 0 || sig.engineProbability > 100) {
    reasons.push("invalid_probability");
  }
  if (!isFiniteNumber(sig.projection)) reasons.push("invalid_projection");

  if (sig.currentStatKnown !== true) reasons.push("current_stat_unknown");

  if (sig.market === "home_runs") {
    if (sig.hasRealSportsbookLine !== true) reasons.push("hr_missing_real_line");
    if (sig.hrCurrentState !== "BET_NOW") reasons.push("hr_not_current_fire");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    version: MLB_OFFICIAL_ELIGIBILITY_VERSION,
  };
}
