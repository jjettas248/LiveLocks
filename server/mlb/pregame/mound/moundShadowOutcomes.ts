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
import {
  deriveMoundOutcome,
  deriveMoundMarketOutcome,
  isMoundOutcomeGradeableNow,
  hasPitcherBeenPulled,
  resolveMoundSettlementDirection,
  resolveMoundSettlementLane,
} from "./moundOutcomeAttribution";
import { computeMoundGradingMeasurements } from "./evaluationSnapshot";
import { deriveFrozenMoundMarketRecommendation } from "./marketRecommendation";
import type { MoundOutcome, MoundSignal, MoundEvaluationSnapshot } from "./types";
import type { MoundDirection } from "./moundDirection";
import type { MoundCalibrationRecord } from "../../../../shared/moundRadarWin";

/**
 * Stamp real-market settlement fields onto the same outcome object as the
 * engine-baseline classification. The two decisions are intentionally
 * independent:
 *
 *   model read:   moundDirection (Follow/Fade vs stable season baseline)
 *   market read:  frozen matchup projection vs frozen sportsbook line
 *
 * A Follow can therefore legitimately produce an UNDER market read, and a
 * Fade can produce an OVER read. The market side is derived exclusively from
 * the final pregame snapshot and can never drift at grading time.
 */
function stampMarketOutcome(
  outcome: MoundOutcome,
  signal: MoundSignal,
  finalPregameSnapshot: MoundEvaluationSnapshot | null,
  isPublicRecommendation: boolean,
): MoundOutcome {
  // Strikeouts is the sole settlement market, regardless of this card's Best
  // Angle badge (signal.primaryMarket) — see moundOutcomeAttribution.ts's
  // header comment.
  const settlementMarket = "pitcher_strikeouts" as const;
  const frozenLine = finalPregameSnapshot?.champion.postedLine.strikeouts ?? null;
  const actual = outcome.finalStrikeouts ?? null;
  const recommendation = deriveFrozenMoundMarketRecommendation(settlementMarket, finalPregameSnapshot);

  // deriveMoundMarketOutcome's input type predates the separation and names the
  // side carrier `moundDirection`. Adapt the frozen MARKET side only; never pass
  // the signal's actual Follow/Fade model read into market settlement.
  const marketSettlementDirection: MoundDirection =
    recommendation.side === "OVER" ? "follow" : recommendation.side === "UNDER" ? "fade" : null;

  const market = deriveMoundMarketOutcome({
    moundDirection: marketSettlementDirection,
    frozenLine,
    lineFrozenAt: finalPregameSnapshot?.frozenAt ?? null,
    actual,
  });

  const lane = resolveMoundSettlementLane(market.marketOutcome, market.marketUnavailableReason, isPublicRecommendation);

  // Bounded: one line per graded signal, at stamp time — never per render.
  // bestAngle is logged alongside the fixed settlement market so admins can
  // still see when a K-graded result came from an Outs-Best-Angle card.
  console.log(
    `[MOUND_SETTLEMENT] ${signal.signalId} pitcher=${signal.pitcherId} game=${signal.gameId} ` +
      `market=${settlementMarket} bestAngle=${signal.primaryMarket} public=${isPublicRecommendation} lane=${lane} ` +
      `officialSide=${market.recommendedSide ?? "none"} frozenLine=${market.sportsbookLine ?? "none"} ` +
      `finalStat=${actual ?? "none"} outcome=${market.marketOutcome} reason=${market.marketUnavailableReason ?? "none"}`,
  );

  if (lane === "integrity_gap") {
    console.warn(
      `[MOUND_SETTLEMENT_INTEGRITY] ${signal.signalId} pitcher=${signal.pitcherId} game=${signal.gameId} ` +
        `publicRecommendation=true reason=${market.marketUnavailableReason} ` +
        `missingSide=${market.recommendedSide == null} missingLine=${market.sportsbookLine == null} ` +
        `missingSnapshot=${finalPregameSnapshot == null} market=${settlementMarket}`,
    );
  }

  return {
    ...outcome,
    marketOutcome: market.marketOutcome,
    sportsbookLine: market.sportsbookLine,
    recommendedSide: market.recommendedSide,
    lineSnapshotType: market.lineSnapshotType,
    lineFrozenAt: market.lineFrozenAt,
    lineSource: market.lineSource,
    marketUnavailableReason: market.marketUnavailableReason,
  };
}

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
  everPubliclyFlagged: boolean,
  everPubliclyFlaggedFade: boolean,
): MoundOutcome | null {
  const box = mlbGameCache.gamePitchingBoxScore[signal.gameId];
  const line = box?.byPitcherId?.[signal.pitcherId];
  if (!line) return null;

  // Durable public exposure decides which model rule applies — NOT the
  // recomputable moundDirection column, which a post-first-pitch rebuild can
  // flip to "fade" on a card that was publicly surfaced as a Follow (see
  // resolveMoundSettlementDirection). Grading off the raw column inverts that
  // card's outcome. Affects the MODEL read only; sportsbook side still comes
  // exclusively from the frozen pregame recommendation (stampMarketOutcome).
  const settlementDirection = resolveMoundSettlementDirection({
    moundDirection: signal.moundDirection,
    everPubliclyFlagged,
    everPubliclyFlaggedFade,
  });
  const wasPubliclyFlagged = settlementDirection === "fade" ? everPubliclyFlaggedFade : everPubliclyFlagged;

  // Strikeouts is the sole official settlement market — see
  // moundOutcomeAttribution.ts's header comment. signal.primaryMarket (Best
  // Angle) is display-only and never selects the grading input here.
  const attribution = deriveMoundOutcome({
    finalStrikeouts: line.strikeOuts,
    seasonKPer9,
    wasPubliclyFlagged,
    moundDirection: settlementDirection,
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
    settledDirection: settlementDirection,
  };
}

/**
 * For a mound_win already graded live (gradedLive: true) and now that this
 * pitcher's outing is complete (pulled, or the whole game went final): pull
 * the latest box-score line and refresh ONLY the raw counting stats (final
 * Ks/outs/BB/ER) + resolvedAt.
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

/** Persist a signal's current in-memory state. */
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
    // Durable public-exposure state and the pinned MODEL direction are needed
    // by every branch below (including the live-win refresh), so they are
    // rehydrated once, up front, rather than only on the fresh-grade path.
    const persisted = persistedState.get(signal.signalId);

    // Pin the persisted MODEL direction before anything grades against it.
    if (signal.moundDirection !== "fade" && persisted?.moundDirection === "fade" && persisted.everPubliclyFlaggedFade === true) {
      signal.moundDirection = "fade";
    } else if (signal.moundDirection !== "follow" && persisted?.moundDirection === "follow" && persisted.everPubliclyFlagged === true) {
      signal.moundDirection = "follow";
    }

    const everPubliclyFlagged = signal.everPubliclyFlagged || (persisted?.everPubliclyFlagged ?? false);
    const everPubliclyFlaggedFade = signal.everPubliclyFlaggedFade || (persisted?.everPubliclyFlaggedFade ?? false);
    signal.everPubliclyFlagged = everPubliclyFlagged;
    signal.everPubliclyFlaggedFade = everPubliclyFlaggedFade;

    const settlementDirection = resolveMoundSettlementDirection({
      moundDirection: signal.moundDirection,
      everPubliclyFlagged,
      everPubliclyFlaggedFade,
    });
    const isPublicRecommendation = settlementDirection === "fade" ? everPubliclyFlaggedFade : everPubliclyFlagged;

    const pendingLiveWinRefresh = signal.status === "graded" && signal.outcomes?.gradedLive === true;
    // A row already settled under a direction that durable public exposure
    // contradicts was graded by the wrong rule (see
    // resolveMoundSettlementDirection). Re-settle it from the SAME recorded
    // facts — final stats and season baseline are untouched, only the
    // comparison rule is corrected. Never invents data, and converges (once
    // repaired, settledDirection matches and this stops firing).
    const settledUnder = signal.outcomes?.settledDirection ?? signal.moundDirection;
    const needsDirectionRepair =
      signal.status === "graded" &&
      signal.outcomes != null &&
      !pendingLiveWinRefresh &&
      settledUnder !== settlementDirection;
    if (signal.status === "graded" && !pendingLiveWinRefresh && !needsDirectionRepair) continue;

    const isFinal = signal.gameStatus === "final";
    if (!isFinal && signal.gameStatus !== "live") continue;

    const pitcherPulled =
      !isFinal &&
      hasPitcherBeenPulled(signal.pitcherId, getPitcherAppearanceOrder(signal.gameId, signal.team));
    const outingComplete = isFinal || pitcherPulled;

    if (pendingLiveWinRefresh) {
      if (!outingComplete) continue;
      const refreshedOutcome = refreshMoundWinCountingStats(signal);
      if (!refreshedOutcome) continue;
      signal.outcomes = refreshedOutcome;
      refreshed++;
      console.log(
        `[MLB_PREGAME_OUTCOME_REFRESHED] ${signal.signalId} market=${signal.primaryMarket} ` +
          `k=${refreshedOutcome.finalStrikeouts} outs=${refreshedOutcome.finalOutsRecorded}`,
      );

      try {
        const finalPregameSnapshot = signal.diagnostics.evaluation?.finalPregameSnapshot ?? null;
        const gradingMeasurements = computeMoundGradingMeasurements(
          signal.primaryMarket,
          settlementDirection,
          finalPregameSnapshot,
          refreshedOutcome.finalStrikeouts ?? null,
          refreshedOutcome.finalOutsRecorded ?? null,
          refreshedOutcome.seasonBaselineValue ?? null,
        );
        if (signal.diagnostics.evaluation) {
          signal.diagnostics.evaluation.gradingMeasurements = gradingMeasurements;
        }
        signal.outcomes = stampMarketOutcome(signal.outcomes, signal, finalPregameSnapshot, isPublicRecommendation);
      } catch (err: any) {
        console.warn(`[MOUND_RADAR_EVALUATION_SNAPSHOT] grading measurement failed (refresh) ${signal.signalId}:`, err?.message ?? err);
      }

      try {
        await persistMoundSignal(signal, null);
      } catch (err: any) {
        console.warn(`[MLB_PREGAME_OUTCOME_REFRESHED] persist failed ${signal.signalId}:`, err?.message);
      }
      continue;
    }

    const { mlbPlayerCache } = await import("../../dataPullService");
    const seasonStats = mlbPlayerCache.pitcherSeasonStats[signal.pitcherId] ?? null;

    const outcome = resolveMoundOutcome(signal, seasonStats?.kPer9 ?? null, everPubliclyFlagged, everPubliclyFlaggedFade);
    if (!outcome) continue;

    if (needsDirectionRepair) {
      console.warn(
        `[MOUND_SETTLEMENT_DIRECTION_REPAIR] ${signal.signalId} pitcher=${signal.pitcherId} game=${signal.gameId} ` +
          `settledUnder=${settledUnder ?? "null"} resolved=${settlementDirection} ` +
          `everPubliclyFlagged=${everPubliclyFlagged} everPubliclyFlaggedFade=${everPubliclyFlaggedFade} ` +
          `was=${signal.outcomes?.outcome} now=${outcome.outcome}`,
      );
    }

    if (!isMoundOutcomeGradeableNow(outingComplete, outcome.outcome)) continue;

    const gradedLive = !outingComplete && outcome.outcome === "mound_win";
    signal.outcomes = { ...outcome, gradedLive };
    signal.status = "graded";
    graded++;

    if (!gradedLive) {
      try {
        const finalPregameSnapshot = signal.diagnostics.evaluation?.finalPregameSnapshot ?? null;
        const gradingMeasurements = computeMoundGradingMeasurements(
          signal.primaryMarket,
          settlementDirection,
          finalPregameSnapshot,
          outcome.finalStrikeouts ?? null,
          outcome.finalOutsRecorded ?? null,
          outcome.seasonBaselineValue ?? null,
        );
        if (signal.diagnostics.evaluation) {
          signal.diagnostics.evaluation.gradingMeasurements = gradingMeasurements;
        }
        signal.outcomes = stampMarketOutcome(signal.outcomes!, signal, finalPregameSnapshot, isPublicRecommendation);
      } catch (err: any) {
        console.warn(`[MOUND_RADAR_EVALUATION_SNAPSHOT] grading measurement failed ${signal.signalId}:`, err?.message ?? err);
      }
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
