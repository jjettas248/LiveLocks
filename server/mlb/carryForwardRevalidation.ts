// ── MLB Live Edge Trust Recovery (Phase 5) — carry-forward revalidation ──────
// Pure, I/O-free, read-time-only. A signal surviving a narrowed engine cycle
// via edgeCarryForward.ts's scope-not-absence predicate was NOT re-evaluated
// this tick — its pricing, matchup, and opportunity state are exactly what
// they were when it was last freshly computed. This module answers "is a
// carried signal still safe to SHOW" without ever mutating the carried
// object and without re-entering suppression/persistence/the bus (that
// invariant belongs to edgeCarryForward.ts and is untouched by this file).
//
// This is a visibility check only — callers decide what "not visible" means
// (e.g. drop from a served feed) but never write back into the signal.

import type { MLBMarket, MLBQualifiedSignal } from "./types";

const PITCHER_MARKETS: ReadonlySet<MLBMarket> = new Set<MLBMarket>([
  "pitcher_strikeouts",
  "hits_allowed",
  "walks_allowed",
  "pitcher_outs",
  "hr_allowed",
]);

export type CarryForwardRejectionReason =
  | "stale_source_price"
  | "max_age_exceeded"
  | "cache_degraded"
  | "opportunity_exhausted"
  | "current_stat_unknown"
  | "pitching_changed"
  | "same_team_mismatch"
  | "terminal_game_state"
  | "already_resolved"
  | "family_suppressed";

export interface CarryForwardRevalidationContext {
  nowMs: number;
  /** Same bound edgeCarryForward.ts already enforces at merge time; re-checked here for defense in depth at read time. */
  maxCarryAgeMs: number;
  /** isMLBSnapshotFresh's live threshold (ms) for the signal's own oddsTimestamp (real source time, never fetchedAt). */
  oddsFreshnessThresholdMs: number;
  /** The ONE pitcher currently in the game for this side, from state.pitcherInGame. Null when unknown. */
  currentPitcherId: string | null;
  currentPitcherName: string | null;
  /** Batting team currently on offense, if known — used for the same-team defense-in-depth check. */
  currentOffenseTeam: string | null;
  gameIsTerminal: boolean;
  isResolved: boolean;
}

export interface CarryForwardRevalidationResult {
  visible: boolean;
  reasons: CarryForwardRejectionReason[];
}

/**
 * Re-validates a carried (not freshly re-evaluated this cycle) MLB signal
 * against the CURRENT tick's live state. Never mutates `sig`.
 */
export function revalidateCarriedSignal(
  sig: MLBQualifiedSignal,
  ctx: CarryForwardRevalidationContext
): CarryForwardRevalidationResult {
  const reasons: CarryForwardRejectionReason[] = [];

  if (ctx.gameIsTerminal) reasons.push("terminal_game_state");
  if (ctx.isResolved) reasons.push("already_resolved");

  const generatedAt = sig.engineGeneratedAt ?? 0;
  if (generatedAt > 0 && ctx.nowMs - generatedAt > ctx.maxCarryAgeMs) {
    reasons.push("max_age_exceeded");
  }

  if (sig.oddsTimestamp == null) {
    // No real source-timestamp provenance at all — cannot claim it's fresh.
    reasons.push("stale_source_price");
  } else if (ctx.nowMs - sig.oddsTimestamp > ctx.oddsFreshnessThresholdMs) {
    reasons.push("stale_source_price");
  }

  if (sig.isDegraded) reasons.push("cache_degraded");
  if (sig.currentStatKnown === false) reasons.push("current_stat_unknown");

  // Opportunity exhaustion — a batter with all 4 traditional ABs already
  // completed has no realistic remaining opportunity for an OVER market to
  // still develop. Conservative heuristic; never applied to pitcher markets
  // (pitcherPitchCount-based exhaustion is handled by pitching_changed below).
  if (!PITCHER_MARKETS.has(sig.market) && sig.completedAB >= 4) {
    reasons.push("opportunity_exhausted");
  }

  // Pitching change since this signal was last computed.
  if (PITCHER_MARKETS.has(sig.market)) {
    if (ctx.currentPitcherId != null && sig.playerId !== ctx.currentPitcherId) {
      reasons.push("pitching_changed");
    }
  } else if (sig.pitcherName != null && ctx.currentPitcherName != null && sig.pitcherName !== ctx.currentPitcherName) {
    reasons.push("pitching_changed");
  }

  // Same-team mismatch defense-in-depth — Phase 2 already prevents this at
  // signal-generation time; this re-checks that the batter's team still
  // matches the side actually on offense, in case the half-inning flipped
  // while this signal sat carried.
  if (!PITCHER_MARKETS.has(sig.market) && ctx.currentOffenseTeam != null && sig.team && sig.team !== ctx.currentOffenseTeam) {
    reasons.push("same_team_mismatch");
  }

  if (sig.familyPenaltyFactor != null && sig.familyPenaltyFactor < 1 && sig.isFlagship === false) {
    reasons.push("family_suppressed");
  }

  return { visible: reasons.length === 0, reasons };
}
