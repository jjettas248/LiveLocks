// Mound Radar V2 (shadow) — reconciliation eligibility policy + grading
// coverage reporting (Correction 3). Pure: no storage, no dataPullService,
// no I/O of any kind — fully unit-testable without a database. The
// storage/network-touching sweep built on top of these functions lives in
// the sibling moundV2ShadowReconciliationSweep.ts (same pure/impure split as
// moundV2ShadowGrading.ts / moundV2ShadowGradingSweep.ts).
//
// WHY this exists: moundV2ShadowGradingSweep.ts's routine grading sweep is
// deliberately, permanently passive — it only ever reads whatever
// mlbGameCache.gamePitchingBoxScore already holds (see that file's own
// header). That is the CORRECT default (zero extra provider calls on every
// 5-minute tick), but it means a prediction for a game the live orchestrator
// has since stopped tracking (or never tracked at all — e.g. the flag was
// off, or a restart lost the in-memory live registry) can stay
// settlementStatus="pending" forever, with nothing ever prompting a fresh
// box-score fetch. This module defines the BOUNDED backstop policy for that
// tail case: how to decide a row is old enough to actively re-check, how
// hard to back off between attempts, when to stop escalating a postponed
// game, and how to report the resulting coverage gap honestly.
//
// Every "reason" a row is or isn't eligible is a real, named branch — never
// a boolean with no explanation. Every constant below is deliberately
// generous (biased toward NOT re-fetching) because active reconciliation
// costs a real MLB Stats API call; the passive sweep remains the first,
// preferred, free path for every ordinary game.

import type { MoundV2GradingGameStatus } from "./moundV2ShadowGrading";

export const MOUND_V2_RECONCILIATION_POLICY = {
  /**
   * A pregame build runs hours before first pitch; essentially every real
   * MLB game (including extras and an in-game delay) is decided within this
   * window of its scheduled first pitch. Below this age, "still pending" is
   * the expected, healthy state — never attempt reconciliation this early.
   */
  ELIGIBLE_AFTER_SCHEDULED_MS: 5 * 60 * 60 * 1000,
  /**
   * Legacy rows captured before scheduledGameTime existed (or a slate whose
   * schedule genuinely never supplied a start time) have no real anchor at
   * all. Fall back to the always-present build-time timestamp with a much
   * wider buffer, since build time can precede first pitch by anywhere from
   * minutes to most of a day.
   */
  ELIGIBLE_AFTER_EVALUATION_FALLBACK_MS: 14 * 60 * 60 * 1000,
  /** Exponential backoff base — doubles per attempt, capped by MAX_COOLDOWN_MS. */
  BASE_COOLDOWN_MS: 30 * 60 * 1000,
  MAX_COOLDOWN_MS: 6 * 60 * 60 * 1000,
  /**
   * Once a fetch has confirmed the game is postponed/suspended, a flat,
   * much longer cooldown applies REGARDLESS of attempt-count backoff — a
   * suspended game can sit for days, and re-checking it on the ordinary
   * exponential schedule would still eventually hammer it every 6h.
   */
  POSTPONED_COOLDOWN_MS: 12 * 60 * 60 * 1000,
  /** Bounded retries — beyond this, a row is a reporting concern, not something to keep re-fetching forever. */
  MAX_ATTEMPTS: 20,
  /** Beyond this age, a still-pending row is a genuine operational concern — reported distinctly from ordinary in-window pending rows. */
  ALERT_AFTER_MS: 24 * 60 * 60 * 1000,
  /** Bounds worst-case provider-call volume in a single sweep tick — never an unbounded fan-out. */
  MAX_GAMES_PER_SWEEP: 10,
  /** Caps the detail list returned by the coverage report — staleAlertCount itself is never truncated. */
  MAX_STALE_ALERTS_RETURNED: 50,
} as const;

export interface MoundV2ReconciliationRow {
  predictionId: string;
  gameId: string;
  pitcherId: string;
  settlementStatus: string;
  scheduledGameTime: Date | null;
  evaluationTimestamp: Date;
  reconciliationAttemptCount: number;
  lastReconciliationAttemptAt: Date | null;
  lastReconciliationFailureReason: string | null;
  /** Current live-cache classification for this row's game, if ever checked. undefined/null means "never checked yet" — never assumed final or postponed. */
  lastKnownStatus?: MoundV2GradingGameStatus | null;
}

