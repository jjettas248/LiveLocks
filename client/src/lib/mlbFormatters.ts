const MLB_MARKET_LABELS: Record<string, string> = {
  hits: "Hits",
  total_bases: "Total Bases",
  hrr: "H+R+RBI",
  hr: "Home Runs",
  home_runs: "Home Runs",
  rbi: "RBIs",
  runs: "Runs",
  stolen_bases: "Stolen Bases",
  pitcher_strikeouts: "K (Pitcher)",
  pitcher_k: "K (Pitcher)",
  pitcher_outs: "Outs (Pitcher)",
  walks_allowed: "BB Allowed",
  hits_allowed: "Hits Allowed",
  earned_runs: "Earned Runs",
  batter_strikeouts: "Strikeouts",
  hr_allowed: "HR Allowed",
};

export function formatMlbMarketLabel(market: string): string {
  return MLB_MARKET_LABELS[market] ?? market;
}

export function formatAmericanOdds(odds: number | null | undefined): string {
  if (odds == null || !Number.isFinite(odds)) return "";
  return odds > 0 ? `+${odds}` : `${odds}`;
}

export function getMlbLiveStatValue(sig: {
  market: string;
  currentStats?: { ab?: number; h?: number; hr?: number; tb?: number; bb?: number; rbi?: number; k?: number; sb?: number; r?: number } | null;
}): { label: string; value: number } | null {
  const cs = sig.currentStats;
  if (!cs) return null;
  const ext = sig as any;
  switch (sig.market) {
    case "hits": return { label: "H", value: cs.h ?? 0 };
    case "home_runs":
    case "hr": return { label: "HR", value: cs.hr ?? 0 };
    case "total_bases": return { label: "TB", value: cs.tb ?? 0 };
    case "rbi": return { label: "RBI", value: cs.rbi ?? 0 };
    case "runs": return { label: "R", value: cs.r ?? 0 };
    case "stolen_bases": return { label: "SB", value: cs.sb ?? 0 };
    case "batter_strikeouts": return { label: "K", value: cs.k ?? 0 };
    case "hrr": return { label: "H+R+RBI", value: (cs.h ?? 0) + (cs.r ?? 0) + (cs.rbi ?? 0) };
    case "pitcher_strikeouts": return { label: "K", value: cs.k ?? 0 };
    case "pitcher_outs": return { label: "Outs", value: ext.pitcherPitchCount != null ? Math.round((ext.pitcherPitchCount ?? 0) / 5) : 0 };
    case "hits_allowed": return { label: "HA", value: cs.h ?? 0 };
    case "walks_allowed": return { label: "BB", value: cs.bb ?? 0 };
    case "hr_allowed": return { label: "HRA", value: cs.hr ?? 0 };
    default: return { label: "H", value: cs.h ?? 0 };
  }
}

export const TIER_COLORS: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  ELITE: { bg: "rgba(234,179,8,0.08)", border: "rgba(234,179,8,0.4)", text: "#eab308", badge: "ELITE" },
  STRONG: { bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.4)", text: "#22c55e", badge: "STRONG" },
  SOLID: { bg: "rgba(20,184,166,0.08)", border: "rgba(20,184,166,0.4)", text: "#14b8a6", badge: "SOLID" },
  WATCHLIST: { bg: "rgba(113,113,122,0.06)", border: "rgba(113,113,122,0.3)", text: "#71717a", badge: "WATCH" },
};

// [MLB Canonical Signal Tier — Phase 2] Lowercase, server-canonical tier
// vocabulary used by every MLB UI surface. Keys match `MLBSignal.signalTier`
// exactly, so consumers can do `TIER_COLORS_BY_SIGNAL_TIER[sig.signalTier]`
// without translation. NEVER infer the tier from `signalScore` on the client
// — always read `sig.signalTier` and use `resolveMlbSignalTier()` only as a
// fallback if the server hasn't stamped it yet.
export type MlbSignalTier = "watch" | "lean" | "strong" | "elite";

export const TIER_COLORS_BY_SIGNAL_TIER: Record<MlbSignalTier, { bg: string; border: string; text: string; badge: string }> = {
  elite:  { bg: "rgba(234,179,8,0.08)",   border: "rgba(234,179,8,0.4)",   text: "#eab308", badge: "ELITE" },
  strong: { bg: "rgba(34,197,94,0.08)",   border: "rgba(34,197,94,0.4)",   text: "#22c55e", badge: "STRONG" },
  lean:   { bg: "rgba(20,184,166,0.08)",  border: "rgba(20,184,166,0.4)",  text: "#14b8a6", badge: "LEAN"   },
  watch:  { bg: "rgba(113,113,122,0.06)", border: "rgba(113,113,122,0.3)", text: "#71717a", badge: "WATCH"  },
};

