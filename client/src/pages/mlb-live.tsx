import { useState, useEffect, useRef, Component, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { getAdminViewMode } from "@/lib/adminViewMode";
import { TopPlays } from "@/components/mlb/TopPlays";
import { TopLiveOpportunities } from "@/components/mlb/TopLiveOpportunities";
import { LiveBoard } from "@/components/mlb/LiveBoard";
import { LiveFeed } from "@/components/mlb/LiveFeed";
import { MlbSignalCard, type MlbSignalData } from "@/components/mlb/MlbSignalCard";
import { HrRadarLadder, HeatingUpMeter, type HrRadarLadderEntry } from "@/components/mlb/HrRadarLadder";
import { hrTierTheme, tierFromPlayabilityStatus } from "@/components/mlb/hrRadarVisuals";
import { HR_RADAR_STAGE_COPY, hrRadarConsumerLabelForPlayability } from "@/components/mlb/hrRadarConsumerCopy";
import { PregameHub } from "@/components/mlb/pregame/PregameHub";
import { AbLogRows, type AbRow } from "@/components/mlb/AbLogRows";
import { HrQuickDecide } from "@/components/mlb/HrQuickDecide";
import { shouldMountHrRadarTab } from "@/lib/mlb/hrRadarFeatureFlag";
import { type MlbPlayerStat } from "@/components/mlb/MlbBoxScore";
import { MlbSlateRibbon } from "@/components/mlb/MlbSlateRibbon";
import { LiveEdgePreview } from "@/components/dashboard/LiveEdgePreview";
import { UpgradeModal } from "@/components/upgrade-modal";
import type { MLBSignal } from "@shared/mlbSignal";
import type { LiveEdgePreview as LiveEdgePreviewData } from "@shared/topPlays";
import { applyConvictionCap10, convictionDisplayBadge, pregameSeedTierLabel } from "@shared/hrRadarConviction";
import { ProbabilityRing } from "@/components/probability-ring";
import { StatCard } from "@/components/stat-card";
import { SkeletonCard } from "@/components/sports/SkeletonCard";
import { EmptyState } from "@/components/sports/EmptyState";
import { LiveIndicator } from "@/components/common/LiveIndicator";
import { Radio, Target, RefreshCw, Calculator, Loader2, Flame, Zap, Trophy, Eye, ChevronDown, ChevronUp, Bell, Activity, X, BarChart3, Plus, ExternalLink, TrendingUp, TrendingDown, Clock, CheckCircle2, Calendar } from "lucide-react";
import {
  launchAngleLabel, formatMlbDisplayValue,
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

// Server-authoritative discriminant (see server/services/liveEdgeAccess.ts).
// "full" carries the complete existing shape unchanged; "preview" carries
// only the sanitized LiveEdgePreview — no signals/rows/grouped fields ride
// along, regardless of which `view` was requested.
type EdgeFeedResponse =
  | {
      access: "full";
      // Freshness Integrity Fix #2 — server now returns full feed metadata so
      // the client can detect a real engine recompute and clear sticky state
      // on advance.
      mode?: "live" | "monitoring";
      signals: MLBSignal[];
      updatedAt?: number;
      generatedAt?: number;
      staleCount?: number;
      edgeCacheEntries?: number;
    }
  | { access: "preview"; preview: LiveEdgePreviewData };


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

function formatOdds(n: number): string {
  return n > 0 ? `+${n}` : String(n);
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
  const initialScore = parseFloat(alert.initialReadinessScore ?? "0");
  const currentScore = parseFloat(alert.currentReadinessScore ?? "0");
  const peakScore = parseFloat(alert.peakReadinessScore ?? "0");
  // Same shared heat-tier ramp the ladder/Quick Decide use (hrRadarVisuals.tsx),
  // keyed off the server-stamped playabilityStatus rather than a separately
  // re-derived score→tier lookup, so this modal's color can never diverge from
  // the card's for the same signal.
  const t = hrTierTheme(tierFromPlayabilityStatus((alert as any).playabilityStatus, alert.status === "hit"));
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
          {/* Single trajectory representation (initial → current · peak +
              HeatingUpMeter) — the same widget the Full Ladder card uses, so
              there is exactly one trajectory design across the feature
              instead of a separate three-tile + progress-bar rendering. */}
          <div className="flex items-center justify-between gap-3 px-1">
            <div className="flex items-baseline gap-1.5 font-mono">
              <span className="text-xs text-muted-foreground" data-testid="text-signal-score-10-initial">
                {initial10.toFixed(1)}
              </span>
              <span className="text-muted-foreground">→</span>
              <span className="text-xl font-extrabold" style={{ color: t.hex }} data-testid="text-signal-score-10-current">
                {current10.toFixed(1)}
              </span>
              <span className="text-[10px] text-muted-foreground/60">
                /10 · peak <span data-testid="text-signal-score-10-peak">{peak10.toFixed(1)}</span>
              </span>
            </div>
            <HeatingUpMeter
              initial={initial10}
              current={current10}
              peak={peak10}
              playerId={alert.playerId ?? "analyze"}
              isPregame={isNoAbsYet}
            />
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
              {/* Consumer-safe stage label (Fire/Ready/Build/Watch) — the same
                  ONE vocabulary Quick Decide and Full Ladder use. Never the
                  server's internal playability jargon (Watchlist/Lean/
                  Playable/Attack), the internal pregame-seed tier
                  (LEAN/WATCH), or raw confidenceTier/signalState. */}
              <span data-testid="text-analyze-tier">
                Stage: {pregameSeedTier === "LEAN" ? HR_RADAR_STAGE_COPY.build.short
                  : pregameSeedTier === "WATCH" ? HR_RADAR_STAGE_COPY.watch.short
                  : hrRadarConsumerLabelForPlayability((alert as any).playabilityStatus)}
              </span>
              {pregameSeedTier && !(alert as any).playabilityLabel && (
                <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-300 border border-orange-500/20 font-semibold">
                  Pregame
                </span>
              )}
              {(alert as any).playabilityDescription && (
                <>
                  <span className="text-muted-foreground/40">|</span>
                  <span>{(alert as any).playabilityDescription}</span>
                </>
              )}
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

function MlbLiveInner({ activeSubTab, showHrRadarTab = false }: { activeSubTab: "live_feed" | "hr_radar" | "pregame_power"; showHrRadarTab?: boolean }) {
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
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

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
  const { data: marketSignalsRespRaw } = useQuery<
    | {
        access: "full";
        rows: import("@/components/mlb/LiveFeed").MarketSignalViewModelClient[];
        grouped: Record<string, import("@/components/mlb/LiveFeed").MarketSignalViewModelClient[]>;
        unknownInningCount: number;
        unknownInningReasons: Record<string, number>;
      }
    | { access: "preview"; preview: LiveEdgePreviewData }
  >({
    queryKey: ["/api/mlb/edge-feed", "market-signals", inningWindowFilter],
    queryFn: async ({ signal }) => {
      const viewMode = getAdminViewMode();
      const headers: Record<string, string> = {};
      if (viewMode !== "real") headers["X-LL-Admin-View-Mode"] = viewMode;
      const res = await fetch(`/api/mlb/edge-feed?view=market-signals&inningWindow=${inningWindowFilter}`, { credentials: "include", headers, signal });
      if (!res.ok) throw new Error("market-signals fetch failed");
      return res.json();
    },
    refetchInterval: 20_000,
    placeholderData: (prev) => prev,
    // Preview-access users never need this query — the live_feed tab renders
    // LiveEdgePreview from edgeFeedResp.access alone and never reads
    // marketSignalsResp's data in that branch, so skip the extra request.
    enabled: activeSubTab === "live_feed" && edgeFeedResp?.access !== "preview",
  });
  // Narrowed view for the rest of the component — at runtime this is only
  // ever the "preview" variant when edgeFeedResp is ALSO "preview" (both
  // queries resolve the same user's access the same way), and the live_feed
  // render branch below never reaches code that uses this when
  // edgeFeedResp.access === "preview". Downstream code keeps using the same
  // `marketSignalsResp` name/shape it always has.
  const marketSignalsResp = marketSignalsRespRaw?.access === "full" ? marketSignalsRespRaw : undefined;
  const rawSignals: MlbSignalData[] = edgeFeedResp?.access === "full" && Array.isArray(edgeFeedResp.signals)
    ? edgeFeedResp.signals.map(s => mapMlbSignalToUi(s) as unknown as MlbSignalData)
    : [];
  const stickySignalMapRef = useRef<Map<string, MlbSignalData & { _stickyTs?: number }>>(new Map());

  // Freshness Integrity Fix #5 — clear sticky map on real engine recompute.
  // When the server's `updatedAt` advances, every sticky cell becomes
  // potentially-misleading immediately, so we drop the whole map. The next
  // render rebuilds from `rawSignals` (the just-arrived authoritative feed).
  const lastEdgeFeedUpdatedAtRef = useRef<number>(0);
  const edgeFeedUpdatedAt = edgeFeedResp?.access === "full" ? edgeFeedResp.updatedAt ?? 0 : 0;
  useEffect(() => {
    if (edgeFeedUpdatedAt > 0 && edgeFeedUpdatedAt !== lastEdgeFeedUpdatedAtRef.current) {
      stickySignalMapRef.current.clear();
      lastEdgeFeedUpdatedAtRef.current = edgeFeedUpdatedAt;
    }
  }, [edgeFeedUpdatedAt]);
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

  // Clear the ribbon's game filter when the selected game leaves the slate
  // (e.g. it ends and drops off), so the active surface never gets stuck
  // filtered to a game that no longer exists. The ribbon defaults to "All
  // games" (selectedGameId === null) — we no longer auto-select a game.
  useEffect(() => {
    if (selectedGameId && games.length > 0 && !games.find(g => g.gameId === selectedGameId)) {
      setSelectedGameId(null);
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
      {/* Slate ribbon — premium per-game triage. Deep-links into the active
          surface (HR Radar / Pre-Game Power) via selectedGameId. Replaces the
          former orphaned "games" sub-tab block. */}
      <MlbSlateRibbon
        games={games}
        signals={edgeFeedSignals}
        selectedGameId={selectedGameId}
        onSelectGame={setSelectedGameId}
        dataUpdatedAt={gamesUpdatedAt}
      />

      {activeSubTab === "live_feed" && (
        edgeFeedResp?.access === "preview" ? (
          <LiveEdgePreview preview={edgeFeedResp.preview} onUpgradeClick={() => setShowUpgradeModal(true)} />
        ) : edgeFeedResp?.access !== "full" ? null : (
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
        )
      )}

      {activeSubTab === "pregame_power" && (
        <div className="space-y-4">
          <PregameHub selectedGameId={selectedGameId} />
        </div>
      )}

      {shouldMountHrRadarTab(activeSubTab, showHrRadarTab) && (
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
              selectedGameId={selectedGameId}
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

      {showUpgradeModal && (
        <UpgradeModal
          playsUsed={0}
          limit={0}
          currentTier={user?.subscriptionTier ?? null}
          onClose={() => setShowUpgradeModal(false)}
        />
      )}
    </div>
  );
}

export default function MlbLivePage({
  activeSubTab = "live_feed",
  showHrRadarTab = false,
}: {
  activeSubTab?: "live_feed" | "hr_radar" | "pregame_power";
  showHrRadarTab?: boolean;
}) {
  return (
    <MLBErrorBoundary>
      <MlbLiveInner activeSubTab={activeSubTab} showHrRadarTab={showHrRadarTab} />
    </MLBErrorBoundary>
  );
}
