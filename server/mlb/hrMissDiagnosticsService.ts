/**
 * HR Miss Diagnostic Payload Generator — DB gatherer.
 *
 * Read-only service behind GET /api/admin/hr-radar/miss-payload. Pulls the
 * persisted grading truth (hr_radar_alerts miss rows + their signal-event
 * timelines), enriches best-effort with the in-memory analytics miss-tracer
 * blockedGate, and delegates all shaping to the pure builders in
 * `hrMissDiagnostics.ts`. Never mutates any row, engine state, the bus, or
 * lifecycle state; `gradingStatus` stays authoritative and is only read.
 */

import { db } from "../db";
import { hrRadarAlerts, hrRadarSignalEvents } from "@shared/schema";
import { and, desc, inArray, sql } from "drizzle-orm";
import { todayET, daysAgoET } from "../utils/dateUtils";
import { getAnalyticsEvents } from "../analytics/analyticsEvent";
import {
  buildHrMissDiagnosticPayload,
  buildHrMissDiagnosticRecord,
  DEFAULT_MISS_CATEGORIES,
  EXEMPT_GRADING_STATUSES,
  MISS_GRADING_STATUSES,
  type HrMissAlertRowInput,
  type HrMissCategory,
  type HrMissDiagnosticPayload,
  type HrMissDiagnosticRecord,
  type HrMissSignalEventInput,
} from "./hrMissDiagnostics";

export interface GenerateHrMissPayloadOptions {
  /** Session-date lookback window (ET). Clamped to [1, 30]. */
  days?: number;
  /** Max records in the payload, most recent first. Clamped to [1, 200]. */
  limit?: number;
  /** Miss categories to include. Defaults to the four counted families. */
  categories?: HrMissCategory[];
}

function keyOf(gameId: string, playerId: string): string {
  return `${gameId}_${playerId}`;
}

/** Best-effort blockedGate lookup from the analytics ring buffer (in-memory,
 * lost on restart — records built after a reboot carry null, never a guess). */
function collectBlockedGates(): Map<string, string> {
  const gates = new Map<string, string>();
  try {
    const traces = getAnalyticsEvents({ sport: "mlb", eventType: "hr_radar_miss_trace" });
    for (const t of traces) {
      if (t.blockedGate) gates.set(keyOf(t.gameId, t.playerId), t.blockedGate);
    }
  } catch {
    /* analytics is best-effort — never block the payload */
  }
  return gates;
}

export async function generateHrMissDiagnosticPayload(
  options: GenerateHrMissPayloadOptions = {},
): Promise<HrMissDiagnosticPayload> {
  const days = Math.max(1, Math.min(30, Math.floor(options.days ?? 7)));
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  const requestedCategories =
    options.categories && options.categories.length
      ? options.categories
      : [...DEFAULT_MISS_CATEGORIES];

  const fromDateET = daysAgoET(days);
  const toDateET = todayET();

  // Only query the grading statuses the requested categories can map from.
  const wantExempt = requestedCategories.includes("early_window_exempt");
  const wantFalsePositive =
    requestedCategories.includes("fired_miss") || requestedCategories.includes("ready_only_miss");
  const wantedStatuses: string[] = [];
  if (wantFalsePositive) wantedStatuses.push("called_miss");
  if (requestedCategories.includes("uncalled_hr")) wantedStatuses.push("uncalled_hr");
  if (requestedCategories.includes("late_signal")) wantedStatuses.push("late_signal");
  if (wantExempt) wantedStatuses.push(...EXEMPT_GRADING_STATUSES);
  if (wantedStatuses.length === 0) wantedStatuses.push(...MISS_GRADING_STATUSES);

  const rows = await db
    .select()
    .from(hrRadarAlerts)
    .where(
      and(
        sql`${hrRadarAlerts.sessionDate} >= ${fromDateET}`,
        inArray(hrRadarAlerts.gradingStatus, wantedStatuses),
      ),
    )
    .orderBy(desc(hrRadarAlerts.sessionDate), desc(hrRadarAlerts.detectedAt));

  // Canonical per (sessionDate, gameId, playerId) — keep the most recent row.
  const canonical = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const k = `${row.sessionDate}|${row.gameId}|${row.playerId}`;
    if (!canonical.has(k)) canonical.set(k, row);
  }

  const blockedGates = collectBlockedGates();

  // Build records first (deriveMissCategory can drop rows — e.g. a called_miss
  // whose fire/ready split was not requested), then apply the record limit.
  const allRecords: HrMissDiagnosticRecord[] = [];
  const requested = new Set(requestedCategories);
  const rowsForTimeline: Array<{ row: (typeof rows)[number]; record: HrMissDiagnosticRecord }> = [];
  for (const row of Array.from(canonical.values())) {
    const record = buildHrMissDiagnosticRecord(row as unknown as HrMissAlertRowInput, [], {
      blockedGate: blockedGates.get(keyOf(row.gameId, row.playerId)) ?? null,
    });
    if (!record || !requested.has(record.category)) continue;
    allRecords.push(record);
    rowsForTimeline.push({ row, record });
  }

  const totalMissesInWindow = allRecords.length;
  const limited = rowsForTimeline.slice(0, limit);

  // Attach signal-event timelines only for the rows that made the cut — one
  // query over the surviving gameIds, grouped in memory.
  const gameIds = Array.from(new Set(limited.map((x) => x.row.gameId)));
  const eventsByKey = new Map<string, HrMissSignalEventInput[]>();
  if (gameIds.length > 0) {
    try {
      const eventRows = await db
        .select({
          gameId: hrRadarSignalEvents.gameId,
          playerId: hrRadarSignalEvents.playerId,
          eventType: hrRadarSignalEvents.eventType,
          signalState: hrRadarSignalEvents.signalState,
          score: hrRadarSignalEvents.score,
          confidenceTier: hrRadarSignalEvents.confidenceTier,
          detectedAt: hrRadarSignalEvents.detectedAt,
          inning: hrRadarSignalEvents.inning,
          half: hrRadarSignalEvents.half,
        })
        .from(hrRadarSignalEvents)
        .where(inArray(hrRadarSignalEvents.gameId, gameIds));
      for (const e of eventRows) {
        const k = keyOf(e.gameId, e.playerId);
        const list = eventsByKey.get(k) ?? [];
        list.push(e);
        eventsByKey.set(k, list);
      }
    } catch (err: any) {
      // Timelines are enrichment — the payload is still valid without them.
      console.warn(`[HR_MISS_PAYLOAD] timeline fetch failed: ${err?.message ?? err}`);
    }
  }

  const records = limited.map(({ row }) =>
    buildHrMissDiagnosticRecord(
      row as unknown as HrMissAlertRowInput,
      eventsByKey.get(keyOf(row.gameId, row.playerId)) ?? [],
      { blockedGate: blockedGates.get(keyOf(row.gameId, row.playerId)) ?? null },
    ),
  ).filter((r): r is HrMissDiagnosticRecord => r != null);

  const payload = buildHrMissDiagnosticPayload(records, {
    generatedAt: new Date().toISOString(),
    days,
    fromDateET,
    toDateET,
    requestedCategories,
    totalMissesInWindow,
    recordLimit: limit,
  });

  console.log(
    `[HR_MISS_PAYLOAD] generated window=${fromDateET}→${toDateET} records=${records.length}/` +
      `${totalMissesInWindow} categories=${requestedCategories.join(",")} ` +
      `fp=${payload.summary.falsePositives} fn=${payload.summary.falseNegatives}`,
  );

  return payload;
}
