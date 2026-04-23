/**
 * Task #122 backfill — re-grade legacy `late_signal` rows that were actually
 * called pre-HR.
 *
 * The matcher used to mark an alert as `late_signal` whenever no qualifying
 * signal-event row existed before the HR endTime, even when the persisted
 * `signalDetectedAt` on the alert itself proved the signal predated the HR by
 * minutes or hours. The validator (`validateHrRadarLadder.ts`) flags this as
 * `I25_LATE_SIGNAL_ACTUALLY_PRE_HR`.
 *
 * This script:
 *   1. Finds all `hr_radar_alerts` rows where:
 *        - gradingStatus = 'late_signal'
 *        - signalDetectedAt is not null
 *        - hitDetectedAt is not null
 *        - hitDetectedAt - signalDetectedAt > TICK_TOLERANCE_MS (2000ms)
 *   2. Re-grades each row as `called_hit` (userVisible=true,
 *      matchedBeforeHr=true, matchMethod=direct_pre_hr_signal).
 *   3. Appends `resolved_called_hit` signal events for audit trail.
 *
 * Safe to run repeatedly — the WHERE clause excludes already-fixed rows.
 *
 * Usage:
 *   DRY-RUN (default): npx tsx scripts/backfillLateSignalToCalledHit.ts
 *   APPLY:             APPLY=1 npx tsx scripts/backfillLateSignalToCalledHit.ts
 */
import { db } from "../server/db";
import {
  hrRadarAlerts,
  hrRadarSignalEvents,
  type InsertHrRadarSignalEvent,
} from "../shared/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";

const TICK_TOLERANCE_MS = 2000;

async function main() {
  const apply = process.env.APPLY === "1";

  const candidates = await db
    .select()
    .from(hrRadarAlerts)
    .where(
      and(
        eq(hrRadarAlerts.gradingStatus, "late_signal"),
        isNotNull(hrRadarAlerts.signalDetectedAt),
        isNotNull(hrRadarAlerts.hitDetectedAt),
        sql`extract(epoch from (${hrRadarAlerts.hitDetectedAt} - ${hrRadarAlerts.signalDetectedAt})) * 1000 > ${TICK_TOLERANCE_MS}`,
      ),
    );

  console.log(
    `[BACKFILL] mode=${apply ? "APPLY" : "DRY-RUN"} candidates=${candidates.length}`,
  );

  let updated = 0;
  const auditFailures: Array<{ alertId: string; error: string }> = [];
  for (const row of candidates) {
    const sigMs = row.signalDetectedAt!.getTime();
    const hitMs = row.hitDetectedAt!.getTime();
    const deltaMs = hitMs - sigMs;
    const reason =
      `task-122 backfill: signalDetectedAt=${row.signalDetectedAt!.toISOString()} ` +
      `strictly precedes hitDetectedAt=${row.hitDetectedAt!.toISOString()} by ${deltaMs}ms — ` +
      `re-graded from late_signal to called_hit`;

    console.log(
      `[BACKFILL] alertId=${row.id} session=${row.sessionDate} game=${row.gameId} ` +
        `player=${row.playerId} (${row.playerName}) deltaMs=${deltaMs}`,
    );

    if (!apply) continue;

    const auditEvent: InsertHrRadarSignalEvent = {
      sessionDate: row.sessionDate,
      gameId: row.gameId,
      playerId: row.playerId,
      team: row.team ?? "",
      alertId: row.id,
      eventType: "resolved_called_hit",
      detectedAt: new Date(),
      inning: row.hitInning ?? null,
      half: row.hitHalf ?? null,
      source: "backfill_task_122",
    };

    // Update + audit insert wrapped in a transaction so a row can never be
    // re-graded without its audit event landing (and vice versa). If either
    // statement fails the whole row is rolled back and surfaces as a failure
    // the operator can re-run.
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(hrRadarAlerts)
          .set({
            gradingStatus: "called_hit",
            gradingReason: reason,
            matchedBeforeHr: true,
            userVisible: true,
            matchMethod: "direct_pre_hr_signal",
          })
          .where(eq(hrRadarAlerts.id, row.id));
        await tx.insert(hrRadarSignalEvents).values(auditEvent);
      });
      updated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditFailures.push({ alertId: row.id, error: msg });
      console.error(
        `[BACKFILL] transaction failed for alertId=${row.id}: ${msg}`,
      );
    }
  }

  console.log(
    `[BACKFILL] done. updated=${updated} auditFailures=${auditFailures.length} (apply=${apply})`,
  );
  if (auditFailures.length > 0) {
    console.error(
      `[BACKFILL] audit-event insert failures (rerun required for these alertIds): ` +
        JSON.stringify(auditFailures),
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
