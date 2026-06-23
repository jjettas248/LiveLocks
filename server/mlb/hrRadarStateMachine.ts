// HR Radar Canonical Lifecycle State Machine
// ─────────────────────────────────────────────────────────────────────────
// Pure transition graph for the HR Radar canonical lifecycle. No I/O, no
// probability math, no mutations to engine outputs. The orchestrator,
// alert engine, settlement, finalization, and UI all read state through
// this module so there is exactly ONE source of truth for HR Radar
// lifecycle.
//
// HARD RULES:
//   * No engine math (engineProbability / calibratedProbability* / evPct
//     / edge / signalScore) is ever read or written here.
//   * Terminal states (cashed | missed | model_review | expired) are
//     sticky — no event can promote them back to an active state.
//   * Illegal transitions are REJECTED (returned with ok=false), never
//     thrown. Caller logs and keeps current state.
//   * applyHrRadarLifecycleEvent is a pure function. The in-memory
//     persistence layer lives in hrRadarCanonicalStore.ts.

export type HrRadarLifecycleState =
  | "inactive"
  | "watch"
  | "build"
  | "ready"
  | "fire"
  | "cashed"
  | "missed"
  | "model_review"
  | "expired";

export type HrRadarLifecycleEvent =
  | "CONTACT_EVIDENCE"
  | "NEAR_HR"
  | "BARREL"
  | "REPEATED_DANGER"
  | "PITCHER_FADE"
  | "PROMOTE"
  | "DECAY"
  | "HR_HIT"
  | "GAME_FINAL"
  | "EXPIRE"
  | "MODEL_REVIEW";

export type HrRadarSection =
  | "FIRE"
  | "READY"
  | "BUILD"
  | "WATCH"
  | "CASHED"
  | "MISSED"
  | "MODEL REVIEW"
  | "EXPIRED"
  | "INACTIVE";

// Canonical stage lives in shared/hrRadarStage.ts — alias so this module and
// hrRadarUserStage share ONE definition (Step 5 consolidation).
import type { CanonicalHrRadarStage } from "@shared/hrRadarStage";
export type HrRadarUserStage = CanonicalHrRadarStage;

export const ACTIVE_STATES: ReadonlySet<HrRadarLifecycleState> = new Set<HrRadarLifecycleState>([
  "watch",
  "build",
  "ready",
  "fire",
]);

export const TERMINAL_STATES: ReadonlySet<HrRadarLifecycleState> = new Set<HrRadarLifecycleState>([
  "cashed",
  "missed",
  "model_review",
  "expired",
]);

export function isActive(s: HrRadarLifecycleState): boolean {
  return ACTIVE_STATES.has(s);
}
export function isTerminal(s: HrRadarLifecycleState): boolean {
  return TERMINAL_STATES.has(s);
}

const STATE_RANK: Record<HrRadarLifecycleState, number> = {
  inactive: 0,
  watch: 1,
  build: 2,
  ready: 3,
  fire: 4,
  cashed: 99,
  missed: 99,
  model_review: 99,
  expired: 99,
};

export function rankOf(s: HrRadarLifecycleState): number {
  return STATE_RANK[s];
}

export interface HrRadarApplyContext {
  reason?: string;
  inning?: number | null;
  /** Caller-supplied display score for the resulting state. May be null. */
  displayScore10?: number | null;
  peakScore10?: number | null;
  /** Explicit target for PROMOTE (must be a higher active rank than current). */
  promoteTo?: HrRadarLifecycleState;
  /** Explicit target for DECAY (must be a lower active rank). */
  decayTo?: HrRadarLifecycleState;
  /**
   * For HR_HIT classification. true → HR was preceded by qualifying
   * evidence (so a same-tick promote-to-cashed from inactive is OK).
   * false → HR was the first observation (model_review path).
   */
  hadPriorEvidence?: boolean;
  /**
   * For HR_HIT from inactive with no prior evidence — distinguishes
   * true_uncalled from early_hr_insufficient_sample (e.g. first PA).
   * Caller decides; both end at model_review.
   */
  earlyHrInsufficientSample?: boolean;
}

