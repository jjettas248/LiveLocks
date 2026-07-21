import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { getAdminViewMode } from "@/lib/adminViewMode";

const TOKEN_KEY = "ll_auth_token";

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { ...extra };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  // Admin-only QA preview mode (see @/lib/adminViewMode). Inert everywhere
  // except the few routes that explicitly read it, and those routes only
  // ever honor it after confirming the REAL authenticated account is admin
  // (server/services/liveEdgeAccess.ts) — a non-admin sending this header
  // has no effect.
  const viewMode = getAdminViewMode();
  if (viewMode !== "real") {
    headers["X-LL-Admin-View-Mode"] = viewMode;
  }
  return headers;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: authHeaders(data ? { "Content-Type": "application/json" } : {}),
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  // Forward TanStack's AbortSignal to fetch() so queryClient.cancelQueries()
  // actually aborts the in-flight network request (not just discards its
  // eventual result) — needed so switching admin view-mode can't have a
  // late-arriving old-mode response repopulate the cache after the switch.
  async ({ queryKey, signal }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
      headers: authHeaders(),
      signal,
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      // Per-query polling stays opt-in via refetchInterval. These defaults make
      // non-polling queries self-heal and refresh on return instead of showing
      // a frozen first-load snapshot forever:
      //  - finite staleTime so a refetch trigger (focus/remount) can refresh
      //  - refetchOnWindowFocus so returning to a backgrounded tab updates
      //  - retry once so a single transient blip doesn't become a dead error
      refetchInterval: false,
      refetchOnWindowFocus: true,
      staleTime: 30_000,
      retry: 1,
    },
    mutations: {
      retry: false,
    },
  },
});
