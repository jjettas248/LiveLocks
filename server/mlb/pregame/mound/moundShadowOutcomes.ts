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
import { mlbGameCache, getPitcherAppearanceOrder } from "../../dataPullService";
import { getMoundSnapshot } from "./mlbMoundRadarStore";
import { deriveMoundOutcome, isMoundOutcomeGradeableNow, hasPitcherBeenPulled } from "./moundOutcomeAttribution";
import { computeAvgInningsPerStart } from "./scoreUtils";
import { computeMoundGradingMeasurements } from "./evaluationSnapshot";
import type { MoundOutcome, MoundSignal } from "./types";
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
 * For a mound_win already graded live (gradedLive: true) and now that this
 * pitcher's outing is complete (pulled, or the whole game went final): pull
 * the latest box-score line and refresh ONLY the raw counting stats (final
 * Ks/outs/BB/ER) + resolvedAt.
 *
 * Deliberately does NOT re-derive outcome/userVisible/seasonBaselineValue —
 * those decided the win and are locked in at the moment it was granted. The
 * counting stats (strikeouts, outs recorded) are monotonic-safe to refresh
 * because they only ever climb, but the season baseline they were compared
 * against is refetched live each tick and can drift (e.g. the pitcher's
 * season K/9 cache updates from an earlier game finalizing mid-day) —
 * re-deriving the outcome against a shifted baseline risks silently
 * revoking an already-public win, which this codebase's settlement
 * philosophy (a calibration_miss is never a public loss) treats as strictly
 * worse than a display number that lags until final.
 */
function refreshMoundWinCountingStats(signal: MoundSignal): MoundOutcome | null {
  const box = mlbGameCache.gamePitchingBoxScore[signal.gameId];
  const line = box?.byPitcherId?.[signal.pitcherId];
  if (!line || !signal.outcomes) return null;

  return {
    ...signal.outcomes,
    finalStrikeouts: line.strikeOuts,
    finalOutsRecorded: line.outsRecorded,
    finalBaseOnBalls: line.baseOnBalls,
    finalEarnedRuns: line.earnedRuns,
    resolvedAt: new Date().toISOString(),
    gradedLive: false,
  };
}

/**
 * Persist a signal's current in-memory state. `gradedAt` is passed through
 * as-is — callers pass `new Date()` only on the tick that first sets
 * `status: "graded"`, and `null` on a later counting-stat refresh, so the
 * upsert's `COALESCE(excluded.graded_at, existing)` (storage.ts) preserves
 * the original first-graded timestamp instead of sliding it forward.
 */
async function persistMoundSignal(signal: MoundSignal, gradedAt: Date | null): Promise<void> {
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
    moundDirection: signal.moundDirection,
    becameLiveReady: signal.becameLiveReady,
    becameLiveFire: signal.becameLiveFire,
    convertedLiveAt: signal.convertedLiveAt ? new Date(signal.convertedLiveAt) : null,
    lockedAt: signal.lockedAt ? new Date(signal.lockedAt) : null,
    gradedAt,
  });
}

/**
 * Single grading pass over the current snapshot. Updates in-memory signals
 * and persists them. Never throws into runtime. Runs on its own interval —
 * NOT chained inside gradePregameOutcomes() — independent failure isolation
 * from Plate's grader.
 */
