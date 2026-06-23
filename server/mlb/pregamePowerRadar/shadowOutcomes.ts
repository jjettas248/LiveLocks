// Pre-Game Power Radar — shadow outcomes + live bridge (Phase 4/5).
//
// Grades pre-game targets in their OWN track only:
//   • Live bridge (read-only): cross-references the live HR canonical store to
//     mark whether a target later became live Ready / Fire. Never mutates the
//     live engine — pure reads via getCanonicalHrRadarState.
//   • Shadow outcomes: when a game is final and a box score is available, records
//     hit HR / total bases / hit / RBI on the target's own row.
//
// Writes ONLY to the pre-game store + pregame tables. Never persisted_plays /
// ROI / official W-L. Labels stay "pregame target hit rate" — a proxy, not
// official record.

import { storage } from "../../storage";
import { getCanonicalHrRadarState } from "../hrRadarCanonicalStore";
import { mlbGameCache } from "../dataPullService";
import { getSnapshot } from "./pregamePowerRadarStore";
import type { PregameOutcome, PregamePowerSignal } from "./types";

/** Read-only: did this batter reach live Ready/Fire in the live HR radar? */
function liveBridge(signal: PregamePowerSignal): {
  becameLiveReady: boolean;
  becameLiveFire: boolean;
  convertedLiveAt: string | null;
} {
  const state = getCanonicalHrRadarState(signal.gameId, signal.batterId);
  if (!state) {
    return {
      becameLiveReady: signal.becameLiveReady,
      becameLiveFire: signal.becameLiveFire,
      convertedLiveAt: signal.convertedLiveAt,
    };
  }
  const ls = state.lifecycleState;
  const ready = ls === "ready" || ls === "fire" || ls === "cashed";
  const fire = ls === "fire" || ls === "cashed";
  const convertedLiveAt = signal.convertedLiveAt ?? (ready ? state.updatedAt : null);
  return { becameLiveReady: signal.becameLiveReady || ready, becameLiveFire: signal.becameLiveFire || fire, convertedLiveAt };
}

/** Resolve final-game box-score outcome for a target, when available. */
function resolveOutcome(signal: PregamePowerSignal): PregameOutcome | null {
  const box = mlbGameCache.gameBoxScore[signal.gameId];
  const line = box?.byPlayerId?.[signal.batterId];
  if (!line) return null;
  return {
    hitHr: (line.hr ?? 0) > 0,
    totalBases: line.tb ?? null,
    hitRecorded: (line.hits ?? 0) > 0,
    rbiRecorded: line.rbi ?? null,
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * Single grading pass over the current snapshot. Updates in-memory signals and
 * persists them. Never throws into runtime.
 */
export async function gradePregameOutcomes(): Promise<{ bridged: number; graded: number }> {
  const snapshot = getSnapshot();
  if (!snapshot) return { bridged: 0, graded: 0 };

  let bridged = 0;
  let graded = 0;

  for (const signal of Array.from(snapshot.signals.values())) {
    let changed = false;

    // ── Live bridge (read-only) ───────────────────────────────────────────────
    const bridge = liveBridge(signal);
    if (
      bridge.becameLiveReady !== signal.becameLiveReady ||
      bridge.becameLiveFire !== signal.becameLiveFire ||
      bridge.convertedLiveAt !== signal.convertedLiveAt
    ) {
      signal.becameLiveReady = bridge.becameLiveReady;
      signal.becameLiveFire = bridge.becameLiveFire;
      signal.convertedLiveAt = bridge.convertedLiveAt;
      changed = true;
      bridged++;
      console.log(`[PREGAME_POWER_RADAR_BRIDGE] ${signal.signalId} ready=${bridge.becameLiveReady} fire=${bridge.becameLiveFire}`);
    }

    // ── Shadow outcome on final games ─────────────────────────────────────────
    if (signal.gameStatus === "final" && signal.status !== "graded") {
      const outcome = resolveOutcome(signal);
      if (outcome) {
        signal.outcomes = outcome;
        signal.status = "graded";
        changed = true;
        graded++;
        console.log(`[PREGAME_POWER_RADAR_GRADED] ${signal.signalId} hr=${outcome.hitHr} tb=${outcome.totalBases} rbi=${outcome.rbiRecorded}`);
      }
    }

    if (changed) {
      try {
        await storage.upsertPregamePowerRadarSignal({
          signalId: signal.signalId,
          buildId: signal.buildId,
          sessionDate: signal.sessionDate,
          gameId: signal.gameId,
          gameDate: signal.gameDate,
          startsAt: signal.startsAt ?? null,
          gameStatus: signal.gameStatus,
          firstPitchLockEligible: signal.firstPitchLockEligible,
          batterId: signal.batterId,
          batterName: signal.batterName,
          team: signal.team,
          opponent: signal.opponent,
          pitcherId: signal.pitcherId ?? null,
          pitcherName: signal.pitcherName ?? null,
          battingOrderSlot: signal.battingOrderSlot ?? null,
          primaryMarket: signal.primaryMarket,
          marketTags: signal.marketTags,
          marketScores: signal.marketScores,
          score10: String(signal.score10),
          tier: signal.tier,
          drivers: signal.drivers,
          warnings: signal.warnings,
          diagnostics: signal.diagnostics,
          lineupStatus: signal.lineupStatus,
          weatherStatus: signal.weatherStatus,
          hasMarketLine: signal.hasMarketLine,
          isOfficialPlay: false,
          isPregameTarget: true,
          status: signal.status,
          suppressed: signal.suppressed,
          suppressedReasons: signal.suppressedReasons,
          outcomes: signal.outcomes ?? null,
          becameLiveReady: signal.becameLiveReady,
          becameLiveFire: signal.becameLiveFire,
          convertedLiveAt: signal.convertedLiveAt ? new Date(signal.convertedLiveAt) : null,
          lockedAt: signal.lockedAt ? new Date(signal.lockedAt) : null,
          gradedAt: signal.status === "graded" ? new Date() : null,
        });
      } catch (err: any) {
        console.warn(`[PREGAME_POWER_RADAR_GRADED] persist failed ${signal.signalId}:`, err?.message);
      }
    }
  }

  return { bridged, graded };
}

/** Summary for admin diagnostics — pregame-only proxy metrics (never official ROI). */
export function getPregameOutcomeSummary(): {
  total: number;
  graded: number;
  hrHitRate: number | null;
  becameLiveReady: number;
  becameLiveFire: number;
  conversionRate: number | null;
} {
  const snapshot = getSnapshot();
  const all = snapshot ? Array.from(snapshot.signals.values()) : [];
  const public_ = all.filter((s) => !s.suppressed);
  const graded = public_.filter((s) => s.status === "graded" && s.outcomes);
  const hrHits = graded.filter((s) => s.outcomes?.hitHr).length;
  const becameLiveReady = public_.filter((s) => s.becameLiveReady).length;
  const becameLiveFire = public_.filter((s) => s.becameLiveFire).length;
  return {
    total: public_.length,
    graded: graded.length,
    hrHitRate: graded.length > 0 ? Math.round((hrHits / graded.length) * 1000) / 10 : null,
    becameLiveReady,
    becameLiveFire,
    conversionRate: public_.length > 0 ? Math.round((becameLiveReady / public_.length) * 1000) / 10 : null,
  };
}
