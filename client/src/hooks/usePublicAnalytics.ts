import { useQuery } from "@tanstack/react-query";

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

export function usePublicAnalytics() {
  return useQuery<PublicAnalyticsSummary>({
    queryKey: ["/api/public-analytics/summary"],
    refetchInterval: 300_000,
  });
}
