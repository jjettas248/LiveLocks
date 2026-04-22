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
  type ContactChangeEvent,
  syncPitcherSeasonStats,
  syncBatterRollingStats,
  syncBvPMatchup,
  syncSavantSeasonForLineup,
  syncOpenMeteoWeather,
  resolveCurrentHourWeather,
  mlbGameCache,
  mlbPlayerCache,
  type GameStateCache,
} from "./dataPullService";
import { estimateRemainingPA, estimatePitcherRemainingBF } from "./paEstimator";
import { getMarketParkFactor, isVenueIndoors } from "./dataSources";
import { calculateMLBPropEdge, hasRealOdds, canShowSignal, updateSelfLearningCalibration } from "./markets";
import { refreshFullSelfLearning, getLearnedRateAdjustment, getLearnedContactProfile, getContactQualityScore, getPitchTypeHrRisk, getAllCalibrationData } from "./selfLearning";
import { recordMLBDiagnostic } from "./diagnostics";
import type { MLBPropInput, MLBPropOutput, MLBMarket, MLBQualifiedSignal } from "./types";
import { MARKET_QUALIFY_FLOOR, ALL_MLB_MARKETS } from "./types";
import { runIntegrityFirewall, logFirewallResult } from "./integrityFirewall";
import { computeSignalScore, computeSignalScoreByFamily, scoreHRRadar, deriveSignalTags, deriveFeedTags, deriveGameCardTags, isPlayerGlowEligible, derivePitcherSignals, computeFullOpportunityScore, computeLiveOpportunityScore, getMarketFamily } from "./signalScore";
import type { MarketFamily } from "./signalScore";
import { resolveMLBOddsEventId, getMLBPlayerOdds } from "../oddsService";
import { assignMlbTier, assignAndCheckPoll, markPolled, clearGame as clearScheduler, logTierAssignment, type MlbGameContext } from "../odds/oddsScheduler";
import { clearTier } from "../odds/oddsDiagnostics";
import { readOddsSnapshot, readLastKnownGood } from "../odds/oddsCache";
import { rankBook } from "../odds/oddsConfig";
import {
  classifyBatterArchetype,
  classifyPitcherArchetype,
  generateThesis,
  MARKET_VOLATILITY,
  type MLBBatterArchetype,
  type MLBPitcherArchetype,
} from "./archetypes";
// NOTE: probabilityEngine.applyModelSafetyCeiling is the single authoritative cap layer.
// Orchestrator no longer applies its own ceiling — engine output is trusted.
import { buildLiveEventInterpretation } from "./liveEventInterpretation";
import { applyFamilySuppression } from "./marketFamily";
import { trackSignalDirection } from "./directionalBias";
import { evaluateHRAlert, markAlertSent, clearGameCooldowns, type HRAlertInput } from "./evaluateHRAlert";
import { recomputeHrAlertState, clearGameHrStates, getHrAlertState, mapDynamicStateToStage, type HRAlertSnapshot } from "./hrAlertEngine";
import { todayET } from "../utils/dateUtils";
import { buildHRSignal } from "./HRSignalBuilder";
import { getPlayer } from "./rosterService";
import { storage } from "../storage";
import { trackPlay } from "../services/playTracker";
import { runFullOnlyHomersScrape, getHotHitters, getLiveBallparkFactors, getBatterVsPitcherHrHistory } from "./onlyHomersService";

// ── OnlyHomers data caches (refreshed periodically) ─────────────────────────
let ohHotHitters7d: Map<string, number> = new Map();
let ohHotHitters14d: Map<string, number> = new Map();
let ohHotHitters30d: Map<string, number> = new Map();
let ohBallparkFactors: Map<string, number> = new Map();
let ohLastRefresh = 0;
const OH_REFRESH_MS = 30 * 60_000;

async function refreshSelfLearningCalibration(): Promise<void> {
  try {
    await refreshFullSelfLearning();

    const calData = getAllCalibrationData();
    for (const [market, cal] of Object.entries(calData.marketCalibrations)) {
      updateSelfLearningCalibration(market, cal.actualRate, cal.engineExpectedRate, cal.sampleSize);
    }
  } catch (e: any) {
    console.warn(`[MLB SELF_LEARN] Calibration chain failed: ${e.message}`);
  }
}

async function refreshOnlyHomersCache(): Promise<void> {
  if (Date.now() - ohLastRefresh < OH_REFRESH_MS) return;
  try {
    const [h7, h14, h30, parks] = await Promise.all([
      getHotHitters("7d"),
      getHotHitters("14d"),
      getHotHitters("30d"),
      getLiveBallparkFactors(),
    ]);
    ohHotHitters7d = new Map(h7.map(h => [h.playerName, h.hrCount]));
    ohHotHitters14d = new Map(h14.map(h => [h.playerName, h.hrCount]));
    ohHotHitters30d = new Map(h30.map(h => [h.playerName, h.hrCount]));
    ohBallparkFactors = parks;
    ohLastRefresh = Date.now();
    console.log(`[OnlyHomers] Cache refreshed — 7d=${ohHotHitters7d.size} 14d=${ohHotHitters14d.size} 30d=${ohHotHitters30d.size} parks=${ohBallparkFactors.size}`);
  } catch (e: any) {
    console.warn(`[OnlyHomers] Cache refresh failed: ${e.message}`);
  }
}

export function getOnlyHomersEnrichment(playerName: string): {
  isHotHitter: boolean;
  hotHitterPeriod: string | null;
  hotHitterHrCount: number | null;
} {
  const hr7 = ohHotHitters7d.get(playerName);
  if (hr7 != null && hr7 >= 2) {
    return { isHotHitter: true, hotHitterPeriod: "7d", hotHitterHrCount: hr7 };
  }
  const hr14 = ohHotHitters14d.get(playerName);
  if (hr14 != null && hr14 >= 3) {
    return { isHotHitter: true, hotHitterPeriod: "14d", hotHitterHrCount: hr14 };
  }
  const hr30 = ohHotHitters30d.get(playerName);
  if (hr30 != null && hr30 >= 5) {
    return { isHotHitter: true, hotHitterPeriod: "30d", hotHitterHrCount: hr30 };
  }
  return { isHotHitter: false, hotHitterPeriod: null, hotHitterHrCount: null };
}

export function getOnlyHomersBallparkHrCount(ballpark: string): number | null {
  return ohBallparkFactors.get(ballpark) ?? null;
}

// ── HR alert grading tracker ──────────────────────────────────────────────────
// Tracks the highest atBatIndex of an HR play we've already graded per
// (gameId, playerId). Using the play's atBatIndex (canonical from MLB Stats API)
// instead of a count avoids race conditions where the box-score HR count
// updates before/after the play feed and produces wrong inning attribution.
const KNOWN_HR_COUNTS = new Map<string, number>();          // legacy: used elsewhere as "we've seen this player's HR"
const KNOWN_HR_AB_INDEX = new Map<string, number>();        // gameId_playerId -> highest graded atBatIndex

function gradeSingleHRPlay(
  playerId: string,
  gameId: string,
  playerName: string,
  team: string,
  inning: number,
  halfInning: "top" | "bottom",
  atBatIndex: number,
  endTimeMs: number | null,
  source: "play_feed" | "box_score_fallback",
): void {
  const hitHalf = halfInning === "top" ? "T" : "B";
  const hitLabel = `${hitHalf}${inning}`;
  const ageSec = endTimeMs ? Math.round((Date.now() - endTimeMs) / 1000) : null;
  console.log(
    `[HR_GRADE_DETECTED] playerId=${playerId} player=${playerName} gameId=${gameId} ` +
    `hitLabel=${hitLabel} abIndex=${atBatIndex} source=${source}` +
    (ageSec !== null ? ` ageSec=${ageSec}` : "")
  );
  storage.resolveAlertAsHit(playerId, gameId, inning, halfInning, atBatIndex, endTimeMs).catch(() => {});
  storage.resolveHrRadarAlertAsHit(playerId, gameId, inning, hitHalf, hitLabel, endTimeMs)
    .then((count) => {
      if (count === 0) {
        storage.ensureHrRadarAlertHit({
          gameId,
          playerId,
          playerName,
          team,
          inning,
          half: halfInning,
          hitLabel,
        }).catch(err => console.warn(`[HR_RADAR_ENSURE_HIT] Failed: ${err.message}`));
      }
    }).catch(() => {});
}

/**
 * Centralized HR grading using the MLB Stats API live-feed play data.
 * Razor-sharp inning attribution: pulls inning/halfInning directly from each
 * HR play's `about.inning`/`about.halfInning` rather than the orchestrator's
 * current `state.inning` (which may have rolled over by the time we poll).
 *
 * Runs once per pollGame after syncContactData has populated mlbGameCache.hrPlays.
 */
