// ── MLB Data Pull Service ─────────────────────────────────────────────────────
// Fetches and caches live game data from MLB Stats API and Baseball Savant.
// All functions: 8-second timeout, try/catch, log-and-return on error.

import type { PitchMixEntry, PitcherHandednessSplits, BatterHandednessSplits } from "./types";
import { normalizePitchTypeCode } from "./pitchTypeNormalizer";
import { fetchBaseballSavantData, fetchSavantGameFeed, getStadiumCoords, windDirectionRelativeToField, isVenueIndoors } from "./dataSources";
import { classifyContact, computeGameContactProfile, isBarrel as isCanonicalBarrel } from "./statcastXBA";
import { storage } from "../storage";
import { aggregateOrderSplits } from "./orderSplits";
import { todayET } from "../utils/dateUtils";

// ── Cache type definitions ────────────────────────────────────────────────────

export interface BattingOrderEntry {
  playerId: string;
  playerName: string;
  team: string;
  slot: number;
}

export interface GameStateCache {
  inning: number;
  isTopInning: boolean;
  outs: number;
  runnersOnBase: Array<"first" | "second" | "third">;
  battingOrder: BattingOrderEntry[];
  currentBatter: { playerId: string; playerName: string } | null;
  pitcherInGame: { playerId: string; playerName: string; team: string; throws: "L" | "R" | null } | null;
  pitchCount: number;
  timesThroughOrder: number;
  homeScore: number;
  awayScore: number;
  totalPlays: number;
  homeTeamAbbr: string;
  awayTeamAbbr: string;
  fetchedAt: number;
}

export interface PlayerContactData {
  exitVelocity: number | null;
  launchAngle: number | null;
  hitDistance: number | null;
  latestExitVelocity: number | null;
  latestLaunchAngle: number | null;
  hardHitPct: number | null;
  barrelPct: number | null;
  avgBatSpeed: number | null;
  avgSwingLength: number | null;
  xBA: number | null;
  xSLG: number | null;
  gameAvgXBA: number | null;
  gameMaxXBA: number | null;
  gameBarrelCount: number;
  gameContactQuality: number;
  // Power profile — Gaps 7–9
  flyBallPercent: number | null;
  hrFBRatio: number | null;
  xwOBASeason: number | null;
  xISOSeason: number | null;
  sweetSpotPercent: number | null;
  pullRatePercent: number | null;
  // Phase 2 — overlay season Savant aggregates (optional, no-op when absent).
  batterPitchSplits?: import("./hr/hrOverlayTypes").PitchTypeBatterSplit[] | null;
  toppedPct?: number | null;
  maxEV?: number | null;
  priorABResults: Array<{
    exitVelocity: number | null;
    launchAngle: number | null;
    distance: number | null;
    outcome: "hit" | "out" | "strikeout" | "walk" | "hbp" | "error" | "other";
    pitchType: string | null;
    pitchSpeed: number | null;
    isBarrel?: boolean;
    perABxBA?: number | null;
    contactGrade?: string;
    hrProbability?: number;
    // MLB Signals audit P1 — capture hit-type granularity + RBI from the
    // play feed so play-feed-derived stat counts (total_bases, hrr) match
    // the engine's market keys without waiting for the box-score sync.
    hitType?: "single" | "double" | "triple" | "home_run" | null;
    rbi?: number;
    runScored?: boolean;
    // Committed-window scoping (2026-06) — inning/half this AB occurred, from
    // the play feed (`play.about`). Threaded to ClassifiedContact so near-HR
    // credit can be limited to the committed window.
    inning?: number | null;
    half?: "top" | "bottom" | null;
  }>;
}

interface ContactDataCache {
  byPlayerId: Record<string, PlayerContactData>;
  fetchedAt: number;
}

interface PitcherContextEntry {
  pitchMix: PitchMixEntry[];
  avgVelocity: number | null;
  pitchCount: number;
  timesThroughOrder: number;
  velocityDrop: number | null;
  // Lane 3.3 — recent in-game velocity trend (mph) = avg(last 5 pitches) −
  // avg(prior 5). Negative = velo falling right now. Null until >= 10 pitches.
  recentVeloTrend: number | null;
  seasonAvgVelocity: number | null;
  avgFastballSpin: number | null;
  // Gap 3: pre-game fatigue — pitcher's recent start history
  lastStartPitchCount: number | null;
  daysSinceLastStart: number | null;
  last3StartERA: number | null;
}

interface PitcherContextCache {
  byPitcherId: Record<string, PitcherContextEntry>;
  fetchedAt: number;
}

export interface HourlyWeatherEntry {
  hour: number;
  temperature: number | null;
  windSpeed: number | null;
  windDirection: "in" | "out" | "cross" | "calm" | null;
  windDegrees: number | null;
  humidity: number | null;
  precipProb: number | null;
  // Lane 3.2 — surface barometric pressure (hPa). Optional.
  pressure?: number | null;
}

export interface WeatherCache {
  temperature: number | null;
  windSpeed: number | null;
  windDirection: "in" | "out" | "cross" | "calm" | null;
  humidity: number | null;
  // Lane 3.2 — surface barometric pressure (hPa). Optional; null when source
  // (Open-Meteo) didn't provide it or weather came from the MLB feed.
  pressure?: number | null;
  fetchedAt: number;
  venueName: string | null;
  isIndoors: boolean;
  // Player-specific park/wind fit inputs (shared parkWindFit module). Optional /
  // nullable — they only enrich the directional (LF/RF) fit; the engine stays
  // neutral when both are absent. windString preserves the MLB feed's explicit
  // sector text ("Out To LF"); windDegrees preserves the Open-Meteo bearing.
  windString?: string | null;
  windDegrees?: number | null;
  hourlyForecast?: HourlyWeatherEntry[];
  utcOffsetSeconds?: number;
  gameStartWindDirection?: "in" | "out" | "cross" | "calm" | null;
  windShiftDetected?: boolean;
}

interface BullpenCache {
  bullpenEra: number | null;
  bullpenUsageLastThreeDays: number | null;
  isTopRelieverAvailable: boolean;
  relieversUsed: Array<{ playerId: string; playerName: string; pitchCount: number }>;
  fetchedAt: number;
}

interface PitcherSeasonStats {
  era: number | null;
  whip: number | null;
  kPer9: number | null;
  bbPer9: number | null;
  inningsPitched: number | null;
  wins: number | null;
  losses: number | null;
  /** Mound Radar input — season starts, used for Long Leash / avg-IP-per-start projection. */
  gamesStarted: number | null;
  fetchedAt: number;
}

/**
 * Prior-season K/9 history (current season excluded — that's PitcherSeasonStats).
 * Mound Radar input for matchupAdjustedKs.ts's multi-year baseline blend.
 * A season only counts if it clears a minimum innings-pitched floor (avoids a
 * few relief innings or an injury-shortened season skewing the blend) — a
 * year that doesn't clear it, or that fails to fetch, is `null`, never
 * fabricated as 0 or league-average, and never simply omitted (that would
 * shift a real year-2 value into the year-1 slot and misweight it).
 */
interface PitcherMultiYearStats {
  /** Prior seasons' K/9, positionally aligned [year-1, year-2] — null where that year is disqualified or failed to fetch. Never compacted. */
  priorSeasonsKPer9: (number | null)[];
  fetchedAt: number;
}

interface BatterRollingStats {
  last7: { avg: number | null; ops: number | null; slg: number | null; games: number };
  last15: { avg: number | null; ops: number | null; slg: number | null; games: number };
  last30: { avg: number | null; ops: number | null; slg: number | null; games: number };
  seasonAvg: number | null;
  seasonOps: number | null;
  seasonSlg: number | null;
  seasonHRRate: number | null;
  abSinceLastHR: number | null;
  hrRateLast7: number | null;
  hrRateLast15: number | null;
  hrRateLast30: number | null;
  seasonTotalHR: number;
  seasonTotalAB: number;
  seasonTotalPA: number;
  // Intentional walks (feared-slugger prior). Defensive: 0 / null when the feed
  // does not expose intentionalWalks, so downstream multipliers stay neutral.
  seasonTotalIBB: number;
  seasonIBBRate: number | null;   // IBB / PA
  fetchedAt: number;
}

interface BvPMatchupStats {
  atBats: number;
  hits: number;
  homeRuns: number;
  strikeouts: number;
  avg: number | null;
  ops: number | null;
  fetchedAt: number;
}

// ── In-memory cache ───────────────────────────────────────────────────────────

interface GameBoxScorePlayer {
  playerId: string;
  playerName: string;
  team: string;
  hits: number;
  hr: number;
  ab: number;
  bb: number;
  rbi: number;
  so: number;
  tb: number;
  runs: number;
}

interface GameBoxScoreCache {
  byPlayerId: Record<string, GameBoxScorePlayer>;
  fetchedAt: number;
}

/** Mound Radar settlement input — final pitching line, keyed by pitcherId. */
export interface GamePitchingBoxScorePitcher {
  pitcherId: string;
  pitcherName: string;
  team: string;
  strikeOuts: number;
  outsRecorded: number;
  baseOnBalls: number;
  earnedRuns: number;
  hits: number;
  homeRuns: number;
}

interface GamePitchingBoxScoreCache {
  byPitcherId: Record<string, GamePitchingBoxScorePitcher>;
  /**
   * Ordered pitcher-appearance list per team abbreviation (index 0 = the
   * starter), sourced from the live feed's boxscore.teams[side].pitchers —
   * the same array MLB's own UI uses to render "who's pitched in this game
   * and in what order." Mound Radar settlement (moundOutcomeAttribution.ts's
   * hasPitcherBeenPulled) uses this to detect a pitcher's own outing being
   * over well before the whole game reaches final.
   */
  pitcherOrderByTeam: Record<string, string[]>;
  fetchedAt: number;
}

export interface HRPlayMeta {
  playerId: string;
  playerName: string;
  team: string;
  inning: number;
  halfInning: "top" | "bottom";
  atBatIndex: number;
  endTimeMs: number | null;
  eventType: string;
  isComplete: boolean;
}

interface HRPlaysCache {
  plays: HRPlayMeta[];
  fetchedAt: number;
}

export const mlbGameCache: {
  gameState: Record<string, GameStateCache>;
  contactData: Record<string, ContactDataCache>;
  pitcherContext: Record<string, PitcherContextCache>;
  weather: Record<string, WeatherCache>;
  bullpen: Record<string, BullpenCache>;
  gameBoxScore: Record<string, GameBoxScoreCache>;
  /** Mound Radar settlement input — final pitching lines. Populated by syncGameBoxScore. */
  gamePitchingBoxScore: Record<string, GamePitchingBoxScoreCache>;
  hrPlays: Record<string, HRPlaysCache>;
} = {
  gameState: {},
  contactData: {},
  pitcherContext: {},
  weather: {},
  bullpen: {},
  gameBoxScore: {},
  gamePitchingBoxScore: {},
  hrPlays: {},
};

export const mlbPlayerCache: {
  pitcherSeasonStats: Record<string, PitcherSeasonStats>;
  pitcherMultiYearStats: Record<string, PitcherMultiYearStats>;
  batterRollingStats: Record<string, BatterRollingStats>;
  batterOrderSplits: Record<string, BatterOrderSplitsData>;
  bvpMatchups: Record<string, BvPMatchupStats>;
  // Pitcher ALLOWED stat lines by opposing batting-order slot. No producer is
  // wired yet (see GitHub issue: research a real pitcher-allowed-by-slot feed) —
  // the Pre-Game Power Radar's pitcherOrderSplit scorer reads this and reports
  // "unavailable" while it is empty, so it never fabricates pitcher-order
  // confidence. A future sync populates `slots` keyed by lineup slot (1–9).
  pitcherOrderSplits: Record<string, PitcherOrderSplitsData>;
} = {
  pitcherSeasonStats: {},
  pitcherMultiYearStats: {},
  batterRollingStats: {},
  batterOrderSplits: {},
  bvpMatchups: {},
  pitcherOrderSplits: {},
};

