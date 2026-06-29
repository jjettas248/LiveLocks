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
import { wasPubliclyFlaggedPregame } from "./diagnostics";
import { deriveWinAttribution, buildDailyPregameWins } from "./winAttribution";
import type { PregameOutcome, PregamePowerSignal } from "./types";
import type {
  PregameCalibrationRecord,
  PregameRadarWinItem,
} from "../../../shared/pregameRadarWin";

/** Canonical live-HR hit inning lookup, keyed by `${gameId}|${playerId}`. */
type CanonicalHitLookup = Map<string, { hitInning: number | null; hitHalf: string | null }>;

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

/**
 * Resolve final-game box-score outcome for a target, when available, and stamp
 * the win-attribution result (pregame_win vs calibration_miss) plus HR inning /
 * plate-appearance detail. `canonicalHit` is an optional inning fallback drawn
 * from the live HR Radar canonical store.
 */
function resolveOutcome(
  signal: PregamePowerSignal,
  canonicalHit?: { hitInning: number | null; hitHalf: string | null } | null,
): PregameOutcome | null {
  const box = mlbGameCache.gameBoxScore[signal.gameId];
  const line = box?.byPlayerId?.[signal.batterId];
  if (!line) return null;

  const hitHr = (line.hr ?? 0) > 0;

  // Inning + plate-appearance detail: prefer the player's own ordered ABs from
  // the play feed; fall back to the play-feed HR list, then the canonical hit.
  const priorABResults =
    mlbGameCache.contactData[signal.gameId]?.byPlayerId?.[signal.batterId]?.priorABResults ?? null;
  const hrPlay = mlbGameCache.hrPlays[signal.gameId]?.plays?.find(
    (p) => String(p.playerId) === String(signal.batterId),
  );

  const attribution = deriveWinAttribution({
    hitHr,
    wasPubliclyFlagged: wasPubliclyFlaggedPregame(signal),
    priorABResults,
    hrPlayInning: hrPlay?.inning ?? null,
    hrPlayHalf: hrPlay?.halfInning ?? null,
    canonicalHitInning: canonicalHit?.hitInning ?? null,
    canonicalHitHalf: canonicalHit?.hitHalf ?? null,
  });

  return {
    hitHr,
    totalBases: line.tb ?? null,
    hitRecorded: (line.hits ?? 0) > 0,
    rbiRecorded: line.rbi ?? null,
    resolvedAt: new Date().toISOString(),
    outcome: attribution.outcome,
    userVisible: attribution.userVisible,
    hrInning: attribution.hrInning,
    hrHalf: attribution.hrHalf,
    plateAppearanceNumber: attribution.plateAppearanceNumber,
    firstAbPregameWin: attribution.firstAbPregameWin,
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

  // One read-only fetch of the live HR Radar canonical hits for inning fallback.
  // Best-effort: a failure just leaves attribution to the play-feed sources.
  let canonicalHits: CanonicalHitLookup = new Map();
  try {
    const canonical = await storage.getCanonicalHrRadarOutcomes(snapshot.sessionDate);
    canonicalHits = new Map(
      canonical.hits.map((h) => [
        `${h.gameId}|${h.playerId}`,
        { hitInning: h.hitInning ?? null, hitHalf: h.hitHalf ?? null },
      ]),
    );
  } catch {
    // leave canonicalHits empty
  }

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

    // ── Shadow outcome + win attribution on final games ───────────────────────
    if (signal.gameStatus === "final" && signal.status !== "graded") {
      const outcome = resolveOutcome(signal, canonicalHits.get(`${signal.gameId}|${signal.batterId}`));
      if (outcome) {
        signal.outcomes = outcome;
        signal.status = "graded";
        changed = true;
        graded++;
        console.log(`[PREGAME_POWER_RADAR_GRADED] ${signal.signalId} hr=${outcome.hitHr} tb=${outcome.totalBases} rbi=${outcome.rbiRecorded}`);
        // Win Attribution: hits are public wins; misses are calibration only.
        if (outcome.outcome === "pregame_win" && outcome.userVisible) {
          console.log(
            `[PREGAME_RADAR_WIN] ${signal.signalId} player=${signal.batterName} inning=${outcome.hrInning ?? "?"} pa=${outcome.plateAppearanceNumber ?? "?"} firstAb=${outcome.firstAbPregameWin === true}`,
          );
        } else if (outcome.outcome === "pregame_win") {
          console.log(`[PREGAME_RADAR_WIN_INTERNAL] ${signal.signalId} player=${signal.batterName} (homered, not publicly flagged)`);
        } else {
          console.log(`[PREGAME_CALIBRATION_MISS] ${signal.signalId} player=${signal.batterName} (no HR — internal calibration only)`);
        }
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
  calibrationRecord: PregameCalibrationRecord;
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
    calibrationRecord: getPregameCalibrationRecord(),
  };
}

/**
 * Pregame Radar Record + admin calibration rollup. Wins are public hits;
 * calibration misses are internal-only (never decrement a public record).
 */
export function getPregameCalibrationRecord(): PregameCalibrationRecord {
  const snapshot = getSnapshot();
  const all = snapshot ? Array.from(snapshot.signals.values()) : [];
  const graded = all.filter((s) => s.status === "graded" && s.outcomes);

  let wins = 0;
  let firstAbWins = 0;
  let calibrationMisses = 0;
  let internalWins = 0;

  for (const s of graded) {
    const o = s.outcomes!;
    if (o.outcome === "pregame_win") {
      if (o.userVisible === true) {
        wins++;
        if (o.firstAbPregameWin === true) firstAbWins++;
      } else {
        internalWins++;
      }
    } else if (o.outcome === "calibration_miss") {
      calibrationMisses++;
    }
  }

  // Public win rate denominator = publicly-flagged graded targets (wins +
  // public calibration misses). Internal (unflagged) hits are excluded.
  const publicGraded = graded.filter(
    (s) => wasPubliclyFlaggedPregame(s) && s.outcomes?.outcome != null,
  ).length;

  return {
    wins,
    firstAbWins,
    calibrationMisses,
    internalWins,
    totalGraded: graded.length,
    winRate: publicGraded > 0 ? Math.round((wins / publicGraded) * 1000) / 10 : null,
  };
}

/** Today's public Pregame Radar Wins, grouped for the daily cashed log. */
export function getPregameRadarWins(): {
  pregameRadarWins: PregameRadarWinItem[];
  firstAbPregameWins: PregameRadarWinItem[];
} {
  const snapshot = getSnapshot();
  const all = snapshot ? Array.from(snapshot.signals.values()) : [];
  return buildDailyPregameWins(all);
}
