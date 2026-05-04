import { useQuery } from "@tanstack/react-query";

/**
 * [PRIMARY ROI EXCLUSION v1] Mirror of the server PublicAnalyticsSummary.
 *
 * `last7Days` is the headline / Core Engine ROI — excludes home_runs and
 * batter_strikeouts so the dashboard reflects markets the engine is
 * actually optimized for. `last7DaysFull` keeps the full all-markets
 * numbers for admin / internal observability and tooltips that explain
 * the exclusion. `byMarket` powers per-market breakdown panels and
 * carries an `excludedFromPrimary` flag per row.
 */
export type PublicAnalyticsSummary = {
  last7Days: { winRate: number; roi: number; plays: number };
  last7DaysFull: { winRate: number; roi: number; plays: number };
  excludedFromPrimary: readonly string[];
  byMarket: Array<{
    market: string;
    excludedFromPrimary: boolean;
    metrics: {
      totalBets: number;
      totalProfit: number;
      totalStake: number;
      roi: number;
      hitRate: number;
      hits: number;
      misses: number;
      pushes: number;
      pending: number;
    };
  }>;
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

export function usePublicAnalytics(enabled = true) {
  return useQuery<PublicAnalyticsSummary>({
    queryKey: ["/api/public-analytics/summary"],
    refetchInterval: 300_000,
    enabled,
  });
}
