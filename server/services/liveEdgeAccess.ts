// Live Edge access control + response serialization — the single shared
// entry point for every route that can expose reconstructable Live Edge
// signal data (currently /api/top-plays and /api/mlb/edge-feed). See
// docs/plans (or the PR description) for the full rationale; in short:
//
//   - Access is resolved PER SURFACE, not once for the whole app. The
//     cross-sport surface (/api/top-plays) is gated on `hasUnlimited` (any
//     real paid tier). The MLB-specific surface (/api/mlb/edge-feed) is
//     gated on `hasMLB` (elite tier only), matching requireMLBAccess's
//     existing definition of full MLB access used everywhere else.
//   - Preview responses are an EXACT minimal shape — no internal envelope
//     fields (mode/generatedAt/staleCount/edgeCacheEntries/rows/grouped/
//     unknownInningCount/etc.) ride along, on either route or view.
//   - The admin "view as" QA override (client/src/lib/adminViewMode.ts) is
//     threaded through via a request header, but is only ever consulted
//     after confirming the REAL authenticated account is an admin — a
//     non-admin sending this header has zero effect in either direction.
import { resolveAccess } from "../utils/access";
import type { TopPlayItem } from "./topPlaysService";
import type { LiveEdgePreview } from "@shared/topPlays";

export type LiveEdgeScope = "global" | "mlb";
export type LiveEdgeAccess = "full" | "preview";

type AdminViewMode = "real" | "free" | "pro_mlb" | "all_sports" | "admin";
type ScopeFlags = { hasMLB: boolean; hasUnlimited: boolean };

// Mirrors client applyViewMode()'s exact flag combinations per mode
// (client/src/lib/adminViewMode.ts) — intentionally NOT derived from
// resolveAccess(), since "pro_mlb" is a QA-only label, not a real assignable
// subscriptionTier value (real tiers are exactly null | "all" | "elite" —
// see server/utils/resolveTier.ts and the admin tier-write routes).
const VIEW_MODE_FLAGS: Record<Exclude<AdminViewMode, "real">, ScopeFlags> = {
  free: { hasMLB: false, hasUnlimited: false },
  pro_mlb: { hasMLB: true, hasUnlimited: false },
  all_sports: { hasMLB: true, hasUnlimited: true },
  admin: { hasMLB: true, hasUnlimited: true },
};

function accessForScope(scope: LiveEdgeScope, flags: ScopeFlags): LiveEdgeAccess {
  return (scope === "mlb" ? flags.hasMLB : flags.hasUnlimited) ? "full" : "preview";
}

export type MinimalUser = { subscriptionTier?: string | null; isAdmin?: boolean | null } | null | undefined;

export function resolveLiveEdgeAccess(
  user: MinimalUser,
  scope: LiveEdgeScope,
  viewModeHeader?: string | null,
): LiveEdgeAccess {
  const realFlags: ScopeFlags = !user
    ? { hasMLB: false, hasUnlimited: false }
    : user.isAdmin
      ? { hasMLB: true, hasUnlimited: true }
      : resolveAccess(user.subscriptionTier, false);
  const real = accessForScope(scope, realFlags);

  // Defense in depth: only ever consult the header if the REAL authenticated
  // account is admin. A non-admin sending this header (e.g. crafted via
  // devtools) is silently ignored — `real` always wins, in either direction.
  if (!user?.isAdmin) return real;
  const mode = (viewModeHeader ?? "real") as AdminViewMode;
  if (mode === "real" || !(mode in VIEW_MODE_FLAGS)) return real;
  return accessForScope(scope, VIEW_MODE_FLAGS[mode as Exclude<AdminViewMode, "real">]);
}

type PreviewSourceItem = {
  sport: string;
  confidenceTier?: string | null;
  timingContext?: string | null;
  updatedAt?: string | number | null;
};

const TIMING_LATE_HINTS = ["7", "8", "9", "late"];
const TIMING_LIVE_HINTS = ["inning", "live", "1", "2", "3", "4", "5", "6", "in progress"];

// Coarsens a per-play timing value (which may be as specific as "Inning 7")
// down to a small, non-identifying bucket. Never passes the verbatim value
// through — that's the whole point of "broad timing context."
function coarsenTimingContext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("pre")) return "Pre-game";
  if (lower.includes("final") || lower.includes("post")) return null;
  if (TIMING_LATE_HINTS.some((h) => lower.includes(`inning ${h}`) || lower === h)) return "Late";
  if (TIMING_LIVE_HINTS.some((h) => lower.includes(h))) return "Live";
  return null;
}

