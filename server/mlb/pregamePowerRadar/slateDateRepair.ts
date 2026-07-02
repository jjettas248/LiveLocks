// Pre-Game Power Radar — slate-date repair planner (pure, no I/O).
//
// Historical `pregame_power_radar_signals` rows built before the slateDateET()
// alignment fix (see buildPregamePowerRadar.ts) could have been stamped with a
// `sessionDate` one day off from the game's actual slate day, whenever a
// rebuild ran between midnight and 6am ET. This module computes the correct
// slate date per row from the game's own data — never by blanket-subtracting
// a day — so the caller (server/scripts/repairPregameRadarSlateDates.ts) can
// decide what to fix.
//
// Priority order for the correct slate date (never HR/settlement timestamp,
// never a UTC date bucket, never a re-derived "today"):
//   1. game start time (startsAt), converted to its ET calendar date — MLB
//      games start well after the 6am-ET slate cutover, so this is reliable.
//   2. the row's own gameDate field (official MLB game date), when startsAt
//      is unavailable.
//   3. unresolved — no game date evidence at all; left unchanged, flagged for
//      diagnostic review rather than guessed at.

import { toEtDateKey } from "../../utils/dateUtils";

export interface SlateDateRepairRow {
  signalId: string;
  sessionDate: string;
  gameDate: string;
  startsAt: string | null;
  gameId: string;
  batterId: string;
}

export type SlateDateRepairSource = "startsAt" | "gameDate" | "unresolved";

export interface SlateDateRepairPlanEntry {
  signalId: string;
  gameId: string;
  batterId: string;
  currentSessionDate: string;
  correctSessionDate: string;
  correctSignalId: string;
  source: SlateDateRepairSource;
  /** True when another row in the same input set already owns correctSignalId — needs manual review, never auto-merged. */
  collision: boolean;
}

function computeCorrectSessionDate(row: SlateDateRepairRow): { date: string; source: SlateDateRepairSource } {
  if (row.startsAt) return { date: toEtDateKey(row.startsAt), source: "startsAt" };
  if (row.gameDate) return { date: row.gameDate, source: "gameDate" };
  return { date: row.sessionDate, source: "unresolved" };
}

/**
 * Compute the repair plan for a set of rows. Only rows whose correct slate
 * date differs from the stored one are returned; unresolved rows (no game
 * start time or game date to check against) are never included since there is
 * no evidence to act on.
 */
export function planSlateDateRepair(rows: SlateDateRepairRow[]): SlateDateRepairPlanEntry[] {
  const existingIds = new Set(rows.map((r) => r.signalId));
  const plan: SlateDateRepairPlanEntry[] = [];

  for (const row of rows) {
    const { date: correctSessionDate, source } = computeCorrectSessionDate(row);
    if (source === "unresolved") continue;
    if (correctSessionDate === row.sessionDate) continue;

    const correctSignalId = `mlb-pregame:${correctSessionDate}:${row.gameId}:${row.batterId}`;
    plan.push({
      signalId: row.signalId,
      gameId: row.gameId,
      batterId: row.batterId,
      currentSessionDate: row.sessionDate,
      correctSessionDate,
      correctSignalId,
      source,
      collision: existingIds.has(correctSignalId),
    });
  }

  return plan;
}
