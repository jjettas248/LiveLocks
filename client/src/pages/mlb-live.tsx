import { useState, useEffect, Component, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { TopPlays } from "@/components/mlb/TopPlays";
import { LiveBoard } from "@/components/mlb/LiveBoard";
import { MlbSignalCard, type MlbSignalData } from "@/components/mlb/MlbSignalCard";
import { MlbBoxScore, type MlbPlayerStat } from "@/components/mlb/MlbBoxScore";
import type { MLBSignal } from "@shared/mlbSignal";
import { ProbabilityRing } from "@/components/probability-ring";
import { SkeletonCard } from "@/components/sports/SkeletonCard";
import { EmptyState } from "@/components/sports/EmptyState";
import { Radio, Target, RefreshCw, Calculator, Loader2 } from "lucide-react";

class MLBErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; message: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message ?? "Unknown error" };
  }
  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[MLBErrorBoundary] caught:", error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="max-w-5xl mx-auto px-4 py-12 text-center space-y-3">
          <div className="text-sm font-semibold text-foreground">Something went wrong loading MLB</div>
          <div className="text-xs text-muted-foreground">{this.state.message}</div>
          <button className="text-xs text-primary underline" onClick={() => this.setState({ hasError: false, message: "" })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

type MLBGame = {
  gameId: string;
  homeTeam: string | null;
  awayTeam: string | null;
  awayAbbr: string | null;
  homeAbbr: string | null;
  homeScore: number | null;
  awayScore: number | null;
  inning: number;
  isTopInning: boolean;
  status: "live" | "pregame" | "final" | null;
  startTime?: string | null;
  venue?: string | null;
  weatherSummary?: string | null;
  weather?: { temperature: number | null; windSpeed: number | null; windDirection: string | null; humidity: number | null } | null;
  pitcherAway?: string | null;
  pitcherHome?: string | null;
  awayPitcherHand?: string | null;
  homePitcherHand?: string | null;
  hasOdds?: boolean;
  signalCount?: number;
  gameCardTags?: string[];
};

type MLBGamesResponse = {
  mode: "live" | "preview" | "preview_locked";
  games: MLBGame[];
};

type EdgeFeedResponse = {
  signals: MLBSignal[];
};

type HRRadarResponse = {
  hrEdges: Array<{
    playerId: string; playerName: string; team: string; market: string; side: string;
    line: number; projection: number; engineProbability: number; edge: number | null;
    signalScore: number; confidenceTier: string; badges: string[]; reasons: string[];
    gameId: string; awayAbbr: string | null; homeAbbr: string | null;
    alreadyHit?: boolean;
  }>;
  bettableHR: Array<any>;
  activity?: Array<any>;
  hrWatchlist: Array<{
    playerId: string; playerName: string; team: string; hrProbability: number;
    hardHitEvents: number; parkFactor: number | null; windFactor: string;
    reasons: string[]; gameId: string; awayAbbr: string | null; homeAbbr: string | null;
    badges: string[];
  }>;
};

const MARKET_LABELS: Record<string, string> = {
  hits: "Hits", total_bases: "Total Bases", hrr: "H+R+RBI",
  pitcher_k: "K (Pitcher)", pitcher_strikeouts: "K (Pitcher)", pitcher_outs: "Pitcher Outs",
  hits_allowed: "Hits Allowed", walks_allowed: "Walks Allowed",
  hr: "Home Runs", home_runs: "Home Runs",
  batter_strikeouts: "Strikeouts", hr_allowed: "HR Allowed",
};

const MLB_CALC_MARKETS = [
  { value: "hits", label: "Hits" },
  { value: "total_bases", label: "Total Bases" },
  { value: "pitcher_strikeouts", label: "Pitcher Ks" },
  { value: "home_runs", label: "Home Runs" },
];

const MLB_ODDS_STAT_MAP: Record<string, string> = {
  hits: "hits", total_bases: "total_bases", home_runs: "home_runs",
  hrr: "hrr", batter_strikeouts: "batter_strikeouts",
  pitcher_strikeouts: "pitcher_strikeouts", pitcher_outs: "pitcher_outs",
  hits_allowed: "hits_allowed", walks_allowed: "walks_allowed",
};

const BOOK_DISPLAY: Record<string, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  hardrockbet: "Hard Rock",
  prizepicks: "PrizePicks",
  underdogfantasy: "Underdog",
};