export interface HrRadarApplyResult {
  ok: boolean;
  previousState: HrRadarLifecycleState;
  nextState: HrRadarLifecycleState;
  section: HrRadarSection;
  userStage: HrRadarUserStage;
  displayScore10: number | null;
  reason: string;
  rejectedReason?: string;
}

// Default display floors per active stage. Kept in lock-step with
// hrRadarUserStage.fallbackScoreForStage so a row that lands in build
// renders ≥ 5.5 even when the engine score is 0. Caller-supplied
// displayScore10 always wins when present.
const STAGE_SCORE_FLOOR: Record<HrRadarLifecycleState, number | null> = {
  inactive: null,
  watch: 3.5,
  build: 5.5,
  ready: 7.5,
  fire: 9.0,
  cashed: 10.0,
  missed: null,
  model_review: null,
  expired: null,
};

function sectionFor(s: HrRadarLifecycleState): HrRadarSection {
  switch (s) {
    case "fire": return "FIRE";
    case "ready": return "READY";
    case "build": return "BUILD";
    case "watch": return "WATCH";
    case "cashed": return "CASHED";
    case "missed": return "MISSED";
    case "model_review": return "MODEL REVIEW";
    case "expired": return "EXPIRED";
    case "inactive": return "INACTIVE";
  }
}

function userStageFor(s: HrRadarLifecycleState): HrRadarUserStage {
  if (s === "fire") return "fire";
  if (s === "ready") return "ready";
  if (s === "build") return "build";
  if (isTerminal(s)) return "resolved";
  return "track";
}

function deriveDisplayScore(
  state: HrRadarLifecycleState,
  ctx?: HrRadarApplyContext,
): number | null {
  if (ctx?.displayScore10 != null && ctx.displayScore10 > 0) return ctx.displayScore10;
  return STAGE_SCORE_FLOOR[state] ?? ctx?.displayScore10 ?? null;
}

function reject(
  current: HrRadarLifecycleState,
  rejectedReason: string,
): HrRadarApplyResult {
  return {
    ok: false,
    previousState: current,
    nextState: current,
    section: sectionFor(current),
    userStage: userStageFor(current),
    displayScore10: null,
    reason: "",
    rejectedReason,
  };
}

function ok(
  current: HrRadarLifecycleState,
  next: HrRadarLifecycleState,
  reason: string,
  ctx?: HrRadarApplyContext,
): HrRadarApplyResult {
  return {
    ok: true,
    previousState: current,
    nextState: next,
    section: sectionFor(next),
    userStage: userStageFor(next),
    displayScore10: deriveDisplayScore(next, ctx),
    reason,
  };
}

/**
 * Apply a lifecycle event to the current state. Pure function.
 *
 * Transition rules (high level):
 *   * Terminal states are sticky — every event from a terminal state is
 *     REJECTED with rejectedReason="terminal_state_locked". Callers
 *     should not retry; the state is final.
 *   * CONTACT_EVIDENCE / NEAR_HR  → at least watch (idempotent if already watch+).
 *   * BARREL                      → at least build (idempotent if already build+).
 *   * REPEATED_DANGER             → at least ready (idempotent if already ready+).
 *   * PITCHER_FADE                → at least ready (idempotent if already ready+).
 *   * PROMOTE                     → explicit upgrade to ctx.promoteTo (must be
 *                                   a strictly higher active rank). Rejects
 *                                   non-active targets and same-or-lower ranks.
 *   * DECAY                       → drops one active rank by default, or to
 *                                   ctx.decayTo if supplied. Watch decays to
 *                                   expired (terminal). Cannot DECAY from
 *                                   inactive or terminal.
 *   * HR_HIT                      → from active → cashed.
 *                                   from inactive + hadPriorEvidence=true
 *                                     → cashed (synthesized from evidence).
 *                                   from inactive + hadPriorEvidence=false
 *                                     → model_review.
 *   * GAME_FINAL                  → from active → missed (player did not HR
 *                                   while we were active).
 *                                   from inactive → inactive (no-op, terminal-equivalent).
 *   * EXPIRE                      → from active → expired.
 *                                   from inactive → expired.
 *   * MODEL_REVIEW                → from active or inactive → model_review.
 */
