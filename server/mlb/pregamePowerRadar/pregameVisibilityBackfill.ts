// Pre-Game Power Radar — visibility backfill (admin-triggered + auto-on-boot).
//
// Before `everPubliclyFlagged` existed, grading stamped `outcomes.userVisible`
// from a single live evaluation of `wasPubliclyFlaggedPregame` at whatever
// instant the 5-minute grading tick happened to fire. A signal that was
// legitimately publicly flagged pregame could still get `userVisible: false`
// baked in permanently if a mutable eligibility field (tier/score/
// dataCoverageScore/etc., all re-fetched from live data on every rebuild)
// happened to dip below threshold at that exact instant — hiding a real win
// from "Wins Today"/the drawer forever, since grading never re-runs.
//
// This was originally a manual, today-only admin action, which left every
// slate day *before* the fix permanently stuck (nobody could re-run "today's"
// backfill for a day that already rolled over), and depended on someone
// remembering to hit the endpoint after each deploy that touched this area —
// the exact way the drawer's win history kept coming up empty across
// restarts. `backfillPregameWinVisibilityRange` below removes that manual
// dependency: it walks every date the drawer can display and self-heals on
// boot, so a win misclassified by a bug in one deploy gets corrected by the
// very next process start rather than needing a human to invoke it per date.
//
// For TODAY specifically we still check two independent sources and unhide
// on either landing eligible:
//   1. The DB-persisted `ever_publicly_flagged` column, read directly (no
//      rebuild). `server/storage.ts`'s upsert OR-merges this column on every
//      write, so it durably accumulates any "lucky" true evaluation from a
//      natural rebuild that ran between deploy and this backfill invocation —
//      independent of whatever the in-memory snapshot looks like right now.
//   2. A forced fresh rebuild — one more live chance under current data, same
//      as the live card list gets on every request.
// A past slate day has no live data to rebuild, so only source #1 (the
// persisted column, read straight off each row) applies there.
//
// Never creates a new win, never touches calibration misses, and never
// mutates anything but `outcomes.userVisible` (+ `everPubliclyFlagged`) on a
// signal + its persisted DB row.
//
// Writes ONLY to the pre-game store + pregame tables. Never persisted_plays /
// ROI / official W-L.

import { storage } from "../../storage";
import { slateDateET, daysAgoET } from "../../utils/dateUtils";
import { buildPregamePowerRadar } from "./buildPregamePowerRadar";
import { getSnapshot } from "./pregamePowerRadarStore";
import { signalToRow, rowToSignal } from "./pregamePersistence";
import type { PregamePowerSignal } from "./types";

export interface PregameVisibilityBackfillResult {
  scanned: number;
  corrected: number;
  correctedSignalIds: string[];
}

/**
 * Unhide already-graded pregame wins wrongly stamped non-public for a single
 * slate day. `sessionDate` defaults to today. Only today gets the live-bridge
 * treatment (in-memory snapshot merge + a forced fresh rebuild) — a past
 * slate day is corrected from its persisted DB rows alone.
 */
