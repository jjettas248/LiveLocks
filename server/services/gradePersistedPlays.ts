import type { IStorage } from "../storage";
import { recordResult as recordDirectionalResult } from "../nba/directionalBias";

// ── MLB Stats API typed interfaces ────────────────────────────────────────────

interface MlbGameStatusData {
  gameData?: {
    status?: {
      abstractGameState?: string;
      codedGameState?: string;
    };
  };
}

interface MlbPlayerStatsBlock {
  batting?: Record<string, unknown>;
  pitching?: Record<string, unknown>;
}

interface MlbBoxscorePlayerData {
  person?: { id?: number | string; fullName?: string };
  stats?: MlbPlayerStatsBlock;
}

interface MlbBoxscoreTeam {
  players?: Record<string, MlbBoxscorePlayerData>;
}

interface MlbBoxscoreData {
  teams?: {
    away?: MlbBoxscoreTeam;
    home?: MlbBoxscoreTeam;
  };
}

// ── MLB market → boxscore field mapping ───────────────────────────────────────

// Maps persisted market names (from MLBMarket type in server/mlb/types.ts) to
// their corresponding field names in the MLB Stats API boxscore response.
// Batting stats come from playerData.stats.batting; pitching from playerData.stats.pitching.
// The "source" field distinguishes which side of the boxscore to look at.
// "composite" markets (hrr = hits+runs+rbi) require multi-field summation.
interface MlbStatMappingSingle {
  kind: "single";
  source: "batting" | "pitching";
  field: string;
}

interface MlbStatMappingComposite {
  kind: "composite";
  source: "batting";
  fields: string[];
}

type MlbStatMapping = MlbStatMappingSingle | MlbStatMappingComposite;

const MLB_STAT_KEY_MAP: Record<string, MlbStatMapping> = {
  // Batter markets (single-field)
  hits:               { kind: "single",    source: "batting",  field: "hits" },
  total_bases:        { kind: "single",    source: "batting",  field: "totalBases" },
  batter_strikeouts:  { kind: "single",    source: "batting",  field: "strikeOuts" },
  pitcher_outs:       { kind: "single",    source: "pitching", field: "outs" },
  home_runs:          { kind: "single",    source: "batting",  field: "homeRuns" },
  rbis:               { kind: "single",    source: "batting",  field: "rbi" },
  rbi:                { kind: "single",    source: "batting",  field: "rbi" },
  walks:              { kind: "single",    source: "batting",  field: "baseOnBalls" },
  // hrr = hits + runs + rbi (composite batting market)
  hrr:                { kind: "composite", source: "batting",  fields: ["hits", "runs", "rbi"] },
  // Pitcher markets (single-field)
  pitcher_strikeouts: { kind: "single",    source: "pitching", field: "strikeOuts" },
  hits_allowed:       { kind: "single",    source: "pitching", field: "hits" },
  walks_allowed:      { kind: "single",    source: "pitching", field: "baseOnBalls" },
  earned_runs:        { kind: "single",    source: "pitching", field: "earnedRuns" },
  outs_recorded:      { kind: "single",    source: "pitching", field: "outs" },
};

