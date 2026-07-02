// Pre-Game Power Radar — one-off visibility backfill (admin-triggered).
//
// Before `everPubliclyFlagged` existed, grading stamped `outcomes.userVisible`
// from a single live evaluation of `wasPubliclyFlaggedPregame` at whatever
// instant the 5-minute grading tick happened to fire. A signal that was
// legitimately publicly flagged pregame could still get `userVisible: false`
// baked in permanently if a mutable eligibility field (tier/score/
// dataCoverageScore/etc., all re-fetched from live data on every rebuild)
// happened to dip below threshold at that exact instant — hiding a real win
// from "Wins Today" and the drawer forever, since grading never re-runs.
//
// A legacy row's persisted `everPubliclyFlagged` defaults to false (the
// column didn't exist before this fix), and this backfill typically runs
// right after a deploy — i.e. right after a process restart wipes the
// in-memory OR-accumulator this flag depends on. Relying on a *single* fresh
// rebuild at that point re-runs the exact same live, drift-prone predicate
// that caused the original bug, with no better odds of landing on `true`.
//
// So this checks TWO independent sources and unhides on either landing
// eligible:
//   1. The DB-persisted `ever_publicly_flagged` column, read directly (no
//      rebuild). `server/storage.ts`'s upsert OR-merges this column on every
//      write, so it durably accumulates any "lucky" true evaluation from a
//      natural rebuild that ran between deploy and this backfill invocation —
//      independent of whatever the in-memory snapshot looks like right now.
//   2. A forced fresh rebuild — one more live chance under current data, same
//      as the live card list gets on every request.
//
// Scope: only today's slate (the in-memory snapshot / DB rows for
// `slateDateET()`), matching the "today's already-graded misses" backfill
// this was built for — it does not reach back into prior slate days.
//
// Never creates a new win, never touches calibration misses, and never
// mutates anything but `outcomes.userVisible` on the in-memory signal + its
// persisted DB row.
//
// Writes ONLY to the pre-game store + pregame tables. Never persisted_plays /
// ROI / official W-L.

import { storage } from "../../storage";
import { slateDateET } from "../../utils/dateUtils";
import { buildPregamePowerRadar } from "./buildPregamePowerRadar";
import { getSnapshot } from "./pregamePowerRadarStore";
import { signalToRow } from "./pregamePersistence";

export interface PregameVisibilityBackfillResult {
  scanned: number;
  corrected: number;
  correctedSignalIds: string[];
}

/** One-off admin backfill: unhide pregame wins wrongly stamped non-public. */
export async function backfillPregameWinVisibility(): Promise<PregameVisibilityBackfillResult> {
  // Durable historical read: a direct DB read (no rebuild) so it can never
  // collapse into "just another fresh live recompute" the way a second
  // getRadarSnapshot()/buildPregamePowerRadar() call would on a cold process.
  const persistedFlagged = new Set<string>();
  try {
    const rows = await storage.getPregamePowerRadarSignalsByDate(slateDateET());
    for (const r of rows) {
      if (r.everPubliclyFlagged) persistedFlagged.add(r.signalId);
    }
  } catch (err: any) {
    console.warn(`[PREGAME_RADAR_VISIBILITY_BACKFILL] persisted read failed:`, err?.message);
  }

  // Best-effort: if a build is already in flight or fails, fall back to
  // whatever snapshot is already in memory rather than throwing.
  await buildPregamePowerRadar().catch(() => null);

  const snapshot = getSnapshot();
  if (!snapshot) return { scanned: 0, corrected: 0, correctedSignalIds: [] };

  let scanned = 0;
  let corrected = 0;
  const correctedSignalIds: string[] = [];

  for (const signal of Array.from(snapshot.signals.values())) {
    if (signal.status !== "graded" || !signal.outcomes) continue;
    scanned++;

    const outcome = signal.outcomes;
    if (outcome.outcome !== "pregame_win" || outcome.userVisible === true) continue;
    if (!signal.everPubliclyFlagged && !persistedFlagged.has(signal.signalId)) continue;

    signal.outcomes = { ...outcome, userVisible: true };
    signal.everPubliclyFlagged = true;
    corrected++;
    correctedSignalIds.push(signal.signalId);
    console.log(`[PREGAME_RADAR_VISIBILITY_BACKFILL] ${signal.signalId} player=${signal.batterName} unhidden`);

    try {
      await storage.upsertPregamePowerRadarSignal(signalToRow(signal));
    } catch (err: any) {
      console.warn(`[PREGAME_RADAR_VISIBILITY_BACKFILL] persist failed ${signal.signalId}:`, err?.message);
    }
  }

  return { scanned, corrected, correctedSignalIds };
}
