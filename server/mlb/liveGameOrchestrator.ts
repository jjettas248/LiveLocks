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
  syncGameBoxScore,
  syncContactData,
  syncPitcherContext,
  syncWeather,
  syncBullpenUsage,
  syncPitcherSeasonStats,
  syncBatterRollingStats,
  syncBvPMatchup,
  mlbGameCache,
  mlbPlayerCache,
  type GameStateCache,
} from "./dataPullService";
import { estimateRemainingPA, estimatePitcherRemainingBF } from "./paEstimator";
import { calculateMLBPropEdge, hasRealOdds, canShowSignal } from "./markets";
import { recordMLBDiagnostic } from "./diagnostics";
import type { MLBPropInput, MLBPropOutput, MLBMarket, MLBQualifiedSignal } from "./types";
import { MARKET_QUALIFY_FLOOR } from "./types";
import { runIntegrityFirewall, logFirewallResult } from "./integrityFirewall";
import { computeSignalScore, deriveSignalTags, deriveFeedTags, deriveGameCardTags, isPlayerGlowEligible } from "./signalScore";
import { resolveMLBOddsEventId, getMLBPlayerOdds } from "../oddsService";

// ── Engine dedup lock ─────────────────────────────────────────────────────────
const LAST_RUN = new Map<string, number>();
const DEDUP_WINDOW_MS = 30_000;

function shouldSkip(gameId: string): boolean {
  const last = LAST_RUN.get(gameId);
  if (last === undefined) return false;
  return Date.now() - last < DEDUP_WINDOW_MS;
}

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
  "home_runs",
  "hrr",
];

const PITCHER_MARKETS: MLBMarket[] = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed"];

// ── Previously-resolved line cache ───────────────────────────────────────────
// Persists the last successfully fetched sportsbook line per event+player+market
// within this server process. Used as the second-priority fallback when the
// odds service is unreachable or has no line posted yet.
// Key: "oddsEventId|playerNameNorm|market" — Value: last known real line
const priorResolvedLines = new Map<string, number>();

// Preferred bookmaker order for deterministic line selection (matches manual flow).
// First match wins; unlisted bookmakers are used only as a last resort.
const PREFERRED_BOOKMAKERS = ["draftkings", "fanduel", "hardrockbet"];

type ResolvedLine = { line: number; overOdds: number | null; underOdds: number | null; isDegraded: boolean };

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
        const entry = oddsResult[preferred];
        const line = entry.line;
        if (typeof line === "number" && isFinite(line) && line > 0) {
          priorResolvedLines.set(cacheKey, line);
          pLog(oddsEventId, `odds:bookLine:${isOddsDegraded ? "degraded" : "live"}`, { player: playerName, market, line, book: preferred });
          return {
            line,
            overOdds: typeof entry.overOdds === "number" && isFinite(entry.overOdds) ? entry.overOdds : null,
            underOdds: typeof entry.underOdds === "number" && isFinite(entry.underOdds) ? entry.underOdds : null,
            isDegraded: isOddsDegraded,
          };
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
    return { line: prior, overOdds: null, underOdds: null, isDegraded: true };
  }

  // (3) Use standard derived line as fallback — allows engine to generate signals for all markets
  const DERIVED_LINES: Record<string, number> = {
    hits: 0.5,
    total_bases: 1.5,
    pitcher_strikeouts: 4.5,
    pitcher_outs: 16.5,
    hits_allowed: 5.5,
    walks_allowed: 2.5,
    home_runs: 0.5,
    hrr: 1.5,
  };
  const derivedLine = DERIVED_LINES[market];
  if (derivedLine !== undefined) {
    console.log(`[MLB orchestrator] Using derived line for ${playerName}/${market}: ${derivedLine}`);
    pLog(oddsEventId ?? "unknown", "odds:bookLine:derived", { player: playerName, market, line: derivedLine });
    return { line: derivedLine, overOdds: -110, underOdds: -110, isDegraded: true };
  }

  console.warn(`[MLB orchestrator] No line available for ${playerName}/${market} — market skipped`);
  pLog(oddsEventId ?? "unknown", "odds:bookLine:skipped", { player: playerName, market, reason: "noLineAvailable" });
  return null;
}

