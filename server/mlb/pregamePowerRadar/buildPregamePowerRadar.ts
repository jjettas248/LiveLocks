// Pre-Game Power Radar — build orchestration.
//
// Scans today's slate, assembles per-batter inputs from shared MLB data
// services (never fabricated), scores them, and writes the in-memory snapshot.
// Guarded against concurrent builds; everything try/catch so it can never crash
// runtime. DB persistence (Phase 2) is invoked via an optional sink callback so
// this module stays free of storage imports.

import { randomUUID } from "crypto";
import { todayET } from "../../utils/dateUtils";
import { discoverTodaysGames } from "../gameDiscoveryService";
import { getStartingLineup, getStartingPitcher, getPlayer } from "../rosterService";
import { fetchBaseballSavantData, getMarketParkFactor, isVenueIndoors } from "../dataSources";
import {
  fetchPitcherHandednessSplits,
  fetchBatterHandednessSplits,
  mlbGameCache,
  mlbPlayerCache,
} from "../dataPullService";
import type {
  PregamePowerSignal,
  PregameGameStatus,
  PregameLineupStatus,
  PregameWeatherStatus,
  PowerDriver,
} from "./types";
import { computeBatterPowerProfile, type BatterPowerInputs } from "./batterPowerProfile";
import { computePitcherVulnerability } from "./pitcherVulnerability";
import { computeMatchupFit } from "./matchupFit";
import { computeParkWeatherScore } from "./parkWeatherScore";
import { computeLineupOpportunity } from "./lineupOpportunity";
import { computeMarketTags } from "./marketTagger";
import { composePregameScore } from "./scoring";
import {
  setSnapshot,
  type PregamePowerSnapshot,
} from "./pregamePowerRadarStore";

let isPregamePowerRadarBuildRunning = false;

/** Optional DB sink — wired in Phase 2 to persist all evaluated rows. */
export type PregameBuildSink = (
  signals: PregamePowerSignal[],
  manifest: {
    buildId: string;
    sessionDate: string;
    startedAt: string;
    completedAt: string;
    gamesScanned: number;
    battersEvaluated: number;
    lineupCoverage: number;
    weatherCoverage: number;
    batterCoverage: number;
    pitcherCoverage: number;
    signalsCreated: number;
    suppressedCount: number;
  },
) => Promise<void>;

let buildSink: PregameBuildSink | null = null;
export function setPregameBuildSink(sink: PregameBuildSink): void {
  buildSink = sink;
}

function mapGameStatus(espnStatus: string | undefined): PregameGameStatus {
  const s = (espnStatus ?? "").toUpperCase();
  if (s.includes("FINAL")) return "final";
  if (s.includes("IN_PROGRESS") || s.includes("LIVE")) return "live";
  if (s.includes("POSTPONED")) return "postponed";
  if (s.includes("DELAY")) return "delayed";
  if (s.includes("PRE")) return "pre";
  if (s.includes("SCHEDULED")) return "scheduled";
  return "unknown";
}

function savantToPowerInputs(s: Awaited<ReturnType<typeof fetchBaseballSavantData>>): BatterPowerInputs {
  return {
    xISO: s.xISOSeason,
    xSLG: s.xSLG,
    barrelRatePct: s.barrelRateProxySeason,
    hardHitRatePct: s.hardHitRateSeason,
    exitVelocity: s.exitVelocity,
    maxEV: s.maxEV,
    flyBallPct: s.flyBallPercent,
    hrFBRatioPct: s.hrFBRatio,
    pullRatePct: s.pullRatePercent,
    sweetSpotPct: s.sweetSpotPercent,
    xwOBA: s.xwOBASeason,
  };
}

/**
 * Run a full build. Returns the snapshot it stored (or the previous one if a
 * build is already running). Never throws.
 */
