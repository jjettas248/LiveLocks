import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@shared/routes";
import type {
  CalculateProbabilityRequest,
  CalculateProbabilityResponse,
  LiveGame,
  LivePlayerStat,
  OddsLine,
  ParlayPickInput,
  ParlayResult,
  Player,
} from "@shared/schema";

export function usePlayers() {
  return useQuery({
    queryKey: [api.players.list.path],
    queryFn: async (): Promise<Player[]> => {
      const res = await fetch(api.players.list.path);
      if (!res.ok) throw new Error("Failed to fetch players");
      return res.json();
    },
  });
}

export function useTeams() {
  return useQuery({
    queryKey: [api.teams.list.path],
    queryFn: async (): Promise<string[]> => {
      const res = await fetch(api.teams.list.path);
      if (!res.ok) throw new Error("Failed to fetch teams");
      return res.json();
    },
  });
}

export function useCalculateProbability() {
  return useMutation({
    mutationFn: async (data: CalculateProbabilityRequest): Promise<CalculateProbabilityResponse> => {
      const res = await fetch(api.calculator.calculate.path, {
        method: api.calculator.calculate.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).message || "Failed to calculate probability");
      }
      return res.json();
    },
  });
}

export function useLiveGames() {
  return useQuery({
    queryKey: [api.liveGames.list.path],
    queryFn: async (): Promise<LiveGame[]> => {
      const res = await fetch(api.liveGames.list.path);
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 30000,
    staleTime: 15000,
  });
}

export function useLiveStats(gameId: string | undefined) {
  return useQuery({
    queryKey: ["/api/live-stats", gameId],
    queryFn: async (): Promise<LivePlayerStat[]> => {
      if (!gameId) return [];
      const res = await fetch(`/api/live-stats/${gameId}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!gameId,
    refetchInterval: false,
    staleTime: 30000,
  });
}

// playerTeam / opponentTeam are DB abbreviations (e.g. "GSW", "MEM").
// A game tile doesn't need to be selected — odds fetch as soon as a player + opponent are chosen.
export function usePlayerOdds(
  playerTeam: string | undefined,
  opponentTeam: string | undefined,
  playerName: string | undefined,
  statType: string | undefined,
  isLive?: boolean
) {
  const enabled = !!playerTeam && !!opponentTeam && !!playerName && !!statType;
  return useQuery({
    queryKey: ["/api/odds", playerTeam, opponentTeam, playerName, statType],
    queryFn: async (): Promise<Record<string, OddsLine>> => {
      if (!enabled) return {};
      const params = new URLSearchParams({
        playerTeam: playerTeam!,
        opponentTeam: opponentTeam!,
        playerName: playerName!,
        statType: statType!,
      });
      const res = await fetch(`/api/odds?${params}`);
      if (!res.ok) return {};
      const data = await res.json();
      // Strip internal error hint keys before returning
      if (data._error) return {};
      return data;
    },
    enabled,
    staleTime: isLive ? 2 * 60 * 1000 : 5 * 60 * 1000,
    refetchInterval: isLive ? 90 * 1000 : false,
    retry: 1,
  });
}

// Fetch live game-level spread and total from The Odds API.
// Enabled whenever both team abbreviations are known — no user input needed.
export function useGameLines(
  team: string | undefined,
  opponent: string | undefined
) {
  const enabled = !!team && !!opponent;
  return useQuery({
    queryKey: ["/api/game-lines", team, opponent],
    queryFn: async (): Promise<{ spread: number | null; total: number | null; favorite: string | null }> => {
      if (!enabled) return { spread: null, total: null, favorite: null };
      const params = new URLSearchParams({ team: team!, opponent: opponent! });
      const res = await fetch(`/api/game-lines?${params}`);
      if (!res.ok) return { spread: null, total: null, favorite: null };
      return res.json();
    },
    enabled,
    staleTime: 4 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useCalculateParlay() {
  return useMutation({
    mutationFn: async (picks: ParlayPickInput[]): Promise<ParlayResult> => {
      const res = await fetch("/api/parlay/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ picks }),
      });
      if (!res.ok) throw new Error("Failed to calculate parlay");
      return res.json();
    },
  });
}
