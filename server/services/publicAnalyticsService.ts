import { db } from "../db";
import { persistedPlays } from "@shared/schema";
import { sql, desc } from "drizzle-orm";
import { daysAgoET } from "../utils/dateUtils";

export type PublicAnalyticsSummary = {
  last7Days: { winRate: number; roi: number; plays: number };
  bySport: Array<{ sport: string; winRate: number; roi: number; plays: number }>;
  recentResults: Array<{
    id: string;
    sport: string;
    player: string;
    market: string;
    side: string;
    line: string;
    probability: number;
    result: string;
    finalStat: number | null;
    settledAt: string;
  }>;
};

export async function getPublicAnalyticsSummary(): Promise<PublicAnalyticsSummary> {
  const sevenDaysStr = daysAgoET(7);

  const settled = await db
    .select()
    .from(persistedPlays)
    .where(sql`${persistedPlays.result} IS NOT NULL AND ${persistedPlays.gameDate} >= ${sevenDaysStr}`)
    .orderBy(desc(persistedPlays.settledAt))
    .limit(2000);

  const totalPlays = settled.length;
  const wins = settled.filter(p => p.result === "hit").length;
  const losses = settled.filter(p => p.result === "miss").length;
  const decidedPlays = wins + losses;
  const winRate = decidedPlays > 0 ? Math.round((wins / decidedPlays) * 1000) / 10 : 0;
  const roi = decidedPlays > 0 ? Math.round(((wins * 0.909 - losses) / decidedPlays) * 1000) / 10 : 0;

  const sportMap = new Map<string, { wins: number; losses: number; total: number }>();
  for (const p of settled) {
    const sport = (p.sport ?? "nba").toUpperCase();
    if (!sportMap.has(sport)) sportMap.set(sport, { wins: 0, losses: 0, total: 0 });
    const entry = sportMap.get(sport)!;
    entry.total++;
    if (p.result === "hit") entry.wins++;
    if (p.result === "miss") entry.losses++;
  }

  const bySport = Array.from(sportMap.entries()).map(([sport, data]) => {
    const decided = data.wins + data.losses;
    return {
      sport,
      winRate: decided > 0 ? Math.round((data.wins / decided) * 1000) / 10 : 0,
      roi: decided > 0 ? Math.round(((data.wins * 0.909 - data.losses) / decided) * 1000) / 10 : 0,
      plays: data.total,
    };
  });

  const recentResults = settled.slice(0, 5).map(p => ({
    id: p.id,
    sport: (p.sport ?? "nba").toUpperCase(),
    player: p.playerName,
    market: p.market,
    side: p.direction,
    line: String(p.line),
    probability: p.prob ? parseFloat(String(p.prob)) : 0,
    result: p.result ?? "pending",
    finalStat: p.finalStat ? parseFloat(String(p.finalStat)) : null,
    settledAt: p.settledAt ? p.settledAt.toISOString() : "",
  }));

  return { last7Days: { winRate, roi, plays: totalPlays }, bySport, recentResults };
}
