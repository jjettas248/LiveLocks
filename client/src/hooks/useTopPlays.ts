import { useQuery } from "@tanstack/react-query";
import type { LiveEdgePreview } from "@shared/topPlays";

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
  signalScore?: number | null;
  timingContext?: string | null;
  batterArchetype?: string | null;
  pitcherArchetype?: string | null;
  thesis?: string | null;
  isFlagship?: boolean;
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
};

// Server-authoritative discriminant — the client renders from this, it is
// never the security boundary (that's enforced in
// server/services/liveEdgeAccess.ts). "full" carries the complete payload;
// "preview" carries only the sanitized LiveEdgePreview shape.
export type TopPlaysResponse =
  | { access: "full"; plays: UnifiedTopPlay[] }
  | { access: "preview"; preview: LiveEdgePreview };

export function useTopPlays() {
  return useQuery<TopPlaysResponse>({
    queryKey: ["/api/top-plays"],
    refetchInterval: 60_000,
  });
}
