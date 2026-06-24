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
import {
  getStartingLineup,
  getStartingPitcher,
  getPlayer,
  updateStartingLineups,
  updateStartingPitchers,
} from "../rosterService";
import { fetchBaseballSavantData, getMarketParkFactor, isVenueIndoors } from "../dataSources";
import {
  fetchPitcherHandednessSplits,
  fetchBatterHandednessSplits,
  syncWeather,
  syncBvPMatchup,
  syncBatterOrderSplits,
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
import { computePitcherOrderSplit } from "./pitcherOrderSplit";
import { computeBatterOrderSplit } from "./batterOrderSplit";
import { computeMatchupFit } from "./matchupFit";
import { round1 as round1Score } from "./scoreUtils";
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

      // The roster + weather stores are keyed by the MLB Stats gamePk (the
      // statsapi feed/live id), NOT the ESPN event id in game.gameId. Without a
      // gamePk we cannot hydrate lineups/pitchers/weather — skip cleanly.
      const gamePk = game.gamePk ?? null;
      if (!gamePk) {
        console.log(`[PREGAME_POWER_RADAR_GAME_SCANNED] game=${game.gameId} skipped — no gamePk`);
        continue;
      }

      // Hydrate lineups, starters, and weather for this game (none are populated
      // elsewhere for pre-game slates). Independent fetches → run in parallel;
      // each is internally try/catch'd so one failure can't abort the build.
      // Weather is cached under the ESPN game.gameId (matching the orchestrator's
      // `syncWeather(gamePk, gameId)`) so the signal's gameId and the live
      // weather entry stay aligned; lineups/pitchers key by gamePk.
      try {
        await Promise.all([
          updateStartingLineups(gamePk),
          updateStartingPitchers(gamePk),
          syncWeather(gamePk, game.gameId),
        ]);
      } catch {
        /* hydration failures degrade to empty/neutral below */
      }

      const lineup = getStartingLineup(gamePk);
      if (lineup.length > 0) lineupGames++;

      const weather = mlbGameCache.weather[game.gameId];
      const venueName = weather?.venueName ?? null;
      const weatherAvailable = !!weather && (weather.temperature != null || weather.windSpeed != null);
      const isIndoors = weather?.isIndoors ?? isVenueIndoors(venueName);
      if (weatherAvailable || isIndoors) weatherGames++;

      // Starters are keyed `${gamePk}:home|away`. Resolve the opposing starter
      // per batter by team side (both lineup.team and pitcher.team come from the
      // same MLB feed, so the abbreviations match — no ESPN/MLB skew).
      const sideStarters = [
        getStartingPitcher(`${gamePk}:home`),
        getStartingPitcher(`${gamePk}:away`),
      ].filter((p): p is NonNullable<typeof p> => !!p);
      const lineupTeams = Array.from(new Set(lineup.map((l) => l.team)));

      console.log(
        `[PREGAME_POWER_RADAR_GAME_SCANNED] game=${game.gameId} pk=${gamePk} ${game.awayTeam}@${game.homeTeam} ` +
          `status=${gameStatus} lineup=${lineup.length} starters=${sideStarters.length} weather=${weatherAvailable}`,
      );

      for (const slot of lineup) {
        const player = getPlayer(slot.playerId);
        if (!player) continue;
        battersEvaluated++;

        const batterTeam = slot.team;
        const opponent =
          lineupTeams.find((t) => t !== batterTeam) ??
          (batterTeam === game.homeTeam ? game.awayTeam : game.homeTeam);

        // Opposing starter: the side whose team differs from the batter's.
        const opposingPitcher = sideStarters.find((p) => p.team !== batterTeam) ?? null;
        const pitcherKnown = !!opposingPitcher;
        if (pitcherKnown) pitcherResolved++;

        // ── Gather inputs (each guarded — degrade to neutral on failure) ──────
        let savant: Awaited<ReturnType<typeof fetchBaseballSavantData>> | null = null;
        try {
          const savantId = player.savantId ?? player.playerId;
          savant = await fetchBaseballSavantData(String(savantId), gamePk);
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

        // BvP context — sync (network, guarded) so the cache is populated before
        // we read it below. Low/medium-confidence context only; never the model.
        if (opposingPitcher) {
          try {
            await syncBvPMatchup(player.playerId, opposingPitcher.pitcherId);
          } catch {
            /* BvP is optional context — ignore failures */
          }
        }

        // Batter's own production from today's lineup slot (real feed: per-game
        // stat lines aggregated by slot). Guarded; degrades to "unavailable".
        try {
          await syncBatterOrderSplits(player.playerId);
        } catch {
          /* lineup-slot split is optional context — ignore failures */
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
          bvpAtBats: bvp?.atBats ?? null,
          bvpStrikeouts: bvp?.strikeouts ?? null,
          bvpOps: bvp?.ops ?? null,
          bvpAvg: bvp?.avg ?? null,
        });

        // ── Layer 1: pitcher ALLOWED-by-opposing-slot vulnerability ─────────────
        // Reads the provider cache (keyed pitcherId → slot). No producer is wired
        // yet, so this resolves to "unavailable" in production and contributes
        // nothing — it never fabricates pitcher-order confidence. The scorer +
        // gate + regression tests are in place for when a real feed is connected.
        const pitcherOrderRow =
          opposingPitcher && slot.battingOrderSlot != null
            ? mlbPlayerCache.pitcherOrderSplits[opposingPitcher.pitcherId]?.slots?.[slot.battingOrderSlot] ?? null
            : null;
        const pitcherOrderSplit = computePitcherOrderSplit({
          slot: slot.battingOrderSlot,
          ab: pitcherOrderRow?.ab ?? null,
          r: pitcherOrderRow?.r ?? null,
          h: pitcherOrderRow?.h ?? null,
          doubles: pitcherOrderRow?.doubles ?? null,
          triples: pitcherOrderRow?.triples ?? null,
          hr: pitcherOrderRow?.hr ?? null,
          rbi: pitcherOrderRow?.rbi ?? null,
          bb: pitcherOrderRow?.bb ?? null,
          hbp: pitcherOrderRow?.hbp ?? null,
          so: pitcherOrderRow?.so ?? null,
          sb: pitcherOrderRow?.sb ?? null,
          cs: pitcherOrderRow?.cs ?? null,
          avg: pitcherOrderRow?.avg ?? null,
          obp: pitcherOrderRow?.obp ?? null,
          slg: pitcherOrderRow?.slg ?? null,
          ops: pitcherOrderRow?.ops ?? null,
        });

        // Batter's own production from TODAY's lineup slot (real feed).
        const batterSlotRow = mlbPlayerCache.batterOrderSplits[player.playerId]?.splits?.find(
          (s) => s.slot === slot.battingOrderSlot,
        );
        const batterOrderSplit = computeBatterOrderSplit({
          slot: slot.battingOrderSlot,
          pa: batterSlotRow?.pa ?? null,
          slg: batterSlotRow?.slg ?? null,
          ops: batterSlotRow?.ops ?? null,
        });

        // Combined pitcher vulnerability = handedness + pitcher-allowed-by-slot
        // (weighted strongly when present). A suppressive slot pulls it down.
        const pitcherVulnerabilityScore = (() => {
          if (pitcherVuln.available && pitcherOrderSplit.available) {
            return round1Score((pitcherVuln.score10 * 2 + pitcherOrderSplit.score10 * 3) / 5);
          }
          if (pitcherOrderSplit.available) return pitcherOrderSplit.score10;
          return pitcherVuln.score10; // handedness (or neutral 5 when unavailable)
        })();
        const pitcherProfileAvailable = pitcherVuln.available || pitcherOrderSplit.available;

        const lineupOpp = computeLineupOpportunity({
          battingOrderSlot: slot.battingOrderSlot,
          teamImpliedRuns: null,
          obpAhead: null,
        });

        const marketTags = computeMarketTags({
          batterPowerScore: batterPower.score10,
          pitcherVulnerabilityScore,
          parkWeatherScore: parkWeather.score10,
          hrFBRatioPct: savant?.hrFBRatio ?? null,
          xISO: savant?.xISOSeason ?? null,
          hardHitRatePct: savant?.hardHitRateSeason ?? null,
        });

        // ── Drivers union + positive count ────────────────────────────────────
        const drivers: PowerDriver[] = [
          ...batterPower.drivers,
          ...pitcherVuln.drivers,
          ...pitcherOrderSplit.drivers,
          ...batterOrderSplit.drivers,
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
            pitcherVulnerabilityScore,
            matchupFitScore: matchupFit.score10,
            parkWeatherScore: parkWeather.score10,
            lineupOpportunityScore: lineupOpp.score10,
            bvpModifier: matchupFit.bvpModifier,
          },
          {
            batterPowerAvailable: batterPower.available,
            pitcherProfileAvailable,
            confirmedLineup: lineupStatus === "confirmed",
            parkAvailable: parkHrFactor != null,
            weatherAvailable,
            bvpAvailable: matchupFit.bvpAvailable,
            parkIsOnlyPositiveDriver: parkWeather.parkIsOnlyPositiveDriver,
            positiveDriverCount,
            bvpDirection: matchupFit.bvpDirection,
            bvpZeroProduction: matchupFit.bvpZeroProduction,
            pitcherOrderSplitDirection: pitcherOrderSplit.direction,
            batterOrderSplitDirection: batterOrderSplit.direction,
          },
        );
        if (batterPower.available) batterWithPower++;

        // Surface any matchup downgrade tags that aren't already a driver label as
        // negative drivers so the UI renders them as warning chips (dedup avoids
        // double chips like "Pitcher Slot Suppression" from both scorer + tag).
        const existingLabels = new Set(drivers.map((d) => d.label));
        for (const tag of scoring.warningTags) {
          if (existingLabels.has(tag)) continue;
          drivers.push({ key: `warn_${tag.replace(/\s+/g, "_").toLowerCase()}`, label: tag, direction: "negative", weight: 0 });
        }

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
          tags: scoring.warningTags,
          lineupStatus,
          weatherStatus,
          gameStatus,
          firstPitchLockEligible,
          lockedAt: isLocked ? generatedAt : null,
          hasMarketLine: false,
          isOfficialPlay: false,
          isPregameTarget: true,
          // `isLocked` already covers live/final games (see above), so by the
          // time we reach the else branch `gameStatus` can only be a non-final
          // pre-game/limbo state (scheduled/pre/postponed/delayed/unknown) →
          // "active". A separate `gameStatus === "final" ? "expired"` check here
          // was dead code (final games are always "locked" first) and tripped
          // TS2367. Final → "graded" is owned by the shadow grader, not here.
          status: isLocked ? "locked" : "active",
          suppressed: scoring.suppressed,
          suppressedReasons: scoring.suppressedReasons,
          outcomes: null,
          becameLiveReady: false,
          becameLiveFire: false,
          convertedLiveAt: null,
          diagnostics: {
            batterPowerScore: batterPower.available ? batterPower.score10 : null,
            pitcherVulnerabilityScore: pitcherProfileAvailable ? pitcherVulnerabilityScore : null,
            pitcherHandednessScore: pitcherVuln.available ? pitcherVuln.score10 : null,
            matchupFitScore: matchupFit.available ? matchupFit.score10 : null,
            parkWeatherScore: parkWeather.available ? parkWeather.score10 : null,
            lineupOpportunityScore: lineupOpp.available ? lineupOpp.score10 : null,
            marketFitScore: marketTags.score10,
            pitcherOrderSplitAvailable: pitcherOrderSplit.available,
            pitcherOrderSplitScore: pitcherOrderSplit.available ? pitcherOrderSplit.score10 : null,
            pitcherOrderSplitDirection: pitcherOrderSplit.direction,
            batterCurrentOrderSlot: slot.battingOrderSlot,
            batterOrderSplitAvailable: batterOrderSplit.available,
            batterOrderSplitScore: batterOrderSplit.available ? batterOrderSplit.score10 : null,
            batterOrderSplitDirection: batterOrderSplit.direction,
            bvpAvailable: matchupFit.bvpAvailable,
            bvpScore: matchupFit.bvpScore,
            bvpSampleSize: matchupFit.bvpAvailable ? matchupFit.bvpSampleSize : null,
            bvpDirection: matchupFit.bvpDirection,
            zeroProductionBvpFlags: matchupFit.zeroProductionFlags,
            dataCoverageScore: scoring.dataCoverageScore,
            finalScoreCap: scoring.finalScoreCap,
            finalScoreBeforeCaps: scoring.finalScoreBeforeCaps,
            finalScoreAfterCaps: scoring.score10,
            matchupPenalty: scoring.matchupPenalty,
            publicTier: scoring.tier,
            warningTags: scoring.warningTags,
            downgradeReasons: scoring.downgradeReasons,
            suppressed: scoring.suppressed,
            suppressedReasons: scoring.suppressedReasons,
            sourceFreshness: {
              weatherUpdatedAt: weather?.fetchedAt ? new Date(weather.fetchedAt).toISOString() : null,
            },
            rawInputsAvailable: {
              lineup: lineupStatus === "confirmed",
              batterPower: batterPower.available,
              pitcherProfile: pitcherProfileAvailable,
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
