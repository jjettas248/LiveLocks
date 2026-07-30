// Mound Radar — build orchestration.
//
// Scans today's slate, assembles per-probable-starter inputs from shared MLB
// data services (never fabricated), scores them, and writes the in-memory
// snapshot. Guarded against concurrent builds; everything try/catch so it can
// never crash runtime. Mirrors pregamePowerRadar/buildPregamePowerRadar.ts's
// orchestration shape — independent implementation, no imports from Plate's
// scoring/driver files. Reused (generic, non-scoring) infra: game discovery,
// roster reads (lineups/starters/player handedness), weather, park lookup,
// date handling.

import { randomUUID } from "crypto";
import { slateDateET } from "../../../utils/dateUtils";
import { discoverTodaysGames } from "../../gameDiscoveryService";
import {
  getStartingLineup,
  getStartingPitcher,
  getPlayer,
  updateStartingLineups,
  updateStartingPitchers,
} from "../../rosterService";
import { getVenueParkFactors, isVenueIndoors, fetchBaseballSavantData } from "../../dataSources";
import {
  fetchPitcherHandednessSplits,
  fetchPitcherRecentStarts,
  syncPitcherSeasonStats,
  syncPitcherMultiYearStats,
  syncBvPMatchup,
  syncWeather,
  mlbGameCache,
  mlbPlayerCache,
} from "../../dataPullService";
import { classifyPitcherArchetype } from "../../archetypes";
import { resolveMLBOddsEventId, resolveMLBOddsEventIdFromCache, getMLBPlayerOdds } from "../../../oddsService";
import { readOddsSnapshot } from "../../../odds/oddsCache";
import type {
  MoundSignal,
  MoundGameStatus,
  MoundLineupStatus,
  MoundWeatherStatus,
  MoundDriver,
} from "./types";
import { computePitcherSkill } from "./pitcherSkill";
import { computeOpponentKProfile } from "./opponentKProfile";
import { fetchOpponentLineupKProfile } from "./opponentBatterKProfile";
import { computeWorkload } from "./workload";
import { computeRunEnvironment } from "./runEnvironment";
import { computeRecentForm } from "./recentForm";
import { computeRiskDrivers } from "./riskDrivers";
import { computeContactRisk } from "./contactRisk";
import { computeMarketTags } from "./marketTagger";
import { computeKProjectionLabel } from "./kProjectionLabel";
import { computeKLineValue } from "./kLineValue";
import { composeMoundScore } from "./scoring";
import { computeMoundDirection } from "./moundDirection";
import { projectedStrikeoutsFromKPer9, computeAvgInningsPerStart } from "./scoreUtils";
import { computeMatchupAdjustedStrikeouts } from "./matchupAdjustedKs";
import { buildMoundMarketEdgeContext, pickBestUnderBook } from "./oddsDisplay";
import { carryForwardMoundGradedState, carryForwardDroppedFromMound } from "./moundGradedStateCarry";
import { applyMoundEvaluationSnapshots } from "./evaluationSnapshot";
import { aggregateRawPitcherContactSnapshot, type RawContactSupportingInputs, type RawPitcherContactSnapshot } from "./rawPitcherContactSnapshot";
import { isMoundV2ShadowEnabled } from "./v2/moundV2ShadowFlags";
import { MOUND_V1_MODEL_VERSION, MOUND_V2_MODEL_VERSION } from "./v2/moundV2ShadowEvaluation";
import { runMoundV2ShadowForPitcher } from "./v2/moundV2ShadowRunner";
import type { FrozenMoundBatterInput, MoundFrozenDataQuality } from "./v2/frozenMoundShadowInput";

/**
 * Builds RawContactSupportingInputs from the already-resolved seasonStats/
 * recentStarts objects. Exported as a thin, directly-testable extraction of
 * exactly the expressions used in the per-pitcher build loop below — so a
 * test can exercise this REAL construction (not a hand-mirrored copy) without
 * running the full build orchestrator. seasonStatsAvailable/recentStartsAvailable
 * intentionally reuse the identical `!= null` checks the existing
 * rawInputsAvailable.pitcherSeasonStats/.pitcherRecentStarts diagnostics use.
 */
export function buildRawContactSupportingInputs(
  seasonStats: { inningsPitched: number | null; homeRunsAllowed: number | null; bbPer9: number | null } | null,
  recentStarts: { ipVarianceLast3: number | null } | null,
): RawContactSupportingInputs {
  return {
    seasonStatsAvailable: seasonStats != null,
    inningsPitchedSeason: seasonStats?.inningsPitched ?? null,
    homeRunsAllowedSeason: seasonStats?.homeRunsAllowed ?? null,
    bb9Season: seasonStats?.bbPer9 ?? null,
    recentStartsAvailable: recentStarts != null,
    ipVarianceLast3: recentStarts?.ipVarianceLast3 ?? null,
  };
}
import {
  getMoundSnapshot,
  setMoundSnapshot,
  type MoundRadarSnapshot,
} from "./mlbMoundRadarStore";

