// Pre-Game Power Radar — read-only stats service.
//
// Bridges pure stats builders to snapshot + persisted JSONB rows. This file is
// intentionally read-only and best-effort: failed historical reads degrade to an
// empty slice so stats can never break runtime or settlement.

import { storage } from "../../storage";
import { todayET, daysAgoET } from "../../utils/dateUtils";
import { getSnapshot } from "./pregamePowerRadarStore";
import { rowToSignal } from "./pregamePersistence";
import { buildCalibrationStats, buildPublicStats } from "./calibrationStats";
import type { PregamePowerSignal } from "./types";
import type { PregameRadarCalibrationStats, PregameRadarPublicStats } from "../../../shared/pregameRadarWin";

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