function gradeHomeRunsFromPlays(gameId: string): void {
  const hrCache = mlbGameCache.hrPlays[gameId];
  if (!hrCache || hrCache.plays.length === 0) return;

  // Group plays by playerId, keep highest atBatIndex per player
  const byPlayer = new Map<string, typeof hrCache.plays>();
  for (const p of hrCache.plays) {
    const arr = byPlayer.get(p.playerId) ?? [];
    arr.push(p);
    byPlayer.set(p.playerId, arr);
  }

  for (const [playerId, plays] of byPlayer) {
    plays.sort((a, b) => a.atBatIndex - b.atBatIndex);
    const trackerKey = `${gameId}_${playerId}`;
    const lastGradedIdx = KNOWN_HR_AB_INDEX.get(trackerKey) ?? -1;

    let cumulativeHR = KNOWN_HR_COUNTS.get(trackerKey) ?? 0;
    for (const play of plays) {
      if (play.atBatIndex <= lastGradedIdx) continue;
      // Prefer completed plays for grading; in-progress plays are noted but not graded yet
      if (!play.isComplete) continue;
      cumulativeHR += 1;
      gradeSingleHRPlay(
        playerId,
        gameId,
        play.playerName,
        play.team,
        play.inning,
        play.halfInning,
        play.atBatIndex,
        play.endTimeMs,
        "play_feed",
      );
      KNOWN_HR_AB_INDEX.set(trackerKey, play.atBatIndex);
    }
    if (cumulativeHR > 0) KNOWN_HR_COUNTS.set(trackerKey, cumulativeHR);
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
  "hrr",
];

const PITCHER_MARKETS: MLBMarket[] = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed"];

// ── Previously-resolved line cache ───────────────────────────────────────────
// Persists the last successfully fetched sportsbook line per event+player+market
// within this server process. Used as the second-priority fallback when the
// odds service is unreachable or has no line posted yet.
// Key: "oddsEventId|playerNameNorm|market" — Value: last known real line
const priorResolvedLines = new Map<string, number>();

// Preferred bookmaker order for deterministic line selection (matches manual flow).
// First match wins; unlisted bookmakers are used only as a last resort.
const PREFERRED_BOOKMAKERS = ["draftkings", "fanduel", "hardrockbet", "betmgm", "betrivers", "espnbet"];

type ResolvedLine = { line: number; overOdds: number | null; underOdds: number | null; isDegraded: boolean; source: "live" | "prior" | "cache" | "lkg" };

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

  // (0) Cache-first: serve from shared odds cache when fresh — avoids API hit.
  //     Try in-play first (more relevant during live games), then pre-game.
  if (oddsEventId) {
    for (const inPlay of [true, false]) {
      const snap = readOddsSnapshot({ sport: "mlb", eventId: oddsEventId, market, player: playerName, isLive: inPlay });
      if (snap && snap.freshness === "fresh") {
        const bookKeys = Object.keys(snap.books);
        const preferred = bookKeys.slice().sort((a, b) => rankBook("mlb", a) - rankBook("mlb", b))[0];
        const entry = snap.books[preferred];
        if (entry && typeof entry.line === "number" && isFinite(entry.line) && entry.line > 0) {
          priorResolvedLines.set(cacheKey, entry.line);
          pLog(oddsEventId, `odds:bookLine:cache:${inPlay ? "inPlay" : "pre"}`, { player: playerName, market, line: entry.line, book: preferred, ageMs: snap.ageMs, freshness: snap.freshness });
          return {
            line: entry.line,
            overOdds: typeof entry.overOdds === "number" && isFinite(entry.overOdds) ? entry.overOdds : null,
            underOdds: typeof entry.underOdds === "number" && isFinite(entry.underOdds) ? entry.underOdds : null,
            isDegraded: false,
            source: "cache",
          };
        }
      }
    }
  }

  // (1) Try odds service — first pre-game, then in-play
  //     Only short-circuit on non-degraded pre-game lines; if pre-game returns
  //     degraded/stale data, continue to try in-play for a fresher quote.
  if (oddsEventId) {
    let bestDegraded: ResolvedLine | null = null;
    for (const inPlay of [false, true]) {
      try {
        const oddsResult = await getMLBPlayerOdds(oddsEventId, playerName, market, inPlay);
        const bookKeys = Object.keys(oddsResult).filter(k => !k.startsWith("_"));
        const isOddsDegraded = !!(oddsResult._isDegraded);
        if (bookKeys.length > 0) {
          const preferred = PREFERRED_BOOKMAKERS.find(b => bookKeys.includes(b)) ?? bookKeys[0];
          const entry = oddsResult[preferred];
          const line = entry.line;
          if (typeof line === "number" && isFinite(line) && line > 0) {
            const resolved: ResolvedLine = {
              line,
              overOdds: typeof entry.overOdds === "number" && isFinite(entry.overOdds) ? entry.overOdds : null,
              underOdds: typeof entry.underOdds === "number" && isFinite(entry.underOdds) ? entry.underOdds : null,
              isDegraded: isOddsDegraded,
              source: isOddsDegraded ? "prior" : "live",
            };
            if (!isOddsDegraded) {
              priorResolvedLines.set(cacheKey, line);
              pLog(oddsEventId, `odds:bookLine:${inPlay ? "inPlay" : "live"}`, { player: playerName, market, line, book: preferred });
              return resolved;
            }
            if (!bestDegraded) bestDegraded = resolved;
          }
        }
      } catch (err: any) {
        console.warn(`[MLB orchestrator] resolveBookLine odds error for ${playerName}/${market} (inPlay=${inPlay}):`, err.message);
      }
    }
    if (bestDegraded) {
      priorResolvedLines.set(cacheKey, bestDegraded.line);
      pLog(oddsEventId, "odds:bookLine:degraded", { player: playerName, market, line: bestDegraded.line });
      return bestDegraded;
    }

    // (1.5) Last-known-good fallback from shared cache — even if stale/expired.
    for (const inPlay of [true, false]) {
      const lkg = readLastKnownGood({ sport: "mlb", eventId: oddsEventId, market, player: playerName, isLive: inPlay });
      if (lkg) {
        const bookKeys = Object.keys(lkg.books);
        const preferred = bookKeys.slice().sort((a, b) => rankBook("mlb", a) - rankBook("mlb", b))[0];
        const entry = lkg.books[preferred];
        if (entry && typeof entry.line === "number" && isFinite(entry.line) && entry.line > 0) {
          priorResolvedLines.set(cacheKey, entry.line);
          pLog(oddsEventId, "odds:bookLine:lkg", { player: playerName, market, line: entry.line, book: preferred, ageMs: lkg.ageMs, freshness: lkg.freshness });
          return {
            line: entry.line,
            overOdds: typeof entry.overOdds === "number" && isFinite(entry.overOdds) ? entry.overOdds : null,
            underOdds: typeof entry.underOdds === "number" && isFinite(entry.underOdds) ? entry.underOdds : null,
            isDegraded: true,
            source: "lkg",
          };
        }
      }
    }
  }

  // (2) Fall back to previously resolved line (real market line from earlier in session — stale)
  const prior = priorResolvedLines.get(cacheKey);
  if (prior !== undefined) {
    console.warn(`[MLB orchestrator] Using prior known line for ${playerName}/${market}: ${prior}`);
    pLog(oddsEventId ?? "unknown", "odds:bookLine:priorResolved", { player: playerName, market, line: prior });
    return { line: prior, overOdds: null, underOdds: null, isDegraded: true, source: "prior" };
  }

  console.log(`[MLB orchestrator] No real line for ${playerName}/${market} — SKIPPED`);
  pLog(oddsEventId ?? "unknown", "odds:bookLine:skipped", { player: playerName, market, reason: "noLineAvailable" });
  return null;
}

// ── MLB status normalization ──────────────────────────────────────────────────
export function normalizeMlbStatus(raw: string | undefined): "live" | "pregame" | "final" | "unknown" {
  if (!raw) return "unknown";
  const s = raw.toLowerCase().replace(/[\s_-]/g, "").replace(/^status/, "");
  if (s === "live" || s === "inprogress" || s === "halftime" || s === "delayed") return "live";
  if (s === "preview" || s === "pregame" || s === "scheduled") return "pregame";
  if (s === "final" || s === "gameover" || s === "completed" || s === "fulltime" || s === "postponed" || s === "canceled" || s === "cancelled") return "final";
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
  ball_in_play: ["hits", "total_bases", "home_runs", "hrr", "hits_allowed"],
  inning_change: "all",
  pitcher_change: "all",
  runner_change: ["hits", "total_bases", "hrr"],
  pitch_count_threshold: ["pitcher_strikeouts", "pitcher_outs", "hits_allowed"],
  tto_shift: "all",
  lineup_substitution: "all",
  hard_hit_event: ["hits", "total_bases", "home_runs", "hrr", "hits_allowed"],
  out_recorded: "all",
  score_change: "all",
  odds_update: "all",
};

// ── Polling intervals ─────────────────────────────────────────────────────────

const GAME_DISCOVERY_MS = 5 * 60 * 1000;   // 5 minutes
const GAME_STATE_MS = 10 * 1000;            // 10 seconds (via pollGame)
const WEATHER_MS = 10 * 60 * 1000;          // 10 minutes

// ── Orchestrator class ────────────────────────────────────────────────────────

const HR_ROSTER_SCAN_INTERVAL_MS = 3 * 60 * 1000;
const hrRosterScanLastRun = new Map<string, number>();
const hrRosterScanLastABCount = new Map<string, number>();

export class LiveGameOrchestrator {
  private timers: ReturnType<typeof setInterval>[] = [];
  private previousStates: Map<string, GameStateCache> = new Map();
  private pollInFlight: Set<string> = new Set();

