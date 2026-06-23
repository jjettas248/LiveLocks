import { useState, useEffect, useRef, Component, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { TopPlays } from "@/components/mlb/TopPlays";
import { TopLiveOpportunities } from "@/components/mlb/TopLiveOpportunities";
import { LiveBoard } from "@/components/mlb/LiveBoard";
import { LiveFeed } from "@/components/mlb/LiveFeed";
import { MlbSignalCard, type MlbSignalData } from "@/components/mlb/MlbSignalCard";
import { HrRadarLadder, type HrRadarLadderEntry } from "@/components/mlb/HrRadarLadder";
import { PregamePowerRadar } from "@/components/mlb/PregamePowerRadar";
import { AbLogRows, type AbRow } from "@/components/mlb/AbLogRows";
import { HrQuickDecide } from "@/components/mlb/HrQuickDecide";
import { MlbBoxScore, type MlbPlayerStat } from "@/components/mlb/MlbBoxScore";
import { AdminEngineDebugPanel } from "@/components/mlb/AdminEngineDebugPanel";
import type { MLBSignal } from "@shared/mlbSignal";
import { applyConvictionCap10, convictionDisplayBadge, pregameSeedTierLabel } from "@shared/hrRadarConviction";
import { ProbabilityRing } from "@/components/probability-ring";
import { StatCard } from "@/components/stat-card";
import { SkeletonCard } from "@/components/sports/SkeletonCard";
import { EmptyState } from "@/components/sports/EmptyState";
import { LiveIndicator } from "@/components/common/LiveIndicator";
import { Radio, Target, RefreshCw, Calculator, Loader2, Flame, Zap, Trophy, Eye, ChevronDown, ChevronUp, Bell, Activity, X, BarChart3, Plus, ExternalLink, TrendingUp, TrendingDown, Clock, CheckCircle2, Calendar } from "lucide-react";
import {
  radarScoreToTier, launchAngleLabel, formatMlbDisplayValue,
  liveScoreToGrade,
  mapMlbSignalToUi,
  type HrRadarCardUi,
} from "@/lib/mlbUiMappers";
import { MODE_STYLES, resolveMlbSignalTier, TIER_COLORS_BY_SIGNAL_TIER } from "@/lib/mlbFormatters";
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

const TIER_RANK: Record<string, number> = { elite: 4, strong: 3, lean: 2, watch: 1 };

function tierFirstSort(a: MlbSignalData, b: MlbSignalData): number {
  const ta = TIER_RANK[resolveMlbSignalTier(a)] ?? 0;
  const tb = TIER_RANK[resolveMlbSignalTier(b)] ?? 0;
  if (ta !== tb) return tb - ta;
  return (b.signalScore ?? 0) - (a.signalScore ?? 0);
}

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
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-center space-y-3">
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
  // Freshness Integrity Fix #2 — server now returns full feed metadata so the
  // client can detect a real engine recompute and clear sticky state on advance.
  mode?: "live" | "monitoring";
  signals: MLBSignal[];
  updatedAt?: number;
  generatedAt?: number;
  staleCount?: number;
  edgeCacheEntries?: number;
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
  // [MLB Canonical Signal Tier — Phase 2] Filter MLB signals on the canonical
  // lowercase signalTier rather than the legacy uppercase confidenceTier so
  // the badge stays consistent with LiveBoard buckets and TopPlays.
  const gameSignals = signals.filter(s => {
    if (s.gameId !== gameId) return false;
    const t = resolveMlbSignalTier(s as any);
    return t === "elite" || t === "strong";
  });
  if (gameSignals.length === 0) return null;
  const pitcherCount = gameSignals.filter(s => ["pitcher_k", "pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"].includes(s.market)).length;
  const batterCount = gameSignals.length - pitcherCount;
  if (pitcherCount > batterCount) return { label: "Pitch", color: "#3b82f6" };
  if (batterCount > pitcherCount) return { label: "Hit", color: "#f97316" };
  return { label: "Mixed", color: "#71717a" };
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

const BATTER_OVER_MARKETS_UI = ["hits", "total_bases", "home_runs", "hrr", "batter_strikeouts"];

function SignalStrip({ signals, onPlayerClick }: { signals: MlbSignalData[]; onPlayerClick: (sig: MlbSignalData) => void }) {
  const topSignals = [...signals]
    .filter(s => {
      if (s.alreadyHit) return false;
      // Plan B: Pre-AB Watch entries (HR_VS_ELITE_PITCHER, PITCHER_NEAR_MISS,
      // and any future early bypasses) render in PreABWatchBand only — keep
      // them out of the main "Top Signals" strip.
      if ((s as any).isEarlySignal || (s as any).watchlist) return false;
      const isBatterOver = BATTER_OVER_MARKETS_UI.includes(s.market);
      if (isBatterOver) return (s.signalScore ?? 0) >= 42;
      // Pitcher / non-batter-over markets: gate on engine signal score, not raw
      // book probability. Probability is one input feature; signal score is the
      // engine's authoritative composite.
      return (s.signalScore ?? 0) >= 50 && s.recommendedSide !== "NO_EDGE";
    })
    .sort(tierFirstSort)
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
          // [MLB Canonical Signal Tier — Phase 2] Color is derived from the
          // server-stamped signalTier, never from probability. The previous
          // `pct >= 80 ? green : pct >= 70 ? yellow : blue` mapping was a
          // client-side prob-to-tier inference that contradicted the server's
          // canonical tier (e.g. an "elite" signal at 65% would have shown
          // blue while the card badge showed ELITE). resolveMlbSignalTier()
          // emits [MLB_TIER_FALLBACK] if the server hasn't stamped one.
          const tierColor = TIER_COLORS_BY_SIGNAL_TIER[resolveMlbSignalTier(sig as any)].text;
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
                {sig.signalScore != null && (
                  <span className="text-[8px] text-green-400/70 tabular-nums">{sig.signalScore}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Plan B: Pre-AB Watch band — surfaces early/watchlist signals that the main
// SignalStrip filters out. Driven by the API's isEarlySignal flag, set by the
// orchestrator's HR_VS_ELITE_PITCHER and PITCHER_NEAR_MISS bypass paths.
// Auto-collapses once ≥3 confirmed live signals exist for the game.
// (HIGH_PROB_BYPASS entries surface via the box score row enrichment, not here.)
function PreABWatchBand({ signals, onPlayerClick }: { signals: MlbSignalData[]; onPlayerClick: (sig: MlbSignalData) => void }) {
  const confirmedCount = signals.filter(s => {
    if ((s as any).isEarlySignal) return false;
    if ((s as any).alreadyHit) return false;
    const isBatterOver = BATTER_OVER_MARKETS_UI.includes(s.market);
    if (isBatterOver) return (s.signalScore ?? 0) >= 42;
    return (s.signalScore ?? 0) >= 50 && s.recommendedSide !== "NO_EDGE";
  }).length;

  const watchSignals = signals
    .filter(s => {
      if (!(s as any).isEarlySignal) return false;
      if ((s as any).alreadyHit) return false;
      const pct = normalizePct(s.enginePct);
      const edge = s.edge ?? 0;
      return pct >= 60 && edge >= 3;
    })
    .sort(tierFirstSort)
    .slice(0, 8);

  const autoCollapse = confirmedCount >= 3;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(autoCollapse); }, [autoCollapse]);

  if (watchSignals.length === 0) return null;

  return (
    <div className="mb-3" data-testid="pre-ab-watch-band">
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        className="flex items-center gap-2 mb-1.5 px-1 w-full text-left"
        data-testid="button-toggle-pre-ab-watch"
      >
        <Eye className="w-3 h-3 text-cyan-400" />
        <span className="text-[9px] font-bold uppercase tracking-wider text-cyan-400/90">
          Pre-AB Watch · {watchSignals.length}
        </span>
        <span className="text-[8px] text-muted-foreground">prob ≥ 60% · edge ≥ +3%</span>
        {collapsed ? <ChevronDown className="w-3 h-3 text-muted-foreground ml-auto" /> : <ChevronUp className="w-3 h-3 text-muted-foreground ml-auto" />}
      </button>
      {!collapsed && (
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
          {watchSignals.map((sig, i) => {
            const pct = normalizePct(sig.enginePct);
            const sideColor = sig.recommendedSide === "OVER" ? "text-green-400" : "text-blue-400";
            const tags: string[] = ((sig as any).feedTags ?? []) as string[];
            const tagLabel = tags.includes("HR_VS_ELITE_PITCHER")
              ? "HR vs ELITE P"
              : tags.includes("PITCHER_NEAR_MISS")
              ? "P NEAR-MISS"
              : tags.includes("HIGH_PROB")
              ? "HIGH PROB"
              : "PRE-AB";
            return (
              <button
                key={`${sig.playerId}-${sig.market}-${i}`}
                data-testid={`pre-ab-watch-card-${i}`}
                onClick={() => onPlayerClick(sig)}
                className="flex-shrink-0 rounded-lg border border-cyan-400/30 px-3 py-2 bg-cyan-400/5 hover:bg-cyan-400/10 transition-colors text-left min-w-[150px]"
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                  <span className="text-[10px] font-bold text-foreground truncate">{sig.playerName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-muted-foreground">{SIGNAL_STRIP_MARKET_SHORT[sig.market] ?? sig.market.replace(/_/g, " ")}</span>
                  <span className={`text-[10px] font-black ${sideColor}`}>{sig.recommendedSide}</span>
                  <span className="text-[10px] font-bold tabular-nums text-cyan-300">{pct.toFixed(0)}%</span>
                </div>
                <div className="mt-0.5 text-[8px] font-semibold uppercase tracking-wider text-cyan-400/70">{tagLabel}</div>
              </button>
            );
          })}
        </div>
      )}
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
    // HR spike alerts use our engine signal score (book-implied HR probability
    // is structurally low and would never trigger a probability-based gate).
    const isHR = s.market === "home_runs" && (s.signalScore ?? 0) >= 60;
    // [MLB Canonical Signal Tier — Phase 2] Read canonical signalTier instead
    // of the legacy uppercase confidenceTier so spike-band membership matches
    // LiveBoard "Elite" bucket membership exactly.
    const isElite = resolveMlbSignalTier(s as any) === "elite";
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
                {chip.isLive && <LiveIndicator />}
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

function GameSignalsPanel({ signals, isElite, onAddToSlip, onOpenCalculator, selectedGameId, totalFeedSignals, isAdmin }: {
  signals: MlbSignalData[];
  isElite: boolean;
  onAddToSlip: (sig: MlbSignalData) => void;
  onOpenCalculator?: (sig: MlbSignalData) => void;
  selectedGameId: string | null;
  totalFeedSignals: number;
  isAdmin: boolean;
}) {
  // Plan B: Active Signals panel renders confirmed live signals only — early /
  // watchlist (HR_VS_ELITE_PITCHER, PITCHER_NEAR_MISS, fallback watch) entries
  // belong in the dedicated PreABWatchBand surface above this panel.
  const confirmed = signals.filter(s => !(s as any).isEarlySignal && !(s as any).watchlist);
  const sorted = [...confirmed].sort(tierFirstSort);
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
        <div className="rounded-xl border border-border/40 bg-card p-6 text-center" data-testid="active-signals-empty-state">
          <div className="flex items-center justify-center gap-2 text-sm text-blue-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400" />
            </span>
            Engine evaluating this game — no actionable signals yet
          </div>
          <div className="text-xs text-muted-foreground/60 mt-1">Signals surface as at-bats produce qualifying contact, pitcher fatigue, or HR-shaped batted balls.</div>
          {isAdmin && (
            <div className="mt-3 pt-3 border-t border-border/30 text-[10px] font-mono text-muted-foreground/70 space-y-0.5 text-left max-w-md mx-auto" data-testid="admin-empty-debug">
              <div>selectedGameId: <span className="text-foreground">{selectedGameId ?? "null"}</span></div>
              <div>matched: <span className="text-foreground">{signals.length}</span> / feed: <span className="text-foreground">{totalFeedSignals}</span></div>
              <div>endpoint: <span className="text-foreground">/api/mlb/edge-feed</span> (bus populator)</div>
              <div>client filters: isEarlySignal=excluded, watchlist=excluded → see Pre-AB Watch band</div>
              <div className="text-muted-foreground/50 italic">Open the admin engine panel above for raw candidates / qualification / rejections.</div>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {visible.map((sig, idx) => (
            <MlbSignalCard
              key={`${sig.playerId}-${sig.market}-${idx}`}
              sig={sig}
              onAddToSlip={onAddToSlip}
              onOpenCalculator={onOpenCalculator}
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


function HRRadarAnalyzeModal({ playerId, gameId, onClose }: { playerId: string; gameId: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<{ alert: any; analyze: any; source?: string; partial?: boolean }>({
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

  // Hard fail only when route truly returned nothing (404/500 with no alert AND no analyze).
  const hasAlert = !!data?.alert;
  const hasAnalyze = !!data?.analyze && (
    (data.analyze.priorABs?.length ?? 0) > 0 ||
    data.analyze.hrFactors != null ||
    data.analyze.hrBuildScore != null ||
    (data.analyze.explanationBullets?.length ?? 0) > 0
  );
  // Hard-fail only when both data channels are truly empty. A refetch error with
  // prior cached data should still render — `data` carries the previous payload.
  if (!hasAlert && !hasAnalyze) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose} data-testid="modal-hr-analyze">
        <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
          <p className="text-sm text-muted-foreground text-center py-4">No analysis data available</p>
          <button className="w-full py-2 rounded-lg text-sm border border-border/40 text-muted-foreground" onClick={onClose} data-testid="button-close-analyze">Close</button>
        </div>
      </div>
    );
  }

  const alert = data!.alert ?? {};
  const analyze = data!.analyze ?? { priorABs: [], explanationBullets: [] };
  const isLimited = !!data!.partial || data!.source === "analytics_fallback" || data!.source === "historical_alert";
  const isNoAbsYet = (data as any)!.partialReason === "no_abs_yet";
  const priorABs: Array<{ abNumber: number; exitVelocity: number | null; launchAngle: number | null; distance: number | null; outcome: string; isBarrel: boolean; isHardHit: boolean; perABxBA?: number | null; contactGrade?: string; hrProbability?: number }> = analyze?.priorABs ?? [];
  // Goldmaster Phase 1 — single 0-100 wire scale. The server normalizes
  // initial/current/peak to the canonical 0-100 readiness scale at CREATE
  // time. The client renders these values DIRECTLY as 0-100 with no /10 mix.
  // The legacy radarScoreToTier / BuildScoreMeter consumers are calibrated on
  // a 0-10 build-score scale, so we derive a separate `tierBasis` value (=
  // currentScore/10) ONLY for those legacy controls.
  const initialScore = parseFloat(alert.initialReadinessScore ?? "0");
  const currentScore = parseFloat(alert.currentReadinessScore ?? "0");
  const peakScore = parseFloat(alert.peakReadinessScore ?? "0");
  const tierBasis = currentScore / 10;
  const tier = radarScoreToTier(tierBasis);
  // Goldmaster RESTORE — USER-FACING 10-point score derived from canonical
  // 0-100 readiness (one decimal). The 0-100 numbers remain available as a
  // small admin/debug sub-row for power users.
  const round1 = (n: number) => Math.round(Math.max(0, Math.min(100, n)) * 10) / 100;
  const rawInitial10 = round1(initialScore);
  const rawCurrent10 = round1(currentScore);
  const rawPeak10 = round1(peakScore);
  // Conviction-aware DISPLAY scores — capped to engine's actual conviction
  // ceiling for the row's alertPath (e.g. PATH_F_BLOCKED_BRIDGE → 6.0/10).
  // The headline /10 number renders capped so it stays coherent with the
  // section the engine assigned the row to. The raw 0-100 admin sub-row
  // beneath each tile is INTENTIONALLY left uncapped — that surface exists
  // for power users who need to see the dynamic engine's raw readiness.
  //
  // RESOLVED guard — once a row resolves (HR landed, miss called, late
  // signal, uncalled HR, expired, etc.), the historical headline number
  // must render uncapped so the user sees the same value they saw on the
  // live ladder right before the outcome. Mirrors enrichWithUserStage's
  // resolved-row bypass on the server side. Uses a broad discriminator
  // (status / currentStatus / gradingStatus / outcome) so any future
  // resolution path that doesn't flip `status` to hit|miss still bypasses.
  const aAny = alert as any;
  const isResolvedAlert =
    aAny.status === "hit" ||
    aAny.status === "miss" ||
    aAny.currentStatus === "resolved" ||
    (aAny.gradingStatus != null && aAny.gradingStatus !== "active") ||
    (aAny.outcome != null && aAny.outcome !== "pending" && aAny.outcome !== "active");
  const capPath = isResolvedAlert ? null : (alert.alertPath ?? null);
  const initial10 = applyConvictionCap10(rawInitial10, capPath) ?? rawInitial10;
  const current10 = applyConvictionCap10(rawCurrent10, capPath) ?? rawCurrent10;
  const peak10 = applyConvictionCap10(rawPeak10, capPath) ?? rawPeak10;
  const convictionBadge = convictionDisplayBadge(capPath);

  // Pregame seed (presence-floor rows): a display-only lifted tier + "why"
  // drivers from the season power profile. Read straight off the server-stamped
  // diagnosticsSnapshot.pregameSeed — formatting only, no re-derivation.
  const pregameSeed = (aAny.diagnosticsSnapshot?.pregameSeed ?? null) as
    | { seedScore?: number; drivers?: string[] }
    | null;
  const pregameDrivers: string[] = Array.isArray(pregameSeed?.drivers) ? pregameSeed!.drivers.slice(0, 4) : [];
  const pregameSeedTier = !isResolvedAlert ? pregameSeedTierLabel(current10) : null;

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
              {/* HR Radar contract: detectedLabel is frozen first detection, never advances on score climb. */}
              {alert.detectedLabel && <span>Detected {alert.detectedLabel}</span>}
              <span className={`font-bold ${statusColor}`}>{statusLabel}</span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-muted/30" data-testid="button-close-analyze-x"><X className="w-4 h-4 text-muted-foreground" aria-hidden="true" /></button>
        </div>

        <div className="p-4 space-y-4">
          {isNoAbsYet && !isLimited && (
            <div className="text-[10px] px-2 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 font-semibold" data-testid="text-no-abs-yet">
              No at-bats yet — score reflects pre-game form, matchup, and park factors. Per-AB contact data will appear after the first plate appearance.
            </div>
          )}
          {isLimited && (
            <div className="text-[10px] px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 font-semibold" data-testid="text-limited-analysis">
              Limited analysis available — live game data is no longer cached for this play.
            </div>
          )}
          {/* Goldmaster RESTORE — Initial / Current / Peak rendered on the
              single USER-FACING 0.0-10.0 scale (one decimal). The redundant
              0-100 readiness sub-row was removed for clarity; the harness
              still validates against the 0-100 canonical scale on the wire. */}
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center p-2 rounded-lg bg-muted/20 border border-border/20">
              <div className="text-[9px] text-muted-foreground">Initial</div>
              <div className="text-sm font-bold text-foreground" data-testid="text-signal-score-10-initial">
                {initial10.toFixed(1)}<span className="text-[9px] text-muted-foreground"> / 10</span>
              </div>
            </div>
            <div className="text-center p-2 rounded-lg bg-muted/20 border border-border/20">
              <div className="text-[9px] text-muted-foreground">Current</div>
              <div className="text-sm font-bold" style={{ color: tier.color }} data-testid="text-signal-score-10-current">
                {current10.toFixed(1)}<span className="text-[9px] text-muted-foreground"> / 10</span>
              </div>
            </div>
            <div className="text-center p-2 rounded-lg bg-muted/20 border border-border/20">
              <div className="text-[9px] text-muted-foreground">Peak</div>
              <div className="text-sm font-bold text-foreground" data-testid="text-signal-score-10-peak">
                {peak10.toFixed(1)}<span className="text-[9px] text-muted-foreground"> / 10</span>
              </div>
            </div>
          </div>

          {/* Heat progress bar — BuildScoreMeter is calibrated on a 0-10
              build-score scale, so feed it tierBasis (= currentScore/10).
              The visible numbers above remain on the canonical 0-100 scale. */}
          <div className="px-1">
            <BuildScoreMeter score={tierBasis} size="lg" />
          </div>

          {convictionBadge && (
            <div
              className="text-[10px] px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300"
              data-testid="text-conviction-cap-explanation"
            >
              <span className="font-semibold">{convictionBadge.label}.</span>{" "}
              <span className="text-amber-200/80">{convictionBadge.description}</span>
            </div>
          )}

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
              <span data-testid="text-analyze-tier">Tier: {pregameSeedTier ?? alert.confidenceTier?.toUpperCase()}</span>
              {pregameSeedTier && (
                <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-300 border border-orange-500/20 font-semibold">
                  Pregame
                </span>
              )}
              <span className="text-muted-foreground/40">|</span>
              <span>State: {alert.signalState?.toUpperCase()}</span>
            </div>
            {pregameDrivers.length > 0 && (
              <div className="flex flex-wrap gap-1" data-testid="chips-analyze-pregame-drivers">
                {pregameDrivers.map((d, i) => (
                  <span key={i} className="text-[8px] px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-300 border border-orange-500/20 font-semibold">{d}</span>
                ))}
              </div>
            )}
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

          {priorABs.length > 0 && <AbLogRows abs={priorABs as AbRow[]} />}

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

function ResultPanel({ calcResult, calcMarket, calcBookLine, activeCalcName, calcPlayer, selectedGameId, onAddToSlip, handleAddToSlip, matchingSignal }: {
  calcResult: any;
  calcMarket: string;
  calcBookLine: string;
  activeCalcName: string;
  calcPlayer: MlbPlayerStat | null;
  selectedGameId: string | null;
  onAddToSlip: (sig: MlbSignalData) => void;
  handleAddToSlip: (sig: MlbSignalData) => void;
  matchingSignal?: MlbSignalData | null;
}) {
  const isBatterOverMarket = BATTER_OVER_MARKETS_UI.includes(calcMarket);
  const sigMode = matchingSignal?.mode ?? (isBatterOverMarket ? (calcResult.mode !== "manual" ? calcResult.mode : null) : null);
  const sigScore = matchingSignal?.signalScore ?? calcResult.signalScore ?? null;
  const sigPrimaryReason = (matchingSignal as any)?.primaryReason ?? calcResult.primaryReason ?? null;
  const sigSmartTags: string[] = (matchingSignal as any)?.smartTags ?? calcResult.smartTags ?? [];
  const modeStyle = sigMode && MODE_STYLES[sigMode] ? MODE_STYLES[sigMode] : null;
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
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                {modeStyle ? (
                  <span
                    data-testid="badge-live-edge"
                    className="text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-full"
                    style={{ color: modeStyle.color, background: modeStyle.bg, border: `1px solid ${modeStyle.border}` }}
                  >
                    {modeStyle.icon} {modeStyle.label}
                  </span>
                ) : (
                  <span data-testid="badge-live-edge" className="text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-zinc-500/20 text-zinc-400">
                    {isBatterOverMarket ? "SIGNAL" : "LIVE EDGE"}
                  </span>
                )}
                {/* Source badge — single source of truth label so the user knows
                    whether this panel is rendering the canonical live engine
                    signal (matches box score) or a calculator fallback estimate. */}
                {calcResult.source === "engine" ? (
                  <span
                    data-testid="badge-calc-source"
                    className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                    title="This panel mirrors the live engine signal shown on the box score row."
                  >
                    {calcResult.label ?? "Live Engine Signal"}
                  </span>
                ) : (
                  <span
                    data-testid="badge-calc-source"
                    className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-500/15 text-zinc-300 border border-zinc-500/30"
                    title="No live engine signal exists for this player + market + line. Showing a calculator estimate."
                  >
                    {calcResult.label ?? "Calculator Estimate"}
                  </span>
                )}
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
              <span>Line <strong className="text-foreground">{calcBookLine}</strong></span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
                calcResult.recommendedSide === "OVER" ? "bg-emerald-500/20 text-emerald-400" :
                calcResult.recommendedSide === "UNDER" ? "bg-red-500/20 text-red-400" :
                "bg-secondary/40 text-muted-foreground"
              }`}>
                {calcResult.recommendedSide === "OVER" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {calcResult.recommendedSide === "NO_EDGE" ? "EVALUATING" : calcResult.recommendedSide}
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

      {isBatterOverMarket && modeStyle ? (
        <div
          data-testid="badge-model-confidence-calc"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
          style={{ color: modeStyle.color, background: modeStyle.bg, border: `1px solid ${modeStyle.border}` }}
        >
          {modeStyle.icon}
          {sigMode === "elite" || sigMode === "hr_elite" ? "High-conviction signal" :
           sigMode === "strong" || sigMode === "hr_strong" ? "Strong signal detected" :
           sigMode === "lean" ? "Lean signal — developing" :
           sigMode === "heating_up" || sigMode === "hr_heating_up" ? "Heating up — watch closely" :
           sigMode === "watch" || sigMode === "hr_watch" ? "On watch — emerging setup" :
           "Signal evaluating"}
        </div>
      ) : calcResult.confidenceTier ? (
        <div
          data-testid="badge-model-confidence-calc"
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${
            calcResult.confidenceTier === "ELITE" ? "bg-yellow-500/10 border border-yellow-500/20 text-yellow-400" :
            calcResult.confidenceTier === "STRONG" ? "bg-brand/10 border border-brand/20 text-brand" :
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
      ) : null}

      {isBatterOverMarket ? (
        sigPrimaryReason ? (
          <div data-testid="ev-box" className="rounded-xl border border-border/30 p-4">
            <div className="text-sm font-medium text-foreground">{sigPrimaryReason}</div>
            {sigSmartTags.length > 0 && (
              <div className="flex gap-1.5 flex-wrap mt-2">
                {sigSmartTags.map((tag: string, i: number) => (
                  <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-secondary/40 text-muted-foreground">{tag}</span>
                ))}
              </div>
            )}
          </div>
        ) : null
      ) : evPct != null && Math.abs(evPct) >= 1 ? (
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
              Model <strong className="text-foreground">{overPct.toFixed(1)}%</strong> vs Book Implied <strong className="text-foreground">{bookImplied!.toFixed(1)}%</strong>
            </p>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">
              {Math.abs(evPct) >= 6 ? "High conviction edge vs market." : Math.abs(evPct) >= 3 ? "Solid discrepancy — model sees value." : evPct > 0 ? "Slight edge — use as tiebreaker." : "Model trails implied — line may be priced in."}
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard
          title="Remaining PA"
          value={calcResult.remainingPA?.toFixed(1) ?? "—"}
          subtitle={`${calcResult.completedAB ?? 0} AB completed`}
          icon={<Clock className="w-4 h-4" />}
          highlight="neutral"
        />
        {isBatterOverMarket ? (
          <StatCard
            title="Signal"
            value={`${calcResult.signalStrengthScore ?? sigScore ?? "—"}`}
            subtitle={sigMode && MODE_STYLES[sigMode] ? MODE_STYLES[sigMode].label : "Evaluating"}
            icon={<TrendingUp className="w-4 h-4" />}
            highlight={(calcResult.signalStrengthScore ?? sigScore ?? 0) >= 68 ? "positive" : (calcResult.signalStrengthScore ?? sigScore ?? 0) >= 42 ? "neutral" : "negative"}
          />
        ) : (
          <StatCard
            title="Edge"
            value={`${edge > 0 ? "+" : ""}${edge.toFixed(1)}%`}
            subtitle="Model vs book line"
            icon={<TrendingUp className="w-4 h-4" />}
            highlight={edge > 3 ? "positive" : edge < -3 ? "negative" : "neutral"}
          />
        )}
        <StatCard
          title="Confidence"
          value={sigMode && MODE_STYLES[sigMode] ? MODE_STYLES[sigMode].label : (calcResult.confidenceTier ?? "—")}
          subtitle={calcResult.marketFamily === "batter_over" ? "Signal First" : calcResult.marketFamily === "hr_radar" ? "HR Radar" : "Standard"}
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
            enginePct: selectedSide === "OVER" ? overPct : underPct,
            edge: calcResult.edge ?? null,
            recommendedSide: selectedSide,
            gameId: selectedGameId ?? "",
            sportsbook: calcResult.source === "engine" ? "engine" : "manual",
            // Canonical fields — preserved on the slip pick so any
            // downstream consumer can render the same Over/Under prob.
            calibratedProbabilityOver: overPct,
            calibratedProbabilityUnder: underPct,
            engineConfidence: calcResult.engineConfidence ?? null,
            source: calcResult.source ?? "calculator",
          } as unknown as MlbSignalData)}
          className="w-full py-3 rounded-xl border border-green-500/30 bg-green-500/10 text-green-400 font-semibold text-sm hover:bg-green-500/20 transition-colors min-h-[48px]"
        >
          + Add {selectedSide} to Bet Slip
        </button>
      )}
    </div>
  );
}

function MlbLiveInner({ activeSubTab }: { activeSubTab: "live_feed" | "hr_radar" | "pregame_power" }) {
  const { user, isLoading: authLoading } = useAuth();
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [liveFeedSub, setLiveFeedSub] = useState<"all" | "3rd" | "5th" | "7th">("all");
  // Signal-first inning-window filter for the new market-signals feed.
  // Independent of `liveFeedSub` (legacy 3rd/5th/7th feedTag filter) so
  // we can keep both controls during rollout. Default "all".
  const [inningWindowFilter, setInningWindowFilter] = useState<"all" | "early" | "mid" | "late">("all");
  const [signalSortBy, setSignalSortBy] = useState<"signalScore" | "enginePct">("signalScore");
  const mlbUpgradeNeeded = false;
  const [mlbSlipPicks, setMlbSlipPicks] = useState<Array<{ playerId: string; playerName: string; market: string; line: number; side: string; sportsbook: string; edge: number | null; enginePct: number; gameId: string; overOdds?: number | null; underOdds?: number | null; overProbability?: number | null; underProbability?: number | null; engineConfidence?: number | null; source?: "engine" | "calculator" }>>([]);
  const [analyzeTarget, setAnalyzeTarget] = useState<{ playerId: string; gameId: string } | null>(null);
  const [hrViewMode, setHrViewMode] = useState<"quick" | "ladder">("quick");

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
  // Signal-first market-signals view (LiveLocks MLB UX Phase 1).
  // Returns server-stamped MarketSignalViewModel rows already grouped
  // by displayGroup. Inning window filter is sent as a query param —
  // server filters but never DROPS valid signals (unknown rows pass
  // through, just de-prioritized in sort).
  const { data: marketSignalsResp } = useQuery<{
    rows: import("@/components/mlb/LiveFeed").MarketSignalViewModelClient[];
    grouped: Record<string, import("@/components/mlb/LiveFeed").MarketSignalViewModelClient[]>;
    unknownInningCount: number;
    unknownInningReasons: Record<string, number>;
  }>({
    queryKey: ["/api/mlb/edge-feed", "market-signals", inningWindowFilter],
    queryFn: async () => {
      const res = await fetch(`/api/mlb/edge-feed?view=market-signals&inningWindow=${inningWindowFilter}`, { credentials: "include" });
      if (!res.ok) throw new Error("market-signals fetch failed");
      return res.json();
    },
    refetchInterval: 20_000,
    placeholderData: (prev) => prev,
    enabled: activeSubTab === "live_feed",
  });
  const rawSignals: MlbSignalData[] = Array.isArray(edgeFeedResp?.signals)
    ? (edgeFeedResp!.signals as MlbSignalData[]).map(s => mapMlbSignalToUi(s) as unknown as MlbSignalData)
    : [];
  const stickySignalMapRef = useRef<Map<string, MlbSignalData & { _stickyTs?: number }>>(new Map());

  // Freshness Integrity Fix #5 — clear sticky map on real engine recompute.
  // When the server's `updatedAt` advances, every sticky cell becomes
  // potentially-misleading immediately, so we drop the whole map. The next
  // render rebuilds from `rawSignals` (the just-arrived authoritative feed).
  const lastEdgeFeedUpdatedAtRef = useRef<number>(0);
  useEffect(() => {
    const nextUpdatedAt = edgeFeedResp?.updatedAt ?? 0;
    if (nextUpdatedAt > 0 && nextUpdatedAt !== lastEdgeFeedUpdatedAtRef.current) {
      stickySignalMapRef.current.clear();
      lastEdgeFeedUpdatedAtRef.current = nextUpdatedAt;
    }
  }, [edgeFeedResp?.updatedAt]);
  // Freshness Integrity Fix #5 — TTL fallback in case `updatedAt` never
  // advances (engine quiet, server crash, network drop). 120s replaces the
  // old 30-minute TTL that let removed signals linger for half an hour.
  const STICKY_TTL_MS = 120 * 1000;
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
    if (games.length > 0) {
      const activeGameIds = new Set(games.map(g => g?.gameId).filter(Boolean));
      if (activeGameIds.size > 0) {
        Array.from(merged.entries()).forEach(([key, sig]) => {
          if (sig.gameId && !activeGameIds.has(sig.gameId)) {
            merged.delete(key);
          }
        });
      }
    }
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

  // Sticky Result Panel + Smart Auto-Focus: pulses+scrolls only on a fresh successful calc,
  // never on input edits (which can leave a stale calcResult in place).
  const resultRef = useRef<HTMLDivElement | null>(null);
  const [resultPulse, setResultPulse] = useState(0);

  useEffect(() => {
    if (resultPulse === 0) return;
    const node = resultRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const viewportH = window.innerHeight || document.documentElement.clientHeight;
    const isMobile = (window.innerWidth || document.documentElement.clientWidth) < 1024;
    const fullyVisible = rect.top >= 0 && rect.bottom <= viewportH;
    const mostlyVisible = rect.top >= -40 && rect.top < viewportH * 0.6;
    if (isMobile || !fullyVisible) {
      if (!mostlyVisible) {
        node.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }, [resultPulse]);

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
    onSuccess: (data) => {
      setCalcResult(data);
      setResultPulse((n) => n + 1);
    },
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
    const sigAny = sig as any;
    setMlbSlipPicks(prev => [...prev, {
      playerId: sig.playerId, playerName: sig.playerName, market: sig.market,
      line: sig.bookLine ?? 0, side: sig.recommendedSide,
      sportsbook: sig.sportsbook ?? "draftkings", edge: sig.edge ?? null,
      enginePct: sig.enginePct, gameId: sig.gameId ?? "",
      overOdds: sig.overOdds, underOdds: sig.underOdds,
      // Canonical fields — preserved so the slip persists the same Over/Under
      // probabilities the calculator + box score both rendered.
      overProbability: sigAny.calibratedProbabilityOver ?? null,
      underProbability: sigAny.calibratedProbabilityUnder ?? null,
      engineConfidence: sigAny.engineConfidence ?? null,
      source: sigAny.source ?? "engine",
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

  // Freshness Integrity Fix #6 — single helper that invalidates every MLB
  // live query in lockstep so cards, feed, stats, signals, and HR radar all
  // refresh as one unit. Use this instead of one-off invalidateQueries calls.
  const refreshMlbLiveData = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/mlb/live-games"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mlb/edge-feed"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mlb/hr-radar"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mlb/hr-radar/ladder"] });
    if (selectedGameId) {
      queryClient.invalidateQueries({ queryKey: ["/api/mlb/live-stats", selectedGameId] });
      queryClient.invalidateQueries({ queryKey: ["/api/mlb/live-signals", selectedGameId] });
    }
  };

  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (isManualRefreshing) return;
    setIsManualRefreshing(true);
    try {
      const res = await apiRequest("GET", "/api/mlb/live-games?force=1");
      const freshData = await res.json();
      // Seed the just-fetched force=1 result so the UI updates immediately,
      // then fan out invalidation across the rest of the live pipeline.
      queryClient.setQueryData(["/api/mlb/live-games"], freshData);
      refreshMlbLiveData();
    } catch {}
    setTimeout(() => setIsManualRefreshing(false), 1000);
  };

  useEffect(() => {
    if (selectedGameId && games.length > 0 && !games.find(g => g.gameId === selectedGameId)) {
      setSelectedGameId(null);
    }
  }, [games, selectedGameId]);

  // Auto-select the first live game when nothing is selected so the user is
  // never stuck on a dead "Ready to Predict" empty state during live games.
  // Prefers status==="live"; falls back to the first game in the list (which
  // is the next-up pregame card). Pure UI state change — does not call any
  // API, mutate engine math, or affect signals/lifecycle/bus.
  useEffect(() => {
    if (selectedGameId) return;
    if (!games || games.length === 0) return;
    const liveGame = games.find(g => g?.status === "live" && g.gameId);
    const pick = liveGame ?? games.find(g => g?.gameId);
    if (pick?.gameId) {
      const liveCount = games.filter(g => g?.status === "live").length;
      console.log(`[MLB_AUTO_SELECT_GAME] gameId=${pick.gameId} status=${pick.status ?? "unknown"} liveGames=${liveCount} totalGames=${games.length}`);
      setSelectedGameId(pick.gameId);
    }
  }, [games, selectedGameId]);

  if (authLoading || gamesLoading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-3">
        <SkeletonCard count={4} />
      </div>
    );
  }

  if (mlbUpgradeNeeded) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 flex flex-col items-center justify-center gap-4">
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
    <div
      className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5"
      style={{ paddingBottom: mlbSlipPicks.length > 0 ? "calc(env(safe-area-inset-bottom, 16px) + 280px)" : "calc(env(safe-area-inset-bottom, 16px) + 24px)" }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-foreground tracking-tight" data-testid="text-mlb-header">LiveLocks | MLB</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 font-semibold border border-green-500/20">LIVE</span>
        </div>
      </div>
      {user?.isAdmin && (
        <AdminEngineDebugPanel selectedGameId={selectedGameId} />
      )}
      {(activeSubTab as string) === "games" && (
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

              <PreABWatchBand signals={gameSignals} onPlayerClick={handleSignalClick} />

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
                      <span className="text-xs font-bold text-foreground">Signal Read</span>
                      <span className="text-[9px] text-muted-foreground/70 ml-auto">Engine evaluating this player</span>
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
                          <><Calculator className="w-4 h-4" /> Get Signal Read</>
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
                    <div
                      ref={resultRef}
                      key={`result-${resultPulse}`}
                      data-testid="mlb-result-anchor"
                      className="lg:sticky lg:top-4 lg:z-10 scroll-mt-4 rounded-xl ring-2 ring-primary/40 ring-offset-2 ring-offset-background animate-in fade-in zoom-in-95 duration-300"
                    >
                      <ResultPanel
                        calcResult={calcResult}
                        calcMarket={calcMarket}
                        calcBookLine={calcBookLine}
                        activeCalcName={activeCalcName}
                        calcPlayer={calcPlayer}
                        selectedGameId={selectedGameId}
                        onAddToSlip={handleAddToSlip}
                        handleAddToSlip={handleAddToSlip}
                        matchingSignal={edgeFeedSignals.find(s =>
                          s.playerId === calcPlayer?.playerId &&
                          s.market === calcMarket &&
                          s.gameId === selectedGameId
                        ) ?? null}
                      />
                    </div>
                  )}

                  <GameSignalsPanel
                    signals={gameSignals}
                    isElite={isElite}
                    onAddToSlip={handleAddToSlip}
                    onOpenCalculator={handleSignalClick}
                    selectedGameId={selectedGameId}
                    totalFeedSignals={edgeFeedSignals.length}
                    isAdmin={!!user?.isAdmin}
                  />
                </div>
              </div>
            </>
          )}

          {/* Only renders when there are zero games today — the auto-select
              effect above ensures any non-empty `games` list immediately picks
              the first live (or fallback first) game, so this empty state is
              now a true "no slate" surface rather than a dead end. */}
          {!selectedGameId && games.length === 0 && (
            <div className="rounded-xl border border-border/40 bg-card p-8 text-center space-y-3" data-testid="mlb-games-empty-state">
              <Target className="w-10 h-10 text-muted-foreground/30 mx-auto" />
              <div className="text-sm font-bold text-foreground">No Live Games Right Now</div>
              <div className="text-xs text-muted-foreground">Game tiles will appear here as soon as today's slate is live.</div>
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
          {/* Signal-first inning window filter (LiveLocks MLB UX Phase 1). */}
          {(() => {
            // Compute per-window counts from marketSignalsResp for pill badges.
            // Only shown when we have loaded data; undefined = loading.
            const allRows = marketSignalsResp?.rows ?? [];
            const liveTotal = allRows.filter(r => r.displayGroup === "ACTION_NOW" || r.displayGroup === "BUILDING").length;
            return (
              <div className="flex items-center gap-2 flex-wrap" data-testid="mlb-inning-filter-row">
                <div className="flex gap-1.5 flex-wrap flex-1">
                  {(["all", "early", "mid", "late"] as const).map(win => {
                    const dotColor = win === "early" ? "#a78bfa" : win === "mid" ? "#94a3b8" : win === "late" ? "#ef4444" : null;
                    const count = win === "all"
                      ? allRows.length
                      : allRows.filter(r => r.inningWindow === win).length;
                    return (
                      <button
                        key={`win-${win}`}
                        data-testid={`tab-inning-window-${win}`}
                        onClick={() => setInningWindowFilter(win)}
                        className={`flex items-center gap-1.5 px-3.5 py-2.5 min-h-[44px] text-xs font-semibold rounded-full border transition-all ${
                          inningWindowFilter === win ? "bg-background text-foreground border-primary/50 shadow-sm" : "border-border/50 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {dotColor && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor }} />}
                        {win === "all" ? "All Innings" : win === "early" ? "Early 1–3" : win === "mid" ? "Mid 4–6" : "Late 7+"}
                        {marketSignalsResp !== undefined && count > 0 && (
                          <span className={`text-[9px] font-bold px-1 py-0.5 rounded-full ml-0.5 ${
                            inningWindowFilter === win ? "bg-primary/20 text-primary" : "bg-border/40 text-muted-foreground"
                          }`}>{count}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {/* Live pulse with active signal count */}
                {marketSignalsResp !== undefined && (
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
                    {liveTotal > 0
                      ? <><span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /><span className="text-green-400 font-semibold">{liveTotal} live</span></>
                      : <><span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" /><span>Engine scoring</span></>
                    }
                  </div>
                )}
              </div>
            );
          })()}
          {(() => {
            // Signal-first surface: render LiveFeed whenever the market-signals
            // endpoint has responded (even with 0 rows — the LiveFeed component
            // has its own narrative empty state). Falls back to legacy view only
            // during initial load before the query has fired.
            if (marketSignalsResp !== undefined) {
              const marketRows = marketSignalsResp.rows ?? [];
              // Build a fast lookup from view-model signalId → MlbSignalData.
              // Also index by canonicalSignalId to handle cases where the bus
              // signalId differs from the manually-constructed key.
              const sigIndex = new Map<string, MlbSignalData>();
              for (const s of edgeFeedSignals) {
                const sid = `mlb:${s.gameId}:${s.playerId}:${s.market}:${s.recommendedSide ?? "OVER"}`;
                sigIndex.set(sid, s);
                const csid = (s as any).canonicalSignalId;
                if (csid) sigIndex.set(csid, s);
              }
              const resolveSignal = (vm: import("@/components/mlb/LiveFeed").MarketSignalViewModelClient): MlbSignalData | null => {
                return sigIndex.get(vm.signalId) ?? null;
              };
              const distinctBatterIds = new Set<string>();
              for (const s of edgeFeedSignals) {
                if (s?.playerId) distinctBatterIds.add(String(s.playerId));
              }
              const buildingCount = marketRows.filter((r) => r.displayGroup === "BUILDING").length;
              const lateWindowsForming = marketRows.filter(
                (r) =>
                  (r.displayGroup === "ACTION_NOW" || r.displayGroup === "BUILDING") &&
                  r.inningWindow === "late",
              ).length;
              return (
                <div className="space-y-6">
                  <LiveFeed
                    rows={marketRows}
                    resolveSignal={resolveSignal}
                    onAddToSlip={handleAddToSlip}
                    isElite={isElite}
                    isAdmin={!!user?.isAdmin}
                    unknownInningCount={marketSignalsResp?.unknownInningCount}
                    narrativeStats={{
                      gamesMonitored: games.length,
                      batterProfiles: distinctBatterIds.size,
                      buildingCount,
                      lateWindowsForming,
                    }}
                  />
                </div>
              );
            }

            // Legacy fallback — only shown during initial load before market-signals responds.
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
                    <TopPlays signals={visibleSlice} onAddToSlip={handleAddToSlip} onOpenCalculator={handleSignalClick} sortBy={signalSortBy} />
                    {filtered.length > 1 && (
                      <div className="relative">
                        <div className="filter blur-[6px] pointer-events-none select-none" aria-hidden="true">
                          <LiveBoard signals={filtered.slice(1, 6)} sortBy={signalSortBy} />
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
                  <TopPlays signals={filtered} onAddToSlip={handleAddToSlip} onOpenCalculator={handleSignalClick} sortBy={signalSortBy} />
                  <LiveBoard signals={filtered} onAddToSlip={handleAddToSlip} onOpenCalculator={handleSignalClick} sortBy={signalSortBy} />
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

      {activeSubTab === "pregame_power" && (
        <div className="space-y-4">
          <PregamePowerRadar />
        </div>
      )}

      {activeSubTab === "hr_radar" && (
        <div className="space-y-4">
          {/* Quick Decide / Full Ladder toggle */}
          <div className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg border border-border/50">
            <button
              data-testid="button-hr-mode-quick"
              onClick={() => setHrViewMode("quick")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${hrViewMode === "quick" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              ⚡ Quick Decide
            </button>
            <button
              data-testid="button-hr-mode-ladder"
              onClick={() => setHrViewMode("ladder")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${hrViewMode === "ladder" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              Full Ladder
            </button>
          </div>

          {hrViewMode === "quick" ? (
            <HrQuickDecide
              onAddToSlip={handleAddToSlip}
              onSwitchToLadder={() => setHrViewMode("ladder")}
            />
          ) : (
            <HrRadarLadder
              onAddToSlip={handleAddToSlip}
              isAdmin={!!user?.isAdmin}
              onOpenDetails={(entry: HrRadarLadderEntry) => {
                handleHrRadarClick({
                  playerId: entry.playerId,
                  playerName: entry.playerName,
                  team: entry.team,
                  gameId: entry.gameId,
                } as unknown as HrRadarCardUi);
              }}
            />
          )}
        </div>
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

export default function MlbLivePage({ activeSubTab = "live_feed" }: { activeSubTab?: "live_feed" | "hr_radar" | "pregame_power" }) {
  return (
    <MLBErrorBoundary>
      <MlbLiveInner activeSubTab={activeSubTab} />
    </MLBErrorBoundary>
  );
}
