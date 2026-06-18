import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { getAuthToken } from "@/lib/queryClient";
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

function authFetchHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { ...extra };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

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

export class PlayLimitError extends Error {
  constructor(public playsUsed: number, public limit: number) {
    super("PAYWALL_TRIGGER");
    this.name = "PlayLimitError";
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Not authenticated");
    this.name = "UnauthenticatedError";
  }
}

export function useCalculateProbability() {
  return useMutation({
    mutationFn: async (data: CalculateProbabilityRequest): Promise<CalculateProbabilityResponse> => {
      const res = await fetch(api.calculator.calculate.path, {
        method: api.calculator.calculate.method,
        headers: authFetchHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (res.status === 402) {
        const err = await res.json().catch(() => ({}));
        throw new PlayLimitError(err.playsUsedToday ?? err.playsUsed ?? 3, err.limit ?? 3);
      }
      if (res.status === 401) {
        throw new UnauthenticatedError();
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error || (err as any).message || "Failed to calculate probability");
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
      // Surface failures as query errors (not an empty slate) so the UI can show
      // a retry affordance. placeholderData keeps the last good list visible
      // through a transient refetch error.
      if (!res.ok) throw new Error("Failed to load live games");
      return res.json();
    },
    refetchInterval: 30000,
    staleTime: 15000,
    placeholderData: (prev) => prev,
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
    // Freshness Integrity Fix #3.1 — box score must refresh on its own so the
    // stat dots, made-FG counts, and tier transitions stay in sync with live
    // signal recomputes. Dashboard still invalidates on its 15s tick (Fix
    // #3.2) which dedupes against this and just brings the next refetch
    // forward; staleTime stays under both intervals so invalidates always
    // trigger a real network refetch.
    refetchInterval: 15_000,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
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
    // Include isLive in the cache key so live and pre-game results don't collide
    queryKey: ["/api/odds", playerTeam, opponentTeam, playerName, statType, isLive ? "live" : "pre"],
    queryFn: async (): Promise<Record<string, OddsLine> & { _quotaExhausted?: boolean }> => {
      if (!enabled) return {};
      const params = new URLSearchParams({
        playerTeam: playerTeam!,
        opponentTeam: opponentTeam!,
        playerName: playerName!,
        statType: statType!,
      });
      // Pass inPlay flag to server so it fetches live halftime-adjusted lines for active games
      if (isLive) params.set("inPlay", "true");
      const res = await fetch(`/api/odds?${params}`);
      if (!res.ok) return {};
      const data = await res.json();
      // Strip internal error hint keys before returning
      if (data._error) return {};
      // Pass quota exhaustion sentinel through so the UI can display a clear message
      if (data._quotaExhausted) return { _quotaExhausted: true } as any;
      return data;
    },
    enabled,
    // Live games: short stale time + auto-refetch to track line movement
    staleTime: isLive ? 90 * 1000 : 5 * 60 * 1000,
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
        headers: authFetchHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({ picks }),
      });
      if (!res.ok) throw new Error("Failed to calculate parlay");
      return res.json();
    },
  });
}
