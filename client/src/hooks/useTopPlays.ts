import { useQuery } from "@tanstack/react-query";

export type UnifiedTopPlay = {
  id: string;
  sport: "NBA" | "NCAAB" | "MLB";
  playerOrTeam: string;
  marketLabel: string;
  side: string;
  line?: number | string;
  probability: number;
  edge: number;
  projection?: number | null;
  summary?: string;
  routeTarget: string;
  confidenceTier: "ELITE" | "STRONG" | "VALUE" | "NO_EDGE";
  updatedAt: string;
  currentStats?: { ab: number; h: number; hr: number; tb: number; bb: number; rbi: number; k: number; sb: number } | null;
  matchup?: string;
};

export function useTopPlays() {
  return useQuery<{ plays: UnifiedTopPlay[] }>({
    queryKey: ["/api/top-plays"],
    refetchInterval: 60_000,
  });
}
