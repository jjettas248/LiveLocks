import { useQuery } from "@tanstack/react-query";

export type UnifiedTopPlay = {
  id: string;
  sport: "NBA" | "NCAAB" | "MLB";
  playerOrTeam: string;
  market?: string;
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
  gameId?: string;
  playerId?: string | number;
  team?: string;
  sportsbook?: string;
  betDirection?: string;
  currentStats?: { ab: number; h: number; hr: number; tb: number; bb: number; rbi: number; k: number; sb: number } | null;
  lastABContact?: {
    exitVelo: number | null;
    launchAngle: number | null;
    batSpeed: number | null;
    distance: number | null;
    barrelPct: number | null;
    hardHitPct: number | null;
    outcome: string | null;
  } | null;
  matchup?: string;
  expansionTier?: string;
  projectionSource?: string;
  projectionQuality?: string;
  projectionTrustScore?: number;
};

export function useTopPlays() {
  return useQuery<{ plays: UnifiedTopPlay[] }>({
    queryKey: ["/api/top-plays"],
    refetchInterval: 60_000,
  });
}
