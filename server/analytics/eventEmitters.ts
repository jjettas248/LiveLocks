// LiveLocks Batch E — Analytics event emitters.
//
// Thin helpers that translate runtime objects (CanonicalSignal,
// shadow records, HR Radar transitions, alert envelopes) into
// AnalyticsEvent rows. These are the ONLY callers of
// recordAnalyticsEvent from outside the analytics dir.
//
// HARD RULE: emitters are read-only. They build a new AnalyticsEvent
// from already-immutable runtime fields and append it to the in-memory
// store. They never touch probability / signalTier / lifecycleState /
// drivers / SignalBus.

import type { CanonicalSignal } from "../../shared/canonicalSignal";
import { recordAnalyticsEvent, type AnalyticsEventType } from "./analyticsEvent";

function safeDriverLabels(c: CanonicalSignal): string[] | undefined {
  if (!Array.isArray(c.drivers) || c.drivers.length === 0) return undefined;
  return c.drivers.map((d) => d.label).filter((s): s is string => typeof s === "string");
}

function fromCanonical(
  c: CanonicalSignal,
  eventType: AnalyticsEventType,
  extras: Partial<{
    alertType: string;
    outcome: string;
    odds: number | null;
    fromStage: string;
    toStage: string;
    reason: string;
    shadowQualified: boolean;
  }> = {},
): void {
  try {
    recordAnalyticsEvent({
      eventType,
      signalId: c.signalId,
      sport: c.sport,
      gameId: c.gameId,
      playerId: c.actorId,
      market: c.market,
      side: c.side,
      signalTier: c.signalTier ?? null,
      lifecycleState: c.lifecycleState ?? null,
      drivers: safeDriverLabels(c),
      edge: c.edge ?? null,
      probability: c.displayProbability ?? null,
      signalScore: c.signalScore ?? null,
      ...extras,
    });
  } catch (err: any) {
    // Analytics MUST NEVER break runtime. Swallow + log once.
    console.warn(
      `[LL_ANALYTICS_EVENT] emit failed type=${eventType} signalId=${c?.signalId ?? "?"} err=${err?.message ?? err}`,
    );
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────
export type LifecycleEmissionKind =
  | "created"
  | "upgraded"
  | "downgraded"
  | "cashed"
  | "missed"
  | "expired";

const LIFECYCLE_TYPE_MAP: Record<LifecycleEmissionKind, AnalyticsEventType> = {
  created: "signal_created",
  upgraded: "signal_upgraded",
  downgraded: "signal_downgraded",
  cashed: "signal_cashed",
  missed: "signal_missed",
  expired: "signal_expired",
};

export function emitLifecycleEvent(
  c: CanonicalSignal,
  kind: LifecycleEmissionKind,
  reason?: string,
): void {
  fromCanonical(c, LIFECYCLE_TYPE_MAP[kind], { reason });
}

// ── Alerts ────────────────────────────────────────────────────────────
export function emitAlertEvent(
  c: CanonicalSignal,
  eventType: "alert_queued" | "alert_sent" | "alert_opened" | "alert_clicked",
  alertType?: string,
): void {
  fromCanonical(c, eventType, alertType ? { alertType } : {});
}

// ── Shadow qualification ──────────────────────────────────────────────
export function emitShadowEvent(args: {
  signalId: string;
  gameId: string;
  playerId: string;
  market: string;
  side: "OVER" | "UNDER";
  outcome: "created" | "cashed" | "missed";
  signalTier?: "watch" | "lean" | "strong" | "elite" | null;
  signalScore?: number | null;
  probability?: number | null;
}): void {
  try {
    const map: Record<typeof args.outcome, AnalyticsEventType> = {
      created: "shadow_signal_created",
      cashed: "shadow_signal_cashed",
      missed: "shadow_signal_missed",
    };
    recordAnalyticsEvent({
      eventType: map[args.outcome],
      signalId: args.signalId,
      sport: "mlb",
      gameId: args.gameId,
      playerId: args.playerId,
      market: args.market,
      side: args.side,
      signalTier: args.signalTier ?? null,
      lifecycleState: null,
      shadowQualified: true,
      outcome: args.outcome,
      probability: args.probability ?? null,
      signalScore: args.signalScore ?? null,
    });
  } catch (err: any) {
    console.warn(`[LL_ANALYTICS_EVENT] shadow emit failed err=${err?.message ?? err}`);
  }
}

// ── HR Radar miss tracing / lead-time (recall measurement) ─────────────
export function emitHrRadarMissTrace(args: {
  signalId: string;
  gameId: string;
  playerId: string;
  gradingStatus: string;
  blockedGate: string;
  strongContact: boolean;
  drivers?: string[];
  probability?: number | null;
}): void {
  try {
    recordAnalyticsEvent({
      eventType: "hr_radar_miss_trace",
      signalId: args.signalId,
      sport: "mlb",
      gameId: args.gameId,
      playerId: args.playerId,
      market: "home_runs",
      side: "OVER",
      signalTier: null,
      lifecycleState: null,
      outcome: args.gradingStatus,
      blockedGate: args.blockedGate,
      strongContact: args.strongContact,
      drivers: args.drivers,
      probability: args.probability ?? null,
    });
  } catch (err: any) {
    console.warn(`[LL_ANALYTICS_EVENT] hr_radar_miss_trace emit failed err=${err?.message ?? err}`);
  }
}

export function emitCalledHitLeadTime(args: {
  signalId: string;
  gameId: string;
  playerId: string;
  // null when the called hit has no clean (positive, finite) lead time — the
  // hit still counts toward recall but is excluded from the lead-time distribution.
  leadTimeMs: number | null;
  alertPath?: string | null;
}): void {
  try {
    const cleanLead =
      typeof args.leadTimeMs === "number" && Number.isFinite(args.leadTimeMs) && args.leadTimeMs > 0
        ? args.leadTimeMs
        : undefined;
    recordAnalyticsEvent({
      eventType: "hr_radar_called_hit_lead",
      signalId: args.signalId,
      sport: "mlb",
      gameId: args.gameId,
      playerId: args.playerId,
      market: "home_runs",
      side: "OVER",
      signalTier: null,
      lifecycleState: null,
      leadTimeMs: cleanLead,
      reason: args.alertPath ?? undefined,
    });
  } catch (err: any) {
    console.warn(`[LL_ANALYTICS_EVENT] hr_radar_called_hit_lead emit failed err=${err?.message ?? err}`);
  }
}

// ── HR Radar stage transitions ────────────────────────────────────────
export function emitHrRadarTransition(args: {
  signalId: string;
  gameId: string;
  playerId: string;
  fromStage: string;
  toStage: string;
  // Additive precision/recall fields — no-op when absent (older callers).
  signalPath?: string | null;
  score10?: number | null;
}): void {
  try {
    recordAnalyticsEvent({
      eventType: "hr_radar_transition",
      signalId: args.signalId,
      sport: "mlb",
      gameId: args.gameId,
      playerId: args.playerId,
      market: "home_runs",
      side: "OVER",
      signalTier: null,
      lifecycleState: null,
      fromStage: args.fromStage,
      toStage: args.toStage,
      ...(args.signalPath ? { signalPath: args.signalPath } : {}),
      ...(typeof args.score10 === "number" && Number.isFinite(args.score10) ? { score10: args.score10 } : {}),
    });
  } catch (err: any) {
    console.warn(`[LL_ANALYTICS_EVENT] hr_radar emit failed err=${err?.message ?? err}`);
  }
}

// ── HR Radar terminal outcome (precision measurement) ──────────────────
// Emits the canonical hr_radar_cashed / hr_radar_missed events at the HR
// grading boundary. These event types were declared but never emitted, so
// every precision rollup that depended on them (falseFireRate, fireToCashed,
// per-path false-positive rate) was silently empty. Read-only analytics tap.
//
//   kind="cashed"  → the tracked player hit a HR after a real call (called_hit)
//   kind="missed"  → the player did NOT HR while we tracked them (called_miss)
//
// `late_signal` is intentionally NOT routed here — it is an uncalled/late HR
// (a recall miss, not a precision miss) and is already captured by the
// miss-tracer. Mixing it into hr_radar_missed would understate precision.
export function emitHrRadarOutcome(args: {
  signalId: string;
  gameId: string;
  playerId: string;
  kind: "cashed" | "missed";
  signalPath?: string | null;
  score10?: number | null;
  finalStage?: string | null;
  gradingStatus?: string | null;
}): void {
  try {
    recordAnalyticsEvent({
      eventType: args.kind === "cashed" ? "hr_radar_cashed" : "hr_radar_missed",
      signalId: args.signalId,
      sport: "mlb",
      gameId: args.gameId,
      playerId: args.playerId,
      market: "home_runs",
      side: "OVER",
      signalTier: null,
      lifecycleState: null,
      outcome: args.gradingStatus ?? args.kind,
      ...(args.signalPath ? { signalPath: args.signalPath } : {}),
      ...(typeof args.score10 === "number" && Number.isFinite(args.score10) ? { score10: args.score10 } : {}),
      ...(args.finalStage ? { finalStage: args.finalStage } : {}),
    });
  } catch (err: any) {
    console.warn(`[LL_ANALYTICS_EVENT] hr_radar_outcome emit failed err=${err?.message ?? err}`);
  }
}
