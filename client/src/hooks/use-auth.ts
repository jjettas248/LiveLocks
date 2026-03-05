import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, getAuthToken, setAuthToken, clearAuthToken } from "@/lib/queryClient";

export interface AuthUser {
  id: number;
  email: string;
  isAdmin: boolean;
  subscriptionTier: string | null;
  playsUsed: number;
  isNewProUser: boolean;
  upgradedAt: string | null;
}

async function apiFetch(path: string, options?: RequestInit) {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(path, {
    credentials: "include",
    ...options,
    headers,
  });
  return res;
}

export function useAuth() {
  const { data: user, isLoading } = useQuery<AuthUser | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const res = await apiFetch("/api/auth/me");
      if (res.status === 401) return null;
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const loginMutation = useMutation({
    mutationFn: async (payload: { email?: string; phone?: string; password: string }) => {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error || "Login failed");
      }
      const data = await res.json();
      if (data.token) setAuthToken(data.token);
      return data as AuthUser;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/auth/me"], data);
    },
  });

  const registerMutation = useMutation({
    mutationFn: async (payload: { email: string; password: string; smsConsent: boolean; phoneNumber?: string }) => {
      const res = await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error || "Registration failed");
      }
      const data = await res.json();
      if (data.token) setAuthToken(data.token);
      return data as AuthUser;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/auth/me"], data);
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiFetch("/api/auth/logout", { method: "POST" });
      clearAuthToken();
    },
    onSuccess: () => {
      queryClient.setQueryData(["/api/auth/me"], null);
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
  });

  return {
    user: user ?? null,
    isLoading,
    login: loginMutation.mutateAsync,
    loginPending: loginMutation.isPending,
    loginError: loginMutation.error,
    register: registerMutation.mutateAsync,
    registerPending: registerMutation.isPending,
    registerError: registerMutation.error,
    logout: logoutMutation.mutate,
    logoutPending: logoutMutation.isPending,
  };
}
