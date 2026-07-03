// Mound Radar — shadow outcomes (settlement).
//
// Grades mound targets in their OWN track only. Writes ONLY to the mound
// store + mound tables. Never persisted_plays / ROI / official W-L. No
// live-bridge in v1 — no dedicated canonical pitcher-prop lifecycle store
// exists to read from (HR Radar's canonical store is HR-specific); this
// module deliberately does not build a new live-engine read surface as a
// side effect of a pregame feature. becameLiveReady/becameLiveFire stay
// `false` for every Mound signal.
//
// Mirrors pregamePowerRadar/shadowOutcomes.ts's role for pitcher signals.

import { storage } from "../../../storage";
import { mlbGameCache } from "../../dataPullService";
import { getMoundSnapshot } from "./mlbMoundRadarStore";
import { deriveMoundOutcome } from "./moundOutcomeAttribution";
import type { MoundOutcome, MoundSignal } from "./types";
import type { MoundCalibrationRecord } from "../../../../shared/moundRadarWin";

/**
 * Resolve final-game pitching-box-score outcome for a target, when available,
 * and stamp the outcome-attribution result (mound_win vs mound_calibration_miss).
 */
function resolveMoundOutcome(signal: MoundSignal, seasonKPer9: number | null, seasonAvgInningsPerStart: number | null): MoundOutcome | null {
  const box = mlbGameCache.gamePitchingBoxScore[signal.gameId];
  const line = box?.byPitcherId?.[signal.pitcherId];
  if (!line) return null;

  const attribution = deriveMoundOutcome({
    primaryMarket: signal.primaryMarket,
    finalStrikeouts: line.strikeOuts,
    finalOutsRecorded: line.outsRecorded,
    seasonKPer9,
    seasonAvgInningsPerStart,
    wasPubliclyFlagged: signal.everPubliclyFlagged,
  });

  return {
    finalStrikeouts: line.strikeOuts,
    finalOutsRecorded: line.outsRecorded,
    finalBaseOnBalls: line.baseOnBalls,
    finalEarnedRuns: line.earnedRuns,
    resolvedAt: new Date().toISOString(),
    outcome: attribution.outcome,
    userVisible: attribution.userVisible,
    seasonBaselineValue: attribution.seasonBaselineValue,
  };
}

/**
 * Single grading pass over the current snapshot. Updates in-memory signals
 * and persists them. Never throws into runtime. Runs on its own interval —
 * NOT chained inside gradePregameOutcomes() — independent failure isolation
 * from Plate's grader.
 */
export async function gradeMoundOutcomes(): Promise<{ graded: number }> {
  const snapshot = getMoundSnapshot();
  if (!snapshot) return { graded: 0 };

  let graded = 0;

  for (const signal of Array.from(snapshot.signals.values())) {
    if (signal.gameStatus !== "final" || signal.status === "graded") continue;

    // Season baseline inputs are re-derived from the diagnostics stamped at
    // build time (finalScoreCap/rawInputsAvailable don't carry the raw rate —
    // approximate from diagnostics' pitcherSkillScore is NOT used here; the
    // true season rate is refetched from the live cache so settlement always
    // uses current season stats, not a stale build-time snapshot).
    const { mlbPlayerCache } = await import("../../dataPullService");
    const seasonStats = mlbPlayerCache.pitcherSeasonStats[signal.pitcherId] ?? null;
    const seasonAvgInningsPerStart =
      seasonStats?.gamesStarted != null && seasonStats.gamesStarted > 0 && seasonStats?.inningsPitched != null
        ? seasonStats.inningsPitched / seasonStats.gamesStarted
        : null;

    const outcome = resolveMoundOutcome(signal, seasonStats?.kPer9 ?? null, seasonAvgInningsPerStart);
    if (!outcome) continue;

    signal.outcomes = outcome;
    signal.status = "graded";
    graded++;

    console.log(
      `[MLB_PREGAME_OUTCOME_SETTLED] ${signal.signalId} market=${signal.primaryMarket} ` +
        `k=${outcome.finalStrikeouts} outs=${outcome.finalOutsRecorded} baseline=${outcome.seasonBaselineValue} outcome=${outcome.outcome}`,
    );

    try {
      await storage.upsertMlbMoundRadarSignal({
        signalId: signal.signalId,
        buildId: signal.buildId,
        sessionDate: signal.sessionDate,
        gameId: signal.gameId,
        gameDate: signal.gameDate,
        startsAt: signal.startsAt ?? null,
        gameStatus: signal.gameStatus,
        firstPitchLockEligible: signal.firstPitchLockEligible,
        pitcherId: signal.pitcherId,
        pitcherName: signal.pitcherName,
        team: signal.team,
        opponent: signal.opponent,
        opposingLineupConfirmed: signal.opposingLineupConfirmed,
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
        everPubliclyFlagged: signal.everPubliclyFlagged,
        becameLiveReady: signal.becameLiveReady,
        becameLiveFire: signal.becameLiveFire,
        convertedLiveAt: signal.convertedLiveAt ? new Date(signal.convertedLiveAt) : null,
        lockedAt: signal.lockedAt ? new Date(signal.lockedAt) : null,
        gradedAt: new Date(),
      });
    } catch (err: any) {
      console.warn(`[MLB_PREGAME_OUTCOME_SETTLED] persist failed ${signal.signalId}:`, err?.message);
    }
  }

  return { graded };
}

/** Mound Radar Record + admin calibration rollup. */
export function getMoundCalibrationRecord(): MoundCalibrationRecord {
  const snapshot = getMoundSnapshot();
  const all = snapshot ? Array.from(snapshot.signals.values()) : [];
  const graded = all.filter((s) => s.status === "graded" && s.outcomes);

  let wins = 0;
  let calibrationMisses = 0;
  let internalWins = 0;

  for (const s of graded) {
    const o = s.outcomes!;
    if (o.outcome === "mound_win") {
      if (o.userVisible === true) wins++;
      else internalWins++;
    } else if (o.outcome === "mound_calibration_miss") {
      calibrationMisses++;
    }
  }

  const publicGraded = graded.filter((s) => s.everPubliclyFlagged && s.outcomes?.outcome != null).length;

  return {
    wins,
    calibrationMisses,
    internalWins,
    totalGraded: graded.length,
    winRate: publicGraded > 0 ? Math.round((wins / publicGraded) * 1000) / 10 : null,
  };
}