// Map the legacy uppercase `confidenceTier` enum to the canonical lowercase
// `signalTier` for clients that still receive a signal without a stamped
// `signalTier` (cache rollover during deploy, legacy persisted rows). This
// MUST mirror server-side `deriveSignalTier()` in signalScore.ts.
function mapConfidenceTierToSignalTier(confidenceTier: string | null | undefined): MlbSignalTier {
  switch (confidenceTier) {
    case "ELITE":  return "elite";
    case "STRONG": return "strong";
    case "SOLID":  return "lean";
    case "WATCHLIST":
    case "NO_SIGNAL":
    default:       return "watch";
  }
}

/**
 * Resolve the canonical `MlbSignalTier` for a signal. Always prefers the
 * server-stamped `signalTier`; falls back to the legacy `confidenceTier`
 * mapping (and emits a console warning so we can detect missing stamps in
 * production). NEVER recomputes the tier from `signalScore`.
 */
export function resolveMlbSignalTier(sig: {
  signalTier?: string | null;
  confidenceTier?: string | null;
  playerName?: string;
  market?: string;
}): MlbSignalTier {
  const t = sig.signalTier;
  if (t === "elite" || t === "strong" || t === "lean" || t === "watch") {
    return t;
  }
  const derived = mapConfidenceTierToSignalTier(sig.confidenceTier);
  try {
    // Surface client-side fallback so the orchestrator team can correlate
    // missing server stamps with the [MLB_TIER_FALLBACK] server log.
    // eslint-disable-next-line no-console
    console.warn("[MLB_TIER_FALLBACK]", {
      surface: "client",
      player: sig.playerName,
      market: sig.market,
      confidenceTier: sig.confidenceTier,
      derivedSignalTier: derived,
    });
  } catch {}
  return derived;
}

export const SIDE_STYLES = {
  OVER: { accent: "#22c55e", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.35)", label: "OVER" },
  UNDER: { accent: "#3b82f6", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.35)", label: "UNDER" },
};

export const MODE_STYLES: Record<string, { label: string; color: string; bg: string; border: string; icon: string }> = {
  // Core signal tiers route through the shared --tier-* tokens (single source
  // of truth) so "elite/strong/value" render the same color everywhere.
  elite:         { label: "ELITE",       color: "hsl(var(--tier-elite))",  bg: "hsl(var(--tier-elite) / 0.13)",  border: "hsl(var(--tier-elite) / 0.5)",  icon: "🔒" },
  strong:        { label: "STRONG",      color: "hsl(var(--tier-strong))", bg: "hsl(var(--tier-strong) / 0.10)", border: "hsl(var(--tier-strong) / 0.45)", icon: "🟢" },
  lean:          { label: "LEAN",        color: "hsl(var(--tier-value))",  bg: "hsl(var(--tier-value) / 0.10)",  border: "hsl(var(--tier-value) / 0.4)",  icon: "📊" },
  heating_up:    { label: "HEATING UP",  color: "#f59e0b", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.4)", icon: "🔥" },
  watch:         { label: "WATCH",       color: "#71717a", bg: "rgba(113,113,122,0.08)", border: "rgba(113,113,122,0.3)", icon: "👁" },
  hr_elite:      { label: "HR ELITE",    color: "#ef4444", bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.5)",  icon: "💣" },
  hr_strong:     { label: "HR STRONG",   color: "#f97316", bg: "rgba(249,115,22,0.10)", border: "rgba(249,115,22,0.45)", icon: "🚀" },
  hr_heating_up: { label: "HR HEATING",  color: "#f59e0b", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.4)", icon: "🔥" },
  hr_watch:      { label: "HR WATCH",    color: "#a78bfa", bg: "rgba(167,139,250,0.10)", border: "rgba(167,139,250,0.35)", icon: "👁" },
};

export function classifyTier(score: number | null | undefined): string {
  const s = score ?? 0;
  if (s >= 75) return "elite";
  if (s >= 65) return "edge";
  if (s >= 55) return "lean";
  return "watch";
}

export function generateShareTweet(sig: {
  playerName: string;
  recommendedSide: string;
  market: string;
  bookLine?: number | null;
  enginePct: number;
  edge?: number | null;
  signalScore?: number | null;
}): string {
  const marketLabel = formatMlbMarketLabel(sig.market);
  const BATTER_OVER = ["hits", "total_bases", "home_runs", "hrr", "batter_strikeouts"];
  const isBatterOver = BATTER_OVER.includes(sig.market);
  const suffix = isBatterOver
    ? (sig.signalScore ? ` | Signal: ${sig.signalScore}` : "")
    : ((sig.edge ?? 0) > 0 ? `, +${(sig.edge ?? 0).toFixed(1)}% edge` : "");
  return `${sig.playerName} ${sig.recommendedSide} ${marketLabel} ${sig.bookLine ?? ""} \u2014 ${sig.enginePct.toFixed(0)}% prob${suffix}\n\nPowered by LiveLocks`;
}

export function openShareWindow(tweet: string) {
  window.open(
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`,
    "_blank",
    "noopener,noreferrer,width=550,height=420"
  );
}
