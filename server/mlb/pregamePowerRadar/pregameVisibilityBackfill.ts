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
// This backfill forces one fresh rebuild (so `everPubliclyFlagged` is
// populated under the corrected, OR'd-forward logic), then unhides any
// already-graded `pregame_win` whose `userVisible` is still false but whose
// target is now known to have been legitimately flagged. It never creates a
// new win, never touches calibration misses, and never mutates anything but
// `outcomes.userVisible` on the in-memory signal + its persisted DB row.
//
// Writes ONLY to the pre-game store + pregame tables. Never persisted_plays /
// ROI / official W-L.

import { storage } from "../../storage";
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
    if (!signal.everPubliclyFlagged) continue;

    signal.outcomes = { ...outcome, userVisible: true };
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