export interface MoundV2ReconciliationReferenceTime {
  referenceTime: Date;
  eligibleAfterMs: number;
  source: "scheduled" | "evaluation_fallback";
}

/** Which timestamp anchors "how old is this pending row", and how long to wait from it before ever attempting reconciliation. Prefers the real scheduled first pitch; falls back to build time only when genuinely absent. */
export function computeReconciliationReferenceTime(
  row: Pick<MoundV2ReconciliationRow, "scheduledGameTime" | "evaluationTimestamp">,
): MoundV2ReconciliationReferenceTime {
  if (row.scheduledGameTime) {
    return {
      referenceTime: row.scheduledGameTime,
      eligibleAfterMs: MOUND_V2_RECONCILIATION_POLICY.ELIGIBLE_AFTER_SCHEDULED_MS,
      source: "scheduled",
    };
  }
  return {
    referenceTime: row.evaluationTimestamp,
    eligibleAfterMs: MOUND_V2_RECONCILIATION_POLICY.ELIGIBLE_AFTER_EVALUATION_FALLBACK_MS,
    source: "evaluation_fallback",
  };
}

/** Exponential backoff: attempt 0 -> 30min, 1 -> 1h, 2 -> 2h, 3 -> 4h, 4+ -> capped at 6h. */
export function computeReconciliationCooldownMs(attemptCount: number): number {
  const exp = MOUND_V2_RECONCILIATION_POLICY.BASE_COOLDOWN_MS * Math.pow(2, Math.max(0, attemptCount));
  return Math.min(exp, MOUND_V2_RECONCILIATION_POLICY.MAX_COOLDOWN_MS);
}

export type MoundV2ReconciliationEligibilityReason =
  | "eligible"
  | "not_pending"
  | "max_attempts_reached"
  | "too_soon"
  | "cooldown"
  | "postponed_cooldown";

export interface MoundV2ReconciliationEligibility {
  eligible: boolean;
  reason: MoundV2ReconciliationEligibilityReason;
  referenceTimeSource: "scheduled" | "evaluation_fallback";
  ageMs: number;
}

/**
 * The single decision function every reconciliation call site funnels
 * through (mirrors computeMoundV2GradingDecision's role for routine
 * grading). Never throws — always returns a real, named reason.
 */
export function isReconciliationEligible(row: MoundV2ReconciliationRow, now: Date): MoundV2ReconciliationEligibility {
  const { referenceTime, eligibleAfterMs, source } = computeReconciliationReferenceTime(row);
  const ageMs = now.getTime() - referenceTime.getTime();

  if (row.settlementStatus !== "pending") {
    return { eligible: false, reason: "not_pending", referenceTimeSource: source, ageMs };
  }
  if (row.reconciliationAttemptCount >= MOUND_V2_RECONCILIATION_POLICY.MAX_ATTEMPTS) {
    return { eligible: false, reason: "max_attempts_reached", referenceTimeSource: source, ageMs };
  }
  if (ageMs < eligibleAfterMs) {
    return { eligible: false, reason: "too_soon", referenceTimeSource: source, ageMs };
  }
  if (row.lastKnownStatus === "postponed_or_suspended" && row.lastReconciliationAttemptAt) {
    const sinceLastMs = now.getTime() - row.lastReconciliationAttemptAt.getTime();
    if (sinceLastMs < MOUND_V2_RECONCILIATION_POLICY.POSTPONED_COOLDOWN_MS) {
      return { eligible: false, reason: "postponed_cooldown", referenceTimeSource: source, ageMs };
    }
    return { eligible: true, reason: "eligible", referenceTimeSource: source, ageMs };
  }
  if (row.lastReconciliationAttemptAt) {
    const sinceLastMs = now.getTime() - row.lastReconciliationAttemptAt.getTime();
    const cooldownMs = computeReconciliationCooldownMs(row.reconciliationAttemptCount);
    if (sinceLastMs < cooldownMs) {
      return { eligible: false, reason: "cooldown", referenceTimeSource: source, ageMs };
    }
  }
  return { eligible: true, reason: "eligible", referenceTimeSource: source, ageMs };
}

// ─────────────────────────────────────────────────────────────────────────
// Pure: grading coverage report
// ─────────────────────────────────────────────────────────────────────────

export interface MoundV2StaleAlertEntry {
  predictionId: string;
  gameId: string;
  pitcherId: string;
  ageMs: number;
  reconciliationAttemptCount: number;
}

