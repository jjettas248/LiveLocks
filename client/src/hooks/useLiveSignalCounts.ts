import { useQuery } from "@tanstack/react-query";

export type LiveSignalCounts = {
  nbaElite: number;
  ncaabElite: number;
  mlbElite: number;
  totalLive: number;
};

export function useLiveSignalCounts() {
  return useQuery<LiveSignalCounts>({
    queryKey: ["/api/live-signal-counts"],
    refetchInterval: 20_000,
  });
}
