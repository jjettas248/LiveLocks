import type { IStorage } from "./storage";

const normName = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");

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

function parseStatMap(statistics: any[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const s of statistics) {
    const name = (s.name || "").toLowerCase();
    const val = parseFloat(s.displayValue ?? s.value ?? "0");
    map[name] = isNaN(val) ? 0 : val;
  }
  return map;
}

function getFinalStat(statMap: Record<string, number>, statType: string): number | null {
  const components = STAT_COMPONENTS[statType];
  if (!components) return null;
  const componentMap: Record<string, string> = {
    points: "points",
    rebounds: "rebounds",
    assists: "assists",
    threes: "threepointersmade",
    steals: "steals",
    blocks: "blockedshots",
  };
  let total = 0;
  for (const c of components) {
    const key = componentMap[c] ?? c;
    if (!(key in statMap)) return null;
    total += statMap[key];
  }
  return total;
}

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

    for (const [gameId, alerts] of byGameId) {
      try {
        const res = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`,
          { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) { failed++; continue; }
        const data = await res.json() as any;

        const statusDesc: string = data.header?.competitions?.[0]?.status?.type?.description ?? "";
        if (statusDesc !== "Final") continue;

        const boxscorePlayers: any[] = [];
        for (const team of (data.boxscore?.players ?? [])) {
          for (const statGroup of (team.statistics ?? [])) {
            for (const athlete of (statGroup.athletes ?? [])) {
              boxscorePlayers.push(athlete);
            }
          }
        }

        for (const alert of alerts) {
          const normAlert = normName(alert.playerName);
          const match = boxscorePlayers.find((a: any) => {
            const athleteName = a.athlete?.displayName ?? a.athlete?.shortName ?? "";
            return normName(athleteName) === normAlert;
          });

          if (!match) { failed++; continue; }

          const statistics: any[] = match.statistics ?? [];
          const statMap = parseStatMap(statistics);
          const finalStat = getFinalStat(statMap, alert.statType);

          if (finalStat === null) { failed++; continue; }

          const line = Number(alert.line);
          const betDir = alert.betDirection;
          const hit = betDir === "over" ? finalStat > line : finalStat < line;

          await storage.savePlayResult(alert.id, finalStat, hit);
          resolved++;
        }
      } catch (err) {
        failed++;
        console.warn(`[analyticsResolver] Failed game ${gameId}:`, (err as any).message);
      }
    }

    if (resolved > 0 || failed > 0) {
      console.log(`[analyticsResolver] Auto-resolved ${resolved} plays (${failed} failed/pending)`);
    }
  } catch (err) {
    console.warn("[analyticsResolver] Error:", (err as any).message);
  }
}