export async function buildPregamePowerRadar(): Promise<PregamePowerSnapshot | null> {
  if (isPregamePowerRadarBuildRunning) {
    console.log("[PREGAME_POWER_RADAR_BUILD_START] skipped — build already running");
    return null;
  }
  isPregamePowerRadarBuildRunning = true;
  const startedAt = new Date().toISOString();
  const buildId = `ppr_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const sessionDate = todayET();
  console.log(`[PREGAME_POWER_RADAR_BUILD_START] buildId=${buildId} date=${sessionDate}`);

  const signals = new Map<string, PregamePowerSignal>();
  let gamesScanned = 0;
  let battersEvaluated = 0;
  let lineupGames = 0;
  let weatherGames = 0;
  let batterWithPower = 0;
  let pitcherResolved = 0;
  let createdPublicEligible = 0;
  let suppressedCount = 0;

  try {
    const games = await discoverTodaysGames();

    for (const game of games) {
      gamesScanned++;
      const gameStatus = mapGameStatus(game.espnStatus);
      const startsAt = game.startTime || null;
      const firstPitchLockEligible = gameStatus === "scheduled" || gameStatus === "pre";

      const lineup = getStartingLineup(game.gameId);
      if (lineup.length > 0) lineupGames++;

      const weather = mlbGameCache.weather[game.gameId];
      const venueName = weather?.venueName ?? null;
      const weatherAvailable = !!weather && (weather.temperature != null || weather.windSpeed != null);
      const isIndoors = weather?.isIndoors ?? isVenueIndoors(venueName);
      if (weatherAvailable || isIndoors) weatherGames++;

      const pitcher = getStartingPitcher(game.gameId);

      console.log(
        `[PREGAME_POWER_RADAR_GAME_SCANNED] game=${game.gameId} ${game.awayTeam}@${game.homeTeam} ` +
          `status=${gameStatus} lineup=${lineup.length} weather=${weatherAvailable}`,
      );

      for (const slot of lineup) {
        const player = getPlayer(slot.playerId);
        if (!player) continue;
        battersEvaluated++;

        const batterTeam = slot.team;
        const opponent = batterTeam === game.homeTeam ? game.awayTeam : game.homeTeam;

        // Opposing pitcher: the stored starter when it belongs to the other team.
        const opposingPitcher =
          pitcher && pitcher.team && pitcher.team !== batterTeam ? pitcher : null;
        const pitcherKnown = !!opposingPitcher;
        if (pitcherKnown) pitcherResolved++;

        // ── Gather inputs (each guarded — degrade to neutral on failure) ──────
        let savant: Awaited<ReturnType<typeof fetchBaseballSavantData>> | null = null;
        try {
          const savantId = player.savantId ?? player.playerId;
          savant = await fetchBaseballSavantData(String(savantId), game.gameId);
        } catch {
          savant = null;
        }

        let pitcherSplits = null;
        if (opposingPitcher) {
          try {
            pitcherSplits = await fetchPitcherHandednessSplits(opposingPitcher.pitcherId);
          } catch {
            pitcherSplits = null;
          }
        }

        let batterSplits = null;
        try {
          batterSplits = await fetchBatterHandednessSplits(player.playerId);
        } catch {
          batterSplits = null;
        }

        // ── Compute components ────────────────────────────────────────────────
        const powerInputs: BatterPowerInputs = savant
          ? savantToPowerInputs(savant)
          : {
              xISO: null, xSLG: null, barrelRatePct: null, hardHitRatePct: null,
              exitVelocity: null, maxEV: null, flyBallPct: null, hrFBRatioPct: null,
              pullRatePct: null, sweetSpotPct: null, xwOBA: null,
            };
        const batterPower = computeBatterPowerProfile(powerInputs);

        const pitcherVuln = computePitcherVulnerability({
          pitcherKnown,
          batterHand: player.bats,
          pitcherThrows: opposingPitcher?.throws ?? null,
          hrPer9VsLHB: pitcherSplits?.hrPer9VsLHB ?? null,
          hrPer9VsRHB: pitcherSplits?.hrPer9VsRHB ?? null,
          eraVsLHB: pitcherSplits?.eraVsLHB ?? null,
          eraVsRHB: pitcherSplits?.eraVsRHB ?? null,
        });

        const parkHrFactor = venueName
          ? getMarketParkFactor(venueName, "home_runs", player.bats)
          : null;
        const parkWeather = computeParkWeatherScore({
          parkHrFactor,
          isIndoors,
          weatherAvailable,
          temperature: weather?.temperature ?? null,
          windSpeed: weather?.windSpeed ?? null,
          windDirection: weather?.windDirection ?? null,
        });

        const opsVsHand =
          opposingPitcher?.throws === "L"
            ? batterSplits?.opsVsLHP ?? null
            : opposingPitcher?.throws === "R"
              ? batterSplits?.opsVsRHP ?? null
              : null;

        // Read BvP from cache only — never fabricate. Present only when a prior
        // syncBvPMatchup populated it. atBats is the PA proxy for sample gating.
        const bvp = opposingPitcher
          ? mlbPlayerCache.bvpMatchups[`${player.playerId}_vs_${opposingPitcher.pitcherId}`] ?? null
          : null;
        const matchupFit = computeMatchupFit({
          batterHand: player.bats,
          pitcherThrows: opposingPitcher?.throws ?? null,
          batterOpsVsHand: opsVsHand,
          batterXslgVsDominantFamily: null,
          pullRatePct: savant?.pullRatePercent ?? null,
          parkFavorsPull: (parkHrFactor ?? 1) > 1.05,
          bvpPlateAppearances: bvp?.atBats ?? null,
          bvpHr: bvp?.homeRuns ?? null,
          bvpHits: bvp?.hits ?? null,
        });

        const lineupOpp = computeLineupOpportunity({
          battingOrderSlot: slot.battingOrderSlot,
          teamImpliedRuns: null,
          obpAhead: null,
        });

        const marketTags = computeMarketTags({
          batterPowerScore: batterPower.score10,
          pitcherVulnerabilityScore: pitcherVuln.score10,
          parkWeatherScore: parkWeather.score10,
          hrFBRatioPct: savant?.hrFBRatio ?? null,
          xISO: savant?.xISOSeason ?? null,
          hardHitRatePct: savant?.hardHitRateSeason ?? null,
        });

        // ── Drivers union + positive count ────────────────────────────────────
        const drivers: PowerDriver[] = [
          ...batterPower.drivers,
          ...pitcherVuln.drivers,
          ...matchupFit.drivers,
          ...parkWeather.drivers,
          ...lineupOpp.drivers,
          ...marketTags.drivers,
        ];
        const positiveDriverCount = drivers.filter((d) => d.direction === "positive").length;

        const lineupStatus: PregameLineupStatus = "confirmed"; // synced lineups are official

        const scoring = composePregameScore(
          {
            batterPowerScore: batterPower.score10,
            pitcherVulnerabilityScore: pitcherVuln.score10,
            matchupFitScore: matchupFit.score10,
            parkWeatherScore: parkWeather.score10,
            lineupOpportunityScore: lineupOpp.score10,
            bvpModifier: matchupFit.bvpModifier,
          },
          {
            batterPowerAvailable: batterPower.available,
            pitcherProfileAvailable: pitcherVuln.available,
            confirmedLineup: lineupStatus === "confirmed",
            parkAvailable: parkHrFactor != null,
            weatherAvailable,
            bvpAvailable: matchupFit.bvpAvailable,
            parkIsOnlyPositiveDriver: parkWeather.parkIsOnlyPositiveDriver,
            positiveDriverCount,
          },
        );
        if (batterPower.available) batterWithPower++;

        const warnings = [
          ...batterPower.warnings,
          ...pitcherVuln.warnings,
          ...matchupFit.warnings,
          ...parkWeather.warnings,
          ...lineupOpp.warnings,
        ];

        const weatherStatus: PregameWeatherStatus = isIndoors
          ? "roof"
          : weatherAvailable
            ? "estimated"
            : "unknown";

        const signalId = `mlb-pregame:${sessionDate}:${game.gameId}:${player.playerId}`;
        const generatedAt = new Date().toISOString();
        const isLocked = !firstPitchLockEligible && (gameStatus === "live" || gameStatus === "final");

        const signal: PregamePowerSignal = {
          signalId,
          sport: "mlb",
          engine: "pregame_power_radar",
          sessionDate,
          gameId: game.gameId,
          gameDate: sessionDate,
          startsAt,
          generatedAt,
          buildId,
          batterId: player.playerId,
          batterName: player.playerName,
          team: batterTeam,
          opponent,
          pitcherId: opposingPitcher?.pitcherId ?? null,
          pitcherName: opposingPitcher?.pitcherName ?? null,
          battingOrderSlot: slot.battingOrderSlot,
          handednessMatchup: opposingPitcher
            ? `${player.bats} vs ${opposingPitcher.throws}`
            : null,
          primaryMarket: marketTags.primaryMarket,
          marketTags: marketTags.marketTags,
          marketScores: marketTags.marketScores,
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
          status: isLocked ? "locked" : gameStatus === "final" ? "expired" : "active",
          suppressed: scoring.suppressed,
          suppressedReasons: scoring.suppressedReasons,
          outcomes: null,
          becameLiveReady: false,
          becameLiveFire: false,
          convertedLiveAt: null,
          diagnostics: {
            batterPowerScore: batterPower.available ? batterPower.score10 : null,
            pitcherVulnerabilityScore: pitcherVuln.available ? pitcherVuln.score10 : null,
            matchupFitScore: matchupFit.available ? matchupFit.score10 : null,
            parkWeatherScore: parkWeather.available ? parkWeather.score10 : null,
            lineupOpportunityScore: lineupOpp.available ? lineupOpp.score10 : null,
            marketFitScore: marketTags.score10,
            dataCoverageScore: scoring.dataCoverageScore,
            finalScoreCap: scoring.finalScoreCap,
            suppressed: scoring.suppressed,
            suppressedReasons: scoring.suppressedReasons,
            sourceFreshness: {
              weatherUpdatedAt: weather?.fetchedAt ? new Date(weather.fetchedAt).toISOString() : null,
            },
            rawInputsAvailable: {
              lineup: lineupStatus === "confirmed",
              batterPower: batterPower.available,
              pitcherProfile: pitcherVuln.available,
              park: parkHrFactor != null,
              weather: weatherAvailable,
              bvp: matchupFit.bvpAvailable,
            },
          },
        };

        signals.set(signalId, signal);
        if (scoring.suppressed) {
          suppressedCount++;
          console.log(`[PREGAME_POWER_RADAR_SIGNAL_SUPPRESSED] ${signalId} score=${scoring.score10} reasons=${scoring.suppressedReasons.join(",")}`);
        } else {
          createdPublicEligible++;
          console.log(`[PREGAME_POWER_RADAR_SIGNAL_CREATED] ${signalId} ${player.playerName} ${scoring.tier} score=${scoring.score10} market=${marketTags.primaryMarket}`);
        }
      }
    }
  } catch (err: any) {
    console.error(`[PREGAME_POWER_RADAR_BUILD_FAILED] buildId=${buildId}:`, err?.message ?? err);
    isPregamePowerRadarBuildRunning = false;
    return null;
  }

  const completedAt = new Date().toISOString();
  const snapshot: PregamePowerSnapshot = {
    buildId,
    sessionDate,
    generatedAt: completedAt,
    builtAtMs: Date.now(),
    gamesScanned,
    battersEvaluated,
    signals,
    coverage: {
      lineupCoverage: gamesScanned > 0 ? round2(lineupGames / gamesScanned) : 0,
      weatherCoverage: gamesScanned > 0 ? round2(weatherGames / gamesScanned) : 0,
      batterCoverage: battersEvaluated > 0 ? round2(batterWithPower / battersEvaluated) : 0,
      pitcherCoverage: battersEvaluated > 0 ? round2(pitcherResolved / battersEvaluated) : 0,
    },
  };
  setSnapshot(snapshot);

  console.log(
    `[PREGAME_POWER_RADAR_BUILD_COMPLETE] buildId=${buildId} games=${gamesScanned} ` +
      `batters=${battersEvaluated} public=${createdPublicEligible} suppressed=${suppressedCount}`,
  );

  // Persist (Phase 2 sink) — never blocks/raises into runtime.
  if (buildSink) {
    try {
      await buildSink(Array.from(signals.values()), {
        buildId,
        sessionDate,
        startedAt,
        completedAt,
        gamesScanned,
        battersEvaluated,
        lineupCoverage: snapshot.coverage.lineupCoverage,
        weatherCoverage: snapshot.coverage.weatherCoverage,
        batterCoverage: snapshot.coverage.batterCoverage,
        pitcherCoverage: snapshot.coverage.pitcherCoverage,
        signalsCreated: createdPublicEligible,
        suppressedCount,
      });
    } catch (err: any) {
      console.error(`[PREGAME_POWER_RADAR_DB_UPSERT] sink failed:`, err?.message ?? err);
    }
  }

  isPregamePowerRadarBuildRunning = false;
  return snapshot;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
