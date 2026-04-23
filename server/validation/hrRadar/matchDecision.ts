/**
 * Pure decision helper extracted from `matchHrRadarAlertToHrEvent` so the
 * called_hit / timestamp-rescue / late_signal branch can be unit-tested
 * without a live database. The matcher in `server/storage.ts` performs the
 * DB lookups and then defers all classification to this function.
 *
 * Invariants encoded here mirror the Goldmaster Detection Ledger (Phase 5+
 * RC5 strict matcher and Task #122 timestamp-rescue):
 *
 *  1. A qualifying signal event row that strictly precedes hrEnd AND a
 *     row that has crossed out of WATCH (detectedInning != null) ⇒ called_hit.
 *  2. Otherwise, if the persisted signalDetectedAt timestamp on the alert
 *     row strictly precedes hrEnd by more than TICK_TOLERANCE_MS ⇒
 *     called_hit (timestamp-rescue).
 *  3. Otherwise the alert exists but its detection moment is at or after
 *     the HR ⇒ late_signal.
 */

export const TICK_TOLERANCE_MS = 2000;

export const QUALIFYING_EVENT_TYPES: string[] = [
  "qualified_detected",
  "promoted_building",
  "promoted_attack",
  "stage_building",
  "stage_attack",
  "escalated",
];

export interface MatchDecisionAlert {
  id: string;
  signalDetectedAt: Date | null;
  detectedAt: Date;
  signalInning: number | null;
  signalHalf: string | null;
  detectedInning: number | null;
  detectedHalf: string | null;
}

export interface MatchDecisionQualifyingEvent {
  id: number | null;
  eventType: string;
  detectedAt: Date;
  inning: number | null;
  half: string | null;
}

export interface MatchDecisionResult {
  matched: boolean;
  matchedBeforeHr: boolean;
  isLateSignal: boolean;
  alertId: string | null;
  signalEventId: number | null;
  signalDetectedAt: Date | null;
  signalInning: number | null;
  signalHalf: string | null;
  gradingStatus: "called_hit" | "uncalled_hr" | "late_signal";
  gradingReason: string;
  matchMethod: "direct_pre_hr_signal" | "post_hr_fallback" | "player_game_only" | "none";
}

/**
 * Decide the grading outcome given the alert row, the most recent qualifying
 * pre-HR signal event (if any), and the HR endTime in epoch ms.
 *
 * This function does NOT handle the "no alert row exists" case — the caller
 * is responsible for the early_hr_no_window / uncalled_hr branches because
 * those decisions depend on extra DB lookups.
 */
export function decideHrRadarMatch(input: {
  alert: MatchDecisionAlert;
  lastQualifyingEvent: MatchDecisionQualifyingEvent | null;
  hrEnd: number | null;
}): MatchDecisionResult {
  const { alert, lastQualifyingEvent, hrEnd } = input;

  const signalDetectedMs =
    alert.signalDetectedAt?.getTime() ?? alert.detectedAt.getTime();
  const rowEverQualified = alert.detectedInning != null;

  // Branch 1 — strict qualifying event + row crossed out of WATCH.
  if (lastQualifyingEvent && rowEverQualified) {
    return {
      matched: true,
      matchedBeforeHr: true,
      isLateSignal: false,
      alertId: alert.id,
      signalEventId: lastQualifyingEvent.id ?? null,
      signalDetectedAt:
        alert.signalDetectedAt ?? alert.detectedAt ?? lastQualifyingEvent.detectedAt,
      signalInning: alert.signalInning ?? alert.detectedInning ?? lastQualifyingEvent.inning,
      signalHalf: alert.signalHalf ?? alert.detectedHalf ?? lastQualifyingEvent.half,
      gradingStatus: "called_hit",
      gradingReason: `qualifying signal event ${lastQualifyingEvent.eventType} at ${new Date(lastQualifyingEvent.detectedAt).toISOString()} strictly preceded HR endTime; row qualified at ${alert.detectedHalf}${alert.detectedInning}`,
      matchMethod: "direct_pre_hr_signal",
    };
  }

  // Branch 2 — Task #122 timestamp-rescue. Persisted signalDetectedAt
  // strictly precedes hrEnd by more than a single engine tick.
  if (
    hrEnd != null &&
    Number.isFinite(signalDetectedMs) &&
    hrEnd - signalDetectedMs > TICK_TOLERANCE_MS
  ) {
    return {
      matched: true,
      matchedBeforeHr: true,
      isLateSignal: false,
      alertId: alert.id,
      signalEventId: lastQualifyingEvent?.id ?? null,
      signalDetectedAt: alert.signalDetectedAt ?? alert.detectedAt,
      signalInning: alert.signalInning ?? alert.detectedInning,
      signalHalf: alert.signalHalf ?? alert.detectedHalf,
      gradingStatus: "called_hit",
      gradingReason: `signalDetectedAt ${new Date(signalDetectedMs).toISOString()} strictly precedes HR endTime ${new Date(hrEnd).toISOString()} by ${hrEnd - signalDetectedMs}ms (timestamp-rescue: no qualifying event row, but persisted signal timestamp is authoritative)`,
      matchMethod: "direct_pre_hr_signal",
    };
  }

  // Branch 3 — late_signal fallback.
  return {
    matched: true,
    matchedBeforeHr: false,
    isLateSignal: true,
    alertId: alert.id,
    signalEventId: null,
    signalDetectedAt: alert.signalDetectedAt ?? alert.detectedAt,
    signalInning: alert.signalInning ?? alert.detectedInning,
    signalHalf: alert.signalHalf ?? alert.detectedHalf,
    gradingStatus: "late_signal",
    gradingReason: `signal detectedAt ${new Date(signalDetectedMs).toISOString()} occurred at or after HR endTime ${hrEnd != null ? new Date(hrEnd).toISOString() : "(unknown)"}`,
    matchMethod: "post_hr_fallback",
  };
}
