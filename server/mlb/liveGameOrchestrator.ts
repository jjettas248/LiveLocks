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
import { mlbEdgeCache } from "./edgeCache";
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
import { resolveMLBOddsEventId, getMLBPlayerOdds } from "../oddsService";

// ── Debug pipeline logging ────────────────────────────────────────────────────
const DEBUG_PIPELINE = process.env.DEBUG_PIPELINE === "true";
function pLog(gameId: string, stage: string, payload: unknown): void {
  if (!DEBUG_PIPELINE) return;
  console.log(`[PIPELINE][MLB][${gameId}] ${stage}:`, JSON.stringify(payload));
}

// ── Engine input guard-rail ───────────────────────────────────────────────────
// Returns null (with a log) if required fields are missing or invalid.
function validateMLBInput(input: MLBPropInput): string | null {
  if (!input.playerName) return "missing playerName";
  if (!isFinite(input.bookLine) || input.bookLine <= 0) return `invalid bookLine=${input.bookLine}`;
  if (!input.gameId) return "missing gameId";
  if (!input.market) return "missing market";
  return null; // valid
}

// ── Market scoping ────────────────────────────────────────────────────────────

const BATTER_MARKETS: MLBMarket[] = [
  "hits",
  "total_bases",
  "batter_strikeouts",
  "home_runs",
  "hrr",
];

const PITCHER_MARKETS: MLBMarket[] = ["pitcher_strikeouts", "hits_allowed", "walks_allowed"];

// ── Previously-resolved line cache ───────────────────────────────────────────
// Persists the last successfully fetched sportsbook line per event+player+market
// within this server process. Used as the second-priority fallback when the
// odds service is unreachable or has no line posted yet.
// Key: "oddsEventId|playerNameNorm|market" — Value: last known real line
const priorResolvedLines = new Map<string, number>();

// Preferred bookmaker order for deterministic line selection (matches manual flow).
// First match wins; unlisted bookmakers are used only as a last resort.
const PREFERRED_BOOKMAKERS = ["draftkings", "fanduel", "hardrockbet"];

type ResolvedLine = { line: number; isDegraded: boolean };

