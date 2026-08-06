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
//     sweep retries with backoff). Same as the persisted grader leaving pending.
//   * A final game with a finite final stat ⇒ SETTLE (cashed/missed/push graded
//     against the frozen side/line).
//   * A final game where the player is present in the final box but has no stat
//     ⇒ DNP ⇒ VOID immediately (matches settlePlay(..., "void", null) DNP path).
//   * A final game where the player/stat is unresolvable ⇒ HOLD until the row is
//     old enough (official stat corrections land late), then terminal-VOID —
//     mirrors the grader's 48h terminal-void backstop.
//   * A postponed/suspended game ⇒ HOLD until old enough, then terminal-VOID.
//
// Void rows are excluded from calibration denominators (like a push is excluded
// from a hit rate). No I/O; the outcome is resolved by the caller (the future
// sweep) via fetchMlbBoxScore/getMlbStatValue read-only and passed in here.

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
  // not be resolved (game not final, player absent, or DNP). Never a live value.
  finalStat: number | null;
  // True when the player's row exists in a FINAL box score but the market stat
  // is absent/empty (the DNP signal — distinct from "player row missing").
  playerPresentButNoStat: boolean;
  // Hours since the prediction was captured (drives the terminal-void backstop).
  ageHours: number;
}

export interface MlbLedgerSettlementPolicy {
  // Age past which an ungradable (unresolvable or postponed/suspended) row is
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

  // Not final yet (scheduled/live/unknown) ⇒ hold; the sweep retries.
  if (resolution.gameState !== "final") {
    return { action: "hold", reason: `game_not_final_${resolution.gameState}` };
  }

  // Final game with a finite stat ⇒ grade against the frozen side/line.
  if (resolution.finalStat != null && Number.isFinite(resolution.finalStat)) {
    const result = gradeMlbLanePredictionOutcome(prediction.side, prediction.line, resolution.finalStat);
    return { action: "settle", result, finalStat: resolution.finalStat, reason: "graded_final" };
  }

  // Final game, player present but no stat ⇒ DNP ⇒ void immediately.
  if (resolution.playerPresentButNoStat) {
    return { action: "void", voidReason: "player_did_not_appear", reason: "dnp_final_box" };
  }

  // Final game, player/stat unresolvable ⇒ hold for late stat corrections, then
  // terminal-void once old enough.
  if (oldEnoughToVoid) {
    return { action: "void", voidReason: "line_unresolvable", reason: "terminal_void_unresolvable" };
  }
  return { action: "hold", reason: "final_box_missing_player" };
}
