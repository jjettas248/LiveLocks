import type { IStorage } from "../storage";

const ESPN_KEY_MAP: Record<string, string> = {
  PTS: "points",       POINTS: "points",
  REB: "rebounds",     TOTALREBOUNDS: "rebounds",  REBOUNDS: "rebounds",
  AST: "assists",      ASSISTS: "assists",
  BLK: "blocks",       BLOCKEDSHOTS: "blocks",     BLOCKS: "blocks",
  STL: "steals",       STEALS: "steals",
  "3PM": "threes",     "3PT": "threes",            TPM: "threes",
  THREEPOINTERSMADE: "threes",
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

      for (const play of plays) {
        try {
          const byId = playerMap.get(String(play.playerId!));
          if (!byId) {
            console.warn("[GRADE] playerId", play.playerId, "not found in box score for game", gameId,
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