interface PitcherOrderSplitRow {
  ab: number | null; r: number | null; h: number | null;
  doubles: number | null; triples: number | null; hr: number | null;
  rbi: number | null; bb: number | null; hbp: number | null; so: number | null;
  sb: number | null; cs: number | null;
  avg: number | null; obp: number | null; slg: number | null; ops: number | null;
}

interface PitcherOrderSplitsData {
  /** Allowed line per opposing lineup slot (1–9). */
  slots: Record<number, PitcherOrderSplitRow>;
  fetchedAt: number;
}

interface BatterOrderSplitsData {
  splits: Array<{ slot: number; slg: number | null; ops: number | null; pa: number }>;
  overallSlg: number | null;
  fetchedAt: number;
}

const PITCHER_SEASON_TTL = 30 * 60 * 1000;
// Prior seasons never change once final — long TTL, matches SPLITS_TTL's
// "moves slowly" rationale rather than PITCHER_SEASON_TTL's in-progress one.
const PITCHER_MULTI_YEAR_TTL = 24 * 60 * 60 * 1000;
/** A prior season only counts toward the multi-year blend at this IP floor. */
const PITCHER_MULTI_YEAR_MIN_IP = 20;
const BATTER_ROLLING_TTL = 20 * 60 * 1000;
const BATTER_ORDER_SPLITS_TTL = 6 * 60 * 60 * 1000; // lineup-slot history moves slowly
const BVP_TTL = 60 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