// ── Resolve a real book line for a player/market ──────────────────────────────
// Precedence:
//   (1) Odds service live/cached line (getMLBPlayerOdds) — preferred book order
//       isDegraded=true when odds service served a stale last-known-good cache
//   (2) Previously resolved line cache (real market line from earlier in session)
//       isDegraded=true since it is not the current live quote
//   (3) null — no compliant line available; caller must skip this market
//
// Synthetic/default hardcoded lines are NOT used. Markets without a real line
// are explicitly skipped to avoid invalidated edge calculations.
async function resolveBookLine(
  oddsEventId: string | null,
  playerName: string,
  market: MLBMarket
): Promise<ResolvedLine | null> {
  const normName = playerName.toLowerCase().trim();
  const cacheKey = oddsEventId ? `${oddsEventId}|${normName}|${market}` : `unknown|${normName}|${market}`;

  // (1) Try odds service
  if (oddsEventId) {
    try {
      const oddsResult = await getMLBPlayerOdds(oddsEventId, playerName, market);
      const bookKeys = Object.keys(oddsResult).filter(k => !k.startsWith("_"));
      const isOddsDegraded = !!(oddsResult._isDegraded);
      if (bookKeys.length > 0) {
        // Apply deterministic bookmaker preference order
        const preferred = PREFERRED_BOOKMAKERS.find(b => bookKeys.includes(b)) ?? bookKeys[0];
        const line = oddsResult[preferred].line;
        if (typeof line === "number" && isFinite(line) && line > 0) {
          priorResolvedLines.set(cacheKey, line);
          pLog(oddsEventId, `odds:bookLine:${isOddsDegraded ? "degraded" : "live"}`, { player: playerName, market, line, book: preferred });
          return { line, isDegraded: isOddsDegraded };
        }
      }
    } catch (err: any) {
      console.warn(`[MLB orchestrator] resolveBookLine odds error for ${playerName}/${market}:`, err.message);
    }
  }

  // (2) Fall back to previously resolved line (real market line from earlier in session — stale)
  const prior = priorResolvedLines.get(cacheKey);
  if (prior !== undefined) {
    console.warn(`[MLB orchestrator] Using prior known line for ${playerName}/${market}: ${prior}`);
    pLog(oddsEventId ?? "unknown", "odds:bookLine:priorResolved", { player: playerName, market, line: prior });
    return { line: prior, isDegraded: true };
  }

  // (3) No compliant line available — skip this market
  console.warn(`[MLB orchestrator] No sportsbook line for ${playerName}/${market} — market skipped (no synthetic fallback)`);
  pLog(oddsEventId ?? "unknown", "odds:bookLine:skipped", { player: playerName, market, reason: "noCompliantLine" });
  return null;
}

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
    let anyDegraded = false; // true if any market used stale last-known-good odds
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

    // ── Resolve MLB odds event ID once per game ────────────────────────────────
    let oddsEventId: string | null = null;
    if (game) {
      try {
        oddsEventId = await resolveMLBOddsEventId(game.awayTeam, game.homeTeam);
        pLog(gameId, "oddsEventId", { resolved: oddsEventId, home: game.homeTeam, away: game.awayTeam });
      } catch (err: any) {
        console.warn(`[MLB orchestrator] Could not resolve odds event ID for game ${gameId}:`, err.message);
        pLog(gameId, "oddsEventId:error", { error: err.message });
      }
    }

    // ── Batter markets: evaluate each hitter in the starting lineup ────────────
    for (const market of BATTER_MARKETS) {
      for (const batter of state.battingOrder) {
        // ── Input validation: skip player if required context is missing ─────
        if (!batter.playerId || batter.playerId === "unknown") {
          console.warn(`[MLB orchestrator] Skipping batter — missing playerId (market: ${market})`);
          continue;
        }
        if (!batter.slot || batter.slot < 1 || batter.slot > 9) {
          console.warn(`[MLB orchestrator] Skipping ${batter.playerName} — invalid battingOrderSlot: ${batter.slot} (market: ${market})`);
          continue;
        }
        if (!gameId) {
          console.warn(`[MLB orchestrator] Skipping ${batter.playerName} — missing gameId (market: ${market})`);
          continue;
        }
        if (!state.inning || state.inning < 1) {
          console.warn(`[MLB orchestrator] Skipping ${batter.playerName} — inning not set: ${state.inning} (market: ${market})`);
          continue;
        }

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

        const resolvedLine = await resolveBookLine(oddsEventId, batter.playerName, market);
        if (resolvedLine === null) continue;
        if (resolvedLine.isDegraded) anyDegraded = true;

        const input: MLBPropInput = {
          playerId: batter.playerId,
          playerName: batter.playerName,
          team: batter.team,
          opponent: "",
          gameId,
          market,
          bookLine: resolvedLine.line,
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

        pLog(gameId, "engineInput", { player: input.playerName, market: input.market, bookLine: input.bookLine, inning: input.inning });

        const guardError = validateMLBInput(input);
        if (guardError) {
          console.warn(`[MLB orchestrator] Skipping ${batter.playerName}/${market}: ${guardError}`);
          continue;
        }

        try {
          const output = calculateMLBPropEdge(input);
          pLog(gameId, "engineOutput", { player: output.playerName, market: output.market, edge: output.edge, tier: output.confidenceTier, suppressed: output.suppressed });
          recordMLBDiagnostic(output);

          // ── Per-player debug logging for signal integrity verification ──────
          console.log(`[MLB engine] playerId=${batter.playerId} player="${batter.playerName}" market=${market} slot=${batter.slot} inning=${state.inning} remainingPA=${remainingPA} calibratedProbOver=${output.calibratedProbabilityOver.toFixed(2)} calibratedProbUnder=${output.calibratedProbabilityUnder.toFixed(2)} edge=${output.edge.toFixed(2)} side=${output.recommendedSide}`);

          outputs.push({ ...output });
        } catch (err: any) {
          console.warn(`[MLB orchestrator] engine error for ${batter.playerName} / ${market}:`, err.message);
        }
      }
    }

    // ── Pitcher markets: evaluate active pitcher only (skip unknown) ────────────
    const activePitcher = state.pitcherInGame;

    const pitcherToEval = activePitcher && activePitcher.playerId && activePitcher.playerId !== "unknown"
      ? activePitcher
      : null;

    if (!pitcherToEval) {
      console.warn(`[MLB orchestrator] Skipping pitcher markets — no identified active pitcher for game ${gameId}`);
    }

    if (pitcherToEval) {
      const pitcherCtx = pitcherCtxCache?.byPitcherId?.[pitcherToEval.playerId];

      for (const market of PITCHER_MARKETS) {
        const { remainingPA, remainingAB } = estimateRemainingPA(
          state.inning,
          state.isTopInning,
          5 // neutral batting order slot for pitcher PA estimate
        );

        const resolvedPitcherLine = await resolveBookLine(oddsEventId, pitcherToEval.playerName, market);
        if (resolvedPitcherLine === null) continue;
        if (resolvedPitcherLine.isDegraded) anyDegraded = true;

        const input: MLBPropInput = {
          playerId: pitcherToEval.playerId,
          playerName: pitcherToEval.playerName,
          team: pitcherToEval.team,
          opponent: "",
          gameId,
          market,
          bookLine: resolvedPitcherLine.line,
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

        pLog(gameId, "engineInput:pitcher", { player: input.playerName, market: input.market, bookLine: input.bookLine });

        const guardError = validateMLBInput(input);
        if (guardError) {
          console.warn(`[MLB orchestrator] Skipping pitcher ${pitcherToEval.playerName}/${market}: ${guardError}`);
          continue;
        }

        try {
          const output = calculateMLBPropEdge(input);
          pLog(gameId, "engineOutput:pitcher", { player: output.playerName, market: output.market, edge: output.edge, tier: output.confidenceTier });
          recordMLBDiagnostic(output);

          // ── Per-player debug logging for signal integrity verification ──────
          console.log(`[MLB engine] playerId=${pitcherToEval.playerId} player="${pitcherToEval.playerName}" market=${market} inning=${state.inning} remainingPA=${remainingPA} calibratedProbOver=${output.calibratedProbabilityOver.toFixed(2)} calibratedProbUnder=${output.calibratedProbabilityUnder.toFixed(2)} edge=${output.edge.toFixed(2)} side=${output.recommendedSide}`);

          outputs.push({ ...output });
        } catch (err: any) {
          console.warn(`[MLB orchestrator] engine error for pitcher ${pitcherToEval.playerName} / ${market}:`, err.message);
        }
      }
    }

    const now = Date.now();
    mlbEdgeCache.set(gameId, { gameId, outputs, updatedAt: now, createdAt: now, isDegraded: anyDegraded });
    console.log(`[MLB orchestrator] triggerEngine: game ${gameId} — ${outputs.length} outputs`);
    return outputs;
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const liveOrchestrator = new LiveGameOrchestrator();
