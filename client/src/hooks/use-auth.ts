import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, getAuthToken, setAuthToken, clearAuthToken } from "@/lib/queryClient";
import { readStoredAttribution } from "@/hooks/useAttributionCapture";
import {
  viewModeListeners,
  getAdminViewMode,
  setAdminViewMode,
  useAdminViewMode,
  type AdminViewMode,
} from "@/lib/adminViewMode";

// Re-exported so no other file's imports need to change — the pure state
// machine lives in adminViewMode.ts (see that file for why), this module
// just re-exports it and layers the queryClient side effects on top below.
export { getAdminViewMode, setAdminViewMode, useAdminViewMode, type AdminViewMode };

export interface AuthUser {
  id: number;
  email: string;
  isAdmin: boolean;
  subscriptionTier: string | null;
  playsUsed: number;
  playsUsedToday: number;
  playsResetDate: string | null;
  isNewProUser: boolean;
  upgradedAt: string | null;
  emailVerified: boolean;
  hasNBA: boolean;
  hasNCAAB: boolean;
  hasMLB: boolean;
  hasUnlimited: boolean;
  hasCompletedOnboarding: boolean;
  sportFocus: string | null;
  // Pass 4 — lifecycle additions. All optional so older payloads (without these keys)
  // continue to type-check. Consumers MUST treat each as possibly undefined/null.
  subscriptionStatus?: "free" | "trialing" | "active" | "canceled" | "past_due" | null;
  subscriptionSource?: "trial" | "direct_paid" | "admin" | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  cancelAtPeriodEnd?: boolean | null;
  convertedToPaidAt?: string | null;
  alertsChannelStatus?: "unavailable" | "available_not_connected" | "connected" | null;
  telegramConnectionStatus?: string | null;
  telegramUsername?: string | null;
  isOnTrial?: boolean;
  isFreeAccount?: boolean;
}

// ── Admin View-As Mode — queryClient side effects ───────────────────────────
// The pure state (get/set/hook) lives in @/lib/adminViewMode; registered here
// (once, at module load) because this is the module that already owns
// queryClient and the AuthUser shape. Fires on every mode change.
viewModeListeners.add(() => {
  // Force every useAuth() consumer to re-derive its `select` output.
  queryClient.invalidateQueries({ queryKey: ["/api/auth/me"], refetchType: "none" });
  // Trigger an immediate setQueryData round-trip so subscribers re-run select.
  const cur = queryClient.getQueryData<AuthUser | null>(["/api/auth/me"]);
  if (cur !== undefined) {
    queryClient.setQueryData(["/api/auth/me"], cur);
  }

  // The view-mode header (attached by queryClient.ts's authHeaders()) changes
  // the server response for /api/top-plays and /api/mlb/edge-feed without
  // changing the query key, so TanStack has no way to know a cached response
  // is stale for the new mode. Cancel in-flight requests FIRST (aborts the
  // underlying fetch via the AbortSignal threaded through getQueryFn) so a
  // response that started under the OLD mode can't resolve and repopulate
  // the cache after the switch, then invalidate + refetch. The default
  // "active" refetchType covers every currently-mounted observer, and the
  // prefix match on ["/api/mlb/edge-feed"] covers both the default view and
  // the ["/api/mlb/edge-feed","market-signals",inningWindow] variant.
  queryClient.cancelQueries({ queryKey: ["/api/top-plays"] });
  queryClient.cancelQueries({ queryKey: ["/api/mlb/edge-feed"] });
  queryClient.invalidateQueries({ queryKey: ["/api/top-plays"] });
  queryClient.invalidateQueries({ queryKey: ["/api/mlb/edge-feed"] });
});

function applyViewMode(real: AuthUser | null, mode: AdminViewMode): AuthUser | null {
  if (!real || mode === "real") return real;
  // Defense in depth — only an authenticated admin may apply overrides.
  if (!real.isAdmin) return real;
  const base = { ...real };
  switch (mode) {
    case "free":
      return {
        ...base,
        isAdmin: false,
        hasMLB: false,
        hasNBA: false,
        hasNCAAB: false,
        hasUnlimited: false,
        subscriptionTier: "free",
        isFreeAccount: true,
        isOnTrial: false,
        subscriptionStatus: "free",
      };
    case "pro_mlb":
      return {
        ...base,
        isAdmin: false,
        hasMLB: true,
        hasNBA: false,
        hasNCAAB: false,
        hasUnlimited: false,
        subscriptionTier: "pro_mlb",
        isFreeAccount: false,
        subscriptionStatus: "active",
      };
    case "all_sports":
      return {
        ...base,
        isAdmin: false,
        hasMLB: true,
        hasNBA: true,
        hasNCAAB: true,
        hasUnlimited: true,
        subscriptionTier: "all_sports",
        isFreeAccount: false,
        subscriptionStatus: "active",
      };
    case "admin":
      return base;
    default:
      return real;
  }
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
  const [viewMode] = useAdminViewMode();
  const { data: user, isLoading } = useQuery<AuthUser | null, Error, AuthUser | null>({
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
    select: (raw) => applyViewMode(raw, viewMode),
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
      // Attach first-touch attribution from localStorage (best-effort).
      const attribution = readStoredAttribution();
      const body = attribution ? { ...payload, attribution } : payload;
      const res = await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(body),
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
      // Clear view-mode override on logout so the next account isn't confused.
      setAdminViewMode("real");
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

// Read the REAL (un-overridden) user — bypasses the view-mode overlay.
// Use sparingly; ONLY for surfaces that must always reflect the actual
// admin identity (e.g. the view-mode switcher itself, or audit banners).
export function useRealUser(): AuthUser | null {
  const { data } = useQuery<AuthUser | null>({
    queryKey: ["/api/auth/me"],
    enabled: false,
  });
  return data ?? null;
}
