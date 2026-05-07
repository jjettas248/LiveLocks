// ── LiveLocks Batch B — Lifecycle Engine ──────────────────────────────
// Pure transition engine for CanonicalSignal.lifecycleState.
//
// Hard rules:
//   - NEVER mutates probability/edge/projection/drivers/signalTier.
//   - lifecycleState is ORTHOGONAL to signalTier — no inference here.
//   - Invalid transitions are LOGGED and IGNORED, never thrown.

import type {
  CanonicalSignal,
  LifecycleEventKind,
  LifecycleHistoryEntry,
  LifecycleState,
} from "../../shared/canonicalSignal";
import { LIFECYCLE_TRANSITIONS, isTerminalLifecycle } from "../../shared/canonicalSignal";

export interface LifecycleEvent {
  kind: LifecycleEventKind;
  to: LifecycleState;
  reason?: string;
  by?: string;
  at?: number;
}

export interface ApplyResult {
  changed: boolean;
  next: CanonicalSignal;
  rejected?: { reason: string; from: LifecycleState; to: LifecycleState };
}

export function validateTransition(from: LifecycleState, to: LifecycleState): boolean {
  if (from === to) return true; // idempotent — allow no-op refreshes
  if (isTerminalLifecycle(from)) return false;
  return LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

function tagFor(kind: LifecycleEventKind): string {
  switch (kind) {
    case "created":    return "[LL_SIGNAL_CREATED]";
    case "upgraded":   return "[LL_SIGNAL_UPGRADED]";
    case "downgraded": return "[LL_SIGNAL_DOWNGRADED]";
    case "cashed":     return "[LL_SIGNAL_CASHED]";
    case "missed":     return "[LL_SIGNAL_MISSED]";
    case "expired":    return "[LL_SIGNAL_EXPIRED]";
    case "suppressed": return "[LL_SIGNAL_SUPPRESSED]";
  }
}

/**
 * Apply a lifecycle event to a canonical signal. Returns a new object —
 * the input is never mutated. If the transition is invalid, returns
 * { changed: false } with a `rejected` reason and emits
 * [LL_LIFECYCLE_INVALID_TRANSITION].
 */
export function applyLifecycleEvent(
  prev: CanonicalSignal,
  event: LifecycleEvent
): ApplyResult {
  const at = event.at ?? Date.now();
  const from = prev.lifecycleState;
  const to = event.to;

  if (!validateTransition(from, to)) {
    console.warn(
      `[LL_LIFECYCLE_INVALID_TRANSITION] signalId=${prev.signalId} from=${from} to=${to} kind=${event.kind} reason=${event.reason ?? "n/a"}`
    );
    return {
      changed: false,
      next: prev,
      rejected: { reason: `invalid ${from}→${to}`, from, to },
    };
  }

  if (from === to) {
    // No-op refresh — only bump updatedAt, no history entry.
    return {
      changed: false,
      next: { ...prev, updatedAt: at },
    };
  }

  const entry: LifecycleHistoryEntry = {
    at,
    from,
    to,
    event: event.kind,
    reason: event.reason,
    by: event.by ?? "engine",
  };

  const next: CanonicalSignal = {
    ...prev,
    lifecycleState: to,
    lifecycleHistory: [...prev.lifecycleHistory, entry],
    updatedAt: at,
    suppressionReason: event.kind === "suppressed" ? event.reason ?? null : prev.suppressionReason,
    expirationReason:  event.kind === "expired"    ? event.reason ?? null : prev.expirationReason,
  };

  console.log(
    `${tagFor(event.kind)} signalId=${prev.signalId} ${from}→${to} reason=${event.reason ?? "n/a"} by=${entry.by}`
  );

  return { changed: true, next };
}

/**
 * Convenience: classify the directional kind of a lifecycle change for
 * call sites that only know "I want to move this signal to <to>".
 */
export function inferEventKind(from: LifecycleState, to: LifecycleState): LifecycleEventKind {
  if (to === "cashed") return "cashed";
  if (to === "missed") return "missed";
  if (to === "expired") return "expired";
  const order: LifecycleState[] = ["watch", "build", "strong", "elite"];
  const fi = order.indexOf(from);
  const ti = order.indexOf(to);
  if (fi < 0 || ti < 0) return "created";
  return ti > fi ? "upgraded" : "downgraded";
}
