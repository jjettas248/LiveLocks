// ── MLB Live Game Orchestrator ────────────────────────────────────────────────
// Central heartbeat of the Phase A MLB engine.
// Discovers games, registers them, polls live data, detects state changes,
// and triggers engine recalculations.

import { discoverTodaysGames } from "./gameDiscoveryService";
import {
  registerGame,
  removeGame,
  getActiveGames,
  getGame,
} from "./liveGameRegistry";
import {
  syncGameState,
  syncContactData,
  syncPitcherContext,
  syncWeather,
  syncBullpenUsage,
  mlbGameCache,
  type GameStateCache,
} from "./dataPullService";
import { estimateRemainingPA } from "./paEstimator";
import { calculateMLBPropEdge } from "./markets";
import { recordMLBDiagnostic } from "./diagnostics";
import type { MLBPropInput, MLBPropOutput, MLBMarket } from "./types";

// ── Market scoping ────────────────────────────────────────────────────────────

const BATTER_MARKETS: MLBMarket[] = [
  "hits",
  "total_bases",
  "batter_strikeouts",
  "home_runs",
  "hrr",
];

const PITCHER_MARKETS: MLBMarket[] = ["pitcher_strikeouts", "hits_allowed"];

// ── Neutral book line defaults (used for internal/diagnostic triggers) ─────────

const DEFAULT_BOOK_LINE: Record<MLBMarket, number> = {
  hits: 0.5,
  total_bases: 1.5,
  batter_strikeouts: 0.5,
  pitcher_strikeouts: 4.5,
  hits_allowed: 4.5,
  home_runs: 0.5,
  hrr: 1.5,
};

// ── State change trigger types ────────────────────────────────────────────────

export type StateChangeTrigger =
  | "new_ab"
  | "ball_in_play"
  | "inning_change"
  | "pitcher_change"
  | "runner_change";

// ── Polling intervals ─────────────────────────────────────────────────────────

const GAME_DISCOVERY_MS = 5 * 60 * 1000;   // 5 minutes
const GAME_STATE_MS = 15 * 1000;            // 15 seconds (via pollGame)
const WEATHER_MS = 10 * 60 * 1000;          // 10 minutes

// ── Orchestrator class ────────────────────────────────────────────────────────

export class LiveGameOrchestrator {
  private timers: ReturnType<typeof setInterval>[] = [];
  private previousStates: Map<string, GameStateCache> = new Map();

  start(): void {
    console.log("[MLB orchestrator] Starting...");

    // Initial discovery
    this.pollGames().catch(console.error);

    // Game discovery every 5 minutes
    this.timers.push(
      setInterval(() => {
        this.pollGames().catch(console.error);
      }, GAME_DISCOVERY_MS)
    );

    // Game state + contact + pitcher context every 15 seconds
    this.timers.push(
      setInterval(() => {
        for (const game of getActiveGames()) {
          this.pollGame(game.gameId).catch(console.error);
        }
      }, GAME_STATE_MS)
    );

    // Weather every 10 minutes
    this.timers.push(
      setInterval(() => {
        for (const game of getActiveGames()) {
          syncWeather(game.gameId).catch(console.error);
        }
      }, WEATHER_MS)
    );

    console.log("[MLB orchestrator] Started — discovery 5m, state/contact/pitcher 15s, weather 10m");
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    console.log("[MLB orchestrator] Stopped");
  }

  async pollGames(): Promise<void> {
    try {
      const discovered = await discoverTodaysGames();
      const discoveredIds = new Set(discovered.map((g) => g.gameId));

      // Register new games
      for (const game of discovered) {
        registerGame(game);
      }

      // Remove games no longer active
      for (const existing of getActiveGames()) {
        if (!discoveredIds.has(existing.gameId)) {
          removeGame(existing.gameId);
          this.previousStates.delete(existing.gameId);
        }
      }
    } catch (err: any) {
      console.error("[MLB orchestrator] pollGames error:", err.message);
    }
  }

  async pollGame(gameId: string): Promise<void> {
    const prevState = this.previousStates.get(gameId);

    // Sync all three data sources (Correction 1)
    await syncGameState(gameId);
    await syncContactData(gameId);
    await syncPitcherContext(gameId);

    const newState = mlbGameCache.gameState[gameId];
    if (!newState) return;

    if (prevState) {
      const triggers = this.detectStateChange(prevState, newState);
      if (triggers.length > 0) {
        console.log(`[MLB orchestrator] State change for game ${gameId}: ${triggers.join(", ")}`);

        // On inning change, also sync bullpen
        if (triggers.includes("inning_change")) {
          await syncBullpenUsage(gameId);
        }

        await this.triggerEngine(gameId);
      }
    }

    this.previousStates.set(gameId, { ...newState });
  }

