// ── MLB Live Edge safety-core — Stage B: Prediction Settlement Decision ──────
// Pure decision function for grading a captured MlbLanePrediction against a
// resolved game/box-score outcome. It decides ONLY what to do — hold / settle /
// void — and the caller applies it via the frozen contract's
// settleMlbLanePrediction / voidMlbLanePrediction (single-write, terminal-safe).
//
// It faithfully mirrors the persisted-play grader's conventions
// (server/services/gradePersistedPlays.ts) so Stage B grades identically to the
// official pipeline WITHOUT touching it:
//   * A not-final game ⇒ HOLD (never void on a transient/pending outcome — the
//     sweep retries). Only once the row is terminal-old is it retired via a
//     NEUTRAL `line_unresolvable` void (never asserting "postponed" for a game
//     whose box was merely unfetchable — that would mislabel a real final).
//   * A final game with a finite final stat ⇒ SETTLE (cashed/missed/push).
//   * A final game where the player TRULY did not appear (present in the box
//     with NO batting AND NO pitching participation) ⇒ VOID player_did_not_appear
//     immediately — matching the persisted grader's isDnp gate (both empty).
//   * A final game where the player played but THIS market's stat is not yet
//     resolvable (present WITH stats but the field is absent), or the player row
//     is missing ⇒ HOLD for late/partial-box corrections, then terminal-VOID
//     (line_unresolvable) once old enough. This preserves gradable observations
//     instead of dropping them as false DNPs — the whole point of the dataset.
//   * A postponed/suspended game ⇒ HOLD until old enough, then terminal-VOID.
//
// Void rows are excluded from calibration denominators (like a push is excluded
// from a hit rate). No I/O; the outcome is resolved by the caller (the sweep)
// via fetchMlbBoxScore/getMlbStatValue read-only and passed in here.

import {
  gradeMlbLanePredictionOutcome,
  isTerminalMlbLedgerStatus,
  type MlbLanePrediction,
  type MlbLedgerSettlementResult,
  type MlbLedgerVoidReason,
} from "@shared/mlbPredictionLedger";

// The coarse game state the outcome resolver reports. Kept independent of
// oddsService's MlbGameStatus so the pure decision has an explicit, closed set.
export const MLB_LEDGER_OUTCOME_GAME_STATES = [
  "scheduled", "live", "final", "postponed", "suspended", "unknown",
] as const;
export type MlbLedgerOutcomeGameState = (typeof MLB_LEDGER_OUTCOME_GAME_STATES)[number];

export interface MlbLedgerOutcomeResolution {
  gameState: MlbLedgerOutcomeGameState;
  // The resolved FINAL stat for this prediction's market, or null when it could
  // not be resolved (game not final, player absent, DNP, or field not yet in
  // the box). Never a live value.
  finalStat: number | null;
  // The player's row exists in a FINAL box score.
  playerFoundInFinalBox: boolean;
  // The found player has ANY batting or pitching participation. false with
  // playerFoundInFinalBox=true is a TRUE did-not-appear (matches the persisted
  // grader's "batting AND pitching empty" DNP gate); true here with a null
  // finalStat means the player played but this market's field is not yet
  // resolvable (hold, do not DNP-void).
  playerHasAnyStats: boolean;
  // Hours since the prediction was captured (drives the terminal-void backstop).
  ageHours: number;
}

export interface MlbLedgerSettlementPolicy {
  // Age past which an ungradable (unresolvable / not-final / postponed) row is
  // terminal-voided instead of held forever. Matches the persisted grader's
  // TERMINAL_VOID_AGE_HOURS = 48.
  terminalVoidAgeHours: number;
}

export const DEFAULT_MLB_LEDGER_SETTLEMENT_POLICY: MlbLedgerSettlementPolicy = {
  terminalVoidAgeHours: 48,
};

export type MlbLedgerSettlementAction = "hold" | "settle" | "void";

export interface MlbLedgerSettlementDecision {
  action: MlbLedgerSettlementAction;
  // Present when action === "settle": cashed/missed/push, plus the finalStat.
  result?: MlbLedgerSettlementResult;
  finalStat?: number;
  // Present when action === "void".
  voidReason?: MlbLedgerVoidReason;
  // Always present — a stable, closed diagnostic reason code.
  reason: string;
}

/**
 * Decides how to settle a captured prediction given a resolved outcome. Pure and
 * total — never throws for the caller's normal inputs; a terminal row yields a
 * defensive "hold" (the sweep should not have selected it).
 */
export function decideLanePredictionSettlement(
  prediction: MlbLanePrediction,
  resolution: MlbLedgerOutcomeResolution,
  policy: MlbLedgerSettlementPolicy = DEFAULT_MLB_LEDGER_SETTLEMENT_POLICY,
): MlbLedgerSettlementDecision {
  if (isTerminalMlbLedgerStatus(prediction.status)) {
    return { action: "hold", reason: "already_terminal" };
  }

  const oldEnoughToVoid = resolution.ageHours >= policy.terminalVoidAgeHours;

  // Postponed / suspended: never void while the game might still resume — hold
  // until the terminal backstop age, then retire the row.
  if (resolution.gameState === "postponed" || resolution.gameState === "suspended") {
    if (oldEnoughToVoid) {
      return {
        action: "void",
        voidReason: resolution.gameState === "postponed" ? "game_postponed" : "game_suspended",
        reason: `terminal_void_${resolution.gameState}`,
      };
    }
    return { action: "hold", reason: `awaiting_${resolution.gameState}` };
  }

  // Not final yet (scheduled/live/unknown ⇒ box not final or unfetchable). Hold
  // and retry; only retire once terminal-old, and with a NEUTRAL reason —
  // "postponed" must never be asserted for a game whose box was merely
  // unavailable (that would mislabel a genuinely-final game).
  if (resolution.gameState !== "final") {
    if (oldEnoughToVoid) {
      return { action: "void", voidReason: "line_unresolvable", reason: `terminal_void_not_final_${resolution.gameState}` };
    }
    return { action: "hold", reason: `game_not_final_${resolution.gameState}` };
  }

  // Final game with a finite stat ⇒ grade against the frozen side/line.
  if (resolution.finalStat != null && Number.isFinite(resolution.finalStat)) {
    const result = gradeMlbLanePredictionOutcome(prediction.side, prediction.line, resolution.finalStat);
    return { action: "settle", result, finalStat: resolution.finalStat, reason: "graded_final" };
  }

  // Final game, player present in the box with NO participation at all ⇒ a TRUE
  // did-not-appear ⇒ void immediately.
  if (resolution.playerFoundInFinalBox && !resolution.playerHasAnyStats) {
    return { action: "void", voidReason: "player_did_not_appear", reason: "dnp_final_box" };
  }

  // Final game, but this market's stat is not (yet) resolvable — either the
  // player played but the field is absent (partial/late box), or the player row
  // is missing. Hold for corrections, then terminal-void as unresolvable. Do NOT
  // treat this as a DNP: that would drop a gradable observation.
  if (oldEnoughToVoid) {
    return { action: "void", voidReason: "line_unresolvable", reason: "terminal_void_unresolvable" };
  }
  return { action: "hold", reason: "final_box_unresolvable" };
}
