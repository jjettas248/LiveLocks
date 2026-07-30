// Mound V2 shadow reconciliation policy — invariants (Correction 3). Pure —
// no database, no network.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ShadowReconciliation.test.ts

import {
  isReconciliationEligible,
  computeReconciliationCooldownMs,
  computeReconciliationReferenceTime,
  buildMoundV2GradingCoverageReport,
  MOUND_V2_RECONCILIATION_POLICY,
  type MoundV2ReconciliationRow,
} from "./moundV2ShadowReconciliation";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const NOW = new Date("2026-07-30T12:00:00.000Z");
function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000);
}

function baseRow(overrides: Partial<MoundV2ReconciliationRow> = {}): MoundV2ReconciliationRow {
  return {
    predictionId: "pred_1",
    gameId: "game_1",
    pitcherId: "pitcher_1",
    settlementStatus: "pending",
    scheduledGameTime: hoursAgo(6),
    evaluationTimestamp: hoursAgo(10),
    reconciliationAttemptCount: 0,
    lastReconciliationAttemptAt: null,
    lastReconciliationFailureReason: null,
    lastKnownStatus: null,
    ...overrides,
  };
}

// ── computeReconciliationReferenceTime ──────────────────────────────────────
{
  const withSchedule = computeReconciliationReferenceTime({ scheduledGameTime: hoursAgo(3), evaluationTimestamp: hoursAgo(10) });
  ok(withSchedule.source === "scheduled" && withSchedule.eligibleAfterMs === MOUND_V2_RECONCILIATION_POLICY.ELIGIBLE_AFTER_SCHEDULED_MS, "a real scheduledGameTime is preferred and gets the SCHEDULED (tighter) eligibility window");

  const legacy = computeReconciliationReferenceTime({ scheduledGameTime: null, evaluationTimestamp: hoursAgo(10) });
  ok(legacy.source === "evaluation_fallback" && legacy.eligibleAfterMs === MOUND_V2_RECONCILIATION_POLICY.ELIGIBLE_AFTER_EVALUATION_FALLBACK_MS, "a null scheduledGameTime (legacy row) falls back to evaluationTimestamp with a WIDER, more conservative window");
  ok(legacy.eligibleAfterMs > withSchedule.eligibleAfterMs, "the legacy fallback window is strictly more conservative than the real-schedule window");
}

// ── computeReconciliationCooldownMs: exponential backoff, capped ───────────
{
  const c0 = computeReconciliationCooldownMs(0);
  const c1 = computeReconciliationCooldownMs(1);
  const c2 = computeReconciliationCooldownMs(2);
  ok(c0 === MOUND_V2_RECONCILIATION_POLICY.BASE_COOLDOWN_MS, `attempt 0 cooldown is the base (got ${c0})`);
  ok(c1 === c0 * 2, "attempt 1 cooldown doubles attempt 0's");
  ok(c2 === c0 * 4, "attempt 2 cooldown doubles again (true exponential growth)");
  const cHigh = computeReconciliationCooldownMs(50);
  ok(cHigh === MOUND_V2_RECONCILIATION_POLICY.MAX_COOLDOWN_MS, `an absurdly high attempt count is capped at MAX_COOLDOWN_MS, never grows unbounded (got ${cHigh})`);
  const cNeg = computeReconciliationCooldownMs(-5);
  ok(cNeg === c0, "a negative attempt count (should never happen, but never trusted blindly) clamps to attempt 0's cooldown, never a shorter-than-base or NaN cooldown");
}

// ── isReconciliationEligible: not_pending short-circuits everything else ───
{
  const v = isReconciliationEligible(baseRow({ settlementStatus: "graded", scheduledGameTime: hoursAgo(100) }), NOW);
  ok(!v.eligible && v.reason === "not_pending", "an already-graded row is never eligible, regardless of age");
}

// ── too_soon: below the eligibility window ──────────────────────────────────
{
  const v = isReconciliationEligible(baseRow({ scheduledGameTime: hoursAgo(2) }), NOW);
  ok(!v.eligible && v.reason === "too_soon", "a game scheduled only 2h ago is too soon to reconcile (5h window)");
}
{
  const v = isReconciliationEligible(baseRow({ scheduledGameTime: hoursAgo(6) }), NOW);
  ok(v.eligible && v.reason === "eligible", "a game scheduled 6h ago (past the 5h window) with no prior attempt is eligible");
}

