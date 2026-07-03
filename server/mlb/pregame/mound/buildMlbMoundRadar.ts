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
import { getVenueParkFactors, isVenueIndoors } from "../../dataSources";
import {
  fetchPitcherHandednessSplits,
  fetchPitcherRecentStarts,
  syncPitcherSeasonStats,
  syncWeather,
  mlbGameCache,
  mlbPlayerCache,
} from "../../dataPullService";
import { classifyPitcherArchetype } from "../../archetypes";
import type {
  MoundSignal,
  MoundGameStatus,
  MoundLineupStatus,
  MoundWeatherStatus,
  MoundDriver,
} from "./types";
import { computePitcherSkill } from "./pitcherSkill";
import { computeOpponentKProfile } from "./opponentKProfile";
import { computeWorkload } from "./workload";
import { computeRunEnvironment } from "./runEnvironment";
import { computeRecentForm } from "./recentForm";
import { computeRiskDrivers } from "./riskDrivers";
import { computeMarketTags } from "./marketTagger";
import { composeMoundScore } from "./scoring";
import { carryForwardMoundGradedState } from "./moundGradedStateCarry";
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

  const signals = new Map<string, MoundSignal>();
  let gamesScanned = 0;
  let pitchersEvaluated = 0;
  let starterGames = 0;
  let weatherGames = 0;
  let pitcherWithSkill = 0;
  let lineupConfirmedCount = 0;
  let createdPublicEligible = 0;
  let suppressedCount = 0;
  // score10 for confirmed-lineup pitchers only — the population the publish
  // gate actually evaluates. Distribution logged at build-complete so a
  // future "why is this empty" pass can read the answer instead of
  // re-deriving it from the scoring formula by hand.
  const confirmedLineupScores: number[] = [];

  try {
    const games = await discoverTodaysGames();

    for (const game of games) {
      gamesScanned++;
      const gameStatus = mapGameStatus(game.espnStatus);
      const startsAt = game.startTime || null;
      const firstPitchLockEligible = gameStatus === "scheduled" || gameStatus === "pre";

      const gamePk = game.gamePk ?? null;
      if (!gamePk) continue;

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

      for (const starter of starters) {
        pitchersEvaluated++;
        const opposingLineup = lineup.filter((l) => l.team !== starter.team);
        const opposingLineupConfirmed = opposingLineup.length > 0;
        if (opposingLineupConfirmed) lineupConfirmedCount++;

        const opponent =
          Array.from(new Set(opposingLineup.map((l) => l.team)))[0] ??
          (starter.team === game.homeTeam ? game.awayTeam : game.homeTeam);

        // ── Gather inputs (each guarded — degrade to neutral on failure) ────
        // Three independent network calls, no data dependency between them —
        // run concurrently rather than paying 3x the round-trip latency per
        // starter across a full slate's ~30 probable starters.
        const [, handSplitsResult, recentStartsResult] = await Promise.allSettled([
          syncPitcherSeasonStats(starter.pitcherId),
          fetchPitcherHandednessSplits(starter.pitcherId),
          fetchPitcherRecentStarts(starter.pitcherId),
        ]);
        const seasonStats = mlbPlayerCache.pitcherSeasonStats[starter.pitcherId] ?? null;
        const handSplits = handSplitsResult.status === "fulfilled" ? handSplitsResult.value : null;
        const recentStarts = recentStartsResult.status === "fulfilled" ? recentStartsResult.value : null;

        const pitcherKnown = true; // starter itself is always known here
        const avgInningsPerStart =
          seasonStats?.gamesStarted != null && seasonStats.gamesStarted > 0 && seasonStats?.inningsPitched != null
            ? seasonStats.inningsPitched / seasonStats.gamesStarted
            : null;

        const archetype = classifyPitcherArchetype({
          era: seasonStats?.era ?? null,
          whip: seasonStats?.whip ?? null,
          kPer9: seasonStats?.kPer9 ?? null,
          inningsPitched: seasonStats?.inningsPitched ?? null,
          gamesStarted: seasonStats?.gamesStarted ?? null,
          avgInningsPerStart,
        });

        // Opposing lineup handedness composition — generic roster read, not
        // hitter scoring, used only to weight the pitcher's own K-rate splits.
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
        });
        if (pitcherSkill.available) pitcherWithSkill++;

        const opponentKProfile = computeOpponentKProfile({
          pitcherKnown,
          opposingLineupConfirmed,
          kRateVsLHB: handSplits?.kRateVsLHB ?? null,
          kRateVsRHB: handSplits?.kRateVsRHB ?? null,
          opposingLineupHandedness: opposingLineupConfirmed ? { left, right, switchHit } : null,
        });

        const workload = computeWorkload({
          pitcherKnown,
          bbPer9: seasonStats?.bbPer9 ?? null,
          avgInningsPerStart,
          lastStartPitchCount: recentStarts?.lastStartPitchCount ?? null,
          // last3StartInningsPitched[0] is the SAME start lastStartPitchCount
          // came from (fetchPitcherRecentStarts builds both from `starts[0]`,
          // most-recent-first) — the correct pitches/inning denominator.
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

        const drivers: MoundDriver[] = [
          ...pitcherSkill.drivers,
          ...opponentKProfile.drivers,
          ...workload.drivers,
          ...runEnv.drivers,
          ...recentForm.drivers,
          ...risk.drivers,
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
        const positiveDriverCount = drivers.filter((d) => d.direction === "positive").length;

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
          parkContext: runEnv.parkContext,
          score10: scoring.score10,
          tier: scoring.tier,
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
          status: isLocked ? "locked" : "active",
          suppressed: scoring.suppressed,
          suppressedReasons: scoring.suppressedReasons,
          outcomes: null,
          everPubliclyFlagged: false,
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
              park: parkFactors != null,
              weather: weatherAvailable,
            },
          },
        };

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
    }
  } catch (err: any) {
    console.error(`[MLB_PREGAME_MOUND_TARGETS] build failed buildId=${buildId}:`, err?.message ?? err);
    isMoundRadarBuildRunning = false;
    return null;
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

  // Distribution over confirmed-lineup pitchers only — the population the
  // publish gate actually evaluates — so a future "why is this empty" pass
  // can read the answer in one log line instead of re-deriving it from the
  // scoring formula by hand.
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