  start(): void {
    console.log("[MLB orchestrator] Starting...");

    // Initial discovery
    this.pollGames().catch(console.error);

    this.timers.push(
      setInterval(() => {
        this.pollGames().catch(console.error);
        resetDailyPersistGuard();
      }, GAME_DISCOVERY_MS)
    );

    // Game state + contact + pitcher context — gated by sport-aware scheduler tier
    this.timers.push(
      setInterval(() => {
        for (const game of getActiveGames()) {
          const ctx = this.buildMlbContext(game.gameId);
          const tier = assignMlbTier(ctx);
          const decision = assignAndCheckPoll("mlb", game.gameId, tier);
          if (!decision.shouldPoll) continue;
          markPolled("mlb", game.gameId, tier);
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
          const venueName = mlbGameCache.weather[game.gameId]?.venueName ?? null;
          syncOpenMeteoWeather(game.gameId, venueName).catch(console.error);
        }
      }, WEATHER_MS)
    );

    runFullOnlyHomersScrape().then(() => refreshOnlyHomersCache()).catch(console.error);
    refreshSelfLearningCalibration().catch(console.error);

    this.timers.push(
      setInterval(() => {
        runFullOnlyHomersScrape().then(() => refreshOnlyHomersCache()).catch(console.error);
      }, 60 * 60_000)
    );

    this.timers.push(
      setInterval(() => {
        refreshSelfLearningCalibration().catch(console.error);
      }, 30 * 60_000)
    );

    console.log(`[MLB orchestrator] Started — discovery ${GAME_DISCOVERY_MS / 1000}s, state/contact/pitcher ${GAME_STATE_MS / 1000}s, weather ${WEATHER_MS / 1000}s, OnlyHomers=hourly, calibration=30min`);
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
          // For freshly-discovered games that may already be live, kick off
          // an immediate state poll so the cached inning/score is accurate
          // within ~1s instead of waiting for the next 10s tick (which would
          // leave the UI showing the default "top of 1st" placeholder).
          this.pollGame(game.gameId).catch((err) =>
            console.warn(`[MLB orchestrator] immediate poll failed for ${game.gameId}:`, err.message)
          );
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
          clearScheduler("mlb", existing.gameId);
          clearTier("mlb", existing.gameId);
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
      const gameDate = todayET();
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

  private buildMlbContext(gameId: string): MlbGameContext {
    const game = getGame(gameId);
    const state = mlbGameCache.gameState[gameId];
    const status = normalizeMlbStatus(game?.espnStatus);
    let inning: number | undefined;
    let isTopInning: boolean | undefined;
    if (state) {
      inning = state.inning;
      isTopInning = state.isTopInning;
    }
    let startsInMinutes: number | undefined;
    if (game?.startTime) {
      const startMs = new Date(game.startTime).getTime();
      if (!isNaN(startMs)) startsInMinutes = Math.max(0, (startMs - Date.now()) / 60000);
    }
    const cachedEdge = mlbEdgeCache.get(gameId);
    const hasActiveSignals = (cachedEdge?.qualifiedSignals?.length ?? 0) > 0;
    return {
      gameId,
      status: status === "live" || status === "pregame" || status === "final" ? status : "unknown",
      inning,
      isTopInning,
      hasActiveSignals,
      startsInMinutes,
    };
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
    const contactChanges = await syncContactData(statsPk, gameId);
    await syncPitcherContext(statsPk, gameId);

    // Resolve normalized status EARLY so HR-radar gates can use it. Previously
    // these gates read mlbGameCache.gameState[gameId].status (raw MLB Stats API
    // field), which is frequently empty until ESPN fallback runs further down,
    // causing the HR radar to never evaluate any batter and the ledger to stay
    // empty. Computing the normalized status here unlocks the radar pipeline.
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

    const isLiveForContact = normalizedStatus === "live";

    // Razor-sharp HR grading: pulls inning attribution from each HR play directly,
    // not from the orchestrator's current state.inning (which can roll over).
    // Runs every poll cycle (live + final) so post-game catch-ups still resolve correctly.
    gradeHomeRunsFromPlays(gameId);

    if (contactChanges.length > 0 && isLiveForContact) {
      await this.reevaluateHRRadarOnContact(gameId, contactChanges);
    }

    if (isLiveForContact) {
      await this.periodicHRRadarRosterScan(gameId);
    }

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

    // normalizedStatus + statusSource were already resolved earlier (above the
    // HR-radar gates) so this section just consumes them.
    if (normalizedStatus === "final") {
      const boxScore = mlbGameCache.gameBoxScore?.[gameId];
      const playerHrMap = new Map<string, { inning: number; half: string }>();
      if (boxScore?.byPlayerId) {
        for (const [pid, bsp] of Object.entries(boxScore.byPlayerId)) {
          const hrCount = (bsp as any).hr ?? 0;
          if (hrCount > 0) {
            const liveKey = `${gameId}_${pid}`;
            const alreadyGraded = KNOWN_HR_COUNTS.has(liveKey);
            if (!alreadyGraded) {
              storage.resolveAlertAsHit(pid, gameId, 0, "final", 0).catch(() => {});
            }
            const lastInning = newState.inning ?? 9;
            playerHrMap.set(pid, { inning: lastInning, half: "final" });
          }
        }
      }
      storage.reconcileAlertsForGame(gameId).catch(() => {});
      storage.reconcileHrRadarAlertsForGame(gameId, playerHrMap).catch(() => {});
      clearGameCooldowns(gameId);
      clearGameHrStates(gameId);
      for (const key of Array.from(KNOWN_HR_COUNTS.keys())) {
        if (key.startsWith(`${gameId}_`)) KNOWN_HR_COUNTS.delete(key);
      }
      for (const key of Array.from(KNOWN_HR_AB_INDEX.keys())) {
        if (key.startsWith(`${gameId}_`)) KNOWN_HR_AB_INDEX.delete(key);
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
      } else if (normalizedStatus === "live") {
        const cached = mlbEdgeCache.get(gameId);
        if (cached) {
          mlbEdgeCache.set(gameId, { ...cached, updatedAt: Date.now() });
        }
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

    const marketFamily = getMarketFamily(output.market, output.recommendedSide);
    const isBatterOver = marketFamily === "batter_over";

    const sideProbability = output.recommendedSide === "OVER"
      ? output.calibratedProbabilityOver
      : output.calibratedProbabilityUnder;

    if (isBatterOver) {
      if (sideProbability < 40) {
        console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — prob=${sideProbability.toFixed(1)} < 40 absolute floor (batter_over)`);
        return null;
      }
    } else {
      const qualifyFloor = MARKET_QUALIFY_FLOOR[output.market] ?? 60;
      if (sideProbability < qualifyFloor) {
        console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — prob=${sideProbability.toFixed(1)} < ${qualifyFloor} gate`);
        return null;
      }
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

    if (isBatterOver) {
      const tolerance = ({ hits: 0.08, total_bases: 0.15, home_runs: 0.05, hrr: 0.15, batter_strikeouts: 0.10 } as Record<string, number>)[output.market] ?? 0.10;
      if (output.recommendedSide === "OVER" && output.projection < output.bookLine - tolerance) {
        console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — side inconsistency: OVER but proj=${output.projection} < line=${output.bookLine} - ${tolerance} tolerance (batter_over)`);
        return null;
      }
    } else {
      if (output.recommendedSide === "OVER" && output.projection < output.bookLine) {
        console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — side inconsistency: OVER but proj=${output.projection} < line=${output.bookLine}`);
        return null;
      }
    }
    if (output.recommendedSide === "UNDER" && output.projection > output.bookLine) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — side inconsistency: UNDER but proj=${output.projection} > line=${output.bookLine}`);
      return null;
    }

    const scoreBreakdown = computeSignalScoreByFamily(input, output);

    let hrRadarResult: ReturnType<typeof scoreHRRadar> | null = null;
    if (output.market === "home_runs") {
      hrRadarResult = scoreHRRadar(input, output);
    }

    // ROI HARDENING: batter_over markets (hits/total_bases/hrr/home_runs) are
    // the lowest-ROI family. Tighten the floor from 42→46 and add a borderline
    // conviction-cluster gate so single-positive setups stay watch-only and
    // do not promote into surfaced lean/strong plays without a real driver.
    const minScore = isBatterOver ? 46 : 50;
    if (scoreBreakdown.total < minScore) {
      if (hrRadarResult && hrRadarResult.total >= 35) {
        console.log(`[MLB QUALIFY HR_WATCH][${gameId}] ${output.playerName}/${output.market} — batterOverScore=${scoreBreakdown.total} < ${minScore} but hrRadarScore=${hrRadarResult.total} ≥ 35, surfacing as HR_WATCH`);
      } else {
        console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — signalScore=${scoreBreakdown.total} < ${minScore} gate (tier=${scoreBreakdown.confidenceTier})`);
        return null;
      }
    } else if (
      isBatterOver &&
      scoreBreakdown.total < 55 &&
      ["hits", "total_bases", "hrr", "home_runs"].includes(output.market)
    ) {
      // Borderline batter_over band (46-54): require at least one strong
      // conviction driver (matchup, live confirmation, or recent form).
      // Without a driver, downgrade to HR_WATCH if HR-eligible, else reject.
      const hasConviction =
        scoreBreakdown.matchup >= 55 ||
        scoreBreakdown.liveContext >= 55 ||
        scoreBreakdown.form >= 60;
      if (!hasConviction) {
        if (hrRadarResult && hrRadarResult.total >= 35) {
          console.log(`[MLB QUALIFY HR_WATCH][${gameId}] ${output.playerName}/${output.market} — borderline batter_over score=${scoreBreakdown.total} no conviction cluster (matchup=${scoreBreakdown.matchup} live=${scoreBreakdown.liveContext} form=${scoreBreakdown.form}), routing to HR_WATCH`);
        } else {
          console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — borderline batter_over score=${scoreBreakdown.total} lacks conviction cluster (matchup=${scoreBreakdown.matchup} live=${scoreBreakdown.liveContext} form=${scoreBreakdown.form})`);
          return null;
        }
      }
    }

    const signalTags = deriveSignalTags(input, output, scoreBreakdown);
    const feedTags = deriveFeedTags(input, output, scoreBreakdown);
    const glowEligible = isPlayerGlowEligible(scoreBreakdown, signalTags);
    const pitcherSigs = derivePitcherSignals(input, output);
    const opportunityScore = computeFullOpportunityScore(input, input.inning);
    const liveScore = computeLiveOpportunityScore(scoreBreakdown.total, output.edge, opportunityScore, marketFamily ?? undefined);

    let adjustedProjection = output.projection;
    const isPitcherMarket = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed"].includes(output.market);
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

    console.log(`[LIVE_OPPORTUNITY] player=${output.playerName} market=${output.market} family=${marketFamily} signalScore=${scoreBreakdown.total} edge=${output.edge.toFixed(1)} opportunityScore=${opportunityScore} liveScore=${(liveScore * 100).toFixed(2)} eventBoost=${scoreBreakdown.eventBoost}`);

    const stateFields = this.computeSignalState(gameId, input, output, scoreBreakdown, isBatterOver);

    let signalMode: MLBQualifiedSignal["mode"] = null;
    if (isBatterOver) {
      if (scoreBreakdown.total >= 80) signalMode = "elite";
      else if (scoreBreakdown.total >= 68) signalMode = "strong";
      else if (scoreBreakdown.total >= 55) signalMode = "lean";
      else if (scoreBreakdown.total >= 48) signalMode = "heating_up";
      else if (scoreBreakdown.total >= 42) signalMode = "watch";
    } else {
      if (scoreBreakdown.total >= 85) signalMode = "elite";
      else if (scoreBreakdown.total >= 70) signalMode = "strong";
      else if (scoreBreakdown.total >= 60) signalMode = "lean";
      else if (scoreBreakdown.total >= 50) signalMode = "heating_up";
      else if (scoreBreakdown.total >= 40) signalMode = "watch";
    }

    if (output.market === "home_runs" && hrRadarResult) {
      if (hrRadarResult.total >= 80) signalMode = "hr_elite";
      else if (hrRadarResult.total >= 65) signalMode = "hr_strong";
      else if (hrRadarResult.total >= 50) signalMode = "hr_heating_up";
      else if (hrRadarResult.total >= 35) signalMode = "hr_watch";
    }

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

    signal.mode = signalMode;
    signal.signalStrengthScore = scoreBreakdown.total;
    signal.marketFamily = marketFamily;
    signal.hrRadarScore = hrRadarResult?.total ?? undefined;
    signal.pitcherAnalysis = output.pitcherAnalysis ?? null;
    signal.pitcherSignals = pitcherSigs.length > 0 ? pitcherSigs : (output.pitcherSignals ?? null);
    signal.opportunityScore = opportunityScore;
    signal.liveScore = Math.round(liveScore * 10000) / 10000;
    signal.eventBoost = scoreBreakdown.eventBoost;

    if (output.market === "home_runs" || output.market === "hrr") {
      const ohEnrichment = getOnlyHomersEnrichment(output.playerName);
      (signal as any).isHotHitter = ohEnrichment.isHotHitter;
      (signal as any).hotHitterPeriod = ohEnrichment.hotHitterPeriod;
      (signal as any).hotHitterHrCount = ohEnrichment.hotHitterHrCount;
      if (ohEnrichment.isHotHitter) {
        signal.badges = [...(signal.badges ?? []), "HOT_HITTER"];
        if (!signal.reasons) signal.reasons = [];
        signal.reasons.push(`Hot hitter: ${ohEnrichment.hotHitterHrCount} HRs in last ${ohEnrichment.hotHitterPeriod}`);
      }
    }

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

    if (isBatterOver || output.market === "home_runs") {
      console.log(`[SIGNAL_ENGINE] player=${output.playerName} market=${output.market} family=${marketFamily} mode=${signalMode} sss=${scoreBreakdown.total} edge=${output.edge?.toFixed(1)} prob=${output.calibratedProbability?.toFixed(1)} actionable=${signal.actionable}${hrRadarResult ? ` hrRadar=${hrRadarResult.total}` : ""}`);
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
    scoreBreakdown: { total: number; confidenceTier: string },
    isBatterOver: boolean = false
  ) {
    const gameState = mlbGameCache.gameState[gameId];
    const boxScore = mlbGameCache.gameBoxScore?.[gameId];
    const boxPlayer = boxScore?.byPlayerId?.[input.playerId];

    const currentStat = input.currentStatValue ?? 0;
    const line = output.bookLine;
    const alreadyHit = currentStat >= line && line > 0;

    const isFallback = output.fallbackUsed === true;
    const isStale = output.engineGeneratedAt > 0 && (Date.now() - output.engineGeneratedAt) > 120_000;
    const watchlistThreshold = isBatterOver ? 42 : 55;
    const isWatchlist = isBatterOver
      ? (scoreBreakdown.total < watchlistThreshold || isFallback)
      : (scoreBreakdown.confidenceTier === "WATCHLIST" || scoreBreakdown.total < watchlistThreshold || isFallback);
    const edgeOk = isBatterOver ? true : output.edge > 0;
    const isActionable = !alreadyHit && !isStale && !isWatchlist && !isFallback
      && edgeOk && (output.overOdds !== null || output.underOdds !== null);

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
    const isWatchPitcherMarket = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed"].includes(output.market);
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

  async periodicHRRadarRosterScan(gameId: string): Promise<void> {
    const lastScan = hrRosterScanLastRun.get(gameId) ?? 0;
    const sinceLast = Date.now() - lastScan;
    if (sinceLast < HR_ROSTER_SCAN_INTERVAL_MS) {
      return;
    }
    hrRosterScanLastRun.set(gameId, Date.now());

    const state = mlbGameCache.gameState[gameId];
    if (!state || !state.battingOrder?.length) {
      console.log(`[HR_RADAR_PERIODIC_SCAN_TICK] game=${gameId} skipped — no battingOrder cached`);
      return;
    }

    const contactCache = mlbGameCache.contactData[gameId];
    const allChanges: ContactChangeEvent[] = [];
    let battersWithContact = 0;

    for (const batter of state.battingOrder) {
      const playerContact = contactCache?.byPlayerId?.[batter.playerId];
      const priorABs = (playerContact?.priorABResults ?? []) as any[];
      if (!priorABs.length) continue;
      battersWithContact++;

      const scanKey = `${gameId}:${batter.playerId}`;
      const lastABCount = hrRosterScanLastABCount.get(scanKey) ?? 0;
      // First scan or new AB recorded → include batter. The previous strict
      // ">" check meant on first attempt with priorABs already full, the
      // counter would be set and equality would block the next scan even
      // though no rebuild ever happened. Include on first scan (lastABCount=0)
      // OR when new ABs since last scan.
      const isFirstScan = lastABCount === 0;
      if (!isFirstScan && priorABs.length <= lastABCount) continue;
      hrRosterScanLastABCount.set(scanKey, priorABs.length);

      allChanges.push({
        playerId: batter.playerId,
        playerName: batter.playerName,
        newABCount: priorABs.length,
        prevABCount: lastABCount,
        latestAB: priorABs.slice(-1)[0] ?? null,
      });
    }

    console.log(`[HR_RADAR_PERIODIC_SCAN_TICK] game=${gameId} battersInOrder=${state.battingOrder.length} battersWithContact=${battersWithContact} changesQueued=${allChanges.length}`);

    if (allChanges.length > 0) {
      console.log(`[HR_RADAR_ROSTER_SCAN] game=${gameId} evaluating ${allChanges.length} batters with contact data`);
      await this.reevaluateHRRadarOnContact(gameId, allChanges);
    }
  }

  async reevaluateHRRadarOnContact(gameId: string, contactChanges: ContactChangeEvent[]): Promise<void> {
    const state = mlbGameCache.gameState[gameId];
    if (!state || !state.battingOrder?.length) return;

    const contactCache = mlbGameCache.contactData[gameId];
    const pitcherCtxCache = mlbGameCache.pitcherContext?.[gameId];
    const weatherCache = mlbGameCache.weather[gameId];
    const bullpenCache = mlbGameCache.bullpen[gameId];

    const pitcher = state.pitcherInGame;
    const pitcherCtx = pitcher ? pitcherCtxCache?.byPitcherId?.[pitcher.playerId] : undefined;
    const pitcherSeasonStats = pitcher ? mlbPlayerCache.pitcherSeasonStats[pitcher.playerId] : undefined;

    const isPitcherCollapsing = pitcherCtx
      ? (pitcherCtx.velocityDrop !== null && pitcherCtx.velocityDrop > 2)
      : false;

    const hourlyWeather = resolveCurrentHourWeather(gameId);
    const resolvedTemp = hourlyWeather?.temperature ?? weatherCache?.temperature ?? null;
    const resolvedWindSpeed = hourlyWeather?.windSpeed ?? weatherCache?.windSpeed ?? null;
    const resolvedWindDir = hourlyWeather?.windDirection ?? weatherCache?.windDirection ?? null;

    for (const change of contactChanges) {
      const batter = state.battingOrder.find(b => b.playerId === change.playerId);
      if (!batter) continue;

      const playerContact = contactCache?.byPlayerId?.[change.playerId];
      if (!playerContact?.priorABResults?.length) continue;

      const rosterLookup = getPlayer(batter.playerId);
      const resolvedBatterHand: "L" | "R" | "S" | null = rosterLookup?.bats ?? null;
      const rollingStats = mlbPlayerCache.batterRollingStats[batter.playerId];

      const { remainingPA } = estimateRemainingPA(
        state.inning,
        state.isTopInning,
        batter.slot,
      );

      const hrInput: MLBPropInput = {
        playerId: batter.playerId,
        playerName: batter.playerName,
        team: batter.team,
        opponent: state.homeTeamAbbr && state.awayTeamAbbr
          ? (batter.team === state.homeTeamAbbr ? state.awayTeamAbbr : state.homeTeamAbbr)
          : "",
        gameId,
        market: "home_runs" as MLBMarket,
        bookLine: 0.5,
        overOdds: null,
        underOdds: null,
        seasonAvg: 0.04,
        plateAppearances: state.pitchCount > 0 ? Math.max(1, state.battingOrder.length) : 0,
        atBats: mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId]?.ab ?? 0,
        currentStatValue: mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId]?.hr ?? 0,
        remainingPA,
        remainingAB: remainingPA,
        completedAB: mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId]?.ab ?? 0,
        inning: state.inning,
        isTopInning: state.isTopInning,
        currentGameHR: mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId]?.hr ?? 0,
        hardHitCount: (playerContact.priorABResults ?? []).filter((ab: any) => (ab.exitVelocity ?? 0) >= 95).length,
        batterHand: resolvedBatterHand,
        contactQuality: {
          exitVelocity: playerContact.exitVelocity ?? null,
          launchAngle: playerContact.launchAngle ?? null,
          hitDistance: playerContact.hitDistance ?? null,
          hardHitRateSeason: playerContact.hardHitPct != null ? playerContact.hardHitPct / 100 : null,
          barrelRateProxySeason: playerContact.barrelPct != null ? playerContact.barrelPct / 100 : null,
          avgBatSpeed: playerContact.avgBatSpeed ?? null,
          avgSwingLength: playerContact.avgSwingLength ?? null,
          priorABResults: (playerContact.priorABResults ?? []) as MLBPropInput["contactQuality"]["priorABResults"],
          xBA: playerContact.xBA ?? null,
          xSLG: playerContact.xSLG ?? null,
          learnedHitLikelihood: null,
          learnedHrLikelihood: null,
          pitchTypeHrRisk: null,
        },
        pitcher: {
          pitchCount: pitcher ? state.pitchCount : 0,
          timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
          era: pitcherSeasonStats?.era ?? null,
          whip: pitcherSeasonStats?.whip ?? null,
          kPer9: pitcherSeasonStats?.kPer9 ?? null,
          bbPer9: pitcherSeasonStats?.bbPer9 ?? null,
          managerLeashShort: pitcherCtx ? pitcherCtx.timesThroughOrder >= 3 && pitcherCtx.pitchCount > 80 : false,
          isPitcherCollapsing,
          pitchMix: pitcherCtx?.pitchMix ?? [],
          throws: pitcher?.throws ?? null,
          seasonAvgVelocity: pitcherCtx?.seasonAvgVelocity ?? null,
        },
        ...(rollingStats ? {
          hrTrend: {
            abSinceLastHR: rollingStats.abSinceLastHR,
            hrRateLast7: rollingStats.hrRateLast7,
            hrRateLast15: rollingStats.hrRateLast15,
            hrRateLast30: rollingStats.hrRateLast30,
            seasonTotalHR: rollingStats.seasonTotalHR,
            seasonTotalAB: rollingStats.seasonTotalAB,
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
          parkFactor: getMarketParkFactor(weatherCache?.venueName, "home_runs", resolvedBatterHand),
          temperature: resolvedTemp,
          windSpeed: resolvedWindSpeed,
          windDirection: resolvedWindDir,
          humidity: hourlyWeather?.humidity ?? weatherCache?.humidity ?? null,
          isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
          parkHistoryFactor: null,
          windShiftDetected: false,
        },
        bullpen: {
          bullpenEra: bullpenCache?.bullpenEra ?? null,
          bullpenUsageLastThreeDays: bullpenCache?.bullpenUsageLastThreeDays ?? null,
          isTopRelieverAvailable: bullpenCache?.isTopRelieverAvailable ?? true,
        },
      };

      const ohData = getOnlyHomersEnrichment(batter.playerName);
      if (ohData.isHotHitter) {
        const boost = ohData.hotHitterPeriod === "7d" ? 0.8 : ohData.hotHitterPeriod === "14d" ? 0.5 : 0.3;
        hrInput.hotHitterBoost = boost;
      }

      hrInput.liveInterpretation = buildLiveEventInterpretation(hrInput);

      const hrBuild = buildHRSignal(hrInput);
      if (hrBuild.score <= 0) continue;

      const isReliever = bullpenCache?.relieversUsed?.some(
        r => r.playerId === pitcher?.playerId
      ) ?? false;
      let relieverEra: number | null = null;
      if (isReliever && pitcher?.playerId) {
        relieverEra = pitcherSeasonStats?.era ?? null;
      }

      let starterEra: number | null = null;
      if (isReliever && pitcherCtxCache?.byPitcherId && pitcher?.team) {
        const allPitcherIds = Object.keys(pitcherCtxCache.byPitcherId);
        const relieverIds = new Set(
          (bullpenCache?.relieversUsed ?? []).map(r => r.playerId)
        );
        for (const pid of allPitcherIds) {
          if (pid === pitcher.playerId) continue;
          if (relieverIds.has(pid)) continue;
          const sStats = mlbPlayerCache.pitcherSeasonStats[pid];
          if (sStats?.era != null) {
            starterEra = sStats.era;
            break;
          }
        }
      }

      const pitcherDeteriorationCtx = {
        velocityDrop: pitcherCtx?.velocityDrop ?? null,
        avgVelocity: pitcherCtx?.avgVelocity ?? null,
        seasonAvgVelocity: pitcherCtx?.seasonAvgVelocity ?? null,
        isReliever,
        relieverEra,
        starterEra: isReliever ? starterEra : (pitcherSeasonStats?.era ?? null),
        bullpenEra: bullpenCache?.bullpenEra ?? null,
        bullpenUsageLast3Days: bullpenCache?.bullpenUsageLastThreeDays ?? null,
        relieversUsedCount: bullpenCache?.relieversUsed?.length ?? 0,
      };

      const alertInput: HRAlertInput = {
        playerId: batter.playerId,
        playerName: batter.playerName,
        teamAbbr: batter.team,
        gameId,
        hrBuildScore: hrBuild.score,
        hrIntensity: hrBuild.intensity,
        factors: hrBuild.factors,
        inning: state.inning,
        isTopInning: state.isTopInning,
        battingOrderSlot: batter.slot,
        remainingPA,
        pitchCount: pitcher ? state.pitchCount : 0,
        timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
        isPitcherCollapsing,
        parkFactor: getMarketParkFactor(weatherCache?.venueName, "home_runs", resolvedBatterHand),
        windDirection: resolvedWindDir,
        windSpeed: resolvedWindSpeed,
        temperature: resolvedTemp,
        isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
        batterHand: resolvedBatterHand,
        pitcherThrows: pitcher?.throws ?? null,
        era: pitcherSeasonStats?.era ?? null,
        currentRuns: (state.homeScore != null || state.awayScore != null)
          ? (state.homeScore ?? 0) + (state.awayScore ?? 0)
          : 4.5,
        leagueAvgRuns: 4.5,
        seasonHRRate: rollingStats?.seasonHRRate ?? null,
        barrelRate: playerContact.barrelPct != null ? playerContact.barrelPct / 100 : null,
        hardHitRate: playerContact.hardHitPct != null ? playerContact.hardHitPct / 100 : null,
        xSLG: playerContact.xSLG ?? null,
        abSinceLastHR: rollingStats?.abSinceLastHR ?? null,
        hrRateLast7: rollingStats?.hrRateLast7 ?? null,
        hrRateLast15: rollingStats?.hrRateLast15 ?? null,
        hrRateLast30: rollingStats?.hrRateLast30 ?? null,
        handednessParkFactor: getMarketParkFactor(weatherCache?.venueName, "home_runs", resolvedBatterHand),
        pitcherDeterioration: pitcherDeteriorationCtx,
        leiNearHrScore: hrInput.liveInterpretation?.nearHrScore,
        leiMomentumScore: hrInput.liveInterpretation?.momentumScore,
        leiPitcherFatigueScore: hrInput.liveInterpretation?.pitcherFatigueScore,
        leiVeloDropScore: hrInput.liveInterpretation?.veloDropScore,
        leiConfidenceBoost: hrInput.liveInterpretation?.confidenceBoost,
        leiTags: hrInput.liveInterpretation?.tags,
        priorABResults: (playerContact.priorABResults ?? []).map((ab: any) => ({
          exitVelocity: ab.exitVelocity ?? null,
          launchAngle: ab.launchAngle ?? null,
          distance: ab.distance ?? null,
          outcome: ab.outcome ?? "out",
        })),
        preHrDangerScore: hrBuild.preHrDangerScore,
        dangerFlags: hrBuild.dangerFlags,
      };

      const alertResult = evaluateHRAlert(alertInput);
      if (alertResult.level !== "ALERT" && alertResult.level !== "WATCH") continue;

      const latestEV = change.latestAB?.exitVelocity ?? null;
      console.log(`[HR_RADAR_CONTACT_UPDATE] ${alertResult.level} ${batter.playerName} score=${hrBuild.score} intensity=${hrBuild.intensity} latestEV=${latestEV} triggerReason=${alertResult.triggerReason} state=${alertResult.signalState} game=${gameId} inn=${state.inning}`);

      const resolvedOpponent = state.homeTeamAbbr && state.awayTeamAbbr
        ? (batter.team === state.homeTeamAbbr ? state.awayTeamAbbr : state.homeTeamAbbr)
        : "";

      const tierMap: Record<string, "monitor" | "building" | "strong"> = {
        FORMATION: "monitor",
        BUILDING: "building",
        PEAK: "strong",
        COOLDOWN: "monitor",
      };
      const stateMap: Record<string, "live" | "watching" | "actionable"> = {
        FORMATION: "watching",
        BUILDING: "live",
        PEAK: "actionable",
        COOLDOWN: "watching",
      };

      const lastAB = (playerContact.priorABResults ?? []).slice(-1)[0] as any;
      const contactSnap = lastAB ? {
        ev: lastAB.exitVelocity ?? null,
        la: lastAB.launchAngle ?? null,
        distance: lastAB.distance ?? null,
        hardHit: (lastAB.exitVelocity ?? 0) >= 95,
        barrel: (lastAB.exitVelocity ?? 0) >= 98 && (lastAB.launchAngle ?? 0) >= 20 && (lastAB.launchAngle ?? 0) <= 35,
      } : null;

      const convSnap = alertResult.diagnostics?.hrConversion ? {
        hrConversionProbability: alertResult.diagnostics.hrConversion.hrConversionProbability,
        calibratedProbability: alertResult.diagnostics.hrConversion.calibratedProbability,
        perPAHRRate: alertResult.diagnostics.hrConversion.perPAHRRate,
        expectedRemainingPA: alertResult.diagnostics.hrConversion.expectedRemainingPA,
        liveContactMultiplier: alertResult.diagnostics.hrConversion.liveContactMultiplier,
        pitcherMultiplier: alertResult.diagnostics.hrConversion.pitcherMultiplier,
        environmentMultiplier: alertResult.diagnostics.hrConversion.environmentMultiplier,
        pitcherDeteriorationState: alertResult.diagnostics.hrConversion.pitcherDeteriorationState,
      } : null;

      const diagSnap = alertResult.diagnostics ? {
        alertPath: alertResult.diagnostics.alertPath,
        positiveFactors: alertResult.diagnostics.positiveFactors,
        suppressionFlags: alertResult.diagnostics.suppressionFlags,
        hrShapedCount: alertResult.diagnostics.hrShapedCount,
        missedHrCount: alertResult.diagnostics.missedHrCount,
        eliteHrCount: alertResult.diagnostics.eliteHrCount,
        qualifiedEVMean: alertResult.diagnostics.qualifiedEVMean,
        maxDistance: alertResult.diagnostics.maxDistance,
        remainingPA: alertResult.diagnostics.remainingPA,
        pitcherFatigueState: alertResult.diagnostics.pitcherFatigueState,
        environmentContext: alertResult.diagnostics.environmentContext,
        hrConversion: convSnap,
        contactClasses: alertResult.diagnostics.contactClasses.map(c => ({
          contactClass: c.contactClass, exitVelocity: c.exitVelocity,
          launchAngle: c.launchAngle, distance: c.distance,
          outcome: c.outcome, isBarrel: c.isBarrel,
        })),
      } : null;

      // Pull engine's earliest in-memory detection so the row's detected
      // label reflects when we FIRST noticed the player, not when persistence
      // finally fired (HR Radar detection-drift fix, T002).
      const earlyDetect = getHrAlertState(gameId, batter.playerId);
      // Phase 1–2: also pass canonical stage on the contact-update path so
      // a heavy contact event doesn't lag the canonical stage by one tick.
      const contactCanonicalStage = earlyDetect ? mapDynamicStateToStage(earlyDetect.currentState) : null;
      storage.createOrUpdateHrRadarAlert({
        gameId,
        playerId: batter.playerId,
        playerName: batter.playerName,
        team: batter.team,
        opponent: resolvedOpponent,
        inning: state.inning,
        half: state.isTopInning ? "top" : "bottom",
        readinessScore: hrBuild.score,
        dynamicReadinessScore: earlyDetect?.hrReadinessScore ?? null,
        canonicalStage: contactCanonicalStage,
        confidenceTier: tierMap[alertResult.signalState ?? "FORMATION"] ?? "monitor",
        signalState: stateMap[alertResult.signalState ?? "FORMATION"] ?? "live",
        triggerTags: alertResult.triggerReason ? alertResult.triggerReason.split(", ") : [],
        summaryText: alertResult.formattedReason || `${alertResult.decision} — ${alertResult.triggerReason}`,
        contactSnapshot: contactSnap,
        alertPath: alertResult.diagnostics?.alertPath ?? null,
        alertTier: alertResult.alertTier ?? null,
        diagnosticsSnapshot: diagSnap,
        // Canonical HR score contract (Phase 3)
        buildScore: hrBuild.score,
        conversionProbabilityRaw: alertResult.diagnostics?.hrConversion?.hrConversionProbability ?? null,
        conversionProbability: alertResult.diagnostics?.hrConversion?.calibratedProbability ?? null,
        peakConversionProbability: null,
        firstDetectedInning: earlyDetect?.detectedInning ?? null,
        firstDetectedHalf: earlyDetect?.detectedHalf ?? null,
        firstDetectedAtMs: earlyDetect?.detectedAtMs ?? null,
      }).catch(err => console.warn(`[HR_RADAR_CONTACT_UPDATE] persist failed: ${err.message}`));
    }
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

    const hourlyWeather = resolveCurrentHourWeather(gameId);
    const resolvedTemp = hourlyWeather?.temperature ?? weatherCache?.temperature ?? null;
    const resolvedWindSpeed = hourlyWeather?.windSpeed ?? weatherCache?.windSpeed ?? null;
    const resolvedWindDir = hourlyWeather?.windDirection ?? weatherCache?.windDirection ?? null;
    const resolvedHumidity = hourlyWeather?.humidity ?? weatherCache?.humidity ?? null;
    const resolvedWindShift = weatherCache?.windShiftDetected ?? false;

    if (weatherCache?.venueName) {
      const _pf = getMarketParkFactor(weatherCache.venueName);
      const _hrF = getMarketParkFactor(weatherCache.venueName, "home_runs");
      const _hitsF = getMarketParkFactor(weatherCache.venueName, "hits");
      console.log(`[MLB_PARK] game=${gameId} venue="${weatherCache.venueName}" overall=${_pf} hr=${_hrF} hits=${_hitsF}${resolvedWindShift ? " WIND_SHIFT" : ""}`);
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
          const gs = (pStats as any).gamesStarted ?? null;
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
        let hrRadarOnly = false;
        if (resolvedLine === null) {
          if (market === "home_runs") {
            hrRadarOnly = true;
            console.log(`[MLB HR_RADAR_ONLY][${gameId}] ${batter.playerName} — no book line for home_runs, running HR radar scan only`);
          } else {
            console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "no_book_line" }`);
            continue;
          }
        }
        if (resolvedLine && resolvedLine.isDegraded) anyDegraded = true;