export async function gradeMoundOutcomes(): Promise<{ graded: number; refreshed: number }> {
  const snapshot = getMoundSnapshot();
  if (!snapshot) return { graded: 0, refreshed: 0 };

  let graded = 0;
  let refreshed = 0;

  // Rehydrate durable state from the DB before grading: the two boolean
  // flags AND moundDirection are all OR/sticky-upsert-protected columns
  // (storage.ts) — the in-memory snapshot alone can be missing carry-forward
  // history (e.g. a process restart left this game's first post-restart
  // build with no prevSignals to pin against, so a fresh rebuild could
  // recompute a DIFFERENT direction than what was actually shown pre-game).
  // Best-effort: grading still proceeds on in-memory-only state if this
  // read fails.
  let persistedState = new Map<string, { everPubliclyFlagged: boolean; everPubliclyFlaggedFade: boolean; moundDirection: MoundDirection }>();
  try {
    const rows = await storage.getMlbMoundRadarSignalsByDate(snapshot.sessionDate);
    persistedState = new Map(
      rows.map((r) => [
        r.signalId,
        {
          everPubliclyFlagged: r.everPubliclyFlagged,
          everPubliclyFlaggedFade: r.everPubliclyFlaggedFade,
          moundDirection: (r.moundDirection as MoundDirection) ?? null,
        },
      ]),
    );
  } catch (err: any) {
    console.warn(`[MLB_PREGAME_OUTCOME_SETTLED] durable-state rehydration failed date=${snapshot.sessionDate}:`, err?.message ?? err);
  }

  for (const signal of Array.from(snapshot.signals.values())) {
    // A live-graded mound_win is terminal for classification but still
    // awaiting its final counting-stat refresh — everything else that's
    // already "graded" (final-graded wins, fade wins, misses) is fully done.
    const pendingLiveWinRefresh = signal.status === "graded" && signal.outcomes?.gradedLive === true;
    if (signal.status === "graded" && !pendingLiveWinRefresh) continue;

    // Grading needs box-score data, which only exists once the game is live
    // or final — skip pre-game signals outright (cheaper than fetching
    // season stats below for every scheduled game on every 5-min tick).
    const isFinal = signal.gameStatus === "final";
    if (!isFinal && signal.gameStatus !== "live") continue;

    // A pitcher's own outing can be certainly over well before the whole
    // game reaches final (bullpen innings can run for hours afterward) —
    // see hasPitcherBeenPulled's doc comment. Only meaningful to check while
    // live; a final game is already outingComplete regardless.
    const pitcherPulled =
      !isFinal &&
      hasPitcherBeenPulled(signal.pitcherId, getPitcherAppearanceOrder(signal.gameId, signal.team));
    const outingComplete = isFinal || pitcherPulled;

    if (pendingLiveWinRefresh) {
      // No point re-fetching the line repeatedly while the pitcher is still
      // actively in the game — only refresh once their outing is over.
      if (!outingComplete) continue;
      const refreshedOutcome = refreshMoundWinCountingStats(signal);
      if (!refreshedOutcome) continue; // box score not available this tick — retry next tick, stays "graded"+gradedLive
      signal.outcomes = refreshedOutcome;
      refreshed++;
      console.log(
        `[MLB_PREGAME_OUTCOME_REFRESHED] ${signal.signalId} market=${signal.primaryMarket} ` +
          `k=${refreshedOutcome.finalStrikeouts} outs=${refreshedOutcome.finalOutsRecorded}`,
      );
      try {
        await persistMoundSignal(signal, null);
      } catch (err: any) {
        console.warn(`[MLB_PREGAME_OUTCOME_REFRESHED] persist failed ${signal.signalId}:`, err?.message);
      }
      continue;
    }

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
    } else if (signal.moundDirection !== "follow" && persisted?.moundDirection === "follow" && persisted.everPubliclyFlagged === true) {
      signal.moundDirection = "follow";
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

    // See isMoundOutcomeGradeableNow's doc comment: a Follow/Over mound_win
    // is monotonic-safe to grade live; everything else waits for outingComplete
    // (game final OR this pitcher already pulled).
    if (!isMoundOutcomeGradeableNow(outingComplete, outcome.outcome)) continue;

    // gradedLive (needs a later counting-stat refresh) only applies to a win
    // granted mid-outing via the monotonic-safe path — a win/miss graded at
    // outingComplete already reflects this pitcher's true final line, since
    // pulled/final both mean their Ks/outs can no longer change.
    const gradedLive = !outingComplete && outcome.outcome === "mound_win";
    signal.outcomes = { ...outcome, gradedLive };
    signal.status = "graded";
    graded++;

    // Research instrumentation (§7b, three separate measurements) — shadow-
    // only, computed alongside but never altering the public classification
    // above. gradingMeasurements is sticky (only ever set on this, the first
    // grading transition — this branch is unreachable for an already-graded
    // signal). Falls back to the existing live-refetched seasonBaselineValue,
    // tagged legacyMovingBaseline, only when no frozen baseline was captured.
    try {
      const finalPregameSnapshot = signal.diagnostics.evaluation?.finalPregameSnapshot ?? null;
      const gradingMeasurements = computeMoundGradingMeasurements(
        signal.primaryMarket,
        signal.moundDirection,
        finalPregameSnapshot,
        outcome.finalStrikeouts ?? null,
        outcome.finalOutsRecorded ?? null,
        outcome.seasonBaselineValue ?? null,
      );
      if (signal.diagnostics.evaluation) {
        signal.diagnostics.evaluation.gradingMeasurements = gradingMeasurements;
      }
    } catch (err: any) {
      console.warn(`[MOUND_RADAR_EVALUATION_SNAPSHOT] grading measurement failed ${signal.signalId}:`, err?.message ?? err);
    }

    console.log(
      `[MLB_PREGAME_OUTCOME_SETTLED] ${signal.signalId} market=${signal.primaryMarket} ` +
        `k=${outcome.finalStrikeouts} outs=${outcome.finalOutsRecorded} baseline=${outcome.seasonBaselineValue} ` +
        `outcome=${outcome.outcome} gradedLive=${gradedLive} pitcherPulled=${pitcherPulled}`,
    );

    try {
      await persistMoundSignal(signal, new Date());
    } catch (err: any) {
      console.warn(`[MLB_PREGAME_OUTCOME_SETTLED] persist failed ${signal.signalId}:`, err?.message);
    }
  }

  return { graded, refreshed };
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