const LIVE_FEED_URL = (gamePk: string) =>
  `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": "LiveLocks/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseBaseballInnings(raw: unknown): number | null {
  if (raw == null) return null;
  const str = String(raw);
  const parts = str.split(".");
  const whole = parseInt(parts[0], 10);
  if (!Number.isFinite(whole)) return null;
  if (parts.length === 1) return whole;
  const frac = parseInt(parts[1], 10);
  if (frac === 1) return whole + 1 / 3;
  if (frac === 2) return whole + 2 / 3;
  return whole;
}

function normalizeWindDirection(raw: string | undefined): "in" | "out" | "cross" | "calm" | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("in") || lower.includes("toward home")) return "in";
  if (lower.includes("out") || lower.includes("toward center") || lower.includes("to center")) return "out";
  if (lower.includes("calm") || lower.includes("none") || lower === "0" || lower === "still") return "calm";
  return "cross";
}

function inferOutcome(event: string | undefined): PlayerContactData["priorABResults"][0]["outcome"] {
  if (!event) return "other";
  const e = event.toLowerCase();
  if (e.includes("home run") || e.includes("single") || e.includes("double") || e.includes("triple")) return "hit";
  if (e.includes("strikeout") || e.includes("struck out")) return "strikeout";
  if (e.includes("walk")) return "walk";
  if (e.includes("hit by pitch")) return "hbp";
  if (e.includes("error")) return "error";
  if (e.includes("out") || e.includes("fly") || e.includes("ground") || e.includes("line")) return "out";
  return "other";
}

// MLB Signals audit P1 — extract specific hit type so total_bases / hrr
// can be computed from the play feed without waiting for box-score sync.
function inferHitType(
  event: string | undefined
): "single" | "double" | "triple" | "home_run" | null {
  if (!event) return null;
  const e = event.toLowerCase();
  if (e.includes("home run")) return "home_run";
  if (e.includes("triple")) return "triple";
  if (e.includes("double")) return "double";
  if (e.includes("single")) return "single";
  return null;
}

// ── syncGameState ─────────────────────────────────────────────────────────────

export async function syncGameState(statsPk: string, cacheKey?: string): Promise<void> {
  const gameId = cacheKey ?? statsPk;
  try {
    const data = await fetchJson(LIVE_FEED_URL(statsPk));
    const liveData = data.liveData ?? {};
    const linescore = liveData.linescore ?? {};
    const plays = liveData.plays ?? {};
    const boxTeams = liveData.boxscore?.teams ?? {};

    // Canonical session date for HR Radar ledger — derived from MLB Stats API
    // officialDate so late-night/midnight-rollover games persist & match under
    // a stable, game-tied date instead of drifting wall-clock todayET().
    const officialDate: string | undefined = data?.gameData?.datetime?.officialDate;
    if (officialDate) {
      const { setMlbGameSessionDate } = await import("../utils/mlbSessionDate");
      setMlbGameSessionDate(gameId, officialDate);
    }

    // Inning / top-bottom
    // Innings only advance — never let a stale-or-null Stats API response
    // regress the cached value. If the API returns nothing and we have no
    // prior state, fall back to inning 1 (the gameState is fresh-registered).
    const prevState = mlbGameCache.gameState[gameId];
    const apiInning = safeNum(linescore.currentInning);
    const apiInningValid = apiInning != null && apiInning >= 1;
    const inning: number = apiInningValid
      ? Math.max(apiInning, prevState?.inning ?? 0)
      : (prevState?.inning ?? 1);
    // Trust API top/bottom only when API also reported a valid inning;
    // otherwise keep the prior half so we never flip back to "top" on a
    // stale read once the bottom half has begun.
    const isTopInning: boolean = apiInningValid && typeof linescore.isTopInning === "boolean"
      ? linescore.isTopInning
      : (prevState?.isTopInning ?? true);
    if (apiInning != null && prevState?.inning != null && apiInning < prevState.inning) {
      console.warn(`[MLB SYNC GUARD] ${gameId}: API inning ${apiInning} < cached ${prevState.inning} — keeping cached (stale read)`);
    }
    const outs: number = safeNum(linescore.outs) ?? 0;

    // Scores
    const homeScore: number = safeNum(linescore.teams?.home?.runs) ?? 0;
    const awayScore: number = safeNum(linescore.teams?.away?.runs) ?? 0;

    // Total completed plays (for AB completion detection)
    const allPlays: any[] = plays.allPlays ?? [];
    const totalPlays: number = allPlays.filter((p: any) => p.result?.event).length;

    // Runners on base
    const offenseBase = linescore.offense ?? {};
    const runnersOnBase: Array<"first" | "second" | "third"> = [];
    if (offenseBase.first) runnersOnBase.push("first");
    if (offenseBase.second) runnersOnBase.push("second");
    if (offenseBase.third) runnersOnBase.push("third");

    // Current batter
    const currentPlayBatter = plays.currentPlay?.matchup?.batter;
    const currentBatter = currentPlayBatter
      ? { playerId: String(currentPlayBatter.id), playerName: currentPlayBatter.fullName ?? "" }
      : null;

    // Active pitcher
    const currentPlayPitcher = plays.currentPlay?.matchup?.pitcher;
    const gameDataTeams = data.gameData?.teams ?? {};
    const pitcherSide: "home" | "away" = isTopInning ? "home" : "away";
    const pitcherTeamAbbrev: string = gameDataTeams[pitcherSide]?.abbreviation ?? "";

    let pitcherInGame: GameStateCache["pitcherInGame"] = null;
    if (currentPlayPitcher) {
      const pitcherId = String(currentPlayPitcher.id);
      const playerBox = boxTeams[pitcherSide]?.players?.[`ID${pitcherId}`];
      const throwsHand: "L" | "R" | null =
        playerBox?.person?.pitchHand?.code === "L" ? "L"
        : playerBox?.person?.pitchHand?.code === "R" ? "R"
        : null;
      pitcherInGame = {
        playerId: pitcherId,
        playerName: currentPlayPitcher.fullName ?? "",
        team: pitcherTeamAbbrev,
        throws: throwsHand,
      };
    } else {
      // Phase 9.2 — pre-game / early-game BvP warmup. When MLB has not yet
      // populated currentPlay.matchup.pitcher (game still pregame or in
      // mid-pitch transition), fall back to the probable starter from
      // gameData.probablePitchers so BvP hydration can run pre-first-pitch.
      // Without this, ~50% of games consistently show withBvP=0 in logs.
      const probablePitchers = data.gameData?.probablePitchers ?? {};
      const probable = probablePitchers[pitcherSide];
      if (probable?.id) {
        const pitcherId = String(probable.id);
        const playerBox = boxTeams[pitcherSide]?.players?.[`ID${pitcherId}`];
        const throwsHand: "L" | "R" | null =
          playerBox?.person?.pitchHand?.code === "L" ? "L"
          : playerBox?.person?.pitchHand?.code === "R" ? "R"
          : null;
        pitcherInGame = {
          playerId: pitcherId,
          playerName: probable.fullName ?? "",
          team: pitcherTeamAbbrev,
          throws: throwsHand,
        };
      }
    }

    // Batting order — use both home and away sides
    const battingOrder: BattingOrderEntry[] = [];
    for (const side of ["home", "away"] as const) {
      const team = boxTeams[side];
      if (!team) continue;
      const teamAbbrev: string = gameDataTeams[side]?.abbreviation ?? side;
      const order: number[] = team.battingOrder ?? [];
      order.forEach((pid: number, idx: number) => {
        const playerInfo = team.players?.[`ID${pid}`];
        battingOrder.push({
          playerId: String(pid),
          playerName: playerInfo?.person?.fullName ?? "",
          team: teamAbbrev,
          slot: idx + 1,
        });
      });
    }

    // Times through order — infer from pitchCount proxy
    const currentPitchCount: number =
      (currentPlayPitcher
        ? boxTeams[pitcherSide]?.players?.[`ID${currentPlayPitcher.id}`]?.stats?.pitching?.numberOfPitches
        : undefined) ?? 0;
    const timesThroughOrder: number = Math.min(3, Math.ceil(currentPitchCount / 27) || 1);

    const homeTeamAbbr: string = gameDataTeams.home?.abbreviation ?? "";
    const awayTeamAbbr: string = gameDataTeams.away?.abbreviation ?? "";

    mlbGameCache.gameState[gameId] = {
      inning,
      isTopInning,
      outs,
      runnersOnBase,
      battingOrder,
      currentBatter,
      pitcherInGame,
      pitchCount: currentPitchCount,
      timesThroughOrder,
      homeScore,
      awayScore,
      totalPlays,
      homeTeamAbbr,
      awayTeamAbbr,
      fetchedAt: Date.now(),
    };

    console.log(`[MLB pull] syncGameState: game ${gameId} — inning ${inning}${isTopInning ? "T" : "B"}, ${battingOrder.length} batters`);
  } catch (err: any) {
    console.error(`[MLB pull] syncGameState(${gameId}) error:`, err.message);
  }
}

// ── syncGameBoxScore ──────────────────────────────────────────────────────────
// Pulls per-player hitting stats from the MLB Stats API boxscore for the current game.
// Falls back to Tank01 API if MLB Stats API returns no player data.

export async function syncGameBoxScore(statsPk: string, cacheKey?: string): Promise<void> {
  const gameId = cacheKey ?? statsPk;
  try {
    const data = await fetchJson(LIVE_FEED_URL(statsPk));
    const boxTeams = data?.liveData?.boxscore?.teams ?? {};
    const gameDataTeams = data?.gameData?.teams ?? {};
    const byPlayerId: Record<string, GameBoxScorePlayer> = {};
    // Mound Radar settlement — parsed from the same already-fetched payload,
    // zero extra network calls. `p.stats.pitching` sits alongside the batting
    // block read below but was never ingested anywhere in the codebase before.
    const byPitcherId: Record<string, GamePitchingBoxScorePitcher> = {};
    const pitcherOrderByTeam: Record<string, string[]> = {};

    for (const side of ["home", "away"] as const) {
      const team = boxTeams[side];
      if (!team?.players) continue;
      const teamAbbrev: string = gameDataTeams[side]?.abbreviation ?? side;
      // `team.pitchers` is the live feed's own ordered appearance list
      // (index 0 = starter) — reused directly rather than re-derived, same
      // source already trusted elsewhere in this file (syncBullpenUsage).
      pitcherOrderByTeam[teamAbbrev] = (team.pitchers ?? []).map((id: number) => String(id));

      for (const [key, pdata] of Object.entries(team.players)) {
        const p = pdata as any;
        const pid = key.replace("ID", "");

        const batting = p?.stats?.batting;
        if (batting) {
          const hits = safeNum(batting.hits) ?? 0;
          const doubles = safeNum(batting.doubles) ?? 0;
          const triples = safeNum(batting.triples) ?? 0;
          const hr = safeNum(batting.homeRuns) ?? 0;
          const singles = hits - doubles - triples - hr;
          const tb = singles + doubles * 2 + triples * 3 + hr * 4;
          byPlayerId[pid] = {
            playerId: pid,
            playerName: p?.person?.fullName ?? pid,
            team: teamAbbrev,
            hits,
            hr,
            ab: safeNum(batting.atBats) ?? 0,
            bb: safeNum(batting.baseOnBalls) ?? 0,
            rbi: safeNum(batting.rbi) ?? 0,
            so: safeNum(batting.strikeOuts) ?? 0,
            tb,
            runs: safeNum(batting.runs) ?? 0,
          };
        }

        const pitching = p?.stats?.pitching;
        if (pitching) {
          const outsRecorded = Math.round((parseBaseballInnings(pitching.inningsPitched) ?? 0) * 3);
          byPitcherId[pid] = {
            pitcherId: pid,
            pitcherName: p?.person?.fullName ?? pid,
            team: teamAbbrev,
            strikeOuts: safeNum(pitching.strikeOuts) ?? 0,
            outsRecorded,
            baseOnBalls: safeNum(pitching.baseOnBalls) ?? 0,
            earnedRuns: safeNum(pitching.earnedRuns) ?? 0,
            hits: safeNum(pitching.hits) ?? 0,
            homeRuns: safeNum(pitching.homeRuns) ?? 0,
          };
        }
      }
    }

    mlbGameCache.gamePitchingBoxScore[gameId] = { byPitcherId, pitcherOrderByTeam, fetchedAt: Date.now() };
    // No Tank01-style fallback source exists for pitching lines (unlike batting
    // below) — surface an empty/partial parse so a transient live-feed gap is
    // observable rather than silently producing no settlement data. This is
    // self-healing: syncGameBoxScore is re-invoked on every orchestrator poll
    // while the game remains active, so a later call typically fills the gap.
    if (Object.keys(byPitcherId).length === 0 && Object.keys(byPlayerId).length > 0) {
      console.warn(`[MLB pull] syncGameBoxScore: game ${gameId} — batting present but 0 pitching entries parsed (transient live-feed gap?)`);
    }

    if (Object.keys(byPlayerId).length === 0) {
      try {
        const { fetchTank01BoxScore } = await import("./tank01Service");
        const tank01Box = await fetchTank01BoxScore(gameId);
        if (tank01Box?.players) {
          for (const p of tank01Box.players) {
            byPlayerId[p.playerId] = {
              playerId: p.playerId,
              playerName: p.playerName,
              team: p.team,
              hits: p.hits,
              hr: p.hr,
              ab: p.ab,
              bb: p.bb,
              rbi: p.rbi,
              so: p.so,
              tb: p.hits + p.hr * 3,
              runs: 0,
            };
          }
          console.log(`[MLB pull] syncGameBoxScore: game ${gameId} — Tank01 fallback provided ${tank01Box.players.length} players`);
        }
      } catch (err: any) {
        console.warn(`[MLB pull] syncGameBoxScore Tank01 fallback error:`, err.message);
      }
    }

    mlbGameCache.gameBoxScore[gameId] = { byPlayerId, fetchedAt: Date.now() };
    console.log(`[MLB pull] syncGameBoxScore: game ${gameId} — ${Object.keys(byPlayerId).length} players with box stats`);
  } catch (err: any) {
    console.error(`[MLB pull] syncGameBoxScore(${gameId}) error:`, err.message);
  }
}

/**
 * Read-only accessor for a team's live pitcher-appearance order (see
 * GamePitchingBoxScoreCache.pitcherOrderByTeam). Returns null when the box
 * score hasn't been synced for this game yet — callers treat that as "can't
 * tell, assume not exited" rather than an error.
 */
export function getPitcherAppearanceOrder(gameId: string, team: string): string[] | null {
  return mlbGameCache.gamePitchingBoxScore[gameId]?.pitcherOrderByTeam?.[team] ?? null;
}

// ── syncContactData ───────────────────────────────────────────────────────────
// Uses MLB Stats API live feed (already fetched for game state) to extract
// Statcast hitData from play-by-play events. Replaces the broken Savant /gf endpoint.

export type ContactChangeEvent = {
  playerId: string;
  playerName: string;
  newABCount: number;
  prevABCount: number;
  latestAB: { exitVelocity: number | null; launchAngle: number | null; distance: number | null; outcome: string } | null;
};

export async function syncContactData(statsPk: string, cacheKey?: string): Promise<ContactChangeEvent[]> {
  const gameId = cacheKey ?? statsPk;
  const persistedContactKeys = new Set<string>();
  const contactChanges: ContactChangeEvent[] = [];

  try {
    const data = await fetchJson(LIVE_FEED_URL(statsPk));
    const liveData = data.liveData ?? {};
    const allPlays: any[] = liveData.plays?.allPlays ?? [];

    const byPlayerId: Record<string, PlayerContactData> = {};
    const hrPlaysOut: HRPlayMeta[] = [];

    for (const play of allPlays) {
      const batterId = play.matchup?.batter?.id;
      if (!batterId) continue;
      const playerId = String(batterId);
      const batterName: string = play.matchup?.batter?.fullName ?? playerId;

      // Extract HR plays (canonical inning attribution from the play feed itself)
      const eventTypeRaw: string = (play.result?.eventType ?? "").toString().toLowerCase();
      const eventNameRaw: string = (play.result?.event ?? "").toString().toLowerCase();
      const isHomeRunPlay = eventTypeRaw === "home_run" || eventNameRaw === "home run";
      if (isHomeRunPlay) {
        const aboutInning = Number(play.about?.inning);
        const aboutHalf = (play.about?.halfInning ?? "").toString().toLowerCase();
        const halfNorm: "top" | "bottom" | null =
          aboutHalf === "top" ? "top" : aboutHalf === "bottom" ? "bottom" : null;
        if (Number.isFinite(aboutInning) && aboutInning > 0 && halfNorm) {
          const endTimeStr: string | null = play.about?.endTime ?? null;
          const endTimeMs = endTimeStr ? Date.parse(endTimeStr) || null : null;
          const teamSide: string = halfNorm === "top"
            ? (data.gameData?.teams?.away?.abbreviation ?? "")
            : (data.gameData?.teams?.home?.abbreviation ?? "");
          hrPlaysOut.push({
            playerId,
            playerName: batterName,
            team: teamSide,
            inning: aboutInning,
            halfInning: halfNorm,
            atBatIndex: Number(play.about?.atBatIndex ?? 0) || 0,
            endTimeMs,
            eventType: eventTypeRaw || eventNameRaw,
            isComplete: play.about?.isComplete === true,
          });
        }
      }

      if (!byPlayerId[playerId]) {
        byPlayerId[playerId] = {
          exitVelocity: null,
          launchAngle: null,
          hitDistance: null,
          latestExitVelocity: null,
          latestLaunchAngle: null,
          hardHitPct: null,
          barrelPct: null,
          avgBatSpeed: null,
          avgSwingLength: null,
          xBA: null,
          xSLG: null,
          gameAvgXBA: null,
          gameMaxXBA: null,
          gameBarrelCount: 0,
          gameContactQuality: 0,
          priorABResults: [],
          flyBallPercent: null,
          hrFBRatio: null,
          xwOBASeason: null,
          xISOSeason: null,
          sweetSpotPercent: null,
          pullRatePercent: null,
        };
      }

      const events: any[] = play.playEvents ?? [];
      const resultEvent = play.result?.event ?? play.result?.description ?? "";
      const outcome = inferOutcome(resultEvent);
      const hitType = inferHitType(resultEvent);
      const rbi = safeNum(play.result?.rbi) ?? 0;
      // Did the batter himself score on this play (i.e. crossed home plate)?
      // For a HR they always score; for everything else we read the play's
      // runners array. Used to compute play-feed runs for the hrr market.
      let runScored = false;
      if (hitType === "home_run") {
        runScored = true;
      } else {
        const runners: any[] = play.runners ?? [];
        for (const r of runners) {
          if (
            r?.details?.runner?.id === batterId &&
            r?.movement?.end === "score"
          ) {
            runScored = true;
            break;
          }
        }
      }

      let bestEV: number | null = null;
      let bestLA: number | null = null;
      let bestDist: number | null = null;
      let lastPitchType: string | null = null;
      let lastPitchSpeed: number | null = null;

      for (const evt of events) {
        if (evt.isPitch) {
          lastPitchType = evt.details?.type?.description ?? evt.details?.type?.code ?? null;
          lastPitchSpeed = safeNum(evt.pitchData?.startSpeed) ?? null;
        }

        const hitData = evt.hitData;
        if (hitData) {
          const ev = safeNum(hitData.launchSpeed);
          const la = safeNum(hitData.launchAngle);
          const dist = safeNum(hitData.totalDistance);

          if (ev !== null) {
            if (bestEV === null || ev > bestEV) {
              bestEV = ev;
              bestLA = la;
              bestDist = dist;
            }

            if (byPlayerId[playerId].exitVelocity === null || ev > (byPlayerId[playerId].exitVelocity ?? 0)) {
              byPlayerId[playerId].exitVelocity = ev;
              byPlayerId[playerId].launchAngle = la;
              byPlayerId[playerId].hitDistance = dist;
            }
          }
        }
      }

      if (bestEV !== null || outcome !== "other") {
        if (bestEV !== null) {
          byPlayerId[playerId].latestExitVelocity = bestEV;
          byPlayerId[playerId].latestLaunchAngle = bestLA;
        }

        const contactClass = classifyContact(bestEV, bestLA);
        const abAboutInning = Number(play.about?.inning);
        const abAboutHalf = (play.about?.halfInning ?? "").toString().toLowerCase();
        byPlayerId[playerId].priorABResults.push({
          exitVelocity: bestEV,
          launchAngle: bestLA,
          distance: bestDist,
          outcome,
          pitchType: lastPitchType,
          pitchSpeed: lastPitchSpeed,
          isBarrel: contactClass.isBarrel,
          perABxBA: bestEV != null ? contactClass.xBA : null,
          contactGrade: contactClass.contactGrade,
          hrProbability: contactClass.hrProbability,
          hitType,
          rbi,
          runScored,
          inning: Number.isFinite(abAboutInning) && abAboutInning > 0 ? abAboutInning : null,
          half: abAboutHalf === "top" ? "top" : abAboutHalf === "bottom" ? "bottom" : null,
        });

        const abIndex = byPlayerId[playerId].priorABResults.length;
        const fingerprint = `${statsPk}:${playerId}:${abIndex}:${bestEV ?? 0}:${bestLA ?? 0}`;
        if (!persistedContactKeys.has(fingerprint) && bestEV != null) {
          persistedContactKeys.add(fingerprint);
          const isBarrel = isCanonicalBarrel(bestEV ?? null, bestLA ?? null);
          storage.insertContactEvent({
            playerId,
            playerName: batterName,
            gameId: String(statsPk),
            exitVelocity: bestEV,
            launchAngle: bestLA,
            distance: bestDist,
            result: outcome,
            pitchType: lastPitchType,
            pitchSpeed: lastPitchSpeed,
            isBarrel,
            eventFingerprint: fingerprint,
          }).catch(() => {});
        }
      }
    }

    const allEVs: number[] = [];
    for (const entry of Object.values(byPlayerId)) {
      for (const ab of entry.priorABResults) {
        if (ab.exitVelocity != null) allEVs.push(ab.exitVelocity);
      }
    }
    if (allEVs.length > 0) {
      const hardHitPct = parseFloat(((allEVs.filter((v) => v >= 95).length / allEVs.length) * 100).toFixed(1));
      const barrelPct = parseFloat(((allEVs.filter((v) => v >= 98).length / allEVs.length) * 100).toFixed(1));
      for (const entry of Object.values(byPlayerId)) {
        if (entry.hardHitPct === null) entry.hardHitPct = hardHitPct;
        if (entry.barrelPct === null) entry.barrelPct = barrelPct;
      }
    }

    for (const entry of Object.values(byPlayerId)) {
      const contacts = entry.priorABResults
        .filter(ab => ab.exitVelocity != null)
        .map(ab => ({ exitVelocity: ab.exitVelocity, launchAngle: ab.launchAngle }));
      if (contacts.length > 0) {
        const profile = computeGameContactProfile(contacts);
        entry.gameAvgXBA = profile.avgXBA;
        entry.gameMaxXBA = profile.maxXBA;
        entry.gameBarrelCount = profile.barrelCount;
        entry.gameContactQuality = profile.contactQualityScore;
      }
    }

    const existing = mlbGameCache.contactData[gameId]?.byPlayerId ?? {};

    for (const [pid, freshEntry] of Object.entries(byPlayerId)) {
      const prev = existing[pid];
      if (prev) {
        if (freshEntry.xBA === null && prev.xBA != null) freshEntry.xBA = prev.xBA;
        if (freshEntry.xSLG === null && prev.xSLG != null) freshEntry.xSLG = prev.xSLG;
        if (freshEntry.exitVelocity === null && prev.exitVelocity != null) freshEntry.exitVelocity = prev.exitVelocity;
        if (freshEntry.hardHitPct === null && prev.hardHitPct != null) freshEntry.hardHitPct = prev.hardHitPct;
        if (freshEntry.barrelPct === null && prev.barrelPct != null) freshEntry.barrelPct = prev.barrelPct;
        if (freshEntry.avgBatSpeed === null && prev.avgBatSpeed != null) freshEntry.avgBatSpeed = prev.avgBatSpeed;
        if (freshEntry.avgSwingLength === null && prev.avgSwingLength != null) freshEntry.avgSwingLength = prev.avgSwingLength;
      }
    }

    for (const [pid, prev] of Object.entries(existing)) {
      if (!byPlayerId[pid]) {
        byPlayerId[pid] = prev;
      }
    }

    const playerIds = Object.keys(byPlayerId);
    const needsSavant = playerIds.filter((pid) => {
      const e = byPlayerId[pid];
      if (!e) return false;
      return (e.xBA === null && e.xSLG === null) ||
             (e.avgBatSpeed === null && e.barrelPct === null && e.hardHitPct === null);
    });
    if (needsSavant.length > 0) {
      const savantResults = await Promise.allSettled(
        needsSavant.map((pid) => fetchBaseballSavantData(pid, gameId))
      );
      for (let i = 0; i < needsSavant.length; i++) {
        const result = savantResults[i];
        if (result.status === "fulfilled" && result.value) {
          const entry = byPlayerId[needsSavant[i]];
          if (entry) {
            if (entry.xBA === null && result.value.xBA != null) entry.xBA = result.value.xBA;
            if (entry.xSLG === null && result.value.xSLG != null) entry.xSLG = result.value.xSLG;
            if (entry.exitVelocity === null && result.value.exitVelocity != null) entry.exitVelocity = result.value.exitVelocity;
            if (entry.hardHitPct === null && result.value.hardHitRateSeason != null) entry.hardHitPct = result.value.hardHitRateSeason;
            if (entry.barrelPct === null && result.value.barrelRateProxySeason != null) entry.barrelPct = result.value.barrelRateProxySeason;
            if (entry.avgBatSpeed === null && result.value.avgBatSpeed != null) entry.avgBatSpeed = result.value.avgBatSpeed;
            if (entry.avgSwingLength === null && result.value.avgSwingLength != null) entry.avgSwingLength = result.value.avgSwingLength;
          }
        }
      }
      const enrichedCount = playerIds.filter((pid) => byPlayerId[pid]?.xBA != null || byPlayerId[pid]?.xSLG != null).length;
      console.log(`[MLB pull] syncContactData Savant enrichment: game ${gameId} — ${enrichedCount}/${playerIds.length} players with xBA/xSLG`);
    }

    try {
      const savantPitches = await fetchSavantGameFeed(statsPk);
      if (savantPitches.length > 0) {
        const byBatter = new Map<string, Array<{ xBA: number | null; xWOBA: number | null; ev: number | null; la: number | null }>>();
        for (const p of savantPitches) {
          if (!p.batterId) continue;
          if (!byBatter.has(p.batterId)) byBatter.set(p.batterId, []);
          if (p.exitVelocity != null) {
            byBatter.get(p.batterId)!.push({ xBA: p.xBA, xWOBA: p.xWOBA, ev: p.exitVelocity, la: p.launchAngle });
          }
        }
        let enrichCount = 0;
        byBatter.forEach((hits, batterId) => {
          const entry = byPlayerId[batterId];
          if (!entry || hits.length === 0) return;
          const officialXBAs = hits.filter((h: any) => h.xBA != null).map((h: any) => h.xBA as number);
          if (officialXBAs.length > 0) {
            const avgOfficialXBA = Math.round((officialXBAs.reduce((a: number, b: number) => a + b, 0) / officialXBAs.length) * 1000) / 1000;
            const maxOfficialXBA = Math.max(...officialXBAs);
            entry.gameAvgXBA = avgOfficialXBA;
            entry.gameMaxXBA = maxOfficialXBA;
            enrichCount++;
          }
          const usedSavantIdx = new Set<number>();
          for (const ab of entry.priorABResults) {
            if (ab.exitVelocity == null) continue;
            let bestIdx = -1;
            let bestDist = Infinity;
            for (let j = 0; j < hits.length; j++) {
              if (usedSavantIdx.has(j)) continue;
              if (hits[j].ev == null || hits[j].xBA == null) continue;
              const evDiff = Math.abs((hits[j].ev as number) - ab.exitVelocity);
              const laDiff = Math.abs((hits[j].la ?? 0) - (ab.launchAngle ?? 0));
              const dist = evDiff + laDiff * 0.5;
              if (dist < bestDist && evDiff < 3) {
                bestDist = dist;
                bestIdx = j;
              }
            }
            if (bestIdx >= 0) {
              ab.perABxBA = hits[bestIdx].xBA;
              (ab as any).perABxWOBA = hits[bestIdx].xWOBA;
              usedSavantIdx.add(bestIdx);
            }
          }
        });
        if (enrichCount > 0) {
          console.log(`[MLB pull] Savant GameFeed enrichment: game ${gameId} — ${enrichCount} batters with official per-pitch xBA`);
        }
      }
    } catch (err: any) {
      console.warn(`[MLB pull] Savant GameFeed enrichment error: ${err.message}`);
    }

    for (const [pid, freshEntry] of Object.entries(byPlayerId)) {
      const prev = existing[pid];
      const prevABCount = prev?.priorABResults?.length ?? 0;
      const newABCount = freshEntry.priorABResults?.length ?? 0;
      if (newABCount > prevABCount) {
        const latestAB = freshEntry.priorABResults[newABCount - 1] ?? null;
        const playerName = allPlays.find((p: any) => String(p.matchup?.batter?.id) === pid)?.matchup?.batter?.fullName ?? pid;
        contactChanges.push({
          playerId: pid,
          playerName,
          newABCount,
          prevABCount,
          latestAB: latestAB ? {
            exitVelocity: latestAB.exitVelocity ?? null,
            launchAngle: latestAB.launchAngle ?? null,
            distance: latestAB.distance ?? null,
            outcome: latestAB.outcome ?? "out",
          } : null,
        });
      }
    }

    mlbGameCache.contactData[gameId] = { byPlayerId, fetchedAt: Date.now() };
    mlbGameCache.hrPlays[gameId] = { plays: hrPlaysOut, fetchedAt: Date.now() };
    if (contactChanges.length > 0) {
      console.log(`[MLB pull] syncContactData: game ${gameId} — ${Object.keys(byPlayerId).length} players, ${allEVs.length} BIP — ${contactChanges.length} new contact events: ${contactChanges.map(c => `${c.playerName}(EV=${c.latestAB?.exitVelocity ?? "?"})`).join(", ")}`);
    } else {
      console.log(`[MLB pull] syncContactData: game ${gameId} — ${Object.keys(byPlayerId).length} players, ${allEVs.length} BIP with hitData`);
    }
  } catch (err: any) {
    console.error(`[MLB pull] syncContactData(${gameId}) error:`, err.message);
  }
  return contactChanges;
}

// ── syncPitcherContext ────────────────────────────────────────────────────────

export async function syncPitcherContext(statsPk: string, cacheKey?: string): Promise<void> {
  const gameId = cacheKey ?? statsPk;
  try {
    const data = await fetchJson(LIVE_FEED_URL(statsPk));
    const liveData = data.liveData ?? {};
    const boxTeams = liveData.boxscore?.teams ?? {};
    const allPlays = liveData.plays?.allPlays ?? [];

    const byPitcherId: Record<string, PitcherContextEntry> = {};

    for (const side of ["home", "away"] as const) {
      const team = boxTeams[side] ?? {};
      const pitcherIds: number[] = team.pitchers ?? [];

      for (const pid of pitcherIds) {
        const key = `ID${pid}`;
        const playerBox = team.players?.[key];
        if (!playerBox) continue;

        const pitchStats = playerBox.stats?.pitching ?? {};
        const pitchCount: number = safeNum(pitchStats.numberOfPitches) ?? 0;
        const timesThroughOrder: number = safeNum(pitchStats.battersFaced) != null
          ? Math.min(3, Math.ceil((pitchStats.battersFaced ?? 0) / 9) || 1)
          : 1;

        // Build pitch mix from play events for this pitcher (canonical-coded)
        const pitchMixMap: Record<string, { count: number; totalVelocity: number; descriptions: Record<string, number> }> = {};
        let pitchVelocities: number[] = [];

        for (const play of allPlays) {
          if (String(play.matchup?.pitcher?.id) !== String(pid)) continue;
          for (const event of play.playEvents ?? []) {
            if (event.type !== "pitch") continue;
            const rawDesc: string = event.details?.type?.description ?? event.details?.type?.code ?? "Unknown";
            const code = normalizePitchTypeCode(rawDesc);
            const vel: number | null = safeNum(event.pitchData?.startSpeed);
            if (!pitchMixMap[code]) pitchMixMap[code] = { count: 0, totalVelocity: 0, descriptions: {} };
            pitchMixMap[code].count += 1;
            pitchMixMap[code].descriptions[rawDesc] = (pitchMixMap[code].descriptions[rawDesc] ?? 0) + 1;
            if (vel !== null) {
              pitchMixMap[code].totalVelocity += vel;
              pitchVelocities.push(vel);
            }
          }
        }

        const totalPitches = Object.values(pitchMixMap).reduce((s, v) => s + v.count, 0);
        const pitchMix: PitchMixEntry[] = Object.entries(pitchMixMap).map(([pitchType, v]) => {
          const topDesc = Object.entries(v.descriptions).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
          return {
            pitchType,
            pitchName: topDesc,
            percentage: totalPitches > 0 ? parseFloat(((v.count / totalPitches) * 100).toFixed(1)) : 0,
            avgVelocity: v.count > 0 ? parseFloat((v.totalVelocity / v.count).toFixed(1)) : null,
          };
        });

        const avgVelocity: number | null =
          pitchVelocities.length > 0
            ? parseFloat((pitchVelocities.reduce((a, b) => a + b, 0) / pitchVelocities.length).toFixed(1))
            : null;

        // Velocity drop: compare first half vs second half of pitches seen
        let velocityDrop: number | null = null;
        if (pitchVelocities.length >= 10) {
          const mid = Math.floor(pitchVelocities.length / 2);
          const firstHalfAvg = pitchVelocities.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
          const secondHalfAvg = pitchVelocities.slice(mid).reduce((a, b) => a + b, 0) / (pitchVelocities.length - mid);
          velocityDrop = parseFloat((firstHalfAvg - secondHalfAvg).toFixed(2));
        }

        // Lane 3.3 — recent velocity TREND: avg(last 5) − avg(prior 5). A
        // fresher decline signal than the whole-game first/second-half split:
        // a pitcher stably down all game vs one losing velo right now.
        let recentVeloTrend: number | null = null;
        if (pitchVelocities.length >= 10) {
          const last5 = pitchVelocities.slice(-5);
          const prior5 = pitchVelocities.slice(-10, -5);
          const last5Avg = last5.reduce((a, b) => a + b, 0) / last5.length;
          const prior5Avg = prior5.reduce((a, b) => a + b, 0) / prior5.length;
          recentVeloTrend = parseFloat((last5Avg - prior5Avg).toFixed(2));
        }

        const entryFatigue = await fetchPitcherRecentStarts(String(pid));

        // Season fastball spin from Savant pitcher CSV — 4h cached, no extra network cost per tick.
        let avgFastballSpin: number | null = null;
        try {
          const savant = await fetchBaseballSavantData(String(pid), gameId);
          avgFastballSpin = savant.avgFastballSpin ?? null;
        } catch {
          // Non-fatal; scoring falls back to no spin adjustment
        }

        byPitcherId[String(pid)] = {
          pitchMix,
          avgVelocity,
          pitchCount,
          timesThroughOrder,
          velocityDrop,
          recentVeloTrend,
          seasonAvgVelocity: null,
          avgFastballSpin,
          lastStartPitchCount: entryFatigue.lastStartPitchCount,
          daysSinceLastStart: entryFatigue.daysSinceLastStart,
          last3StartERA: entryFatigue.last3StartERA,
        };
      }
    }

    mlbGameCache.pitcherContext[gameId] = { byPitcherId, fetchedAt: Date.now() };
    console.log(`[MLB pull] syncPitcherContext: game ${gameId} — ${Object.keys(byPitcherId).length} pitchers`);
  } catch (err: any) {
    console.error(`[MLB pull] syncPitcherContext(${gameId}) error:`, err.message);
  }
}

// ── fetchPitcherRecentStarts ──────────────────────────────────────────────────
// Gap 3: fetch last 3 starts for a pitcher to derive pre-game fatigue context.
// Returns null fields on any failure so callers are never blocked. Exported
// (in addition to the live pitcherContext consumer below) so the Mound Radar
// can read the same recent-start data for Recent K Form / Recent IP Stability
// / Blow-Up Risk — a generic data-source read, not shared scoring logic.
export async function fetchPitcherRecentStarts(pitcherId: string): Promise<{
  lastStartPitchCount: number | null;
  daysSinceLastStart: number | null;
  last3StartERA: number | null;
  /** Mound Radar input — last 3 starts' K counts, most recent first. */
  last3StartStrikeouts: number[] | null;
  /** Mound Radar input — last 3 starts' innings pitched, most recent first. */
  last3StartInningsPitched: number[] | null;
  /** Mound Radar input — stddev of last-3-start IP (lower = more stable workload). */
  ipVarianceLast3: number | null;
}> {
  const empty = {
    lastStartPitchCount: null, daysSinceLastStart: null, last3StartERA: null,
    last3StartStrikeouts: null, last3StartInningsPitched: null, ipVarianceLast3: null,
  };
  try {
    const currentYear = new Date().getFullYear();
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=${currentYear}&group=pitching`;
    const data = await fetchJson(url);
    const splits: any[] = data.stats?.[0]?.splits ?? [];
    if (splits.length === 0) return empty;

    // Most recent first
    const starts = splits
      .filter((s: any) => (safeNum(s.stat?.inningsPitched) ?? 0) >= 1)
      .slice(-10)
      .reverse();

    if (starts.length === 0) return empty;

    const last = starts[0];
    const lastStartPitchCount = safeNum(last.stat?.numberOfPitches) ?? null;
    const lastDateStr: string | null = last.date ?? null;
    let daysSinceLastStart: number | null = null;
    if (lastDateStr) {
      const lastDate = new Date(lastDateStr);
      daysSinceLastStart = Math.round((Date.now() - lastDate.getTime()) / 86400000);
    }

    const recent3 = starts.slice(0, 3);
    let totalER = 0, totalIP = 0;
    const ipValues: number[] = [];
    const kValues: number[] = [];
    for (const s of recent3) {
      totalER += safeNum(s.stat?.earnedRuns) ?? 0;
      const ip = parseBaseballInnings(s.stat?.inningsPitched) ?? 0;
      totalIP += ip;
      ipValues.push(ip);
      kValues.push(safeNum(s.stat?.strikeOuts) ?? 0);
    }
    const last3StartERA = totalIP > 0 ? parseFloat(((totalER / totalIP) * 9).toFixed(2)) : null;

    let ipVarianceLast3: number | null = null;
    if (ipValues.length >= 2) {
      const mean = ipValues.reduce((a, b) => a + b, 0) / ipValues.length;
      const variance = ipValues.reduce((a, b) => a + (b - mean) ** 2, 0) / ipValues.length;
      ipVarianceLast3 = parseFloat(Math.sqrt(variance).toFixed(2));
    }

    return {
      lastStartPitchCount, daysSinceLastStart, last3StartERA,
      last3StartStrikeouts: kValues.length > 0 ? kValues : null,
      last3StartInningsPitched: ipValues.length > 0 ? ipValues : null,
      ipVarianceLast3,
    };
  } catch {
    return empty;
  }
}

