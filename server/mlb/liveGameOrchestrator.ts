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
  syncSavantSeasonForLineup,
  syncOpenMeteoWeather,
  mlbGameCache,
  mlbPlayerCache,
  type GameStateCache,
} from "./dataPullService";
import { estimateRemainingPA, estimatePitcherRemainingBF } from "./paEstimator";
import { getMarketParkFactor, isVenueIndoors } from "./dataSources";
import { calculateMLBPropEdge, hasRealOdds, canShowSignal } from "./markets";
import { recordMLBDiagnostic } from "./diagnostics";
import type { MLBPropInput, MLBPropOutput, MLBMarket, MLBQualifiedSignal } from "./types";
import { MARKET_QUALIFY_FLOOR, ALL_MLB_MARKETS } from "./types";
import { runIntegrityFirewall, logFirewallResult } from "./integrityFirewall";
import { computeSignalScore, deriveSignalTags, deriveFeedTags, deriveGameCardTags, isPlayerGlowEligible, derivePitcherSignals, computeFullOpportunityScore, computeLiveOpportunityScore } from "./signalScore";
import { resolveMLBOddsEventId, getMLBPlayerOdds } from "../oddsService";
import {
  classifyBatterArchetype,
  classifyPitcherArchetype,
  generateThesis,
  MARKET_VOLATILITY,
  type MLBBatterArchetype,
  type MLBPitcherArchetype,
} from "./archetypes";
import { applySafetyCeiling, applyDirectionalBias } from "./calibration";
import { applyFamilySuppression } from "./marketFamily";
import { trackSignalDirection } from "./directionalBias";
import { evaluateHRAlert, markAlertSent, type HRAlertInput } from "./evaluateHRAlert";
import { storage } from "../storage";

// ── HR alert grading tracker ──────────────────────────────────────────────────
const KNOWN_HR_COUNTS = new Map<string, number>();

function checkAndGradeHR(playerId: string, gameId: string, currentHR: number) {
  const key = `${gameId}_${playerId}`;
  const prevHR = KNOWN_HR_COUNTS.get(key) ?? 0;
  KNOWN_HR_COUNTS.set(key, currentHR);
  if (currentHR > prevHR && prevHR >= 0) {
    storage.gradeAlertsForPlayer(playerId, gameId, "HR").catch(() => {});
  }
}

// ── Engine dedup lock ─────────────────────────────────────────────────────────
const LAST_RUN = new Map<string, number>();
const DEDUP_WINDOW_MS = 15_000;

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
  "batter_strikeouts",
];

const PITCHER_MARKETS: MLBMarket[] = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"];

// ── Previously-resolved line cache ───────────────────────────────────────────
// Persists the last successfully fetched sportsbook line per event+player+market
// within this server process. Used as the second-priority fallback when the
// odds service is unreachable or has no line posted yet.
// Key: "oddsEventId|playerNameNorm|market" — Value: last known real line
const priorResolvedLines = new Map<string, number>();

// Preferred bookmaker order for deterministic line selection (matches manual flow).
// First match wins; unlisted bookmakers are used only as a last resort.
const PREFERRED_BOOKMAKERS = ["draftkings", "fanduel", "hardrockbet"];

type ResolvedLine = { line: number; overOdds: number | null; underOdds: number | null; isDegraded: boolean; source: "live" | "prior" | "default" };

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
            source: isOddsDegraded ? "prior" : "live",
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
    return { line: prior, overOdds: null, underOdds: null, isDegraded: true, source: "prior" };
  }

  const DEFAULT_LINES: Partial<Record<MLBMarket, number>> = {
    home_runs: 0.5,
  };
  const defaultLine = DEFAULT_LINES[market];
  if (defaultLine !== undefined) {
    console.log(`[MLB orchestrator] Using default line ${defaultLine} for ${playerName}/${market} (no odds available)`);
    pLog(oddsEventId ?? "unknown", "odds:bookLine:default", { player: playerName, market, line: defaultLine });
    return { line: defaultLine, overOdds: null, underOdds: null, isDegraded: true, source: "default" };
  }

  console.log(`[MLB orchestrator] No real line for ${playerName}/${market} — SKIPPED`);
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
  | "ab_completed"
  | "ball_in_play"
  | "inning_change"
  | "pitcher_change"
  | "runner_change"
  | "pitch_count_threshold"
  | "tto_shift"
  | "lineup_substitution"
  | "hard_hit_event"
  | "out_recorded"
  | "score_change"
  | "odds_update";

const HIGH_IMPACT_TRIGGERS = new Set<StateChangeTrigger>([
  "new_ab", "ab_completed", "inning_change", "pitcher_change",
  "tto_shift", "lineup_substitution", "out_recorded", "score_change",
]);

const TRIGGER_IMPACTED_MARKETS: Record<StateChangeTrigger, MLBMarket[] | "all"> = {
  new_ab: "all",
  ab_completed: "all",
  ball_in_play: ["hits", "total_bases", "home_runs", "hrr", "batter_strikeouts", "hits_allowed", "hr_allowed"],
  inning_change: "all",
  pitcher_change: "all",
  runner_change: ["hits", "total_bases", "hrr"],
  pitch_count_threshold: ["pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"],
  tto_shift: "all",
  lineup_substitution: "all",
  hard_hit_event: ["hits", "total_bases", "home_runs", "hrr", "hits_allowed", "hr_allowed"],
  out_recorded: "all",
  score_change: "all",
  odds_update: "all",
};

// ── Polling intervals ─────────────────────────────────────────────────────────

const GAME_DISCOVERY_MS = 5 * 60 * 1000;   // 5 minutes
const GAME_STATE_MS = 10 * 1000;            // 10 seconds (via pollGame)
const WEATHER_MS = 10 * 60 * 1000;          // 10 minutes

// ── Orchestrator class ────────────────────────────────────────────────────────

export class LiveGameOrchestrator {
  private timers: ReturnType<typeof setInterval>[] = [];
  private previousStates: Map<string, GameStateCache> = new Map();
  private pollInFlight: Set<string> = new Set();

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

    console.log(`[MLB orchestrator] Started — discovery ${GAME_DISCOVERY_MS / 1000}s, state/contact/pitcher ${GAME_STATE_MS / 1000}s, weather ${WEATHER_MS / 1000}s`);
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

      // Register new games + pre-hydrate pitcher stats and weather
      for (const game of discovered) {
        const isNew = !getGame(game.gameId);
        registerGame(game);
        if (isNew && game.gamePk) {
          this.preHydrateNewGame(game).catch(console.error);
        }
      }