function formatOdds(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function inningLabel(game: MLBGame): string {
  if (game.status === "pregame") return "Pre-Game";
  if (game.status === "final") return "Final";
  if (!game.inning) return "—";
  return `${game.isTopInning ? "▲" : "▼"}${game.inning}`;
}

function gameLeanBadge(signals: MlbSignalData[], gameId: string): { label: string; color: string } | null {
  const gameSignals = signals.filter(s => s.gameId === gameId && (s.confidenceTier === "ELITE" || s.confidenceTier === "STRONG"));
  if (gameSignals.length === 0) return null;
  const pitcherCount = gameSignals.filter(s => ["pitcher_k", "pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"].includes(s.market)).length;
  const batterCount = gameSignals.length - pitcherCount;
  if (pitcherCount > batterCount) return { label: "Pitch", color: "#3b82f6" };
  if (batterCount > pitcherCount) return { label: "Hit", color: "#f97316" };
  return { label: "Mixed", color: "#71717a" };
}

function GameChipStrip({ games, selectedGameId, onSelectGame, edgeFeedSignals, onRefresh }: {
  games: MLBGame[];
  selectedGameId: string | null;
  onSelectGame: (id: string | null) => void;
  edgeFeedSignals: MlbSignalData[];
  onRefresh: () => void;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4" data-testid="mlb-games-strip">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Radio className="w-3.5 h-3.5 text-green-500" /> Today's Games
        </h2>
        <button
          onClick={onRefresh}
          className="text-muted-foreground flex items-center gap-1 text-xs hover:text-foreground transition-colors"
          data-testid="button-refresh-mlb-games"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      <div className="flex gap-2 flex-wrap">
        {games.map((game) => {
          const isLive = game.status === "live";
          const isFinal = game.status === "final";
          const isSelected = game.gameId === selectedGameId;
          const lean = gameLeanBadge(edgeFeedSignals, game.gameId);
          const tipoffTime = game.startTime
            ? new Date(game.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
            : null;

          return (
            <button
              key={game.gameId}
              data-testid={`button-game-${game.gameId}`}
              onClick={() => onSelectGame(isSelected ? null : game.gameId)}
              className={`flex flex-col items-center px-3 py-2 rounded-lg border text-xs min-w-[130px] transition-all ${
                isSelected
                  ? "border-primary bg-primary/10 ring-1 ring-primary shadow-[0_0_16px_-3px_hsl(var(--primary)/0.4)]"
                  : "border-border/60 bg-secondary/40 hover:bg-secondary/70 hover:shadow-[0_0_14px_-3px_hsl(var(--primary)/0.25)]"
              }`}
            >
              <div className="flex items-center justify-between w-full gap-2">
                <span className="font-semibold text-foreground">{game.awayAbbr}</span>
                <span className={`font-mono font-bold ${isLive ? "text-green-400" : "text-primary"}`}>
                  {game.awayScore ?? 0} – {game.homeScore ?? 0}
                </span>
                <span className="font-semibold text-foreground">{game.homeAbbr}</span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground mt-0.5">
                {isLive && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />}
                {isFinal && <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 inline-block" />}
                <span className={isLive ? "text-green-400" : isFinal ? "text-muted-foreground/60" : ""}>
                  {isLive
                    ? inningLabel(game)
                    : game.status === "pregame" && tipoffTime
                    ? tipoffTime
                    : game.status === "final"
                    ? "Final"
                    : "—"}
                </span>
                {lean && (
                  <span className="w-2 h-2 rounded-full" style={{ background: lean.color }} title={`${lean.label}-lean`} />
                )}
                {isSelected && <span className="text-primary font-medium ml-0.5">●</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GameContextPanel({ game, signalCount }: { game: MLBGame; signalCount: number }) {
  const isLive = game.status === "live";
  return (
    <div className="space-y-3" data-testid="mlb-game-context">
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-bold text-foreground">
            {game.awayAbbr} @ {game.homeAbbr}
          </div>
          {isLive && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/30 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              LIVE
            </span>
          )}
        </div>

        {isLive && (
          <div className="text-center py-2">
            <div className="text-2xl font-black text-foreground tabular-nums">
              {game.awayScore ?? 0} – {game.homeScore ?? 0}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {inningLabel(game)}
            </div>
          </div>
        )}

        {game.venue && (
          <div className="text-[11px] text-muted-foreground">
            <span className="font-semibold">Venue:</span> {game.venue}
          </div>
        )}

        {game.weather && (game.weather.temperature != null || game.weather.windSpeed != null) && (
          <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
            {game.weather.temperature != null && <span>{Math.round(game.weather.temperature)}°F</span>}
            {game.weather.windSpeed != null && (
              <span>{game.weather.windSpeed} mph {game.weather.windDirection ?? ""}</span>
            )}
            {game.weather.humidity != null && <span>{game.weather.humidity}% humidity</span>}
          </div>
        )}

        <div className="border-t border-border/30 pt-3 space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Pitchers</div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="bg-secondary/30 rounded-lg p-2">
              <div className="text-[9px] text-muted-foreground uppercase">Away SP</div>
              <div className="font-semibold text-foreground">{game.pitcherAway ?? "TBD"}</div>
              {game.awayPitcherHand && <span className="text-[9px] text-muted-foreground">({game.awayPitcherHand}HP)</span>}
            </div>
            <div className="bg-secondary/30 rounded-lg p-2">
              <div className="text-[9px] text-muted-foreground uppercase">Home SP</div>
              <div className="font-semibold text-foreground">{game.pitcherHome ?? "TBD"}</div>
              {game.homePitcherHand && <span className="text-[9px] text-muted-foreground">({game.homePitcherHand}HP)</span>}
            </div>
          </div>
        </div>

        <div className="text-[10px] text-muted-foreground">
          {signalCount > 0 ? (
            <span className="text-green-400 font-semibold">{signalCount} active signal{signalCount !== 1 ? "s" : ""}</span>
          ) : (
            <span>Monitoring — signals appear as the game progresses</span>
          )}
        </div>
      </div>
    </div>
  );
}

function GameSignalsPanel({ signals, isElite, onAddToSlip }: {
  signals: MlbSignalData[];
  isElite: boolean;
  onAddToSlip: (sig: MlbSignalData) => void;
}) {
  const sorted = [...signals].sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0));
  const visible = isElite ? sorted : sorted.slice(0, 2);
  const lockedCount = isElite ? 0 : Math.max(0, sorted.length - 2);

  return (
    <div className="space-y-3" data-testid="mlb-game-signals">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-primary" />
          <span className="text-sm font-bold text-foreground">Active Signals</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-semibold">{signals.length}</span>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-xl border border-border/40 bg-card p-6 text-center">
          <div className="flex items-center justify-center gap-2 text-sm text-blue-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400" />
            </span>
            Monitoring
          </div>
          <div className="text-xs text-muted-foreground/60 mt-1">Signals appear as the game progresses and pitcher fatigue data accumulates.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {visible.map((sig, idx) => (
            <MlbSignalCard
              key={`${sig.playerId}-${sig.market}-${idx}`}
              sig={sig}
              onAddToSlip={onAddToSlip}
            />
          ))}
        </div>
      )}

      {lockedCount > 0 && (
        <div className="relative">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 filter blur-[6px] pointer-events-none select-none" aria-hidden="true">
            {sorted.slice(2, 4).map((sig, idx) => (
              <MlbSignalCard key={`blur-${sig.playerId}-${sig.market}-${idx}`} sig={sig} />
            ))}
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
            <div className="rounded-xl border border-primary/30 bg-card/95 backdrop-blur-sm p-5 text-center space-y-3 max-w-sm shadow-xl">
              <div className="text-sm font-bold text-foreground">{lockedCount} more signal{lockedCount !== 1 ? "s" : ""} available</div>
              <div className="text-xs text-muted-foreground">Unlock all MLB edges with All Sports.</div>
              <a href="/upgrade" data-testid="link-mlb-signals-upgrade"
                className="inline-block px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors">
                Upgrade to All Sports →
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HREdgeCard({ edge }: { edge: any }) {
  const [expanded, setExpanded] = useState(false);
  const reasons = edge.explanationBullets ?? edge.reasons ?? [];
  const edgeVal = edge.edge ?? 0;
  const hasPositiveEdge = edgeVal > 0;

  return (
    <div
      data-testid={`card-hr-edge-${edge.playerId}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      className={`rounded-xl border p-4 space-y-2.5 cursor-pointer transition-all hover:border-green-500/50 ${hasPositiveEdge ? "border-green-500/30 bg-green-500/5" : "border-orange-500/30 bg-orange-500/5"}`}
      onClick={() => setExpanded(!expanded)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!expanded); } }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-foreground">{edge.playerName}</span>
          <span className="text-[10px] text-muted-foreground">{edge.team}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
            edge.confidenceTier === "ELITE" ? "bg-yellow-500/20 text-yellow-400" :
            edge.confidenceTier === "STRONG" ? "bg-green-500/20 text-green-400" :
            "bg-muted/30 text-muted-foreground"
          }`}>{edge.confidenceTier}</span>
          <span className="text-muted-foreground text-xs">{expanded ? "▾" : "▸"}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 text-[10px]">
        <span className="text-green-400 font-bold">{edge.side} {edge.line?.toFixed(1)}</span>
        <span className="text-muted-foreground">·</span>
        <span className={`font-bold ${hasPositiveEdge ? "text-green-400" : "text-muted-foreground"}`}>
          {edgeVal > 0 ? "+" : ""}{edgeVal.toFixed(1)}% Edge
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-foreground">{edge.engineProbability?.toFixed(1)}% Prob</span>
      </div>

      {Array.isArray(edge.badges) && edge.badges.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {edge.badges.map((b: string) => (
            <span key={b} className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 font-semibold">{b}</span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="space-y-2 pt-1 border-t border-border/20 animate-in slide-in-from-top-1 duration-200">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-secondary/30 rounded-lg p-1.5">
              <div className="text-[8px] text-muted-foreground">Projection</div>
              <div className="text-xs font-bold text-foreground">{edge.projection?.toFixed(2) ?? "—"}</div>
            </div>
            <div className="bg-secondary/30 rounded-lg p-1.5">
              <div className="text-[8px] text-muted-foreground">Edge</div>
              <div className={`text-xs font-bold ${hasPositiveEdge ? "text-green-400" : "text-muted-foreground"}`}>
                {edgeVal > 0 ? "+" : ""}{edgeVal.toFixed(1)}%
              </div>
            </div>
            <div className="bg-secondary/30 rounded-lg p-1.5">
              <div className="text-[8px] text-muted-foreground">Signal</div>
              <div className="text-xs font-bold text-foreground">{edge.signalScore}/100</div>
            </div>
          </div>
          {reasons.length > 0 && (
            <div className="space-y-0.5">
              {reasons.map((r: string, i: number) => (
                <p key={i} className="text-[10px] text-muted-foreground flex items-start gap-1">
                  <span className="text-primary/50 mt-px">•</span><span>{r}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HRRadarSection({ isElite }: { isElite: boolean }) {
  const { data: hrData, isLoading } = useQuery<HRRadarResponse>({
    queryKey: ["/api/mlb/hr-radar"],
    refetchInterval: 60_000,
  });

  if (isLoading) return <SkeletonCard count={3} />;

  const hrEdges = hrData?.hrEdges ?? [];
  const hrWatchlist = hrData?.hrWatchlist ?? [];
  const activity = hrData?.activity ?? [];

  return (
    <div className="space-y-6" data-testid="mlb-hr-radar">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">💣</span>
          <span className="text-sm font-bold text-foreground">Bettable HR Edges</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-400 font-semibold">{hrEdges.length}</span>
        </div>
        {hrEdges.length === 0 ? (
          <div className="rounded-xl border border-border/40 bg-card p-6 text-center">
            <div className="text-xs text-muted-foreground">No HR edges detected yet — engine is scanning all live games.</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(isElite ? hrEdges : hrEdges.slice(0, 2)).map((edge) => (
              <HREdgeCard key={`${edge.playerId}-${edge.market}`} edge={edge} />
            ))}
          </div>
        )}
        {!isElite && hrEdges.length > 2 && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-center space-y-2">
            <div className="text-sm font-bold text-foreground">{hrEdges.length - 2} more HR edge{hrEdges.length - 2 !== 1 ? "s" : ""}</div>
            <a href="/upgrade" data-testid="link-hr-upgrade" className="inline-block px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-xs">
              Upgrade to All Sports →
            </a>
          </div>
        )}
      </div>

      {activity.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">⚡</span>
            <span className="text-sm font-bold text-foreground">HR Activity Today</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {activity.map((a: any, i: number) => (
              <div key={i} className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
                <span className="font-bold text-emerald-400">{a.playerName}</span>
                <span className="text-muted-foreground ml-1">({a.team})</span>
                <span className="text-emerald-400 ml-1">HR ✓</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hrWatchlist.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">👀</span>
            <span className="text-sm font-bold text-foreground">HR Watchlist</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/30 text-muted-foreground font-semibold">{hrWatchlist.length}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {hrWatchlist.map((w) => (
              <div key={w.playerId} className="rounded-lg border border-border/40 bg-card p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-foreground">{w.playerName}</span>
                  <span className="text-[10px] text-muted-foreground">{w.team}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
                  <span>HR Prob: <span className="text-foreground font-semibold">{(w.hrProbability * 100).toFixed(0)}%</span></span>
                  {w.hardHitEvents > 0 && <span className="text-orange-400">{w.hardHitEvents} hard hits</span>}
                  {w.parkFactor != null && w.parkFactor > 1 && <span className="text-green-400">Park+</span>}
                  {w.windFactor && w.windFactor !== "neutral" && <span>Wind: {w.windFactor}</span>}
                </div>
                {w.badges.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {w.badges.map(b => (
                      <span key={b} className="text-[8px] px-1 py-0.5 rounded bg-orange-500/10 text-orange-400">{b}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MlbLiveInner({ activeSubTab }: { activeSubTab: "games" | "live_feed" | "hr_radar" }) {
  const { user, isLoading: authLoading } = useAuth();
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [liveFeedSub, setLiveFeedSub] = useState<"all" | "3rd" | "5th" | "7th">("all");
  const mlbUpgradeNeeded = false;
  const [mlbSlipPicks, setMlbSlipPicks] = useState<Array<{ playerId: string; playerName: string; market: string; line: number; side: string; sportsbook: string; edge: number | null; enginePct: number; gameId: string; overOdds?: number | null; underOdds?: number | null }>>([]);

  const isElite = user?.hasMLB === true;

  const { data: gamesResp, isLoading: gamesLoading } = useQuery<MLBGamesResponse>({
    queryKey: ["/api/mlb/live-games"],
    refetchInterval: 30_000,
  });
  const games = Array.isArray(gamesResp?.games) ? gamesResp!.games : [];

  const { data: edgeFeedResp } = useQuery<EdgeFeedResponse>({
    queryKey: ["/api/mlb/edge-feed"],
    refetchInterval: 45_000,
  });
  const edgeFeedSignals: MlbSignalData[] = Array.isArray(edgeFeedResp?.signals)
    ? (edgeFeedResp!.signals as MlbSignalData[])
    : [];

  const selectedGame = games.find(g => g?.gameId === selectedGameId) ?? null;
  const gameSignals = edgeFeedSignals.filter(s => s.gameId === selectedGameId);

  const [calcPlayer, setCalcPlayer] = useState<MlbPlayerStat | null>(null);
  const [calcPlayerName, setCalcPlayerName] = useState("");
  const [calcMarket, setCalcMarket] = useState("hits");
  const [calcBookLine, setCalcBookLine] = useState("");
  const [calcResult, setCalcResult] = useState<{
    probability?: number;
    modelProbability?: number;
    recommendedSide?: string;
    edge?: number;
    projection?: number;
    expectedTotal?: number;
    bookImplied?: number;
    confidenceTier?: string;
    featureScores?: Record<string, number>;
  } | null>(null);

  const activeCalcName = calcPlayer?.playerName ?? calcPlayerName;
  const activeCalcTeam = calcPlayer?.teamAbbr ?? "";

  type OddsEntry = { line: number; overOdds: number; underOdds: number; sportsbook: string };
  const { data: oddsData, isLoading: oddsLoading, isError: oddsError } = useQuery<Record<string, OddsEntry>>({
    queryKey: ["/api/mlb/odds", activeCalcName, calcMarket, selectedGame?.awayAbbr, selectedGame?.homeAbbr],
    queryFn: async () => {
      if (!activeCalcName.trim() || !selectedGame) return {};
      const params = new URLSearchParams({
        playerName: activeCalcName,
        statType: MLB_ODDS_STAT_MAP[calcMarket] ?? calcMarket,
        playerTeam: activeCalcTeam || (selectedGame.homeAbbr ?? ""),
        opponentTeam: calcPlayer
          ? (calcPlayer.teamSide === "home" ? (selectedGame.awayAbbr ?? "") : (selectedGame.homeAbbr ?? ""))
          : (selectedGame.awayAbbr ?? ""),
        inPlay: selectedGame.status === "live" ? "true" : "false",
      });
      const res = await fetch(`/api/mlb/odds?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch odds");
      return res.json();
    },
    enabled: !!activeCalcName.trim() && !!selectedGame,
    staleTime: 60_000,
  });
  const oddsEntries = Object.entries(oddsData ?? {})
    .filter(([k]) => !k.startsWith("_"))
    .map(([book, v]) => ({ sportsbook: book, ...(v as OddsEntry) }));

  const calcMutation = useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      const res = await apiRequest("POST", "/api/mlb/calculate-manual", input);
      return res.json();
    },
    onSuccess: (data) => setCalcResult(data),
  });

  const handleBoxScoreClick = (player: MlbPlayerStat) => {
    setCalcPlayer(player);
    setCalcPlayerName(player.playerName);
    setCalcResult(null);
    setCalcBookLine("");
  };

  const handleCalculate = () => {
    if (!activeCalcName.trim() || !selectedGame) return;
    const line = parseFloat(calcBookLine);
    if (!Number.isFinite(line) || line <= 0) return;
    calcMutation.mutate({
      playerId: calcPlayer?.playerId ?? "",
      playerName: activeCalcName,
      team: activeCalcTeam,
      opponent: calcPlayer?.teamSide === "home" ? (selectedGame.awayAbbr ?? "") : (selectedGame.homeAbbr ?? ""),
      gameId: selectedGameId,
      market: calcMarket,
      bookLine: line,
      currentStats: calcPlayer ? {
        ab: calcPlayer.ab,
        h: calcPlayer.h,
        tb: calcPlayer.tb,
        k: calcPlayer.k,
        bb: calcPlayer.bb,
        battingOrder: calcPlayer.battingOrderSlot,
      } : undefined,
      gameContext: {
        inning: selectedGame.inning ?? 1,
        isTopInning: selectedGame.isTopInning ?? true,
      },
    });
  };

  const handleAddToSlip = (sig: MlbSignalData) => {
    if (mlbSlipPicks.length >= 10) return;
    const exists = mlbSlipPicks.find(p => p.playerId === sig.playerId && p.market === sig.market);
    if (exists) return;
    setMlbSlipPicks(prev => [...prev, {
      playerId: sig.playerId, playerName: sig.playerName, market: sig.market,
      line: sig.bookLine ?? 0, side: sig.recommendedSide,
      sportsbook: sig.sportsbook ?? "draftkings", edge: sig.edge ?? null,
      enginePct: sig.enginePct, gameId: sig.gameId ?? "",
      overOdds: sig.overOdds, underOdds: sig.underOdds,
    }]);
  };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/mlb/live-games"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mlb/edge-feed"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mlb/hr-radar"] });
  };

  useEffect(() => {
    if (selectedGameId && games.length > 0 && !games.find(g => g.gameId === selectedGameId)) {
      setSelectedGameId(null);
    }
  }, [games, selectedGameId]);

  if (authLoading || gamesLoading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-3">
        <SkeletonCard count={4} />
      </div>
    );
  }

  if (mlbUpgradeNeeded) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-12 flex flex-col items-center justify-center gap-4">
        <EmptyState
          icon="⚾"
          title="MLB Preview Limit Reached"
          description="You've used your 2 free MLB preview plays for today. Upgrade to All Sports for unlimited MLB access."
        />
        <a href="/pricing" data-testid="link-mlb-upgrade-pricing"
          className="w-full max-w-xs py-2.5 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors text-center block">
          Upgrade to All Sports — $65/mo
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      {activeSubTab === "games" && (
        <>
          {games.length === 0 ? (
            <div className="text-xs text-muted-foreground py-3" data-testid="text-no-mlb-games-today">
              No MLB games scheduled today. Check back soon.
            </div>
          ) : (
            <GameChipStrip
              games={games}
              selectedGameId={selectedGameId}
              onSelectGame={(id) => { setSelectedGameId(id); setCalcPlayer(null); setCalcPlayerName(""); setCalcResult(null); setCalcBookLine(""); }}
              edgeFeedSignals={edgeFeedSignals}
              onRefresh={handleRefresh}
            />
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-4 order-2 lg:order-1">
              <div className="rounded-xl border border-border bg-card" data-testid="mlb-calculator">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40">
                  <Calculator className="w-4 h-4 text-primary" />
                  <span className="text-xs font-bold text-foreground">Matchup Details</span>
                </div>

                <div className="p-4 space-y-4">
                  <div>
                    <label htmlFor="calc-player-name" className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1">Player</label>
                    <input
                      id="calc-player-name"
                      type="text"
                      data-testid="input-calc-player-name"
                      value={calcPlayer ? calcPlayer.playerName : calcPlayerName}
                      onChange={(e) => { setCalcPlayer(null); setCalcPlayerName(e.target.value); setCalcResult(null); }}
                      placeholder="Type name or click box score row"
                      className="w-full px-3 py-2.5 text-xs rounded-lg bg-secondary/60 border border-border/40 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                  </div>

                  {calcPlayer && (
                    <div className="p-2 rounded-lg bg-secondary/30 border border-border/30 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <div className="text-[10px] text-muted-foreground flex items-center gap-2 flex-wrap flex-1">
                          <span className="font-semibold text-foreground">{calcPlayer.teamAbbr}</span>
                          <span>#{calcPlayer.battingOrderSlot || "—"}</span>
                          <span>{calcPlayer.ab} AB</span>
                          <span>{calcPlayer.h} H</span>
                          <span>{calcPlayer.tb} TB</span>
                          <span>{calcPlayer.k} K</span>
                        </div>
                        <button
                          data-testid="button-clear-calc-player"
                          onClick={() => { setCalcPlayer(null); setCalcPlayerName(""); setCalcResult(null); }}
                          className="text-muted-foreground hover:text-foreground text-[10px] px-1.5 py-0.5"
                        >✕</button>
                      </div>
                      {calcPlayer.priorABResults && calcPlayer.priorABResults.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap" data-testid="calc-player-ab-results">
                          <span className="text-[9px] text-muted-foreground/60 uppercase font-semibold mr-0.5">ABs:</span>
                          {calcPlayer.priorABResults.map((ab, i) => {
                            const isHit = ab.outcome === "hit" || ab.outcome === "home_run" || ab.outcome === "hr" || ab.outcome === "homerun";
                            const isHR = ab.outcome === "home_run" || ab.outcome === "hr" || ab.outcome === "homerun";
                            const isK = ab.outcome === "strikeout";
                            const isWalk = ab.outcome === "walk" || ab.outcome === "hbp";
                            const label = isHR ? "HR" : isHit ? "H" : isK ? "K" : isWalk ? "BB" : "O";
                            const evLabel = ab.exitVelocity ? `${Math.round(ab.exitVelocity)}` : null;
                            const color = isHR
                              ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/40"
                              : isHit
                              ? "bg-green-500/20 text-green-400 border-green-500/40"
                              : isK
                              ? "bg-red-500/20 text-red-400 border-red-500/40"
                              : isWalk
                              ? "bg-blue-500/20 text-blue-400 border-blue-500/40"
                              : "bg-secondary/40 text-muted-foreground border-border/40";
                            return (
                              <span
                                key={i}
                                data-testid={`ab-result-${i}`}
                                className={`inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded border ${color}`}
                                title={[
                                  `AB ${i + 1}: ${ab.outcome}`,
                                  ab.exitVelocity ? `EV: ${ab.exitVelocity} mph` : null,
                                  ab.launchAngle != null ? `LA: ${ab.launchAngle}°` : null,
                                  ab.distance ? `Dist: ${ab.distance} ft` : null,
                                ].filter(Boolean).join(" · ")}
                              >
                                {label}
                                {evLabel && <span className="text-[8px] font-normal opacity-70">{evLabel}</span>}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  <div>
                    <label htmlFor="calc-market" className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1">Stat Type</label>
                    <select
                      id="calc-market"
                      data-testid="select-calc-market"
                      value={calcMarket}
                      onChange={(e) => { setCalcMarket(e.target.value); setCalcResult(null); setCalcBookLine(""); }}
                      className="w-full px-3 py-2.5 text-xs rounded-lg bg-secondary/60 border border-border/40 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                    >
                      {MLB_CALC_MARKETS.map(m => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="calc-book-line" className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1">Live Line</label>
                    <input
                      id="calc-book-line"
                      type="number"
                      step="0.5"
                      min="0"
                      data-testid="input-calc-book-line"
                      value={calcBookLine}
                      onChange={(e) => setCalcBookLine(e.target.value)}
                      placeholder="e.g. 1.5"
                      className="w-full px-3 py-2.5 text-xs rounded-lg bg-secondary/60 border border-border/40 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                  </div>

                  {oddsEntries.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Sportsbook Lines</div>
                      <div className="flex flex-wrap gap-1.5">
                        {oddsEntries.map((o) => (
                          <button
                            key={o.sportsbook}
                            data-testid={`button-odds-${o.sportsbook}`}
                            onClick={() => setCalcBookLine(String(o.line))}
                            className={`text-[10px] px-2.5 py-1.5 rounded-lg border transition-colors ${
                              calcBookLine === String(o.line)
                                ? "border-primary/50 bg-primary/10 text-primary"
                                : "border-border/40 bg-secondary/30 text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            <span className="font-semibold">{BOOK_DISPLAY[o.sportsbook] ?? o.sportsbook}</span>
                            <span className="ml-1.5">{o.line}</span>
                            <span className="ml-1 text-green-400">O {formatOdds(o.overOdds)}</span>
                            <span className="ml-1 text-blue-400">U {formatOdds(o.underOdds)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {oddsLoading && (
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <Loader2 className="w-3 h-3 animate-spin" /> Loading odds...
                    </div>
                  )}
                  {oddsError && !oddsLoading && (
                    <div className="text-[10px] text-muted-foreground/60">Could not load live odds — enter a line manually.</div>
                  )}

                  <button
                    data-testid="button-calculate-mlb"
                    onClick={handleCalculate}
                    disabled={calcMutation.isPending || !activeCalcName.trim() || !calcBookLine || parseFloat(calcBookLine) <= 0 || !selectedGame}
                    className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-h-[44px]"
                  >
                    {calcMutation.isPending ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Calculating...</>
                    ) : (
                      <><Calculator className="w-4 h-4" /> Calculate Probability</>
                    )}
                  </button>

                  {calcMutation.isError && (
                    <div className="text-center text-xs text-red-400 py-2">
                      {(calcMutation.error as Error)?.message || "Calculation failed — check inputs"}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="lg:col-span-8 order-1 lg:order-2">
              {selectedGameId && selectedGame ? (
                <MlbBoxScore
                  gameId={selectedGameId}
                  signals={edgeFeedSignals}
                  onPlayerClick={handleBoxScoreClick}
                  awayAbbr={selectedGame.awayAbbr}
                  homeAbbr={selectedGame.homeAbbr}
                  onAddToSlip={handleAddToSlip}
                />
              ) : (
                <div className="rounded-xl border border-border/40 bg-card p-8 text-center space-y-3" data-testid="mlb-games-empty-state">
                  <Target className="w-10 h-10 text-muted-foreground/30 mx-auto" />
                  <div className="text-sm font-bold text-foreground">Ready to Predict</div>
                  <div className="text-xs text-muted-foreground">Select a game above to get started</div>
                  <div className="text-[11px] text-muted-foreground/60 space-y-1 max-w-xs mx-auto text-left">
                    <div className="flex items-center gap-2"><span className="text-primary">◎</span> Click a game tile above</div>
                    <div className="flex items-center gap-2"><span className="text-primary">◎</span> Click a player in the box score</div>
                    <div className="flex items-center gap-2"><span className="text-primary">◎</span> Pick a stat type & live line</div>
                    <div className="flex items-center gap-2"><span className="text-primary">◎</span> Hit Calculate</div>
                  </div>
                </div>
              )}

              {calcResult && (
                <div className="mt-4 rounded-xl border border-border bg-card p-6 space-y-5 animate-in slide-in-from-top-2 duration-300" data-testid="mlb-calc-results">
                  <div className="flex items-center justify-center">
                    <ProbabilityRing probability={calcResult.probability ?? calcResult.modelProbability ?? 50} size={140} strokeWidth={12} />
                  </div>

                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="bg-secondary/30 rounded-lg p-3">
                      <div className="text-[9px] text-muted-foreground uppercase font-semibold">Side</div>
                      <div className={`text-lg font-black ${
                        calcResult.recommendedSide === "OVER" ? "text-green-400" : calcResult.recommendedSide === "UNDER" ? "text-blue-400" : "text-muted-foreground"
                      }`}>
                        {calcResult.recommendedSide ?? "—"}
                      </div>
                    </div>
                    <div className="bg-secondary/30 rounded-lg p-3">
                      <div className="text-[9px] text-muted-foreground uppercase font-semibold">Edge</div>
                      <div className={`text-lg font-black ${
                        (calcResult.edge ?? 0) > 0 ? "text-green-400" : "text-muted-foreground"
                      }`}>
                        {calcResult.edge != null ? `${calcResult.edge > 0 ? "+" : ""}${calcResult.edge.toFixed(1)}%` : "—"}
                      </div>
                    </div>
                    <div className="bg-secondary/30 rounded-lg p-3">
                      <div className="text-[9px] text-muted-foreground uppercase font-semibold">Projection</div>
                      <div className="text-lg font-black text-foreground">
                        {calcResult.projection?.toFixed(2) ?? calcResult.expectedTotal?.toFixed(2) ?? "—"}
                      </div>
                    </div>
                  </div>

                  {calcResult.probability != null && (
                    <div className="text-center text-xs text-muted-foreground">
                      <span>Model: <strong className="text-foreground">{(calcResult.probability ?? calcResult.modelProbability ?? 0).toFixed(1)}%</strong> Over {calcBookLine}</span>
                    </div>
                  )}

                  {calcResult.confidenceTier && (
                    <div className="text-center">
                      <span className={`text-[10px] font-black px-3 py-1 rounded-full ${
                        calcResult.confidenceTier === "ELITE" ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" :
                        calcResult.confidenceTier === "STRONG" ? "bg-green-500/20 text-green-400 border border-green-500/30" :
                        calcResult.confidenceTier === "SOLID" ? "bg-blue-500/20 text-blue-400 border border-blue-500/30" :
                        "bg-secondary/40 text-muted-foreground border border-border/30"
                      }`}>
                        {calcResult.confidenceTier}
                      </span>
                    </div>
                  )}

                  {calcResult.featureScores && Object.keys(calcResult.featureScores).length > 0 && (
                    <div className="rounded-lg p-3 bg-secondary/20 border border-border/20">
                      <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Analysis Scores</div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        {Object.entries(calcResult.featureScores as Record<string, number>)
                          .filter(([, v]) => Math.abs(v - 0.5) >= 0.03)
                          .sort(([, a], [, b]) => Math.abs(b - 0.5) - Math.abs(a - 0.5))
                          .slice(0, 8)
                          .map(([key, val]) => {
                            const label: Record<string, string> = {
                              contactQuality: "Contact", batSpeedPower: "Power", handednessMatchup: "Platoon",
                              pitchBlendMatchup: "Pitch Mix", hotColdForm: "Form", parkEnv: "Park/Env",
                              bvp: "vs Pitcher", lineupOpportunity: "Lineup", bullpenFactor: "Bullpen",
                              pitcherSuppression: "Stuff", pitcherDeterioration: "Fatigue",
                            };
                            const color = val >= 0.65 ? "#22c55e" : val >= 0.55 ? "#a3e635" : val >= 0.45 ? "#94a3b8" : val >= 0.35 ? "#f59e0b" : "#ef4444";
                            return (
                              <div key={key} className="flex items-center justify-between gap-1">
                                <span className="text-[9px] text-muted-foreground">{label[key] ?? key}</span>
                                <div className="flex items-center gap-1.5">
                                  <div className="w-12 h-1.5 rounded-full bg-secondary/60 overflow-hidden">
                                    <div className="h-full rounded-full" style={{ width: `${Math.round(val * 100)}%`, backgroundColor: color }} />
                                  </div>
                                  <span className="text-[8px] font-bold tabular-nums" style={{ color }}>{(val * 100).toFixed(0)}</span>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}

                  {calcResult.recommendedSide && calcResult.recommendedSide !== "NO_EDGE" && (
                    <button
                      data-testid="button-add-calc-to-slip"
                      onClick={() => handleAddToSlip({
                        playerId: calcPlayer?.playerId ?? "",
                        playerName: activeCalcName,
                        market: calcMarket,
                        bookLine: parseFloat(calcBookLine),
                        enginePct: calcResult.probability ?? calcResult.modelProbability ?? 0,
                        edge: calcResult.edge ?? null,
                        recommendedSide: calcResult.recommendedSide ?? "",
                        gameId: selectedGameId ?? "",
                        sportsbook: "manual",
                      } as MlbSignalData)}
                      className="w-full py-2.5 rounded-lg border border-green-500/30 bg-green-500/10 text-green-400 font-semibold text-xs hover:bg-green-500/20 transition-colors min-h-[44px]"
                    >
                      + Add to Bet Slip
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {!selectedGameId && !isElite && games.length > 0 && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 text-center space-y-3">
              <div className="text-sm font-bold text-foreground">Unlock MLB Edges</div>
              <div className="text-xs text-muted-foreground">
                {edgeFeedSignals.length > 0
                  ? `${edgeFeedSignals.length} live signal${edgeFeedSignals.length !== 1 ? "s" : ""} across ${games.filter(g => g.status === "live").length || games.length} game${games.length !== 1 ? "s" : ""} — upgrade to see them all.`
                  : `${games.length} game${games.length !== 1 ? "s" : ""} today — upgrade to see live probabilities, edge percentages, and bet recommendations.`}
              </div>
              <a href="/upgrade" data-testid="link-mlb-upgrade-cta"
                className="inline-block px-5 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors">
                Upgrade to All Sports →
              </a>
            </div>
          )}
        </>
      )}

      {activeSubTab === "live_feed" && (
        <div className="space-y-4">
          <div className="flex gap-1.5 flex-wrap">
            {(["all", "3rd", "5th", "7th"] as const).map(sub => (
              <button
                key={sub}
                data-testid={`tab-feed-${sub}`}
                onClick={() => setLiveFeedSub(sub)}
                className={`px-3.5 py-2.5 min-h-[44px] text-xs font-semibold rounded-full border transition-all ${
                  liveFeedSub === sub ? "bg-background text-foreground border-primary/50 shadow-sm" : "border-border/50 text-muted-foreground hover:text-foreground"
                }`}
              >
                {sub === "all" ? "All Signals" : sub === "3rd" ? "3rd Inning" : sub === "5th" ? "5th Inning" : "7th Inning"}
              </button>
            ))}
          </div>
          {(() => {
            let filtered = edgeFeedSignals;
            if (liveFeedSub !== "all") {
              const feedTagKey = liveFeedSub === "3rd" ? "inning_3" : liveFeedSub === "5th" ? "inning_5" : "inning_7";
              filtered = edgeFeedSignals.filter(s => (s.feedTags ?? []).includes(feedTagKey));
            }
            if (liveFeedSub === "all") {
              if (!isElite && filtered.length > 0) {
                const visibleSlice = filtered.slice(0, 1);
                return (
                  <div className="space-y-6">
                    <TopPlays signals={visibleSlice} onAddToSlip={handleAddToSlip} />
                    {filtered.length > 1 && (
                      <div className="relative">
                        <div className="filter blur-[6px] pointer-events-none select-none" aria-hidden="true">
                          <LiveBoard signals={filtered.slice(1, 6)} />
                        </div>
                        <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
                          <div className="rounded-xl border border-primary/30 bg-card/95 backdrop-blur-sm p-5 text-center space-y-3 max-w-sm shadow-xl">
                            <div className="text-sm font-bold text-foreground">
                              {filtered.length - 1} more signal{filtered.length - 1 !== 1 ? "s" : ""} available
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Unlock all MLB edges, probabilities, and bet recommendations with All Sports.
                            </div>
                            <a href="/upgrade" data-testid="link-mlb-all-feed-upgrade"
                              className="inline-block px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors">
                              Upgrade to All Sports →
                            </a>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div className="space-y-6">
                  <TopPlays signals={filtered} onAddToSlip={handleAddToSlip} />
                  <LiveBoard signals={filtered} onAddToSlip={handleAddToSlip} />
                </div>
              );
            }
            return filtered.length === 0 ? (
              <div className="rounded-xl border border-border/40 bg-card p-8 text-center">
                <div className="flex items-center justify-center gap-2 text-sm text-blue-400">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400" />
                  </span>
                  Monitoring {liveFeedSub} inning signals
                </div>
                <div className="text-xs text-muted-foreground/60 mt-1">Signals appear as games progress and pitcher fatigue data accumulates.</div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {(isElite ? filtered : filtered.slice(0, 1)).map((sig, idx) => (
                    <MlbSignalCard key={`${sig.playerId}-${sig.market}-${sig.gameId}-${idx}`} sig={sig} onAddToSlip={handleAddToSlip} />
                  ))}
                </div>
                {!isElite && filtered.length > 1 && (
                  <div className="relative">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 filter blur-[6px] pointer-events-none select-none" aria-hidden="true">
                      {filtered.slice(1, 3).map((sig, idx) => (
                        <MlbSignalCard key={`blur-${sig.playerId}-${sig.market}-${idx}`} sig={sig as MlbSignalData} />
                      ))}
                    </div>
                    <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
                      <div className="rounded-xl border border-primary/30 bg-card/95 backdrop-blur-sm p-5 text-center space-y-3 max-w-sm shadow-xl">
                        <div className="text-sm font-bold text-foreground">
                          {filtered.length - 1} more signal{filtered.length - 1 !== 1 ? "s" : ""} available
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Unlock all MLB edges, probabilities, and bet recommendations with All Sports.
                        </div>
                        <a href="/upgrade" data-testid="link-mlb-feed-upgrade"
                          className="inline-block px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors">
                          Upgrade to All Sports →
                        </a>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {activeSubTab === "hr_radar" && (
        <HRRadarSection isElite={isElite} />
      )}

      {mlbSlipPicks.length > 0 && (
        <div className="fixed bottom-4 right-4 left-4 sm:left-auto sm:w-96 z-50" data-testid="mlb-bet-slip">
          <div className="rounded-xl border border-green-500/30 bg-card shadow-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-foreground">MLB Bet Slip ({mlbSlipPicks.length})</span>
              <button
                data-testid="button-clear-mlb-slip"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setMlbSlipPicks([])}
              >Clear All</button>
            </div>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {mlbSlipPicks.map((pick, idx) => (
                <div key={`${pick.playerId}-${pick.market}`} className="flex items-center justify-between text-xs py-1.5 px-2 rounded-lg bg-secondary/40 border border-border/30">
                  <div className="min-w-0">
                    <span className="font-semibold text-foreground truncate block">{pick.playerName}</span>
                    <div className="flex items-center gap-1.5 text-muted-foreground flex-wrap">
                      <span className={`font-bold ${pick.side === "OVER" ? "text-green-400" : "text-blue-400"}`}>{pick.side}</span>
                      <span>{MARKET_LABELS[pick.market] ?? pick.market} {pick.line}</span>
                      {pick.edge != null && pick.edge > 0 && <span className="text-green-400 font-semibold">+{pick.edge.toFixed(1)}%</span>}
                      {pick.overOdds != null && pick.side === "OVER" && <span>({formatOdds(pick.overOdds)})</span>}
                      {pick.underOdds != null && pick.side === "UNDER" && <span>({formatOdds(pick.underOdds)})</span>}
                    </div>
                  </div>
                  <button
                    data-testid={`button-remove-slip-${idx}`}
                    className="text-muted-foreground hover:text-red-400 shrink-0 ml-2 p-2 min-w-[44px] min-h-[44px] flex items-center justify-center"
                    onClick={() => setMlbSlipPicks(prev => prev.filter((_, i) => i !== idx))}
                  >✕</button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                data-testid="button-copy-mlb-slip"
                className="text-xs py-3 min-h-[44px] rounded-lg border border-border hover:bg-muted transition-colors text-foreground font-semibold px-3"
                onClick={() => {
                  const text = mlbSlipPicks.map(p => `${p.playerName} — ${MARKET_LABELS[p.market] ?? p.market} ${p.side} ${p.line}`).join("\n");
                  navigator.clipboard?.writeText(text);
                }}
              >Copy</button>
              <a
                data-testid="link-mlb-slip-dk"
                href="https://sportsbook.draftkings.com/leagues/baseball/mlb?category=player-props"
                target="_blank" rel="noopener noreferrer"
                className="flex-1 text-xs py-3 min-h-[44px] rounded-lg bg-[#1a6f3c] hover:bg-[#1a8f4c] text-white text-center font-semibold transition-colors"
                onClick={() => {
                  const text = mlbSlipPicks.map(p => `${p.playerName} — ${MARKET_LABELS[p.market] ?? p.market} ${p.side} ${p.line}`).join("\n");
                  navigator.clipboard?.writeText(text);
                }}
              >DraftKings</a>
              <a
                data-testid="link-mlb-slip-fd"
                href="https://sportsbook.fanduel.com/baseball?tab=player-props"
                target="_blank" rel="noopener noreferrer"
                className="flex-1 text-xs py-3 min-h-[44px] rounded-lg bg-[#1493ff] hover:bg-[#0d7ee6] text-white text-center font-semibold transition-colors"
                onClick={() => {
                  const text = mlbSlipPicks.map(p => `${p.playerName} — ${MARKET_LABELS[p.market] ?? p.market} ${p.side} ${p.line}`).join("\n");
                  navigator.clipboard?.writeText(text);
                }}
              >FanDuel</a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MlbLivePage({ activeSubTab = "games" }: { activeSubTab?: "games" | "live_feed" | "hr_radar" }) {
  return (
    <MLBErrorBoundary>
      <MlbLiveInner activeSubTab={activeSubTab} />
    </MLBErrorBoundary>
  );
}