        if (!hrRadarOnly) {
          const resolvedMarketObj = { line: resolvedLine!.line, odds: (resolvedLine!.overOdds !== null || resolvedLine!.underOdds !== null) ? { overOdds: resolvedLine!.overOdds, underOdds: resolvedLine!.underOdds } : null };
          if (!hasRealOdds(resolvedMarketObj)) {
            console.warn(`[MLB orchestrator] hasRealOdds failed for ${batter.playerName}/${market} — signalLocked=false, skipping computation`);
            console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "no_real_odds", line: ${resolvedLine!.line} }`);
            continue;
          }
        }

        const boxScorePlayer = mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId];
        const playerAB = boxScorePlayer?.ab ?? 0;
        const isEarlySignalMode = playerAB < 1;

        const rollingStats = mlbPlayerCache.batterRollingStats[batter.playerId];
        const pitcherSeasonStats = pitcher ? mlbPlayerCache.pitcherSeasonStats[pitcher.playerId] : undefined;
        const bvpKey = pitcher ? `${batter.playerId}_vs_${pitcher.playerId}` : null;
        const bvpData = bvpKey ? mlbPlayerCache.bvpMatchups[bvpKey] : undefined;

        const batterSeasonAvg = rollingStats?.seasonAvg ?? 0.250;
        const rollingAvg = rollingStats?.last15?.avg;
        const rawSeasonAvg = rollingAvg != null ? rollingAvg : batterSeasonAvg;
        const rateAdj = getLearnedRateAdjustment(market);
        const effectiveSeasonAvg = rateAdj !== 1.0
          ? Math.max(0.01, rawSeasonAvg * rateAdj)
          : rawSeasonAvg;
        let currentStatForMarket = 0;
        if (boxScorePlayer) {
          switch (market) {
            case "hits": currentStatForMarket = boxScorePlayer.hits; break;
            case "home_runs": currentStatForMarket = boxScorePlayer.hr; break;
            case "hrr": currentStatForMarket = (boxScorePlayer.hr ?? 0) + ((boxScorePlayer as any).r ?? 0) + ((boxScorePlayer as any).rbi ?? 0); break;
            case "total_bases": currentStatForMarket = boxScorePlayer.tb; break;
            case "pitcher_strikeouts": case "hits_allowed": currentStatForMarket = 0; break;
            default: currentStatForMarket = boxScorePlayer.hits; break;
          }
        }

        const contactABs = playerContact?.priorABResults ?? [];
        if (contactABs.length > 0 && market === "hits") {
          let contactHits = 0;
          for (const ab of contactABs) {
            if (ab.outcome === "hit") contactHits++;
          }
          if (contactHits > currentStatForMarket) {
            console.log(`[MLB CONTACT_CROSSCHECK][${gameId}] ${batter.playerName} hits: box=${currentStatForMarket} contact=${contactHits} — using contact`);
            currentStatForMarket = contactHits;
          }
        }

        const boxHR = boxScorePlayer?.hr ?? 0;
        const currentGameHR = boxHR;
        // Note: HR grading is now centralized in gradeHomeRunsFromPlays()
        // (called once per poll cycle from _pollGameInner) using the canonical
        // inning/halfInning from each HR play's about.* fields. The legacy
        // box-score-driven path used state.inning here, which produced wrong
        // inning attribution when polling lagged behind an inning rollover.
        const hardHitCount = playerContact
          ? (playerContact.priorABResults ?? []).filter((ab: any) => (ab.exitVelocity ?? 0) >= 95).length
          : 0;

        const rosterLookup = getPlayer(batter.playerId);
        const resolvedBatterHand: "L" | "R" | "S" | null = rosterLookup?.bats ?? null;
        const batterOpponent = state.homeTeamAbbr && state.awayTeamAbbr
          ? (batter.team === state.homeTeamAbbr ? state.awayTeamAbbr : state.homeTeamAbbr)
          : "";

        const input: MLBPropInput = {
          playerId: batter.playerId,
          playerName: batter.playerName,
          team: batter.team,
          opponent: batterOpponent,
          gameId,
          market,
          bookLine: hrRadarOnly ? 0.5 : resolvedLine!.line,
          overOdds: hrRadarOnly ? null : resolvedLine!.overOdds,
          underOdds: hrRadarOnly ? null : resolvedLine!.underOdds,
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
          batterHand: rosterLookup?.bats ?? null,
          contactQuality: (() => {
            const ev = playerContact?.exitVelocity ?? null;
            const la = playerContact?.launchAngle ?? null;
            const dist = playerContact?.hitDistance ?? null;
            const learnedScores = ev != null ? getContactQualityScore(ev, la, dist) : null;
            const latestPitchType = (playerContact?.priorABResults ?? []).slice(-1)[0]?.pitchType ?? null;
            const pitchHrRisk = latestPitchType ? getPitchTypeHrRisk(latestPitchType) : null;
            return {
              exitVelocity: ev,
              launchAngle: la,
              hitDistance: dist,
              hardHitRateSeason: playerContact?.hardHitPct != null ? playerContact.hardHitPct / 100 : null,
              barrelRateProxySeason: playerContact?.barrelPct != null ? playerContact.barrelPct / 100 : null,
              avgBatSpeed: playerContact?.avgBatSpeed ?? null,
              avgSwingLength: playerContact?.avgSwingLength ?? null,
              priorABResults: (playerContact?.priorABResults ?? []) as MLBPropInput["contactQuality"]["priorABResults"],
              xBA: playerContact?.xBA ?? null,
              xSLG: playerContact?.xSLG ?? null,
              learnedHitLikelihood: learnedScores?.hitLikelihood ?? null,
              learnedHrLikelihood: learnedScores?.hrLikelihood ?? null,
              pitchTypeHrRisk: pitchHrRisk,
            };
          })(),
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
            seasonAvgVelocity: pitcherCtx?.seasonAvgVelocity ?? null,
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
            hrTrend: {
              abSinceLastHR: rollingStats.abSinceLastHR,
              hrRateLast7: rollingStats.hrRateLast7,
              hrRateLast15: rollingStats.hrRateLast15,
              hrRateLast30: rollingStats.hrRateLast30,
              seasonTotalHR: rollingStats.seasonTotalHR,
              seasonTotalAB: rollingStats.seasonTotalAB,
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
            parkFactor: getMarketParkFactor(weatherCache?.venueName, market, resolvedBatterHand),
            temperature: resolvedTemp,
            windSpeed: resolvedWindSpeed,
            windDirection: resolvedWindDir,
            humidity: resolvedHumidity,
            isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
            parkHistoryFactor: null,
            windShiftDetected: resolvedWindShift,
          },
          bullpen: {
            bullpenEra: bullpenCache?.bullpenEra ?? null,
            bullpenUsageLastThreeDays: bullpenCache?.bullpenUsageLastThreeDays ?? null,
            isTopRelieverAvailable: bullpenCache?.isTopRelieverAvailable ?? true,
          },
        };

        if (market === "home_runs" || market === "hrr") {
          const ohData = getOnlyHomersEnrichment(batter.playerName);
          if (ohData.isHotHitter) {
            const boost = ohData.hotHitterPeriod === "7d" ? 0.8 : ohData.hotHitterPeriod === "14d" ? 0.5 : 0.3;
            input.hotHitterBoost = boost;
          }
        }

        input.liveInterpretation = buildLiveEventInterpretation(input);

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
          if (!hrRadarOnly) marketsEvaluated++;

          const fwResult = runIntegrityFirewall(rawOutput);
          logFirewallResult(gameId, rawOutput.playerName, market, fwResult);

          if (fwResult.hardReject && !hrRadarOnly) {
            signalsRejected++;
            console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "firewall_hard_reject" }`);
            continue;
          }

          const output = fwResult.hardReject ? rawOutput : fwResult.cappedOutput;

          const bArch = batterArchetypeCache.get(batter.playerId) ?? "stable_regular";

          // Trace: engine → firewall → final (no double-cap; engine is authoritative)
          console.log(`[MLB_PROB_TRACE] player=${batter.playerName} market=${market} arch=${bArch} engine=${rawOutput.calibratedProbability.toFixed(1)} postFw=${output.calibratedProbability.toFixed(1)} side=${output.recommendedSide} edge=${output.edge.toFixed(2)}`);

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
            batSpeed: playerContact?.avgBatSpeed ?? null,
            distance: lastAB?.distance ?? playerContact?.hitDistance ?? null,
            barrelPct: playerContact?.barrelPct ?? null,
            hardHitPct: playerContact?.hardHitPct ?? null,
            outcome: lastAB?.outcome ?? null,
            perABxBA: lastAB?.perABxBA ?? null,
            contactGrade: lastAB?.contactGrade ?? undefined,
            hrProbability: lastAB?.hrProbability ?? 0,
          } : null;

          if (!hrRadarOnly) {
            const qResult = this.qualifySignal(gameId, input, output);
            if (qResult && !isEarlySignalMode) {
              qResult.currentStats = batterStats;
              qResult.lastABContact = lastABContact;
              qResult.batterArchetype = bArch;
              qResult.pitcherArchetype = pitcherArch;
              qResult.thesis = thesis;
              qResult.safetyCeilingApplied = output.safetyCeilingApplied ?? false;
              qResult.varianceTier = MARKET_VOLATILITY[market] ?? "mid";
              qResult.isDegraded = !!(input as any).isDegraded;
              if ((input as any).bvpHistory) {
                qResult.bvpHistory = (input as any).bvpHistory;
              }
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
              if (!isEarlySignalMode) signalsRejected++;
              const watchSig = isEarlySignalMode
                ? (qResult ?? this.buildWatchSignal(gameId, input, output))
                : this.buildWatchSignal(gameId, input, output);
              if (watchSig) {
                watchSig.currentStats = batterStats;
                watchSig.lastABContact = lastABContact;
                watchSig.batterArchetype = bArch;
                watchSig.pitcherArchetype = pitcherArch;
                watchSig.thesis = thesis;
                watchSig.isDegraded = !!(input as any).isDegraded;
                if ((input as any).bvpHistory) {
                  watchSig.bvpHistory = (input as any).bvpHistory;
                }
                if (isEarlySignalMode) {
                  watchSig.confidenceTier = "WATCHLIST" as any;
                  watchSig.isEarlySignal = true;
                  watchSig.watchlist = true;
                  watchSig.actionable = false;
                  console.log(`[MLB EARLY_SIGNAL] ${batter.playerName}/${market} game=${gameId} — pre-AB watchlist signal (edge=${output.edge.toFixed(1)}, side=${output.recommendedSide})`);
                }
                allSignals.push(watchSig);
              }
            }
          }

          if (market === "home_runs" && output.hrBuildScore != null && output.hrBuildScore > 0) {
            const hrFactorsBuild = typeof output.hrFactors === "object" && output.hrFactors?.build
              ? output.hrFactors.build
              : { avgEV: null, maxEV: null, avgLA: null, barrels: 0, hardHits: 0, deepFlyouts: 0, batSpeedScore: 0, pitcherFatigueBoost: 0, parkWindBoost: 0, platoonBoost: 0, hrShapedCount: 0, missedHrCount: 0, eliteHrCount: 0, qualifiedEVMean: null, maxDistance: null, contactClasses: [] };

            const isReliever = bullpenCache?.relieversUsed?.some(
              r => r.playerId === pitcher?.playerId
            ) ?? false;
            let relieverEra: number | null = null;
            if (isReliever && pitcher?.playerId) {
              relieverEra = pitcherSeasonStats?.era ?? null;
            }

            let starterEra: number | null = null;
            if (isReliever && pitcherCtxCache?.byPitcherId && pitcher?.team) {
              const allPitcherIds = Object.keys(pitcherCtxCache.byPitcherId);
              const relieverIds = new Set(
                (bullpenCache?.relieversUsed ?? []).map(r => r.playerId)
              );
              for (const pid of allPitcherIds) {
                if (pid === pitcher.playerId) continue;
                if (relieverIds.has(pid)) continue;
                const sStats = mlbPlayerCache.pitcherSeasonStats[pid];
                if (sStats?.era != null) {
                  starterEra = sStats.era;
                  break;
                }
              }
            }

            const pitcherDeteriorationCtx = {
              velocityDrop: pitcherCtx?.velocityDrop ?? null,
              avgVelocity: pitcherCtx?.avgVelocity ?? null,
              seasonAvgVelocity: pitcherCtx?.seasonAvgVelocity ?? null,
              isReliever,
              relieverEra,
              starterEra: isReliever ? starterEra : (pitcherSeasonStats?.era ?? null),
              bullpenEra: bullpenCache?.bullpenEra ?? null,
              bullpenUsageLast3Days: bullpenCache?.bullpenUsageLastThreeDays ?? null,
              relieversUsedCount: bullpenCache?.relieversUsed?.length ?? 0,
            };

            const resolvedSeasonHRRate = rollingStats?.seasonHRRate ?? null;
            const resolvedOpponent = state.homeTeamAbbr && state.awayTeamAbbr
              ? (batter.team === state.homeTeamAbbr ? state.awayTeamAbbr : state.homeTeamAbbr)
              : "";

            const alertInput: HRAlertInput = {
              playerId: batter.playerId,
              playerName: batter.playerName,
              teamAbbr: batter.team,
              gameId,
              hrBuildScore: output.hrBuildScore,
              hrIntensity: output.hrIntensity ?? "weak",
              factors: hrFactorsBuild as any,
              inning: state.inning,
              isTopInning: state.isTopInning,
              battingOrderSlot: batter.slot,
              remainingPA,
              pitchCount: pitcher ? state.pitchCount : 0,
              timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
              isPitcherCollapsing,
              parkFactor: getMarketParkFactor(weatherCache?.venueName, "home_runs", resolvedBatterHand),
              windDirection: resolvedWindDir,
              windSpeed: resolvedWindSpeed,
              temperature: resolvedTemp,
              isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
              batterHand: resolvedBatterHand,
              pitcherThrows: pitcher?.throws ?? null,
              era: pitcherSeasonStats?.era ?? null,
              currentRuns: (state.homeScore != null || state.awayScore != null)
                ? (state.homeScore ?? 0) + (state.awayScore ?? 0)
                : 4.5,
              leagueAvgRuns: 4.5,
              seasonHRRate: resolvedSeasonHRRate,
              barrelRate: playerContact?.barrelPct != null ? playerContact.barrelPct / 100 : null,
              hardHitRate: playerContact?.hardHitPct != null ? playerContact.hardHitPct / 100 : null,
              xSLG: playerContact?.xSLG ?? null,
              abSinceLastHR: rollingStats?.abSinceLastHR ?? null,
              hrRateLast7: rollingStats?.hrRateLast7 ?? null,
              hrRateLast15: rollingStats?.hrRateLast15 ?? null,
              hrRateLast30: rollingStats?.hrRateLast30 ?? null,
              handednessParkFactor: getMarketParkFactor(weatherCache?.venueName, "home_runs", resolvedBatterHand),
              pitcherDeterioration: pitcherDeteriorationCtx,
              leiNearHrScore: input.liveInterpretation?.nearHrScore,
              leiMomentumScore: input.liveInterpretation?.momentumScore,
              leiPitcherFatigueScore: input.liveInterpretation?.pitcherFatigueScore,
              leiVeloDropScore: input.liveInterpretation?.veloDropScore,
              leiConfidenceBoost: input.liveInterpretation?.confidenceBoost,
              leiTags: input.liveInterpretation?.tags,
              priorABResults: (playerContact?.priorABResults ?? []).map((ab: any) => ({
                exitVelocity: ab.exitVelocity ?? null,
                launchAngle: ab.launchAngle ?? null,
                distance: ab.distance ?? null,
                outcome: ab.outcome ?? "out",
              })),
              preHrDangerScore: (output.hrFactors as any)?.preHrDangerScore,
              dangerFlags: (output.hrFactors as any)?.dangerFlags,
            };
            const alertResult = evaluateHRAlert(alertInput);

            const hrDynSnap = recomputeHrAlertState(alertInput, {
              gameFinal: normalizedStatus === "final",
              currentPitcherId: pitcher?.playerId ?? null,
              isHome: batter.team === state.homeTeamAbbr,
              precomputedAlert: alertResult,
            });
            (output as any).hrAlertSnapshot = hrDynSnap;
            console.log(`[HR_DYNAMIC] ${batter.playerName} state=${hrDynSnap.currentState} readiness=${hrDynSnap.hrReadinessScore} convRaw=${(hrDynSnap.hrConversionProbabilityRaw * 100).toFixed(1)}% convCal=${(hrDynSnap.hrConversionProbabilityCalibrated * 100).toFixed(1)}% decay=${hrDynSnap.decayFactor.toFixed(2)} pitVuln=${hrDynSnap.pitcherHrVulnerability} remPA=${hrDynSnap.remainingPAExpectation.toFixed(1)} tick=${hrDynSnap.tickCount} game=${gameId}`);

            const convResult = alertResult.diagnostics.hrConversion;
            const rawPct = convResult ? `${(convResult.hrConversionProbability * 100).toFixed(1)}%` : "n/a";
            const calPct = convResult ? `${(convResult.calibratedProbability * 100).toFixed(1)}%` : "n/a";
            const detState = convResult?.pitcherDeteriorationState ?? "n/a";
            if (alertResult.level === "ALERT" || alertResult.level === "WATCH") {
              const diag = alertResult.diagnostics;
              console.log(`[HR_ALERT_TRIGGER] ${alertResult.level} ${batter.playerName} score=${output.hrBuildScore} rawConv=${rawPct} calConv=${calPct} pitDet=${detState} reason=${alertResult.triggerReason} state=${alertResult.signalState} decision=${alertResult.decision} confidence=${alertResult.confidenceScore} tier=${alertResult.alertTier} path=${diag.alertPath} hrShaped=${diag.hrShapedCount} missed=${diag.missedHrCount} elite=${diag.eliteHrCount} evMean=${diag.qualifiedEVMean} maxDist=${diag.maxDistance} remPA=${diag.remainingPA} pitcher=${diag.pitcherFatigueState} env=${diag.environmentContext} suppressions=${diag.suppressionFlags.length} positives=[${diag.positiveFactors.join("|")}] game=${gameId} inn=${state.inning}`);
              // Only burn the 10-minute cooldown on actual ALERTs. WATCH-tier
              // signals (FORMATION/MONITOR) are non-actionable tracking signals
              // and must not suppress a later genuine ALERT for the same
              // player — particularly important for the PATH_E_CONVICTION
              // safety net which intentionally fires WATCH signals before
              // contact-event evidence accumulates.
              if (alertResult.level === "ALERT") {
                markAlertSent(batter.playerId, gameId);
              }
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

              const tierMap: Record<string, "monitor" | "building" | "strong"> = {
                FORMATION: "monitor",
                BUILDING: "building",
                PEAK: "strong",
                COOLDOWN: "monitor",
              };
              const stateMap: Record<string, "live" | "watching" | "actionable"> = {
                FORMATION: "watching",
                BUILDING: "live",
                PEAK: "actionable",
                COOLDOWN: "watching",
              };

              const lastAB = (playerContact?.priorABResults ?? []).slice(-1)[0] as any;
              const contactSnap = lastAB ? {
                ev: lastAB.exitVelocity ?? null,
                la: lastAB.launchAngle ?? null,
                distance: lastAB.distance ?? null,
                hardHit: (lastAB.exitVelocity ?? 0) >= 95,
                barrel: (lastAB.exitVelocity ?? 0) >= 98 && (lastAB.launchAngle ?? 0) >= 20 && (lastAB.launchAngle ?? 0) <= 35,
              } : null;

              const convSnap = alertResult.diagnostics?.hrConversion ? {
                hrConversionProbability: alertResult.diagnostics.hrConversion.hrConversionProbability,
                calibratedProbability: alertResult.diagnostics.hrConversion.calibratedProbability,
                perPAHRRate: alertResult.diagnostics.hrConversion.perPAHRRate,
                expectedRemainingPA: alertResult.diagnostics.hrConversion.expectedRemainingPA,
                liveContactMultiplier: alertResult.diagnostics.hrConversion.liveContactMultiplier,
                pitcherMultiplier: alertResult.diagnostics.hrConversion.pitcherMultiplier,
                environmentMultiplier: alertResult.diagnostics.hrConversion.environmentMultiplier,
                pitcherDeteriorationState: alertResult.diagnostics.hrConversion.pitcherDeteriorationState,
              } : null;

              const diagSnap = alertResult.diagnostics ? {
                alertPath: alertResult.diagnostics.alertPath,
                positiveFactors: alertResult.diagnostics.positiveFactors,
                suppressionFlags: alertResult.diagnostics.suppressionFlags,
                hrShapedCount: alertResult.diagnostics.hrShapedCount,
                missedHrCount: alertResult.diagnostics.missedHrCount,
                eliteHrCount: alertResult.diagnostics.eliteHrCount,
                qualifiedEVMean: alertResult.diagnostics.qualifiedEVMean,
                maxDistance: alertResult.diagnostics.maxDistance,
                remainingPA: alertResult.diagnostics.remainingPA,
                pitcherFatigueState: alertResult.diagnostics.pitcherFatigueState,
                environmentContext: alertResult.diagnostics.environmentContext,
                hrConversion: convSnap,
                contactClasses: alertResult.diagnostics.contactClasses.map(c => ({
                  contactClass: c.contactClass, exitVelocity: c.exitVelocity,
                  launchAngle: c.launchAngle, distance: c.distance,
                  outcome: c.outcome, isBarrel: c.isBarrel,
                })),
              } : null;

              // ── Goldmaster Phase 1–2: canonical stage as live truth ──────
              // The dynamic engine state is the source of truth for the live
              // user-facing ladder. We pass it explicitly; storage maps it to
              // the legacy confidenceTier for backwards compat.
              const canonicalStage = hrDynSnap ? mapDynamicStateToStage(hrDynSnap.currentState) : null;

              storage.createOrUpdateHrRadarAlert({
                gameId,
                playerId: batter.playerId,
                playerName: batter.playerName,
                team: batter.team,
                opponent: resolvedOpponent,
                inning: state.inning,
                half: state.isTopInning ? "top" : "bottom",
                readinessScore: output.hrBuildScore,
                // Phase 2 — dynamic engine readiness becomes the live progression score
                dynamicReadinessScore: hrDynSnap?.hrReadinessScore ?? null,
                // Phase 1 — canonical stage (overrides legacy sticky tier)
                canonicalStage,
                confidenceTier: tierMap[alertResult.signalState ?? "FORMATION"] ?? "monitor",
                signalState: stateMap[alertResult.signalState ?? "FORMATION"] ?? "live",
                triggerTags: alertResult.triggerReason ? alertResult.triggerReason.split(", ") : [],
                summaryText: alertResult.formattedReason || `${alertResult.decision} — ${alertResult.triggerReason}`,
                contactSnapshot: contactSnap,
                alertPath: alertResult.diagnostics?.alertPath ?? null,
                alertTier: alertResult.alertTier ?? null,
                diagnosticsSnapshot: diagSnap,
                // Canonical HR score contract (Phase 3)
                buildScore: output.hrBuildScore ?? null,
                conversionProbabilityRaw: alertResult.diagnostics?.hrConversion?.hrConversionProbability ?? null,
                conversionProbability: alertResult.diagnostics?.hrConversion?.calibratedProbability ?? null,
                peakConversionProbability: hrDynSnap?.peakConversionProbability ?? null,
                // Engine's earliest in-memory detection (T002 backfill).
                firstDetectedInning: hrDynSnap?.detectedInning ?? null,
                firstDetectedHalf: hrDynSnap?.detectedHalf ?? null,
                firstDetectedAtMs: hrDynSnap?.detectedAtMs ?? null,
              }).catch(err => console.warn(`[HR_RADAR_ALERT] persist failed: ${err.message}`));
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
        const isPitcherEarlySignal = currentPitchCount < 10;
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

        const pitcherOpponent = state.homeTeamAbbr && state.awayTeamAbbr
          ? (pitcherToEval.team === state.homeTeamAbbr ? state.awayTeamAbbr : state.homeTeamAbbr)
          : "";

        const input: MLBPropInput = {
          playerId: pitcherToEval.playerId,
          playerName: pitcherToEval.playerName,
          team: pitcherToEval.team,
          opponent: pitcherOpponent,
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
            seasonAvgVelocity: pitcherCtx?.seasonAvgVelocity ?? null,
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
            temperature: resolvedTemp,
            windSpeed: resolvedWindSpeed,
            windDirection: resolvedWindDir,
            humidity: resolvedHumidity,
            isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
            parkHistoryFactor: null,
            windShiftDetected: resolvedWindShift,
          },
          bullpen: {
            bullpenEra: bullpenCache?.bullpenEra ?? null,
            bullpenUsageLastThreeDays: bullpenCache?.bullpenUsageLastThreeDays ?? null,
            isTopRelieverAvailable: bullpenCache?.isTopRelieverAvailable ?? true,
          },
        };

        input.liveInterpretation = buildLiveEventInterpretation(input);

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
          // Trace: engine → firewall → final (no double-cap; engine is authoritative)
          console.log(`[MLB_PROB_TRACE] pitcher=${pitcherToEval.playerName} market=${market} arch=${pArchForMarket} engine=${rawOutput.calibratedProbability.toFixed(1)} postFw=${output.calibratedProbability.toFixed(1)} side=${output.recommendedSide} edge=${output.edge.toFixed(2)}`);

          if (output.recommendedSide === "OVER" || output.recommendedSide === "UNDER") {
            trackSignalDirection(market, output.recommendedSide);
          }

          pLog(gameId, "engineOutput:pitcher", { player: output.playerName, market: output.market, edge: output.edge, tier: output.confidenceTier, archetype: pArchForMarket });
          recordMLBDiagnostic(output);

          console.log(`[MLB engine] playerId=${pitcherToEval.playerId} player="${pitcherToEval.playerName}" market=${market} inning=${state.inning} remainingPA=${remainingPA} calibratedProbOver=${output.calibratedProbabilityOver.toFixed(2)} calibratedProbUnder=${output.calibratedProbabilityUnder.toFixed(2)} edge=${output.edge.toFixed(2)} side=${output.recommendedSide} arch=${pArchForMarket}`);

          outputs.push({ ...output });
          marketsEvaluated++;

          const qResult = this.qualifySignal(gameId, input, output);
          if (qResult && !isPitcherEarlySignal) {
            qResult.pitcherArchetype = pArchForMarket;
            qResult.safetyCeilingApplied = output.safetyCeilingApplied ?? false;
            qResult.varianceTier = MARKET_VOLATILITY[market] ?? "mid";
            qResult.isDegraded = !!(input as any).isDegraded;
            qResult.dataQuality = !!(input as any).isDegraded ? "degraded" : "partial";
            qualifiedSignals.push(qResult);
            allSignals.push(qResult);
            signalsQualified++;
            scoreSum += qResult.signalScore;
          } else {
            if (!isPitcherEarlySignal) signalsRejected++;
            const watchSig = isPitcherEarlySignal
              ? (qResult ?? this.buildWatchSignal(gameId, input, output))
              : this.buildWatchSignal(gameId, input, output);
            if (watchSig) {
              watchSig.pitcherArchetype = pArchForMarket;
              watchSig.isDegraded = !!(input as any).isDegraded;
              if (isPitcherEarlySignal) {
                watchSig.confidenceTier = "WATCHLIST" as any;
                watchSig.isEarlySignal = true;
                watchSig.watchlist = true;
                watchSig.actionable = false;
                console.log(`[MLB EARLY_SIGNAL] pitcher ${pitcherToEval.playerName}/${market} game=${gameId} — early pitcher watchlist signal (pitchCount=${currentPitchCount}, edge=${output.edge.toFixed(1)})`);
              }
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
          const isSigBatterOver = sig.side === "OVER" && !["pitcher_strikeouts", "pitcher_outs", "hits_allowed"].includes(sig.market);
          const familyWatchThreshold = isSigBatterOver ? 42 : 55;
          if (sig.signalScore < familyWatchThreshold) {
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

    const existingCache = mlbEdgeCache.get(gameId);
    // Preserve when this cycle produced no signals at all (transient blank
    // between innings, all watch signals returned null, etc.) so the user's
    // feed doesn't briefly empty itself mid-game. The previous version only
    // preserved when marketsEvaluated === 0, but a cycle can evaluate dozens
    // of markets and still emit zero signals (every watch fails the side/odds
    // gate); that empty cycle would wipe a populated cache.
    const isThisCycleEmpty = allSignals.length === 0;
    const PRESERVE_MAX_AGE_MS = 10 * 60 * 1000;
    const cacheAge = now - Math.max(existingCache?.updatedAt ?? 0, existingCache?.createdAt ?? 0);
    if (isThisCycleEmpty && existingCache && existingCache.allSignals.length > 0 && cacheAge < PRESERVE_MAX_AGE_MS) {
      mlbEdgeCache.set(gameId, { ...existingCache, updatedAt: now });
      console.log(`[MLB QUALIFICATION][${gameId}] marketsEvaluated=${marketsEvaluated} qualified=0 rejected=${signalsRejected} PRESERVED ${existingCache.allSignals.length} existing signals (this cycle blank, last good cycle within ${Math.round(cacheAge/1000)}s)`);
    } else {
      mlbEdgeCache.set(gameId, {
        gameId,
        outputs,
        qualifiedSignals,
        allSignals,
        gameCardTags: gameCardTags as string[],
        updatedAt: now,
        createdAt: existingCache?.createdAt ?? now,
        isDegraded: anyDegraded,
        signalLocked,
      });
      const avgScore = signalsQualified > 0 ? Math.round(scoreSum / signalsQualified) : 0;
      console.log(`[MLB QUALIFICATION][${gameId}] marketsEvaluated=${marketsEvaluated} qualified=${signalsQualified} rejected=${signalsRejected} allSignals=${allSignals.length} avgScore=${avgScore} gameCardTags=[${gameCardTags.join(",")}]`);

      autoPersistMLBSignals(gameId, qualifiedSignals);
    }
    return outputs;
  }
}

// ── Auto-persist qualified MLB signals to persisted_plays ────────────────────

const mlbPersistGuard = new Map<string, number>();

function autoPersistMLBSignals(gameId: string, qualifiedSignals: MLBQualifiedSignal[]): void {
  const today = todayET();
  let persisted = 0;
  let skipped = 0;
  let skipReasons: Record<string, number> = {};

  for (const sig of qualifiedSignals) {
    const isBatterOverWatch = sig.marketFamily === "batter_over" && sig.mode === "watch";
    if ((sig.watchlist && !isBatterOverWatch) || sig.isEarlySignal) { skipped++; skipReasons["watchlist"] = (skipReasons["watchlist"] ?? 0) + 1; continue; }
    const sbk = sig.sportsbook && sig.sportsbook.trim() !== "" ? sig.sportsbook : "odds_api";
    if (!Number.isFinite(sig.line) || sig.line <= 0) { skipped++; skipReasons["bad_line"] = (skipReasons["bad_line"] ?? 0) + 1; continue; }

    const dir = sig.side === "OVER" ? "over" : sig.side === "UNDER" ? "under" : null;
    if (!dir) { skipped++; skipReasons["no_dir"] = (skipReasons["no_dir"] ?? 0) + 1; continue; }

    const canonicalKey = `${sig.playerId}|${sig.market}|${dir}|${gameId}|${today}`;
    const prevScore = mlbPersistGuard.get(canonicalKey);
    const curScore = sig.signalScore ?? 0;
    if (prevScore !== undefined && curScore <= prevScore) { skipped++; skipReasons["dedup"] = (skipReasons["dedup"] ?? 0) + 1; continue; }
    mlbPersistGuard.set(canonicalKey, curScore);

    trackPlay({
      gameId,
      playerId: sig.playerId,
      playerName: sig.playerName,
      team: sig.team ?? null,
      sport: "mlb",
      market: sig.market,
      direction: dir,
      line: sig.line,
      projection: sig.projection,
      probability: sig.engineProbability,
      edge: sig.evPct ?? 0,
      sportsbook: sbk,
      derivedLine: false,
      createdAt: sig.engineGeneratedAt ?? Date.now(),
      signalScore: sig.signalScore ?? null,
      confidenceTier: sig.confidenceTier ?? null,
      inning: sig.inning ?? null,
      abNumber: sig.completedAB ?? null,
      opportunityScore: sig.opportunityScore ?? null,
      liveScore: sig.liveScore ?? null,
      eventBoost: sig.eventBoost ?? null,
      signalMode: sig.mode ?? null,
      marketFamily: sig.marketFamily ?? null,
    }, storage).catch(err => console.warn(`[MLB_AUTO_PERSIST] failed: ${err.message}`));
    persisted++;
  }

  const reasonStr = Object.entries(skipReasons).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`[MLB_AUTO_PERSIST] game=${gameId} qualified=${qualifiedSignals.length} persisted=${persisted} skipped=${skipped} ${reasonStr}`);
}

function resetDailyPersistGuard(): void {
  const today = todayET();
  for (const key of Array.from(mlbPersistGuard.keys())) {
    if (!key.endsWith(today)) mlbPersistGuard.delete(key);
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const liveOrchestrator = new LiveGameOrchestrator();