let isMoundRadarBuildRunning = false;

/** Optional DB sink — mirrors Plate's PregameBuildSink pattern. */
export type MoundBuildSink = (
  signals: MoundSignal[],
  manifest: {
    buildId: string;
    sessionDate: string;
    startedAt: string;
    completedAt: string;
    gamesScanned: number;
    pitchersEvaluated: number;
    starterCoverage: number;
    weatherCoverage: number;
    pitcherCoverage: number;
    lineupCoverage: number;
    signalsCreated: number;
    suppressedCount: number;
  },
) => Promise<void>;

let buildSink: MoundBuildSink | null = null;
export function setMoundBuildSink(sink: MoundBuildSink): void {
  buildSink = sink;
}

function mapGameStatus(espnStatus: string | undefined): MoundGameStatus {
  const s = (espnStatus ?? "").toUpperCase();
  if (s.includes("FINAL")) return "final";
  if (s.includes("IN_PROGRESS") || s.includes("LIVE")) return "live";
  if (s.includes("POSTPONED")) return "postponed";
  if (s.includes("DELAY")) return "delayed";
  if (s.includes("PRE")) return "pre";
  if (s.includes("SCHEDULED")) return "scheduled";
  return "unknown";
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Run a full build. Returns the snapshot it stored (or the previous one if a
 * build is already running). Never throws.
 */
export async function buildMlbMoundRadar(): Promise<MoundRadarSnapshot | null> {
  if (isMoundRadarBuildRunning) {
    console.log("[MLB_PREGAME_MOUND_TARGETS] skipped — build already running");
    return null;
  }
  isMoundRadarBuildRunning = true;
  const startedAt = new Date().toISOString();
  const buildId = `mound_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const sessionDate = slateDateET();
  console.log(`[MLB_PREGAME_MOUND_TARGETS] build start buildId=${buildId} date=${sessionDate}`);

  const prevSnapshot = getMoundSnapshot();
  const prevSignals =
    prevSnapshot && prevSnapshot.sessionDate === sessionDate ? prevSnapshot.signals : null;
  const prevSignalsByGame = new Map<string, MoundSignal[]>();
  if (prevSignals) {
    for (const s of Array.from(prevSignals.values())) {
      const list = prevSignalsByGame.get(s.gameId);
      if (list) list.push(s);
      else prevSignalsByGame.set(s.gameId, [s]);
    }
  }

  const signals = new Map<string, MoundSignal>();
  let gamesScanned = 0;
  let pitchersEvaluated = 0;
  let starterGames = 0;
  let weatherGames = 0;
  let pitcherWithSkill = 0;
  let lineupConfirmedCount = 0;
  let createdPublicEligible = 0;
  let suppressedCount = 0;
  const confirmedLineupScores: number[] = [];
  const seasonRatesByPitcherId = new Map<string, { seasonKPer9: number | null; seasonAvgInningsPerStart: number | null }>();
  const rawContactSnapshotsBySignalId = new Map<string, RawPitcherContactSnapshot>();

  try {
    const games = await discoverTodaysGames();

    if (games.length === 0 && prevSignals && prevSignals.size > 0) {
      console.warn(
        `[MLB_PREGAME_MOUND_EMPTY_DISCOVERY] buildId=${buildId} date=${sessionDate} discovery returned 0 games with ${prevSignals.size} prior signals in memory — preserving existing snapshot`,
      );
      isMoundRadarBuildRunning = false;
      return prevSnapshot;
    }

    for (const game of games) {
      gamesScanned++;
      const gameStatus = mapGameStatus(game.espnStatus);
      const startsAt = game.startTime || null;
      const firstPitchLockEligible = gameStatus === "scheduled" || gameStatus === "pre";

      const gamePk = game.gamePk ?? null;
      if (!gamePk) {
        const carriedOver = carryForwardDroppedFromMound(
          game.gameId,
          new Set(),
          prevSignalsByGame.get(game.gameId) ?? [],
          gameStatus,
          firstPitchLockEligible,
          new Date().toISOString(),
          buildId,
        );
        for (const carried of carriedOver) {
          signals.set(carried.signalId, carried);
          console.log(
            `[MLB_PREGAME_MOUND_SIGNAL_CARRIED] ${carried.signalId} ${carried.pitcherName} game gamePk unresolved this cycle — preserved (status=${carried.status})`,
          );
        }
        continue;
      }

      try {
        await Promise.all([
          updateStartingLineups(gamePk),
          updateStartingPitchers(gamePk),
          syncWeather(gamePk, game.gameId),
        ]);
      } catch {
        /* hydration failures degrade to unavailable below */
      }

      const lineup = getStartingLineup(gamePk);
      const weather = mlbGameCache.weather[game.gameId];
      const venueName = weather?.venueName ?? null;
      const weatherAvailable = !!weather && (weather.temperature != null || weather.windSpeed != null);
      const isIndoors = weather?.isIndoors ?? isVenueIndoors(venueName);
      if (weatherAvailable || isIndoors) weatherGames++;
      const parkFactors = getVenueParkFactors(venueName);

      const homeStarter = getStartingPitcher(`${gamePk}:home`);
      const awayStarter = getStartingPitcher(`${gamePk}:away`);
      const starters = [homeStarter, awayStarter].filter((p): p is NonNullable<typeof p> => !!p);
      if (starters.length > 0) starterGames++;

      let oddsEventId: string | null = resolveMLBOddsEventIdFromCache(game.homeTeam, game.awayTeam);
      if (!oddsEventId) {
        resolveMLBOddsEventId(game.homeTeam, game.awayTeam).catch(() => {});
      }

      for (const starter of starters) {
        pitchersEvaluated++;
        const opposingLineup = lineup.filter((l) => l.team !== starter.team);
        const opposingLineupConfirmed = opposingLineup.length > 0;
        if (opposingLineupConfirmed) lineupConfirmedCount++;

        const opponent =
          Array.from(new Set(opposingLineup.map((l) => l.team)))[0] ??
          (starter.team === game.homeTeam ? game.awayTeam : game.homeTeam);

        // Independent upstream calls run concurrently. Hitter-side K propensity
        // is one cached aggregate call for the confirmed lineup, not an N+1 in
        // the scoring function; internally it fans out once per hitter and then
        // remains cached for subsequent pregame rebuilds.
        const bvpBatterIds = opposingLineupConfirmed ? opposingLineup.map((l) => l.playerId) : [];
        const [, , handSplitsResult, recentStartsResult, savantResult, lineupKResult] = await Promise.allSettled([
          syncPitcherSeasonStats(starter.pitcherId),
          syncPitcherMultiYearStats(starter.pitcherId),
          fetchPitcherHandednessSplits(starter.pitcherId),
          fetchPitcherRecentStarts(starter.pitcherId),
          fetchBaseballSavantData(starter.pitcherId, game.gameId),
          fetchOpponentLineupKProfile(
            opposingLineup.map((l) => ({ playerId: l.playerId, battingOrderSlot: l.battingOrderSlot })),
            starter.throws ?? null,
          ),
          ...bvpBatterIds.map((batterId) => syncBvPMatchup(batterId, starter.pitcherId)),
        ]);
        const seasonStats = mlbPlayerCache.pitcherSeasonStats[starter.pitcherId] ?? null;
        const priorSeasonsKPer9 = mlbPlayerCache.pitcherMultiYearStats[starter.pitcherId]?.priorSeasonsKPer9 ?? [];
        const handSplits = handSplitsResult.status === "fulfilled" ? handSplitsResult.value : null;
        const recentStarts = recentStartsResult.status === "fulfilled" ? recentStartsResult.value : null;
        const savant = savantResult.status === "fulfilled" ? savantResult.value : null;
        const lineupKProfile = lineupKResult.status === "fulfilled" ? lineupKResult.value : null;

        let bvpTotalAtBats = 0;
        let bvpTotalStrikeouts = 0;
        for (const batterId of bvpBatterIds) {
          const bvp = mlbPlayerCache.bvpMatchups[`${batterId}_vs_${starter.pitcherId}`];
          if (bvp) {
            bvpTotalAtBats += bvp.atBats;
            bvpTotalStrikeouts += bvp.strikeouts;
          }
        }

        const strikeoutSnap = oddsEventId
          ? readOddsSnapshot({ sport: "mlb", eventId: oddsEventId, market: "pitcher_strikeouts", player: starter.pitcherName, isLive: false, allowStale: true })
          : null;
        const marketEdgeContext = buildMoundMarketEdgeContext(strikeoutSnap?.books ?? null, strikeoutSnap?.fetchedAt ?? Date.now());
        if (oddsEventId && !strikeoutSnap) {
          getMLBPlayerOdds(oddsEventId, starter.pitcherName, "pitcher_strikeouts", false).catch(() => {});
        }

        const pitcherKnown = true;
        const avgInningsPerStart = computeAvgInningsPerStart(seasonStats?.gamesStarted, seasonStats?.inningsPitched);
        seasonRatesByPitcherId.set(starter.pitcherId, {
          seasonKPer9: seasonStats?.kPer9 ?? null,
          seasonAvgInningsPerStart: avgInningsPerStart,
        });
        const projectedStrikeouts = projectedStrikeoutsFromKPer9(seasonStats?.kPer9);

        const archetype = classifyPitcherArchetype({
          era: seasonStats?.era ?? null,
          whip: seasonStats?.whip ?? null,
          kPer9: seasonStats?.kPer9 ?? null,
          inningsPitched: seasonStats?.inningsPitched ?? null,
          gamesStarted: seasonStats?.gamesStarted ?? null,
          avgInningsPerStart,
        });

        let left = 0, right = 0, switchHit = 0;
        for (const slot of opposingLineup) {
          const p = getPlayer(slot.playerId);
          if (p?.bats === "L") left++;
          else if (p?.bats === "R") right++;
          else if (p?.bats === "S") switchHit++;
        }

        const pitcherSkill = computePitcherSkill({
          pitcherKnown,
          kPer9: seasonStats?.kPer9 ?? null,
          swStrPct: savant?.pitcherSwStrPct ?? null,
          cswPct: savant?.pitcherCswPct ?? null,
          missesBatsFamily: savant?.pitcherMissesBatsFamily ?? null,
        });
        if (pitcherSkill.available) pitcherWithSkill++;

        const opponentKProfile = computeOpponentKProfile({
          pitcherKnown,
          opposingLineupConfirmed,
          kRateVsLHB: handSplits?.kRateVsLHB ?? null,
          kRateVsRHB: handSplits?.kRateVsRHB ?? null,
          opposingLineupHandedness: opposingLineupConfirmed ? { left, right, switchHit } : null,
          lineupBatterKRate: lineupKProfile?.lineupKRate ?? null,
          lineupBatterKCoverage: lineupKProfile?.coverage ?? 0,
          lineupHighKShare: lineupKProfile?.highKShare ?? null,
        });

        const workload = computeWorkload({
          pitcherKnown,
          bbPer9: seasonStats?.bbPer9 ?? null,
          avgInningsPerStart,
          lastStartPitchCount: recentStarts?.lastStartPitchCount ?? null,
          lastStartInningsPitched: recentStarts?.last3StartInningsPitched?.[0] ?? null,
          ipVarianceLast3: recentStarts?.ipVarianceLast3 ?? null,
          archetype,
        });

        const runEnv = computeRunEnvironment({
          venueName,
          parkFactorRuns: parkFactors?.runs ?? null,
          isIndoors,
          weatherAvailable,
          temperatureF: isIndoors ? null : weather?.temperature ?? null,
          windMph: isIndoors ? null : weather?.windSpeed ?? null,
          windDirection: isIndoors ? null : weather?.windDirection ?? null,
        });

        const recentForm = computeRecentForm({
          pitcherKnown,
          seasonKPer9: seasonStats?.kPer9 ?? null,
          last3StartStrikeouts: recentStarts?.last3StartStrikeouts ?? null,
          last3StartERA: recentStarts?.last3StartERA ?? null,
        });

        // The richer projection remains separate from the stable season-baseline
        // model grading, but it now uses the actual pitcher × hitter matchup K
        // rate rather than pitcher splits alone.
        const matchupAdjustedStrikeouts = computeMatchupAdjustedStrikeouts({
          kPer9: seasonStats?.kPer9 ?? null,
          priorSeasonsKPer9,
          avgInningsPerStart,
          platoonKRate: opponentKProfile.matchupKRate,
          opposingLineupConfirmed,
          runEnvironmentScore10: runEnv.available ? runEnv.score10 : null,
          runEnvironmentAvailable: runEnv.available,
          last3StartStrikeouts: recentStarts?.last3StartStrikeouts ?? null,
          bvpTotalAtBats,
          bvpTotalStrikeouts,
        });

        const risk = computeRiskDrivers({
          archetype,
          bbPer9: seasonStats?.bbPer9 ?? null,
          lastStartPitchCount: recentStarts?.lastStartPitchCount ?? null,
          avgInningsPerStart,
          isIndoors,
          windMph: isIndoors ? null : weather?.windSpeed ?? null,
          windDirection: isIndoors ? null : weather?.windDirection ?? null,
          opposingLineupConfirmed,
        });

        const marketTags = computeMarketTags({
          pitcherSkillScore: pitcherSkill.score10,
          opponentKProfileScore: opponentKProfile.score10,
          workloadScore: workload.score10,
        });

        const kProjectionLabel = computeKProjectionLabel(projectedStrikeouts, matchupAdjustedStrikeouts);
        const kLineValue = computeKLineValue(projectedStrikeouts, matchupAdjustedStrikeouts, marketEdgeContext?.line ?? null);

        const contactRisk = computeContactRisk({
          pitcherKnown,
          opposingLineupConfirmed,
          hrPer9VsLHB: handSplits?.hrPer9VsLHB ?? null,
          hrPer9VsRHB: handSplits?.hrPer9VsRHB ?? null,
          eraVsLHB: handSplits?.eraVsLHB ?? null,
          eraVsRHB: handSplits?.eraVsRHB ?? null,
          opposingLineupHandedness: opposingLineupConfirmed ? { left, right, switchHit } : null,
        });

        const rawContactSupportingInputs: RawContactSupportingInputs = buildRawContactSupportingInputs(seasonStats, recentStarts);
        const rawContactSnapshot = aggregateRawPitcherContactSnapshot(
          savant?.pitcherContactCsvSource ?? null,
          rawContactSupportingInputs,
        );

        const drivers: MoundDriver[] = [
          ...pitcherSkill.drivers,
          ...opponentKProfile.drivers,
          ...workload.drivers,
          ...runEnv.drivers,
          ...recentForm.drivers,
          ...risk.drivers,
          ...contactRisk.drivers,
        ];
        if (starter) {
          drivers.push({ key: "ctx_confirmed_starter", label: "Confirmed Starter", direction: "positive", weight: 20 });
        }
        if (opposingLineupConfirmed) {
          drivers.push({ key: "ctx_confirmed_lineup", label: "Confirmed Opposing Lineup", direction: "positive", weight: 20 });
        }
        if (archetype === "ace") {
          drivers.push({ key: "ctx_ace", label: "Ace/Quality Starter Profile", direction: "positive", weight: 40 });
        } else if (archetype === "quality_starter") {
          drivers.push({ key: "ctx_quality", label: "Strong Pitcher Archetype", direction: "positive", weight: 30 });
        }
        // Legacy chip count retained for diagnostics/tests. composeMoundScore and
        // the public predicate now gate on independent component families.
        const positiveDriverCount = drivers.filter((d) => d.direction === "positive" && !d.key.startsWith("cr_")).length;

        const lineupStatus: MoundLineupStatus = opposingLineupConfirmed ? "confirmed" : "unconfirmed";

        const scoring = composeMoundScore(
          {
            pitcherSkillScore: pitcherSkill.score10,
            opponentKProfileScore: opponentKProfile.score10,
            workloadScore: workload.score10,
            runEnvironmentScore: runEnv.score10,
            recentFormScore: recentForm.score10,
            riskPenalty: risk.riskPenalty,
          },
          {
            pitcherSkillAvailable: pitcherSkill.available,
            confirmedStarter: pitcherKnown,
            confirmedOpposingLineup: opposingLineupConfirmed,
            parkAvailable: parkFactors != null,
            weatherAvailable,
            positiveDriverCount,
          },
        );

        if (opposingLineupConfirmed) confirmedLineupScores.push(scoring.score10);

        const moundDirection = computeMoundDirection({
          tier: scoring.tier,
          pitcherSkillScore: pitcherSkill.available ? pitcherSkill.score10 : null,
          dataCoverageScore: scoring.dataCoverageScore,
          opposingLineupConfirmed,
          pitcherSeasonStatsAvailable: seasonStats != null,
          primaryMarket: marketTags.primaryMarket,
          seasonKPer9: seasonStats?.kPer9 ?? null,
          seasonAvgInningsPerStart: avgInningsPerStart,
        });

        console.log(
          `[MLB_PREGAME_MOUND_SCORE] pitcher=${starter.pitcherId} skill=${pitcherSkill.score10} opp=${opponentKProfile.score10} ` +
            `workload=${workload.score10} runEnv=${runEnv.score10} recent=${recentForm.score10} risk=${risk.riskPenalty} score10=${scoring.score10}`,
        );

        const warnings = [
          ...pitcherSkill.warnings,
          ...opponentKProfile.warnings,
          ...workload.warnings,
          ...runEnv.warnings,
          ...recentForm.warnings,
          ...risk.warnings,
        ];

        const weatherStatus: MoundWeatherStatus = isIndoors ? "roof" : weatherAvailable ? "estimated" : "unknown";

        const signalId = `mlb-mound:${sessionDate}:${game.gameId}:${starter.pitcherId}`;
        rawContactSnapshotsBySignalId.set(signalId, rawContactSnapshot);
        const generatedAt = new Date().toISOString();
        const isLocked = !firstPitchLockEligible && (gameStatus === "live" || gameStatus === "final");

        const signal: MoundSignal = {
          signalId,
          sport: "mlb",
          engine: "mound_radar",
          sessionDate,
          gameId: game.gameId,
          gameDate: sessionDate,
          startsAt,
          generatedAt,
          buildId,
          pitcherId: starter.pitcherId,
          pitcherName: starter.pitcherName,
          team: starter.team,
          opponent,
          throws: starter.throws ?? null,
          opposingLineupConfirmed,
          opposingLineupLabel: `vs ${opponent} ${opposingLineupConfirmed ? "confirmed" : "projected"} lineup`,
          primaryMarket: marketTags.primaryMarket,
          marketTags: marketTags.marketTags,
          marketScores: marketTags.marketScores,
          marketSetups: marketTags.marketSetups,
          kStuffScore: marketTags.kStuffScore,
          kStuffLabel: marketTags.kStuffLabel,
          platoonKFitScore: marketTags.platoonKFitScore,
          platoonKFitLabel: marketTags.platoonKFitLabel,
          platoonKFitReason: marketTags.platoonKFitReason,
          kProjectionLabel,
          kLineValue,
          parkContext: runEnv.parkContext,
          score10: scoring.score10,
          tier: scoring.tier,
          moundDirection,
          drivers,
          warnings,
          tags: [],
          lineupStatus,
          weatherStatus,
          gameStatus,
          firstPitchLockEligible,
          lockedAt: isLocked ? generatedAt : null,
          hasMarketLine: false,
          isOfficialPlay: false,
          isPregameTarget: true,
          marketEdgeContext,
          projectedStrikeouts,
          matchupAdjustedStrikeouts,
          status: isLocked ? "locked" : "active",
          suppressed: scoring.suppressed,
          suppressedReasons: scoring.suppressedReasons,
          outcomes: null,
          everPubliclyFlagged: false,
          everPubliclyFlaggedFade: false,
          becameLiveReady: false,
          becameLiveFire: false,
          convertedLiveAt: null,
          diagnostics: {
            pitcherSkillScore: pitcherSkill.available ? pitcherSkill.score10 : null,
            opponentKProfileScore: opponentKProfile.available ? opponentKProfile.score10 : null,
            workloadScore: workload.available ? workload.score10 : null,
            runEnvironmentScore: runEnv.available ? runEnv.score10 : null,
            recentFormScore: recentForm.available ? recentForm.score10 : null,
            marketFitScore: 0,
            contactRiskScore: contactRisk.available ? contactRisk.score10 : null,
            riskPenalty: risk.riskPenalty,
            appliedDrivers: drivers.filter((d) => d.direction === "positive").map((d) => d.label),
            appliedWarnings: warnings,
            dataCoverageScore: scoring.dataCoverageScore,
            finalScoreCap: scoring.finalScoreCap,
            finalScoreBeforeCaps: scoring.finalScoreBeforeCaps,
            finalScoreAfterCaps: scoring.score10,
            publicTier: scoring.tier,
            suppressed: scoring.suppressed,
            suppressedReasons: scoring.suppressedReasons,
            sourceFreshness: {
              weatherUpdatedAt: weather?.fetchedAt ? new Date(weather.fetchedAt).toISOString() : null,
              pitcherStatsUpdatedAt: seasonStats?.fetchedAt ? new Date(seasonStats.fetchedAt).toISOString() : null,
            },
            rawInputsAvailable: {
              confirmedStarter: pitcherKnown,
              confirmedOpposingLineup: opposingLineupConfirmed,
              pitcherSeasonStats: seasonStats != null,
              pitcherHandednessSplits: handSplits != null,
              pitcherRecentStarts: recentStarts != null,
              pitcherStuffMetrics: savant?.pitcherSwStrPct != null || savant?.pitcherCswPct != null,
              park: parkFactors != null,
              weather: weatherAvailable,
            },
          },
        };

        // ── Mound V2 (shadow, research-only) ────────────────────────────────
        // Runs AFTER `signal` above is fully assembled and reads only
        // variables already fetched for V1's own use above (no additional
        // provider/odds/roster request). Never touches `signal` or
        // `signals` — a failure here is caught and reported, never thrown
        // into this loop, and V1's real output is already complete by the
        // time this block runs. See CLAUDE.md's Mound V2 status note.
        if (isMoundV2ShadowEnabled()) {
          try {
            const shadowSnapshotId = `mound_v2:${signalId}:${buildId}`;
            const battingOrder: FrozenMoundBatterInput[] = opposingLineup.map((slot) => {
              const player = getPlayer(slot.playerId);
              const perBatterRate = lineupKProfile?.perBatter?.find((b) => b.playerId === slot.playerId);
              const bvp = mlbPlayerCache.bvpMatchups[`${slot.playerId}_vs_${starter.pitcherId}`];
              const bats = player?.bats;
              return {
                playerId: slot.playerId,
                playerName: player?.playerName ?? slot.playerId,
                battingOrderSlot: slot.battingOrderSlot,
                handedness: bats === "L" || bats === "R" || bats === "S" ? bats : null,
                kRateVsThrowHand: perBatterRate?.kRateVsThrowHand ?? null,
                kRateSamplePa: perBatterRate?.plateAppearances ?? null,
                bvpAtBats: bvp?.atBats ?? null,
                bvpStrikeouts: bvp?.strikeouts ?? null,
              };
            });
            const throwsForShadow: "L" | "R" | null = starter.throws === "L" || starter.throws === "R" ? starter.throws : null;
            const dataQuality: MoundFrozenDataQuality =
              opposingLineupConfirmed && seasonStats != null ? "complete" : seasonStats != null ? "partial" : "degraded";
            // Correction 1: the raw odds snapshot (strikeoutSnap.books) already
            // carries an UNDER price for every book — buildMoundMarketEdgeContext
            // only ever surfaces the OVER side for V1's own display purposes, so
            // the shadow capture previously hardcoded underPrice to null even
            // though the real data was already fetched. Zero new provider calls.
            const underBook = strikeoutSnap?.books ? pickBestUnderBook(strikeoutSnap.books) : null;
            // V1's own frozen recommended side at this exact evaluation moment —
            // captured, never recomputed, so the decision-policy comparison
            // (moundV2ComparisonStats.ts) can grade V1's actual pick against its
            // own captured price rather than treating V1's performance as
            // structurally unavailable.
            const v1RecommendedSide: "OVER" | "UNDER" | null =
              signal.moundDirection === "follow" ? "OVER" : signal.moundDirection === "fade" ? "UNDER" : null;

            // The actual evaluate/record/log/never-throw wrapper is
            // extracted into runMoundV2ShadowForPitcher (Correction 2) so it
            // can be exercised with real behavioral tests (including
            // injected throwing stubs), not just proven by reading source
            // text. This outer try/catch additionally covers the
            // construction above (battingOrder, underBook,
            // v1RecommendedSide) — real defense-in-depth, not redundant,
            // since that setup code has deep closure dependencies on this
            // per-pitcher loop and can't be moved into the extracted runner.
            runMoundV2ShadowForPitcher({
              signalId,
              evaluateArgs: {
                snapshotId: shadowSnapshotId,
                now: new Date(),
                frozenInputArgs: {
                  gameId: game.gameId,
                  pitcherId: starter.pitcherId,
                  pitcherName: starter.pitcherName,
                  opponent,
                  scheduledGameTime: startsAt,
                  lineupStatus,
                  battingOrder,
                  pitcherThrows: throwsForShadow,
                  kPer9: seasonStats?.kPer9 ?? null,
                  priorSeasonsKPer9,
                  swStrPct: savant?.pitcherSwStrPct ?? null,
                  cswPct: savant?.pitcherCswPct ?? null,
                  missesBatsFamily: savant?.pitcherMissesBatsFamily ?? null,
                  kRateVsLHB: handSplits?.kRateVsLHB ?? null,
                  kRateVsRHB: handSplits?.kRateVsRHB ?? null,
                  avgInningsPerStart,
                  ipVarianceLast3: recentStarts?.ipVarianceLast3 ?? null,
                  lastStartPitchCount: recentStarts?.lastStartPitchCount ?? null,
                  lastStartInningsPitched: recentStarts?.last3StartInningsPitched?.[0] ?? null,
                  bbPer9: seasonStats?.bbPer9 ?? null,
                  // Outs has no real fetch path anywhere in this codebase today
                  // (see types.ts's postedLine.outs comment) — always
                  // unavailable, never fabricated or cross-substituted from
                  // strikeouts.
                  strikeoutsMarket: {
                    line: marketEdgeContext?.line ?? null,
                    overPrice: marketEdgeContext?.odds ?? null,
                    underPrice: underBook?.odds ?? null,
                    sportsbook: marketEdgeContext?.sportsbook ?? null,
                    fetchedAt: marketEdgeContext?.oddsUpdatedAt ?? null,
                  },
                  outsMarket: { line: null, overPrice: null, underPrice: null, sportsbook: null, fetchedAt: null },
                  dataQuality,
                  productionModelVersion: MOUND_V1_MODEL_VERSION,
                  v2ModelVersion: MOUND_V2_MODEL_VERSION,
                },
                productionComponentScores: {
                  pitcherSkillScore: pitcherSkill.available ? pitcherSkill.score10 : null,
                  workloadScore: workload.available ? workload.score10 : null,
                  opponentKProfileScore: opponentKProfile.available ? opponentKProfile.score10 : null,
                },
                v1Score10: scoring.score10,
                v1Tier: scoring.tier,
                v1RecommendedSide,
                strikeoutsLine: marketEdgeContext?.line ?? null,
                outsLine: null,
              },
            });
          } catch (err: any) {
            // Belt-and-suspenders: runMoundV2ShadowForPitcher itself never
            // throws, but this outer guard also covers the construction
            // above (battingOrder, underBook, v1RecommendedSide) — a defect
            // there can never affect V1's own signal, which is already
            // fully assembled above.
            console.warn(`[MOUND_V2_SHADOW_UNEXPECTED_ERROR] ${signalId}`, err?.message ?? err);
          }
        }

        carryForwardMoundGradedState(signal, prevSignals?.get(signalId));
        signals.set(signalId, signal);

        if (scoring.suppressed) {
          suppressedCount++;
          console.log(`[MLB_PREGAME_MOUND_DRIVER_BUILD] ${signalId} suppressed reasons=${scoring.suppressedReasons.join(",")}`);
        } else {
          createdPublicEligible++;
          console.log(`[MLB_PREGAME_MOUND_DRIVER_BUILD] ${signalId} ${starter.pitcherName} ${scoring.tier} score=${scoring.score10} market=${marketTags.primaryMarket}`);
        }
      }

      const currentStarterIds = new Set(starters.map((s) => s.pitcherId));
      const carriedOver = carryForwardDroppedFromMound(
        game.gameId,
        currentStarterIds,
        prevSignalsByGame.get(game.gameId) ?? [],
        gameStatus,
        firstPitchLockEligible,
        new Date().toISOString(),
        buildId,
      );
      for (const carried of carriedOver) {
        signals.set(carried.signalId, carried);
        console.log(
          `[MLB_PREGAME_MOUND_SIGNAL_CARRIED] ${carried.signalId} ${carried.pitcherName} dropped from starter resolution — preserved (status=${carried.status})`,
        );
      }
    }
  } catch (err: any) {
    console.error(`[MLB_PREGAME_MOUND_TARGETS] build failed buildId=${buildId}:`, err?.message ?? err);
    isMoundRadarBuildRunning = false;
    return null;
  }

  try {
    applyMoundEvaluationSnapshots(signals, prevSignals, buildId, seasonRatesByPitcherId, rawContactSnapshotsBySignalId);
  } catch (err: any) {
    console.warn(`[MOUND_RADAR_EVALUATION_SNAPSHOT] buildId=${buildId} failed:`, err?.message ?? err);
  }

  const completedAt = new Date().toISOString();
  const snapshot: MoundRadarSnapshot = {
    buildId,
    sessionDate,
    generatedAt: completedAt,
    builtAtMs: Date.now(),
    gamesScanned,
    pitchersEvaluated,
    signals,
    coverage: {
      starterCoverage: gamesScanned > 0 ? round2(starterGames / gamesScanned) : 0,
      weatherCoverage: gamesScanned > 0 ? round2(weatherGames / gamesScanned) : 0,
      pitcherCoverage: pitchersEvaluated > 0 ? round2(pitcherWithSkill / pitchersEvaluated) : 0,
      lineupCoverage: pitchersEvaluated > 0 ? round2(lineupConfirmedCount / pitchersEvaluated) : 0,
    },
  };
  setMoundSnapshot(snapshot);

  console.log(
    `[MLB_PREGAME_MOUND_TARGETS] build complete buildId=${buildId} games=${gamesScanned} ` +
      `pitchers=${pitchersEvaluated} public=${createdPublicEligible} suppressed=${suppressedCount}`,
  );

  if (confirmedLineupScores.length > 0) {
    const sorted = confirmedLineupScores.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? round2((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
    const max = sorted[sorted.length - 1];
    const clearing = (min: number) => sorted.filter((s) => s >= min).length;
    console.log(
      `[MLB_PREGAME_MOUND_SCORE_DIST] buildId=${buildId} confirmedLineupPitchers=${sorted.length} ` +
        `median=${median} max=${max} clearing5.0=${clearing(5.0)} clearing5.5=${clearing(5.5)} clearing6.0=${clearing(6.0)}`,
    );
  }

  if (buildSink) {
    try {
      await buildSink(Array.from(signals.values()), {
        buildId,
        sessionDate,
        startedAt,
        completedAt,
        gamesScanned,
        pitchersEvaluated,
        starterCoverage: snapshot.coverage.starterCoverage,
        weatherCoverage: snapshot.coverage.weatherCoverage,
        pitcherCoverage: snapshot.coverage.pitcherCoverage,
        lineupCoverage: snapshot.coverage.lineupCoverage,
        signalsCreated: createdPublicEligible,
        suppressedCount,
      });
    } catch (err: any) {
      console.error(`[MLB_PREGAME_MOUND_TARGETS] DB sink failed:`, err?.message ?? err);
    }
  }

  isMoundRadarBuildRunning = false;
  return snapshot;
}