export interface MoundV2GradingCoverageReport {
  totalRows: number;
  gradedOrVoidedCount: number;
  pendingCount: number;
  /** null (never 0) when totalRows is 0 — a rate with no denominator is not a real 0%. */
  gradingCoverageRatio: number | null;
  /** Pending rows already past their own reconciliation-eligible age — "should have resolved by now" by construction, independent of whether reconciliation actually ran. */
  pendingPastEligibleWindowCount: number;
  oldestPendingPrediction: { predictionId: string; gameId: string; pitcherId: string; ageMs: number } | null;
  /** Full count of pending rows older than ALERT_AFTER_MS — never truncated even though the detail list below is capped. */
  staleAlertCount: number;
  /** Oldest-first, capped at MAX_STALE_ALERTS_RETURNED. */
  staleAlerts: MoundV2StaleAlertEntry[];
  /** Pending rows whose most recent reconciliation attempt recorded a real failure reason (provider error), not merely "still not final". */
  providerFailureCount: number;
  /** Distinct pitcherIds still pending past their own eligible window. */
  unresolvedPitcherIds: string[];
  /** Pending rows whose last known live-cache classification is postponed/suspended. */
  suspendedOrPostponedCount: number;
}

/**
 * Builds the Correction-3-required coverage report from whatever rows the
 * caller supplies — deliberately takes plain data (no storage import), so
 * it's testable with hand-built fixtures. The impure gatherer in
 * moundV2ShadowReconciliationSweep.ts is the only thing that actually lists
 * real rows from the database and calls this.
 */
export function buildMoundV2GradingCoverageReport(rows: MoundV2ReconciliationRow[], now: Date): MoundV2GradingCoverageReport {
  const totalRows = rows.length;
  const pending = rows.filter((r) => r.settlementStatus === "pending");
  const gradedOrVoidedCount = totalRows - pending.length;
  const gradingCoverageRatio = totalRows === 0 ? null : gradedOrVoidedCount / totalRows;

  const pendingWithAge = pending.map((r) => {
    const { referenceTime, eligibleAfterMs } = computeReconciliationReferenceTime(r);
    return { row: r, ageMs: now.getTime() - referenceTime.getTime(), eligibleAfterMs };
  });

  const pastEligibleWindow = pendingWithAge.filter((r) => r.ageMs >= r.eligibleAfterMs);

  let oldest: (typeof pendingWithAge)[number] | null = null;
  for (const r of pendingWithAge) {
    if (!oldest || r.ageMs > oldest.ageMs) oldest = r;
  }
  const oldestPendingPrediction: MoundV2GradingCoverageReport["oldestPendingPrediction"] = oldest
    ? { predictionId: oldest.row.predictionId, gameId: oldest.row.gameId, pitcherId: oldest.row.pitcherId, ageMs: oldest.ageMs }
    : null;

  const staleAlertRows = pendingWithAge
    .filter((r) => r.ageMs >= MOUND_V2_RECONCILIATION_POLICY.ALERT_AFTER_MS)
    .sort((a, b) => b.ageMs - a.ageMs);
  const staleAlerts: MoundV2StaleAlertEntry[] = staleAlertRows
    .slice(0, MOUND_V2_RECONCILIATION_POLICY.MAX_STALE_ALERTS_RETURNED)
    .map((r) => ({
      predictionId: r.row.predictionId,
      gameId: r.row.gameId,
      pitcherId: r.row.pitcherId,
      ageMs: r.ageMs,
      reconciliationAttemptCount: r.row.reconciliationAttemptCount,
    }));

  const providerFailureCount = pending.filter((r) => r.lastReconciliationFailureReason != null).length;
  const unresolvedPitcherIds = Array.from(new Set(pastEligibleWindow.map((r) => r.row.pitcherId)));
  const suspendedOrPostponedCount = pending.filter((r) => r.lastKnownStatus === "postponed_or_suspended").length;

  return {
    totalRows,
    gradedOrVoidedCount,
    pendingCount: pending.length,
    gradingCoverageRatio,
    pendingPastEligibleWindowCount: pastEligibleWindow.length,
    oldestPendingPrediction,
    staleAlertCount: staleAlertRows.length,
    staleAlerts,
    providerFailureCount,
    unresolvedPitcherIds,
    suspendedOrPostponedCount,
  };
}
