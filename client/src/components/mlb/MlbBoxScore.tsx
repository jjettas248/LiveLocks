import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw, Search, Target, ChevronDown, ChevronUp } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import type { MlbSignalData } from "./MlbSignalCard";
import { MlbSignalCard } from "./MlbSignalCard";
import {
  deriveMlbQuickViewColorTier, deriveBestPlay, COLOR_TIER_STYLES,
  type MlbQuickViewColorTier,
} from "@/lib/mlb/mlbNormalizers";

const SHORT_MARKET_LABELS: Record<string, string> = {
  hits: "H", total_bases: "TB", hrr: "HRR",
  pitcher_k: "PK", pitcher_strikeouts: "PK", pitcher_outs: "PO",
  hits_allowed: "HA", walks_allowed: "BB",
  hr: "HR", home_runs: "HR",
  batter_strikeouts: "K", hr_allowed: "HRA",
};

type ABResultEntry = {
  outcome: string;
  exitVelocity: number | null;
  launchAngle: number | null;
  distance: number | null;
  pitchType: string | null;
  pitchSpeed: number | null;
  isBarrel?: boolean;
};

type MlbPlayerStat = {
  playerId: string;
  playerName: string;
  teamAbbr: string;
  teamSide: "home" | "away";
  battingOrderSlot: number;
  ab: number;
  h: number;
  hr: number;
  tb: number;
  r: number;
  rbi: number;
  bb: number;
  sb: number;
  k: number;
  lastABOutcome: string | null;
  exitVelocity: number | null;
  barrelPct: number | null;
  xBA: number | null;
  xSLG: number | null;
  hardHitPct: number | null;
  priorABResults?: ABResultEntry[];
};

type LiveStatsResponse = {
  ready: boolean;
  reason: string | null;
  players: MlbPlayerStat[];
};


type EventBadge = { label: string; color: string; bg: string };

function getPlayerEventBadges(player: MlbPlayerStat): EventBadge[] {
  const badges: EventBadge[] = [];
  if (player.hr > 0) badges.push({ label: "HR", color: "#facc15", bg: "rgba(250,204,21,0.15)" });
  if (player.h >= 2) badges.push({ label: `${player.h}H`, color: "#22c55e", bg: "rgba(34,197,94,0.12)" });
  if (player.exitVelocity != null && player.exitVelocity >= 100) badges.push({ label: "HARD HIT", color: "#f97316", bg: "rgba(249,115,22,0.12)" });
  else if (player.exitVelocity != null && player.exitVelocity >= 95) badges.push({ label: "SOLID", color: "#3b82f6", bg: "rgba(59,130,246,0.12)" });
  if (player.barrelPct != null && (player.barrelPct > 1 ? player.barrelPct : player.barrelPct * 100) >= 15) badges.push({ label: "BARREL", color: "#ef4444", bg: "rgba(239,68,68,0.12)" });
  return badges;
}