// ── MLB status normalization ──────────────────────────────────────────────────
export function normalizeMlbStatus(raw: string | undefined): "live" | "pregame" | "final" | "unknown" {
  if (!raw) return "unknown";
  const s = raw.toLowerCase().replace(/[\s_-]/g, "");
  if (s === "live" || s === "inprogress") return "live";
  if (s === "preview" || s === "pregame" || s === "scheduled") return "pregame";
  if (s === "final" || s === "gameover" || s === "completed") return "final";
  return "unknown";
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

    // Weather every 10 minutes — only for games with a resolved gamePk
    this.timers.push(
      setInterval(() => {
        for (const game of getActiveGames()) {
          if (!game.gamePk) continue;
          syncWeather(game.gamePk, game.gameId).catch(console.error);
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

    // Look up the registered game to get the MLB Stats gamePk (may differ from ESPN event ID)
    const registeredGame = getGame(gameId);
    const statsPk: string | undefined = registeredGame?.gamePk;

    // Guard: only call Stats API when a valid gamePk is known.
    // Using the ESPN event ID as a fake gamePk would cause 404s against the Stats API.
    if (!statsPk) {
      console.log(`[MLB orchestrator] pollGame(${gameId}): gamePk not yet resolved — skipping Stats API calls`);
      return;
    }

    await syncGameState(statsPk, gameId);
    await syncGameBoxScore(statsPk, gameId);
    await syncContactData(statsPk, gameId);
    await syncPitcherContext(statsPk, gameId);

    const stateAfterSync = mlbGameCache.gameState[gameId];
    if (stateAfterSync) {
      const playerSyncPromises: Promise<void>[] = [];

      if (stateAfterSync.pitcherInGame?.playerId) {
        playerSyncPromises.push(syncPitcherSeasonStats(stateAfterSync.pitcherInGame.playerId));
      }

      for (const batter of stateAfterSync.battingOrder) {
        if (batter.playerId && batter.playerId !== "unknown") {
          playerSyncPromises.push(syncBatterRollingStats(batter.playerId));
          if (stateAfterSync.pitcherInGame?.playerId) {
            playerSyncPromises.push(syncBvPMatchup(batter.playerId, stateAfterSync.pitcherInGame.playerId));
          }
        }
      }

      await Promise.allSettled(playerSyncPromises);
    }

    const newState = mlbGameCache.gameState[gameId];
    if (!newState) return;

    // Fetch and normalize live game status before triggering engine
    // Engine must only run for genuinely live games
    let normalizedStatus: "live" | "pregame" | "final" | "unknown" = "unknown";
    let statusSource = "none";
    try {
      const statusUrl = `https://statsapi.mlb.com/api/v1/game/${statsPk}/feed/live`;
      const statusRes = await fetch(statusUrl, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(4000),
      });
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as any;
        const rawAbstractState: string = statusData.gameData?.status?.abstractGameState ?? "";
        normalizedStatus = normalizeMlbStatus(rawAbstractState);
        if (normalizedStatus !== "unknown") statusSource = "mlbStatsApi";
      }
    } catch {
      console.warn(`[MLB orchestrator] pollGame: MLB Stats API status fetch failed for game ${gameId}`);
    }

    // Fallback: if MLB Stats API returned unknown, use ESPN status from discovery
    if (normalizedStatus === "unknown" && registeredGame) {
      const espnRaw = registeredGame.espnStatus ?? "";
      if (espnRaw === "STATUS_IN_PROGRESS" || espnRaw === "STATUS_DELAYED") {
        normalizedStatus = "live";
        statusSource = "espnFallback";
      } else if (espnRaw === "STATUS_FINAL" || espnRaw === "STATUS_FORFEIT") {
        normalizedStatus = "final";
        statusSource = "espnFallback";
      } else if (registeredGame.startTime) {
        const startMs = new Date(registeredGame.startTime).getTime();
        if (startMs > 0 && Date.now() >= startMs) {
          normalizedStatus = "live";
          statusSource = "timeFallback";
        }
      }
      if (statusSource !== "none") {
        console.log(`[MLB orchestrator] Status fallback for game ${gameId}: ${normalizedStatus} (source=${statusSource}, espnStatus=${espnRaw})`);
      }
    }

    if (prevState) {
      const triggers = this.detectStateChange(prevState, newState);
      if (triggers.length > 0) {
        console.log(`[MLB orchestrator] State change for game ${gameId} (status=${normalizedStatus}, source=${statusSource}): ${triggers.join(", ")}`);

        // On inning change, also sync bullpen
        if (triggers.includes("inning_change")) {
          await syncBullpenUsage(statsPk, gameId);
        }

        // Only trigger engine when game is confirmed live
        await this.triggerEngine(gameId, normalizedStatus);
      }
    } else if (normalizedStatus === "live") {
      // First time seeing this game — if it's already live, trigger engine immediately
      console.log(`[MLB orchestrator] First poll for live game ${gameId} (status=${normalizedStatus}, source=${statusSource}) — triggering engine`);
      await this.triggerEngine(gameId, normalizedStatus);
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

  private qualifySignal(gameId: string, input: MLBPropInput, output: MLBPropOutput): MLBQualifiedSignal | null {
    if (output.recommendedSide !== "OVER" && output.recommendedSide !== "UNDER") {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — invalid side="${output.recommendedSide}"`);
      return null;
    }

    if (typeof output.bookLine !== "number" || !Number.isFinite(output.bookLine) || output.bookLine <= 0) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — invalid bookLine=${output.bookLine}`);
      return null;
    }
    if (typeof output.calibratedProbabilityOver !== "number" || !Number.isFinite(output.calibratedProbabilityOver) || output.calibratedProbabilityOver <= 0) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — invalid probOver=${output.calibratedProbabilityOver}`);
      return null;
    }
    if (typeof output.calibratedProbabilityUnder !== "number" || !Number.isFinite(output.calibratedProbabilityUnder) || output.calibratedProbabilityUnder <= 0) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — invalid probUnder=${output.calibratedProbabilityUnder}`);
      return null;
    }

    if (output.suppressed) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — suppressed`);
      return null;
    }

    const sideProbability = output.recommendedSide === "OVER"
      ? output.calibratedProbabilityOver
      : output.calibratedProbabilityUnder;
    const qualifyFloor = MARKET_QUALIFY_FLOOR[output.market] ?? 60;
    if (sideProbability < qualifyFloor) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — prob=${sideProbability.toFixed(1)} < ${qualifyFloor} gate`);
      return null;
    }

    const hydrationOk = canShowSignal({
      line: output.bookLine,
      odds: (output.overOdds !== null || output.underOdds !== null)
        ? { overOdds: output.overOdds, underOdds: output.underOdds }
        : null,
      projection: output.projection,
      oddsUpdatedAt: output.oddsUpdatedAt,
      projectionUpdatedAt: output.projectionUpdatedAt,
      calibratedProbabilityOver: output.calibratedProbabilityOver,
      calibratedProbabilityUnder: output.calibratedProbabilityUnder,
    });
    if (!hydrationOk) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — hydration gate failed`);
      return null;
    }

    if ((output.market === "hr" || output.market === "home_runs") && output.recommendedSide === "UNDER") {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — HR UNDER suppressed (unplayable odds)`);
      return null;
    }

    if (output.recommendedSide === "OVER" && output.projection < output.bookLine) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — side inconsistency: OVER but proj=${output.projection} < line=${output.bookLine}`);
      return null;
    }
    if (output.recommendedSide === "UNDER" && output.projection > output.bookLine) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — side inconsistency: UNDER but proj=${output.projection} > line=${output.bookLine}`);
      return null;
    }

    const scoreBreakdown = computeSignalScore(input, output);

    if (scoreBreakdown.total < 55) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — signalScore=${scoreBreakdown.total} < 55 gate (tier=${scoreBreakdown.confidenceTier})`);
      return null;
    }

    const signalTags = deriveSignalTags(input, output, scoreBreakdown);
    const feedTags = deriveFeedTags(input, output, scoreBreakdown);
    const glowEligible = isPlayerGlowEligible(scoreBreakdown, signalTags);

    const signal: MLBQualifiedSignal = {
      id: `${gameId}_${output.playerId}_${output.market}`,
      gameId,
      playerId: output.playerId,
      playerName: output.playerName,
      team: (output as any).team ?? input.team ?? "",
      market: output.market,
      side: output.recommendedSide,
      sportsbook: output.sportsbook,
      line: output.bookLine,
      impliedProbability: null,
      engineProbability: output.calibratedProbability,
      projection: output.projection,
      evPct: output.evPct,
      confidenceTier: scoreBreakdown.confidenceTier,
      signalScore: scoreBreakdown.total,
      reasons: output.explanationBullets,
      feedTags: feedTags as string[],
      signalTags: signalTags as string[],
      playerGlowEligible: glowEligible,
      gameCardSignalTags: [],
      formIndicator: output.formIndicator,
      isExperimental: output.isExperimental,
      engineGeneratedAt: output.engineGeneratedAt,
      badges: [],
      riskFlags: [],
      drivers: {
        edge: output.edge,
        probability: output.calibratedProbability,
        projection: output.projection,
        formScore: output.formScore,
        contextScore: output.contextScore,
      },
      timestamps: {
        engineGeneratedAt: new Date(output.engineGeneratedAt).toISOString(),
        oddsUpdatedAt: new Date(output.oddsUpdatedAt).toISOString(),
        gameStateUpdatedAt: new Date(output.projectionUpdatedAt).toISOString(),
      },
    };

    console.log(`[MLB QUALIFY OK][${gameId}] ${output.playerName}/${output.market} side=${output.recommendedSide} score=${scoreBreakdown.total} tier=${scoreBreakdown.confidenceTier} tags=[${signalTags.join(",")}]`);
    return signal;
  }

  private buildWatchSignal(gameId: string, input: MLBPropInput, output: MLBPropOutput): MLBQualifiedSignal | null {
    let effectiveSide = output.recommendedSide;
    if (effectiveSide !== "OVER" && effectiveSide !== "UNDER") {
      const overP = output.calibratedProbabilityOver ?? 0;
      const underP = output.calibratedProbabilityUnder ?? 0;
      if (overP > underP && overP > 0) effectiveSide = "OVER";
      else if (underP > 0) effectiveSide = "UNDER";
      else return null;
    }

    if ((output.market === "hr" || output.market === "home_runs") && effectiveSide === "UNDER") {
      return null;
    }

    const bookLine = typeof output.bookLine === "number" && Number.isFinite(output.bookLine) && output.bookLine > 0
      ? output.bookLine
      : (typeof output.projection === "number" && Number.isFinite(output.projection) ? Math.round(output.projection * 2) / 2 : null);
    if (bookLine === null) return null;

    const sideProbability = effectiveSide === "OVER"
      ? output.calibratedProbabilityOver
      : output.calibratedProbabilityUnder;
    if (!Number.isFinite(sideProbability) || sideProbability <= 0) return null;

    const scoreBreakdown = computeSignalScore(input, output);
    const signalTags = deriveSignalTags(input, output, scoreBreakdown);
    const feedTags = deriveFeedTags(input, output, scoreBreakdown);

    return {
      id: `${gameId}_${output.playerId}_${output.market}`,
      gameId,
      playerId: output.playerId,
      playerName: output.playerName,
      team: (output as any).team ?? input.team ?? "",
      market: output.market,
      side: effectiveSide as "OVER" | "UNDER",
      sportsbook: output.sportsbook,
      line: bookLine,
      impliedProbability: null,
      engineProbability: output.calibratedProbability,
      projection: output.projection,
      evPct: output.evPct,
      confidenceTier: scoreBreakdown.total >= 55 ? scoreBreakdown.confidenceTier : "WATCHLIST" as any,
      signalScore: scoreBreakdown.total,
      reasons: output.explanationBullets,
      feedTags: feedTags as string[],
      signalTags: signalTags as string[],
      playerGlowEligible: false,
      gameCardSignalTags: [],
      formIndicator: output.formIndicator,
      isExperimental: output.isExperimental,
      engineGeneratedAt: output.engineGeneratedAt,
      badges: [],
      riskFlags: [],
      drivers: {
        edge: output.edge,
        probability: output.calibratedProbability,
        projection: output.projection,
        formScore: output.formScore,
        contextScore: output.contextScore,
      },
      timestamps: {
        engineGeneratedAt: new Date(output.engineGeneratedAt).toISOString(),
        oddsUpdatedAt: new Date(output.oddsUpdatedAt).toISOString(),
        gameStateUpdatedAt: new Date(output.projectionUpdatedAt).toISOString(),
      },
    };
  }

  async triggerEngine(gameId: string, normalizedStatus: "live" | "pregame" | "final" | "unknown"): Promise<MLBPropOutput[]> {
    const outputs: MLBPropOutput[] = [];
    const qualifiedSignals: MLBQualifiedSignal[] = [];
    const allSignals: MLBQualifiedSignal[] = [];
    let marketsEvaluated = 0;
    let signalsQualified = 0;
    let signalsRejected = 0;
    let scoreSum = 0;
    let anyDegraded = false;
    const state = mlbGameCache.gameState[gameId];
    const game = getGame(gameId);

    // Strict status gate — engine MUST receive explicit "live" status.
    // If status is undefined, unknown, pregame, or final — skip entirely.
    // This prevents fabricated signals for non-live games.
    if (normalizedStatus !== "live") {
      console.log(`[MLB orchestrator] triggerEngine skipped for game ${gameId}: normalizedStatus=${normalizedStatus ?? "undefined"} (must be "live")`);
      return outputs;
    }

    // Dedup lock — skip if engine ran within the last 30 seconds for this game.
    if (shouldSkip(gameId)) {
      console.log(`[MLB orchestrator] triggerEngine dedup-skipped for game ${gameId} (ran within ${DEDUP_WINDOW_MS}ms)`);
      return outputs;
    }
    LAST_RUN.set(gameId, Date.now());

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

        console.log(`[MLB MARKET INPUT][${gameId}][${market}] { playerName: "${batter.playerName}", playerId: "${batter.playerId}", inning: ${state.inning} }`);

        const resolvedLine = await resolveBookLine(oddsEventId, batter.playerName, market);
        if (resolvedLine === null) {
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "no_book_line" }`);
          continue;
        }
        if (resolvedLine.isDegraded) anyDegraded = true;

        // hasRealOdds gate — skip signal computation if odds are not valid
        const resolvedMarketObj = { line: resolvedLine.line, odds: (resolvedLine.overOdds !== null || resolvedLine.underOdds !== null) ? { overOdds: resolvedLine.overOdds, underOdds: resolvedLine.underOdds } : null };
        if (!hasRealOdds(resolvedMarketObj)) {
          console.warn(`[MLB orchestrator] hasRealOdds failed for ${batter.playerName}/${market} — signalLocked=false, skipping computation`);
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "no_real_odds", line: ${resolvedLine.line} }`);
          continue;
        }

        const rollingStats = mlbPlayerCache.batterRollingStats[batter.playerId];
        const pitcherSeasonStats = pitcher ? mlbPlayerCache.pitcherSeasonStats[pitcher.playerId] : undefined;
        const bvpKey = pitcher ? `${batter.playerId}_vs_${pitcher.playerId}` : null;
        const bvpData = bvpKey ? mlbPlayerCache.bvpMatchups[bvpKey] : undefined;

        const batterSeasonAvg = rollingStats?.seasonAvg ?? 0.250;
        const rollingAvg = rollingStats?.last15?.avg;
        const effectiveSeasonAvg = rollingAvg != null ? rollingAvg : batterSeasonAvg;

        const boxScorePlayer = mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId];
        let currentStatForMarket = 0;
        if (boxScorePlayer) {
          switch (market) {
            case "hits": currentStatForMarket = boxScorePlayer.hits; break;
            case "home_runs": case "hrr": currentStatForMarket = boxScorePlayer.hr; break;
            case "total_bases": currentStatForMarket = boxScorePlayer.tb; break;
            case "pitcher_strikeouts": case "hits_allowed": case "walks_allowed": currentStatForMarket = 0; break;
            default: currentStatForMarket = boxScorePlayer.hits; break;
          }
        }

        const input: MLBPropInput = {
          playerId: batter.playerId,
          playerName: batter.playerName,
          team: batter.team,
          opponent: "",
          gameId,
          market,
          bookLine: resolvedLine.line,
          overOdds: resolvedLine.overOdds,
          underOdds: resolvedLine.underOdds,
          seasonAvg: effectiveSeasonAvg,
          plateAppearances: state.pitchCount > 0 ? Math.max(1, state.battingOrder.length) : 0,
          atBats: boxScorePlayer ? boxScorePlayer.ab : Math.max(0, state.pitchCount > 0 ? Math.max(1, state.battingOrder.length) : 0),
          currentStatValue: currentStatForMarket,
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
            xBA: playerContact?.xBA ?? null,
            xSLG: playerContact?.xSLG ?? null,
          },
          pitcher: {
            pitchCount: pitcher ? state.pitchCount : 0,
            timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
            era: pitcherSeasonStats?.era ?? null,
            whip: pitcherSeasonStats?.whip ?? null,
            kPer9: pitcherSeasonStats?.kPer9 ?? null,
            bbPer9: pitcherSeasonStats?.bbPer9 ?? null,
            managerLeashShort,
            isPitcherCollapsing,
            pitchMix: pitcherCtx?.pitchMix ?? [],
            throws: pitcher?.throws ?? null,
          },
          ...(bvpData && bvpData.atBats > 0 ? {
            bvpHistory: {
              atBats: bvpData.atBats,
              hits: bvpData.hits,
              homeRuns: bvpData.homeRuns,
              strikeouts: bvpData.strikeouts,
              avg: bvpData.avg,
            },
          } : {}),
          ...(rollingStats ? {
            rollingForm: {
              last7Avg: rollingStats.last7.avg,
              last15Avg: rollingStats.last15.avg,
              last30Avg: rollingStats.last30.avg,
              last7Ops: rollingStats.last7.ops,
              last15Ops: rollingStats.last15.ops,
            },
          } : {}),
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
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "guard_error:${guardError}" }`);
          continue;
        }

        // ── Structured per-player input log ────────────────────────────────
        console.log(`[MLB engine:input] ${JSON.stringify({
          playerId: batter.playerId,
          playerContext: {
            gameId,
            battingOrderSlot: batter.slot,
            inning: state.inning,
            isTopInning: state.isTopInning,
            currentStats: {
              ab: input.atBats,
              h: input.currentStatValue,
              remainingPA,
            },
            pitcherContext: {
              pitchCount: input.pitcher.pitchCount,
              timesThrough: input.pitcher.timesThrough,
              isPitcherCollapsing: input.pitcher.isPitcherCollapsing,
            },
            parkFactor: input.weatherPark.parkFactor,
          },
          bookLine: input.bookLine,
          market,
        })}`);

        try {
          const rawOutput = calculateMLBPropEdge(input);
          marketsEvaluated++;

          const fwResult = runIntegrityFirewall(rawOutput);
          logFirewallResult(gameId, rawOutput.playerName, market, fwResult);

          if (fwResult.hardReject) {
            signalsRejected++;
            console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "firewall_hard_reject" }`);
            continue;
          }

          const output = fwResult.cappedOutput;

          pLog(gameId, "engineOutput", { player: output.playerName, market: output.market, edge: output.edge, tier: output.confidenceTier, suppressed: output.suppressed });
          recordMLBDiagnostic(output);

          console.log(`[MLB engine] playerId=${batter.playerId} player="${batter.playerName}" market=${market} slot=${batter.slot} inning=${state.inning} remainingPA=${remainingPA} calibratedProbOver=${output.calibratedProbabilityOver.toFixed(2)} calibratedProbUnder=${output.calibratedProbabilityUnder.toFixed(2)} edge=${output.edge.toFixed(2)} side=${output.recommendedSide}`);

          outputs.push({ ...output });

          const qResult = this.qualifySignal(gameId, input, output);
          if (qResult) {
            qualifiedSignals.push(qResult);
            allSignals.push(qResult);
            signalsQualified++;
            scoreSum += qResult.signalScore;
          } else {
            signalsRejected++;
            const watchSig = this.buildWatchSignal(gameId, input, output);
            if (watchSig) allSignals.push(watchSig);
          }
        } catch (err: any) {
          console.warn(`[MLB orchestrator] engine error for ${batter.playerName} / ${market}:`, err.message);
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "engine_error:${(err as any).message}" }`);
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
        const currentPitchCount = pitcherCtx?.pitchCount ?? state.pitchCount ?? 0;
        const { remainingBF, remainingIP } = estimatePitcherRemainingBF(
          state.inning,
          currentPitchCount
        );
        const remainingPA = remainingBF;
        const remainingAB = remainingBF;

        console.log(`[MLB MARKET INPUT][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", playerId: "${pitcherToEval.playerId}", inning: ${state.inning} }`);

        const resolvedPitcherLine = await resolveBookLine(oddsEventId, pitcherToEval.playerName, market);
        if (resolvedPitcherLine === null) {
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", reason: "no_book_line" }`);
          continue;
        }
        if (resolvedPitcherLine.isDegraded) anyDegraded = true;

        // hasRealOdds gate — skip signal computation if odds are not valid
        const resolvedPitcherMarketObj = { line: resolvedPitcherLine.line, odds: (resolvedPitcherLine.overOdds !== null || resolvedPitcherLine.underOdds !== null) ? { overOdds: resolvedPitcherLine.overOdds, underOdds: resolvedPitcherLine.underOdds } : null };
        if (!hasRealOdds(resolvedPitcherMarketObj)) {
          console.warn(`[MLB orchestrator] hasRealOdds failed for pitcher ${pitcherToEval.playerName}/${market} — signalLocked=false, skipping computation`);
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", reason: "no_real_odds", line: ${resolvedPitcherLine.line} }`);
          continue;
        }

        const pitcherSeasonForPitcherMarket = mlbPlayerCache.pitcherSeasonStats[pitcherToEval.playerId];

        const pitcherKper9 = pitcherSeasonForPitcherMarket?.kPer9;
        const pitcherSeasonAvg = market === "pitcher_strikeouts"
          ? (pitcherKper9 != null ? pitcherKper9 : 6.0)
          : market === "pitcher_outs"
            ? 0.65
          : market === "hits_allowed"
            ? (pitcherSeasonForPitcherMarket?.whip != null ? pitcherSeasonForPitcherMarket.whip * 0.72 * 6 : 5.0)
            : 5.0;

        const input: MLBPropInput = {
          playerId: pitcherToEval.playerId,
          playerName: pitcherToEval.playerName,
          team: pitcherToEval.team,
          opponent: "",
          gameId,
          market,
          bookLine: resolvedPitcherLine.line,
          overOdds: resolvedPitcherLine.overOdds,
          underOdds: resolvedPitcherLine.underOdds,
          seasonAvg: pitcherSeasonAvg,
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
            xBA: null,
            xSLG: null,
          },
          pitcher: {
            pitchCount: state.pitchCount,
            timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
            era: pitcherSeasonForPitcherMarket?.era ?? null,
            whip: pitcherSeasonForPitcherMarket?.whip ?? null,
            kPer9: pitcherSeasonForPitcherMarket?.kPer9 ?? null,
            bbPer9: pitcherSeasonForPitcherMarket?.bbPer9 ?? null,
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
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", reason: "guard_error:${guardError}" }`);
          continue;
        }

        try {
          const rawOutput = calculateMLBPropEdge(input);

          const fwResult = runIntegrityFirewall(rawOutput);
          logFirewallResult(gameId, rawOutput.playerName, market, fwResult);

          if (fwResult.hardReject) {
            signalsRejected++;
            console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", reason: "firewall_hard_reject" }`);
            continue;
          }

          const output = fwResult.cappedOutput;

          pLog(gameId, "engineOutput:pitcher", { player: output.playerName, market: output.market, edge: output.edge, tier: output.confidenceTier });
          recordMLBDiagnostic(output);

          console.log(`[MLB engine] playerId=${pitcherToEval.playerId} player="${pitcherToEval.playerName}" market=${market} inning=${state.inning} remainingPA=${remainingPA} calibratedProbOver=${output.calibratedProbabilityOver.toFixed(2)} calibratedProbUnder=${output.calibratedProbabilityUnder.toFixed(2)} edge=${output.edge.toFixed(2)} side=${output.recommendedSide}`);

          outputs.push({ ...output });
          marketsEvaluated++;

          const qResult = this.qualifySignal(gameId, input, output);
          if (qResult) {
            qualifiedSignals.push(qResult);
            allSignals.push(qResult);
            signalsQualified++;
            scoreSum += qResult.signalScore;
          } else {
            signalsRejected++;
            const watchSig = this.buildWatchSignal(gameId, input, output);
            if (watchSig) allSignals.push(watchSig);
          }
        } catch (err: any) {
          console.warn(`[MLB orchestrator] engine error for pitcher ${pitcherToEval.playerName} / ${market}:`, err.message);
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", reason: "engine_error:${(err as any).message}" }`);
        }
      }
    }

    const now = Date.now();
    const signalLocked = allSignals.length > 0;

    const gameCardTags = deriveGameCardTags(
      qualifiedSignals.map((s) => ({
        signalTags: s.signalTags as any,
        market: s.market,
        recommendedSide: s.side,
        signalScore: s.signalScore,
      }))
    );
    for (const sig of qualifiedSignals) {
      sig.gameCardSignalTags = gameCardTags as string[];
    }

    allSignals.sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0));

    mlbEdgeCache.set(gameId, {
      gameId,
      outputs,
      qualifiedSignals,
      allSignals,
      gameCardTags: gameCardTags as string[],
      updatedAt: now,
      createdAt: now,
      isDegraded: anyDegraded,
      signalLocked,
    });

    const avgScore = signalsQualified > 0 ? Math.round(scoreSum / signalsQualified) : 0;
    console.log(`[MLB QUALIFICATION][${gameId}] marketsEvaluated=${marketsEvaluated} qualified=${signalsQualified} rejected=${signalsRejected} allSignals=${allSignals.length} avgScore=${avgScore} gameCardTags=[${gameCardTags.join(",")}]`);
    return outputs;
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const liveOrchestrator = new LiveGameOrchestrator();