// ── fetchPitcherHandednessSplits ──────────────────────────────────────────────
// Gap 4: pitcher ERA and HR rate split by opposing batter handedness.
// MLB Stats API: stats=statSplits&sitCodes=vl,vr returns separate rows for
// "vs Left" (code vl) and "vs Right" (code vr) handed batters. NOTE: the prior
// `stats=byHand` value is NOT a valid statType and the API returned an empty
// `stats` array, so every pitcher came back with null splits — which capped the
// Pre-Game Power Radar at 5.9 and suppressed the entire slate. Cached 24h —
// season-level stats don't change intraday.

const pitcherSplitsCache = new Map<string, { data: PitcherHandednessSplits; fetchedAt: number }>();
const batterSplitsCache = new Map<string, { data: BatterHandednessSplits; fetchedAt: number }>();
const SPLITS_TTL = 24 * 60 * 60 * 1000;

/**
 * Additive widening of PitcherHandednessSplits with K-rate-by-hand for the
 * Mound Radar's "Platoon K Advantage" driver. Declared locally (not added to
 * the shared server/mlb/types.ts interface) so the live engine's type stays
 * untouched — all existing callers of fetchPitcherHandednessSplits keep
 * working unchanged since these are additive fields on the same fetch.
 */
export interface PitcherKHandSplits extends PitcherHandednessSplits {
  kRateVsLHB: number | null;
  kRateVsRHB: number | null;
}

