// ── LiveLocks Phase 1, Batch D — Client Canonical View Model ─────────
// Single client adapter for reading CanonicalSignal-derived fields off
// the existing MLBSignal-shape API responses. The server's
// canonicalSignalViewModel.ts stamps these fields directly onto the
// payload via attachCanonicalToMlbSignals().
//
// HARD RULES (Batch D Part 2):
//   - UI MUST NOT infer signalTier from probability.
//   - UI MUST NOT invent lifecycleState client-side.
//   - When canonical fields are absent (legacy server cache, stale
//     payload), surface a `unknown` lifecycle state and tag for
//     diagnostics; do NOT guess.

export type CanonicalLifecycleState =
  | "watch"
  | "build"
  | "strong"
  | "elite"
  | "cashed"
  | "missed"
  | "expired"
  | "unknown";

export type CanonicalSignalTier = "watch" | "lean" | "strong" | "elite";

export interface CanonicalAwareSignal {
  signalTier?: CanonicalSignalTier | string | null;
  canonicalSignalId?: string | null;
  canonicalLifecycleState?: CanonicalLifecycleState | null;
  canonicalSurfacedAt?: number | null;
  canonicalUpdatedAt?: number | null;
  canonicalExpiresAt?: number | null;
  canonicalEngineGeneratedAt?: number | null;
}

/**
 * Read the canonical lifecycle state directly off a payload item. Never
 * derives the value from probability or score. Returns `"unknown"` (and
 * logs to console) when the field is missing, so the UI can render a
 * neutral state instead of fabricating one.
 */
let _missingLogged = false;
export function readCanonicalLifecycle(
  s: CanonicalAwareSignal | null | undefined
): CanonicalLifecycleState {
  const state = s?.canonicalLifecycleState;
  if (state) return state;
  if (!_missingLogged && typeof console !== "undefined") {
    _missingLogged = true;
    // eslint-disable-next-line no-console
    console.log("[LL_LEGACY_SIGNAL_CONSUMER] client: payload missing canonicalLifecycleState — server pre-Batch-D shape");
  }
  return "unknown";
}

/**
 * Read the engine-stamped tier directly. Falls back to "watch" only
 * when missing (never derives from probability).
 */
export function readCanonicalTier(
  s: CanonicalAwareSignal | null | undefined
): CanonicalSignalTier {
  const t = s?.signalTier;
  if (t === "elite" || t === "strong" || t === "lean" || t === "watch") return t;
  return "watch";
}

/**
 * Lifecycle badge styling — pure mapping table, never inferred.
 */
export const LIFECYCLE_BADGE: Record<
  CanonicalLifecycleState,
  { label: string; bg: string; text: string }
> = {
  watch:   { label: "Watching",  bg: "#0c4a6e", text: "#7dd3fc" },
  build:   { label: "Building",  bg: "#422006", text: "#fbbf24" },
  strong:  { label: "Strong",    bg: "#052e16", text: "#4ade80" },
  elite:   { label: "Elite",     bg: "#3b0764", text: "#c4b5fd" },
  cashed:  { label: "Cashed",    bg: "#0f5132", text: "#86efac" },
  missed:  { label: "Missed",    bg: "#450a0a", text: "#fca5a5" },
  expired: { label: "Expired",   bg: "#1c1917", text: "#a3a3a3" },
  unknown: { label: "—",         bg: "#1c1917", text: "#525252" },
};

/**
 * Canonical timing labels — relative durations from canonical timestamps.
 * Returns null when the field is missing instead of fabricating a value.
 */
export function readSurfacedAgoMs(s: CanonicalAwareSignal | null | undefined): number | null {
  const surfacedAt = s?.canonicalSurfacedAt;
  if (typeof surfacedAt !== "number" || surfacedAt <= 0) return null;
  return Date.now() - surfacedAt;
}

export function formatSurfacedAgo(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 60_000) return `surfaced ${Math.round(ms / 1000)}s ago`;
  if (ms < 60 * 60_000) return `surfaced ${Math.round(ms / 60_000)}m ago`;
  return `surfaced ${Math.round(ms / (60 * 60_000))}h ago`;
}
