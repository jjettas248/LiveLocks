// ── MLB Live Edge — live player-state contract (Phase 2) ────────────────────
// Pure, I/O-free helpers pulled out of liveGameOrchestrator.ts so the
// batter/pitcher current-stat mapping and opponent-pitcher integrity check are
// independently unit-testable instead of living only as inline switch/if
// statements inside a ~6000-line orchestrator method.

import type { MLBMarket } from "./types";
import type { GameBoxScorePlayer, GamePitchingBoxScorePitcher } from "./dataPullService";

/**
 * A batter's current in-game stat value for a given batter market, read
 * directly from the typed live box-score contract.
 *
 * HRR (Hits + Runs + RBI) is computed from `hits`/`runs`/`rbi` — NOT
 * `hr`/`rbi` alone, and never from an untyped `.r` alias (which does not
 * exist on GameBoxScorePlayer and would silently evaluate to 0).
 */
export function computeBatterCurrentStat(
  market: MLBMarket,
  box: GameBoxScorePlayer | null | undefined,
): number {
  if (!box) return 0;
  switch (market) {
    case "hits": return box.hits;
    case "home_runs": return box.hr;
    case "hrr": return box.hits + box.runs + box.rbi;
    case "total_bases": return box.tb;
    default: return box.hits;
  }
}

/**
 * A pitcher's current in-game stat value for a given pitcher market, read
 * directly from the typed live pitching box-score contract. Returns 0 when
 * the box-score entry is missing — callers MUST treat that as "unknown", not
 * as a confirmed zero (see the `known` flag on evaluatePitcherCurrentStat).
 */
export function computePitcherCurrentStat(
  market: MLBMarket,
  box: GamePitchingBoxScorePitcher | null | undefined,
): number {
  if (!box) return 0;
  switch (market) {
    case "pitcher_strikeouts": return box.strikeOuts;
    case "pitcher_outs": return box.outsRecorded;
    case "hits_allowed": return box.hits;
    case "walks_allowed": return box.baseOnBalls;
    case "hr_allowed": return box.homeRuns;
    default: return 0;
  }
}

export interface PitcherCurrentStatResult {
  value: number;
  /** False when there is no live pitching box-score entry for this pitcher —
   *  `value` is a placeholder (0), not an observed live stat. */
  known: boolean;
}

/** Combines computePitcherCurrentStat with explicit known/unknown provenance. */
export function evaluatePitcherCurrentStat(
  market: MLBMarket,
  box: GamePitchingBoxScorePitcher | null | undefined,
): PitcherCurrentStatResult {
  return { value: computePitcherCurrentStat(market, box), known: box != null };
}

export interface BatterPitcherMatchup {
  batterTeam: string | null | undefined;
  pitcherTeam: string | null | undefined;
  pitcherKnown: boolean;
  isTopInning: boolean;
  homeTeamAbbr: string | null | undefined;
  awayTeamAbbr: string | null | undefined;
}

export type MatchupRejectionReason =
  | "no_active_pitcher"
  | "batter_not_on_offense"
  | "same_team_matchup";

export interface MatchupValidationResult {
  valid: boolean;
  reason?: MatchupRejectionReason;
}

/**
 * Opponent-pitcher integrity (Phase 2). `state.battingOrder` intentionally
 * contains BOTH teams' lineups; `state.pitcherInGame` is the single currently
 * active pitcher. A batter may only be evaluated when:
 *   1. a pitcher has actually been identified (never invent one), AND
 *   2. the batter's team matches the offensive team implied by the current
 *      top/bottom half-inning state, AND
 *   3. the batter's team is not the SAME team as the active pitcher.
 */
export function validateBatterPitcherMatchup(m: BatterPitcherMatchup): MatchupValidationResult {
  if (!m.pitcherKnown) return { valid: false, reason: "no_active_pitcher" };
  const offensiveTeam = m.isTopInning ? m.awayTeamAbbr : m.homeTeamAbbr;
  if (offensiveTeam && m.batterTeam && m.batterTeam !== offensiveTeam) {
    return { valid: false, reason: "batter_not_on_offense" };
  }
  if (m.batterTeam && m.pitcherTeam && m.batterTeam === m.pitcherTeam) {
    return { valid: false, reason: "same_team_matchup" };
  }
  return { valid: true };
}