export async function fetchPitcherHandednessSplits(pitcherId: string): Promise<PitcherKHandSplits | null> {
  const empty: PitcherKHandSplits = {
    eraVsLHB: null, eraVsRHB: null, hrPer9VsLHB: null, hrPer9VsRHB: null,
    kRateVsLHB: null, kRateVsRHB: null,
  };
  if (!pitcherId) return null;
  const cached = pitcherSplitsCache.get(pitcherId);
  if (cached && Date.now() - cached.fetchedAt < SPLITS_TTL) return cached.data as PitcherKHandSplits;
  try {
    const currentYear = new Date().getFullYear();
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=statSplits&sitCodes=vl,vr&group=pitching&season=${currentYear}&gameType=R`;
    const data = await fetchJson(url);
    const splits: any[] = data.stats?.[0]?.splits ?? [];
    const result = { ...empty };
    for (const s of splits) {
      const code: string = (s.split?.code ?? "").toLowerCase();
      const desc: string = (s.split?.description ?? "").toLowerCase();
      const stat = s.stat ?? {};
      const era = safeNum(stat.era);
      const hr = safeNum(stat.homeRuns);
      const ip = parseBaseballInnings(stat.inningsPitched);
      const hrPer9 = ip != null && ip > 0 && hr != null ? parseFloat(((hr / ip) * 9).toFixed(2)) : null;
      const battersFaced = safeNum(stat.battersFaced);
      const so = safeNum(stat.strikeOuts);
      const kRate = battersFaced != null && battersFaced > 0 && so != null
        ? parseFloat((so / battersFaced).toFixed(3))
        : null;
      const isLeft = code === "vl" || desc.includes("left");
      const isRight = code === "vr" || desc.includes("right");
      if (isLeft) { result.eraVsLHB = era; result.hrPer9VsLHB = hrPer9; result.kRateVsLHB = kRate; }
      else if (isRight) { result.eraVsRHB = era; result.hrPer9VsRHB = hrPer9; result.kRateVsRHB = kRate; }
    }
    pitcherSplitsCache.set(pitcherId, { data: result, fetchedAt: Date.now() });
    console.log(`[HR_RADAR_SPLITS] pitcher=${pitcherId} eraVsLHB=${result.eraVsLHB} eraVsRHB=${result.eraVsRHB} hrPer9VsLHB=${result.hrPer9VsLHB} hrPer9VsRHB=${result.hrPer9VsRHB}`);
    return result;
  } catch {
    return null;
  }
}

export async function fetchBatterHandednessSplits(batterId: string): Promise<BatterHandednessSplits | null> {
  const empty: BatterHandednessSplits = { hrRateVsLHP: null, hrRateVsRHP: null, opsVsLHP: null, opsVsRHP: null };
  if (!batterId) return null;
  const cached = batterSplitsCache.get(batterId);
  if (cached && Date.now() - cached.fetchedAt < SPLITS_TTL) return cached.data;
  try {
    const currentYear = new Date().getFullYear();
    const url = `https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=statSplits&sitCodes=vl,vr&group=hitting&season=${currentYear}&gameType=R`;
    const data = await fetchJson(url);
    const splits: any[] = data.stats?.[0]?.splits ?? [];
    const result = { ...empty };
    for (const s of splits) {
      const code: string = (s.split?.code ?? "").toLowerCase();
      const desc: string = (s.split?.description ?? "").toLowerCase();
      const stat = s.stat ?? {};
      const ab = safeNum(stat.atBats) ?? 0;
      const hr = safeNum(stat.homeRuns) ?? 0;
      const hrRate = ab >= 30 ? parseFloat((hr / ab).toFixed(4)) : null;
      const ops = safeNum(stat.ops);
      const isLeft = code === "vl" || desc.includes("left");
      const isRight = code === "vr" || desc.includes("right");
      if (isLeft) { result.hrRateVsLHP = hrRate; result.opsVsLHP = ops; }
      else if (isRight) { result.hrRateVsRHP = hrRate; result.opsVsRHP = ops; }
    }
    batterSplitsCache.set(batterId, { data: result, fetchedAt: Date.now() });
    return result;
  } catch {
    return null;
  }
}

/**
 * Recent per-AB contact events for a batch of batters, since `sinceUtc`.
 * Thin read wrapper over storage — kept here (rather than imported directly
 * into pregamePowerRadar/buildPregamePowerRadar.ts) so that module stays free
 * of storage imports, matching its existing sink-callback persistence
 * convention. Never throws.
 */
export async function fetchRecentContactEventsForBatters(
  playerIds: string[],
  sinceUtc: Date,
): Promise<Array<{
  playerId: string;
  exitVelocity: number | null;
  launchAngle: number | null;
  distance: number | null;
  isBarrel: boolean;
  result: string | null;
  timestamp: Date;
}>> {
  if (playerIds.length === 0) return [];
  try {
    return await storage.getRecentContactEventsForPlayers(playerIds, sinceUtc);
  } catch {
    return [];
  }
}

// ── syncWeather ───────────────────────────────────────────────────────────────

export async function syncWeather(statsPk: string, cacheKey?: string): Promise<void> {
  const gameId = cacheKey ?? statsPk;
  try {
    const data = await fetchJson(LIVE_FEED_URL(statsPk));
    const weather = data.gameData?.weather ?? {};
    const venue = data.gameData?.venue ?? {};

    const temperature: number | null = safeNum(weather.temp);
    // Preserve the raw MLB feed wind text (e.g. "12 mph, Out To LF") — it states
    // the outfield sector explicitly, the high-confidence source for the shared
    // park/wind fit's directional (LF/RF) mapping.
    const windRaw: string | null = weather.wind ?? null;
    const windSpeed: number | null = (() => {
      const match = (windRaw ?? "").match(/(\d+(?:\.\d+)?)/);
      return match ? parseFloat(match[1]) : null;
    })();
    const windDirection = normalizeWindDirection(weather.wind);
    const humidity: number | null = safeNum(weather.condition === "Roof Closed" ? 50 : null);

    const venueName: string | null = venue.name ?? null;
    const isIndoors = (venue.fieldInfo?.roofType ?? "").toLowerCase().includes("retractable")
      || (data.gameData?.weather?.condition ?? "").toLowerCase().includes("roof closed");

    const existing = mlbGameCache.weather[gameId];
    const resolvedWindDir = windDirection ?? "cross";
    const gameStartWindDir = existing?.gameStartWindDirection ?? resolvedWindDir;
    const windShiftDetected = gameStartWindDir !== resolvedWindDir && gameStartWindDir !== "calm" && resolvedWindDir !== "calm";

    mlbGameCache.weather[gameId] = {
      temperature: temperature ?? null,
      windSpeed: windSpeed ?? null,
      windDirection: resolvedWindDir,
      humidity: humidity,
      fetchedAt: Date.now(),
      venueName,
      isIndoors,
      windString: windRaw,
      windDegrees: existing?.windDegrees ?? null,
      hourlyForecast: existing?.hourlyForecast,
      gameStartWindDirection: gameStartWindDir,
      windShiftDetected,
    };

    if (windShiftDetected && !existing?.windShiftDetected) {
      console.log(`[MLB_WEATHER_WIND_SHIFT] game=${gameId} — wind shifted from ${gameStartWindDir} to ${resolvedWindDir} (live feed)`);
    }
    console.log(`[MLB pull] syncWeather: game ${gameId} — ${temperature}°F, wind ${windSpeed}mph ${windDirection ?? "unknown"} venue="${venueName}"${isIndoors ? " (indoors)" : ""}${windShiftDetected ? " WIND_SHIFT" : ""}`);
  } catch (err: any) {
    console.error(`[MLB pull] syncWeather(${gameId}) error:`, err.message);
  }
}

// ── syncBullpenUsage ──────────────────────────────────────────────────────────
// Extracts current-game bullpen usage from live feed boxscore.
// Also fetches prior 3-day appearances from the MLB Stats API schedule endpoint
// to compute a bullpen fatigue score for the active relievers.

const BULLPEN_3DAY_TTL = 10 * 60 * 1000; // 10 min cache for schedule lookups

async function fetchTeamRelieverUsageLastThreeDays(
  teamId: string | number,
  gameDate: string
): Promise<number | null> {
  try {
    const date = new Date(gameDate);
    const pastDates: string[] = [];
    for (let d = 3; d >= 1; d--) {
      const past = new Date(date);
      past.setDate(date.getDate() - d);
      pastDates.push(past.toISOString().slice(0, 10));
    }

    let totalPitchCount = 0;
    let foundAny = false;

    for (const d of pastDates) {
      const url = `https://statsapi.mlb.com/api/v1/schedule?teamId=${teamId}&date=${d}&hydrate=boxscore&sportId=1`;
      try {
        const data = await fetchJson(url);
        const games = data.dates?.[0]?.games ?? [];
        for (const game of games) {
          const boxscore = game.teams;
          if (!boxscore) continue;
          for (const side of ["home", "away"]) {
            if (String(boxscore[side]?.team?.id) !== String(teamId)) continue;
            const pitchers: number[] = boxscore[side]?.pitchers ?? [];
            const relieverIds = pitchers.slice(1); // skip starter
            for (const pid of relieverIds) {
              const playerBox = boxscore[side]?.players?.[`ID${pid}`];
              if (!playerBox) continue;
              const pitches = safeNum(playerBox.stats?.pitching?.numberOfPitches) ?? 0;
              totalPitchCount += pitches;
              if (pitches > 0) foundAny = true;
            }
          }
        }
      } catch {
        // Skip individual date failures
      }
    }

    return foundAny ? totalPitchCount : null;
  } catch (err: any) {
    console.warn(`[MLB pull] fetchTeamRelieverUsageLastThreeDays error:`, err.message);
    return null;
  }
}

