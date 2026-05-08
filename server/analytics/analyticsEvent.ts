// LiveLocks Batch E — Canonical Analytics Event Model
//
// Single contract for every analytics event the platform observes.
// HARD RULE: analytics is read-only. recordAnalyticsEvent() must NEVER
// mutate runtime state. It only appends to an in-memory ring buffer and
// is consumed by the aggregators in this same directory.

import type { Sport } from "../../shared/canonicalSignal";
import { MLB_GOLDMASTER_VERSION } from "../mlb/goldmasterGuard";

export type AnalyticsEventType =
  | "signal_created"
  | "signal_upgraded"
  | "signal_downgraded"
  | "signal_expired"
  | "signal_cashed"
  | "signal_missed"
  | "alert_queued"
  | "alert_sent"
  | "alert_opened"
  | "alert_clicked"
  | "shadow_signal_created"
  | "shadow_signal_cashed"
  | "shadow_signal_missed"
  | "hr_radar_transition"
  | "hr_radar_cashed"
  | "hr_radar_missed";

export interface AnalyticsEvent {
  // Required envelope
  eventId: string;
  eventType: AnalyticsEventType;
  signalId: string;
  sport: Sport | "mlb" | "nba" | "ncaab";
  gameId: string;
  playerId: string;
  market: string;
  side: "OVER" | "UNDER" | "n/a";
  signalTier: "watch" | "lean" | "strong" | "elite" | null;
  lifecycleState: string | null;
  engineVersion: string;
  calibrationVersion: string;
  timestamp: number;

  // Optional payload
  drivers?: string[];
  alertType?: string;
  shadowQualified?: boolean;
  outcome?: string;
  odds?: number | null;
  edge?: number | null;
  probability?: number | null;
  signalScore?: number | null;

  // HR Radar / shadow stage transitions
  fromStage?: string;
  toStage?: string;
  reason?: string;
}

// ── Engine + calibration versioning ────────────────────────────────
// MLB engine + calibration version is the goldmaster lock string.
// NBA/NCAAB engines emit their own analytics with their own version
// strings if/when they adopt this contract — Batch E ships MLB-only.
export const ENGINE_VERSION = MLB_GOLDMASTER_VERSION;
export const CALIBRATION_VERSION = MLB_GOLDMASTER_VERSION;

// ── In-memory ring buffer ──────────────────────────────────────────
// Single global store. Bounded so the process never runs away. The
// aggregators in this directory window it down further by sport / type
// / time as needed.
const MAX_EVENTS = 50_000;
const _store: AnalyticsEvent[] = [];
let _seq = 0;

export function recordAnalyticsEvent(
  partial: Omit<
    AnalyticsEvent,
    "eventId" | "timestamp" | "engineVersion" | "calibrationVersion"
  > &
    Partial<Pick<AnalyticsEvent, "timestamp" | "engineVersion" | "calibrationVersion">>,
): AnalyticsEvent {
  const evt: AnalyticsEvent = {
    eventId: `${++_seq}-${Date.now().toString(36)}`,
    timestamp: partial.timestamp ?? Date.now(),
    engineVersion: partial.engineVersion ?? ENGINE_VERSION,
    calibrationVersion: partial.calibrationVersion ?? CALIBRATION_VERSION,
    ...partial,
  } as AnalyticsEvent;

  _store.push(evt);
  if (_store.length > MAX_EVENTS) {
    _store.splice(0, _store.length - MAX_EVENTS);
  }
  return evt;
}

export interface AnalyticsEventFilter {
  sport?: string;
  eventType?: AnalyticsEventType | AnalyticsEventType[];
  signalId?: string;
  gameId?: string;
  playerId?: string;
  sinceMs?: number;
  limit?: number;
}

export function getAnalyticsEvents(filter: AnalyticsEventFilter = {}): AnalyticsEvent[] {
  const since = filter.sinceMs ?? 0;
  const types = Array.isArray(filter.eventType)
    ? new Set(filter.eventType)
    : filter.eventType
      ? new Set([filter.eventType])
      : null;

  const out: AnalyticsEvent[] = [];
  for (const e of _store) {
    if (filter.sport && e.sport !== filter.sport) continue;
    if (types && !types.has(e.eventType)) continue;
    if (filter.signalId && e.signalId !== filter.signalId) continue;
    if (filter.gameId && e.gameId !== filter.gameId) continue;
    if (filter.playerId && e.playerId !== filter.playerId) continue;
    if (e.timestamp < since) continue;
    out.push(e);
  }
  if (filter.limit && filter.limit > 0) {
    return out.slice(-filter.limit);
  }
  return out;
}

export function getAnalyticsBufferSize(): number {
  return _store.length;
}

export function _resetAnalyticsForTests(): void {
  _store.length = 0;
  _seq = 0;
}
