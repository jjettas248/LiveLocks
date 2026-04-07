export type MlbQuickViewColorTier = "neutral" | "blue" | "yellow" | "green" | "red";

export type MlbGameChipViewModel = {
  gameId: string;
  awayTeam: string;
  homeTeam: string;
  awayScore: number | null;
  homeScore: number | null;
  displayStatus: string;
  displayInning: string;
  inningHalf: "top" | "bottom" | null;
  inningNumber: number | null;
  isLive: boolean;
  isFinal: boolean;
  isPregame: boolean;
};

type GameLike = {
  gameId: string;
  awayTeam?: string | null;
  homeTeam?: string | null;
  awayAbbr?: string | null;
  homeAbbr?: string | null;
  awayScore?: number | null;
  homeScore?: number | null;
  inning?: number | null;
  isTopInning?: boolean;
  status?: string | null;
  startTime?: string | null;
};

export function formatMlbDisplayInning(game: GameLike): string {
  if (!game.status || game.status === "pregame") return "";
  if (game.status === "final") return "Final";
  if (!game.inning || typeof game.inning !== "number" || game.inning < 1) return "Live";
  const arrow = game.isTopInning ? "\u25B2" : "\u25BC";
  return `${arrow}${game.inning}`;
}

export function formatMlbDisplayStatus(game: GameLike): string {
  if (!game.status) return "";
  const s = String(game.status).toLowerCase().trim();
  if (s === "final") return "Final";
  if (s === "live" || s === "in_progress" || s === "status_in_progress") return "Live";
  if (s === "pregame" || s === "scheduled" || s === "status_scheduled") {
    if (game.startTime) {
      try {
        return new Date(game.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
      } catch { return "Scheduled"; }
    }
    return "Scheduled";
  }
  if (s === "delayed" || s === "status_delayed") return "Delayed";
  if (s === "suspended") return "Suspended";
  if (s === "postponed") return "Postponed";
  if (typeof game.status === "string" && game.status.length > 20) return "Live";
  return sanitizeStatusString(game.status);
}

function sanitizeStatusString(raw: unknown): string {
  if (raw == null) return "";
  const str = String(raw);
  const cleaned = str.replace(/[\x00-\x1F\x7F-\x9F]/g, "").replace(/\[object\s+\w+\]/gi, "").trim();
  if (cleaned.length === 0 || cleaned.length > 30) return "Live";
  return cleaned;
}

export function normalizeMlbGameChip(game: GameLike): MlbGameChipViewModel {
  const status = String(game.status ?? "").toLowerCase().trim();
  const isLive = status === "live";
  const isFinal = status === "final";
  const isPregame = !isLive && !isFinal;
  return {
    gameId: game.gameId,
    awayTeam: String(game.awayAbbr ?? game.awayTeam ?? ""),
    homeTeam: String(game.homeAbbr ?? game.homeTeam ?? ""),
    awayScore: typeof game.awayScore === "number" ? game.awayScore : null,
    homeScore: typeof game.homeScore === "number" ? game.homeScore : null,
    displayStatus: formatMlbDisplayStatus(game),
    displayInning: formatMlbDisplayInning(game),
    inningHalf: isLive && game.inning ? (game.isTopInning ? "top" : "bottom") : null,
    inningNumber: isLive && typeof game.inning === "number" ? game.inning : null,
    isLive,
    isFinal,
    isPregame,
  };
}

type SignalLike = {
  playerId: string;
  enginePct?: number;
  recommendedSide?: string;
  alreadyHit?: boolean;
  confidenceTier?: string;
  signalScore?: number | null;
  market?: string;
};

export function deriveMlbQuickViewColorTier(signals: SignalLike[], playerId: string): MlbQuickViewColorTier {
  let pool = signals.filter(s => s.playerId === playerId && !s.alreadyHit);
  if (pool.length === 0) pool = signals.filter(s => s.playerId === playerId);
  if (pool.length === 0) return "neutral";

  let bestPct = 0;
  let bestTier: string | undefined;
  let bestSide: string | undefined;
  for (const s of pool) {
    const pct = s.enginePct ?? 0;
    if (pct > bestPct) {
      bestPct = pct;
      bestTier = s.confidenceTier;
      bestSide = s.recommendedSide;
    }
  }

  const isUnder = bestSide === "UNDER" || bestSide === "under";
  if (bestPct >= 85 && isUnder) return "red";
  if (bestTier === "ELITE" || bestPct >= 75) return "green";
  if (bestTier === "STRONG" || bestPct >= 65) return "yellow";
  if (bestTier === "SOLID" || bestTier === "VALUE" || bestPct >= 55) return "blue";
  if (bestTier === "WATCHLIST" && bestPct > 0) return "blue";
  return "neutral";
}

export type BestPlayInfo = {
  market: string;
  side: string;
  probability: number;
  confidenceTier: "monitor" | "building" | "strong" | null;
  signalScore: number;
};

export function deriveBestPlay(signals: SignalLike[], playerId: string): BestPlayInfo | null {
  const activeSignals = signals.filter(s => s.playerId === playerId && !s.alreadyHit && (s.enginePct ?? 0) > 0);
  if (activeSignals.length > 0) {
    const best = activeSignals.reduce((a, b) => ((b.signalScore ?? 0) > (a.signalScore ?? 0) ? b : a));
    const pct = best.enginePct ?? 0;
    const tier: "monitor" | "building" | "strong" | null =
      pct >= 75 ? "strong" : pct >= 65 ? "building" : pct >= 55 ? "monitor" : null;
    return { market: best.market ?? "", side: best.recommendedSide ?? "", probability: pct, confidenceTier: tier, signalScore: best.signalScore ?? 0 };
  }
  const anySignals = signals.filter(s => s.playerId === playerId && (s.enginePct ?? 0) > 0);
  if (anySignals.length > 0) {
    const best = anySignals.reduce((a, b) => ((b.signalScore ?? 0) > (a.signalScore ?? 0) ? b : a));
    const pct = best.enginePct ?? 0;
    const tier: "monitor" | "building" | "strong" | null =
      pct >= 75 ? "strong" : pct >= 65 ? "building" : pct >= 55 ? "monitor" : null;
    return { market: best.market ?? "", side: best.recommendedSide ?? "", probability: pct, confidenceTier: tier, signalScore: best.signalScore ?? 0 };
  }
  return null;
}

export const COLOR_TIER_STYLES: Record<MlbQuickViewColorTier, { border: string; bg: string; dot: string }> = {
  green: { border: "#22c55e", bg: "rgba(34,197,94,0.12)", dot: "#22c55e" },
  red: { border: "#ef4444", bg: "rgba(239,68,68,0.12)", dot: "#ef4444" },
  yellow: { border: "#eab308", bg: "rgba(234,179,8,0.12)", dot: "#eab308" },
  blue: { border: "#3b82f6", bg: "rgba(59,130,246,0.12)", dot: "#3b82f6" },
  neutral: { border: "transparent", bg: "transparent", dot: "transparent" },
};

export function deriveAllPlayerPlays(signals: SignalLike[], playerId: string): BestPlayInfo[] {
  let pool = signals.filter(s => s.playerId === playerId && !s.alreadyHit && (s.enginePct ?? 0) > 0);
  if (pool.length === 0) {
    pool = signals.filter(s => s.playerId === playerId && (s.enginePct ?? 0) > 0);
  }
  return pool
    .sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0))
    .map(s => {
      const pct = s.enginePct ?? 0;
      const tier: "monitor" | "building" | "strong" | null =
        pct >= 75 ? "strong" : pct >= 65 ? "building" : pct >= 55 ? "monitor" : null;
      return {
        market: s.market ?? "",
        side: s.recommendedSide ?? "",
        probability: pct,
        confidenceTier: tier,
        signalScore: s.signalScore ?? 0,
      };
    });
}