async function fetchMlbBoxScore(gameId: string): Promise<MlbBoxscoreData | null> {
  const statusUrl = `https://statsapi.mlb.com/api/v1/game/${gameId}/feed/live`;
  console.log("[GRADE MLB] Checking game status:", statusUrl);
  try {
    const statusRes = await fetch(statusUrl, {
      headers: { "User-Agent": "LiveLocks/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!statusRes.ok) {
      console.error("[GRADE MLB] Status API returned:", statusRes.status, "for game", gameId);
      return null;
    }
    const statusData = (await statusRes.json()) as MlbGameStatusData;
    const abstractState: string = statusData.gameData?.status?.abstractGameState ?? "";
    const codedState: string = statusData.gameData?.status?.codedGameState ?? "";
    const isFinal = abstractState.toLowerCase() === "final" || codedState === "F";
    if (!isFinal) {
      console.log("[GRADE MLB] Game not final yet:", gameId, "abstractState:", abstractState);
      return null;
    }
  } catch (err) {
    console.error("[GRADE MLB] Status fetch failed for game", gameId, ":", (err as Error).message);
    return null;
  }

  const boxUrl = `https://statsapi.mlb.com/api/v1/game/${gameId}/boxscore`;
  console.log("[GRADE MLB] Fetching box score:", boxUrl);
  try {
    const boxRes = await fetch(boxUrl, {
      headers: { "User-Agent": "LiveLocks/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!boxRes.ok) {
      console.error("[GRADE MLB] Box score API returned:", boxRes.status, "for game", gameId);
      return null;
    }
    return (await boxRes.json()) as MlbBoxscoreData;
  } catch (err) {
    console.error("[GRADE MLB] Box score fetch failed for game", gameId, ":", (err as Error).message);
    return null;
  }
}

interface MlbPlayerEntry {
  id: string;
  name: string;
  batting: Record<string, number>;
  pitching: Record<string, number>;
}

function parseNumericStats(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number") {
      out[k] = v;
    } else if (typeof v === "string" && v !== "" && !isNaN(Number(v))) {
      out[k] = Number(v);
    }
  }
  return out;
}

function buildMlbPlayerStats(boxData: MlbBoxscoreData): Map<string, MlbPlayerEntry> {
  const playerMap = new Map<string, MlbPlayerEntry>();
  for (const side of ["away", "home"] as const) {
    const teamPlayers = boxData.teams?.[side]?.players ?? {};
    for (const playerData of Object.values(teamPlayers)) {
      const playerId = String(playerData.person?.id ?? "");
      if (!playerId || playerId === "undefined") continue;
      const playerName: string = playerData.person?.fullName ?? "";
      const batting = parseNumericStats(playerData.stats?.batting ?? {});
      const pitching = parseNumericStats(playerData.stats?.pitching ?? {});
      playerMap.set(playerId, { id: playerId, name: playerName, batting, pitching });
    }
  }
  return playerMap;
}

function getMlbStatValue(entry: MlbPlayerEntry, market: string): number | null {
  const mapping = MLB_STAT_KEY_MAP[market.toLowerCase().trim()];
  if (!mapping) return null;
  const sourceStats = entry[mapping.source];
  if (mapping.kind === "composite") {
    let total = 0;
    for (const field of mapping.fields) {
      const v = sourceStats[field];
      if (v === undefined || v === null || isNaN(v)) return null;
      total += v;
    }
    return total;
  }
  const val = sourceStats[mapping.field];
  if (val === undefined || val === null || isNaN(val)) return null;
  return val;
}

// ── ESPN Stats API integration ─────────────────────────────────────────────────

const ESPN_KEY_MAP: Record<string, string> = {
  PTS: "points",       POINTS: "points",
  REB: "rebounds",     TOTALREBOUNDS: "rebounds",  REBOUNDS: "rebounds",
  AST: "assists",      ASSISTS: "assists",
  BLK: "blocks",       BLOCKEDSHOTS: "blocks",     BLOCKS: "blocks",
  STL: "steals",       STEALS: "steals",
  "3PM": "threes",     "3PT": "threes",            TPM: "threes",
  THREEPOINTERSMADE: "threes",
  "THREEPOINTFIELDGOALSMADE-THREEPOINTFIELDGOALSATTEMPTED": "threes",
  THREEPOINTFIELDGOALSMADE: "threes",
};

const STAT_COMPONENTS: Record<string, string[]> = {
  points:      ["points"],
  rebounds:    ["rebounds"],
  assists:     ["assists"],
  threes:      ["threes"],
  steals:      ["steals"],
  blocks:      ["blocks"],
  pts_reb:     ["points", "rebounds"],
  pts_ast:     ["points", "assists"],
  pts_reb_ast: ["points", "rebounds", "assists"],
  reb_ast:     ["rebounds", "assists"],
  stl_blk:     ["steals", "blocks"],
};

interface PlayerEntry {
  id: string;
  name: string;
  rawStats: Record<string, number>;
}

function getEspnBoxScoreUrl(gameId: string, sport: string): string {
  const cleanId = String(gameId).replace(/^(nba-|ncaab-|game-)/i, "");
  if (sport === "ncaab") {
    return `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${cleanId}`;
  }
  return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${cleanId}`;
}

type BoxScoreData = {
  boxscore?: {
    players?: Array<{
      statistics?: Array<{
        keys?: string[];
        athletes?: Array<{
          athlete?: { id?: unknown; displayName?: string; shortName?: string };
          stats?: string[];
        }>;
      }>;
    }>;
  };
};

function buildPlayerStatsFromBoxScore(data: unknown): Map<string, PlayerEntry> {
  const playerMap = new Map<string, PlayerEntry>();
  const d = data as BoxScoreData;
  for (const teamData of (d.boxscore?.players ?? [])) {
    for (const statGroup of (teamData.statistics ?? [])) {
      const keys: string[] = statGroup.keys ?? [];
      for (const athlete of (statGroup.athletes ?? [])) {
        const athleteId = String(athlete.athlete?.id ?? "");
        if (!athleteId || athleteId === "undefined") continue;
        const athleteName: string = athlete.athlete?.displayName ?? athlete.athlete?.shortName ?? "";
        const existing = playerMap.get(athleteId) ?? { id: athleteId, name: athleteName, rawStats: {} };
        keys.forEach((key, idx) => {
          const raw = String(athlete.stats?.[idx] ?? "0");
          const num = parseFloat(raw.replace(/[^0-9.-]/g, ""));
          const k = key.toUpperCase();
          if (!isNaN(num) && !(k in existing.rawStats)) {
            existing.rawStats[k] = num;
          }
        });
        playerMap.set(athleteId, existing);
      }
    }
  }
  return playerMap;
}

function buildCanonicalStats(rawStats: Record<string, number>): Record<string, number> {
  const canonical: Record<string, number> = {};
  for (const [key, val] of Object.entries(rawStats)) {
    const mapped = ESPN_KEY_MAP[key];
    if (mapped && !(mapped in canonical)) {
      canonical[mapped] = val;
    }
  }
  return canonical;
}

function computeFinalStat(canonical: Record<string, number>, statType: string): number | null {
  const components = STAT_COMPONENTS[statType];
  if (!components) return null;
  let total = 0;
  for (const c of components) {
    if (!(c in canonical)) return null;
    total += canonical[c];
  }
  return parseFloat(total.toFixed(1));
}

async function fetchBoxScore(gameId: string, sport: string): Promise<unknown | null> {
  const url = getEspnBoxScoreUrl(gameId, sport);
  console.log("[GRADE] Fetching box score:", url);
  let data: unknown;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error("[GRADE] ESPN returned:", res.status, "for game", gameId, "sport:", sport);
      return null;
    }
    data = await res.json();
  } catch (err) {
    console.error("[GRADE] Fetch failed:", (err as Error).message);
    return null;
  }
  type CompStatus = { type?: { description?: string; completed?: boolean }; completed?: boolean };
  type SummaryData = BoxScoreData & { header?: { competitions?: Array<{ status?: CompStatus }> } };
  const d = data as SummaryData;
  const comp = d.header?.competitions?.[0];
  const statusDesc: string = comp?.status?.type?.description ?? "";
  const isCompleted: boolean = comp?.status?.type?.completed === true || comp?.status?.completed === true;
  const descLower = statusDesc.toLowerCase();
  const isFinal = isCompleted || descLower.startsWith("final") || descLower === "full time";
  if (!isFinal) {
    console.log("[GRADE] Game not final yet:", gameId, statusDesc, "sport:", sport);
    return null;
  }
  if (!d.boxscore?.players?.length) {
    console.warn("[GRADE] No box score data for game", gameId, "sport:", sport);
    return null;
  }
  return data;
}

export async function gradePersistedPlays(
  storage: IStorage
): Promise<{ settled: number; failed: number; skipped: number }> {
  let settled = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const { plays: pending } = await storage.getPlays({ limit: 500, settled: "pending" });
    console.log("[ANALYTICS_QUERY] getPlays(pending) returned", pending.length, "plays");
    if (pending.length === 0) return { settled, failed, skipped };

    console.log("[GRADE] Pending persisted plays to grade:", pending.length);

    const byGameAndSport = new Map<string, typeof pending>();
    for (const play of pending) {
      if (!play.gameId) {
        console.warn("[GRADE] Play missing gameId, skipping:", play.id, play.playerName);
        skipped++;
        continue;
      }
      if (!play.playerId) {
        console.warn("[GRADE] Play missing playerId, skipping:", play.id, play.playerName);
        skipped++;
        continue;
      }
      const key = `${play.sport}::${play.gameId}`;
      const list = byGameAndSport.get(key) ?? [];
      list.push(play);
      byGameAndSport.set(key, list);
    }

    for (const [gameKey, plays] of Array.from(byGameAndSport)) {
      const [sport, gameId] = gameKey.split("::") as [string, string];

      // ── MLB branch ───────────────────────────────────────────────────────
      if (sport === "mlb") {
        let mlbData: MlbBoxscoreData | null = null;
        try {
          mlbData = await fetchMlbBoxScore(gameId);
        } catch (err) {
          console.warn("[GRADE MLB] Error fetching box score for game", gameId, ":", (err as Error).message);
          failed += plays.length;
          continue;
        }

        if (!mlbData) {
          continue;
        }

        const mlbPlayerMap = buildMlbPlayerStats(mlbData);
        console.log("[GRADE MLB] Player stats built for", mlbPlayerMap.size, "players, game:", gameId);

        for (const play of plays) {
          try {
            // Req 2 — idempotent grading lock: belt-and-suspenders in case query let a settled play through
            if (play.settledAt !== null && play.settledAt !== undefined) {
              console.warn("[GRADE MLB] Play already settled, skipping:", play.id, play.playerName);
              skipped++;
              continue;
            }

            const playerEntry = mlbPlayerMap.get(String(play.playerId!));
            if (!playerEntry) {
              console.warn("[GRADE MLB] playerId", play.playerId, "not found in box score for game", gameId,
                "— available IDs:", Array.from(mlbPlayerMap.keys()).slice(0, 5).join(", "));
              failed++;
              continue;
            }

            const market = (play.market ?? "").trim();
            const finalStat = getMlbStatValue(playerEntry, market);
            if (finalStat === null) {
              const availableBatting = Object.keys(playerEntry.batting).join(", ");
              const availablePitching = Object.keys(playerEntry.pitching).join(", ");
              console.warn("[GRADE MLB] Could not resolve market:", market,
                "player:", play.playerName,
                "— batting:", availableBatting, "pitching:", availablePitching);
              skipped++;
              continue;
            }

            const line = Number(play.line);
            const direction = (play.direction ?? "").toLowerCase().trim();

            let result: "hit" | "miss" | "push";
            if (finalStat === line) {
              result = "push";
            } else if (direction === "over" && finalStat > line) {
              result = "hit";
            } else if (direction === "under" && finalStat < line) {
              result = "hit";
            } else {
              result = "miss";
            }

            // Req 5 — post-grade validation: ensure finalStat is finite and result is valid
            const VALID_RESULTS = new Set<string>(["hit", "miss", "push"]);
            if (!Number.isFinite(finalStat)) {
              console.error(`[MLB GRADE FAILURE] play=${play.id} player=${play.playerName} — finalStat=${finalStat} is not finite`);
              failed++;
              continue;
            }
            if (!VALID_RESULTS.has(result)) {
              console.error(`[MLB GRADE FAILURE] play=${play.id} player=${play.playerName} — result="${result}" is not a valid outcome`);
              failed++;
              continue;
            }

            console.log("[GRADE MLB]", play.playerName, market,
              "final:", finalStat, "vs line:", line, "direction:", direction, "→", result);

            await storage.settlePlay(play.id, result, finalStat, new Date());
            console.log("[GRADING_RESULT]", JSON.stringify({ sport: "MLB", playId: play.id, player: play.playerName, market, line, direction, finalStat, result, gameId, persisted: true }));
            settled++;
          } catch (err) {
            console.warn("[GRADE MLB] Error grading play", play.id, ":", (err as Error).message);
            failed++;
          }
        }
        continue;
      }

      // ── NBA / NCAAB branch (ESPN) ─────────────────────────────────────────
      let data: unknown | null = null;
      try {
        data = await fetchBoxScore(gameId, sport);
      } catch (err) {
        console.warn("[GRADE] Error fetching box score for game", gameId, "sport:", sport, ":", (err as Error).message);
        failed += plays.length;
        continue;
      }

      if (!data) {
        continue;
      }

      const playerMap = buildPlayerStatsFromBoxScore(data);
      console.log("[GRADE] Player stats built for", playerMap.size, "players, game:", gameId, "sport:", sport);

      // Build internal DB player ID → ESPN athlete ID mapping for this batch
      const internalToEspnId = new Map<number, number>();
      for (const play of plays) {
        if (play.playerId && !internalToEspnId.has(Number(play.playerId))) {
          const dbPlayer = await storage.getPlayer(Number(play.playerId)).catch(() => undefined);
          if (dbPlayer?.espnAthleteId) {
            internalToEspnId.set(Number(play.playerId), dbPlayer.espnAthleteId);
          }
        }
      }

      const normalizeName = (s: string) =>
        s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
          .replace(/['.'\-\s]+/g, "").replace(/jr$|sr$|ii$|iii$|iv$/, "");

      for (const play of plays) {
        try {
          const espnId = play.playerId ? internalToEspnId.get(Number(play.playerId)) : undefined;
          let byId = espnId != null ? playerMap.get(String(espnId)) : undefined;

          // Fallback: name-based lookup when ESPN ID is missing or not found in box score
          if (!byId && play.playerName) {
            const normalTarget = normalizeName(play.playerName);
            byId = Array.from(playerMap.values()).find(
              entry => normalizeName(entry.name) === normalTarget
            );
            if (byId) {
              console.log("[GRADE] Name-fallback match for", play.playerName, "→ espnId", byId.id);
            }
          }

          if (!byId) {
            console.warn("[GRADE] playerId", play.playerId, "(espnId:", espnId ?? "not found",
              ") not found in box score for game", gameId,
              "— available IDs:", Array.from(playerMap.keys()).slice(0, 5).join(", "));
            failed++;
            continue;
          }

          const canonical = buildCanonicalStats(byId.rawStats);
          const marketKey = (play.market ?? "").toLowerCase().trim();

          if (!STAT_COMPONENTS[marketKey]) {
            console.warn("[GRADE] Unsupported market:", marketKey, "for play", play.id, "— skipping");
            skipped++;
            continue;
          }

          const finalStat = computeFinalStat(canonical, marketKey);
          if (finalStat === null) {
            console.warn("[GRADE] Could not compute finalStat for market:", marketKey,
              "player:", play.playerName,
              "— available canonical stats:", Object.keys(canonical).join(", "));
            failed++;
            continue;
          }

          const line = Number(play.line);
          const direction = (play.direction ?? "").toLowerCase().trim();

          let result: "hit" | "miss" | "push";
          if (finalStat === line) {
            result = "push";
          } else if (direction === "over" && finalStat > line) {
            result = "hit";
          } else if (direction === "under" && finalStat < line) {
            result = "hit";
          } else {
            result = "miss";
          }

          console.log("[GRADE]", play.playerName, marketKey,
            "final:", finalStat, "vs line:", line, "direction:", direction, "→", result);

          await storage.settlePlay(play.id, result, finalStat, new Date());
          console.log("[GRADING_RESULT]", JSON.stringify({ sport: play.sport?.toUpperCase(), playId: play.id, player: play.playerName, market: marketKey, line, direction, finalStat, result, gameId, persisted: true }));
          if (play.sport === "nba") {
            const d = direction.toUpperCase();
            if (d === "OVER" || d === "UNDER") {
              recordDirectionalResult(d, result === "hit");
            }
          }
          settled++;
        } catch (err) {
          console.warn("[GRADE] Error grading play", play.id, ":", (err as Error).message);
          failed++;
        }
      }
    }

    if (settled > 0 || failed > 0 || skipped > 0) {
      console.log(`[GRADE] Complete — settled:${settled} failed:${failed} skipped:${skipped}`);
    }
  } catch (err) {
    console.warn("[GRADE] Top-level error:", (err as Error).message);
  }

  return { settled, failed, skipped };
}
