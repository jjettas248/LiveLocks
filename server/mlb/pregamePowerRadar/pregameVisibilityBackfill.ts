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
// So this reads TWO independent snapshots and unhides on either landing
// eligible:
//   1. `getRadarSnapshot()` — the TTL/DB-fallback-aware "stored" read. For a
//      long-running process this already reflects everything OR'd in across
//      every natural rebuild since the target locked (a genuine historical
//      signal, not a fresh recompute); for a cold process it falls back to
//      whatever was last persisted.
//   2. A forced fresh rebuild — a second, independent chance under current
//      data, same as the live card list gets on every request.
//
// Never creates a new win, never touches calibration misses, and never
// mutates anything but `outcomes.userVisible` on the in-memory signal + its
// persisted DB row.
//
// Writes ONLY to the pre-game store + pregame tables. Never persisted_plays /
// ROI / official W-L.

import { storage } from "../../storage";
import { buildPregamePowerRadar } from "./buildPregamePowerRadar";
import { getRadarSnapshot } from "./pregamePowerRadarService";
import { getSnapshot } from "./pregamePowerRadarStore";
import { signalToRow } from "./pregamePersistence";

export interface PregameVisibilityBackfillResult {
  scanned: number;
  corrected: number;
  correctedSignalIds: string[];
}

/** One-off admin backfill: unhide pregame wins wrongly stamped non-public. */
export async function backfillPregameWinVisibility(): Promise<PregameVisibilityBackfillResult> {
  // Stored/TTL-aware read first — captures whatever eligibility history is
  // already known (in-memory accumulation or DB fallback) before a forced
  // rebuild has a chance to overwrite it with a possibly-drifted fresh read.
  const stored = await getRadarSnapshot().catch(() => ({ snapshot: null }));
  const storedFlagged = new Set<string>();
  if (stored.snapshot) {
    for (const s of Array.from(stored.snapshot.signals.values())) {
      if (s.everPubliclyFlagged) storedFlagged.add(s.signalId);
    }
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
    if (!signal.everPubliclyFlagged && !storedFlagged.has(signal.signalId)) continue;

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
