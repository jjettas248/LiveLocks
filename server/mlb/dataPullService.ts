// ── MLB Data Pull Service ─────────────────────────────────────────────────────
// Fetches and caches live game data from MLB Stats API and Baseball Savant.
// All functions: 8-second timeout, try/catch, log-and-return on error.

import type { PitchMixEntry } from "./types";
import { fetchBaseballSavantData } from "./dataSources";

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
  fetchedAt: number;
}

export interface PlayerContactData {
  exitVelocity: number | null;
  launchAngle: number | null;
  hitDistance: number | null;
  hardHitPct: number | null;
  barrelPct: number | null;
  xBA: number | null;
  xSLG: number | null;
  priorABResults: Array<{
    exitVelocity: number | null;
    launchAngle: number | null;
    distance: number | null;
    outcome: "hit" | "out" | "strikeout" | "walk" | "hbp" | "error" | "other";
  }>;
}

export interface ContactDataCache {
  byPlayerId: Record<string, PlayerContactData>;
  fetchedAt: number;
}

export interface PitcherContextEntry {
  pitchMix: PitchMixEntry[];
  avgVelocity: number | null;
  pitchCount: number;
  timesThroughOrder: number;
  velocityDrop: number | null;
  seasonAvgVelocity: number | null;
}

export interface PitcherContextCache {
  byPitcherId: Record<string, PitcherContextEntry>;
  fetchedAt: number;
}

export interface WeatherCache {
  temperature: number | null;
  windSpeed: number | null;
  windDirection: "in" | "out" | "cross" | "calm" | null;
  humidity: number | null;
  fetchedAt: number;
}

export interface BullpenCache {
  bullpenEra: number | null;
  bullpenUsageLastThreeDays: number | null;
  isTopRelieverAvailable: boolean;
  relieversUsed: Array<{ playerId: string; playerName: string; pitchCount: number }>;
  fetchedAt: number;
}

// ── In-memory cache ───────────────────────────────────────────────────────────

export const mlbGameCache: {
  gameState: Record<string, GameStateCache>;
  contactData: Record<string, ContactDataCache>;
  pitcherContext: Record<string, PitcherContextCache>;
  weather: Record<string, WeatherCache>;
  bullpen: Record<string, BullpenCache>;
} = {
  gameState: {},
  contactData: {},
  pitcherContext: {},
  weather: {},
  bullpen: {},
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const LIVE_FEED_URL = (gamePk: string) =>
  `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;

const SAVANT_GF_URL = (gamePk: string) =>
  `https://baseballsavant.mlb.com/gf?game_pk=${gamePk}`;

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

// ── syncGameState ─────────────────────────────────────────────────────────────

export async function syncGameState(statsPk: string, cacheKey?: string): Promise<void> {
  const gameId = cacheKey ?? statsPk;
  try {
    const data = await fetchJson(LIVE_FEED_URL(statsPk));
    const liveData = data.liveData ?? {};
    const linescore = liveData.linescore ?? {};
    const plays = liveData.plays ?? {};
    const boxTeams = liveData.boxscore?.teams ?? {};

    // Inning / top-bottom
    const inning: number = safeNum(linescore.currentInning) ?? 1;
    const isTopInning: boolean = linescore.isTopInning ?? true;
    const outs: number = safeNum(linescore.outs) ?? 0;

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
      fetchedAt: Date.now(),
    };

    console.log(`[MLB pull] syncGameState: game ${gameId} — inning ${inning}${isTopInning ? "T" : "B"}, ${battingOrder.length} batters`);
  } catch (err: any) {
    console.error(`[MLB pull] syncGameState(${gameId}) error:`, err.message);
  }
}

// ── syncContactData ───────────────────────────────────────────────────────────

