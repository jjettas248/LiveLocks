import type { IStorage } from "./storage";

const normName = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");

// ── ESPN key → canonical stat name map ──────────────────────────────────────
const ESPN_KEY_MAP: Record<string, string> = {
  PTS: "points",       POINTS: "points",
  REB: "rebounds",     TOTALREBOUNDS: "rebounds",  REBOUNDS: "rebounds",
  AST: "assists",      ASSISTS: "assists",
  BLK: "blocks",       BLOCKEDSHOTS: "blocks",     BLOCKS: "blocks",
  STL: "steals",       STEALS: "steals",
  "3PM": "threes",     "3PT": "threes",            TPM: "threes",
  THREEPOINTERSMADE: "threes",
};

// ── Stat combinations used by LiveLocks markets ──────────────────────────────
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

// ── Parse ESPN box score → player stat map (keyed by athlete ID) ─────────────
// ESPN boxscore.players format:
//   team → statistics[]: { keys: string[], athletes[]: { athlete: {...}, stats: string[] } }
// The keys array indexes into each athlete's stats array.
function buildPlayerStatsFromBoxScore(data: any): Map<string, PlayerEntry> {
  const playerMap = new Map<string, PlayerEntry>();

  for (const teamData of (data.boxscore?.players ?? [])) {
    for (const statGroup of (teamData.statistics ?? [])) {
      const keys: string[] = statGroup.keys ?? [];
      if (keys.length > 0) {
        console.log("[SETTLE] ESPN stat keys:", JSON.stringify(keys));
      }

      for (const athlete of (statGroup.athletes ?? [])) {
        const athleteId = String(athlete.athlete?.id ?? "");
        const athleteName: string =
          athlete.athlete?.displayName ?? athlete.athlete?.shortName ?? "";
        if (!athleteId || athleteId === "undefined") continue;

        const existing = playerMap.get(athleteId) ?? {
          id: athleteId, name: athleteName, rawStats: {},
        };

        // Map each key by index to its numeric value
        keys.forEach((key, idx) => {
          const raw = String(athlete.stats?.[idx] ?? "0");
          // Ignore composite formats like "3-5" (FG) or "35:30" (MIN)
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

// ── Convert raw ESPN stats → canonical LiveLocks stat names ──────────────────
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

// ── Compute final combined stat for a given market key ────────────────────────
function computeFinalStat(
  canonical: Record<string, number>,
  statType: string
): number | null {
  const components = STAT_COMPONENTS[statType];
  if (!components) return null;
  let total = 0;
  for (const c of components) {
    if (!(c in canonical)) return null;
    total += canonical[c];
  }
  return parseFloat(total.toFixed(1));
}

// ── Find player by ID, then fall back to name matching ───────────────────────
function findPlayer(
  playerId: string | number | null | undefined,
  playerName: string,
  playerMap: Map<string, PlayerEntry>
): PlayerEntry | null {
  // 1. Try exact ID match
  if (playerId != null) {
    const byId = playerMap.get(String(playerId));
    if (byId) return byId;
  }

  // 2. Normalized full name match
  const normTarget = normName(playerName);
  const nameParts = playerName.toLowerCase().split(/\s+/);
  const lastName = nameParts[nameParts.length - 1] ?? "";

  for (const [, p] of Array.from(playerMap)) {
    const normP = normName(p.name);
    if (normP === normTarget) {
      console.log(`[SETTLE] Matched by name: ${playerName} → ${p.name}`);
      return p;
    }
    // Last-name fallback (only for surnames longer than 3 chars)
    if (lastName.length > 3 && normP.includes(normName(lastName))) {
      console.log(`[SETTLE] Matched by last name: ${playerName} → ${p.name}`);
      return p;
    }
  }

  return null;
}

// ── Fetch ESPN box score for a single game; returns null if not final ─────────
async function fetchBoxScore(gameId: string): Promise<any | null> {
  const cleanId = String(gameId).replace(/^(nba-|ncaab-|game-)/i, "");
  const url =
    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${cleanId}`;
  console.log("[SETTLE] Fetching box score:", url);

  let data: any;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error("[SETTLE] ESPN returned:", res.status, "for game", cleanId);
      return null;
    }
    data = await res.json();
  } catch (err) {
    console.error("[SETTLE] Fetch failed:", (err as any).message);
    return null;
  }

  const statusDesc: string =
    data.header?.competitions?.[0]?.status?.type?.description ?? "";
  if (statusDesc !== "Final" && statusDesc !== "Final/OT") {
    console.log("[SETTLE] Game not final yet:", cleanId, statusDesc);
    return null;
  }

  if (!data?.boxscore?.players?.length) {
    console.warn("[SETTLE] No box score data for game", cleanId);
    return null;
  }

  console.log("[SETTLE] Box score found, teams:", data.boxscore.players.length);
  return data;
}

// ── Settle play_alerts table (original — uses savePlayResult) ─────────────────
export async function autoResolveAlerts(storage: IStorage): Promise<void> {
  try {
    const unresolved = await storage.getUnresolvedAlerts();
    if (unresolved.length === 0) return;

    const byGameId = new Map<string, typeof unresolved>();
    for (const alert of unresolved) {
      const list = byGameId.get(alert.gameId) ?? [];
      list.push(alert);
      byGameId.set(alert.gameId, list);
    }

    let resolved = 0;
    let failed = 0;

    for (const [gameId, alerts] of Array.from(byGameId)) {
      try {
        const data = await fetchBoxScore(gameId);
        if (!data) { failed += alerts.length; continue; }

        const playerMap = buildPlayerStatsFromBoxScore(data);
        console.log("[SETTLE/alerts] Player stats built for", playerMap.size, "players");

        for (const alert of alerts) {
          const entry = findPlayer(null, alert.playerName, playerMap);
          if (!entry) {
            console.warn("[SETTLE/alerts] Player not found:", alert.playerName,
              "— Available:", Array.from(playerMap.values()).slice(0, 3).map(p => p.name).join(", "));
            failed++;
            continue;
          }

          const canonical = buildCanonicalStats(entry.rawStats);
          const finalStat = computeFinalStat(canonical, alert.statType);

          if (finalStat === null) {
            console.warn("[SETTLE/alerts] Market not found:", alert.statType,
              "— Available:", Object.keys(canonical).join(", "));
            failed++;
            continue;
          }

          const line = Number(alert.line);
          const betDir = (alert.betDirection ?? "").toLowerCase();
          const hit = betDir === "over" ? finalStat > line : finalStat < line;

          console.log("[SETTLE/alerts]", alert.playerName, alert.statType,
            "final:", finalStat, "vs line:", line, "→", hit ? "HIT" : "MISS");

          await storage.savePlayResult(alert.id, finalStat, hit);
          resolved++;
        }
      } catch (err) {
        failed++;
        console.warn(`[analyticsResolver] Failed game ${gameId}:`, (err as any).message);
      }
    }

    if (resolved > 0 || failed > 0) {
      console.log(`[analyticsResolver] Auto-resolved ${resolved} alerts (${failed} failed/pending)`);
    }
  } catch (err) {
    console.warn("[analyticsResolver] Error:", (err as any).message);
  }
}

// ── Settle persisted_plays table — superseded by gradePersistedPlays service ──
// This function is kept for backward compatibility but delegates to the canonical
// grading path in server/services/gradePersistedPlays.ts.
export async function autoSettlePersistedPlays(
  storage: IStorage
): Promise<{ settled: number; failed: number }> {
  const { gradePersistedPlays } = await import("./services/gradePersistedPlays");
  const result = await gradePersistedPlays(storage);
  return { settled: result.settled, failed: result.failed };
}
