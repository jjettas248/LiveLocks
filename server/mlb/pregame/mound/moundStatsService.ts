// Mound Radar — read-only stats service.
//
// Bridges pure stats builders to snapshot + persisted JSONB rows. Read-only
// and best-effort: failed historical reads degrade to an empty slice so
// stats can never break runtime or settlement. Mirrors
// pregamePowerRadar/statsService.ts's role for pitcher signals.

import { storage } from "../../../storage";
import { slateDateET, daysAgoET } from "../../../utils/dateUtils";
import { getMoundSnapshot } from "./mlbMoundRadarStore";
import { rowToSignal } from "./moundPersistence";
import { getMoundRadarSnapshot } from "./mlbMoundRadarService";
import { buildMoundCalibrationStats, buildMoundPublicStats } from "./moundCalibrationStats";
import { buildDailyMoundWins } from "./moundOutcomeAttribution";
import type { MoundSignal } from "./types";
import type {
  MoundRadarCalibrationStats,
  MoundRadarPublicStats,
  MoundRadarWinItem,
} from "../../../../shared/moundRadarWin";

function uniqueBySignalId(signals: MoundSignal[]): MoundSignal[] {
  const byId = new Map<string, MoundSignal>();
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

export async function loadMoundSignalsByDate(dateET: string): Promise<MoundSignal[]> {
  try {
    const rows = await storage.getMlbMoundRadarSignalsByDate(dateET);
    return rows.map(rowToSignal);
  } catch (err: any) {
    console.warn(`[MLB_PREGAME_MOUND_TARGETS] stats load failed date=${dateET}:`, err?.message ?? err);
    return [];
  }
}

async function loadMoundSignalsByDates(dates: string[]): Promise<MoundSignal[]> {
  const chunks = await Promise.all(dates.map(loadMoundSignalsByDate));
  return uniqueBySignalId(chunks.flat());
}

function currentMoundSnapshotSignalsForDate(dateET: string): MoundSignal[] {
  const snapshot = getMoundSnapshot();
  if (!snapshot || snapshot.sessionDate !== dateET) return [];
  return Array.from(snapshot.signals.values());
}

export async function getMoundRadarPublicStats(dateET: string = slateDateET()): Promise<MoundRadarPublicStats> {
  if (dateET === slateDateET()) await getMoundRadarSnapshot().catch(() => null);

  const todaySignals = uniqueBySignalId([
    ...await loadMoundSignalsByDate(dateET),
    ...currentMoundSnapshotSignalsForDate(dateET),
  ]);

  const last7Dates = datesBack(7);
  const last7Signals = uniqueBySignalId([
    ...await loadMoundSignalsByDates(last7Dates),
    ...currentMoundSnapshotSignalsForDate(slateDateET()),
  ]);

  return buildMoundPublicStats(todaySignals, last7Signals, dateET);
}

export async function getMoundRadarCalibrationStats(days: number = 7): Promise<MoundRadarCalibrationStats> {
  await getMoundRadarSnapshot().catch(() => null);

  const clampedDays = Math.max(1, Math.min(60, Math.floor(days)));
  const dates = datesBack(clampedDays);
  const endET = dates[0] ?? slateDateET();
  const startET = dates[dates.length - 1] ?? endET;

  const signals = uniqueBySignalId([
    ...await loadMoundSignalsByDates(dates),
    ...currentMoundSnapshotSignalsForDate(slateDateET()),
  ]);

  return buildMoundCalibrationStats(signals, { startET, endET });
}

export async function getMoundRadarWinsForDate(dateET: string = slateDateET()): Promise<{
  moundRadarWins: MoundRadarWinItem[];
}> {
  if (dateET === slateDateET()) await getMoundRadarSnapshot().catch(() => null);

  const signals = uniqueBySignalId([
    ...await loadMoundSignalsByDate(dateET),
    ...currentMoundSnapshotSignalsForDate(dateET),
  ]);

  return buildDailyMoundWins(signals);
}