// ── legacy fallback window applies when scheduledGameTime is null ──────────
{
  const v = isReconciliationEligible(baseRow({ scheduledGameTime: null, evaluationTimestamp: hoursAgo(6) }), NOW);
  ok(!v.eligible && v.reason === "too_soon", "a legacy row (no scheduledGameTime) 6h past build time is still too soon under the WIDER 14h fallback window");
}
{
  const v = isReconciliationEligible(baseRow({ scheduledGameTime: null, evaluationTimestamp: hoursAgo(15) }), NOW);
  ok(v.eligible, "a legacy row 15h past build time clears the 14h fallback window");
}

// ── max_attempts_reached ────────────────────────────────────────────────────
{
  const v = isReconciliationEligible(baseRow({ reconciliationAttemptCount: MOUND_V2_RECONCILIATION_POLICY.MAX_ATTEMPTS }), NOW);
  ok(!v.eligible && v.reason === "max_attempts_reached", "a row at the max attempt count is never eligible again, however old it gets");
}

// ── cooldown: recent attempt blocks a retry until backoff elapses ──────────
{
  const v = isReconciliationEligible(baseRow({ reconciliationAttemptCount: 1, lastReconciliationAttemptAt: hoursAgo(0.5) }), NOW);
  // attempt 1 -> 1h cooldown; only 30 min have passed
  ok(!v.eligible && v.reason === "cooldown", "a retry 30 minutes after attempt #1 (1h cooldown) is blocked");
}
{
  const v = isReconciliationEligible(baseRow({ reconciliationAttemptCount: 1, lastReconciliationAttemptAt: hoursAgo(1.5) }), NOW);
  ok(v.eligible, "a retry 90 minutes after attempt #1 (1h cooldown) is allowed");
}

// ── postponed_cooldown overrides the ordinary exponential schedule ─────────
{
  const v = isReconciliationEligible(baseRow({
    reconciliationAttemptCount: 1,
    lastReconciliationAttemptAt: hoursAgo(2), // would clear the ordinary 1h cooldown...
    lastKnownStatus: "postponed_or_suspended",
  }), NOW);
  // ...but the postponed-specific 12h cooldown still applies
  ok(!v.eligible && v.reason === "postponed_cooldown", "a confirmed postponed/suspended game is NOT re-checked on the ordinary exponential schedule — a much longer flat cooldown applies");
}
{
  const v = isReconciliationEligible(baseRow({
    reconciliationAttemptCount: 1,
    lastReconciliationAttemptAt: hoursAgo(13),
    lastKnownStatus: "postponed_or_suspended",
  }), NOW);
  ok(v.eligible, "a postponed/suspended game IS eligible again once the full 12h postponed cooldown has elapsed");
}
{
  // A game that has NEVER been checked (lastReconciliationAttemptAt null) but is
  // somehow already tagged postponed in the cache cannot hit postponed_cooldown
  // (nothing to cool down FROM) — falls through to ordinary eligibility.
  const v = isReconciliationEligible(baseRow({ lastKnownStatus: "postponed_or_suspended", lastReconciliationAttemptAt: null }), NOW);
  ok(v.eligible, "a postponed game with no prior reconciliation attempt yet is still eligible for its first check");
}

// ── buildMoundV2GradingCoverageReport: empty input ──────────────────────────
{
  const report = buildMoundV2GradingCoverageReport([], NOW);
  ok(report.totalRows === 0 && report.gradingCoverageRatio === null, "an empty row set reports gradingCoverageRatio as null, never a fabricated 0 or 1");
  ok(report.oldestPendingPrediction === null, "no pending rows -> no oldestPendingPrediction");
  ok(report.staleAlertCount === 0 && report.staleAlerts.length === 0, "no pending rows -> zero stale alerts");
}

// ── buildMoundV2GradingCoverageReport: coverage ratio + counts ──────────────
{
  const rows: MoundV2ReconciliationRow[] = [
    baseRow({ predictionId: "p1", settlementStatus: "graded" }),
    baseRow({ predictionId: "p2", settlementStatus: "void" }),
    baseRow({ predictionId: "p3", settlementStatus: "pending", scheduledGameTime: hoursAgo(1) }),
    baseRow({ predictionId: "p4", settlementStatus: "pending", scheduledGameTime: hoursAgo(1) }),
  ];
  const report = buildMoundV2GradingCoverageReport(rows, NOW);
  ok(report.totalRows === 4, "totalRows counts every row supplied");
  ok(report.gradedOrVoidedCount === 2, "gradedOrVoidedCount counts graded+void rows");
  ok(report.pendingCount === 2, "pendingCount counts only pending rows");
  ok(Math.abs(report.gradingCoverageRatio! - 0.5) < 1e-9, `gradingCoverageRatio is 2/4=0.5 (got ${report.gradingCoverageRatio})`);
}