function toIsoOrNull(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// activeCount is passed explicitly and separately from `items` so a caller
// can never accidentally report a post-cap array length as the "honest
// count" — see buildTopPlaysWithCount / topPlaysService.ts.
export function buildLiveEdgePreview(activeCount: number, items: PreviewSourceItem[]): LiveEdgePreview {
  const sports = Array.from(new Set(items.map((i) => i.sport).filter(Boolean))).sort();

  let updatedAt: string | null = null;
  for (const item of items) {
    const iso = toIsoOrNull(item.updatedAt);
    if (iso && (!updatedAt || iso > updatedAt)) updatedAt = iso;
  }

  const cards = items.slice(0, 3).map((i) => ({
    sport: i.sport,
    confidenceTier: i.confidenceTier ?? "watch",
    timingContext: coarsenTimingContext(i.timingContext),
  }));

  return { activeCount, sports, updatedAt, cards };
}

export type TopPlaysResponseBody =
  | { access: "full"; plays: TopPlayItem[] }
  | { access: "preview"; preview: LiveEdgePreview };

// Delegates the ENTIRE res.json() payload — the route has no code path where
// the shape could diverge from what's tested.
export function buildTopPlaysResponse(
  user: MinimalUser,
  viewModeHeader: string | null,
  activeCount: number,
  plays: TopPlayItem[],
): TopPlaysResponseBody {
  if (resolveLiveEdgeAccess(user, "global", viewModeHeader) === "full") {
    return { access: "full", plays };
  }
  const preview = buildLiveEdgePreview(
    activeCount,
    plays.map((p) => ({ sport: p.sport, confidenceTier: p.confidenceTier, timingContext: p.timingContext ?? null, updatedAt: p.updatedAt })),
  );
  return { access: "preview", preview };
}

export type EdgeFeedEnvelope = { updatedAt: number; generatedAt: number; staleCount: number; edgeCacheEntries: number };
export type EdgeFeedMarketSignalsExtra = { rows: any[]; grouped: any; unknownInningCount: number; unknownInningReasons: any };

export type EdgeFeedResponseBody =
  | { access: "full"; mode: "live" | "monitoring"; signals: any[]; updatedAt: number; generatedAt: number; staleCount: number; edgeCacheEntries: number }
  | {
      access: "full";
      mode: "live" | "monitoring";
      view: "market-signals";
      rows: any[];
      grouped: any;
      unknownInningCount: number;
      unknownInningReasons: any;
      updatedAt: number;
      generatedAt: number;
      staleCount: number;
      edgeCacheEntries: number;
    }
  | { access: "preview"; preview: LiveEdgePreview };

// Delegates the ENTIRE res.json() payload for /api/mlb/edge-feed, both
// `view` variants. Preview responses ALWAYS collapse to the exact minimal
// { access: "preview", preview } shape regardless of `view` — the
// market-signals shape (rows/grouped/etc.) is never partially exposed.
export function buildEdgeFeedResponse(
  user: MinimalUser,
  viewModeHeader: string | null,
  activeCount: number,
  signals: any[],
  envelope: EdgeFeedEnvelope,
  view: "default" | "market-signals",
  marketSignalsExtra?: EdgeFeedMarketSignalsExtra,
): EdgeFeedResponseBody {
  if (resolveLiveEdgeAccess(user, "mlb", viewModeHeader) !== "full") {
    const preview = buildLiveEdgePreview(
      activeCount,
      signals.map((s: any) => ({
        sport: "MLB",
        confidenceTier: s.signalTier ?? s.confidenceTier ?? null,
        timingContext: s.timingContext ?? null,
        updatedAt: s.updatedAt ?? envelope.updatedAt,
      })),
    );
    return { access: "preview", preview };
  }

  const mode: "live" | "monitoring" = signals.length > 0 ? "live" : "monitoring";
  if (view === "market-signals" && marketSignalsExtra) {
    return {
      access: "full",
      mode,
      view: "market-signals",
      rows: marketSignalsExtra.rows,
      grouped: marketSignalsExtra.grouped,
      unknownInningCount: marketSignalsExtra.unknownInningCount,
      unknownInningReasons: marketSignalsExtra.unknownInningReasons,
      updatedAt: envelope.updatedAt,
      generatedAt: envelope.generatedAt,
      staleCount: envelope.staleCount,
      edgeCacheEntries: envelope.edgeCacheEntries,
    };
  }
  return {
    access: "full",
    mode,
    signals,
    updatedAt: envelope.updatedAt,
    generatedAt: envelope.generatedAt,
    staleCount: envelope.staleCount,
    edgeCacheEntries: envelope.edgeCacheEntries,
  };
}
