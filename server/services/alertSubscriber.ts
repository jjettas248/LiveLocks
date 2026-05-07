// ── LiveLocks Phase 1, Batch D — Alert Subscriber ─────────────────────
// Bus-lifecycle-driven alert pipeline. ALL alert triggers must originate
// from a CanonicalSignal lifecycle event. Component renders / route
// refreshes / client polling / direct cache writes can NEVER fire alerts.
//
// HARD RULES (Batch D Part 5):
//   - Alert source = SignalBus lifecycle event ONLY.
//   - Eligibility:
//       Free        → no premium alert firehose
//       Pro         → NBA / NCAAB strong+
//       All Sports  → MLB strong+ + elite + HR Watch
//       Admin       → debug visibility, not normal user gating
//   - Dedupe: signalId + state + 5-min cooldown.
//   - Alerts log every step: queued / sent / suppressed / deduped.

import type { CanonicalSignal, LifecycleState } from "../../shared/canonicalSignal";

// ── Trigger taxonomy ─────────────────────────────────────────────────
export type AlertTrigger =
  | "lifecycle_upgraded"     // build → strong, strong → elite, watch → strong, etc.
  | "tier_upgraded"          // signalTier escalation observed
  | "hr_watch_detected"      // first surface of HR Watch evidence
  | "hr_watch_upgraded"      // HR Watch → ready / fire
  | "mlb_inning_escalation"  // late-inning context flip
  | "nba_halftime";          // NBA 2H lifecycle event

export type AlertSeverity = "info" | "strong" | "elite" | "fire";

// ── Eligibility ──────────────────────────────────────────────────────
// Pure function — no DB / no network. Tier comes from the user record.
// The dispatcher (Resend / Twilio) handles per-user delivery channels.
export type UserTier = "free" | "pro" | "all_sports" | "admin";

export function isEligibleForAlert(
  tier: UserTier,
  canonical: CanonicalSignal,
  trigger: AlertTrigger
): boolean {
  if (tier === "free") return false;

  // MLB-specific gating — All Sports tier required for MLB alerts.
  if (canonical.sport === "mlb") {
    return (
      tier === "all_sports" &&
      (canonical.signalTier === "strong" ||
        canonical.signalTier === "elite" ||
        trigger === "hr_watch_detected" ||
        trigger === "hr_watch_upgraded")
    );
  }

  // NBA / NCAAB — Pro tier or above is eligible at strong+ tier.
  if (canonical.sport === "nba" || canonical.sport === "ncaab") {
    return canonical.signalTier === "strong" || canonical.signalTier === "elite";
  }

  return false;
}

function severityFor(trigger: AlertTrigger, canonical: CanonicalSignal): AlertSeverity {
  if (trigger === "hr_watch_upgraded") return "fire";
  if (trigger === "hr_watch_detected") return "strong";
  if (canonical.signalTier === "elite") return "elite";
  if (canonical.signalTier === "strong") return "strong";
  return "info";
}

// ── Dedupe + queue ───────────────────────────────────────────────────
// Map<dedupeKey, lastFiredAt>. Per Batch D spec, dedupe key = `signalId + state`
// with a 5-minute cooldown. The trigger is intentionally NOT part of the
// dedupe key so that two different triggers landing on the same lifecycle
// state still count as one alert event for that state.
const DEDUPE_COOLDOWN_MS = 5 * 60 * 1000;
const _dedupe: Map<string, number> = new Map();

interface QueuedAlert {
  signalId: string;
  trigger: AlertTrigger;
  severity: AlertSeverity;
  state: LifecycleState;
  queuedAt: number;
  canonical: CanonicalSignal;
}

const _queue: QueuedAlert[] = [];

interface AlertMetrics {
  queued: number;
  sent: number;
  suppressed: number;
  deduped: number;
  opened: number;
  clicked: number;
  byTrigger: Record<string, number>;
  byState: Record<string, number>;
}

const _alertMetrics: AlertMetrics = {
  queued: 0,
  sent: 0,
  suppressed: 0,
  deduped: 0,
  opened: 0,
  clicked: 0,
  byTrigger: {},
  byState: {},
};

export function getAlertMetrics() {
  return {
    ..._alertMetrics,
    byTrigger: { ..._alertMetrics.byTrigger },
    byState: { ..._alertMetrics.byState },
    queueDepth: _queue.length,
  };
}

/**
 * SOLE entry point for triggering alerts from bus lifecycle changes.
 * Call from registerSignal AFTER recordCanonical — never from anywhere
 * else.
 */
