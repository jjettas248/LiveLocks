// Pre-Game Power Radar — read-only stats service.
//
// Bridges pure stats builders to snapshot + persisted JSONB rows. This file is
// intentionally read-only and best-effort: failed historical reads degrade to an
// empty slice so stats can never break runtime or settlement.

import { storage } from "../../storage";
import { slateDateET, daysAgoET } from "../../utils/dateUtils";
import { getSnapshot } from "./pregamePowerRadarStore";
import { rowToSignal } from "./pregamePersistence";
import { getRadarSnapshot } from "./pregamePowerRadarService";
import { buildCalibrationStats, buildPublicStats } from "./calibrationStats";
import { buildDailyPregameWins } from "./winAttribution";
import type { PregamePowerSignal } from "./types";
import type {
  PregameRadarCalibrationStats,
  PregameRadarPublicStats,
  PregameRadarWinItem,
} from "../../../shared/pregameRadarWin";

/**
 * De-dupe by signalId. A graded outcome is written once by the grader and must
 * never be clobbered by a later, ungraded copy of the same signal — e.g. a
 * fresh snapshot rebuild always re-initializes `outcomes: null` for today's
 * signals, but the DB row already carries the grader's result. When two
 * copies collide, keep the later copy's fields (freshest lineup/tier/etc.)
 * but preserve `outcomes`/`status` from whichever copy actually has them.
 */
function uniqueBySignalId(signals: PregamePowerSignal[]): PregamePowerSignal[] {
  const byId = new Map<string, PregamePowerSignal>();
  for (const signal of signals) {
    const existing = byId.get(signal.signalId);
    const everPubliclyFlagged = existing?.everPubliclyFlagged || signal.everPubliclyFlagged;
    if (existing?.outcomes && !signal.outcomes) {
      byId.set(signal.signalId, { ...signal, status: existing.status, outcomes: existing.outcomes, everPubliclyFlagged });
    } else {
      byId.set(signal.signalId, { ...signal, everPubliclyFlagged });
    }
  }
  return Array.from(byId.values());
}

function datesBack(count: number): string[] {
  const n = Math.max(1, Math.min(60, Math.floor(count)));
  return Array.from({ length: n }, (_, i) => daysAgoET(i));
}

export async function loadPregamePowerSignalsByDate(dateET: string): Promise<PregamePowerSignal[]> {
  try {
    const rows = await storage.getPregamePowerRadarSignalsByDate(dateET);
    return rows.map(rowToSignal);
  } catch (err: any) {
    console.warn(`[PREGAME_RADAR_STATS_LOAD] failed date=${dateET}:`, err?.message ?? err, err?.stack);
    return [];
  }
}

async function loadPregamePowerSignalsByDates(dates: string[]): Promise<PregamePowerSignal[]> {
  const chunks = await Promise.all(dates.map(loadPregamePowerSignalsByDate));
  return uniqueBySignalId(chunks.flat());
}

function currentSnapshotSignalsForDate(dateET: string): PregamePowerSignal[] {
  const snapshot = getSnapshot();
  if (!snapshot || snapshot.sessionDate !== dateET) return [];
  return Array.from(snapshot.signals.values());
}

export async function getPregameRadarPublicStats(dateET: string = slateDateET()): Promise<PregameRadarPublicStats> {
  // "Current slate" comparisons use slateDateET() (6am-ET rollover), matching
  // the sessionDate every snapshot/build is stamped with — todayET() here made
  // the in-memory merge miss the live slate between midnight and 6am ET.
  if (dateET === slateDateET()) await getRadarSnapshot().catch(() => null);

  const todaySignals = uniqueBySignalId([
    ...await loadPregamePowerSignalsByDate(dateET),
    ...currentSnapshotSignalsForDate(dateET),
  ]);

  const last7Dates = datesBack(7);
  const last7Signals = uniqueBySignalId([
    ...await loadPregamePowerSignalsByDates(last7Dates),
    ...currentSnapshotSignalsForDate(slateDateET()),
  ]);

  return buildPublicStats(todaySignals, last7Signals, dateET);
}

export async function getPregameRadarCalibrationStats(days: number = 7): Promise<PregameRadarCalibrationStats> {
  await getRadarSnapshot().catch(() => null);

  const clampedDays = Math.max(1, Math.min(60, Math.floor(days)));
  const dates = datesBack(clampedDays);
  const endET = dates[0] ?? slateDateET();
  const startET = dates[dates.length - 1] ?? endET;

  const signals = uniqueBySignalId([
    ...await loadPregamePowerSignalsByDates(dates),
    ...currentSnapshotSignalsForDate(slateDateET()),
  ]);

  return buildCalibrationStats(signals, { startET, endET });
}

/**
 * Public Pregame Radar Wins for a single ET date (DB + in-memory merge, same
 * pattern as getPregameRadarPublicStats). Powers the daily cashed log for both
 * today and historical dates.
 */
export async function getPregameRadarWinsForDate(dateET: string = slateDateET()): Promise<{
  pregameRadarWins: PregameRadarWinItem[];
  firstAbPregameWins: PregameRadarWinItem[];
}> {
  if (dateET === slateDateET()) await getRadarSnapshot().catch(() => null);

  const signals = uniqueBySignalId([
    ...await loadPregamePowerSignalsByDate(dateET),
    ...currentSnapshotSignalsForDate(dateET),
  ]);

  return buildDailyPregameWins(signals);
}