export async function syncBullpenUsage(statsPk: string, cacheKey?: string): Promise<void> {
  const gameId = cacheKey ?? statsPk;
  try {
    const data = await fetchJson(LIVE_FEED_URL(statsPk));
    const liveData = data.liveData ?? {};
    const boxTeams = liveData.boxscore?.teams ?? {};
    const gameDate: string = data.gameData?.datetime?.officialDate
      ?? todayET();

    const relieversUsed: BullpenCache["relieversUsed"] = [];
    let bullpenEra: number | null = null;
    const eraValues: number[] = [];
    const teamIds: string[] = [];

    for (const side of ["home", "away"] as const) {
      const team = boxTeams[side] ?? {};
      const pitcherIds: number[] = team.pitchers ?? [];
      const teamId = String(data.gameData?.teams?.[side]?.id ?? "");
      if (teamId) teamIds.push(teamId);

      // Skip the first pitcher (starter) — rest are relievers
      const relieverIds = pitcherIds.slice(1);

      for (const pid of relieverIds) {
        const key = `ID${pid}`;
        const playerBox = team.players?.[key];
        if (!playerBox) continue;

        const pitchCount: number = safeNum(playerBox.stats?.pitching?.numberOfPitches) ?? 0;
        const playerName: string = playerBox.person?.fullName ?? "";
        const era = safeNum(playerBox.seasonStats?.pitching?.era);

        relieversUsed.push({ playerId: String(pid), playerName, pitchCount });
        if (era !== null) eraValues.push(era);
      }
    }

    if (eraValues.length > 0) {
      bullpenEra = parseFloat((eraValues.reduce((a, b) => a + b, 0) / eraValues.length).toFixed(2));
    }

    // Fetch prior 3-day pitch counts for each team's bullpen
    let bullpenUsageLastThreeDays: number | null = null;
    if (teamIds.length > 0) {
      const usageCounts = await Promise.all(
        teamIds.map((tid) => fetchTeamRelieverUsageLastThreeDays(tid, gameDate))
      );
      const validCounts = usageCounts.filter((c): c is number => c != null);
      if (validCounts.length > 0) {
        bullpenUsageLastThreeDays = Math.round(
          validCounts.reduce((a, b) => a + b, 0) / validCounts.length
        );
      }
    }

    mlbGameCache.bullpen[gameId] = {
      bullpenEra,
      bullpenUsageLastThreeDays,
      isTopRelieverAvailable: relieversUsed.length < 3,
      relieversUsed,
      fetchedAt: Date.now(),
    };

    console.log(`[MLB pull] syncBullpenUsage: game ${gameId} — ${relieversUsed.length} relievers used, ERA ${bullpenEra ?? "unknown"}, 3-day pitches ${bullpenUsageLastThreeDays ?? "unknown"}`);
  } catch (err: any) {
    console.error(`[MLB pull] syncBullpenUsage(${gameId}) error:`, err.message);
  }
}

// ── syncPitcherSeasonStats ──────────────────────────────────────────────────
export async function syncPitcherSeasonStats(pitcherId: string): Promise<void> {
  if (!pitcherId || pitcherId === "unknown") return;

  const cached = mlbPlayerCache.pitcherSeasonStats[pitcherId];
  if (cached && Date.now() - cached.fetchedAt < PITCHER_SEASON_TTL) return;

  try {
    const currentYear = new Date().getFullYear();
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&season=${currentYear}&group=pitching`;
    const data = await fetchJson(url);
    const splits = data.stats?.[0]?.splits ?? [];
    const stat = splits[0]?.stat;

    if (!stat) {
      if (!cached) {
        mlbPlayerCache.pitcherSeasonStats[pitcherId] = {
          era: null, whip: null, kPer9: null, bbPer9: null,
          inningsPitched: null, wins: null, losses: null, gamesStarted: null,
          fetchedAt: Date.now(),
        };
      } else {
        cached.fetchedAt = Date.now();
      }
      return;
    }

    const ipRaw = stat.inningsPitched;
    const ip = parseBaseballInnings(ipRaw);
    const so = safeNum(stat.strikeOuts) ?? 0;
    const bb = safeNum(stat.baseOnBalls) ?? 0;
    const kPer9 = safeNum(stat.strikeoutsPer9Inn) ?? (ip && ip > 0 ? parseFloat(((so / ip) * 9).toFixed(2)) : null);
    const bbPer9 = safeNum(stat.walksPer9Inn) ?? (ip && ip > 0 ? parseFloat(((bb / ip) * 9).toFixed(2)) : null);

    mlbPlayerCache.pitcherSeasonStats[pitcherId] = {
      era: safeNum(stat.era),
      whip: safeNum(stat.whip),
      kPer9: kPer9 ?? null,
      bbPer9: bbPer9 ?? null,
      inningsPitched: ip,
      wins: safeNum(stat.wins),
      losses: safeNum(stat.losses),
      gamesStarted: safeNum(stat.gamesStarted),
      fetchedAt: Date.now(),
    };

    console.log(`[MLB pull] syncPitcherSeasonStats: pitcher ${pitcherId} — ERA=${stat.era} WHIP=${stat.whip} K/9=${kPer9} BB/9=${bbPer9}`);
  } catch (err: any) {
    console.error(`[MLB pull] syncPitcherSeasonStats(${pitcherId}) error:`, err.message);
    if (cached) cached.fetchedAt = Date.now();
  }
}

// ── syncPitcherMultiYearStats ────────────────────────────────────────────────
// Prior-season K/9 (current season excluded — syncPitcherSeasonStats owns
// that). Mound Radar input only, feeding matchupAdjustedKs.ts's multi-year
// baseline blend — never the settlement-baseline projectedStrikeouts.
export async function syncPitcherMultiYearStats(pitcherId: string): Promise<void> {
  if (!pitcherId || pitcherId === "unknown") return;

  const cached = mlbPlayerCache.pitcherMultiYearStats[pitcherId];
  if (cached && Date.now() - cached.fetchedAt < PITCHER_MULTI_YEAR_TTL) return;

  try {
    const currentYear = new Date().getFullYear();
    const priorYears = [currentYear - 1, currentYear - 2];
    const results = await Promise.allSettled(
      priorYears.map((year) =>
        fetchJson(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&season=${year}&group=pitching`),
      ),
    );

    // Positionally aligned with priorYears ([year-1, year-2]) — a disqualified
    // or failed year pushes `null` rather than being omitted. Omitting it would
    // compact the array and silently shift a real year-2 value into the
    // year-1 slot, applying blendKPer9()'s heavier year-1 weight to what is
    // actually two-year-old data.
    const priorSeasonsKPer9: (number | null)[] = [];
    for (const result of results) {
      if (result.status !== "fulfilled") { priorSeasonsKPer9.push(null); continue; }
      const stat = result.value.stats?.[0]?.splits?.[0]?.stat;
      if (!stat) { priorSeasonsKPer9.push(null); continue; }
      const ip = parseBaseballInnings(stat.inningsPitched);
      const so = safeNum(stat.strikeOuts) ?? 0;
      const kPer9 = safeNum(stat.strikeoutsPer9Inn) ?? (ip && ip > 0 ? parseFloat(((so / ip) * 9).toFixed(2)) : null);
      // Below the IP floor (a handful of relief innings, an injury-shortened
      // season) → null, not counted as a full-weight year.
      priorSeasonsKPer9.push(kPer9 != null && ip != null && ip >= PITCHER_MULTI_YEAR_MIN_IP ? kPer9 : null);
    }

    mlbPlayerCache.pitcherMultiYearStats[pitcherId] = { priorSeasonsKPer9, fetchedAt: Date.now() };
    console.log(`[MLB pull] syncPitcherMultiYearStats: pitcher ${pitcherId} — prior K/9 [${priorSeasonsKPer9.join(", ")}]`);
  } catch (err: any) {
    console.error(`[MLB pull] syncPitcherMultiYearStats(${pitcherId}) error:`, err.message);
    if (cached) cached.fetchedAt = Date.now();
  }
}