export async function syncContactData(statsPk: string, cacheKey?: string): Promise<void> {
  const gameId = cacheKey ?? statsPk;
  try {
    const data = await fetchJson(SAVANT_GF_URL(statsPk));

    const byPlayerId: Record<string, PlayerContactData> = {};

    // The Savant GF endpoint returns home_team_data and away_team_data
    // Each contains a "bip" (balls in play) array with per-event contact data
    for (const side of ["home_team_data", "away_team_data"]) {
      const teamData = data[side] ?? {};
      const bips: any[] = teamData.bip ?? [];

      for (const bip of bips) {
        const playerId = String(bip.batter_id ?? bip.hitter_id ?? "");
        if (!playerId || playerId === "undefined") continue;

        if (!byPlayerId[playerId]) {
          byPlayerId[playerId] = {
            exitVelocity: null,
            launchAngle: null,
            hitDistance: null,
            hardHitPct: null,
            barrelPct: null,
            xBA: null,
            xSLG: null,
            priorABResults: [],
          };
        }

        const ev = safeNum(bip.hit_speed ?? bip.exit_velocity);
        const la = safeNum(bip.hit_angle ?? bip.launch_angle);
        const dist = safeNum(bip.hit_distance ?? bip.distance);
        const event: string = bip.result ?? bip.event ?? "";

        // Track best EV this game per player (most recent hard-contact event)
        if (ev !== null && (byPlayerId[playerId].exitVelocity === null || ev > (byPlayerId[playerId].exitVelocity ?? 0))) {
          byPlayerId[playerId].exitVelocity = ev;
          byPlayerId[playerId].launchAngle = la;
          byPlayerId[playerId].hitDistance = dist;
        }

        byPlayerId[playerId].priorABResults.push({
          exitVelocity: ev,
          launchAngle: la,
          distance: dist,
          outcome: inferOutcome(event),
        });
      }

      // Hard hit % and barrel % from aggregate if available
      const exitVeloList = (teamData.exit_velocity ?? []) as number[];
      if (exitVeloList.length > 0) {
        const hardHit = exitVeloList.filter((v) => v >= 95).length / exitVeloList.length;
        const barrels = exitVeloList.filter((v) => v >= 98).length / exitVeloList.length;
        // Apply to all players from this side that were touched (rough game-level fallback)
        for (const entry of Object.values(byPlayerId)) {
          if (entry.hardHitPct === null) entry.hardHitPct = parseFloat((hardHit * 100).toFixed(1));
          if (entry.barrelPct === null) entry.barrelPct = parseFloat((barrels * 100).toFixed(1));
        }
      }
    }

    // Enrich xBA/xSLG for each player from Baseball Savant seasonal stats (non-blocking)
    const playerIds = Object.keys(byPlayerId);
    if (playerIds.length > 0) {
      const savantResults = await Promise.allSettled(
        playerIds.map((pid) => fetchBaseballSavantData(pid, gameId))
      );
      for (let i = 0; i < playerIds.length; i++) {
        const result = savantResults[i];
        if (result.status === "fulfilled" && result.value) {
          const entry = byPlayerId[playerIds[i]];
          if (entry) {
            if (entry.xBA === null && result.value.xBA != null) entry.xBA = result.value.xBA;
            if (entry.xSLG === null && result.value.xSLG != null) entry.xSLG = result.value.xSLG;
          }
        }
      }
      const enrichedCount = playerIds.filter((pid) => byPlayerId[pid]?.xBA != null || byPlayerId[pid]?.xSLG != null).length;
      console.log(`[MLB pull] syncContactData Savant enrichment: game ${gameId} — ${enrichedCount}/${playerIds.length} players with xBA/xSLG`);
    }

    mlbGameCache.contactData[gameId] = { byPlayerId, fetchedAt: Date.now() };
    console.log(`[MLB pull] syncContactData: game ${gameId} — ${Object.keys(byPlayerId).length} players with contact data`);
  } catch (err: any) {
    console.error(`[MLB pull] syncContactData(${gameId}) error:`, err.message);
  }
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

        // Build pitch mix from play events for this pitcher
        const pitchMixMap: Record<string, { count: number; totalVelocity: number }> = {};
        let pitchVelocities: number[] = [];

        for (const play of allPlays) {
          if (String(play.matchup?.pitcher?.id) !== String(pid)) continue;
          for (const event of play.playEvents ?? []) {
            if (event.type !== "pitch") continue;
            const pType: string = event.details?.type?.description ?? "Unknown";
            const vel: number | null = safeNum(event.pitchData?.startSpeed);
            if (!pitchMixMap[pType]) pitchMixMap[pType] = { count: 0, totalVelocity: 0 };
            pitchMixMap[pType].count += 1;
            if (vel !== null) {
              pitchMixMap[pType].totalVelocity += vel;
              pitchVelocities.push(vel);
            }
          }
        }

        const totalPitches = Object.values(pitchMixMap).reduce((s, v) => s + v.count, 0);
        const pitchMix: PitchMixEntry[] = Object.entries(pitchMixMap).map(([pitchType, v]) => ({
          pitchType,
          percentage: totalPitches > 0 ? parseFloat(((v.count / totalPitches) * 100).toFixed(1)) : 0,
          avgVelocity: v.count > 0 ? parseFloat((v.totalVelocity / v.count).toFixed(1)) : null,
        }));

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

        byPitcherId[String(pid)] = {
          pitchMix,
          avgVelocity,
          pitchCount,
          timesThroughOrder,
          velocityDrop,
          seasonAvgVelocity: null,
        };
      }
    }

    mlbGameCache.pitcherContext[gameId] = { byPitcherId, fetchedAt: Date.now() };
    console.log(`[MLB pull] syncPitcherContext: game ${gameId} — ${Object.keys(byPitcherId).length} pitchers`);
  } catch (err: any) {
    console.error(`[MLB pull] syncPitcherContext(${gameId}) error:`, err.message);
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
    const windSpeed: number | null = (() => {
      const raw: string = weather.wind ?? "";
      const match = raw.match(/(\d+(?:\.\d+)?)/);
      return match ? parseFloat(match[1]) : null;
    })();
    const windDirection = normalizeWindDirection(weather.wind);
    const humidity: number | null = safeNum(weather.condition === "Roof Closed" ? 50 : null);

    mlbGameCache.weather[gameId] = {
      temperature: temperature ?? null,
      windSpeed: windSpeed ?? null,
      windDirection: windDirection ?? "cross",
      humidity: humidity,
      fetchedAt: Date.now(),
    };

    const isIndoors = (venue.fieldInfo?.roofType ?? "").toLowerCase().includes("retractable")
      || (data.gameData?.weather?.condition ?? "").toLowerCase().includes("roof closed");
    console.log(`[MLB pull] syncWeather: game ${gameId} — ${temperature}°F, wind ${windSpeed}mph ${windDirection ?? "unknown"}${isIndoors ? " (indoors)" : ""}`);
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
      ?? new Date().toISOString().slice(0, 10);

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