// ── oldestPendingPrediction picks the true oldest by reference time ────────
{
  const rows: MoundV2ReconciliationRow[] = [
    baseRow({ predictionId: "young", scheduledGameTime: hoursAgo(6) }),
    baseRow({ predictionId: "old", scheduledGameTime: hoursAgo(40) }),
    baseRow({ predictionId: "middle", scheduledGameTime: hoursAgo(20) }),
  ];
  const report = buildMoundV2GradingCoverageReport(rows, NOW);
  ok(report.oldestPendingPrediction?.predictionId === "old", `the row with the largest age is picked as oldest (got ${report.oldestPendingPrediction?.predictionId})`);
  ok(Math.abs(report.oldestPendingPrediction!.ageMs - 40 * 60 * 60 * 1000) < 1000, "oldestPendingPrediction's ageMs is computed correctly");
}

// ── pendingPastEligibleWindowCount + unresolvedPitcherIds ───────────────────
{
  const rows: MoundV2ReconciliationRow[] = [
    baseRow({ predictionId: "p1", pitcherId: "pitcherA", scheduledGameTime: hoursAgo(1) }), // not yet past 5h window
    baseRow({ predictionId: "p2", pitcherId: "pitcherB", scheduledGameTime: hoursAgo(10) }), // past window
    baseRow({ predictionId: "p3", pitcherId: "pitcherB", market: "pitcher_outs" as any, scheduledGameTime: hoursAgo(12) }), // same pitcher, different market, also past window
  ];
  const report = buildMoundV2GradingCoverageReport(rows, NOW);
  ok(report.pendingPastEligibleWindowCount === 2, `two rows are past their own eligible window (got ${report.pendingPastEligibleWindowCount})`);
  ok(report.unresolvedPitcherIds.length === 1 && report.unresolvedPitcherIds[0] === "pitcherB", "unresolvedPitcherIds is deduplicated by pitcher, not counted per-row");
}

// ── staleAlerts: 24h+ pending rows, oldest-first, count never truncated ─────
{
  const rows: MoundV2ReconciliationRow[] = Array.from({ length: 60 }, (_, i) =>
    baseRow({ predictionId: `stale_${i}`, scheduledGameTime: hoursAgo(25 + i) }),
  );
  const report = buildMoundV2GradingCoverageReport(rows, NOW);
  ok(report.staleAlertCount === 60, `staleAlertCount reflects the TRUE full count even though the detail array is capped (got ${report.staleAlertCount})`);
  ok(report.staleAlerts.length === MOUND_V2_RECONCILIATION_POLICY.MAX_STALE_ALERTS_RETURNED, `staleAlerts detail array is capped at MAX_STALE_ALERTS_RETURNED (got ${report.staleAlerts.length})`);
  ok(report.staleAlerts[0].predictionId === `stale_${59}`, "staleAlerts is sorted oldest (most urgent) first");
}
{
  const rows: MoundV2ReconciliationRow[] = [baseRow({ scheduledGameTime: hoursAgo(23) })];
  const report = buildMoundV2GradingCoverageReport(rows, NOW);
  ok(report.staleAlertCount === 0, "a pending row younger than the 24h alert threshold is never counted as a stale alert");
}

// ── providerFailureCount ────────────────────────────────────────────────────
{
  const rows: MoundV2ReconciliationRow[] = [
    baseRow({ predictionId: "ok", lastReconciliationFailureReason: null }),
    baseRow({ predictionId: "failed1", lastReconciliationFailureReason: "network timeout" }),
    baseRow({ predictionId: "failed2", lastReconciliationFailureReason: "gamePk_unresolved_at_capture" }),
    baseRow({ predictionId: "graded_with_stale_failure", settlementStatus: "graded", lastReconciliationFailureReason: "old failure before it eventually graded" }),
  ];
  const report = buildMoundV2GradingCoverageReport(rows, NOW);
  ok(report.providerFailureCount === 2, `only PENDING rows with a real failure reason count (got ${report.providerFailureCount}) — a graded row's stale failure history doesn't count as a current problem`);
}

// ── suspendedOrPostponedCount ────────────────────────────────────────────────
{
  const rows: MoundV2ReconciliationRow[] = [
    baseRow({ predictionId: "p1", lastKnownStatus: "postponed_or_suspended" }),
    baseRow({ predictionId: "p2", lastKnownStatus: "in_progress" }),
    baseRow({ predictionId: "p3", lastKnownStatus: "postponed_or_suspended", settlementStatus: "void" }),
  ];
  const report = buildMoundV2GradingCoverageReport(rows, NOW);
  ok(report.suspendedOrPostponedCount === 1, `only PENDING rows with a postponed/suspended classification count (got ${report.suspendedOrPostponedCount}) — a void row is already resolved, not a live concern`);
}

console.log(`\nmoundV2ShadowReconciliation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