      // Remove games no longer active — snapshot stats before removal
      for (const existing of getActiveGames()) {
        if (!discoveredIds.has(existing.gameId)) {
          this.snapshotGamePlayerStats(existing.gameId, existing.gamePk).catch(err =>
            console.warn(`[MLB orchestrator] snapshot failed for ${existing.gameId}:`, err.message)
          );
          removeGame(existing.gameId);
          this.previousStates.delete(existing.gameId);
        }
      }
    } catch (err: any) {
      console.error("[MLB orchestrator] pollGames error:", err.message);
    }
  }

  private async snapshotGamePlayerStats(gameId: string, gamePk?: string): Promise<void> {
    const { storage } = await import("../storage");
    if (!gamePk) {
      console.log(`[MLB snapshot] No gamePk for ${gameId}, skipping snapshot`);
      return;
    }
    try {
      const url = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
      const response = await fetch(url, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`MLB boxscore API ${response.status}`);
      const data = (await response.json()) as any;
      const gameDate = new Date().toISOString().slice(0, 10);
      const stats: Array<any> = [];

      for (const side of ["away", "home"] as const) {
        const teamData = data.teams?.[side];
        if (!teamData) continue;
        const batters: number[] = teamData.batters ?? [];
        const playerMap = teamData.players ?? {};
        const teamAbbr = teamData.team?.abbreviation ?? "";
        for (const batterId of batters) {
          const entry = playerMap[`ID${batterId}`];
          if (!entry) continue;
          const batting = entry.stats?.batting ?? {};
          const slotRaw: string = entry.battingOrder ?? "0";
          const slot = Math.floor(parseInt(slotRaw, 10) / 100) || 0;
          const contactEntry = mlbGameCache.contactData[gameId]?.byPlayerId?.[String(batterId)];
          const priorABResults = contactEntry?.priorABResults ?? [];
          stats.push({
            gameId,
            gamePk,
            playerId: String(batterId),
            playerName: entry.person?.fullName ?? "",
            teamAbbr,
            teamSide: side,
            battingOrderSlot: slot,
            ab: batting.atBats ?? 0,
            h: batting.hits ?? 0,
            tb: batting.totalBases ?? 0,
            r: batting.runs ?? 0,
            rbi: batting.rbi ?? 0,
            bb: batting.baseOnBalls ?? 0,
            k: batting.strikeOuts ?? 0,
            sb: batting.stolenBases ?? 0,
            abResults: priorABResults.length > 0 ? JSON.stringify(priorABResults) : null,
            gameDate,
          });
        }
      }
      await storage.persistGamePlayerStats(stats);
      console.log(`[MLB snapshot] Persisted ${stats.length} players for game ${gameId}`);
    } catch (err: any) {
      console.error(`[MLB snapshot] Failed for game ${gameId}:`, err.message);
    }
  }

  private async preHydrateNewGame(game: import("./gameDiscoveryService").MLBGame): Promise<void> {
    const { gameId, gamePk } = game;
    if (!gamePk) return;
    console.log(`[MLB_PREHYDRATE] Starting pre-hydration for game ${gameId} (gamePk=${gamePk})`);

    const phase1: Promise<void>[] = [];

    phase1.push(
      syncGameState(gamePk, gameId).then(async () => {
        const state = mlbGameCache.gameState[gameId];
        if (!state) return;

        if (state.pitcherInGame?.playerId) {
          await syncPitcherSeasonStats(state.pitcherInGame.playerId);
          const stats = mlbPlayerCache.pitcherSeasonStats[state.pitcherInGame.playerId];
          console.log(`[MLB_PREHYDRATE] Pitcher ${state.pitcherInGame.playerName}: ERA=${stats?.era ?? "?"} WHIP=${stats?.whip ?? "?"}`);
        }
      })
    );

    phase1.push(
      syncWeather(gamePk, gameId).then(async () => {
        const weather = mlbGameCache.weather[gameId];
        if (weather?.venueName) {
          await syncOpenMeteoWeather(gameId, weather.venueName);
        }
      })
    );

    await Promise.allSettled(phase1);
    console.log(`[MLB_PREHYDRATE] Completed pre-hydration for game ${gameId}`);
  }

  async pollGame(gameId: string): Promise<void> {
    if (this.pollInFlight.has(gameId)) return;
    this.pollInFlight.add(gameId);
    try {
      await this._pollGameInner(gameId);
    } finally {
      this.pollInFlight.delete(gameId);
    }
  }

  private async _pollGameInner(gameId: string): Promise<void> {
    const prevState = this.previousStates.get(gameId);

    const registeredGame = getGame(gameId);
    const statsPk: string | undefined = registeredGame?.gamePk;

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
      let bvpCount = 0;
      let rollingCount = 0;
      let batterCount = 0;

      if (stateAfterSync.pitcherInGame?.playerId) {
        playerSyncPromises.push(
          syncPitcherSeasonStats(stateAfterSync.pitcherInGame.playerId).then(() => {
            const stats = mlbPlayerCache.pitcherSeasonStats[stateAfterSync.pitcherInGame!.playerId];
            if (stats) {
              console.log(`[MLB_PITCHER_HYDRATE] game=${gameId} pitcher=${stateAfterSync.pitcherInGame!.playerName ?? stateAfterSync.pitcherInGame!.playerId} ERA=${stats.era ?? "?"} WHIP=${stats.whip ?? "?"} K9=${stats.kPer9 ?? "?"}`);
            }
          })
        );
      }

      for (const batter of stateAfterSync.battingOrder) {
        if (batter.playerId && batter.playerId !== "unknown") {
          batterCount++;
          playerSyncPromises.push(
            syncBatterRollingStats(batter.playerId).then(() => {
              if (mlbPlayerCache.batterRollingStats[batter.playerId]) rollingCount++;
            })
          );
          if (stateAfterSync.pitcherInGame?.playerId) {
            const bvpKey = `${batter.playerId}_vs_${stateAfterSync.pitcherInGame.playerId}`;
            playerSyncPromises.push(
              syncBvPMatchup(batter.playerId, stateAfterSync.pitcherInGame.playerId).then(() => {
                if (mlbPlayerCache.bvpMatchups[bvpKey]) bvpCount++;
              })
            );
          }
        }
      }

      playerSyncPromises.push(syncSavantSeasonForLineup(gameId));

      await Promise.allSettled(playerSyncPromises);
      if (batterCount > 0) {
        console.log(`[MLB_BVP_HYDRATE] game=${gameId} batters=${batterCount} withBvP=${bvpCount} withRolling=${rollingCount}`);
      }
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

    if (normalizedStatus === "final") {
      const boxScore = mlbGameCache.gameBoxScore?.[gameId];
      if (boxScore?.byPlayerId) {
        for (const [pid, bsp] of Object.entries(boxScore.byPlayerId)) {
          const hrCount = (bsp as any).hr ?? 0;
          const outcome = hrCount > 0 ? "HR" : "NO_HR";
          storage.gradeAlertsForPlayer(pid, gameId, outcome).catch(() => {});
        }
      }
    }

    if (prevState) {
      const triggers = this.detectStateChange(prevState, newState);
      if (triggers.length > 0) {
        console.log(`[MLB orchestrator] State change for game ${gameId} (status=${normalizedStatus}, source=${statusSource}): ${triggers.join(", ")}`);

        if (triggers.includes("inning_change")) {
          await syncBullpenUsage(statsPk, gameId);
        }

        await this.triggerEngine(gameId, normalizedStatus, triggers);
      }
    } else if (normalizedStatus === "live") {
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

    if (oldState.inning !== newState.inning || oldState.isTopInning !== newState.isTopInning) {
      triggers.push("inning_change");
    }

    if (oldState.currentBatter?.playerId !== newState.currentBatter?.playerId) {
      triggers.push("new_ab");
    }

    if (oldState.pitcherInGame?.playerId !== newState.pitcherInGame?.playerId) {
      triggers.push("pitcher_change");
    }

    const oldRunners = JSON.stringify((oldState.runnersOnBase ?? []).sort());
    const newRunners = JSON.stringify((newState.runnersOnBase ?? []).sort());
    if (oldRunners !== newRunners) {
      triggers.push("runner_change");
    }

    if (newState.pitchCount > oldState.pitchCount) {
      triggers.push("ball_in_play");
    }

    if (newState.outs !== oldState.outs) {
      triggers.push("out_recorded");
    }

    const oldTotal = oldState.totalPlays ?? 0;
    const newTotal = newState.totalPlays ?? 0;
    if (newTotal > oldTotal) {
      triggers.push("ab_completed");
    }

    const oldHomeScore = oldState.homeScore ?? 0;
    const oldAwayScore = oldState.awayScore ?? 0;
    const newHomeScore = newState.homeScore ?? 0;
    const newAwayScore = newState.awayScore ?? 0;
    if (newHomeScore !== oldHomeScore || newAwayScore !== oldAwayScore) {
      triggers.push("score_change");
    }

    const pitchCountThresholds = [50, 65, 75, 85, 95, 105];
    for (const threshold of pitchCountThresholds) {
      if (oldState.pitchCount < threshold && newState.pitchCount >= threshold) {
        triggers.push("pitch_count_threshold");
        break;
      }
    }

    const oldTTO = (oldState as any).timesThrough ?? 1;
    const newTTO = (newState as any).timesThrough ?? 1;
    if (newTTO > oldTTO) {
      triggers.push("tto_shift");
    }

    const oldBatterCount = (oldState as any).battingOrder?.length ?? 0;
    const newBatterCount = (newState as any).battingOrder?.length ?? 0;
    if (newBatterCount !== oldBatterCount && oldBatterCount > 0) {
      triggers.push("lineup_substitution");
    }

    return triggers;
  }

  private computeImpactedMarkets(triggers: StateChangeTrigger[]): Set<MLBMarket> {
    const impacted = new Set<MLBMarket>();
    for (const t of triggers) {
      const markets = TRIGGER_IMPACTED_MARKETS[t];
      if (markets === "all") {
        return new Set(ALL_MLB_MARKETS);
      }
      for (const m of markets) impacted.add(m);
    }
    return impacted;
  }

  private getDedupWindow(triggers: StateChangeTrigger[]): number {
    const hasHighImpact = triggers.some(t => HIGH_IMPACT_TRIGGERS.has(t));
    return hasHighImpact ? 5_000 : DEDUP_WINDOW_MS;
  }

  private static readonly JARGON_MAP: Record<string, string> = {
    "1xTTO": "First look at lineup",
    "tto_1": "First look at lineup",
    "2xTTO": "Second time through order",
    "tto_2": "Second time through order",
    "3xTTO": "Third time through — elevated risk",
    "tto_3": "Third time through — elevated risk",
    "NO_EDGE": "No actionable signal",
  };

  private static readonly JARGON_REMOVE = new Set(["EXPERIMENTAL", "SUPPRESSED"]);

  private sanitizeUserFacingFields(signal: MLBQualifiedSignal): void {
    const clean = (arr: string[]): string[] =>
      arr
        .filter(s => !LiveGameOrchestrator.JARGON_REMOVE.has(s))
        .map(s => LiveGameOrchestrator.JARGON_MAP[s] ?? s);

    signal.reasons = clean(signal.reasons);
    signal.badges = clean(signal.badges);
    signal.signalTags = clean(signal.signalTags);
    signal.feedTags = clean(signal.feedTags);
    signal.riskFlags = clean(signal.riskFlags);
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

    if (((output.market as string) === "hr" || output.market === "home_runs") && output.recommendedSide === "UNDER") {
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
    const pitcherSigs = derivePitcherSignals(input, output);
    const opportunityScore = computeFullOpportunityScore(input, input.inning);
    const liveScore = computeLiveOpportunityScore(scoreBreakdown.total, output.edge, opportunityScore);

    let adjustedProjection = output.projection;
    const isPitcherMarket = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"].includes(output.market);
    if (isPitcherMarket && pitcherSigs.length > 0) {
      let sigBoost = 0;
      for (const ps of pitcherSigs) {
        if (ps === "DOMINANT") sigBoost += 0.08;
        else if (ps === "K_STREAK") sigBoost += 0.06;
        else if (ps === "COMMAND_LOCKED") sigBoost += 0.04;
        else if (ps === "FATIGUE_RISK") sigBoost -= 0.05;
        else if (ps === "VELOCITY_DROP") sigBoost -= 0.04;
        else if (ps === "HARD_CONTACT") sigBoost -= 0.06;
      }
      adjustedProjection = output.projection + output.projection * sigBoost;
      if (sigBoost !== 0) {
        console.log(`[SIGNAL_PROJ_LINK] ${output.playerName}/${output.market} projection ${output.projection.toFixed(2)}→${adjustedProjection.toFixed(2)} sigBoost=${(sigBoost * 100).toFixed(1)}% signals=[${pitcherSigs.join(",")}]`);
      }
    }

    console.log(`[LIVE_OPPORTUNITY] player=${output.playerName} market=${output.market} signalScore=${scoreBreakdown.total} edge=${output.edge.toFixed(1)} opportunityScore=${opportunityScore} liveScore=${(liveScore * 100).toFixed(2)} eventBoost=${scoreBreakdown.eventBoost}`);

    const stateFields = this.computeSignalState(gameId, input, output, scoreBreakdown);

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
      projection: adjustedProjection,
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
      badges: output.computedBadges ?? [],
      riskFlags: output.computedRiskFlags ?? [],
      drivers: {
        edge: output.edge,
        probability: output.calibratedProbability,
        projection: adjustedProjection,
        formScore: output.formScore,
        contextScore: output.contextScore,
        ...(output.featureScores ?? {}),
      },
      timestamps: {
        engineGeneratedAt: new Date(output.engineGeneratedAt).toISOString(),
        oddsUpdatedAt: new Date(output.oddsUpdatedAt).toISOString(),
        gameStateUpdatedAt: new Date(output.projectionUpdatedAt).toISOString(),
      },
      ...stateFields,
    };

    signal.pitcherAnalysis = output.pitcherAnalysis ?? null;
    signal.pitcherSignals = pitcherSigs.length > 0 ? pitcherSigs : (output.pitcherSignals ?? null);
    signal.opportunityScore = opportunityScore;
    signal.liveScore = Math.round(liveScore * 10000) / 10000;
    signal.eventBoost = scoreBreakdown.eventBoost;

    if (signal.fallbackUsed) {
      signal.confidenceTier = "WATCHLIST" as any;
      signal.watchlist = true;
      signal.actionable = false;
    }

    (signal as any).isDegraded = !!(input as any).isDegraded;

    this.sanitizeUserFacingFields(signal);

    if (signal.fallbackUsed) {
      console.log(`[MLB_FALLBACK_USED] player=${output.playerName} market=${output.market} defaultRate=fallback`);
    }

    if (process.env.DEBUG_PIPELINE === "true") {
      console.log(`[MLB_SIGNAL_BUILT] gameId=${gameId} player=${output.playerName} market=${output.market} prob=${output.calibratedProbability?.toFixed(1)} edge=${output.edge?.toFixed(1)} actionable=${signal.actionable} fallback=${signal.fallbackUsed}`);
    }

    return signal;
  }

  private computeSignalState(
    gameId: string,
    input: MLBPropInput,
    output: MLBPropOutput,
    scoreBreakdown: { total: number; confidenceTier: string }
  ) {
    const gameState = mlbGameCache.gameState[gameId];
    const boxScore = mlbGameCache.gameBoxScore?.[gameId];
    const boxPlayer = boxScore?.byPlayerId?.[input.playerId];

    const currentStat = input.currentStatValue ?? 0;
    const line = output.bookLine;
    const alreadyHit = currentStat >= line && line > 0;

    const isFallback = output.fallbackUsed === true;
    const isStale = output.engineGeneratedAt > 0 && (Date.now() - output.engineGeneratedAt) > 120_000;
    const isWatchlist = scoreBreakdown.confidenceTier === "WATCHLIST" || scoreBreakdown.total < 55 || isFallback;
    const isActionable = !alreadyHit && !isStale && !isWatchlist && !isFallback
      && output.edge > 0 && (output.overOdds !== null || output.underOdds !== null);

    const pitcher = gameState?.pitcherInGame;
    const pitcherCtxCache = mlbGameCache.pitcherContext?.[gameId];
    const pitcherCtx = pitcher?.playerId ? pitcherCtxCache?.byPitcherId?.[pitcher.playerId] : undefined;

    const contactCache = mlbGameCache.contactData?.[gameId];
    const playerContactData = contactCache?.byPlayerId?.[input.playerId];
    const priorABResults = (playerContactData?.priorABResults ?? []).map((ab: any) => ({
      outcome: ab.outcome ?? "unknown",
      exitVelocity: ab.exitVelocity ?? null,
      launchAngle: ab.launchAngle ?? null,
      pitchType: ab.pitchType ?? null,
      pitchSpeed: ab.pitchSpeed ?? null,
    }));

    const oddsAge = output.oddsUpdatedAt ? Date.now() - output.oddsUpdatedAt : 0;
    const oddsStale = oddsAge > 900_000;
    if (oddsStale) {
      console.log(`[MLB_ODDS_STALE] player=${input.playerName} market=${input.market} ageMs=${oddsAge}`);
    }

    return {
      fallbackUsed: isFallback,
      actionable: isActionable && !oddsStale,
      alreadyHit,
      stale: isStale || oddsStale,
      watchlist: isWatchlist,
      overOdds: output.overOdds ?? null,
      underOdds: output.underOdds ?? null,
      oddsTimestamp: output.oddsUpdatedAt ?? null,
      pitcherName: pitcher?.playerName ?? null,
      pitcherHand: pitcher?.throws ?? null,
      pitcherPitchCount: pitcherCtx?.pitchCount ?? gameState?.pitchCount ?? null,
      pitcherTimesThrough: pitcherCtx?.timesThroughOrder ?? null,
      homeScore: gameState?.homeScore ?? 0,
      awayScore: gameState?.awayScore ?? 0,
      inning: gameState?.inning ?? input.inning,
      isTopInning: gameState?.isTopInning ?? input.isTopInning,
      currentStat,
      completedAB: input.completedAB,
      bookImplied: output.bookImplied ?? null,
      priorABResults,
    };
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

    if (((output.market as string) === "hr" || output.market === "home_runs") && effectiveSide === "UNDER") {
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
    const watchPitcherSigsForProj = derivePitcherSignals(input, output);
    const stateFields = this.computeSignalState(gameId, input, output, scoreBreakdown);

    let watchAdjProjection = output.projection;
    const isWatchPitcherMarket = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"].includes(output.market);
    if (isWatchPitcherMarket && watchPitcherSigsForProj.length > 0) {
      let sigBoost = 0;
      for (const ps of watchPitcherSigsForProj) {
        if (ps === "DOMINANT") sigBoost += 0.08;
        else if (ps === "K_STREAK") sigBoost += 0.06;
        else if (ps === "COMMAND_LOCKED") sigBoost += 0.04;
        else if (ps === "FATIGUE_RISK") sigBoost -= 0.05;
        else if (ps === "VELOCITY_DROP") sigBoost -= 0.04;
        else if (ps === "HARD_CONTACT") sigBoost -= 0.06;
      }
      watchAdjProjection = output.projection + output.projection * sigBoost;
    }

    const watchSignal: MLBQualifiedSignal = {
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
      projection: watchAdjProjection,
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
      badges: output.computedBadges ?? [],
      riskFlags: output.computedRiskFlags ?? [],
      drivers: {
        edge: output.edge,
        probability: output.calibratedProbability,
        projection: watchAdjProjection,
        formScore: output.formScore,
        contextScore: output.contextScore,
        ...(output.featureScores ?? {}),
      },
      timestamps: {
        engineGeneratedAt: new Date(output.engineGeneratedAt).toISOString(),
        oddsUpdatedAt: new Date(output.oddsUpdatedAt).toISOString(),
        gameStateUpdatedAt: new Date(output.projectionUpdatedAt).toISOString(),
      },
      ...stateFields,
      watchlist: true,
      actionable: false,
    };

    watchSignal.pitcherAnalysis = output.pitcherAnalysis ?? null;
    watchSignal.pitcherSignals = watchPitcherSigsForProj.length > 0 ? watchPitcherSigsForProj : (output.pitcherSignals ?? null);
    const watchOppScore = computeFullOpportunityScore(input, input.inning);
    const watchLiveScore = computeLiveOpportunityScore(scoreBreakdown.total, output.edge, watchOppScore);
    watchSignal.opportunityScore = watchOppScore;
    watchSignal.liveScore = Math.round(watchLiveScore * 10000) / 10000;
    watchSignal.eventBoost = scoreBreakdown.eventBoost;

    this.sanitizeUserFacingFields(watchSignal);
    return watchSignal;
  }

  async triggerEngine(gameId: string, normalizedStatus: "live" | "pregame" | "final" | "unknown", triggers?: StateChangeTrigger[]): Promise<MLBPropOutput[]> {
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

    if (normalizedStatus !== "live") {
      console.log(`[MLB orchestrator] triggerEngine skipped for game ${gameId}: normalizedStatus=${normalizedStatus ?? "undefined"} (must be "live")`);
      return outputs;
    }

    const effectiveDedup = triggers ? this.getDedupWindow(triggers) : DEDUP_WINDOW_MS;
    const last = LAST_RUN.get(gameId);
    if (last !== undefined && Date.now() - last < effectiveDedup) {
      console.log(`[MLB orchestrator] triggerEngine dedup-skipped for game ${gameId} (ran within ${effectiveDedup}ms)`);
      return outputs;
    }
    LAST_RUN.set(gameId, Date.now());

    const impactedMarkets = triggers ? this.computeImpactedMarkets(triggers) : new Set(ALL_MLB_MARKETS);
    if (triggers) {
      console.log(`[MLB orchestrator] Event-driven recalc for game ${gameId}: triggers=[${triggers.join(",")}] impactedMarkets=[${Array.from(impactedMarkets).join(",")}]`);
    }

    if (!state) {
      console.warn(`[MLB orchestrator] triggerEngine: no game state cached for ${gameId}`);
      return outputs;
    }

    const contactCache = mlbGameCache.contactData[gameId];
    const pitcherCtxCache = mlbGameCache.pitcherContext[gameId];
    const weatherCache = mlbGameCache.weather[gameId];
    const bullpenCache = mlbGameCache.bullpen[gameId];

    if (weatherCache?.venueName) {
      const _pf = getMarketParkFactor(weatherCache.venueName);
      const _hrF = getMarketParkFactor(weatherCache.venueName, "home_runs");
      const _hitsF = getMarketParkFactor(weatherCache.venueName, "hits");
      console.log(`[MLB_PARK] game=${gameId} venue="${weatherCache.venueName}" overall=${_pf} hr=${_hrF} hits=${_hitsF}`);
    }

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

    const batterArchetypeCache = new Map<string, MLBBatterArchetype>();
    let pitcherArch: MLBPitcherArchetype | null = null;

    {
      const activePitcherForArch = state.pitcherInGame;
      if (activePitcherForArch?.playerId) {
        const pStats = mlbPlayerCache.pitcherSeasonStats[activePitcherForArch.playerId];
        if (pStats) {
          const gs = pStats.gamesStarted ?? null;
          const ip = pStats.inningsPitched ?? null;
          pitcherArch = classifyPitcherArchetype({
            era: pStats.era ?? null,
            whip: pStats.whip ?? null,
            kPer9: pStats.kPer9 ?? null,
            inningsPitched: ip,
            gamesStarted: gs,
            avgInningsPerStart: gs != null && gs > 0 && ip != null ? ip / gs : null,
          });
          console.log(`[MLB_ARCHETYPE] pitcher=${activePitcherForArch.playerName} archetype=${pitcherArch} ERA=${pStats.era ?? "?"}`);
        }
      }
    }

    for (const batter of state.battingOrder) {
      if (!batter.playerId || batter.playerId === "unknown") continue;
      const rollingStatsForArch = mlbPlayerCache.batterRollingStats[batter.playerId];
      const contactForArch = contactCache?.byPlayerId?.[batter.playerId];
      const bArch = classifyBatterArchetype({
        xBA: contactForArch?.xBA ?? null,
        barrelRate: contactForArch?.barrelPct != null ? contactForArch.barrelPct / 100 : null,
        exitVelocity: contactForArch?.exitVelocity ?? null,
        battingOrderSlot: batter.slot ?? 5,
        seasonPA: rollingStatsForArch?.last30?.games != null ? rollingStatsForArch.last30.games * 4 : 200,
        seasonOPS: rollingStatsForArch?.seasonOps ?? null,
        last7OPS: rollingStatsForArch?.last7?.ops ?? null,
        last15OPS: rollingStatsForArch?.last15?.ops ?? null,
        platoonGap: null,
        isStarting: true,
      });
      batterArchetypeCache.set(batter.playerId, bArch);
    }

    // ── Batter markets: evaluate each hitter in the starting lineup ────────────
    for (const market of BATTER_MARKETS) {
      if (!impactedMarkets.has(market)) continue;
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

        const resolvedMarketObj = { line: resolvedLine.line, odds: (resolvedLine.overOdds !== null || resolvedLine.underOdds !== null) ? { overOdds: resolvedLine.overOdds, underOdds: resolvedLine.underOdds } : null };
        const isDefaultFallbackLine = resolvedLine.source === "default";
        if (!isDefaultFallbackLine && !hasRealOdds(resolvedMarketObj)) {
          console.warn(`[MLB orchestrator] hasRealOdds failed for ${batter.playerName}/${market} — signalLocked=false, skipping computation`);
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "no_real_odds", line: ${resolvedLine.line} }`);
          continue;
        }

        const boxScorePlayer = mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId];
        const playerAB = boxScorePlayer?.ab ?? 0;
        if (playerAB < 1) {
          continue;
        }

        const rollingStats = mlbPlayerCache.batterRollingStats[batter.playerId];
        const pitcherSeasonStats = pitcher ? mlbPlayerCache.pitcherSeasonStats[pitcher.playerId] : undefined;
        const bvpKey = pitcher ? `${batter.playerId}_vs_${pitcher.playerId}` : null;
        const bvpData = bvpKey ? mlbPlayerCache.bvpMatchups[bvpKey] : undefined;

        const batterSeasonAvg = rollingStats?.seasonAvg ?? 0.250;
        const rollingAvg = rollingStats?.last15?.avg;
        const effectiveSeasonAvg = rollingAvg != null ? rollingAvg : batterSeasonAvg;
        let currentStatForMarket = 0;
        if (boxScorePlayer) {
          switch (market) {
            case "hits": currentStatForMarket = boxScorePlayer.hits; break;
            case "home_runs": currentStatForMarket = boxScorePlayer.hr; break;
            case "hrr": currentStatForMarket = (boxScorePlayer.hr ?? 0) + ((boxScorePlayer as any).r ?? 0) + ((boxScorePlayer as any).rbi ?? 0); break;
            case "total_bases": currentStatForMarket = boxScorePlayer.tb; break;
            case "batter_strikeouts": currentStatForMarket = (boxScorePlayer as any).strikeouts ?? 0; break;
            case "pitcher_strikeouts": case "hits_allowed": case "walks_allowed": case "hr_allowed": currentStatForMarket = 0; break;
            default: currentStatForMarket = boxScorePlayer.hits; break;
          }
        }

        const currentGameHR = boxScorePlayer ? boxScorePlayer.hr : 0;
        if (market === "home_runs" && currentGameHR > 0) {
          checkAndGradeHR(batter.playerId, gameId, currentGameHR);
        }
        const hardHitCount = playerContact
          ? (playerContact.priorABResults ?? []).filter((ab: any) => (ab.exitVelocity ?? 0) >= 95).length
          : 0;

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
          completedAB: boxScorePlayer ? boxScorePlayer.ab : Math.max(0, 4 - remainingAB),
          inning: state.inning,
          isTopInning: state.isTopInning,
          currentGameHR,
          hardHitCount,
          batterHand: null,
          contactQuality: {
            exitVelocity: playerContact?.exitVelocity ?? null,
            launchAngle: playerContact?.launchAngle ?? null,
            hitDistance: playerContact?.hitDistance ?? null,
            hardHitRateSeason: playerContact?.hardHitPct != null ? playerContact.hardHitPct / 100 : null,
            barrelRateProxySeason: playerContact?.barrelPct != null ? playerContact.barrelPct / 100 : null,
            avgBatSpeed: playerContact?.avgBatSpeed ?? null,
            avgSwingLength: playerContact?.avgSwingLength ?? null,
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
          ...(market === "hrr" && boxScorePlayer ? {
            hrrComponents: {
              currentHits: boxScorePlayer.hits ?? 0,
              currentRuns: (boxScorePlayer as any).r ?? 0,
              currentRBIs: (boxScorePlayer as any).rbi ?? 0,
              hitsRate: effectiveSeasonAvg,
              runsRate: 0.10,
              rbisRate: 0.12,
            },
          } : {}),
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
            parkFactor: getMarketParkFactor(weatherCache?.venueName, market),
            temperature: weatherCache?.temperature ?? null,
            windSpeed: weatherCache?.windSpeed ?? null,
            windDirection: weatherCache?.windDirection ?? null,
            humidity: weatherCache?.humidity ?? null,
            isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
            parkHistoryFactor: null,
          },
          bullpen: {
            bullpenEra: bullpenCache?.bullpenEra ?? null,
            bullpenUsageLastThreeDays: bullpenCache?.bullpenUsageLastThreeDays ?? null,
            isTopRelieverAvailable: bullpenCache?.isTopRelieverAvailable ?? true,
          },
        };

        pLog(gameId, "engineInput", { player: input.playerName, market: input.market, bookLine: input.bookLine, inning: input.inning, parkFactor: input.weatherPark.parkFactor, venue: weatherCache?.venueName });

        const qualityLayers = {
          parkFactor: weatherCache?.venueName != null,
          weather: weatherCache?.temperature != null,
          pitcherERA: input.pitcher.era != null,
          pitcherWHIP: input.pitcher.whip != null,
          contactEV: input.contactQuality.exitVelocity != null,
          xBA: input.contactQuality.xBA != null,
          xSLG: input.contactQuality.xSLG != null,
          bvp: !!(input as any).bvpHistory,
          rollingForm: !!(input as any).rollingForm,
          bullpen: bullpenCache?.bullpenEra != null,
        };
        const realCount = Object.values(qualityLayers).filter(Boolean).length;
        const isDegraded = realCount <= 5;
        if (isDegraded) {
          console.warn(`[MLB_INPUT_QUALITY] DEGRADED game=${gameId} player=${input.playerName} market=${market} real=${realCount}/10 layers=${JSON.stringify(qualityLayers)}`);
        }
        (input as any).isDegraded = isDegraded;

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

          const bArch = batterArchetypeCache.get(batter.playerId) ?? "stable_regular";

          const ceilResult = applySafetyCeiling(
            output.calibratedProbability,
            bArch,
            market
          );
          if (ceilResult.ceilingApplied) {
            output.calibratedProbability = ceilResult.probability;
            if (output.recommendedSide === "OVER") {
              output.calibratedProbabilityOver = Math.min(output.calibratedProbabilityOver, ceilResult.ceiling);
              output.calibratedProbabilityUnder = Math.round((100 - output.calibratedProbabilityOver) * 100) / 100;
            } else {
              output.calibratedProbabilityUnder = Math.min(output.calibratedProbabilityUnder, ceilResult.ceiling);
              output.calibratedProbabilityOver = Math.round((100 - output.calibratedProbabilityUnder) * 100) / 100;
            }
            console.log(`[MLB_CEILING] player=${batter.playerName} market=${market} archetype=${bArch} capped=${ceilResult.ceiling}`);
          }

          if (output.recommendedSide === "OVER" || output.recommendedSide === "UNDER") {
            trackSignalDirection(market, output.recommendedSide);
          }

          const bvpAvg = bvpData?.avg ?? null;
          const thesis = generateThesis(
            bArch,
            pitcherArch,
            market,
            output.recommendedSide === "OVER" || output.recommendedSide === "UNDER" ? output.recommendedSide : "OVER",
            [],
            input.weatherPark.parkFactor,
            bvpAvg,
            output.formIndicator ?? null,
            input.pitcher.pitchCount,
            input.pitcher.timesThrough,
            input.weatherPark.windDirection ?? null
          );

          pLog(gameId, "engineOutput", { player: output.playerName, market: output.market, edge: output.edge, tier: output.confidenceTier, suppressed: output.suppressed, archetype: bArch });
          recordMLBDiagnostic(output);

          console.log(`[MLB engine] playerId=${batter.playerId} player="${batter.playerName}" market=${market} slot=${batter.slot} inning=${state.inning} remainingPA=${remainingPA} calibratedProbOver=${output.calibratedProbabilityOver.toFixed(2)} calibratedProbUnder=${output.calibratedProbabilityUnder.toFixed(2)} edge=${output.edge.toFixed(2)} side=${output.recommendedSide} arch=${bArch}`);

          outputs.push({ ...output });

          const batterStats = boxScorePlayer ? {
            ab: boxScorePlayer.ab, h: boxScorePlayer.hits, hr: boxScorePlayer.hr,
            tb: boxScorePlayer.tb, bb: boxScorePlayer.bb, rbi: boxScorePlayer.rbi,
            k: boxScorePlayer.so, sb: 0,
          } : null;

          const lastAB = playerContact?.priorABResults?.length
            ? playerContact.priorABResults[playerContact.priorABResults.length - 1]
            : null;
          const lastABContact = lastAB || playerContact ? {
            exitVelo: lastAB?.exitVelocity ?? playerContact?.exitVelocity ?? null,
            launchAngle: lastAB?.launchAngle ?? playerContact?.launchAngle ?? null,
            batSpeed: null,
            distance: lastAB?.distance ?? playerContact?.hitDistance ?? null,
            barrelPct: playerContact?.barrelPct ?? null,
            hardHitPct: playerContact?.hardHitPct ?? null,
            outcome: lastAB?.outcome ?? null,
          } : null;

          const qResult = this.qualifySignal(gameId, input, output);
          if (qResult) {
            qResult.currentStats = batterStats;
            qResult.lastABContact = lastABContact;
            qResult.batterArchetype = bArch;
            qResult.pitcherArchetype = pitcherArch;
            qResult.thesis = thesis;
            qResult.safetyCeilingApplied = ceilResult.ceilingApplied;
            qResult.varianceTier = MARKET_VOLATILITY[market] ?? "mid";
            qResult.isDegraded = !!(input as any).isDegraded;
            qResult.dataQuality = !!(input as any).isDegraded ? "degraded" : (Object.values({
              parkFactor: weatherCache?.venueName != null,
              weather: weatherCache?.temperature != null,
              pitcherERA: input.pitcher.era != null,
              xBA: input.contactQuality.xBA != null,
              bvp: !!bvpData,
            }).filter(Boolean).length >= 4 ? "full" : "partial");
            qualifiedSignals.push(qResult);
            allSignals.push(qResult);
            signalsQualified++;
            scoreSum += qResult.signalScore;
          } else {
            signalsRejected++;
            const watchSig = this.buildWatchSignal(gameId, input, output);
            if (watchSig) {
              watchSig.currentStats = batterStats;
              watchSig.lastABContact = lastABContact;
              watchSig.batterArchetype = bArch;
              watchSig.pitcherArchetype = pitcherArch;
              watchSig.thesis = thesis;
              watchSig.isDegraded = !!(input as any).isDegraded;
              allSignals.push(watchSig);
            }
          }

          if (market === "home_runs" && output.hrBuildScore != null && output.hrBuildScore > 0) {
            const hrFactorsBuild = typeof output.hrFactors === "object" && output.hrFactors?.build
              ? output.hrFactors.build
              : { avgEV: null, maxEV: null, avgLA: null, barrels: 0, hardHits: 0, deepFlyouts: 0, batSpeedScore: 0, pitcherFatigueBoost: 0, parkWindBoost: 0, platoonBoost: 0 };
            const alertInput: HRAlertInput = {
              playerId: batter.playerId,
              playerName: batter.playerName,
              teamAbbr: batter.team,
              gameId,
              hrBuildScore: output.hrBuildScore,
              hrIntensity: output.hrIntensity ?? "weak",
              factors: hrFactorsBuild as any,
              inning: state.inning,
              priorABResults: (playerContact?.priorABResults ?? []).map((ab: any) => ({
                exitVelocity: ab.exitVelocity ?? null,
                launchAngle: ab.launchAngle ?? null,
                distance: ab.distance ?? null,
                outcome: ab.outcome ?? "out",
              })),
            };
            const alertResult = evaluateHRAlert(alertInput);
            if (alertResult.level === "ALERT" || alertResult.level === "WATCH") {
              console.log(`[HR_ALERT_TRIGGER] ${alertResult.level} ${batter.playerName} score=${output.hrBuildScore} reason=${alertResult.triggerReason} game=${gameId} inn=${state.inning}`);
              markAlertSent(batter.playerId, gameId);
              storage.insertAlert({
                playerId: batter.playerId,
                playerName: batter.playerName,
                teamAbbr: batter.team,
                gameId,
                alertType: alertResult.level === "ALERT" ? "HR_EARLY" : "HR_WATCH",
                triggerReason: alertResult.triggerReason,
                hrBuildScore: output.hrBuildScore,
                hrIntensity: output.hrIntensity ?? "weak",
                inning: state.inning,
                factors: JSON.stringify(hrFactorsBuild),
              }).catch(err => console.warn(`[HR_ALERT] persist failed: ${err.message}`));
            }
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
        if (!impactedMarkets.has(market)) continue;
        const currentPitchCount = pitcherCtx?.pitchCount ?? state.pitchCount ?? 0;
        if (currentPitchCount < 10) {
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", reason: "pitcher_too_early" }`);
          continue;
        }
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

        const resolvedPitcherMarketObj = { line: resolvedPitcherLine.line, odds: (resolvedPitcherLine.overOdds !== null || resolvedPitcherLine.underOdds !== null) ? { overOdds: resolvedPitcherLine.overOdds, underOdds: resolvedPitcherLine.underOdds } : null };
        const isPitcherDefaultLine = resolvedPitcherLine.source === "default";
        if (!isPitcherDefaultLine && !hasRealOdds(resolvedPitcherMarketObj)) {
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
          : market === "hr_allowed"
            ? (pitcherSeasonForPitcherMarket?.era != null ? Math.max(0.3, pitcherSeasonForPitcherMarket.era / 9 * 1.1) : 0.8)
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
            avgBatSpeed: null,
            avgSwingLength: null,
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
            parkFactor: getMarketParkFactor(weatherCache?.venueName, market),
            temperature: weatherCache?.temperature ?? null,
            windSpeed: weatherCache?.windSpeed ?? null,
            windDirection: weatherCache?.windDirection ?? null,
            humidity: weatherCache?.humidity ?? null,
            isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
            parkHistoryFactor: null,
          },
          bullpen: {
            bullpenEra: bullpenCache?.bullpenEra ?? null,
            bullpenUsageLastThreeDays: bullpenCache?.bullpenUsageLastThreeDays ?? null,
            isTopRelieverAvailable: bullpenCache?.isTopRelieverAvailable ?? true,
          },
        };

        pLog(gameId, "engineInput:pitcher", { player: input.playerName, market: input.market, bookLine: input.bookLine, parkFactor: input.weatherPark.parkFactor });

        const pitcherQualityLayers = {
          parkFactor: weatherCache?.venueName != null,
          weather: weatherCache?.temperature != null,
          pitcherERA: input.pitcher.era != null,
          pitcherWHIP: input.pitcher.whip != null,
          pitcherK9: input.pitcher.kPer9 != null,
          bullpen: bullpenCache?.bullpenEra != null,
        };
        const pitcherRealCount = Object.values(pitcherQualityLayers).filter(Boolean).length;
        const pitcherIsDegraded = pitcherRealCount <= 3;
        if (pitcherIsDegraded) {
          console.warn(`[MLB_INPUT_QUALITY] DEGRADED:pitcher game=${gameId} player=${input.playerName} market=${market} real=${pitcherRealCount}/6 layers=${JSON.stringify(pitcherQualityLayers)}`);
        }
        (input as any).isDegraded = pitcherIsDegraded;

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

          const pArchForMarket = pitcherArch ?? "mid_rotation";
          const pitcherCeilResult = applySafetyCeiling(
            output.calibratedProbability,
            pArchForMarket,
            market
          );
          if (pitcherCeilResult.ceilingApplied) {
            output.calibratedProbability = pitcherCeilResult.probability;
            if (output.recommendedSide === "OVER") {
              output.calibratedProbabilityOver = Math.min(output.calibratedProbabilityOver, pitcherCeilResult.ceiling);
              output.calibratedProbabilityUnder = Math.round((100 - output.calibratedProbabilityOver) * 100) / 100;
            } else {
              output.calibratedProbabilityUnder = Math.min(output.calibratedProbabilityUnder, pitcherCeilResult.ceiling);
              output.calibratedProbabilityOver = Math.round((100 - output.calibratedProbabilityUnder) * 100) / 100;
            }
            console.log(`[MLB_CEILING] pitcher=${pitcherToEval.playerName} market=${market} archetype=${pArchForMarket} capped=${pitcherCeilResult.ceiling}`);
          }

          if (output.recommendedSide === "OVER" || output.recommendedSide === "UNDER") {
            trackSignalDirection(market, output.recommendedSide);
          }

          pLog(gameId, "engineOutput:pitcher", { player: output.playerName, market: output.market, edge: output.edge, tier: output.confidenceTier, archetype: pArchForMarket });
          recordMLBDiagnostic(output);

          console.log(`[MLB engine] playerId=${pitcherToEval.playerId} player="${pitcherToEval.playerName}" market=${market} inning=${state.inning} remainingPA=${remainingPA} calibratedProbOver=${output.calibratedProbabilityOver.toFixed(2)} calibratedProbUnder=${output.calibratedProbabilityUnder.toFixed(2)} edge=${output.edge.toFixed(2)} side=${output.recommendedSide} arch=${pArchForMarket}`);

          outputs.push({ ...output });
          marketsEvaluated++;

          const qResult = this.qualifySignal(gameId, input, output);
          if (qResult) {
            qResult.pitcherArchetype = pArchForMarket;
            qResult.safetyCeilingApplied = pitcherCeilResult.ceilingApplied;
            qResult.varianceTier = MARKET_VOLATILITY[market] ?? "mid";
            qResult.isDegraded = !!(input as any).isDegraded;
            qResult.dataQuality = !!(input as any).isDegraded ? "degraded" : "partial";
            qualifiedSignals.push(qResult);
            allSignals.push(qResult);
            signalsQualified++;
            scoreSum += qResult.signalScore;
          } else {
            signalsRejected++;
            const watchSig = this.buildWatchSignal(gameId, input, output);
            if (watchSig) {
              watchSig.pitcherArchetype = pArchForMarket;
              watchSig.isDegraded = !!(input as any).isDegraded;
              allSignals.push(watchSig);
            }
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

    const familyEnriched = applyFamilySuppression(allSignals);
    let flagshipCount = 0;
    for (const enriched of familyEnriched) {
      const sig = allSignals.find(s => s.id === enriched.id);
      if (sig) {
        sig.familyId = enriched.familyResult.familyId;
        sig.familyRank = enriched.familyResult.siblingRank;
        sig.isFlagship = enriched.familyResult.isFlagship;
        sig.familyPenaltyFactor = enriched.familyResult.familyPenaltyFactor;
        if (enriched.familyResult.isFlagship) flagshipCount++;
        if (!enriched.familyResult.isFlagship && enriched.familyResult.familyPenaltyFactor < 1) {
          sig.signalScore = Math.round(sig.signalScore * enriched.familyResult.familyPenaltyFactor);
          if (sig.signalScore < 55) {
            sig.confidenceTier = "WATCHLIST";
            sig.watchlist = true;
          }
        }
      }
    }
    console.log(`[MLB_FAMILY_SUPPRESSION][${gameId}] signals=${allSignals.length} flagships=${flagshipCount}`);

    allSignals.sort((a, b) => {
      const aDeg = a.isDegraded ? 1 : 0;
      const bDeg = b.isDegraded ? 1 : 0;
      if (aDeg !== bDeg) return aDeg - bDeg;
      const aFlagship = a.isFlagship ? 0 : 1;
      const bFlagship = b.isFlagship ? 0 : 1;
      if (aFlagship !== bFlagship) return aFlagship - bFlagship;
      return (b.signalScore ?? 0) - (a.signalScore ?? 0);
    });

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