export function notifyLifecycleChange(
  canonical: CanonicalSignal,
  trigger: AlertTrigger,
  reason?: string
): void {
  // Dedupe key per spec: signalId + lifecycleState only.
  const dedupeKey = `${canonical.signalId}:${canonical.lifecycleState}`;
  const now = Date.now();
  const lastFired = _dedupe.get(dedupeKey) ?? 0;
  if (now - lastFired < DEDUPE_COOLDOWN_MS) {
    _alertMetrics.deduped++;
    console.log(
      `[LL_ALERT_DEDUPE] signalId=${canonical.signalId} trigger=${trigger} state=${canonical.lifecycleState} cooldownMsRemaining=${DEDUPE_COOLDOWN_MS - (now - lastFired)}`
    );
    return;
  }

  // Suppression policy — terminal lifecycle states never alert (the
  // grader handles win/loss notifications via a separate channel).
  if (
    canonical.lifecycleState === "cashed" ||
    canonical.lifecycleState === "missed" ||
    canonical.lifecycleState === "expired"
  ) {
    _alertMetrics.suppressed++;
    console.log(
      `[LL_ALERT_SUPPRESSED] signalId=${canonical.signalId} reason=terminal-lifecycle state=${canonical.lifecycleState}`
    );
    return;
  }

  // Suppression policy — non-bettable tiers (watch / lean) don't alert.
  if (
    trigger !== "hr_watch_detected" &&
    trigger !== "hr_watch_upgraded" &&
    (canonical.signalTier === "watch" || canonical.signalTier === "lean")
  ) {
    _alertMetrics.suppressed++;
    console.log(
      `[LL_ALERT_SUPPRESSED] signalId=${canonical.signalId} reason=below-bettable-tier tier=${canonical.signalTier}`
    );
    return;
  }

  // Eligibility precheck — if NO paid tier could ever be eligible for this
  // canonical+trigger combo, drop it before queueing. Per-user gating
  // (which user actually receives it) still happens in the dispatch hook
  // via isEligibleForAlert(userTier, canonical, trigger). This precheck
  // simply ensures the queue never carries an alert nobody could receive.
  const couldAnyPaidTierFire =
    isEligibleForAlert("pro", canonical, trigger) ||
    isEligibleForAlert("all_sports", canonical, trigger);
  if (!couldAnyPaidTierFire) {
    _alertMetrics.suppressed++;
    console.log(
      `[LL_ALERT_SUPPRESSED] signalId=${canonical.signalId} reason=no-eligible-tier sport=${canonical.sport} tier=${canonical.signalTier} trigger=${trigger}`
    );
    return;
  }

  const severity = severityFor(trigger, canonical);
  const queued: QueuedAlert = {
    signalId: canonical.signalId,
    trigger,
    severity,
    state: canonical.lifecycleState,
    queuedAt: now,
    canonical,
  };
  _queue.push(queued);
  _dedupe.set(dedupeKey, now);
  _alertMetrics.queued++;
  _alertMetrics.byTrigger[trigger] = (_alertMetrics.byTrigger[trigger] ?? 0) + 1;
  _alertMetrics.byState[canonical.lifecycleState] =
    (_alertMetrics.byState[canonical.lifecycleState] ?? 0) + 1;
  console.log(
    `[LL_ALERT_QUEUED] signalId=${canonical.signalId} trigger=${trigger} severity=${severity} state=${canonical.lifecycleState} reason=${reason ?? "n/a"}`
  );
}

/**
 * Drain the queue and fan out to per-user channels. The actual dispatch
 * (SMS / email / push) is delegated to the existing notification
 * services (Twilio / Resend / web push) which look up subscriber
 * preferences and tier. This skeleton logs [LL_ALERT_SENT] for each
 * fanout — wiring to the production dispatchers is the follow-up.
 */
// Dispatch hook contract: receives a queued alert AND the eligibility
// predicate. Implementations MUST iterate their per-user subscriber list
// and call `isEligibleForAlert(userTier, q.canonical, q.trigger)` to gate
// each recipient. This keeps eligibility enforcement runtime-mandatory.
export interface DispatchHook {
  (
    queued: QueuedAlert,
    isEligible: typeof isEligibleForAlert,
  ): Promise<{ recipients: number }>;
}

let _dispatchHook: DispatchHook | null = null;
export function setDispatchHook(hook: DispatchHook | null) {
  _dispatchHook = hook;
}

export async function drainAlertQueue(): Promise<number> {
  if (_queue.length === 0) return 0;
  const batch = _queue.splice(0, _queue.length);
  let sent = 0;
  for (const q of batch) {
    try {
      const result = _dispatchHook
        ? await _dispatchHook(q, isEligibleForAlert)
        : { recipients: 0 };
      _alertMetrics.sent++;
      sent++;
      console.log(
        `[LL_ALERT_SENT] signalId=${q.signalId} trigger=${q.trigger} severity=${q.severity} recipients=${result.recipients}`
      );
    } catch (err) {
      _alertMetrics.suppressed++;
      console.warn(
        `[LL_ALERT_SUPPRESSED] signalId=${q.signalId} reason=dispatch-failed message=${(err as Error).message}`
      );
    }
  }
  return sent;
}

// Open / click counters — wired by the notification webhook /
// app-side click tracker. Pure counters here; dispatch lives elsewhere.
export function recordAlertOpened(signalId: string): void {
  _alertMetrics.opened++;
  console.log(`[LL_ALERT_OPENED] signalId=${signalId}`);
}

export function recordAlertClicked(signalId: string): void {
  _alertMetrics.clicked++;
  console.log(`[LL_ALERT_CLICKED] signalId=${signalId}`);
}

// ── Drainer boot ─────────────────────────────────────────────────────
let _drainTimer: ReturnType<typeof setInterval> | null = null;
export function startAlertDrainer(intervalMs: number = 5 * 1000): void {
  if (_drainTimer) return;
  _drainTimer = setInterval(() => {
    drainAlertQueue().catch((e) =>
      console.warn(`[LL_ALERT_SUPPRESSED] drain error: ${(e as Error).message}`)
    );
  }, intervalMs);
  if (typeof _drainTimer.unref === "function") _drainTimer.unref();
  console.log(`[LL_ALERT_QUEUED] alert drainer started intervalMs=${intervalMs}`);
}

export function _resetAlertSubscriberForTests() {
  _queue.length = 0;
  _dedupe.clear();
  _alertMetrics.queued = 0;
  _alertMetrics.sent = 0;
  _alertMetrics.suppressed = 0;
  _alertMetrics.deduped = 0;
  _alertMetrics.opened = 0;
  _alertMetrics.clicked = 0;
  _alertMetrics.byTrigger = {};
  _alertMetrics.byState = {};
  if (_drainTimer) {
    clearInterval(_drainTimer);
    _drainTimer = null;
  }
}