// ── syncBatterRollingStats ──────────────────────────────────────────────────
export async function syncBatterRollingStats(playerId: string): Promise<void> {
  if (!playerId || playerId === "unknown") return;

  const cached = mlbPlayerCache.batterRollingStats[playerId];
  if (cached && Date.now() - cached.fetchedAt < BATTER_ROLLING_TTL) return;

  try {
    const currentYear = new Date().getFullYear();
    const url = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${currentYear}&group=hitting`;
    const data = await fetchJson(url);
    const splits = data.stats?.[0]?.splits ?? [];

    if (splits.length === 0) {
      if (!cached) {
        mlbPlayerCache.batterRollingStats[playerId] = {
          last7: { avg: null, ops: null, slg: null, games: 0 },
          last15: { avg: null, ops: null, slg: null, games: 0 },
          last30: { avg: null, ops: null, slg: null, games: 0 },
          seasonAvg: null, seasonOps: null, seasonSlg: null, seasonHRRate: null,
          abSinceLastHR: null, hrRateLast7: null, hrRateLast15: null, hrRateLast30: null,
          seasonTotalHR: 0, seasonTotalAB: 0, seasonTotalPA: 0,
          seasonTotalIBB: 0, seasonIBBRate: null,
          fetchedAt: Date.now(),
        };
      } else {
        cached.fetchedAt = Date.now();
      }
      return;
    }

    const computeRolling = (games: any[]): { avg: number | null; ops: number | null; slg: number | null; games: number } => {
      if (games.length === 0) return { avg: null, ops: null, slg: null, games: 0 };
      let totalAB = 0, totalH = 0, totalPA = 0, totalTB = 0, totalOBP_num = 0;
      for (const g of games) {
        const s = g.stat;
        const ab = safeNum(s.atBats) ?? 0;
        const h = safeNum(s.hits) ?? 0;
        const bb = safeNum(s.baseOnBalls) ?? 0;
        const hbp = safeNum(s.hitByPitch) ?? 0;
        const sf = safeNum(s.sacFlies) ?? 0;
        const doubles = safeNum(s.doubles) ?? 0;
        const triples = safeNum(s.triples) ?? 0;
        const hr = safeNum(s.homeRuns) ?? 0;
        const singles = h - doubles - triples - hr;
        totalAB += ab;
        totalH += h;
        totalPA += ab + bb + hbp + sf;
        totalTB += singles + (doubles * 2) + (triples * 3) + (hr * 4);
        totalOBP_num += h + bb + hbp;
      }
      const avg = totalAB > 0 ? parseFloat((totalH / totalAB).toFixed(3)) : null;
      const obp = totalPA > 0 ? totalOBP_num / totalPA : 0;
      const slgRaw = totalAB > 0 ? totalTB / totalAB : 0;
      const slg = totalAB > 0 ? parseFloat(slgRaw.toFixed(3)) : null;
      const ops = (obp + slgRaw) > 0 ? parseFloat((obp + slgRaw).toFixed(3)) : null;
      return { avg, ops, slg, games: games.length };
    }

    const now = new Date();
    const filterByDays = (days: number): any[] => {
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      return splits.filter((g: any) => {
        const gameDate = g.date ?? g.gameDate ?? "";
        return gameDate >= cutoffStr;
      });
    }

    const last7 = computeRolling(filterByDays(7));
    const last15 = computeRolling(filterByDays(15));
    const last30 = computeRolling(filterByDays(30));

    const allGames = computeRolling(splits);
    const seasonAvg = allGames.avg;
    const seasonOps = allGames.ops;
    const seasonSlg = allGames.slg;

    let seasonTotalPA = 0, seasonTotalHR = 0, seasonTotalAB = 0, seasonTotalIBB = 0;
    for (const g of splits) {
      const s = g.stat;
      const ab = safeNum(s.atBats) ?? 0;
      const bb = safeNum(s.baseOnBalls) ?? 0;
      const hbp = safeNum(s.hitByPitch) ?? 0;
      const sf = safeNum(s.sacFlies) ?? 0;
      const hr = safeNum(s.homeRuns) ?? 0;
      // intentionalWalks: standard MLB Stats API hitting field. Defensive —
      // 0 when absent, so seasonIBBRate stays low/null and the prior is neutral.
      const ibb = safeNum(s.intentionalWalks) ?? safeNum(s.intentionalBaseOnBalls) ?? 0;
      seasonTotalPA += ab + bb + hbp + sf;
      seasonTotalHR += hr;
      seasonTotalAB += ab;
      seasonTotalIBB += ibb;
    }
    const seasonHRRate = seasonTotalPA >= 50 ? parseFloat((seasonTotalHR / seasonTotalPA).toFixed(4)) : null;
    const seasonIBBRate = seasonTotalPA >= 50 ? parseFloat((seasonTotalIBB / seasonTotalPA).toFixed(4)) : null;

    let abSinceLastHR: number | null = null;
    let abAccum = 0;
    for (let i = splits.length - 1; i >= 0; i--) {
      const s = splits[i].stat;
      const ab = safeNum(s.atBats) ?? 0;
      const hr = safeNum(s.homeRuns) ?? 0;
      if (hr > 0) {
        abSinceLastHR = abAccum;
        break;
      }
      abAccum += ab;
    }
    if (abSinceLastHR === null && seasonTotalAB > 0) {
      abSinceLastHR = seasonTotalAB;
    }

    const computeHRRate = (games: any[]): number | null => {
      let pa = 0, hr = 0;
      for (const g of games) {
        const s = g.stat;
        pa += (safeNum(s.atBats) ?? 0) + (safeNum(s.baseOnBalls) ?? 0) + (safeNum(s.hitByPitch) ?? 0) + (safeNum(s.sacFlies) ?? 0);
        hr += safeNum(s.homeRuns) ?? 0;
      }
      return pa >= 10 ? parseFloat((hr / pa).toFixed(4)) : null;
    };

    const hrRateLast7 = computeHRRate(filterByDays(7));
    const hrRateLast15 = computeHRRate(filterByDays(15));
    const hrRateLast30 = computeHRRate(filterByDays(30));

    mlbPlayerCache.batterRollingStats[playerId] = {
      last7, last15, last30, seasonAvg, seasonOps, seasonSlg, seasonHRRate,
      abSinceLastHR, hrRateLast7, hrRateLast15, hrRateLast30,
      seasonTotalHR, seasonTotalAB, seasonTotalPA,
      seasonTotalIBB, seasonIBBRate,
      fetchedAt: Date.now(),
    };

    console.log(`[MLB pull] syncBatterRollingStats: player ${playerId} — L7=${last7.avg} L15=${last15.avg} L30=${last30.avg} Season=${seasonAvg} HR/PA=${seasonHRRate ?? "n/a"} IBB/PA=${seasonIBBRate ?? "n/a"} abSinceHR=${abSinceLastHR ?? "n/a"} hrL7=${hrRateLast7 ?? "n/a"} hrL15=${hrRateLast15 ?? "n/a"} (${splits.length} games)`);
  } catch (err: any) {
    console.error(`[MLB pull] syncBatterRollingStats(${playerId}) error:`, err.message);
    if (cached) cached.fetchedAt = Date.now();
  }
}

// ── syncBatterOrderSplits ─────────────────────────────────────────────────────
// SLG/OPS by lineup slot, aggregated from the locally-collected per-game stat
// lines (game_player_stats) — real data the app already persists. No-ops
// gracefully (empty splits) for players with no tracked history. Pure
// aggregation lives in ./orderSplits (DB-free, unit-testable).
export async function syncBatterOrderSplits(playerId: string): Promise<void> {
  if (!playerId || playerId === "unknown") return;
  const cached = mlbPlayerCache.batterOrderSplits[playerId];
  if (cached && Date.now() - cached.fetchedAt < BATTER_ORDER_SPLITS_TTL) return;
  try {
    const rows = await storage.getBatterOrderSplitRows(playerId, 600);
    const agg = aggregateOrderSplits(rows);
    mlbPlayerCache.batterOrderSplits[playerId] = { ...agg, fetchedAt: Date.now() };
  } catch (err: any) {
    console.error(`[MLB pull] syncBatterOrderSplits(${playerId}) error:`, err.message);
    if (cached) cached.fetchedAt = Date.now();
  }
}

// ── syncSavantSeasonForLineup ─────────────────────────────────────────────────
// Pre-hydrates Savant season stats (xBA, xSLG, EV, barrel%) for ALL batters in
// the lineup — including those with 0 AB who have no BIP events yet.
// This fills the gap where syncContactData only enriches players with BIP data.
export async function syncSavantSeasonForLineup(gameId: string): Promise<void> {
  const state = mlbGameCache.gameState[gameId];
  if (!state || !state.battingOrder || state.battingOrder.length === 0) return;

  const contactData = mlbGameCache.contactData[gameId]?.byPlayerId ?? {};
  const needsEnrichment: string[] = [];

  for (const batter of state.battingOrder) {
    if (!batter.playerId || batter.playerId === "unknown") continue;
    const existing = contactData[batter.playerId];
    if (!existing || (existing.xBA === null && existing.xSLG === null)) {
      needsEnrichment.push(batter.playerId);
    }
  }

  if (needsEnrichment.length === 0) return;

  console.log(`[MLB_SAVANT_PREHYDRATE] game=${gameId} enriching ${needsEnrichment.length} batters without Savant data`);

  const results = await Promise.allSettled(
    needsEnrichment.map((pid) => fetchBaseballSavantData(pid, gameId))
  );

  let enriched = 0;
  for (let i = 0; i < needsEnrichment.length; i++) {
    const result = results[i];
    if (result.status !== "fulfilled" || !result.value) continue;
    const pid = needsEnrichment[i];
    const savant = result.value;
    if (savant.xBA === null && savant.xSLG === null) continue;

    if (!mlbGameCache.contactData[gameId]) {
      mlbGameCache.contactData[gameId] = { byPlayerId: {}, fetchedAt: Date.now() };
    }
    if (!mlbGameCache.contactData[gameId].byPlayerId[pid]) {
      mlbGameCache.contactData[gameId].byPlayerId[pid] = {
        exitVelocity: savant.exitVelocity,
        launchAngle: savant.launchAngle,
        hitDistance: savant.hitDistance,
        latestExitVelocity: null,
        latestLaunchAngle: null,
        hardHitPct: savant.hardHitRateSeason,
        barrelPct: savant.barrelRateProxySeason,
        avgBatSpeed: savant.avgBatSpeed,
        avgSwingLength: savant.avgSwingLength,
        xBA: savant.xBA,
        xSLG: savant.xSLG,
        gameAvgXBA: null,
        gameMaxXBA: null,
        gameBarrelCount: 0,
        gameContactQuality: 0,
        priorABResults: [],
        flyBallPercent: savant.flyBallPercent,
        hrFBRatio: savant.hrFBRatio,
        xwOBASeason: savant.xwOBASeason,
        xISOSeason: savant.xISOSeason,
        sweetSpotPercent: savant.sweetSpotPercent,
        pullRatePercent: savant.pullRatePercent,
        batterPitchSplits: savant.batterPitchSplits,
        toppedPct: savant.toppedPct,
        maxEV: savant.maxEV,
      };
    } else {
      const entry = mlbGameCache.contactData[gameId].byPlayerId[pid];
      if (entry.xBA === null && savant.xBA != null) entry.xBA = savant.xBA;
      if (entry.xSLG === null && savant.xSLG != null) entry.xSLG = savant.xSLG;
      if (entry.exitVelocity === null && savant.exitVelocity != null) entry.exitVelocity = savant.exitVelocity;
      if (entry.hardHitPct === null && savant.hardHitRateSeason != null) entry.hardHitPct = savant.hardHitRateSeason;
      if (entry.barrelPct === null && savant.barrelRateProxySeason != null) entry.barrelPct = savant.barrelRateProxySeason;
      if (entry.avgBatSpeed === null && savant.avgBatSpeed != null) entry.avgBatSpeed = savant.avgBatSpeed;
      if (entry.avgSwingLength === null && savant.avgSwingLength != null) entry.avgSwingLength = savant.avgSwingLength;
      if (entry.flyBallPercent === null && savant.flyBallPercent != null) entry.flyBallPercent = savant.flyBallPercent;
      if (entry.hrFBRatio === null && savant.hrFBRatio != null) entry.hrFBRatio = savant.hrFBRatio;
      if (entry.xwOBASeason === null && savant.xwOBASeason != null) entry.xwOBASeason = savant.xwOBASeason;
      if (entry.xISOSeason === null && savant.xISOSeason != null) entry.xISOSeason = savant.xISOSeason;
      if (entry.sweetSpotPercent === null && savant.sweetSpotPercent != null) entry.sweetSpotPercent = savant.sweetSpotPercent;
      if (entry.pullRatePercent === null && savant.pullRatePercent != null) entry.pullRatePercent = savant.pullRatePercent;
      if (entry.batterPitchSplits == null && savant.batterPitchSplits != null) entry.batterPitchSplits = savant.batterPitchSplits;
      if (entry.toppedPct == null && savant.toppedPct != null) entry.toppedPct = savant.toppedPct;
      if (entry.maxEV == null && savant.maxEV != null) entry.maxEV = savant.maxEV;
    }
    enriched++;
  }

  console.log(`[MLB_SAVANT_PREHYDRATE] game=${gameId} enriched ${enriched}/${needsEnrichment.length} batters with season Savant data`);
}

// ── syncOpenMeteoWeather ─────────────────────────────────────────────────────
// Fetches hourly weather forecast from Open-Meteo API using stadium coordinates.
// Provides per-hour temperature, wind, humidity, and precipitation probability.
// Used as fallback when MLB Stats API live feed weather is not yet available,
// and always used to enrich the weather cache with hourly forecasts.
const openMeteoCache = new Map<string, { data: WeatherCache; fetchedAt: number }>();
// 15-min TTL so wind readings stay fresh during active games (wind can shift
// significantly mid-game vs. the pregame read).
const OPEN_METEO_TTL = 15 * 60 * 1000;

export async function syncOpenMeteoWeather(gameId: string, venueName: string | null): Promise<void> {
  if (!venueName) return;
  if (isVenueIndoors(venueName)) {
    if (!mlbGameCache.weather[gameId]) {
      mlbGameCache.weather[gameId] = {
        temperature: 72,
        windSpeed: 0,
        windDirection: "calm",
        humidity: 50,
        fetchedAt: Date.now(),
        venueName,
        isIndoors: true,
      };
      console.log(`[MLB_WEATHER_OPENMETEO] game=${gameId} venue="${venueName}" → indoor stadium, using defaults`);
    }
    return;
  }

  const cached = openMeteoCache.get(gameId);
  if (cached && Date.now() - cached.fetchedAt < OPEN_METEO_TTL) {
    if (!mlbGameCache.weather[gameId]) {
      mlbGameCache.weather[gameId] = cached.data;
    }
    return;
  }

  const coords = getStadiumCoords(venueName);
  if (!coords) {
    console.warn(`[MLB_WEATHER_OPENMETEO] No coordinates for venue "${venueName}" — skipping`);
    return;
  }

  try {
    // Lane 3.2 — request surface_pressure (one extra field on the existing
    // call, no new feed) for the HR-distance air-density adjustment.
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,surface_pressure&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation_probability,surface_pressure&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=1&timezone=auto`;
    const res = await fetch(url, {
      headers: { "User-Agent": "LiveLocks/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const current = data.current ?? {};

    const temperature = safeNum(current.temperature_2m);
    const windSpeed = safeNum(current.wind_speed_10m);
    const humidity = safeNum(current.relative_humidity_2m);
    const pressure = safeNum(current.surface_pressure);
    const windDeg = safeNum(current.wind_direction_10m);

    const windDirection = windDeg != null
      ? windDirectionRelativeToField(windDeg, coords.orientation)
      : "cross";

    const hourlyForecast: HourlyWeatherEntry[] = [];
    const hourlyData = data.hourly;
    if (hourlyData?.time && Array.isArray(hourlyData.time)) {
      for (let i = 0; i < hourlyData.time.length; i++) {
        const timeStr = hourlyData.time[i] as string;
        const hourMatch = timeStr.match(/T(\d{2}):/);
        const hour = hourMatch ? parseInt(hourMatch[1], 10) : i;
        const hWindDeg = safeNum(hourlyData.wind_direction_10m?.[i]);
        const hWindSpeed = safeNum(hourlyData.wind_speed_10m?.[i]);
        const hWindDir = hWindDeg != null
          ? windDirectionRelativeToField(hWindDeg, coords.orientation)
          : "cross";

        hourlyForecast.push({
          hour,
          temperature: safeNum(hourlyData.temperature_2m?.[i]),
          windSpeed: hWindSpeed,
          windDirection: hWindSpeed != null && hWindSpeed < 3 ? "calm" : hWindDir,
          windDegrees: hWindDeg,
          humidity: safeNum(hourlyData.relative_humidity_2m?.[i]),
          precipProb: safeNum(hourlyData.precipitation_probability?.[i]),
          pressure: safeNum(hourlyData.surface_pressure?.[i]),
        });
      }
    }

    const existingWeather = mlbGameCache.weather[gameId];
    const gameStartWindDir = existingWeather?.gameStartWindDirection ?? (windSpeed != null && windSpeed < 3 ? "calm" : windDirection);
    const currentWindDir = windSpeed != null && windSpeed < 3 ? "calm" : windDirection;
    const windShiftDetected = gameStartWindDir !== currentWindDir && gameStartWindDir !== "calm" && currentWindDir !== "calm";

    const utcOffsetSeconds = safeNum(data.utc_offset_seconds) ?? 0;

    const weatherData: WeatherCache = {
      temperature,
      windSpeed,
      windDirection: currentWindDir,
      humidity,
      pressure,
      fetchedAt: Date.now(),
      venueName,
      isIndoors: false,
      windString: null,
      windDegrees: windDeg,
      hourlyForecast,
      utcOffsetSeconds,
      gameStartWindDirection: gameStartWindDir,
      windShiftDetected,
    };

    openMeteoCache.set(gameId, { data: weatherData, fetchedAt: Date.now() });

    if (!mlbGameCache.weather[gameId] || mlbGameCache.weather[gameId].temperature === null) {
      mlbGameCache.weather[gameId] = weatherData;
      console.log(`[MLB_WEATHER_OPENMETEO] game=${gameId} venue="${venueName}" — ${temperature}°F, wind ${windSpeed}mph ${windDirection}, humidity ${humidity}%, hourly=${hourlyForecast.length}h, utcOff=${utcOffsetSeconds}s`);
    } else {
      const existing = mlbGameCache.weather[gameId];
      // If Open-Meteo has a materially different wind reading, prefer it — the
      // MLB live-feed wind field is set at first pitch and rarely updates
      // mid-game, so it can lag by 3+ innings when wind picks up.
      const existingWs = existing.windSpeed ?? 0;
      const omWs = windSpeed ?? 0;
      const windDrift = Math.abs(omWs - existingWs);
      if (windSpeed != null && (windDrift >= 5 || existing.windSpeed == null)) {
        existing.windSpeed = windSpeed;
        existing.windDirection = currentWindDir;
        // Propagate the fresh Open-Meteo bearing and DROP the stale MLB-feed
        // sector text. resolveWindVector prioritizes windString, so without this
        // HR Radar would keep applying the old LF/RF sector after an Open-Meteo
        // wind shift. Clearing it makes the fresh bearing (windDegrees) win.
        existing.windDegrees = windDeg;
        existing.windString = null;
        console.log(`[MLB_WEATHER_OPENMETEO_WIND_UPDATE] game=${gameId} mlbWind=${existingWs}mph → omWind=${windSpeed}mph ${windDirection} (drift=${windDrift.toFixed(0)}mph)`);
      }
      existing.hourlyForecast = hourlyForecast;
      existing.utcOffsetSeconds = utcOffsetSeconds;
      existing.gameStartWindDirection = gameStartWindDir;
      existing.windShiftDetected = windShiftDetected;
      if (windShiftDetected) {
        console.log(`[MLB_WEATHER_WIND_SHIFT] game=${gameId} — wind shifted from ${gameStartWindDir} to ${currentWindDir} since game start`);
      }
    }
  } catch (err: any) {
    console.warn(`[MLB_WEATHER_OPENMETEO] game=${gameId} error: ${err.message}`);
  }
}

export function resolveCurrentHourWeather(gameId: string): HourlyWeatherEntry | null {
  const weather = mlbGameCache.weather[gameId];
  if (!weather?.hourlyForecast?.length) return null;
  const utcOff = weather.utcOffsetSeconds ?? 0;
  const nowUtcMs = Date.now();
  const venueLocalMs = nowUtcMs + utcOff * 1000;
  const venueLocalHour = new Date(venueLocalMs).getUTCHours();
  return weather.hourlyForecast.find(h => h.hour === venueLocalHour) ?? null;
}

// ── syncBvPMatchup ──────────────────────────────────────────────────────────
export async function syncBvPMatchup(batterId: string, pitcherId: string): Promise<void> {
  if (!batterId || !pitcherId || batterId === "unknown" || pitcherId === "unknown") return;

  const cacheKey = `${batterId}_vs_${pitcherId}`;
  const cached = mlbPlayerCache.bvpMatchups[cacheKey];
  if (cached && Date.now() - cached.fetchedAt < BVP_TTL) return;

  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting`;
    const data = await fetchJson(url);
    const splits = data.stats?.[0]?.splits ?? [];

    let totalAB = 0, totalH = 0, totalHR = 0, totalSO = 0;
    let totalPA = 0, totalTB = 0, totalOBP_num = 0;

    for (const split of splits) {
      const s = split.stat;
      const ab = safeNum(s.atBats) ?? 0;
      const h = safeNum(s.hits) ?? 0;
      const hr = safeNum(s.homeRuns) ?? 0;
      const so = safeNum(s.strikeOuts) ?? 0;
      const bb = safeNum(s.baseOnBalls) ?? 0;
      const hbp = safeNum(s.hitByPitch) ?? 0;
      const sf = safeNum(s.sacFlies) ?? 0;
      const doubles = safeNum(s.doubles) ?? 0;
      const triples = safeNum(s.triples) ?? 0;
      const singles = h - doubles - triples - hr;
      totalAB += ab;
      totalH += h;
      totalHR += hr;
      totalSO += so;
      totalPA += ab + bb + hbp + sf;
      totalTB += singles + (doubles * 2) + (triples * 3) + (hr * 4);
      totalOBP_num += h + bb + hbp;
    }

    const avg = totalAB > 0 ? parseFloat((totalH / totalAB).toFixed(3)) : null;
    const obp = totalPA > 0 ? totalOBP_num / totalPA : 0;
    const slg = totalAB > 0 ? totalTB / totalAB : 0;
    const ops = (obp + slg) > 0 ? parseFloat((obp + slg).toFixed(3)) : null;

    mlbPlayerCache.bvpMatchups[cacheKey] = {
      atBats: totalAB, hits: totalH, homeRuns: totalHR, strikeouts: totalSO,
      avg, ops, fetchedAt: Date.now(),
    };

    if (totalAB > 0) {
      console.log(`[MLB pull] syncBvPMatchup: ${batterId} vs ${pitcherId} — ${totalAB} AB, ${totalH} H, AVG=${avg} OPS=${ops}`);
    }
  } catch (err: any) {
    console.error(`[MLB pull] syncBvPMatchup(${batterId} vs ${pitcherId}) error:`, err.message);
    if (cached) cached.fetchedAt = Date.now();
  }
}
