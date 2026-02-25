import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@shared/routes";
import type { CalculateProbabilityRequest, CalculateProbabilityResponse, LiveGame } from "@shared/schema";

export function usePlayers() {
  return useQuery({
    queryKey: [api.players.list.path],
    queryFn: async () => {
      const res = await fetch(api.players.list.path);
      if (!res.ok) throw new Error("Failed to fetch players");
      return res.json() as Promise<import("@shared/schema").Player[]>;
    },
  });
}

export function useTeams() {
  return useQuery({
    queryKey: [api.teams.list.path],
    queryFn: async () => {
      const res = await fetch(api.teams.list.path);
      if (!res.ok) throw new Error("Failed to fetch teams");
      return res.json() as Promise<string[]>;
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
        const errorData = await res.json().catch(() => ({}));
        throw new Error((errorData as any).message || "Failed to calculate probability");
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
    refetchInterval: 30000, // refresh every 30s
    staleTime: 15000,
  });
}
