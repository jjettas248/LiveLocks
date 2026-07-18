import { useState, useEffect } from "react";

// ── Admin View-As Mode — pure state ─────────────────────────────────────────
// Admin-only client-side overlay that lets an admin preview the UX of a Free /
// Pro / All-Sports user. Purely cosmetic on its own — this module never
// touches server account state and never sends anything to the backend by
// itself. (client/src/lib/queryClient.ts separately reads getAdminViewMode()
// to attach a request header for the small set of routes that consult it,
// and client/src/hooks/use-auth.ts registers a listener here to invalidate
// the relevant caches on a mode change — kept out of this file to avoid a
// circular import between this module and queryClient.ts.)
//
// Defense in depth: the actual gate against a non-admin ever benefiting from
// this lives server-side (server/services/liveEdgeAccess.ts) — it only
// consults the header after confirming the REAL authenticated account is an
// admin. This module's own applyViewMode() consumer (use-auth.ts) also
// refuses to apply unless the real user is an admin. Non-admin users cannot
// trip either check even by editing localStorage.
const VIEW_MODE_KEY = "ll_admin_view_mode_v1";
export type AdminViewMode = "real" | "free" | "pro_mlb" | "all_sports" | "admin";

export const viewModeListeners = new Set<() => void>();
let _viewMode: AdminViewMode = ((): AdminViewMode => {
  if (typeof window === "undefined") return "real";
  // The admin "View as" switcher lived in the removed MLB DevTools panel, which
  // was the only in-app control that wrote this key. Clear any stale persisted
  // override on load so an admin can never get stranded in a downgraded view
  // (which would also hide every admin-gated surface) with no way to reset it.
  if (localStorage.getItem(VIEW_MODE_KEY)) localStorage.removeItem(VIEW_MODE_KEY);
  return "real";
})();

export function getAdminViewMode(): AdminViewMode {
  return _viewMode;
}

export function setAdminViewMode(m: AdminViewMode): void {
  _viewMode = m;
  if (typeof window !== "undefined") {
    if (m === "real") localStorage.removeItem(VIEW_MODE_KEY);
    else localStorage.setItem(VIEW_MODE_KEY, m);
  }
  viewModeListeners.forEach((l) => l());
}

export function useAdminViewMode(): [AdminViewMode, (m: AdminViewMode) => void] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    viewModeListeners.add(l);
    return () => {
      viewModeListeners.delete(l);
    };
  }, []);
  return [_viewMode, setAdminViewMode];
}