export async function backfillPregameWinVisibility(
  sessionDate: string = slateDateET(),
): Promise<PregameVisibilityBackfillResult> {
  const isToday = sessionDate === slateDateET();

  // Durable historical read: a direct DB read (no rebuild) so it can never
  // collapse into "just another fresh live recompute" the way a second
  // getRadarSnapshot()/buildPregamePowerRadar() call would on a cold process.
  let rows: Awaited<ReturnType<typeof storage.getPregamePowerRadarSignalsByDate>> = [];
  const persistedFlagged = new Set<string>();
  try {
    rows = await storage.getPregamePowerRadarSignalsByDate(sessionDate);
    for (const r of rows) {
      if (r.everPubliclyFlagged) persistedFlagged.add(r.signalId);
    }
  } catch (err: any) {
    console.warn(`[PREGAME_RADAR_VISIBILITY_BACKFILL] persisted read failed date=${sessionDate}:`, err?.message);
  }

  // Today only: one more live chance under current data, same as the live
  // card list gets on every request. Best-effort — a past day can't be
  // "rebuilt" (no live discovery/lineups exist for it), and a failed/in-flight
  // build here just falls back to whatever's already in memory.
  if (isToday) {
    await buildPregamePowerRadar().catch(() => null);
  }
  const snapshot = isToday ? getSnapshot() : null;
  const snapshotSignalsById = new Map<string, PregamePowerSignal>(
    snapshot ? Array.from(snapshot.signals.values()).map((s) => [s.signalId, s]) : [],
  );

  // Merge: prefer the in-memory (possibly freshly-rebuilt) copy when present
  // for today, otherwise fall back to the persisted row reconstructed via
  // rowToSignal — this is the only representation available for a past day.
  const candidates: PregamePowerSignal[] = rows.map(
    (r) => snapshotSignalsById.get(r.signalId) ?? rowToSignal(r),
  );
  // Include any in-memory-only signals for today (e.g. a batter graded this
  // tick but not yet reflected in the DB read above).
  if (isToday) {
    for (const s of Array.from(snapshotSignalsById.values())) {
      if (!rows.some((r) => r.signalId === s.signalId)) candidates.push(s);
    }
  }

  let scanned = 0;
  let corrected = 0;
  const correctedSignalIds: string[] = [];

  for (const signal of candidates) {
    if (signal.status !== "graded" || !signal.outcomes) continue;
    scanned++;

    const outcome = signal.outcomes;
    if (outcome.outcome !== "pregame_win" || outcome.userVisible === true) continue;
    if (!signal.everPubliclyFlagged && !persistedFlagged.has(signal.signalId)) continue;

    signal.outcomes = { ...outcome, userVisible: true };
    signal.everPubliclyFlagged = true;
    corrected++;
    correctedSignalIds.push(signal.signalId);
    console.log(`[PREGAME_RADAR_VISIBILITY_BACKFILL] ${signal.signalId} player=${signal.batterName} date=${sessionDate} unhidden`);

    try {
      await storage.upsertPregamePowerRadarSignal(signalToRow(signal));
    } catch (err: any) {
      console.warn(`[PREGAME_RADAR_VISIBILITY_BACKFILL] persist failed ${signal.signalId}:`, err?.message);
    }
  }

  return { scanned, corrected, correctedSignalIds };
}

export interface PregameVisibilityBackfillRangeResult extends PregameVisibilityBackfillResult {
  datesScanned: number;
}

/**
 * Walk the last `days` ET slate days (matching the win-history drawer's own
 * lookback window) and backfill each one. Safe to run on every boot: a
 * signal already corrected on a prior run is a no-op (userVisible already
 * true), so this never double-corrects or creates a new win.
 */
export async function backfillPregameWinVisibilityRange(
  days: number,
): Promise<PregameVisibilityBackfillRangeResult> {
  const clampedDays = Math.max(1, Math.min(60, Math.floor(days)));
  const total: PregameVisibilityBackfillRangeResult = {
    scanned: 0,
    corrected: 0,
    correctedSignalIds: [],
    datesScanned: 0,
  };

  for (let i = 0; i < clampedDays; i++) {
    const dateET = daysAgoET(i);
    try {
      const result = await backfillPregameWinVisibility(dateET);
      total.scanned += result.scanned;
      total.corrected += result.corrected;
      total.correctedSignalIds.push(...result.correctedSignalIds);
      total.datesScanned++;
    } catch (err: any) {
      console.warn(`[PREGAME_RADAR_VISIBILITY_BACKFILL] range date=${dateET} failed:`, err?.message);
    }
  }

  if (total.corrected > 0) {
    console.log(
      `[PREGAME_RADAR_VISIBILITY_BACKFILL] range complete dates=${total.datesScanned} scanned=${total.scanned} corrected=${total.corrected}`,
    );
  }

  return total;
}
