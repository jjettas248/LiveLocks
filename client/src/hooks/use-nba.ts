import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@shared/routes";
import type { CalculateProbabilityRequest, CalculateProbabilityResponse } from "@shared/schema";

export function usePlayers() {
  return useQuery({
    queryKey: [api.players.list.path],
    queryFn: async () => {
      const res = await fetch(api.players.list.path);
      if (!res.ok) throw new Error("Failed to fetch players");
      const data = await res.json();
      return api.players.list.responses[200].parse(data);
    },
  });
}

export function useTeams() {
  return useQuery({
    queryKey: [api.teams.list.path],
    queryFn: async () => {
      const res = await fetch(api.teams.list.path);
      if (!res.ok) throw new Error("Failed to fetch teams");
      const data = await res.json();
      return api.teams.list.responses[200].parse(data);
    },
  });
}

export function useCalculateProbability() {
  return useMutation({
    mutationFn: async (data: CalculateProbabilityRequest) => {
      const res = await fetch(api.calculator.calculate.path, {
        method: api.calculator.calculate.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.message || "Failed to calculate probability");
      }
      
      const responseData = await res.json();
      return api.calculator.calculate.responses[200].parse(responseData);
    },
  });
}
