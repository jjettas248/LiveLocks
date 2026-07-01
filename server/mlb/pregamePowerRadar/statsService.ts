// Pre-Game Power Radar — read-only stats service.
//
// Bridges pure stats builders to snapshot + persisted JSONB rows. This file is
// intentionally read-only and best-effort: failed historical reads degrade to an
// empty slice so stats can never break runtime or settlement.

import { storage } from "../../storage";
import { todayET, daysAgoET } from "../../utils/dateUtils";
import { getSnapshot } from "./pregamePowerRadarStore";
import { rowToSignal } from "./pregamePersistence";
import { getRadarSnapshot } from "./pregamePowerRadarService";
import { buildCalibrationStats, buildPublicStats } from "./calibrationStats";
import { buildDailyPregameWins } from "./winAttribution";
import { wasPubliclyFlaggedPregame } from "./diagnostics";
import type { PregamePowerSignal } from "./types";
import type {
  PregameRadarCalibrationStats,
  PregameRadarPublicStats,
  PregameRadarWinItem,
  PregameRadarDailyHistoryEntry,
} from "../../../shared/pregameRadarWin";

function uniqueBySignalId(signals: PregamePowerSignal[]): PregamePowerSignal[] {
  const byId = new Map<string, PregamePowerSignal>();
  for (const signal of signals) byId.set(signal.signalId, signal);
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
    console.warn(`[PREGAME_RADAR_STATS_LOAD] failed date=${dateET}:`, err?.message ?? err);
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

export async function getPregameRadarPublicStats(dateET: string = todayET()): Promise<PregameRadarPublicStats> {
  if (dateET === todayET()) await getRadarSnapshot().catch(() => null);

  const todaySignals = uniqueBySignalId([
    ...await loadPregamePowerSignalsByDate(dateET),
    ...currentSnapshotSignalsForDate(dateET),
  ]);

  const last7Dates = datesBack(7);
  const last7Signals = uniqueBySignalId([
    ...await loadPregamePowerSignalsByDates(last7Dates),
    ...currentSnapshotSignalsForDate(todayET()),
  ]);

  return buildPublicStats(todaySignals, last7Signals, dateET);
}

export async function getPregameRadarCalibrationStats(days: number = 7): Promise<PregameRadarCalibrationStats> {
  await getRadarSnapshot().catch(() => null);

  const clampedDays = Math.max(1, Math.min(60, Math.floor(days)));
  const dates = datesBack(clampedDays);
  const endET = dates[0] ?? todayET();
  const startET = dates[dates.length - 1] ?? endET;

  const signals = uniqueBySignalId([
    ...await loadPregamePowerSignalsByDates(dates),
    ...currentSnapshotSignalsForDate(todayET()),
  ]);

  return buildCalibrationStats(signals, { startET, endET });
}

/**
 * Public Pregame Radar Wins for a single ET date (DB + in-memory merge, same
 * pattern as getPregameRadarPublicStats). Powers the daily cashed log for both
 * today and historical dates.
 */
export async function getPregameRadarWinsForDate(dateET: string = todayET()): Promise<{
  pregameRadarWins: PregameRadarWinItem[];
  firstAbPregameWins: PregameRadarWinItem[];
}> {
  if (dateET === todayET()) await getRadarSnapshot().catch(() => null);

  const signals = uniqueBySignalId([
    ...await loadPregamePowerSignalsByDate(dateET),
    ...currentSnapshotSignalsForDate(dateET),
  ]);

  return buildDailyPregameWins(signals);
}

/**
 * Day-by-day Pregame Radar history for the drawer (newest first). Days with no
 * publicly-flagged targets (no slate / before launch) are omitted rather than
 * padding the list with empty entries.
 */
export async function getPregameRadarDailyHistory(days: number = 14): Promise<PregameRadarDailyHistoryEntry[]> {
  await getRadarSnapshot().catch(() => null);

  const clampedDays = Math.max(1, Math.min(60, Math.floor(days)));
  const dates = datesBack(clampedDays);

  const entries = await Promise.all(
    dates.map(async (dateET): Promise<PregameRadarDailyHistoryEntry | null> => {
      const signals = uniqueBySignalId([
        ...await loadPregamePowerSignalsByDate(dateET),
        ...currentSnapshotSignalsForDate(dateET),
      ]);
      const flaggedBeforeFirstPitch = signals.filter(wasPubliclyFlaggedPregame).length;
      if (flaggedBeforeFirstPitch === 0) return null;

      const { pregameRadarWins } = buildDailyPregameWins(signals);
      return {
        dateET,
        flaggedBeforeFirstPitch,
        pregameWinsCount: pregameRadarWins.length,
        firstAbPregameWinsCount: pregameRadarWins.filter((w) => w.firstAbPregameWin).length,
        wins: pregameRadarWins,
      };
    }),
  );

  return entries.filter((e): e is PregameRadarDailyHistoryEntry => e != null);
}
