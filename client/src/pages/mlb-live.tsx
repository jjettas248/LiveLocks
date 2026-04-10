import { useState, useEffect, useRef, Component, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { TopPlays } from "@/components/mlb/TopPlays";
import { TopLiveOpportunities } from "@/components/mlb/TopLiveOpportunities";
import { LiveBoard } from "@/components/mlb/LiveBoard";
import { MlbSignalCard, type MlbSignalData } from "@/components/mlb/MlbSignalCard";
import { MlbBoxScore, type MlbPlayerStat } from "@/components/mlb/MlbBoxScore";
import type { MLBSignal } from "@shared/mlbSignal";
import { ProbabilityRing } from "@/components/probability-ring";
import { StatCard } from "@/components/stat-card";
import { SkeletonCard } from "@/components/sports/SkeletonCard";
import { EmptyState } from "@/components/sports/EmptyState";
import { Radio, Target, RefreshCw, Calculator, Loader2, Flame, Zap, Trophy, Eye, ChevronDown, ChevronUp, Bell, Activity, X, BarChart3, Plus, ExternalLink, TrendingUp, TrendingDown, Clock, CheckCircle2, Calendar } from "lucide-react";
import {
  mapHrRadarCardToUi, mapAlertToUi, formatTriggerReason,
  radarScoreToTier, launchAngleLabel, formatMlbDisplayValue,
  sanitizeDisplayString, mapPitcherSignals, liveScoreToGrade,
  mapMlbSignalToUi,
  type HrRadarCardUi,
  type HrRadarAnalyzeViewModel,
} from "@/lib/mlbUiMappers";
import { MODE_STYLES } from "@/lib/mlbFormatters";
import {
  buildSignalViewModel, buildHrRadarViewModel, buildGameViewModel,
  buildAtBatLogViewModel, buildPitchMatchupViewModel,
  buildCalcHydration, buildTopOpportunitiesViewModel,
  normalizeMarket, normalizePct,
  type SignalViewModel, type CalcHydrationPayload,
} from "@/lib/mlb/mlbViewModel";
import {
  formatMlbDisplayInning, formatMlbDisplayStatus,
  normalizeMlbGameChip,
} from "@/lib/mlb/mlbNormalizers";

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

type CanonicalGradedOutcome = {
  sessionDate: string;
  gameId: string;
  playerId: string;
  playerName: string;
  team: string;
  finalStatus: "hit" | "miss";
  detectedLabel: string | null;
  hitLabel: string | null;
  hitInning?: number | null;
  hitHalf?: string | null;
  detectedScore: number | null;
  peakScore: number | null;
  triggerTags: string[];
  resolvedAt: string | null;
};

type HrRadarGradingSummary = {
  wins: number;
  losses: number;
  totalGraded: number;
  hitRate: number;
};

type HRRadarResponse = {
  hrEdges: Array<any>;
  bettableHR: Array<any>;
  cashedToday: Array<any>;
  activity?: Array<any>;
  hrWatchlist: Array<any>;
  gradedHits?: CanonicalGradedOutcome[];
  gradedMisses?: CanonicalGradedOutcome[];
  gradingSummary?: HrRadarGradingSummary;
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
  { value: "hrr", label: "H+R+RBI" },
  { value: "home_runs", label: "Home Runs" },
  { value: "batter_strikeouts", label: "Strikeouts" },
  { value: "pitcher_strikeouts", label: "Pitcher Ks" },
  { value: "pitcher_outs", label: "Pitcher Outs" },
  { value: "hits_allowed", label: "Hits Allowed" },
  { value: "walks_allowed", label: "Walks Allowed" },
  { value: "hr_allowed", label: "HR Allowed" },
];

const MLB_ODDS_STAT_MAP: Record<string, string> = {
  hits: "hits", total_bases: "total_bases", home_runs: "home_runs",
  hrr: "hrr", batter_strikeouts: "batter_strikeouts",
  pitcher_strikeouts: "pitcher_strikeouts", pitcher_outs: "pitcher_outs",
  hits_allowed: "hits_allowed", walks_allowed: "walks_allowed", hr_allowed: "hr_allowed",
};

const TRIGGER_TAG_MAP: Record<string, string> = {
  "PATH_A": "Multi HR-Shaped", "PATH_B": "Elite Contact", "PATH_C": "Late Game",
  "watch": "Monitoring", "cooldown": "Cooldown",
};
function formatTriggerTag(raw: string): string {
  if (!raw) return "";
  for (const [prefix, label] of Object.entries(TRIGGER_TAG_MAP)) {
    if (raw.startsWith(prefix)) return label;
  }
  if (raw.includes("hrShaped")) return "HR-Shaped Contact";
  if (raw.includes("elite")) return "Elite Contact";
  if (raw.includes("missed")) return "Near-Miss HR";
  if (raw.includes("barrel")) return "Barrel";
  if (raw.includes("hard_hit") || raw.includes("hardHit")) return "Hard Hit";
  if (raw.includes("deepFly")) return "Deep Fly";
  return raw.replace(/[:_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()).slice(0, 30);
}

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
  return formatMlbDisplayInning(game);
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

interface HRAlert {
  id: number;
  playerId: string;
  playerName: string;
  teamAbbr: string | null;
  gameId: string;
  alertType: string;
  triggerReason: string | null;
  hrBuildScore: number | null;
  hrIntensity: string | null;
  inning: number | null;
  outcome: string | null;
  signalState: string | null;
  decision: string | null;
  confidenceScore: number | null;
  formattedReason: string | null;
  factors: {
    avgEV: number | null;
    maxEV: number | null;
    avgLA: number | null;
    barrels: number;
    hardHits: number;
    deepFlyouts: number;
    batSpeedScore?: number;
    pitcherFatigueBoost?: number;
    parkWindBoost?: number;
    platoonBoost?: number;
  } | null;
  createdAt: string | null;
}

interface AlertConversionStats {
  totalAlerts: number;
  totalHR: number;
  totalNoHR: number;
  totalPending: number;
  conversionRate: number;
  alertTypeBreakdown: Record<string, { total: number; hr: number; rate: number }>;
}

function LivePulse({ updatedAt }: { updatedAt: number }) {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceUpdate(n => n + 1), 5_000);
    return () => clearInterval(id);
  }, []);
  if (!updatedAt) return null;
  const ago = Math.round((Date.now() - updatedAt) / 1000);
  const label = ago < 5 ? "Just now" : ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`;
  const isStale = ago > 30;
  return (
    <span className={`flex items-center gap-1 text-[10px] tabular-nums ${isStale ? "text-yellow-500" : "text-green-500/80"}`} data-testid="text-live-pulse">
      <span className={`w-1.5 h-1.5 rounded-full ${isStale ? "bg-yellow-500" : "bg-green-500 animate-pulse"}`} />
      {label}
    </span>
  );
}

const SIGNAL_STRIP_MARKET_SHORT: Record<string, string> = {
  hits: "Hits", total_bases: "TB", hrr: "H+R+RBI", pitcher_strikeouts: "Pitcher K", pitcher_outs: "Outs",
  hits_allowed: "Hits Alwd", walks_allowed: "BB Alwd", home_runs: "HR", batter_strikeouts: "Ks", hr_allowed: "HR Alwd",
  hr: "HR", runs: "Runs", rbi: "RBI", stolen_bases: "SB", earned_runs: "ER", pitcher_k: "Pitcher K",
};

function SignalStrip({ signals, onPlayerClick }: { signals: MlbSignalData[]; onPlayerClick: (sig: MlbSignalData) => void }) {
  const topSignals = [...signals]
    .filter(s => normalizePct(s.enginePct) >= 55 && s.recommendedSide !== "NO_EDGE" && !s.alreadyHit)
    .sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0))
    .slice(0, 8);

  if (topSignals.length === 0) return null;

  return (
    <div className="mb-3" data-testid="signal-strip">
      <div className="flex items-center gap-2 mb-1.5 px-1">
        <Zap className="w-3 h-3 text-yellow-400" />
        <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Top Signals</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
        {topSignals.map((sig, i) => {
          const pct = normalizePct(sig.enginePct);
          const tierColor = pct >= 80 ? "#22c55e" : pct >= 70 ? "#eab308" : "#3b82f6";
          const sideColor = sig.recommendedSide === "OVER" ? "text-green-400" : "text-blue-400";
          return (
            <button
              key={`${sig.playerId}-${sig.market}-${i}`}
              data-testid={`signal-strip-card-${i}`}
              onClick={() => onPlayerClick(sig)}
              className="flex-shrink-0 rounded-lg border px-3 py-2 bg-card hover:bg-primary/5 transition-colors text-left min-w-[140px]"
              style={{ borderColor: tierColor + "40" }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: tierColor }} />
                <span className="text-[10px] font-bold text-foreground truncate">{sig.playerName}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-muted-foreground">{SIGNAL_STRIP_MARKET_SHORT[sig.market] ?? sig.market.replace(/_/g, " ")}</span>
                <span className={`text-[10px] font-black ${sideColor}`}>{sig.recommendedSide}</span>
                <span className="text-[10px] font-bold tabular-nums" style={{ color: tierColor }}>{pct.toFixed(0)}%</span>
                {sig.edge != null && sig.edge > 0 && (
                  <span className="text-[8px] text-green-400/70 tabular-nums">+{sig.edge.toFixed(1)}%</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SpikeAlertBanner({ signals }: { signals: MlbSignalData[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [autoDismiss, setAutoDismiss] = useState<string[]>([]);

  const spikeSignals = signals.filter(s => {
    const key = `${s.playerId}-${s.market}`;
    if (dismissed.has(key)) return false;
    const hasPitcherSignal = (s as MlbSignalData & { pitcherSignals?: string[] | null }).pitcherSignals?.length;
    const isHR = s.market === "home_runs" && normalizePct(s.enginePct) >= 60;
    const isElite = s.confidenceTier === "ELITE";
    const isLiveSpike = (s.liveScore ?? 0) >= 0.10;
    return hasPitcherSignal || isHR || isElite || isLiveSpike;
  });

  useEffect(() => {
    if (spikeSignals.length === 0) return;
    const keys = spikeSignals.map(s => `${s.playerId}-${s.market}`);
    const newKeys = keys.filter(k => !autoDismiss.includes(k));
    if (newKeys.length > 0) {
      setAutoDismiss(prev => [...prev, ...newKeys]);
      const timer = setTimeout(() => {
        setDismissed(prev => {
          const next = new Set(prev);
          newKeys.forEach(k => next.add(k));
          return next;
        });
      }, 15000);
      return () => clearTimeout(timer);
    }
  }, [spikeSignals.map(s => `${s.playerId}-${s.market}`).join(",")]);

  if (spikeSignals.length === 0) return null;

  const top = spikeSignals[0];
  const pitcherSigs = (top as MlbSignalData & { pitcherSignals?: string[] | null }).pitcherSignals ?? undefined;
  const isHR = top.market === "home_runs";
  const isLiveSpike = (top.liveScore ?? 0) >= 0.10;
  const borderColor = isLiveSpike ? "rgba(59,130,246,0.5)" : isHR ? "rgba(250,204,21,0.4)" : "rgba(34,197,94,0.4)";
  const bgColor = isLiveSpike ? "rgba(59,130,246,0.08)" : isHR ? "rgba(250,204,21,0.08)" : "rgba(34,197,94,0.08)";

  return (
    <div
      data-testid="spike-alert-banner"
      className="mb-3 rounded-lg border px-4 py-2.5 flex items-center gap-3 animate-in slide-in-from-top-2 duration-300"
      style={{ borderColor, background: bgColor }}
    >
      {isLiveSpike ? (
        <Zap className="w-4 h-4 shrink-0 text-blue-400" />
      ) : (
        <Flame className={`w-4 h-4 shrink-0 ${isHR ? "text-yellow-400" : "text-green-400"}`} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {isLiveSpike && (
            <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30">
              LIVE SPIKE
            </span>
          )}
          <span className="text-[11px] font-bold text-foreground">{top.playerName}</span>
          <span className={`text-[10px] font-black ${top.recommendedSide === "OVER" ? "text-green-400" : "text-blue-400"}`}>
            {SIGNAL_STRIP_MARKET_SHORT[top.market] ?? top.market.replace(/_/g, " ")} {top.recommendedSide}
          </span>
          <span className="text-[10px] font-bold tabular-nums text-foreground">{normalizePct(top.enginePct).toFixed(0)}%</span>
          {top.liveScore != null && top.liveScore > 0 && (() => {
            const lsGrade = liveScoreToGrade(top.liveScore);
            return <span className="text-[9px] font-bold" style={{ color: `${lsGrade.color}B3` }}>Live {lsGrade.grade}</span>;
          })()}
          {pitcherSigs && pitcherSigs.length > 0 && pitcherSigs.slice(0, 2).map(sig => {
            const STRIP_PSIG: Record<string, string> = {
              DOMINANT: "Dominant", K_STREAK: "K Streak", COMMAND_LOCKED: "Locked In",
              VELOCITY_DROP: "Velo Drop", FATIGUE_RISK: "Fatigued", HARD_CONTACT: "Hard Hit",
            };
            return (
              <span key={sig} className="text-[8px] font-black px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                {STRIP_PSIG[sig] ?? sig.replace(/_/g, " ")}
              </span>
            );
          })}
        </div>
      </div>
      <button
        data-testid="button-dismiss-spike"
        onClick={() => setDismissed(prev => { const next = new Set(prev); next.add(`${top.playerId}-${top.market}`); return next; })}
        className="text-[10px] text-muted-foreground hover:text-foreground shrink-0 p-2 min-w-[44px] min-h-[44px] flex items-center justify-center"
      >
        Dismiss
      </button>
    </div>
  );
}

function GameChipStrip({ games, selectedGameId, onSelectGame, edgeFeedSignals, onRefresh, dataUpdatedAt, isRefreshing }: {
  games: MLBGame[];
  selectedGameId: string | null;
  onSelectGame: (id: string | null) => void;
  edgeFeedSignals: MlbSignalData[];
  onRefresh: () => void;
  dataUpdatedAt: number;
  isRefreshing?: boolean;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4" data-testid="mlb-games-strip">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Radio className="w-3.5 h-3.5 text-green-500" /> Today's Games
          <LivePulse updatedAt={dataUpdatedAt} />
        </h2>
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className={`flex items-center gap-1 text-xs transition-colors p-2 min-w-[44px] min-h-[44px] ${isRefreshing ? "text-primary cursor-not-allowed" : "text-muted-foreground hover:text-foreground"}`}
          data-testid="button-refresh-mlb-games"
        >
          <RefreshCw className={`w-3 h-3 ${isRefreshing ? "animate-spin" : ""}`} /> {isRefreshing ? "Updating…" : "Refresh"}
        </button>
      </div>
      <div className="flex gap-2 flex-wrap">
        {games.map((game) => {
          const chip = normalizeMlbGameChip(game);
          const isSelected = game.gameId === selectedGameId;
          const lean = gameLeanBadge(edgeFeedSignals, game.gameId);
          const statusText = chip.isLive ? chip.displayInning : chip.displayStatus;

          return (
            <button
              key={chip.gameId}
              data-testid={`button-game-${chip.gameId}`}
              onClick={() => onSelectGame(isSelected ? null : chip.gameId)}
              className={`flex flex-col items-center px-3 py-2 rounded-lg border text-xs min-w-[130px] transition-all ${
                isSelected
                  ? "border-primary bg-primary/10 ring-1 ring-primary shadow-[0_0_16px_-3px_hsl(var(--primary)/0.4)]"
                  : "border-border/60 bg-secondary/40 hover:bg-secondary/70 hover:shadow-[0_0_14px_-3px_hsl(var(--primary)/0.25)]"
              }`}
            >
              <div className="flex items-center justify-between w-full gap-2">
                <span className="font-semibold text-foreground">{chip.awayTeam}</span>
                <span className={`font-mono font-bold ${chip.isLive ? "text-green-400" : "text-primary"}`}>
                  {chip.awayScore ?? 0} – {chip.homeScore ?? 0}
                </span>
                <span className="font-semibold text-foreground">{chip.homeTeam}</span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground mt-0.5">
                {chip.isLive && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />}
                {chip.isFinal && <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 inline-block" />}
                <span className={chip.isLive ? "text-green-400" : chip.isFinal ? "text-muted-foreground/60" : ""}>
                  {statusText}
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
            <span>Monitoring -- signals appear as the game progresses</span>
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


function BuildScoreMeter({ score, size = "sm" }: { score: number; size?: "sm" | "lg" }) {
  const pct = Math.min((score / 10) * 100, 100);
  const color = score >= 7 ? "bg-red-500" : score >= 5 ? "bg-orange-500" : score >= 3.5 ? "bg-yellow-500" : "bg-zinc-500";
  const h = size === "lg" ? "h-2" : "h-1.5";
  return (
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      <div className={`flex-1 ${h} rounded-full bg-zinc-800 overflow-hidden`}>
        <div className={`${h} rounded-full ${color} transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-[10px] font-bold tabular-nums ${score >= 7 ? "text-red-400" : score >= 5 ? "text-orange-400" : score >= 3.5 ? "text-yellow-400" : "text-zinc-400"}`}>{score.toFixed(1)}</span>
    </div>
  );
}


function RadarCardOddsChips({ playerName, team, gameTeams }: { playerName: string; team: string; gameTeams: { awayAbbr: string; homeAbbr: string } | null }) {
  type OddsEntry = { line: number; overOdds: number; underOdds: number; sportsbook: string };
  const playerTeam = team || (gameTeams?.homeAbbr ?? "");
  const opponentTeam = playerTeam === gameTeams?.homeAbbr ? (gameTeams?.awayAbbr ?? "") : (gameTeams?.homeAbbr ?? "");
  const { data: oddsData, isLoading } = useQuery<Record<string, OddsEntry>>({
    queryKey: ["/api/mlb/odds", playerName, "home_runs", playerTeam, opponentTeam],
    queryFn: async () => {
      if (!playerName || !gameTeams) return {};
      const params = new URLSearchParams({
        playerName,
        statType: "home_runs",
        playerTeam,
        opponentTeam,
        inPlay: "true",
      });
      const res = await fetch(`/api/mlb/odds?${params}`, { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!playerName && !!gameTeams,
    staleTime: 60_000,
  });
  const entries = Object.entries(oddsData ?? {})
    .filter(([k]) => !k.startsWith("_"))
    .map(([book, v]) => { const entry = v as OddsEntry; return { ...entry, sportsbook: book }; });

  if (isLoading) return <div className="text-[9px] text-muted-foreground/50 flex items-center gap-1"><Loader2 className="w-2.5 h-2.5 animate-spin" /> Loading books...</div>;
  if (entries.length === 0) return null;

  return (
    <div className="space-y-1" data-testid="radar-odds-chips">
      <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">HR Lines by Book</div>
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-thin">
        {entries.map((o) => (
          <div
            key={o.sportsbook}
            data-testid={`radar-book-${o.sportsbook}`}
            className="flex-shrink-0 text-[9px] px-2.5 py-1.5 rounded-lg border border-border/40 bg-secondary/30 text-muted-foreground"
          >
            <div className="font-semibold text-foreground">{BOOK_DISPLAY[o.sportsbook] ?? o.sportsbook}</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="font-bold tabular-nums">{o.line}</span>
              <span className="text-green-400 tabular-nums">O {formatOdds(o.overOdds)}</span>
              <span className="text-blue-400 tabular-nums">U {formatOdds(o.underOdds)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RadarCard({ card, onQuickAdd, onOpenDetails, gameTeams }: {
  card: HrRadarCardUi;
  onQuickAdd?: (sig: MlbSignalData) => void;
  onOpenDetails?: (card: HrRadarCardUi) => void;
  gameTeams?: { awayAbbr: string; homeAbbr: string } | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const isCashed = card.status === "CASHED";
  const isMissed = card.status === "MISSED";
  const isAlert = card.status === "ALERT";
  const isPending = card.status === "PENDING";

  const dynState = card.dynamicState;
  const modeStyle = card.mode && MODE_STYLES[card.mode] && !isCashed && !isMissed ? MODE_STYLES[card.mode] : null;
  const borderClass = isCashed
    ? "border-emerald-500/60 bg-emerald-500/10 shadow-[0_0_12px_rgba(16,185,129,0.15)]"
    : isMissed
    ? "border-zinc-500/30 bg-zinc-500/5"
    : dynState === "BET_NOW"
    ? "border-red-500/50 bg-red-500/8 shadow-[0_0_16px_rgba(239,68,68,0.2)]"
    : dynState === "PREPARE"
    ? "border-orange-500/40 bg-orange-500/6"
    : dynState === "COOLED_OFF"
    ? "border-zinc-500/30 bg-zinc-500/5"
    : dynState === "CLOSED"
    ? "border-zinc-600/20 bg-zinc-600/5"
    : modeStyle
    ? ""
    : isAlert
    ? "border-red-500/40 bg-red-500/5"
    : "border-yellow-500/30 bg-yellow-500/5";
  const modeCardStyle = modeStyle ? { borderColor: modeStyle.border, background: modeStyle.bg } : undefined;
  const pulseClass = (isAlert || dynState === "BET_NOW") && !isCashed && !isMissed ? "animate-pulse" : "";
  const DYNAMIC_STATE_BADGES: Record<string, { label: string; cls: string }> = {
    BET_NOW: { label: "BET NOW", cls: "bg-red-500/20 text-red-300 ring-1 ring-red-500/40 animate-pulse" },
    PREPARE: { label: "PREPARE", cls: "bg-orange-500/20 text-orange-300 ring-1 ring-orange-500/30" },
    WATCH: { label: "WATCHING", cls: "bg-yellow-500/15 text-yellow-400" },
    COOLED_OFF: { label: "COOLED OFF", cls: "bg-zinc-500/15 text-zinc-400 ring-1 ring-zinc-500/20" },
    CLOSED: { label: "CLOSED", cls: "bg-zinc-600/15 text-zinc-500" },
  };
  const dynBadge = dynState ? DYNAMIC_STATE_BADGES[dynState] : null;

  const statusBadge = isCashed
    ? { label: "CASHED \u2714", cls: "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30" }
    : isMissed
    ? { label: "MISSED", cls: "bg-zinc-500/15 text-zinc-400" }
    : dynBadge
    ? dynBadge
    : isAlert
    ? { label: "ACTIVE ALERT", cls: "bg-red-500/15 text-red-400" }
    : isPending
    ? { label: "PENDING", cls: "bg-blue-500/15 text-blue-400" }
    : { label: "WATCHING", cls: "bg-yellow-500/15 text-yellow-400" };

  const decisionBadge = dynState
    ? null
    : card.decision === "BET_NOW"
    ? { label: "BET NOW", cls: "bg-red-500/20 text-red-300 border border-red-500/30" }
    : card.decision === "PREPARE"
    ? { label: "PREPARE", cls: "bg-orange-500/20 text-orange-300 border border-orange-500/30" }
    : card.decision === "MONITOR"
    ? { label: "MONITOR", cls: "bg-yellow-500/20 text-yellow-300 border border-yellow-500/30" }
    : null;

  return (
    <div
      data-testid={`card-hr-radar-${card.playerId}`}
      className={`rounded-xl border ${borderClass} p-3 space-y-2 ${pulseClass} cursor-pointer transition-all hover:shadow-md`}
      style={modeCardStyle}
      onClick={() => setExpanded(!expanded)}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!expanded); } }}
    >
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: `${card.radarTierColor}20` }}>
          {isCashed ? <Trophy className="w-4 h-4 text-emerald-400" /> :
           isAlert ? <Flame className="w-4 h-4" style={{ color: card.radarTierColor }} /> :
           isMissed ? <X className="w-4 h-4 text-zinc-400" /> :
           <Eye className="w-4 h-4" style={{ color: card.radarTierColor }} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-foreground truncate">{card.playerName}</span>
            {card.team && <span className="text-[10px] text-muted-foreground shrink-0">{card.team}</span>}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {card.detectedLabel && <span>Detected {card.detectedLabel}</span>}
            {!card.detectedLabel && card.detectedInning != null && <span>Detected: Inn {card.detectedInning}</span>}
            {card.scoreIncreased && card.scoreIncreaseLabel && (
              <span className="text-green-400 font-semibold">{card.scoreIncreaseLabel}</span>
            )}
            {card.hitInning != null && card.hitHalf && (
              <span className="text-emerald-400 font-semibold">HR in {card.hitHalf}{card.hitInning}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${statusBadge.cls}`} data-testid={`badge-status-${card.playerId}`}>{statusBadge.label}</span>
          {card.mode && MODE_STYLES[card.mode] && !isCashed && !isMissed && (
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
              style={{ color: MODE_STYLES[card.mode].color, background: MODE_STYLES[card.mode].bg, border: `1px solid ${MODE_STYLES[card.mode].border}` }}
              data-testid={`badge-mode-${card.playerId}`}
            >
              {MODE_STYLES[card.mode].icon} {MODE_STYLES[card.mode].label}
            </span>
          )}
          {decisionBadge && !isCashed && !isMissed && (
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${decisionBadge.cls}`} data-testid={`badge-decision-${card.playerId}`}>{decisionBadge.label}</span>
          )}
          {card.confidenceScore > 0 && !isCashed && !isMissed && (
            <span className={`text-[10px] font-bold tabular-nums ${card.confidenceScore >= 8 ? "text-red-400" : card.confidenceScore >= 6 ? "text-orange-400" : card.confidenceScore >= 4 ? "text-yellow-400" : "text-zinc-400"}`} data-testid={`confidence-${card.playerId}`}>{card.confidenceScore}/10</span>
          )}
        </div>
      </div>

      {card.radarScore > 0 && (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5">
            <Activity className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground">HR Readiness</span>
          </div>
          <BuildScoreMeter score={card.radarScore} size="lg" />
        </div>
      )}

      {card.evidenceTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {card.evidenceTags.slice(0, 4).map((tag, i) => (
            <span key={i} className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${tag.color}`}>{tag.label}</span>
          ))}
        </div>
      )}

      {dynState && !isCashed && !isMissed && (
        <div className="space-y-1" data-testid={`dynamic-hr-state-${card.playerId}`}>
          <div className="flex items-center gap-2 text-[10px] flex-wrap">
            {card.hrConversionCalibrated != null && (
              <span className={`font-bold tabular-nums ${card.hrConversionCalibrated >= 0.14 ? "text-red-400" : card.hrConversionCalibrated >= 0.08 ? "text-orange-400" : "text-yellow-400"}`}>
                Conv {(card.hrConversionCalibrated * 100).toFixed(1)}%
              </span>
            )}
            {card.remainingPA != null && (
              <>
                <span className="text-muted-foreground/40">|</span>
                <span className="text-muted-foreground tabular-nums">{card.remainingPA.toFixed(1)} PA left</span>
              </>
            )}
            {card.pitcherVulnerability != null && (
              <>
                <span className="text-muted-foreground/40">|</span>
                <span className={`tabular-nums ${card.pitcherVulnerability >= 70 ? "text-red-400" : card.pitcherVulnerability >= 50 ? "text-orange-400" : "text-muted-foreground"}`}>
                  P.Vuln {card.pitcherVulnerability}
                </span>
              </>
            )}
            {card.decayFactor != null && card.decayFactor < 0.95 && (
              <>
                <span className="text-muted-foreground/40">|</span>
                <span className="text-zinc-400 tabular-nums">Decay {(card.decayFactor * 100).toFixed(0)}%</span>
              </>
            )}
          </div>
          {card.cooldownReason && (
            <div className="text-[9px] text-zinc-400 italic" data-testid={`cooldown-reason-${card.playerId}`}>{card.cooldownReason}</div>
          )}
        </div>
      )}

      {card.isHotHitter && (
        <div className="flex items-center gap-1" data-testid={`badge-hot-hitter-${card.playerId}`}>
          <Flame className="w-3 h-3 text-orange-400" />
          <span className="text-[9px] font-bold text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded-full">
            HOT — {card.hotHitterHrCount} HR{(card.hotHitterHrCount ?? 0) > 1 ? "s" : ""} last {card.hotHitterPeriod}
          </span>
        </div>
      )}

      {card.onlyHomersVerified && (
        <div className="flex items-center gap-1" data-testid={`badge-oh-verified-${card.playerId}`}>
          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
          <span className="text-[9px] font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
            OnlyHomers Verified
            {card.ohExitVelocity != null && ` — ${card.ohExitVelocity} EV`}
            {card.ohDistance != null && ` · ${card.ohDistance}ft`}
          </span>
        </div>
      )}

      {(card.formattedReason || card.triggerLabel) && (
        <div className="text-[10px] text-muted-foreground italic leading-tight" data-testid={`reason-${card.playerId}`}>{card.formattedReason || card.triggerLabel}</div>
      )}

      {card.edge != null && card.enginePct != null && !isCashed && !isMissed && (
        <div className="flex items-center gap-2 text-[10px] flex-wrap">
          <span className="text-green-400 font-bold">{card.side} {card.line?.toFixed(1)}</span>
          <span className="text-muted-foreground/40">|</span>
          <span className={`font-bold ${(card.edge ?? 0) > 0 ? "text-green-400" : "text-muted-foreground"}`}>
            {(card.edge ?? 0) > 0 ? "+" : ""}{(card.edge ?? 0).toFixed(1)}% Edge
          </span>
          <span className="text-muted-foreground/40">|</span>
          <span className="text-foreground">{card.enginePct?.toFixed(1)}% Prob</span>
          {card.bestBook && (
            <>
              <span className="text-muted-foreground/40">|</span>
              <span className="text-muted-foreground">{BOOK_DISPLAY[card.bestBook] ?? card.bestBook}</span>
              {card.bestOdds != null && <span className="text-green-400/70 tabular-nums">{formatOdds(card.bestOdds)}</span>}
            </>
          )}
        </div>
      )}

      {card.edge == null && card.enginePct == null && card.conversionPct != null && !isCashed && !isMissed && (
        <div className="flex items-center gap-2 text-[10px] flex-wrap" data-testid={`conv-pct-${card.playerId}`}>
          <span className={`font-bold ${card.conversionPct >= 0.12 ? "text-green-400" : card.conversionPct >= 0.08 ? "text-yellow-400" : "text-muted-foreground"}`}>
            Conv {(card.conversionPct * 100).toFixed(1)}%
          </span>
          {card.alertPath && (
            <>
              <span className="text-muted-foreground/40">|</span>
              <span className="text-muted-foreground/60">{card.alertPath.replace("_", " ")}</span>
            </>
          )}
        </div>
      )}

      {expanded && (
        <div className="space-y-2 pt-1 border-t border-border/20 animate-in slide-in-from-top-1 duration-200" onClick={(e) => e.stopPropagation()}>
          {dynState && !isCashed && !isMissed && (card.dynamicDrivers.length > 0 || card.dynamicSuppressors.length > 0) && (
            <div className="space-y-1" data-testid={`dynamic-drivers-${card.playerId}`}>
              {card.dynamicDrivers.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {card.dynamicDrivers.slice(0, 5).map((d, i) => (
                    <span key={i} className="text-[8px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 font-semibold">{d}</span>
                  ))}
                </div>
              )}
              {card.dynamicSuppressors.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {card.dynamicSuppressors.slice(0, 3).map((s, i) => (
                    <span key={i} className="text-[8px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400 font-semibold">{s}</span>
                  ))}
                </div>
              )}
              {card.dynamicPeakScore != null && card.dynamicPeakScore > 0 && (
                <div className="text-[9px] text-muted-foreground">
                  Peak: {(card.dynamicPeakScore * 100).toFixed(1)}% ({card.dynamicPeakState})
                  {card.dynamicTickCount != null && ` · ${card.dynamicTickCount} ticks`}
                </div>
              )}
            </div>
          )}
          {(isCashed || isMissed) && (card.alertPath || card.conversionPct != null || card.peakScore != null || card.detectedLabel) && (
            <div className="flex flex-wrap gap-1.5 text-[10px]" data-testid={`diagnostics-${card.playerId}`}>
              {card.alertPath && (
                <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-semibold">{card.alertPath.replace("_", " ")}</span>
              )}
              {card.conversionPct != null && (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-semibold">Conv {(card.conversionPct * 100).toFixed(1)}%</span>
              )}
              {card.peakScore != null && card.peakScore > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 font-semibold">Peak {card.peakScore.toFixed(1)}</span>
              )}
              {card.detectedLabel && (
                <span className="px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground">Detected {card.detectedLabel}</span>
              )}
            </div>
          )}
          {!isCashed && !isMissed && gameTeams && (
            <RadarCardOddsChips playerName={card.playerName} team={card.team} gameTeams={gameTeams} />
          )}
          {card.reasons.length > 0 && (
            <div className="space-y-0.5">
              {card.reasons.slice(0, 5).map((r, i) => (
                <p key={i} className="text-[10px] text-muted-foreground flex items-start gap-1">
                  <span className="text-primary/50 mt-px">•</span><span>{r}</span>
                </p>
              ))}
            </div>
          )}
          {card.badges.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {card.badges.map((b) => (
                <span key={b} className="text-[8px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 font-semibold">{b}</span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            {onQuickAdd && !isCashed && !isMissed && (
              <button
                data-testid={`button-hr-quick-add-${card.playerId}`}
                className="flex-1 py-2 rounded-lg text-[10px] font-semibold transition-colors flex items-center justify-center gap-1 min-h-[36px]"
                style={{ background: "rgba(34,197,94,0.12)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onQuickAdd({
                    playerId: card.playerId,
                    playerName: card.playerName,
                    market: "home_runs",
                    bookLine: card.line ?? 0.5,
                    enginePct: card.enginePct ?? 0,
                    edge: card.edge ?? null,
                    recommendedSide: card.side ?? "OVER",
                    gameId: card.gameId ?? "",
                    sportsbook: card.bestBook ?? "draftkings",
                  } as MlbSignalData);
                }}
              >
                <Plus className="w-3 h-3" /> Add HR to Slip
              </button>
            )}
            {onOpenDetails && (
              <button
                data-testid={`button-hr-details-${card.playerId}`}
                className="py-2 px-3 rounded-lg text-[10px] font-semibold transition-colors flex items-center justify-center gap-1 min-h-[36px] border border-border/40 text-muted-foreground hover:text-foreground hover:bg-muted/30"
                onClick={(e) => { e.stopPropagation(); onOpenDetails(card); }}
              >
                <Calculator className="w-3 h-3" /> Analyze
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function HRRadarAnalyzeModal({ playerId, gameId, onClose }: { playerId: string; gameId: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<{ alert: any; analyze: any }>({
    queryKey: ["/api/mlb/hr-radar-analyze", playerId, gameId],
    enabled: !!playerId && !!gameId,
  });

  if (isLoading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose} data-testid="modal-hr-analyze">
        <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-center gap-2 py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading analysis...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error || !data?.alert) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose} data-testid="modal-hr-analyze">
        <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
          <p className="text-sm text-muted-foreground text-center py-4">No analysis data available</p>
          <button className="w-full py-2 rounded-lg text-sm border border-border/40 text-muted-foreground" onClick={onClose} data-testid="button-close-analyze">Close</button>
        </div>
      </div>
    );
  }

  const alert = data.alert;
  const analyze = data.analyze;
  const priorABs: Array<{ abNumber: number; exitVelocity: number | null; launchAngle: number | null; distance: number | null; outcome: string; isBarrel: boolean; isHardHit: boolean; perABxBA?: number | null; contactGrade?: string; hrProbability?: number }> = analyze?.priorABs ?? [];
  const initialScore = parseFloat(alert.initialReadinessScore ?? "0");
  const currentScore = parseFloat(alert.currentReadinessScore ?? "0");
  const peakScore = parseFloat(alert.peakReadinessScore ?? "0");
  const tier = radarScoreToTier(currentScore);

  const statusColor = alert.status === "hit" ? "text-emerald-400" : alert.status === "miss" ? "text-zinc-400" : "text-blue-400";
  const statusLabel = alert.status === "hit" ? "HIT" : alert.status === "miss" ? "MISS" : "LIVE";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose} data-testid="modal-hr-analyze">
      <div className="bg-card border border-border rounded-2xl w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-border/40 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-foreground">{alert.playerName}</h3>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>{alert.team}</span>
              {(analyze?.totalPA != null || analyze?.completedAB != null) && (
                <span className="font-semibold">{analyze.completedAB ?? 0} AB{analyze.totalPA != null && analyze.totalPA > (analyze.completedAB ?? 0) ? ` · ${analyze.totalPA} PA` : ""}</span>
              )}
              {alert.detectedLabel && <span>Detected {alert.detectedLabel}</span>}
              <span className={`font-bold ${statusColor}`}>{statusLabel}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted/30" data-testid="button-close-analyze-x"><X className="w-4 h-4 text-muted-foreground" /></button>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center p-2 rounded-lg bg-muted/20 border border-border/20">
              <div className="text-[9px] text-muted-foreground">Initial</div>
              <div className="text-sm font-bold text-foreground">{initialScore.toFixed(1)}</div>
            </div>
            <div className="text-center p-2 rounded-lg bg-muted/20 border border-border/20">
              <div className="text-[9px] text-muted-foreground">Current</div>
              <div className="text-sm font-bold" style={{ color: tier.color }}>{currentScore.toFixed(1)}</div>
            </div>
            <div className="text-center p-2 rounded-lg bg-muted/20 border border-border/20">
              <div className="text-[9px] text-muted-foreground">Peak</div>
              <div className="text-sm font-bold text-foreground">{peakScore.toFixed(1)}</div>
            </div>
          </div>

          {alert.scoreIncreased && alert.scoreIncreaseLabel && (
            <div className="flex items-center gap-2 text-[10px] px-2 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20">
              <Zap className="w-3 h-3 text-green-400" />
              <span className="text-green-400 font-semibold">Score increased: {alert.scoreIncreaseLabel}</span>
            </div>
          )}

          {alert.hitLabel && (
            <div className="flex items-center gap-2 text-[10px] px-2 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <Trophy className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-400 font-semibold">Home Run in {alert.hitLabel}</span>
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-semibold">
              <Activity className="w-3 h-3" />
              <span>Tier: {alert.confidenceTier?.toUpperCase()}</span>
              <span className="text-muted-foreground/40">|</span>
              <span>State: {alert.signalState?.toUpperCase()}</span>
            </div>
            {(alert.triggerTags ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {(alert.triggerTags as string[]).map((tag: string, i: number) => (
                  <span key={i} className="text-[8px] px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-400 font-semibold">{formatTriggerTag(tag)}</span>
                ))}
              </div>
            )}
            {alert.summaryText && (
              <p className="text-[10px] text-muted-foreground italic">{alert.summaryText}</p>
            )}
          </div>

          {priorABs.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-muted-foreground flex items-center gap-1.5">
                <Target className="w-3 h-3" />
                <span>At-Bat Log ({priorABs.length} PAs)</span>
              </div>
              <div className="space-y-1">
                {priorABs.map((ab) => {
                  const outcomeLabel = ab.outcome === "hit" ? "Hit" : ab.outcome === "strikeout" ? "K" : ab.outcome === "walk" ? "BB" : ab.outcome === "hbp" ? "HBP" : ab.outcome === "out" ? "Out" : ab.outcome === "error" ? "Error" : "PA";
                  const outcomeColor = ab.outcome === "hit" ? "text-green-400" : ab.outcome === "strikeout" ? "text-red-400" : ab.outcome === "walk" || ab.outcome === "hbp" ? "text-blue-400" : "text-muted-foreground";
                  return (
                    <div key={ab.abNumber} className="flex items-center gap-2 text-[10px] p-1.5 rounded-lg bg-muted/10 border border-border/10">
                      <span className="w-5 text-center text-muted-foreground font-bold">#{ab.abNumber}</span>
                      <span className={`font-semibold ${outcomeColor}`}>{outcomeLabel}</span>
                      {ab.exitVelocity != null && (
                        <span className={`font-bold tabular-nums ${ab.isBarrel ? "text-orange-400" : ab.isHardHit ? "text-yellow-400" : "text-muted-foreground"}`}>
                          {ab.exitVelocity.toFixed(1)} mph
                        </span>
                      )}
                      {ab.launchAngle != null && <span className="text-muted-foreground tabular-nums">{ab.launchAngle.toFixed(0)}°</span>}
                      {ab.distance != null && <span className="text-muted-foreground tabular-nums">{ab.distance.toFixed(0)}ft</span>}
                      {ab.isBarrel && <span className="text-[8px] px-1 py-0.5 rounded bg-orange-500/15 text-orange-400 font-bold">BRL</span>}
                      {ab.isHardHit && !ab.isBarrel && <span className="text-[8px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-400 font-bold">HH</span>}
                      {ab.perABxBA != null && ab.perABxBA > 0 && (
                        <span className={`text-[8px] px-1 py-0.5 rounded font-bold tabular-nums ${ab.perABxBA >= 0.700 ? "bg-emerald-500/15 text-emerald-400" : ab.perABxBA >= 0.400 ? "bg-sky-500/15 text-sky-400" : "text-muted-foreground bg-muted/20"}`} data-testid={`text-xba-ab-${ab.abNumber}`}>
                          xBA .{(ab.perABxBA * 1000).toFixed(0).padStart(3, "0")}
                        </span>
                      )}
                      {ab.contactGrade && ab.contactGrade !== "weak" && (
                        <span className={`text-[8px] px-1 py-0.5 rounded font-medium ${ab.contactGrade === "barrel" ? "text-orange-400 bg-orange-500/10" : ab.contactGrade === "solid" ? "text-emerald-400 bg-emerald-500/10" : ab.contactGrade === "flare" ? "text-sky-400 bg-sky-500/10" : "text-muted-foreground bg-muted/10"}`}>
                          {ab.contactGrade}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(analyze?.explanationBullets ?? []).length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold text-muted-foreground">Engine Factors</div>
              {(analyze.explanationBullets as string[]).map((b: string, i: number) => (
                <p key={i} className="text-[10px] text-muted-foreground flex items-start gap-1">
                  <span className="text-primary/50 mt-px">•</span><span>{b}</span>
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-border/40">
          <button
            className="w-full py-2.5 rounded-lg text-sm font-semibold bg-muted/20 border border-border/40 text-muted-foreground hover:bg-muted/30 transition-colors"
            onClick={onClose}
            data-testid="button-close-analyze-bottom"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function RadarStatsBar({ active, cashed, missed }: { active: number; cashed: number; missed: number }) {
  const total = active + cashed + missed;
  if (total === 0) return null;
  const resolved = cashed + missed;
  const hitRate = resolved > 0 ? Math.round((cashed / resolved) * 100) : 0;
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-card border border-border/40 text-[10px]" data-testid="radar-stats-bar">
      <BarChart3 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span className="font-bold text-foreground">{total} tracked</span>
      {active > 0 && <span className="text-blue-400">{active} live</span>}
      {cashed > 0 && <span className="font-bold text-emerald-400">{cashed} HR</span>}
      {missed > 0 && <span className="text-zinc-400">{missed} miss</span>}
      {resolved > 0 && (
        <span className={`font-bold ml-auto ${hitRate >= 30 ? "text-emerald-400" : hitRate >= 15 ? "text-yellow-400" : "text-zinc-400"}`}>
          {hitRate}% hit rate
        </span>
      )}
    </div>
  );
}

function GradingHistoryPanel({
  todaySummary,
  todayHits,
  todayMisses,
  showCashed,
  showMissed,
  historyDate,
  setHistoryDate,
}: {
  todaySummary: { wins: number; losses: number; totalGraded: number; hitRate: number } | null;
  todayHits: CanonicalGradedOutcome[];
  todayMisses: CanonicalGradedOutcome[];
  showCashed: boolean;
  showMissed: boolean;
  historyDate: string | null;
  setHistoryDate: (d: string | null) => void;
}) {
  const { data: historyData } = useQuery<{ history: GradingHistoryDay[] }>({
    queryKey: ["/api/mlb/hr-radar-grading-history"],
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  const { data: selectedDayData, isLoading: dayLoading } = useQuery<{
    gradedHits: CanonicalGradedOutcome[];
    gradedMisses: CanonicalGradedOutcome[];
    gradingSummary: { wins: number; losses: number; totalGraded: number; hitRate: number };
  }>({
    queryKey: ["/api/mlb/hr-radar-grading", historyDate],
    enabled: !!historyDate,
    placeholderData: (prev) => prev,
  });

  const history = historyData?.history ?? [];
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const pastDays = history.filter(h => h.sessionDate !== todayStr);

  const isViewingHistory = !!historyDate;
  const activeSummary = isViewingHistory ? selectedDayData?.gradingSummary : todaySummary;
  const activeHits = isViewingHistory ? (selectedDayData?.gradedHits ?? []) : todayHits;
  const activeMisses = isViewingHistory ? (selectedDayData?.gradedMisses ?? []) : todayMisses;

  const hasContent = (activeSummary && activeSummary.totalGraded > 0) || activeHits.length > 0 || activeMisses.length > 0;
  const hasHistoryChips = pastDays.length > 0;

  if (!hasContent && !hasHistoryChips) return null;

  const formatChipDate = (dateStr: string) => {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div className="space-y-3" data-testid="hr-radar-grading">
      <div className="flex items-center gap-2 flex-wrap">
        <BarChart3 className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-bold text-foreground">Radar Grading</span>
        {activeSummary && activeSummary.totalGraded > 0 && (
          <span className="text-[9px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground" data-testid="grading-summary-chip">
            {activeSummary.wins}W / {activeSummary.losses}L
          </span>
        )}
        {activeSummary && activeSummary.totalGraded >= 3 && (
          <span className="text-[9px] px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground/70">
            {activeSummary.hitRate}%
          </span>
        )}
        {isViewingHistory && (
          <span className="text-[9px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-medium">
            {formatChipDate(historyDate!)}
          </span>
        )}
      </div>

      {(hasHistoryChips || isViewingHistory) && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1" data-testid="grading-history-chips">
          <button
            data-testid="grading-chip-today"
            onClick={() => setHistoryDate(null)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold whitespace-nowrap transition-all ${
              !isViewingHistory
                ? "bg-primary/15 text-primary border border-primary/30"
                : "bg-muted/30 text-muted-foreground border border-transparent hover:bg-muted/50"
            }`}
          >
            <Calendar className="w-3 h-3" />
            Today
            {todaySummary && todaySummary.totalGraded > 0 && (
              <span className="text-[8px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold">
                {todaySummary.wins}W
              </span>
            )}
          </button>
          {pastDays.slice(0, 7).map(day => (
            <button
              key={day.sessionDate}
              data-testid={`grading-chip-${day.sessionDate}`}
              onClick={() => setHistoryDate(day.sessionDate)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold whitespace-nowrap transition-all ${
                historyDate === day.sessionDate
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "bg-muted/30 text-muted-foreground border border-transparent hover:bg-muted/50"
              }`}
            >
              {formatChipDate(day.sessionDate)}
              <span className={`text-[8px] px-1 py-0.5 rounded font-bold ${
                day.calledHits > 0 ? "bg-emerald-500/20 text-emerald-400" : "bg-zinc-500/15 text-zinc-400"
              }`}>
                {day.calledHits}W/{day.misses}L
              </span>
              {day.totalGraded >= 3 && (
                <span className="text-[8px] text-muted-foreground/60">{day.hitRate}%</span>
              )}
            </button>
          ))}
        </div>
      )}

      {dayLoading && isViewingHistory && (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      )}

      {!dayLoading && showCashed && activeHits.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Trophy className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-xs font-semibold text-emerald-400">
              Hits ({activeHits.length})
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {activeHits.map(h => (
              <GradedHitCard key={`canonical-hit-${h.playerId}-${h.gameId}`} outcome={h} />
            ))}
          </div>
        </div>
      )}
      {!dayLoading && showMissed && activeMisses.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <X className="w-3.5 h-3.5 text-zinc-400" />
            <span className="text-xs font-semibold text-zinc-400">
              Misses ({activeMisses.length})
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {activeMisses.slice(0, 12).map(m => (
              <GradedMissCard key={`canonical-miss-${m.playerId}-${m.gameId}`} outcome={m} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GradedHitCard({ outcome }: { outcome: CanonicalGradedOutcome }) {
  const h = outcome;
  const isAutoGraded = (h.triggerTags ?? []).includes("auto_graded");
  const isCalled = !isAutoGraded && h.detectedLabel && h.hitLabel;
  const timeline = isCalled
    ? `${h.detectedLabel} → ${h.hitLabel}`
    : h.hitLabel || (h.hitInning != null && h.hitInning > 0
      ? `${h.hitHalf === "top" ? "T" : h.hitHalf === "bottom" ? "B" : ""}${h.hitInning}`
      : "HR");
  return (
    <div className={`rounded-lg border p-3 space-y-1.5 ${isAutoGraded ? "border-amber-500/20 bg-amber-500/5" : "border-emerald-500/30 bg-emerald-500/5"}`} data-testid={`graded-hit-${h.playerId}-${h.gameId}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Trophy className={`w-3.5 h-3.5 ${isAutoGraded ? "text-amber-400" : "text-emerald-400"}`} />
          <span className="text-xs font-bold text-foreground">{h.playerName}</span>
        </div>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${isAutoGraded ? "bg-amber-500/20 text-amber-400" : "bg-emerald-500/20 text-emerald-400"}`} data-testid={`hit-timeline-${h.playerId}`}>
          {timeline}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
        {h.team && <span>{h.team}</span>}
        {isCalled && (
          <span className="text-emerald-400/80 font-medium">Called {h.detectedLabel}, hit {h.hitLabel}</span>
        )}
        {isAutoGraded && (
          <span className="text-amber-400/80 font-medium">Uncalled HR</span>
        )}
        {h.resolvedAt && (
          <span>{new Date(h.resolvedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[10px] flex-wrap">
        {h.peakScore != null && h.peakScore > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-semibold">Peak {h.peakScore.toFixed(1)}/10</span>
        )}
        {h.detectedScore != null && h.detectedScore > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground">Entry {h.detectedScore.toFixed(1)}</span>
        )}
        {h.triggerTags.length > 0 && h.triggerTags.filter(t => t !== "auto_graded").slice(0, 2).map((tag, i) => (
          <span key={i} className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400/70 text-[9px]">{formatTriggerTag(tag)}</span>
        ))}
      </div>
    </div>
  );
}

function GradedMissCard({ outcome }: { outcome: CanonicalGradedOutcome }) {
  const m = outcome;
  const mAny = m as any;
  return (
    <div className="rounded-lg border border-border/30 bg-muted/20 p-3 space-y-1.5" data-testid={`graded-miss-${m.playerId}-${m.gameId}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <X className="w-3.5 h-3.5 text-zinc-400" />
          <span className="text-xs font-medium text-muted-foreground">{m.playerName}</span>
        </div>
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-500/15 text-zinc-400">No HR</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 flex-wrap">
        {m.team && <span>{m.team}</span>}
        {m.detectedLabel && <span>Detected {m.detectedLabel}</span>}
        {m.resolvedAt && (
          <span>{new Date(m.resolvedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[10px] flex-wrap">
        {m.peakScore != null && m.peakScore > 0 && (
          <span className={`px-1.5 py-0.5 rounded font-semibold ${
            m.peakScore >= 7 ? "bg-orange-500/10 text-orange-400" : "bg-muted/30 text-muted-foreground"
          }`}>Peak {m.peakScore.toFixed(1)}/10</span>
        )}
        {m.detectedScore != null && m.detectedScore > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground">Entry {m.detectedScore.toFixed(1)}</span>
        )}
        {m.triggerTags.length > 0 && m.triggerTags.slice(0, 2).map((tag, i) => (
          <span key={i} className="px-1.5 py-0.5 rounded bg-muted/20 text-muted-foreground/60 text-[9px]">{formatTriggerTag(tag)}</span>
        ))}
        {mAny.alertPath && (
          <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400/60 text-[9px]">{mAny.alertPath.replace("_", " ")}</span>
        )}
        {mAny.conversionPct != null && (
          <span className="px-1.5 py-0.5 rounded bg-muted/20 text-muted-foreground/60 text-[9px]">Conv {(mAny.conversionPct * 100).toFixed(1)}%</span>
        )}
      </div>
    </div>
  );
}

type RadarFilterMode = "all" | "active" | "cashed" | "missed";

type GradingHistoryDay = {
  sessionDate: string;
  calledHits: number;
  uncalledHits: number;
  misses: number;
  totalGraded: number;
  hitRate: number;
};

function HRRadarSection({ isElite, onAddToSlip, onOpenHrDetails, games }: { isElite: boolean; onAddToSlip?: (sig: MlbSignalData) => void; onOpenHrDetails?: (card: HrRadarCardUi) => void; games?: MLBGame[] }) {
  const [radarFilter, setRadarFilter] = useState<RadarFilterMode>("all");
  const [historyDate, setHistoryDate] = useState<string | null>(null);
  const { data: hrData, isLoading } = useQuery<HRRadarResponse>({
    queryKey: ["/api/mlb/hr-radar"],
    refetchInterval: 20_000,
    placeholderData: (prev) => prev,
  });

  const { data: alertData } = useQuery<{ alerts: HRAlert[]; conversionStats: AlertConversionStats | null }>({
    queryKey: ["/api/mlb/alerts"],
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  });

  const gameTeamsMap = new Map((games ?? []).map(g => [g.gameId, { awayAbbr: g.awayAbbr ?? "", homeAbbr: g.homeAbbr ?? "" }]));

  if (isLoading) return <SkeletonCard count={3} />;

  const bettable = hrData?.bettableHR ?? [];
  const watchlist = hrData?.hrWatchlist ?? [];
  const cashedToday = hrData?.cashedToday ?? hrData?.activity ?? [];
  const canonicalHits = hrData?.gradedHits ?? [];
  const canonicalMisses = hrData?.gradedMisses ?? [];
  const gradingSummary = hrData?.gradingSummary ?? null;

  const alerts = alertData?.alerts ?? [];

  const radarState = new Map<string, HrRadarCardUi>();
  const radarKey = (playerId: string, gameId: string) => `${playerId}-${gameId || "unknown"}`;

  for (const w of watchlist) {
    const card = mapHrRadarCardToUi(w, "watch");
    radarState.set(radarKey(card.playerId, card.gameId), card);
  }
  for (const a of alerts) {
    if (a.outcome !== null) continue;
    if (a.alertType === "HR_EARLY") continue;
    const card = mapAlertToUi(a);
    const key = radarKey(card.playerId, card.gameId);
    if (!radarState.has(key)) {
      radarState.set(key, { ...card, status: "WATCH" });
    }
  }
  for (const b of bettable) {
    const card = mapHrRadarCardToUi(b, "edge");
    radarState.set(radarKey(card.playerId, card.gameId), card);
  }
  for (const a of alerts) {
    if (a.outcome !== null) continue;
    if (a.alertType !== "HR_EARLY") continue;
    const key = radarKey(a.playerId, a.gameId);
    const existing = radarState.get(key);
    const card = mapAlertToUi(a);
    if (existing) {
      radarState.set(key, {
        ...existing,
        status: "ALERT",
        signalState: card.signalState ?? existing.signalState,
        decision: card.decision ?? existing.decision,
        confidenceScore: card.confidenceScore > 0 ? card.confidenceScore : existing.confidenceScore,
        formattedReason: card.formattedReason || existing.formattedReason,
        detectedInning: card.detectedInning ?? existing.detectedInning,
        latestInning: card.latestInning ?? existing.latestInning,
      });
    } else {
      radarState.set(key, card);
    }
  }
  for (const c of cashedToday) {
    const card = mapHrRadarCardToUi(c, "cashed");
    radarState.set(radarKey(card.playerId, card.gameId), card);
  }
  for (const a of alerts.filter(al => al.outcome === "HR")) {
    const card = mapAlertToUi(a);
    radarState.set(radarKey(card.playerId, card.gameId), { ...card, status: "CASHED" });
  }
  for (const ch of canonicalHits) {
    const key = radarKey(ch.playerId, ch.gameId);
    if (!radarState.has(key)) {
      radarState.set(key, {
        playerId: ch.playerId,
        playerName: ch.playerName,
        team: ch.team,
        gameId: ch.gameId,
        status: "CASHED",
        signalState: null,
        decision: null,
        confidenceScore: ch.peakScore ?? 0,
        radarScore: ch.peakScore ?? 0,
        radarTier: "strong",
        radarTierLabel: "Cashed",
        radarTierColor: "#10b981",
        formattedReason: ch.hitLabel ? `HR confirmed ${ch.hitLabel}` : "HR confirmed",
        detectedInning: null,
        latestInning: ch.hitInning ?? null,
        edge: null,
        enginePct: null,
        confidenceTier: null,
        hrBuildScore: null,
        badges: [],
        reasons: [],
        evidenceTags: [],
        triggerLabel: "",
        bestBook: null,
        bestOdds: null,
        hrBookCount: 0,
        wasAddedToSlip: false,
        resolvedAt: ch.resolvedAt ?? null,
        hitInning: ch.hitInning ?? null,
        hitHalf: ch.hitHalf ?? null,
        detectedLabel: ch.detectedLabel ?? null,
        scoreIncreased: false,
        scoreIncreaseLabel: null,
        peakScore: ch.peakScore ?? null,
        side: "OVER",
        line: 0.5,
        alertPath: (ch as any).alertPath ?? null,
        conversionPct: (ch as any).conversionPct ?? null,
        mode: null,
        dynamicState: null, hrReadinessScore: null, hrConversionCalibrated: null, hrConversionRaw: null,
        remainingPA: null, pitcherVulnerability: null, decayFactor: null,
        dynamicDrivers: [], dynamicSuppressors: [], cooldownReason: null,
        dynamicPeakScore: null, dynamicPeakState: null, dynamicTickCount: null,
        dynamicLastRecompute: null, dynamicDataFreshness: null,
      } as HrRadarCardUi);
    } else {
      radarState.set(key, { ...radarState.get(key)!, status: "CASHED" });
    }
  }
  const missedAlertsList = alerts.filter(a => a.outcome === "NO_HR");
  const seenMissed = new Set<string>();
  for (const a of missedAlertsList) {
    const key = radarKey(a.playerId, a.gameId);
    if (seenMissed.has(key)) continue;
    seenMissed.add(key);
    if (radarState.has(key)) continue;
    const card = mapAlertToUi(a);
    radarState.set(key, { ...card, status: "MISSED" });
  }
  for (const cm of canonicalMisses) {
    const key = radarKey(cm.playerId, cm.gameId);
    if (!radarState.has(key)) {
      radarState.set(key, {
        playerId: cm.playerId,
        playerName: cm.playerName,
        team: cm.team,
        gameId: cm.gameId,
        status: "MISSED",
        signalState: null,
        decision: null,
        confidenceScore: cm.peakScore ?? 0,
        radarScore: cm.peakScore ?? 0,
        radarTier: "monitor",
        radarTierLabel: "Missed",
        radarTierColor: "#ef4444",
        formattedReason: cm.detectedLabel ? `Tracked from ${cm.detectedLabel}` : "No HR",
        detectedInning: null,
        latestInning: null,
        edge: null,
        enginePct: null,
        confidenceTier: null,
        hrBuildScore: null,
        badges: [],
        reasons: [],
        evidenceTags: [],
        triggerLabel: "",
        bestBook: null,
        bestOdds: null,
        hrBookCount: 0,
        wasAddedToSlip: false,
        resolvedAt: cm.resolvedAt ?? null,
        hitInning: null,
        hitHalf: null,
        detectedLabel: cm.detectedLabel ?? null,
        scoreIncreased: false,
        scoreIncreaseLabel: null,
        peakScore: cm.peakScore ?? null,
        side: "OVER",
        line: 0.5,
        alertPath: (cm as any).alertPath ?? null,
        conversionPct: (cm as any).conversionPct ?? null,
        mode: null,
        dynamicState: null, hrReadinessScore: null, hrConversionCalibrated: null, hrConversionRaw: null,
        remainingPA: null, pitcherVulnerability: null, decayFactor: null,
        dynamicDrivers: [], dynamicSuppressors: [], cooldownReason: null,
        dynamicPeakScore: null, dynamicPeakState: null, dynamicTickCount: null,
        dynamicLastRecompute: null, dynamicDataFreshness: null,
      } as HrRadarCardUi);
    }
  }

  const gameStatusMap = new Map((games ?? []).map(g => [g.gameId, g.status]));
  Array.from(radarState.entries()).forEach(([key, card]) => {
    if (card.status === "WATCH" || card.status === "ALERT") {
      const gStatus = gameStatusMap.get(card.gameId);
      if (gStatus === "final") {
        radarState.set(key, { ...card, status: "MISSED" });
      }
    }
  });

  const allCards = Array.from(radarState.values());
  const dedupCashed = allCards.filter(c => c.status === "CASHED");
  const missedCards = allCards.filter(c => c.status === "MISSED");

  const sortByPriority = (a: HrRadarCardUi, b: HrRadarCardUi) => {
    const dynOrder: Record<string, number> = { BET_NOW: 0, PREPARE: 1, WATCH: 2, COOLED_OFF: 3, CLOSED: 4 };
    const aDyn = a.dynamicState ? dynOrder[a.dynamicState] ?? 2 : null;
    const bDyn = b.dynamicState ? dynOrder[b.dynamicState] ?? 2 : null;
    if (aDyn != null && bDyn != null && aDyn !== bDyn) return aDyn - bDyn;
    if (aDyn != null && bDyn == null) return -1;
    if (aDyn == null && bDyn != null) return 1;
    const aConv = a.hrConversionCalibrated ?? 0;
    const bConv = b.hrConversionCalibrated ?? 0;
    if (aConv !== bConv) return bConv - aConv;
    const decOrder: Record<string, number> = { BET_NOW: 0, PREPARE: 1, MONITOR: 2 };
    const aD = decOrder[a.decision ?? "MONITOR"] ?? 2;
    const bD = decOrder[b.decision ?? "MONITOR"] ?? 2;
    if (aD !== bD) return aD - bD;
    if ((b.confidenceScore ?? 0) !== (a.confidenceScore ?? 0)) return (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0);
    return (b.radarScore ?? 0) - (a.radarScore ?? 0);
  };

  const liveCards = allCards.filter(c => c.status !== "CASHED" && c.status !== "MISSED");
  const peakCards = liveCards.filter(c => c.signalState === "PEAK").sort(sortByPriority);
  const buildingCards = liveCards.filter(c => c.signalState === "BUILDING").sort(sortByPriority);
  const formationCards = liveCards.filter(c => c.signalState === "FORMATION" || (!c.signalState && c.status !== "CASHED" && c.status !== "MISSED")).sort(sortByPriority);
  const cooldownCards = liveCards.filter(c => c.signalState === "COOLDOWN").sort(sortByPriority);

  const isEmpty = peakCards.length === 0 && buildingCards.length === 0 && formationCards.length === 0 && cooldownCards.length === 0 && dedupCashed.length === 0 && missedCards.length === 0;

  const activeCount = peakCards.length + buildingCards.length + formationCards.length + cooldownCards.length;
  const cashedCount = Math.max(dedupCashed.length, canonicalHits.length);
  const missedCount = Math.max(missedCards.length, canonicalMisses.length);

  const showActive = radarFilter === "all" || radarFilter === "active";
  const showCashed = radarFilter === "all" || radarFilter === "cashed";
  const showMissed = radarFilter === "all" || radarFilter === "missed";

  return (
    <div className="space-y-6" data-testid="mlb-hr-radar">
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1" data-testid="hr-radar-filter-bar">
        {([
          { key: "all" as RadarFilterMode, label: "All", count: allCards.length },
          { key: "active" as RadarFilterMode, label: "Active", count: activeCount },
          { key: "cashed" as RadarFilterMode, label: "Cashed", count: cashedCount },
          { key: "missed" as RadarFilterMode, label: "Missed", count: missedCount },
        ]).map(tab => (
          <button
            key={tab.key}
            data-testid={`hr-filter-${tab.key}`}
            onClick={() => setRadarFilter(tab.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap ${
              radarFilter === tab.key
                ? "bg-primary/15 text-primary border border-primary/30"
                : "bg-muted/30 text-muted-foreground border border-transparent hover:bg-muted/50 hover:text-foreground"
            }`}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${
                radarFilter === tab.key
                  ? tab.key === "cashed" ? "bg-emerald-500/20 text-emerald-400"
                    : tab.key === "missed" ? "bg-zinc-500/20 text-zinc-400"
                    : "bg-primary/20 text-primary"
                  : "bg-muted/50 text-muted-foreground"
              }`}>{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {showActive && peakCards.length > 0 && (
        <div className="space-y-3" data-testid="hr-section-peak">
          <div className="flex items-center gap-2">
            <div className="relative">
              <Flame className="w-4.5 h-4.5 text-red-500" />
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 animate-ping" />
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500" />
            </div>
            <span className="text-sm font-bold text-foreground">Peak HR Threats</span>
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 animate-pulse" data-testid="badge-peak-count">{peakCards.length} BET NOW</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(isElite ? peakCards : peakCards.slice(0, 2)).map(c => (
              <RadarCard key={`peak-${c.playerId}-${c.gameId}`} card={c} onQuickAdd={onAddToSlip} onOpenDetails={onOpenHrDetails} gameTeams={gameTeamsMap.get(c.gameId) ?? null} />
            ))}
          </div>
          {!isElite && peakCards.length > 2 && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-center space-y-2">
              <div className="text-sm font-bold text-foreground">{peakCards.length - 2} more peak signal{peakCards.length - 2 !== 1 ? "s" : ""}</div>
              <a href="/upgrade" data-testid="link-hr-upgrade" className="inline-block px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-xs">
                Upgrade to All Sports →
              </a>
            </div>
          )}
        </div>
      )}

      {showActive && <RadarStatsBar active={activeCount} cashed={cashedCount} missed={missedCount} />}

      {showActive && buildingCards.length > 0 && (
        <div className="space-y-3" data-testid="hr-section-building">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-orange-500" />
            <span className="text-sm font-bold text-foreground">Building Pressure</span>
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400" data-testid="badge-building-count">{buildingCards.length} PREPARE</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {buildingCards.map(c => (
              <RadarCard key={`building-${c.playerId}-${c.gameId}`} card={c} onQuickAdd={onAddToSlip} onOpenDetails={onOpenHrDetails} gameTeams={gameTeamsMap.get(c.gameId) ?? null} />
            ))}
          </div>
        </div>
      )}

      {showActive && formationCards.length > 0 && (
        <div className="space-y-3" data-testid="hr-section-formation">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-yellow-500" />
            <span className="text-sm font-bold text-foreground">Early Signals</span>
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400" data-testid="badge-formation-count">{formationCards.length} MONITOR</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {formationCards.map(c => (
              <RadarCard key={`formation-${c.playerId}-${c.gameId}`} card={c} onQuickAdd={onAddToSlip} onOpenDetails={onOpenHrDetails} gameTeams={gameTeamsMap.get(c.gameId) ?? null} />
            ))}
          </div>
        </div>
      )}

      {showActive && cooldownCards.length > 0 && (
        <div className="space-y-3" data-testid="hr-section-cooldown">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-bold text-foreground">Cooldown</span>
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400" data-testid="badge-cooldown-count">{cooldownCards.length}</span>
          </div>
          <p className="text-[10px] text-muted-foreground -mt-1">Recently alerted — monitoring for re-escalation</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {cooldownCards.map(c => (
              <RadarCard key={`cooldown-${c.playerId}-${c.gameId}`} card={c} gameTeams={gameTeamsMap.get(c.gameId) ?? null} />
            ))}
          </div>
        </div>
      )}

      {radarFilter === "active" && activeCount === 0 && (
        <div className="rounded-xl border border-border/40 bg-card p-8 text-center space-y-3">
          <Target className="w-8 h-8 text-muted-foreground/30 mx-auto" />
          <div className="text-sm font-bold text-foreground">No Active Signals</div>
          <div className="text-xs text-muted-foreground">No live HR radar signals right now. Radar scans every at-bat in progress.</div>
        </div>
      )}

      {radarFilter === "cashed" && cashedCount === 0 && (
        <div className="rounded-xl border border-border/40 bg-card p-8 text-center space-y-3">
          <Trophy className="w-8 h-8 text-muted-foreground/30 mx-auto" />
          <div className="text-sm font-bold text-foreground">No Cashed Alerts Yet</div>
          <div className="text-xs text-muted-foreground">When a player on the radar hits a home run, it will appear here.</div>
        </div>
      )}

      {radarFilter === "missed" && missedCount === 0 && (
        <div className="rounded-xl border border-border/40 bg-card p-8 text-center space-y-3">
          <X className="w-8 h-8 text-muted-foreground/30 mx-auto" />
          <div className="text-sm font-bold text-foreground">No Misses Recorded</div>
          <div className="text-xs text-muted-foreground">Radar alerts that finish without a HR show up here after the game ends.</div>
        </div>
      )}

      {isEmpty && radarFilter === "all" && (
        <div className="rounded-xl border border-border/40 bg-card p-8 text-center space-y-3">
          <Target className="w-8 h-8 text-muted-foreground/30 mx-auto" />
          <div className="text-sm font-bold text-foreground">HR Radar Active</div>
          <div className="text-xs text-muted-foreground">No HR signals detected yet. Radar scans live at-bats for HR readiness indicators.</div>
        </div>
      )}

      {showCashed && dedupCashed.length > 0 && !(gradingSummary && (gradingSummary.totalGraded > 0 || canonicalHits.length > 0)) && (
        <div className="space-y-3" data-testid="hr-live-cashed">
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-bold text-foreground">Cashed Today</span>
            <span className="text-[9px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-bold">{dedupCashed.length}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {dedupCashed.map(c => (
              <RadarCard key={`cashed-${c.playerId}-${c.gameId}`} card={c} gameTeams={gameTeamsMap.get(c.gameId) ?? null} />
            ))}
          </div>
        </div>
      )}

      {showMissed && missedCards.length > 0 && !(gradingSummary && (gradingSummary.totalGraded > 0 || canonicalMisses.length > 0)) && (
        <div className="space-y-3" data-testid="hr-live-missed">
          <div className="flex items-center gap-2">
            <X className="w-4 h-4 text-zinc-400" />
            <span className="text-sm font-bold text-foreground">Missed</span>
            <span className="text-[9px] px-2 py-0.5 rounded-full bg-zinc-500/20 text-zinc-400 font-bold">{missedCards.length}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {missedCards.slice(0, 6).map(c => (
              <RadarCard key={`missed-${c.playerId}-${c.gameId}`} card={c} gameTeams={gameTeamsMap.get(c.gameId) ?? null} />
            ))}
          </div>
        </div>
      )}

      <GradingHistoryPanel
        todaySummary={gradingSummary}
        todayHits={canonicalHits}
        todayMisses={canonicalMisses}
        showCashed={showCashed}
        showMissed={showMissed}
        historyDate={historyDate}
        setHistoryDate={setHistoryDate}
      />
    </div>
  );
}

function ResultPanel({ calcResult, calcMarket, calcBookLine, activeCalcName, calcPlayer, selectedGameId, onAddToSlip, handleAddToSlip }: {
  calcResult: any;
  calcMarket: string;
  calcBookLine: string;
  activeCalcName: string;
  calcPlayer: MlbPlayerStat | null;
  selectedGameId: string | null;
  onAddToSlip: (sig: MlbSignalData) => void;
  handleAddToSlip: (sig: MlbSignalData) => void;
}) {
  const [selectedSide, setSelectedSide] = useState<"OVER" | "UNDER">(
    (calcResult.recommendedSide === "UNDER" ? "UNDER" : "OVER") as "OVER" | "UNDER"
  );

  useEffect(() => {
    if (calcResult.recommendedSide === "OVER" || calcResult.recommendedSide === "UNDER") {
      setSelectedSide(calcResult.recommendedSide as "OVER" | "UNDER");
    }
  }, [calcResult.recommendedSide]);

  const hasExplicitSides = typeof calcResult.calibratedProbabilityOver === "number" && typeof calcResult.calibratedProbabilityUnder === "number";
  let overPct: number;
  let underPct: number;
  if (hasExplicitSides) {
    overPct = Math.min(normalizePct(calcResult.calibratedProbabilityOver), 100);
    underPct = Math.min(normalizePct(calcResult.calibratedProbabilityUnder), 100);
  } else {
    const rawProb = calcResult.probability ?? calcResult.modelProbability ?? 50;
    const sided = normalizePct(rawProb);
    const recSide = calcResult.recommendedSide;
    if (recSide === "UNDER") {
      underPct = Math.min(sided, 100);
      overPct = 100 - underPct;
    } else {
      overPct = Math.min(sided, 100);
      underPct = 100 - overPct;
    }
  }
  const displayPct = selectedSide === "OVER" ? overPct : underPct;
  const edge = calcResult.edge ?? 0;
  const projection = calcResult.projection ?? calcResult.expectedTotal;
  const bookImplied = calcResult.bookImplied ?? null;
  const evPct = bookImplied != null ? (overPct - bookImplied) : null;

  const isPitcherMarket = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"].includes(calcMarket);
  const isHRMarket = calcMarket === "home_runs";
  const pa = calcResult.pitcherAnalysis;
  const marketLabel = MARKET_LABELS[calcMarket] ?? calcMarket.replace(/_/g, " ");

  const currentStat = calcPlayer
    ? (calcMarket === "hits" ? (calcPlayer.h ?? 0) : calcMarket === "total_bases" ? (calcPlayer.tb ?? 0) : calcMarket === "home_runs" ? (calcPlayer.hr ?? 0) : calcMarket === "batter_strikeouts" ? (calcPlayer.k ?? 0) : 0)
    : 0;
  const lineNum = parseFloat(calcBookLine);
  const remaining = Number.isFinite(lineNum) ? Math.max(0, lineNum - currentStat) : 0;

  return (
    <div className="space-y-4 animate-in slide-in-from-top-2 duration-300" data-testid="mlb-calc-results">
      <div className="bg-card border border-border rounded-xl p-5 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-48 h-48 bg-primary/5 rounded-full blur-[60px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
        <div className="flex flex-col md:flex-row items-center justify-between gap-5">
          <div className="flex-1 space-y-3 z-10">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span data-testid="badge-live-edge" className="text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-red-500/20 text-red-400">LIVE EDGE</span>
              </div>
              <div className="text-2xl font-bold tracking-tight">
                {activeCalcName} — {marketLabel}{" "}
                <span className="text-primary">{calcBookLine}</span>
              </div>
            </div>

            {calcPlayer && (
              <div className="flex items-center gap-2 text-sm">
                <TrendingUp className="w-4 h-4 text-muted-foreground" />
                <span className="text-muted-foreground">
                  Current: <span className="text-foreground font-bold">{currentStat}</span>
                  {" · "}Needs{" "}
                  <span className="text-foreground font-bold">{remaining.toFixed(1)}</span> more
                </span>
              </div>
            )}

            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span>Projection <strong className="text-foreground">{projection?.toFixed(2) ?? "—"}</strong> vs. Line <strong className="text-foreground">{calcBookLine}</strong></span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
                calcResult.recommendedSide === "OVER" ? "bg-emerald-500/20 text-emerald-400" :
                calcResult.recommendedSide === "UNDER" ? "bg-red-500/20 text-red-400" :
                "bg-secondary/40 text-muted-foreground"
              }`}>
                {calcResult.recommendedSide === "OVER" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {calcResult.recommendedSide === "NO_EDGE" ? "NEUTRAL" : calcResult.recommendedSide}
              </span>
            </div>

            {calcPlayer && (
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span>{calcPlayer.ab} AB</span>
                <span><strong className="text-foreground">{calcPlayer.h}</strong> H</span>
                <span><strong className="text-foreground">{calcPlayer.tb}</strong> TB</span>
                {calcPlayer.hr > 0 && <span className="text-yellow-400 font-bold">{calcPlayer.hr} HR</span>}
                <span>{calcPlayer.bb} BB</span>
                <span>{calcPlayer.k} K</span>
              </div>
            )}

            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                data-testid="button-side-over"
                onClick={() => setSelectedSide("OVER")}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-colors min-h-[44px] ${
                  selectedSide === "OVER"
                    ? "bg-emerald-500/10 border-2 border-emerald-500/50 text-emerald-400 shadow-[0_0_12px_rgba(34,197,94,0.2)]"
                    : "bg-secondary/30 border border-border/40 text-muted-foreground hover:bg-secondary/50"
                }`}
              >
                <TrendingUp className="w-4 h-4" />
                Over {calcBookLine} <span className="opacity-70">({overPct.toFixed(0)}%)</span>
              </button>
              <button
                type="button"
                data-testid="button-side-under"
                onClick={() => setSelectedSide("UNDER")}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-colors min-h-[44px] ${
                  selectedSide === "UNDER"
                    ? "bg-blue-500/10 border-2 border-blue-500/50 text-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.2)]"
                    : "bg-secondary/30 border border-border/40 text-muted-foreground hover:bg-secondary/50"
                }`}
              >
                <TrendingDown className="w-4 h-4" />
                Under {calcBookLine} <span className="opacity-70">({underPct.toFixed(0)}%)</span>
              </button>
            </div>
          </div>
          <div className="flex-shrink-0 z-10 flex flex-col items-center gap-2">
            <ProbabilityRing probability={displayPct} size={160} strokeWidth={14} />
          </div>
        </div>
      </div>

      {calcResult.confidenceTier && (
        <div
          data-testid="badge-model-confidence-calc"
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${
            calcResult.confidenceTier === "ELITE" ? "bg-yellow-500/10 border border-yellow-500/20 text-yellow-400" :
            calcResult.confidenceTier === "STRONG" ? "bg-[#00d4aa]/10 border border-[#00d4aa]/20 text-[#00d4aa]" :
            calcResult.confidenceTier === "SOLID" ? "bg-blue-500/10 border border-blue-500/20 text-blue-400" :
            "bg-secondary/40 border border-border/30 text-muted-foreground"
          }`}
        >
          <Target className="w-3 h-3" />
          {calcResult.confidenceTier === "ELITE" ? "Elite confidence — high-conviction opportunity" :
           calcResult.confidenceTier === "STRONG" ? "Model confidence is strong on this play" :
           calcResult.confidenceTier === "SOLID" ? "Moderate edge detected — solid opportunity" :
           "Marginal edge — proceed with caution"}
        </div>
      )}

      {evPct != null && Math.abs(evPct) >= 1 && (
        <div data-testid="ev-box" className={`rounded-xl border p-4 flex gap-3 items-start ${
          evPct > 0 ? "bg-emerald-500/10 border-emerald-500/30" : "bg-red-500/10 border-red-500/30"
        }`}>
          <div className={`mt-0.5 flex-shrink-0 font-bold text-lg ${evPct > 0 ? "text-emerald-400" : "text-red-400"}`}>
            {evPct > 0 ? "▲" : "▼"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h4 className={`text-sm font-semibold ${evPct > 0 ? "text-emerald-400" : "text-red-400"}`}>
                {Math.abs(evPct) >= 6 ? "Strong" : Math.abs(evPct) >= 3 ? "Moderate" : "Slight"} {selectedSide === "OVER" ? "Over" : "Under"} EV
              </h4>
              <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                evPct > 0 ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
              }`}>
                {evPct > 0 ? "+" : ""}{Math.round(evPct)}% EV
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Model <strong className="text-foreground">{overPct.toFixed(1)}%</strong> vs Book Implied <strong className="text-foreground">{bookImplied.toFixed(1)}%</strong>
            </p>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">
              {Math.abs(evPct) >= 6 ? "High conviction edge vs market." : Math.abs(evPct) >= 3 ? "Solid discrepancy — model sees value." : evPct > 0 ? "Slight edge — use as tiebreaker." : "Model trails implied — line may be priced in."}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          title="Projection"
          value={projection?.toFixed(2) ?? "—"}
          subtitle={`Line: ${calcBookLine}`}
          icon={<Target className="w-4 h-4" />}
          highlight={projection != null && projection > parseFloat(calcBookLine) ? "positive" : "negative"}
        />
        <StatCard
          title="Remaining PA"
          value={calcResult.remainingPA?.toFixed(1) ?? "—"}
          subtitle={`${calcResult.completedAB ?? 0} AB completed`}
          icon={<Clock className="w-4 h-4" />}
          highlight="neutral"
        />
        <StatCard
          title="Edge"
          value={`${edge > 0 ? "+" : ""}${edge.toFixed(1)}%`}
          subtitle="Model vs book line"
          icon={<TrendingUp className="w-4 h-4" />}
          highlight={edge > 3 ? "positive" : edge < -3 ? "negative" : "neutral"}
        />
        <StatCard
          title="Confidence"
          value={calcResult.confidenceTier ?? "—"}
          subtitle={calcResult.mode === "early_explosive" ? "Early Explosive" : "Standard"}
          icon={<Zap className="w-4 h-4" />}
          highlight={calcResult.confidenceTier === "ELITE" || calcResult.confidenceTier === "STRONG" ? "positive" : calcResult.confidenceTier === "SOLID" ? "neutral" : "negative"}
        />
      </div>

      {isPitcherMarket && pa && (
        <div className="rounded-xl border border-border/40 bg-card/50 p-4">
          <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
            Pitcher Analysis
          </div>
          {calcResult.pitcherSignals && calcResult.pitcherSignals.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mb-3">
              {(calcResult.pitcherSignals as string[]).map(sig => {
                const sigBadgeMap: Record<string, { label: string; emoji: string; color: string }> = {
                  DOMINANT: { label: "DOMINANT", emoji: "\uD83D\uDD25", color: "#22c55e" },
                  K_STREAK: { label: "K STREAK", emoji: "\u26A1", color: "#f59e0b" },
                  COMMAND_LOCKED: { label: "COMMAND LOCKED", emoji: "\uD83C\uDFAF", color: "#3b82f6" },
                  VELOCITY_DROP: { label: "VELO DROP", emoji: "\u26A0\uFE0F", color: "#ef4444" },
                  FATIGUE_RISK: { label: "FATIGUE", emoji: "\u26A0\uFE0F", color: "#f97316" },
                  HARD_CONTACT: { label: "HARD CONTACT", emoji: "\u26A0\uFE0F", color: "#ef4444" },
                };
                const badge = sigBadgeMap[sig];
                return badge ? (
                  <span key={sig} className="text-[8px] font-black px-2 py-0.5 rounded-full border" style={{ color: badge.color, borderColor: badge.color + "40", backgroundColor: badge.color + "15" }}>
                    {badge.emoji} {badge.label}
                  </span>
                ) : null;
              })}
            </div>
          )}
          <div className="space-y-2">
            {[
              { key: "stuff", label: "Stuff", value: pa.stuff },
              { key: "command", label: "Command", value: pa.command },
              { key: "swingMiss", label: "Swing & Miss", value: pa.swingMiss },
              { key: "fatigue", label: "Fatigue", value: pa.fatigue, inverted: true },
              { key: "contactSuppression", label: "Contact Supp", value: pa.contactSuppression },
              { key: "matchup", label: "Matchup", value: pa.matchup },
              { key: "context", label: "Context", value: pa.context },
            ].map(({ key, label, value, inverted }) => {
              const displayVal = inverted ? (100 - value) : value;
              const barColor = inverted
                ? (value <= 20 ? "#22c55e" : value <= 35 ? "#a3e635" : value <= 55 ? "#94a3b8" : value <= 70 ? "#f59e0b" : "#ef4444")
                : (value >= 70 ? "#22c55e" : value >= 55 ? "#a3e635" : value >= 45 ? "#94a3b8" : value >= 35 ? "#f59e0b" : "#ef4444");
              return (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-[80px] shrink-0">{label}</span>
                  <div className="flex-1 h-2.5 rounded-full bg-secondary/60 overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${displayVal}%`, backgroundColor: barColor }} />
                  </div>
                  <span className="text-xs font-bold tabular-nums w-7 text-right" style={{ color: barColor }}>{displayVal}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!isPitcherMarket && calcResult.featureScores && Object.keys(calcResult.featureScores).length > 0 && (() => {
        const batterLabels: Record<string, string> = {
          contactQuality: "Contact", batSpeedPower: "Power", handednessMatchup: "Platoon",
          pitchBlendMatchup: "Pitch Mix", hotColdForm: "Form", parkEnv: "Park/Env",
          bvp: "vs Pitcher", lineupOpportunity: "Lineup",
          bullpenFactor: "Late Game", pitcherSuppression: "Pitcher Quality", pitcherDeterioration: "TTO Advantage",
        };
        const batterPriority = ["contactQuality", "batSpeedPower", "hotColdForm", "bvp", "pitchBlendMatchup", "handednessMatchup", "lineupOpportunity", "parkEnv", "pitcherDeterioration", "pitcherSuppression", "bullpenFactor"];
        const pitcherSideKeys = new Set(["pitcherSuppression", "bullpenFactor"]);
        const entries = Object.entries(calcResult.featureScores as Record<string, number>)
          .filter(([, v]) => Math.abs(v - 0.5) >= 0.03)
          .sort(([aKey], [bKey]) => {
            const ai = batterPriority.indexOf(aKey);
            const bi = batterPriority.indexOf(bKey);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          })
          .slice(0, 8);

        return (
          <div className="rounded-xl border border-border/40 bg-card/50 p-4">
            <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
              {isHRMarket ? "HR Analysis" : "Batter Analysis"}
            </div>
            <div className="space-y-2">
              {entries.map(([key, val]) => {
                const pct = Math.round(val * 100);
                const isPitcherSide = pitcherSideKeys.has(key);
                const favorsBatter = isPitcherSide ? pct < 50 : pct >= 50;
                const color = pct >= 65 ? (isPitcherSide ? "#ef4444" : "#22c55e") : pct >= 55 ? (isPitcherSide ? "#f59e0b" : "#a3e635") : pct >= 45 ? "#94a3b8" : pct >= 35 ? (isPitcherSide ? "#a3e635" : "#f59e0b") : (isPitcherSide ? "#22c55e" : "#ef4444");
                const sideTag = Math.abs(pct - 50) >= 15 ? (favorsBatter ? "Batter +" : "Pitcher +") : null;
                return (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-[80px] shrink-0">{batterLabels[key] ?? key}</span>
                    <div className="flex-1 h-2.5 rounded-full bg-secondary/60 overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
                    </div>
                    <span className="text-xs font-bold tabular-nums w-7 text-right" style={{ color }}>{pct}</span>
                    {sideTag && <span className={`text-[8px] font-bold ${favorsBatter ? "text-green-400/60" : "text-red-400/60"}`}>{sideTag}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

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
            recommendedSide: selectedSide,
            gameId: selectedGameId ?? "",
            sportsbook: "manual",
          } as MlbSignalData)}
          className="w-full py-3 rounded-xl border border-green-500/30 bg-green-500/10 text-green-400 font-semibold text-sm hover:bg-green-500/20 transition-colors min-h-[48px]"
        >
          + Add {selectedSide} to Bet Slip
        </button>
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
  const [analyzeTarget, setAnalyzeTarget] = useState<{ playerId: string; gameId: string } | null>(null);

  const isElite = user?.hasMLB === true;

  const { data: gamesResp, isLoading: gamesLoading, dataUpdatedAt: gamesUpdatedAt } = useQuery<MLBGamesResponse>({
    queryKey: ["/api/mlb/live-games"],
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  });
  const games = Array.isArray(gamesResp?.games) ? gamesResp!.games : [];

  const { data: edgeFeedResp } = useQuery<EdgeFeedResponse>({
    queryKey: ["/api/mlb/edge-feed"],
    refetchInterval: 20_000,
    placeholderData: (prev) => prev,
  });
  const rawSignals: MlbSignalData[] = Array.isArray(edgeFeedResp?.signals)
    ? (edgeFeedResp!.signals as MlbSignalData[]).map(s => mapMlbSignalToUi(s) as unknown as MlbSignalData)
    : [];
  const stickySignalMapRef = useRef<Map<string, MlbSignalData & { _stickyTs?: number }>>(new Map());
  const STICKY_TTL_MS = 30 * 60 * 1000;
  const edgeFeedSignals = (() => {
    const currentMap = new Map<string, MlbSignalData>();
    for (const s of rawSignals) {
      currentMap.set(`${s.playerId}|${s.market}|${s.gameId}`, s);
    }
    const now = Date.now();
    const merged = new Map<string, MlbSignalData & { _stickyTs?: number }>(stickySignalMapRef.current);
    Array.from(merged.entries()).forEach(([key, sig]) => {
      if (!currentMap.has(key)) {
        const ts = sig._stickyTs ?? now;
        if (now - ts > STICKY_TTL_MS) {
          merged.delete(key);
        } else {
          merged.set(key, { ...sig, stale: true, _stickyTs: ts } as MlbSignalData & { _stickyTs?: number });
        }
      }
    });
    Array.from(currentMap.entries()).forEach(([key, sig]) => {
      merged.set(key, { ...sig, _stickyTs: undefined } as MlbSignalData & { _stickyTs?: number });
    });
    const activeGameIds = new Set(games.map(g => g?.gameId).filter(Boolean));
    Array.from(merged.entries()).forEach(([key, sig]) => {
      if (sig.gameId && !activeGameIds.has(sig.gameId)) {
        merged.delete(key);
      }
    });
    stickySignalMapRef.current = merged;
    return Array.from(merged.values());
  })();

  const selectedGame = games.find(g => g?.gameId === selectedGameId) ?? null;
  const gameSignals = edgeFeedSignals.filter(s => s.gameId === selectedGameId);

  const [calcPlayer, setCalcPlayer] = useState<MlbPlayerStat | null>(null);
  const [calcPlayerName, setCalcPlayerName] = useState(() => {
    try { return localStorage.getItem("mlb_calc_playerName") ?? ""; } catch { return ""; }
  });
  const [calcMarket, setCalcMarket] = useState(() => {
    try {
      const saved = localStorage.getItem("mlb_calc_market");
      if (saved && MLB_CALC_MARKETS.some(m => m.value === saved)) return saved;
    } catch {}
    return "hits";
  });
  const [calcBookLine, setCalcBookLine] = useState(() => {
    try { return localStorage.getItem("mlb_calc_bookLine") ?? ""; } catch { return ""; }
  });
  const [selectedBook, setSelectedBook] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("mlb_calc_market", calcMarket);
      localStorage.setItem("mlb_calc_bookLine", calcBookLine);
      localStorage.setItem("mlb_calc_playerName", calcPlayerName);
    } catch {}
  }, [calcMarket, calcBookLine, calcPlayerName]);
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
    pitcherAnalysis?: { stuff: number; command: number; swingMiss: number; fatigue: number; contactSuppression: number; matchup: number; context: number } | null;
    pitcherSignals?: string[] | null;
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
    .map(([book, v]) => { const entry = v as OddsEntry; return { ...entry, sportsbook: book }; });

  const calcMutation = useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      const res = await apiRequest("POST", "/api/mlb/calculate-manual", input);
      return res.json();
    },
    onSuccess: (data) => setCalcResult(data),
  });

  const handleBoxScoreClick = (player: MlbPlayerStat) => {
    const bestSig = edgeFeedSignals.find(s => s.playerId === player.playerId && s.enginePct > 0);
    const market = bestSig?.market ?? "hits";
    const line = bestSig?.bookLine ?? null;
    const teamAbbr = (player as any).teamAbbr ?? "";
    hydrateMlbCalculator(buildCalcHydration({
      playerId: player.playerId,
      playerName: player.playerName,
      teamAbbr,
      gameId: selectedGameId ?? "",
      market,
      sportsbook: bestSig?.sportsbook ?? null,
      line,
    }, games), player);
  };

  const handleSelectBook = (book: string, line: number) => {
    if (selectedBook === book) {
      setSelectedBook(null);
      setCalcBookLine("");
    } else {
      setSelectedBook(book);
      setCalcBookLine(String(line));
    }
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
        hr: calcPlayer.hr,
        r: calcPlayer.r,
        rbi: calcPlayer.rbi,
        tb: calcPlayer.tb,
        k: calcPlayer.k,
        bb: calcPlayer.bb,
        sb: calcPlayer.sb,
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

  const hydrateMlbCalculator = (payload: CalcHydrationPayload, fullPlayer?: MlbPlayerStat | null) => {
    setCalcPlayerName(payload.playerName);
    setCalcMarket(payload.market);
    if (payload.line != null) setCalcBookLine(String(payload.line));
    setCalcResult(null);
    setSelectedBook(payload.sportsbook);
    if (payload.gameId && payload.gameId !== selectedGameId) {
      setSelectedGameId(payload.gameId);
    }
    if (fullPlayer) {
      setCalcPlayer(fullPlayer);
    } else {
      const stub = {
        playerId: payload.playerId,
        playerName: payload.playerName,
        teamAbbr: payload.teamAbbr,
        teamSide: payload.teamSide,
        ab: 0, h: 0, hr: 0, tb: 0, r: 0, rbi: 0, bb: 0, sb: 0, k: 0,
        battingOrderSlot: 0, lastABOutcome: null, exitVelocity: null,
        barrelPct: null, xBA: null, xSLG: null, hardHitPct: null,
      } as MlbPlayerStat;
      setCalcPlayer(stub);
    }
  };

  const handleSignalClick = (sig: MlbSignalData) => {
    const teamAbbr = (sig as any).teamAbbr ?? "";
    hydrateMlbCalculator(buildCalcHydration({
      playerId: sig.playerId,
      playerName: sig.playerName,
      teamAbbr,
      gameId: sig.gameId,
      market: sig.market,
      sportsbook: sig.sportsbook,
      line: sig.bookLine,
    }, games));
  };

  const handleHrRadarClick = (card: HrRadarCardUi) => {
    setAnalyzeTarget({ playerId: card.playerId, gameId: card.gameId });
  };

  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (isManualRefreshing) return;
    setIsManualRefreshing(true);
    try {
      const res = await apiRequest("GET", "/api/mlb/live-games?force=1");
      const freshData = await res.json();
      queryClient.setQueryData(["/api/mlb/live-games"], freshData);
      queryClient.invalidateQueries({ queryKey: ["/api/mlb/edge-feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mlb/hr-radar"] });
    } catch {}
    setTimeout(() => setIsManualRefreshing(false), 1000);
  };

  useEffect(() => {
    if (selectedGameId && games.length > 0 && !games.find(g => g.gameId === selectedGameId)) {
      setSelectedGameId(null);
    }
  }, [games, selectedGameId]);

  if (authLoading || gamesLoading) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-3">
        <SkeletonCard count={4} />
      </div>
    );
  }

  if (mlbUpgradeNeeded) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-12 flex flex-col items-center justify-center gap-4">
        <EmptyState
          icon="\u26BE"
          title="MLB Preview Limit Reached"
          description="You've used your 2 free MLB preview plays for today. Upgrade to All Sports for unlimited MLB access."
        />
        <a href="/pricing" data-testid="link-mlb-upgrade-pricing"
          className="w-full max-w-xs py-2.5 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors text-center block">
          Upgrade to All Sports -- $65/mo
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-foreground tracking-tight" data-testid="text-mlb-header">LiveLocks | MLB</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 font-semibold border border-green-500/20">LIVE</span>
        </div>
      </div>
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
              onSelectGame={(id) => { setSelectedGameId(id); setCalcResult(null); }}
              edgeFeedSignals={edgeFeedSignals}
              onRefresh={handleRefresh}
              dataUpdatedAt={gamesUpdatedAt}
              isRefreshing={isManualRefreshing}
            />
          )}

          {selectedGameId && selectedGame && (
            <>
              {gameSignals.length > 0 && (
                <SignalStrip signals={gameSignals} onPlayerClick={handleSignalClick} />
              )}

              <SpikeAlertBanner signals={gameSignals} />

              <MlbBoxScore
                gameId={selectedGameId}
                signals={edgeFeedSignals}
                onPlayerClick={handleBoxScoreClick}
                awayAbbr={selectedGame.awayAbbr}
                homeAbbr={selectedGame.homeAbbr}
                onAddToSlip={handleAddToSlip}
              />

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                <div className="lg:col-span-4 order-1 lg:order-1">
                  <div className="lg:sticky lg:top-4 space-y-4">
                  <GameContextPanel game={selectedGame} signalCount={gameSignals.length} />

                  <div className="rounded-xl border border-primary/20 bg-card shadow-[0_0_20px_-5px_hsl(var(--primary)/0.15)]" data-testid="mlb-calculator">
                    <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/20" style={{ background: "linear-gradient(135deg, rgba(var(--primary-rgb, 59,130,246),0.08), transparent)" }}>
                      <Calculator className="w-4 h-4 text-primary" />
                      <span className="text-xs font-bold text-foreground">MLB Calculator</span>
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
                        <div className="p-2.5 rounded-lg bg-secondary/30 border border-border/30 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <div className="text-[10px] text-muted-foreground flex items-center gap-2 flex-wrap flex-1">
                              <span className="font-semibold text-foreground">{calcPlayer.teamAbbr}</span>
                              <span>#{calcPlayer.battingOrderSlot || ""}</span>
                              <span>{calcPlayer.ab} AB</span>
                              <span>{calcPlayer.h} H</span>
                              {calcPlayer.hr > 0 && <span className="text-yellow-400 font-bold">{calcPlayer.hr} HR</span>}
                              <span>{calcPlayer.r} R</span>
                              <span>{calcPlayer.rbi} RBI</span>
                              <span>{calcPlayer.tb} TB</span>
                              <span>{calcPlayer.bb} BB</span>
                              <span>{calcPlayer.k} K</span>
                            </div>
                            <button
                              data-testid="button-clear-calc-player"
                              onClick={() => { setCalcPlayer(null); setCalcPlayerName(""); setCalcResult(null); setSelectedBook(null); }}
                              className="text-muted-foreground hover:text-foreground p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-[10px]"
                            >{"✕"}</button>
                          </div>
                          {(calcPlayer.exitVelocity != null || calcPlayer.xBA != null) && (
                            <div className="flex items-center gap-2 flex-wrap text-[9px] text-muted-foreground/70 pt-0.5">
                              {calcPlayer.exitVelocity != null && <span data-testid="calc-player-ev">EV {formatMlbDisplayValue("exitVelocity", calcPlayer.exitVelocity)}</span>}
                              {calcPlayer.xBA != null && <span data-testid="calc-player-xba">xBA {formatMlbDisplayValue("xBA", calcPlayer.xBA)}</span>}
                              {calcPlayer.xSLG != null && <span data-testid="calc-player-xslg">xSLG {formatMlbDisplayValue("xSLG", calcPlayer.xSLG)}</span>}
                              {calcPlayer.hardHitPct != null && <span data-testid="calc-player-hardhit">Hard% {formatMlbDisplayValue("hardHitPct", calcPlayer.hardHitPct)}</span>}
                              {calcPlayer.barrelPct != null && <span data-testid="calc-player-barrel">Barrel% {formatMlbDisplayValue("barrelPct", calcPlayer.barrelPct)}</span>}
                            </div>
                          )}
                          {calcPlayer.priorABResults && calcPlayer.priorABResults.length > 0 && (
                            <div className="space-y-1" data-testid="calc-player-ab-results">
                              <span className="text-[9px] text-muted-foreground/60 uppercase font-semibold tracking-wider">At-Bat Log</span>
                              <div className="space-y-0.5">
                                {calcPlayer.priorABResults.map((ab, i) => {
                                  const isHit = ab.outcome === "hit" || ab.outcome === "home_run" || ab.outcome === "hr" || ab.outcome === "homerun";
                                  const isHR = ab.outcome === "home_run" || ab.outcome === "hr" || ab.outcome === "homerun";
                                  const isK = ab.outcome === "strikeout";
                                  const isWalk = ab.outcome === "walk" || ab.outcome === "hbp";
                                  const label = isHR ? "HR" : isHit ? "H" : isK ? "K" : isWalk ? "BB" : "Out";
                                  const dotColor = isHR ? "bg-yellow-400" : isHit ? "bg-green-400" : isK ? "bg-red-400" : isWalk ? "bg-blue-400" : "bg-muted-foreground/40";
                                  const textColor = isHR ? "text-yellow-400" : isHit ? "text-green-400" : isK ? "text-red-400" : isWalk ? "text-blue-400" : "text-muted-foreground";
                                  const laInfo = ab.launchAngle != null ? launchAngleLabel(ab.launchAngle) : null;
                                  return (
                                    <div key={i} data-testid={`ab-result-${i}`} className="flex items-center gap-1.5 text-[9px]">
                                      <span className="text-muted-foreground/40 w-3 text-right tabular-nums">{i + 1}</span>
                                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
                                      <span className={`font-bold w-6 ${textColor}`}>{label}</span>
                                      {ab.exitVelocity != null && (
                                        <span className={`tabular-nums ${(ab.exitVelocity >= 95) ? "text-orange-400 font-semibold" : "text-muted-foreground"}`}>
                                          {Math.round(ab.exitVelocity)} mph
                                        </span>
                                      )}
                                      {laInfo && (
                                        <span className="text-muted-foreground/60">
                                          {Math.round(ab.launchAngle!)}° <span className={`text-[8px] ${laInfo.color}`}>{laInfo.tag}</span>
                                        </span>
                                      )}
                                      {ab.distance != null && ab.distance > 0 && <span className="text-muted-foreground/60 tabular-nums">{Math.round(ab.distance)} ft</span>}
                                      {ab.isBarrel && (
                                        <span className="text-[7px] font-bold px-1 py-0 rounded bg-red-500/20 text-red-400">BRL</span>
                                      )}
                                      {!ab.isBarrel && ab.exitVelocity != null && ab.exitVelocity >= 95 && (
                                        <span className="text-[7px] font-bold px-1 py-0 rounded bg-orange-500/15 text-orange-400">HH</span>
                                      )}
                                      {(ab as any).perABxBA != null && (ab as any).perABxBA > 0 && (
                                        <span className={`text-[7px] font-bold px-1 py-0 rounded tabular-nums ${(ab as any).perABxBA >= 0.700 ? "bg-emerald-500/15 text-emerald-400" : (ab as any).perABxBA >= 0.400 ? "bg-sky-500/15 text-sky-400" : "text-muted-foreground/60 bg-muted/20"}`} data-testid={`text-xba-boxscore-${i}`}>
                                          .{((ab as any).perABxBA * 1000).toFixed(0).padStart(3, "0")}
                                        </span>
                                      )}
                                      {ab.pitchType && (
                                        <span className="text-muted-foreground/50 ml-auto px-1 py-0.5 rounded bg-secondary/40 text-[8px] font-medium">
                                          {ab.pitchType}{ab.pitchSpeed ? ` ${Math.round(ab.pitchSpeed)}` : ""}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                          {(!calcPlayer.priorABResults || calcPlayer.priorABResults.length === 0) && calcPlayer.ab >= 2 && (
                            <div className="text-[9px] text-muted-foreground/50 italic" data-testid="calc-player-no-contact">
                              Pitch-level data syncing...
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
                          onChange={(e) => { setCalcMarket(e.target.value); setCalcResult(null); setCalcBookLine(""); setSelectedBook(null); }}
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
                          onChange={(e) => { setCalcBookLine(e.target.value); setSelectedBook(null); }}
                          placeholder="e.g. 1.5"
                          className="w-full px-3 py-2.5 text-xs rounded-lg bg-secondary/60 border border-border/40 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                        />
                      </div>

                      {oddsEntries.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Sportsbook Lines</div>
                          <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
                            {oddsEntries.map((o) => (
                              <button
                                key={o.sportsbook}
                                data-testid={`button-odds-${o.sportsbook}`}
                                onClick={() => handleSelectBook(o.sportsbook, o.line)}
                                className={`flex-shrink-0 text-[10px] px-3 py-2 rounded-lg border transition-all min-h-[44px] ${
                                  selectedBook === o.sportsbook
                                    ? "border-primary bg-primary/15 text-primary ring-1 ring-primary/30 shadow-[0_0_10px_rgba(var(--primary)/0.2)]"
                                    : "border-border/40 bg-secondary/30 text-muted-foreground hover:text-foreground hover:border-border"
                                }`}
                              >
                                <div className="font-semibold">{BOOK_DISPLAY[o.sportsbook] ?? o.sportsbook}</div>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="font-bold">{o.line}</span>
                                  <span className="text-green-400">O {formatOdds(o.overOdds)}</span>
                                  <span className="text-blue-400">U {formatOdds(o.underOdds)}</span>
                                </div>
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
                        <div className="text-[10px] text-muted-foreground/60">Could not load live odds -- enter a line manually.</div>
                      )}

                      <button
                        data-testid="button-calculate-mlb"
                        onClick={handleCalculate}
                        disabled={calcMutation.isPending || !activeCalcName.trim() || !calcBookLine || parseFloat(calcBookLine) <= 0 || !selectedGame}
                        className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-h-[48px]"
                      >
                        {calcMutation.isPending ? (
                          <><Loader2 className="w-4 h-4 animate-spin" /> Calculating...</>
                        ) : (
                          <><Calculator className="w-4 h-4" /> Calculate Probability</>
                        )}
                      </button>

                      {calcMutation.isError && (
                        <div className="text-center text-xs text-red-400 py-2">
                          {(calcMutation.error as Error)?.message || "Calculation failed -- check inputs"}
                        </div>
                      )}
                    </div>
                  </div>
                  </div>
                </div>

                <div className="lg:col-span-8 order-2 lg:order-2 space-y-4">
                  {calcResult && (
                    <ResultPanel
                      calcResult={calcResult}
                      calcMarket={calcMarket}
                      calcBookLine={calcBookLine}
                      activeCalcName={activeCalcName}
                      calcPlayer={calcPlayer}
                      selectedGameId={selectedGameId}
                      onAddToSlip={handleAddToSlip}
                      handleAddToSlip={handleAddToSlip}
                    />
                  )}

                  <GameSignalsPanel signals={gameSignals} isElite={isElite} onAddToSlip={handleAddToSlip} />
                </div>
              </div>
            </>
          )}

          {!selectedGameId && (
            <div className="rounded-xl border border-border/40 bg-card p-8 text-center space-y-3" data-testid="mlb-games-empty-state">
              <Target className="w-10 h-10 text-muted-foreground/30 mx-auto" />
              <div className="text-sm font-bold text-foreground">Ready to Predict</div>
              <div className="text-xs text-muted-foreground">Select a game above to get started</div>
              <div className="text-[11px] text-muted-foreground/60 space-y-1 max-w-xs mx-auto text-left">
                <div className="flex items-center gap-2"><span className="text-primary">◎</span> Click a game tile above</div>
                <div className="flex items-center gap-2"><span className="text-primary">◎</span> Click a player in the box score</div>
                <div className="flex items-center gap-2"><span className="text-primary">◎</span> Pick a stat type &amp; live line</div>
                <div className="flex items-center gap-2"><span className="text-primary">◎</span> Hit Calculate</div>
              </div>
            </div>
          )}

          {!selectedGameId && !isElite && games.length > 0 && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 text-center space-y-3">
              <div className="text-sm font-bold text-foreground">Unlock MLB Edges</div>
              <div className="text-xs text-muted-foreground">
                {edgeFeedSignals.length > 0
                  ? `${edgeFeedSignals.length} live signal${edgeFeedSignals.length !== 1 ? "s" : ""} across ${games.filter(g => g.status === "live").length || games.length} game${games.length !== 1 ? "s" : ""} -- upgrade to see them all.`
                  : `${games.length} game${games.length !== 1 ? "s" : ""} today -- upgrade to see live probabilities, edge percentages, and bet recommendations.`}
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
                  <TopLiveOpportunities signals={filtered} onAddToSlip={handleAddToSlip} />
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
        <HRRadarSection isElite={isElite} onAddToSlip={handleAddToSlip} onOpenHrDetails={handleHrRadarClick} games={games} />
      )}

      {analyzeTarget && (
        <HRRadarAnalyzeModal
          playerId={analyzeTarget.playerId}
          gameId={analyzeTarget.gameId}
          onClose={() => setAnalyzeTarget(null)}
        />
      )}

      {mlbSlipPicks.length > 0 && (
        <div className="fixed right-4 left-4 sm:left-auto sm:w-96 z-50" style={{ bottom: "max(16px, env(safe-area-inset-bottom, 16px))" }} data-testid="mlb-bet-slip">
          <div className="rounded-xl border border-green-500/30 bg-card shadow-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-foreground">MLB Bet Slip ({mlbSlipPicks.length})</span>
              <button
                data-testid="button-clear-mlb-slip"
                className="text-xs text-muted-foreground hover:text-foreground p-2 min-w-[44px] min-h-[44px]"
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
                      <span>{MARKET_LABELS[pick.market] ?? pick.market.replace(/_/g, " ")} {pick.line}</span>
                      {pick.edge != null && pick.edge > 0 && <span className="text-green-400 font-semibold">+{pick.edge.toFixed(1)}%</span>}
                      {pick.overOdds != null && pick.side === "OVER" && <span>({formatOdds(pick.overOdds)})</span>}
                      {pick.underOdds != null && pick.side === "UNDER" && <span>({formatOdds(pick.underOdds)})</span>}
                    </div>
                  </div>
                  <button
                    data-testid={`button-remove-slip-${idx}`}
                    className="text-muted-foreground hover:text-red-400 shrink-0 ml-2 p-2 min-w-[44px] min-h-[44px] flex items-center justify-center"
                    onClick={() => setMlbSlipPicks(prev => prev.filter((_, i) => i !== idx))}
                  >{"✕"}</button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                data-testid="button-copy-mlb-slip"
                className="text-xs py-3 min-h-[44px] rounded-lg border border-border hover:bg-muted transition-colors text-foreground font-semibold px-3"
                onClick={() => {
                  const text = mlbSlipPicks.map(p => `${p.playerName} \u2014 ${MARKET_LABELS[p.market] ?? p.market.replace(/_/g, " ")} ${p.side} ${p.line}`).join("\n");
                  navigator.clipboard?.writeText(text);
                }}
              >Copy</button>
              <a
                data-testid="link-mlb-slip-dk"
                href="https://sportsbook.draftkings.com/leagues/baseball/mlb?category=player-props"
                target="_blank" rel="noopener noreferrer"
                className="flex-1 text-xs py-3 min-h-[44px] rounded-lg bg-[#1a6f3c] hover:bg-[#1a8f4c] text-white text-center font-semibold transition-colors"
                onClick={() => {
                  const text = mlbSlipPicks.map(p => `${p.playerName} \u2014 ${MARKET_LABELS[p.market] ?? p.market.replace(/_/g, " ")} ${p.side} ${p.line}`).join("\n");
                  navigator.clipboard?.writeText(text);
                }}
              >DraftKings</a>
              <a
                data-testid="link-mlb-slip-fd"
                href="https://sportsbook.fanduel.com/baseball?tab=player-props"
                target="_blank" rel="noopener noreferrer"
                className="flex-1 text-xs py-3 min-h-[44px] rounded-lg bg-[#1493ff] hover:bg-[#0d7ee6] text-white text-center font-semibold transition-colors"
                onClick={() => {
                  const text = mlbSlipPicks.map(p => `${p.playerName} \u2014 ${MARKET_LABELS[p.market] ?? p.market.replace(/_/g, " ")} ${p.side} ${p.line}`).join("\n");
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
