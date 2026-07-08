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
import { computeAvgInningsPerStart } from "./scoreUtils";
import type { MoundOutcome, MoundSignal, MoundDiagnostics } from "./types";
import type { MoundDirection } from "./moundDirection";
import type { MoundCalibrationRecord } from "../../../../shared/moundRadarWin";

/**
 * Resolve final-game pitching-box-score outcome for a target, when available,
 * and stamp the outcome-attribution result (mound_win vs mound_calibration_miss).
 *
 * everPubliclyFlagged/everPubliclyFlaggedFade are passed in ALREADY REHYDRATED
 * from the DB's durable, OR-upsert-protected values (see gradeMoundOutcomes)
 * rather than read off `signal` directly — the in-memory snapshot alone can
 * be missing carry-forward history after a process restart (no prevSignals
 * to OR against on that game's first post-restart build), which would
 * otherwise silently understamp userVisible for a legitimately-flagged pick.
 */
function resolveMoundOutcome(
  signal: MoundSignal,
  seasonKPer9: number | null,
  seasonAvgInningsPerStart: number | null,
  everPubliclyFlagged: boolean,
  everPubliclyFlaggedFade: boolean,
): MoundOutcome | null {
  const box = mlbGameCache.gamePitchingBoxScore[signal.gameId];
  const line = box?.byPitcherId?.[signal.pitcherId];
  if (!line) return null;

  // everPubliclyFlagged's underlying predicate (wasPubliclyFlaggedMound)
  // structurally excludes "track" tier, so a Fade-direction signal must be
  // checked against its own parallel flag (everPubliclyFlaggedFade) —
  // otherwise a correct Fade call could never become userVisible.
  const wasPubliclyFlagged = signal.moundDirection === "fade" ? everPubliclyFlaggedFade : everPubliclyFlagged;

  const attribution = deriveMoundOutcome({
    primaryMarket: signal.primaryMarket,
    finalStrikeouts: line.strikeOuts,
    finalOutsRecorded: line.outsRecorded,
    seasonKPer9,
    seasonAvgInningsPerStart,
    wasPubliclyFlagged,
    // Read as-stamped at build time — never recomputed here (see
    // moundDirection.ts's discipline comment).
    moundDirection: signal.moundDirection,
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

  // Rehydrate durable state from the DB before grading: the two boolean
  // flags (OR-upsert-protected, storage.ts) AND the stamped moundDirection
  // (embedded in the persisted diagnostics blob) — the in-memory snapshot
  // alone can be missing carry-forward history (e.g. a process restart left
  // this game's first post-restart build with no prevSignals to pin
  // against, so a fresh rebuild could recompute a DIFFERENT direction than
  // what was actually shown pre-game). Best-effort: grading still proceeds
  // on in-memory-only state if this read fails.
  let persistedState = new Map<string, { everPubliclyFlagged: boolean; everPubliclyFlaggedFade: boolean; moundDirection: MoundDirection }>();
  try {
    const rows = await storage.getMlbMoundRadarSignalsByDate(snapshot.sessionDate);
    persistedState = new Map(
      rows.map((r) => [
        r.signalId,
        {
          everPubliclyFlagged: r.everPubliclyFlagged,
          everPubliclyFlaggedFade: r.everPubliclyFlaggedFade,
          moundDirection: (r.diagnostics as MoundDiagnostics | null)?.moundDirection ?? null,
        },
      ]),
    );
  } catch (err: any) {
    console.warn(`[MLB_PREGAME_OUTCOME_SETTLED] durable-state rehydration failed date=${snapshot.sessionDate}:`, err?.message ?? err);
  }

  for (const signal of Array.from(snapshot.signals.values())) {
    if (signal.gameStatus !== "final" || signal.status === "graded") continue;

    // Season baseline inputs are re-derived from the diagnostics stamped at
    // build time (finalScoreCap/rawInputsAvailable don't carry the raw rate —
    // approximate from diagnostics' pitcherSkillScore is NOT used here; the
    // true season rate is refetched from the live cache so settlement always
    // uses current season stats, not a stale build-time snapshot).
    const { mlbPlayerCache } = await import("../../dataPullService");
    const seasonStats = mlbPlayerCache.pitcherSeasonStats[signal.pitcherId] ?? null;
    const seasonAvgInningsPerStart = computeAvgInningsPerStart(seasonStats?.gamesStarted, seasonStats?.inningsPitched);

    const persisted = persistedState.get(signal.signalId);

    // Pin the persisted direction FIRST (before computing the flags below,
    // same ordering discipline as carryForwardMoundGradedState's in-memory
    // sticky-pin) — once a signal was legitimately shown with a direction,
    // a later rebuild recomputing a different one must not silently flip
    // which settlement rule it grades against.
    if (signal.moundDirection !== "fade" && persisted?.moundDirection === "fade" && persisted.everPubliclyFlaggedFade === true) {
      signal.moundDirection = "fade";
      signal.diagnostics.moundDirection = "fade";
    } else if (signal.moundDirection !== "follow" && persisted?.moundDirection === "follow" && persisted.everPubliclyFlagged === true) {
      signal.moundDirection = "follow";
      signal.diagnostics.moundDirection = "follow";
    }

    const everPubliclyFlagged = signal.everPubliclyFlagged || (persisted?.everPubliclyFlagged ?? false);
    const everPubliclyFlaggedFade = signal.everPubliclyFlaggedFade || (persisted?.everPubliclyFlaggedFade ?? false);
    // Self-heal the in-memory snapshot too, not just this grading pass — a
    // later re-read of the same in-memory signal (stats service, another
    // grading tick) should see the rehydrated state as well.
    signal.everPubliclyFlagged = everPubliclyFlagged;
    signal.everPubliclyFlaggedFade = everPubliclyFlaggedFade;

    const outcome = resolveMoundOutcome(signal, seasonStats?.kPer9 ?? null, seasonAvgInningsPerStart, everPubliclyFlagged, everPubliclyFlaggedFade);
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
        everPubliclyFlaggedFade: signal.everPubliclyFlaggedFade,
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
  // Fully separate from wins/internalWins above — never blended.
  let fadeWins = 0;
  let internalFadeWins = 0;

  for (const s of graded) {
    const o = s.outcomes!;
    if (o.outcome === "mound_win") {
      if (o.userVisible === true) wins++;
      else internalWins++;
    } else if (o.outcome === "mound_fade_win") {
      if (o.userVisible === true) fadeWins++;
      else internalFadeWins++;
    } else if (o.outcome === "mound_calibration_miss") {
      calibrationMisses++;
    }
  }

  const publicGraded = graded.filter((s) => s.everPubliclyFlagged && s.outcomes?.outcome != null).length;

  return {
    wins,
    calibrationMisses,
    internalWins,
    fadeWins,
    internalFadeWins,
    totalGraded: graded.length,
    winRate: publicGraded > 0 ? Math.round((wins / publicGraded) * 1000) / 10 : null,
  };
}
