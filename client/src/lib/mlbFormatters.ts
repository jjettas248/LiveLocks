export const MLB_MARKET_LABELS: Record<string, string> = {
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
    default: return { label: "H", value: cs.h ?? 0 };
  }
}

export function getSignalStateMeta(sig: {
  alreadyHit?: boolean;
  stale?: boolean;
  watchlist?: boolean;
}): { label: string; color: string; bg: string } | null {
  if (sig.alreadyHit) return { label: "HIT \u2713", color: "#22c55e", bg: "rgba(34,197,94,0.15)" };
  if (sig.stale) return { label: "STALE", color: "#71717a", bg: "rgba(113,113,122,0.15)" };
  if (sig.watchlist) return { label: "WATCH", color: "#71717a", bg: "rgba(113,113,122,0.1)" };
  return null;
}

export function formBadge(form: string | null | undefined): { label: string; color: string } | null {
  if (!form) return null;
  const f = form.toUpperCase();
  if (f === "HOT") return { label: "\uD83D\uDD25 HOT", color: "#f97316" };
  if (f === "WARM") return { label: "\uD83D\uDFE1 WARM", color: "#eab308" };
  if (f === "COLD") return { label: "\u2744\uFE0F COLD", color: "#60a5fa" };
  if (f === "EXTREME_COLD") return { label: "\uD83E\uDDCA ICE COLD", color: "#818cf8" };
  return null;
}

export const TIER_COLORS: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  ELITE: { bg: "rgba(234,179,8,0.08)", border: "rgba(234,179,8,0.4)", text: "#eab308", badge: "ELITE" },
  STRONG: { bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.4)", text: "#22c55e", badge: "STRONG" },
  SOLID: { bg: "rgba(20,184,166,0.08)", border: "rgba(20,184,166,0.4)", text: "#14b8a6", badge: "SOLID" },
  WATCHLIST: { bg: "rgba(113,113,122,0.06)", border: "rgba(113,113,122,0.3)", text: "#71717a", badge: "WATCH" },
};

export const SIDE_STYLES = {
  OVER: { accent: "#22c55e", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.35)", label: "OVER" },
  UNDER: { accent: "#3b82f6", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.35)", label: "UNDER" },
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
}): string {
  const marketLabel = formatMlbMarketLabel(sig.market);
  return `${sig.playerName} ${sig.recommendedSide} ${marketLabel} ${sig.bookLine ?? ""} \u2014 ${sig.enginePct.toFixed(0)}% prob${(sig.edge ?? 0) > 0 ? `, +${(sig.edge ?? 0).toFixed(1)}% edge` : ""}\n\nPowered by LiveLocks`;
}

export function openShareWindow(tweet: string) {
  window.open(
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`,
    "_blank",
    "noopener,noreferrer,width=550,height=420"
  );
}