export function applyHrRadarLifecycleEvent(
  current: HrRadarLifecycleState,
  event: HrRadarLifecycleEvent,
  context?: HrRadarApplyContext,
): HrRadarApplyResult {
  // 1. Terminal lock — never escape.
  if (isTerminal(current)) {
    return reject(current, "terminal_state_locked");
  }

  const ctx = context ?? {};
  const reason = ctx.reason ?? event.toLowerCase();

  switch (event) {
    case "CONTACT_EVIDENCE":
    case "NEAR_HR": {
      if (rankOf(current) >= STATE_RANK.watch) {
        return ok(current, current, `${reason}_idempotent_at_${current}`, ctx);
      }
      return ok(current, "watch", reason, ctx);
    }

    case "BARREL": {
      if (rankOf(current) >= STATE_RANK.build) {
        return ok(current, current, `${reason}_idempotent_at_${current}`, ctx);
      }
      return ok(current, "build", reason, ctx);
    }

    case "REPEATED_DANGER":
    case "PITCHER_FADE": {
      if (rankOf(current) >= STATE_RANK.ready) {
        return ok(current, current, `${reason}_idempotent_at_${current}`, ctx);
      }
      return ok(current, "ready", reason, ctx);
    }

    case "PROMOTE": {
      const target = ctx.promoteTo;
      if (!target) return reject(current, "promote_missing_target");
      if (!ACTIVE_STATES.has(target)) return reject(current, "promote_target_not_active");
      if (rankOf(target) <= rankOf(current)) {
        return reject(current, `promote_not_strictly_higher (${current}→${target})`);
      }
      return ok(current, target, reason, ctx);
    }

    case "DECAY": {
      if (current === "inactive") return reject(current, "decay_from_inactive");
      if (ctx.decayTo) {
        if (isTerminal(ctx.decayTo) && ctx.decayTo !== "expired") {
          return reject(current, "decay_target_invalid_terminal");
        }
        if (ACTIVE_STATES.has(ctx.decayTo) && rankOf(ctx.decayTo) >= rankOf(current)) {
          return reject(current, `decay_not_strictly_lower (${current}→${ctx.decayTo})`);
        }
        return ok(current, ctx.decayTo, reason, ctx);
      }
      // Default: one rank down. watch→expired (terminal exit).
      if (current === "fire") return ok(current, "ready", reason, ctx);
      if (current === "ready") return ok(current, "build", reason, ctx);
      if (current === "build") return ok(current, "watch", reason, ctx);
      if (current === "watch") return ok(current, "expired", reason, ctx);
      return reject(current, "decay_no_path");
    }

    case "HR_HIT": {
      if (isActive(current)) {
        // Section reason carries the active state for cashed-from-X replay.
        return ok(current, "cashed", `cashed_from_${current}`, {
          ...ctx,
          displayScore10: ctx.displayScore10 ?? 10.0,
        });
      }
      // inactive
      if (ctx.hadPriorEvidence) {
        return ok(current, "cashed", "cashed_synthesized_from_evidence", {
          ...ctx,
          displayScore10: ctx.displayScore10 ?? 10.0,
        });
      }
      const cls = ctx.earlyHrInsufficientSample
        ? "early_hr_insufficient_sample"
        : "true_uncalled_hr";
      return ok(current, "model_review", cls, ctx);
    }

    case "GAME_FINAL": {
      if (isActive(current)) {
        return ok(current, "missed", reason, ctx);
      }
      // inactive at final — no-op, but caller should treat as resolved.
      return ok(current, current, "game_final_no_active_state", ctx);
    }

    case "EXPIRE": {
      if (current === "inactive") {
        return ok(current, "expired", reason, ctx);
      }
      return ok(current, "expired", reason, ctx);
    }

    case "MODEL_REVIEW": {
      return ok(current, "model_review", reason, ctx);
    }

    default: {
      const _exhaust: never = event;
      return reject(current, `unknown_event_${String(_exhaust)}`);
    }
  }
}

/** Convenience: section + userStage + score for a static state (no event). */
export function deriveStateView(s: HrRadarLifecycleState): {
  section: HrRadarSection;
  userStage: HrRadarUserStage;
  defaultScore10: number | null;
} {
  return {
    section: sectionFor(s),
    userStage: userStageFor(s),
    defaultScore10: STAGE_SCORE_FLOOR[s] ?? null,
  };
}