function getStickySignalBadges(
  player: MlbPlayerStat,
  stickyCache: React.MutableRefObject<Map<string, Set<string>>>
): EventBadge[] {
  const pid = player.playerId;
  if (!stickyCache.current.has(pid)) {
    stickyCache.current.set(pid, new Set());
  }
  const earned = stickyCache.current.get(pid)!;
  const current = getPlayerEventBadges(player);
  current.forEach(b => earned.add(b.label));
  const BADGE_DEFS: Record<string, { color: string; bg: string }> = {
    "HR": { color: "#facc15", bg: "rgba(250,204,21,0.15)" },
    "HARD HIT": { color: "#f97316", bg: "rgba(249,115,22,0.12)" },
    "SOLID": { color: "#3b82f6", bg: "rgba(59,130,246,0.12)" },
    "BARREL": { color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  };
  const result: EventBadge[] = [];
  Array.from(earned).forEach(label => {
    if (label.endsWith("H") && label !== "HARD HIT") {
      result.push({ label: `${player.h}H`, color: "#22c55e", bg: "rgba(34,197,94,0.12)" });
    } else if (BADGE_DEFS[label]) {
      result.push({ label, ...BADGE_DEFS[label] });
    } else {
      result.push({ label, color: "#71717a", bg: "rgba(113,113,122,0.12)" });
    }
  });
  return result;
}

export function MlbBoxScore({
  gameId,
  signals,
  onPlayerClick,
  awayAbbr,
  homeAbbr,
  onAddToSlip,
}: {
  gameId: string;
  signals: MlbSignalData[];
  onPlayerClick?: (player: MlbPlayerStat) => void;
  awayAbbr?: string | null;
  homeAbbr?: string | null;
  onAddToSlip?: (sig: MlbSignalData) => void;
}) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"order" | "ab" | "h" | "hr" | "tb" | "k" | "signal">("order");
  const [activeTab, setActiveTab] = useState<"all" | "away" | "home" | "signals">("all");
  const [collapsed, setCollapsed] = useState(false);
  const stickyBadgeCache = useRef<Map<string, Set<string>>>(new Map());

  useEffect(() => {
    stickyBadgeCache.current = new Map();
  }, [gameId]);

  const { data, isLoading, isRefetching, dataUpdatedAt } = useQuery<LiveStatsResponse>({
    queryKey: ["/api/mlb/live-stats", gameId],
    refetchInterval: 15_000,
    enabled: !!gameId,
  });

  const players = data?.players ?? [];
  const gameSignals = signals.filter(s => s.gameId === gameId);
  const signalCount = gameSignals.length;

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/mlb/live-stats", gameId] });
  };

  let filtered = players;
  if (activeTab === "away") {
    filtered = filtered.filter(p => p.teamSide === "away");
  } else if (activeTab === "home") {
    filtered = filtered.filter(p => p.teamSide === "home");
  }
  if (search.trim() && activeTab !== "signals") {
    const q = search.toLowerCase();
    filtered = filtered.filter(p => p.playerName.toLowerCase().includes(q));
  }

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "order") return (a.battingOrderSlot || 99) - (b.battingOrderSlot || 99);
    if (sortBy === "ab") return b.ab - a.ab;
    if (sortBy === "h") return b.h - a.h;
    if (sortBy === "hr") return b.hr - a.hr;
    if (sortBy === "tb") return b.tb - a.tb;
    if (sortBy === "k") return b.k - a.k;
    if (sortBy === "signal") {
      const sigA = deriveBestPlay(signals, a.playerId);
      const sigB = deriveBestPlay(signals, b.playerId);
      return (sigB?.probability ?? 0) - (sigA?.probability ?? 0);
    }
    return 0;
  });

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary animate-pulse" />
          <span className="text-xs font-semibold text-foreground">Loading Box Score...</span>
        </div>
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-8 rounded bg-muted/30 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!data?.ready || players.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 text-center space-y-2">
        <Activity className="w-5 h-5 text-muted-foreground mx-auto" />
        <p className="text-xs text-muted-foreground">{data?.reason || "Box score not yet available — waiting for game data."}</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card" data-testid="mlb-box-score">
      <div
        className="flex items-center justify-between px-3 py-2.5 border-b border-border/40 cursor-pointer hover:bg-muted/10 transition-colors"
        onClick={() => setCollapsed(!collapsed)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed(!collapsed); } }}
        data-testid="button-toggle-boxscore"
      >
        <div className="flex items-center gap-2">
          <Activity className={`w-3.5 h-3.5 text-primary ${isRefetching ? "animate-spin" : ""}`} />
          <span className="text-xs font-bold text-foreground">Live Box Score</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-semibold">{players.length}</span>
          {dataUpdatedAt > 0 && (
            <span className="text-[9px] text-muted-foreground/70 tabular-nums" data-testid="text-boxscore-updated">
              {new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {!collapsed && activeTab !== "signals" && (
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="input-boxscore-search"
                className="pl-6 pr-2 py-1.5 w-28 sm:w-36 text-[10px] rounded-lg bg-secondary/60 border border-border/40 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); handleRefresh(); }}
            data-testid="button-refresh-boxscore"
            className="p-1.5 rounded-lg hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${isRefetching ? "animate-spin" : ""}`} />
          </button>
          {collapsed ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
        </div>
      </div>

      {!collapsed && (
      <div className="flex gap-1 px-3 py-1.5 border-b border-border/20">
        {(["all", "away", "home"] as const).map(tab => (
          <button
            key={tab}
            data-testid={`button-boxscore-team-${tab}`}
            onClick={() => setActiveTab(tab)}
            className={`px-2.5 py-1 text-[10px] font-semibold rounded-md transition-colors ${
              activeTab === tab
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "all" ? "All" : tab === "away" ? (awayAbbr ?? "Away") : (homeAbbr ?? "Home")}
          </button>
        ))}
        {signalCount > 0 && (
          <button
            data-testid="button-boxscore-signals-tab"
            onClick={() => setActiveTab("signals")}
            className={`ml-auto px-3 py-1 text-[10px] font-bold rounded-full transition-all flex items-center gap-1.5 ${
              activeTab === "signals"
                ? "bg-green-500/15 text-green-400 border border-green-500/40 shadow-[0_0_8px_rgba(34,197,94,0.3)]"
                : "text-green-400/70 hover:text-green-400 border border-green-500/20 hover:border-green-500/40 hover:shadow-[0_0_6px_rgba(34,197,94,0.2)]"
            }`}
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
            </span>
            Active Signals
            <span className="text-[9px] font-black">{signalCount}</span>
          </button>
        )}
      </div>
      )}

      {!collapsed && activeTab === "signals" ? (
        <div className="p-3 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {gameSignals
              .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0))
              .map((sig, idx) => (
                <MlbSignalCard
                  key={`${sig.playerId}-${sig.market}-${idx}`}
                  sig={sig}
                  onAddToSlip={onAddToSlip}
                />
              ))}
          </div>
        </div>
      ) : !collapsed ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-muted-foreground border-b border-border/20">
                  <th className="text-left px-3 py-1.5 font-semibold">#</th>
                  <th className="text-left px-2 py-1.5 font-semibold">Player</th>
                  {(["ab", "h", "hr", "tb"] as const).map(col => (
                    <th key={col} className="text-center px-1.5 py-1.5 font-semibold">
                      <button
                        type="button"
                        onClick={() => setSortBy(col)}
                        className={`hover:text-foreground ${sortBy === col ? "text-primary" : ""}`}
                        aria-label={`Sort by ${col.toUpperCase()}`}
                      >{col.toUpperCase()}</button>
                    </th>
                  ))}
                  <th className="text-center px-1.5 py-1.5 font-semibold">R</th>
                  <th className="text-center px-1.5 py-1.5 font-semibold">RBI</th>
                  <th className="text-center px-1.5 py-1.5 font-semibold">BB</th>
                  <th className="text-center px-1.5 py-1.5 font-semibold">
                    <button
                      type="button"
                      onClick={() => setSortBy("k")}
                      className={`hover:text-foreground ${sortBy === "k" ? "text-primary" : ""}`}
                      aria-label="Sort by K"
                    >K</button>
                  </th>
                  <th className="text-center px-1.5 py-1.5 font-semibold">EV</th>
                  <th className="text-center px-1.5 py-1.5 font-semibold">
                    <button
                      type="button"
                      onClick={() => setSortBy("signal")}
                      className={`hover:text-foreground ${sortBy === "signal" ? "text-primary" : ""}`}
                      aria-label="Sort by Signal"
                    >Signal</button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((player) => {
                  const colorTier = deriveMlbQuickViewColorTier(signals, player.playerId);
                  const bestPlay = deriveBestPlay(signals, player.playerId);
                  const tierStyle = colorTier !== "neutral" ? COLOR_TIER_STYLES[colorTier] : null;
                  const stickyBadges = getStickySignalBadges(player, stickyBadgeCache);

                  return (
                    <tr
                      key={player.playerId}
                      data-testid={`row-player-${player.playerId}`}
                      className={`border-b border-border/10 transition-colors ${
                        onPlayerClick ? "cursor-pointer hover:bg-primary/5 active:bg-primary/10" : ""
                      }`}
                      style={tierStyle ? { borderLeft: `3px solid ${tierStyle.border}`, background: tierStyle.bg } : undefined}
                      role={onPlayerClick ? "button" : undefined}
                      tabIndex={onPlayerClick ? 0 : undefined}
                      onKeyDown={onPlayerClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPlayerClick(player); } } : undefined}
                      onClick={() => onPlayerClick?.(player)}
                    >
                      <td className="px-3 py-2 text-muted-foreground font-mono">{player.battingOrderSlot || ""}</td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                          <span className="font-semibold text-foreground truncate">{player.playerName}</span>
                          <span className="text-[8px] text-muted-foreground/60 shrink-0">{player.teamAbbr}</span>
                          {stickyBadges.map((badge, bi) => (
                            <span
                              key={bi}
                              data-testid={`badge-sticky-${player.playerId}-${bi}`}
                              className="text-[7px] font-black px-1 py-0.5 rounded shrink-0 uppercase tracking-wide whitespace-nowrap"
                              style={{ color: badge.color, background: badge.bg }}
                            >{badge.label}</span>
                          ))}
                        </div>
                      </td>
                      <td className="text-center px-1.5 py-2 tabular-nums text-foreground">{player.ab}</td>
                      <td className="text-center px-1.5 py-2 tabular-nums font-semibold text-foreground">{player.h}</td>
                      <td className="text-center px-1.5 py-2 tabular-nums text-foreground">
                        {player.hr > 0 ? (
                          <span className="text-yellow-400 font-bold">{player.hr}</span>
                        ) : (
                          <span className="text-muted-foreground/40">0</span>
                        )}
                      </td>
                      <td className="text-center px-1.5 py-2 tabular-nums text-foreground">{player.tb}</td>
                      <td className="text-center px-1.5 py-2 tabular-nums text-foreground">{player.r}</td>
                      <td className="text-center px-1.5 py-2 tabular-nums text-foreground">{player.rbi}</td>
                      <td className="text-center px-1.5 py-2 tabular-nums text-foreground">{player.bb}</td>
                      <td className="text-center px-1.5 py-2 tabular-nums text-foreground">{player.k}</td>
                      <td className="text-center px-1.5 py-2 tabular-nums">
                        {player.exitVelocity != null ? (
                          <span className={player.exitVelocity >= 95 ? "text-orange-400 font-semibold" : "text-muted-foreground"}>
                            {player.exitVelocity.toFixed(0)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/30">—</span>
                        )}
                      </td>
                      <td className="text-center px-1.5 py-2">
                        {bestPlay && tierStyle ? (
                          <div className="flex items-center justify-center gap-1">
                            <span className="w-2 h-2 rounded-full" style={{ background: tierStyle.dot }} />
                            <span className="text-[9px] font-bold" style={{ color: tierStyle.dot }}>
                              {SHORT_MARKET_LABELS[bestPlay.market] ?? bestPlay.market} {bestPlay.probability.toFixed(0)}%
                            </span>
                          </div>
                        ) : bestPlay ? (
                          <div className="flex items-center justify-center gap-1">
                            <span className="text-[9px] text-muted-foreground">
                              {SHORT_MARKET_LABELS[bestPlay.market] ?? bestPlay.market} {bestPlay.probability.toFixed(0)}%
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/30">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {onPlayerClick && (
            <div className="px-3 py-2 border-t border-border/20">
              <p className="text-[9px] text-muted-foreground/50 text-center">Tap a player row to auto-fill the calculator</p>
            </div>
          )}

          <div className="px-3 py-1.5 border-t border-border/20 flex items-center gap-3 text-[8px] text-muted-foreground/50">
            <span className="flex items-center gap-1"><span className="w-2 h-0.5 rounded bg-[#22c55e] inline-block" /> Strong (75%+)</span>
            <span className="flex items-center gap-1"><span className="w-2 h-0.5 rounded bg-[#eab308] inline-block" /> Building (65%+)</span>
            <span className="flex items-center gap-1"><span className="w-2 h-0.5 rounded bg-[#3b82f6] inline-block" /> Monitor (55%+)</span>
            <span className="flex items-center gap-1"><span className="text-orange-400 font-bold">95+</span> Hard hit EV</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

export type { MlbPlayerStat };