  detectStateChange(
    oldState: GameStateCache,
    newState: GameStateCache
  ): StateChangeTrigger[] {
    const triggers: StateChangeTrigger[] = [];

    // Inning change
    if (oldState.inning !== newState.inning || oldState.isTopInning !== newState.isTopInning) {
      triggers.push("inning_change");
    }

    // New AB (current batter changed)
    if (oldState.currentBatter?.playerId !== newState.currentBatter?.playerId) {
      triggers.push("new_ab");
    }

    // Pitcher change
    if (oldState.pitcherInGame?.playerId !== newState.pitcherInGame?.playerId) {
      triggers.push("pitcher_change");
    }

    // Runner state change
    const oldRunners = JSON.stringify((oldState.runnersOnBase ?? []).sort());
    const newRunners = JSON.stringify((newState.runnersOnBase ?? []).sort());
    if (oldRunners !== newRunners) {
      triggers.push("runner_change");
    }

    // Ball in play (pitch count went up — proxy detection)
    if (newState.pitchCount > oldState.pitchCount) {
      triggers.push("ball_in_play");
    }

    return triggers;
  }

  async triggerEngine(gameId: string): Promise<MLBPropOutput[]> {
    const outputs: MLBPropOutput[] = [];
    const state = mlbGameCache.gameState[gameId];
    const game = getGame(gameId);

    if (!state) {
      console.warn(`[MLB orchestrator] triggerEngine: no game state cached for ${gameId}`);
      return outputs;
    }

    const contactCache = mlbGameCache.contactData[gameId];
    const pitcherCtxCache = mlbGameCache.pitcherContext[gameId];
    const weatherCache = mlbGameCache.weather[gameId];
    const bullpenCache = mlbGameCache.bullpen[gameId];

    // ── Batter markets: evaluate each hitter in the starting lineup ────────────
    for (const market of BATTER_MARKETS) {
      for (const batter of state.battingOrder) {
        const { remainingPA, remainingAB } = estimateRemainingPA(
          state.inning,
          state.isTopInning,
          batter.slot
        );

        // Contact quality from cache
        const playerContact = contactCache?.byPlayerId?.[batter.playerId];

        // Pitcher context for the active pitcher
        const pitcher = state.pitcherInGame;
        const pitcherCtx = pitcher ? pitcherCtxCache?.byPitcherId?.[pitcher.playerId] : undefined;

        const isPitcherCollapsing = pitcherCtx
          ? (pitcherCtx.velocityDrop !== null && pitcherCtx.velocityDrop > 2)
          : false;

        const managerLeashShort = pitcherCtx
          ? pitcherCtx.timesThroughOrder >= 3 && pitcherCtx.pitchCount > 80
          : false;

        const input: MLBPropInput = {
          playerId: batter.playerId,
          playerName: batter.playerName,
          team: batter.team,
          opponent: "",
          gameId,
          market,
          bookLine: DEFAULT_BOOK_LINE[market],
          seasonAvg: 1.0,
          plateAppearances: state.pitchCount > 0 ? Math.max(1, state.battingOrder.length) : 0,
          atBats: Math.max(0, state.pitchCount > 0 ? Math.max(1, state.battingOrder.length) : 0),
          currentStatValue: 0,
          remainingPA,
          remainingAB,
          completedAB: Math.max(0, 4 - remainingAB),
          inning: state.inning,
          isTopInning: state.isTopInning,
          batterHand: null,
          contactQuality: {
            exitVelocity: playerContact?.exitVelocity ?? null,
            launchAngle: playerContact?.launchAngle ?? null,
            hitDistance: playerContact?.hitDistance ?? null,
            hardHitRateSeason: playerContact?.hardHitPct != null ? playerContact.hardHitPct / 100 : null,
            barrelRateProxySeason: playerContact?.barrelPct != null ? playerContact.barrelPct / 100 : null,
            priorABResults: (playerContact?.priorABResults ?? []) as MLBPropInput["contactQuality"]["priorABResults"],
          },
          pitcher: {
            pitchCount: pitcher ? state.pitchCount : 0,
            timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
            era: null,
            whip: null,
            kPer9: null,
            bbPer9: null,
            managerLeashShort,
            isPitcherCollapsing,
            pitchMix: pitcherCtx?.pitchMix ?? [],
            throws: pitcher?.throws ?? null,
          },
          lineup: {
            battingOrderSlot: batter.slot,
            orderTurnoverProximity: 0.5,
            lineupSectionStrength: batter.slot <= 3 ? "strong" : batter.slot <= 6 ? "neutral" : "weak",
            hittersAheadOnBase: state.runnersOnBase.length,
            pocketWeakness: null,
          },
          weatherPark: {
            parkFactor: 1.0,
            temperature: weatherCache?.temperature ?? null,
            windSpeed: weatherCache?.windSpeed ?? null,
            windDirection: weatherCache?.windDirection ?? null,
            humidity: weatherCache?.humidity ?? null,
            isIndoors: false,
            parkHistoryFactor: null,
          },
          bullpen: {
            bullpenEra: bullpenCache?.bullpenEra ?? null,
            bullpenUsageLastThreeDays: bullpenCache?.bullpenUsageLastThreeDays ?? null,
            isTopRelieverAvailable: bullpenCache?.isTopRelieverAvailable ?? true,
          },
        };

        try {
          const output = calculateMLBPropEdge(input);
          recordMLBDiagnostic(output);
          outputs.push(output);
        } catch (err: any) {
          console.warn(`[MLB orchestrator] engine error for ${batter.playerName} / ${market}:`, err.message);
        }
      }
    }

    // ── Pitcher markets: evaluate active pitcher (or fallback to probable) ─────
    const activePitcher = state.pitcherInGame;

    // Determine which team is pitching and find fallback probable pitcher from registry
    const probableFallbackName = (() => {
      if (!game) return undefined;
      // If top inning, home team pitches; if bottom, away team pitches
      return state.isTopInning ? game.homePitcher : game.awayPitcher;
    })();

    const pitcherToEval = activePitcher ?? (probableFallbackName
      ? { playerId: "unknown", playerName: probableFallbackName, team: "", throws: null as "L" | "R" | null }
      : null);

    if (pitcherToEval) {
      const pitcherCtx = pitcherCtxCache?.byPitcherId?.[pitcherToEval.playerId];

      for (const market of PITCHER_MARKETS) {
        const { remainingPA, remainingAB } = estimateRemainingPA(
          state.inning,
          state.isTopInning,
          5 // neutral batting order slot for pitcher PA estimate
        );

        const input: MLBPropInput = {
          playerId: pitcherToEval.playerId,
          playerName: pitcherToEval.playerName,
          team: pitcherToEval.team,
          opponent: "",
          gameId,
          market,
          bookLine: DEFAULT_BOOK_LINE[market],
          seasonAvg: market === "pitcher_strikeouts" ? 6.0 : 5.0,
          plateAppearances: pitcherCtx?.pitchCount
            ? Math.floor(pitcherCtx.pitchCount / 4)
            : 0,
          atBats: pitcherCtx?.pitchCount
            ? Math.floor(pitcherCtx.pitchCount / 4)
            : 0,
          currentStatValue: 0,
          remainingPA,
          remainingAB,
          completedAB: Math.max(0, 4 - remainingAB),
          inning: state.inning,
          isTopInning: state.isTopInning,
          batterHand: null,
          contactQuality: {
            exitVelocity: null,
            launchAngle: null,
            hitDistance: null,
            hardHitRateSeason: null,
            barrelRateProxySeason: null,
            priorABResults: [],
          },
          pitcher: {
            pitchCount: state.pitchCount,
            timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
            era: null,
            whip: null,
            kPer9: null,
            bbPer9: null,
            managerLeashShort: pitcherCtx
              ? pitcherCtx.timesThroughOrder >= 3 && pitcherCtx.pitchCount > 80
              : false,
            isPitcherCollapsing: pitcherCtx
              ? (pitcherCtx.velocityDrop !== null && pitcherCtx.velocityDrop > 2)
              : false,
            pitchMix: pitcherCtx?.pitchMix ?? [],
            throws: pitcherToEval.throws ?? null,
          },
          lineup: {
            battingOrderSlot: 5,
            orderTurnoverProximity: 0.5,
            lineupSectionStrength: "neutral",
            hittersAheadOnBase: 0,
            pocketWeakness: null,
          },
          weatherPark: {
            parkFactor: 1.0,
            temperature: weatherCache?.temperature ?? null,
            windSpeed: weatherCache?.windSpeed ?? null,
            windDirection: weatherCache?.windDirection ?? null,
            humidity: weatherCache?.humidity ?? null,
            isIndoors: false,
            parkHistoryFactor: null,
          },
          bullpen: {
            bullpenEra: bullpenCache?.bullpenEra ?? null,
            bullpenUsageLastThreeDays: bullpenCache?.bullpenUsageLastThreeDays ?? null,
            isTopRelieverAvailable: bullpenCache?.isTopRelieverAvailable ?? true,
          },
        };

        try {
          const output = calculateMLBPropEdge(input);
          recordMLBDiagnostic(output);
          outputs.push(output);
        } catch (err: any) {
          console.warn(`[MLB orchestrator] engine error for pitcher ${pitcherToEval.playerName} / ${market}:`, err.message);
        }
      }
    }

    console.log(`[MLB orchestrator] triggerEngine: game ${gameId} — ${outputs.length} outputs`);
    return outputs;
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const liveOrchestrator = new LiveGameOrchestrator();
