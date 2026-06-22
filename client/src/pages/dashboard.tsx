import { useState, useEffect, useRef, useMemo } from "react";
import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { calculateProbabilitySchema, type CalculateProbabilityRequest, type ParlayPickInput, type InjuryPlayer } from "@shared/schema";
import { usePlayers, useTeams, useCalculateProbability, useLiveGames, useLiveStats, usePlayerOdds, useGameLines, PlayLimitError } from "@/hooks/use-nba";
import { apiRequest, queryClient, getAuthToken } from "@/lib/queryClient";
import { ProbabilityRing } from "@/components/probability-ring";
import { StatCard } from "@/components/stat-card";
import { ParlaySlip } from "@/components/parlay-slip";
import { UpgradeModal } from "@/components/upgrade-modal";
import { FeedbackModal } from "@/components/feedback-modal";
import { ManageSubscriptionModal } from "@/components/manage-subscription-modal";
import { NCAABAdminTab } from "@/components/ncaab-admin-tab";
import MlbLivePage from "@/pages/mlb-live";
import { WelcomeBanner } from "@/components/welcome-banner";
import { RecentWinsStrip } from "@/components/RecentWinsStrip";
import { LiveBoxscore } from "@/components/live-boxscore";
import { AlertsOnboardingModal } from "@/components/alerts-onboarding-modal";
import { useAuth } from "@/hooks/use-auth";
import { OnboardingTour } from "@/components/onboarding-tour";
import { SportPicker } from "@/components/sport-picker";
import { usePullRefresh } from "@/hooks/use-pull-refresh";
import { hasProAccess } from "@/lib/tierUtils";
import { useLocation } from "wouter";
import { TopPlaysPanel } from "@/components/dashboard/TopPlaysPanel";
import { QueryErrorState } from "@/components/common/QueryErrorState";
import { LiveIndicator } from "@/components/common/LiveIndicator";
import { FreeActivationRail } from "@/components/dashboard/free-activation-rail";
import { SignalPreviewConversionCard } from "@/components/dashboard/SignalPreviewConversionCard";
import { TrialMissionRail } from "@/components/dashboard/trial-mission-rail";
import { trackRailEvent } from "@/lib/railAnalytics";
import { SignalDetailDialog } from "@/components/signals/SignalDetailDialog";
import type { UnifiedTopPlay } from "@/hooks/useTopPlays";
import { UserStatusRail } from "@/components/dashboard/UserStatusRail";
import { LiveUpdateToast } from "@/components/common/LiveUpdateToast";
import { LockedSignalModule } from "@/components/LockedSignalModule";
import {
  Activity,
  Clock,
  AlertTriangle,
  Target,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  Zap,
  Radio,
  RefreshCw,
  Plus,
  Trophy,
  Loader2,
  Users,
  Search,
  Star,
  Copy,
  Check,
  Settings,
  Lock,
  Bell,
  CheckCircle2,
  X,
  ChevronUp,
  BarChart3,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SiX } from "react-icons/si";

interface NotificationLog {
  id: string;
  timestamp: number;
  type: "prop" | "game" | "edge_flip";
  sport: "nba" | "ncaab";
  title: string;
  body: string;
  confidence: number;
  gameId: string;
  playerId?: string;
  market?: string;
  direction?: string;
  line?: number;
  result?: "HIT" | "MISS" | "PUSH" | null;
  settledAt?: number;
}

// ESPN abbreviation → our DB team abbreviation
const ESPN_TO_DB: Record<string, string> = {
  GS: "GSW", SA: "SAS", NO: "NOP", NY: "NYK",
  PHO: "PHX", UTH: "UTA", UTAH: "UTA", WSH: "WAS", CHO: "CHA",
};
const espnToDb = (abbr: string) => ESPN_TO_DB[abbr.toUpperCase()] ?? abbr.toUpperCase();

const STAT_TYPES = [
  { value: "points", label: "Points" },
  { value: "rebounds", label: "Rebounds" },
  { value: "assists", label: "Assists" },
  { value: "threes", label: "3-Pointers Made" },
  { value: "steals", label: "Steals" },
  { value: "blocks", label: "Blocks" },
  { value: "pts_reb_ast", label: "Pts+Reb+Ast" },
  { value: "pts_reb", label: "Pts+Reb" },
  { value: "pts_ast", label: "Pts+Ast" },
  { value: "reb_ast", label: "Reb+Ast" },
  { value: "stl_blk", label: "Stl+Blk" },
];

const SPORTSBOOK_LABELS: Record<string, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  hardrockbet: "Hard Rock",
  fanatics: "Fanatics",
  prizepicks: "PrizePicks",
  underdogfantasy: "Underdog",
};

const TEAM_FULL_NAMES: Record<string, string> = {
  ATL: "Atlanta Hawks", BKN: "Brooklyn Nets", BOS: "Boston Celtics",
  CHA: "Charlotte Hornets", CHI: "Chicago Bulls", CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks", DEN: "Denver Nuggets", DET: "Detroit Pistons",
  GSW: "Golden State Warriors", HOU: "Houston Rockets", IND: "Indiana Pacers",
  LAC: "LA Clippers", LAL: "LA Lakers", MEM: "Memphis Grizzlies",
  MIA: "Miami Heat", MIL: "Milwaukee Bucks", MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans", NYK: "New York Knicks", OKC: "OKC Thunder",
  ORL: "Orlando Magic", PHI: "Philadelphia 76ers", PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers", SAC: "Sacramento Kings", SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors", UTA: "Utah Jazz", WAS: "Washington Wizards",
};

function formatOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function americanToImplied(odds: number): number {
  if (!odds || odds === 0) return 0.5;
  return odds < 0
    ? Math.abs(odds) / (Math.abs(odds) + 100)
    : 100 / (odds + 100);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from(Array.from(rawData).map(c => c.charCodeAt(0)));
}

const RESET_STEPS = [
  "Clearing yesterday's slate...",
  "Fetching today's NBA games...",
  "Fetching today's NCAAB games...",
  "Engine ready...",
  "Let's go 🔒",
];

// ── Auto-scan qualification thresholds (NBA edge scanner) ──────────────────
// A play qualifies for the auto-run result when it clears both the probability
// floor and the edge floor; plays above the top-tier probability sort first.
const AUTOSCAN_MIN_PROB = 55;
const AUTOSCAN_MIN_EDGE = 5;
const AUTOSCAN_TOP_TIER_PROB = 70;

// Minimum perceived "scanning" time so the edge scan never flashes instantly —
// returns a slightly randomized 300–800ms floor used to pad fast responses.
function autoScanMinDelayMs(): number {
  return 300 + Math.random() * 500;
}

function NewSlateOverlay({
  step,
  steps,
  date,
  liveCount,
  visible,
}: {
  step: number;
  steps: string[];
  date: Date;
  liveCount: number;
  visible: boolean;
}) {
  const progressPct = Math.min(100, (step / (steps.length - 1)) * 100);
  const dateStr = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  return (
    <div
      data-testid="new-slate-overlay"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.92)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "24px",
        opacity: visible ? 1 : 0,
        transition: "opacity 300ms ease",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      {/* Pulsing logo */}
      <div style={{ animation: "slateLogoPulse 2s ease-in-out infinite" }}>
        <img
          src={propPulseLogo}
          alt="LiveLocks"
          style={{ width: 64, height: 64, borderRadius: 16, boxShadow: "0 0 32px hsl(var(--brand-accent) / 0.35)" }}
        />
      </div>

      {/* Heading */}
      <div style={{ textAlign: "center" }}>
        <p style={{ color: "#ffffff", fontWeight: 900, fontSize: 28, letterSpacing: "-0.02em", margin: 0, lineHeight: 1.1 }}>
          New Slate Loading
        </p>
        <p style={{ color: "#71717a", fontSize: 14, fontWeight: 400, marginTop: 6 }}>{dateStr}</p>
      </div>

      {/* Progress section */}
      <div style={{ width: "100%", maxWidth: 280, display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Progress bar track */}
        <div style={{ height: 3, background: "#27272a", borderRadius: 99, overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${progressPct}%`,
              background: "hsl(var(--brand-accent))",
              borderRadius: 99,
              transition: "width 400ms ease",
            }}
          />
        </div>
        {/* Step text */}
        <p
          data-testid="slate-reset-step"
          style={{ color: "#a1a1aa", fontSize: 13, fontFamily: "monospace", textAlign: "center", minHeight: 20, transition: "opacity 200ms ease" }}
        >
          {steps[step] ?? ""}
        </p>
      </div>

      {/* Live count (shows at step 4+) */}
      {step >= 4 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {liveCount > 0 ? (
            <>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "hsl(var(--brand-accent))", display: "inline-block" }} />
              <span style={{ color: "hsl(var(--brand-accent))", fontSize: 13 }}>{liveCount} game{liveCount !== 1 ? "s" : ""} live now</span>
            </>
          ) : (
            <span style={{ color: "#71717a", fontSize: 13 }}>Slate loaded — check back at tipoff</span>
          )}
        </div>
      )}

      <style>{`
        @keyframes slateLogoPulse {
          0%, 100% { transform: scale(1.0); }
          50% { transform: scale(1.08); }
        }
      `}</style>
    </div>
  );
}

const TWEET_COUNTER_KEY = "livelocks_tweet_template_counter";

interface TweetSnippetParams {
  playerName: string;
  direction: string;
  line: string | number;
  statLabel: string;
  directionProb: string;
  projection: string;
  gap: string;
  atHalftime: boolean;
  teamCashtag: string;
  oppCashtag: string;
}

function buildTweetSnippet(params: TweetSnippetParams & { templateIndex: number }): string {
  const { playerName, direction, line, statLabel, directionProb, projection, gap, atHalftime, teamCashtag, oppCashtag, templateIndex } = params;
  const halftimeNote = atHalftime ? "\n\nDetected live at halftime." : "";
  const cashtags = [teamCashtag, oppCashtag].filter(Boolean).join(" ");
  const hashtagBlock = `@proppulsebet #LiveLocks #NBAProps ${cashtags}`;
  const templates = [
    `LIVE EDGE 🚨\n\n${playerName}\n${direction} ${line} ${statLabel}\n\nModel probability: ${directionProb}%\nProjection: ${projection}\nAlpha gap: ${gap}${halftimeNote}\n\n${hashtagBlock}\n\n[Link in Bio]`,
    `⏳ Line moving — ${playerName} ${direction} ${line} ${statLabel}\n\nGap: ${gap} · ${directionProb}% model probability\nProjection: ${projection}${halftimeNote}\n\nLock it before it shifts 🔒\n\n${hashtagBlock}\n\n[Link in Bio]`,
    `${playerName} · ${direction} ${line} ${statLabel}\nProb ${directionProb}% · Proj ${projection} · Gap ${gap}${halftimeNote}\n\n${hashtagBlock}\n\n[Link in Bio]`
  ];
  return templates[templateIndex % 3];
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [upgradeModalState, setUpgradeModalState] = useState<{ playsUsed: number; limit: number }>({ playsUsed: 3, limit: 3 });

  const { data: players, isLoading: isPlayersLoading } = usePlayers();
  const { data: teams, isLoading: isTeamsLoading } = useTeams();
  const { data: liveGames, isLoading: isGamesLoading, isError: isGamesError, isFetching: isGamesFetching, refetch: refetchGames } = useLiveGames();
  
  const { data: dataHealth } = useQuery({
    queryKey: ["/api/debug/data-health"],
    queryFn: async () => {
      const res = await fetch("/api/debug/data-health");
      if (!res.ok) return null;
      return res.json();
    },
    enabled: user?.isAdmin === true,
    refetchInterval: 30000,
  });

  const [autoRunResult, setAutoRunResult] = useState<{ probability: number; projection: number; line: number; direction: string; playerName: string; statType: string; edge: number } | null>(null);
  const [autoRunFallback, setAutoRunFallback] = useState<string | null>(null);
  const [showConfidenceBadge, setShowConfidenceBadge] = useState(false);
  const [scanningEdges, setScanningEdges] = useState(false);
  const autoRunFiredRef = useRef(false);

  const autoRunBestSignal = async () => {
    setScanningEdges(true);
    const scanStart = Date.now();
    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/halftime-plays", { credentials: "include", headers });
      if (!res.ok) {
        const elapsed = Date.now() - scanStart;
        const minDelay = autoScanMinDelayMs();
        if (elapsed < minDelay) await new Promise(r => setTimeout(r, minDelay - elapsed));
        setScanningEdges(false);
        setAutoRunFallback("no_edges");
        return;
      }
      const data = await res.json();
      const plays = data.plays ?? [];
      if (plays.length > 0) {
        fetch("/api/halftime-plays/verify-client", { credentials: "include",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientReceived: true,
            sourceCount: plays.length,
          }),
        }).catch(() => {/* fire-and-forget */});
      }

      const qualifiedPlays = plays
        .filter((p: any) => {
          const prob = parseFloat(p.probability);
          const edge = parseFloat(p.edge ?? "0");
          return prob >= AUTOSCAN_MIN_PROB && edge >= AUTOSCAN_MIN_EDGE;
        })
        .sort((a: any, b: any) => {
          const probA = parseFloat(a.probability);
          const probB = parseFloat(b.probability);
          if (probA >= AUTOSCAN_TOP_TIER_PROB && probB < AUTOSCAN_TOP_TIER_PROB) return -1;
          if (probB >= AUTOSCAN_TOP_TIER_PROB && probA < AUTOSCAN_TOP_TIER_PROB) return 1;
          const edgeA = parseFloat(a.edge ?? "0");
          const edgeB = parseFloat(b.edge ?? "0");
          if (probA === probB) return Math.abs(edgeB) - Math.abs(edgeA);
          return probB - probA;
        });
      if (qualifiedPlays.length === 0) {
        const elapsed = Date.now() - scanStart;
        const minDelay = autoScanMinDelayMs();
        if (elapsed < minDelay) await new Promise(r => setTimeout(r, minDelay - elapsed));
        setScanningEdges(false);
        setAutoRunFallback("no_edges");
        return;
      }

      const best = qualifiedPlays[0];
      const prob = parseFloat(best.probability);
      const line = parseFloat(best.line);
      const projection = parseFloat(best.projection ?? best.expectedTotal ?? "0");
      const direction = best.betDirection?.toUpperCase() ?? "OVER";
      const edge = parseFloat(best.edge ?? "0");

      const elapsed = Date.now() - scanStart;
      const minDelay = autoScanMinDelayMs();
      if (elapsed < minDelay) await new Promise(r => setTimeout(r, minDelay - elapsed));
      setScanningEdges(false);

      setAutoRunResult({
        probability: prob,
        projection,
        line,
        direction,
        playerName: best.playerName ?? "Signal",
        statType: best.statType ?? "",
        edge,
      });
      setShowConfidenceBadge(true);
    } catch {
      const elapsed = Date.now() - scanStart;
      const minDelay = autoScanMinDelayMs();
      if (elapsed < minDelay) await new Promise(r => setTimeout(r, minDelay - elapsed));
      setScanningEdges(false);
      setAutoRunFallback("no_edges");
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const isVerified = params.get("verified") === "1";
    if (isVerified) {
      toast({ title: "You're verified — let's find your first edge" });
      params.delete("verified");
      const newUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
      window.history.replaceState({}, "", newUrl);
    }

    const shouldAutoRun = isVerified || (user && (user.playsUsedToday ?? 0) === 0);
    if (shouldAutoRun && !autoRunFiredRef.current) {
      autoRunFiredRef.current = true;
      autoRunBestSignal();
    }
  }, [user?.playsUsedToday]);

  const [showResetOverlay, setShowResetOverlay] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [resetStep, setResetStep] = useState(0);
  const [ncaabResetKey, setNcaabResetKey] = useState(0);
  const [localTier, setLocalTier] = useState<string | null | undefined>(undefined);

  const effectiveTier = localTier !== undefined
    ? localTier
    : (user?.subscriptionTier ??
       (user as any)?.tier ??
       (user as any)?.metadata?.tier ??
       null);
  const hasNcaabAccess = !!(user?.isAdmin || hasProAccess(effectiveTier));

  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getResetTime = async (): Promise<{ hours: number; minutes: number }> => {
    try {
      const res = await fetch("/api/admin/settings", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (data.slateResetHour != null) return { hours: data.slateResetHour, minutes: data.slateResetMinute ?? 0 };
      }
    } catch (_) {}
    try {
      const stored = localStorage.getItem("slateResetTime");
      if (stored) return JSON.parse(stored);
    } catch (_) {}
    return { hours: 6, minutes: 0 };
  };

  const rescheduleResetTimer = useRef<(h: number, m: number) => void>(() => {});
  rescheduleResetTimer.current = (hours: number, minutes: number) => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    const resetHourUTC = hours + 5;
    const next = new Date();
    next.setUTCHours(resetHourUTC, minutes, 0, 0);
    if (new Date() >= next) next.setUTCDate(next.getUTCDate() + 1);
    const delay = next.getTime() - Date.now();
    resetTimerRef.current = setTimeout(() => {
      executeSlateReset.current();
      rescheduleResetTimer.current(hours, minutes);
    }, delay);
  };

  const executeSlateReset = useRef<() => void>(() => {});
  executeSlateReset.current = async () => {
    setShowResetOverlay(true);
    setResetStep(0);
    setTimeout(() => setOverlayVisible(true), 10);

    const stepInterval = setInterval(() => {
      setResetStep(prev => {
        if (prev >= RESET_STEPS.length - 1) { clearInterval(stepInterval); return prev; }
        return prev + 1;
      });
    }, 600);

    setNotificationLog([]);
    localStorage.setItem("lastLogDate", new Date().toDateString());
    setParlayPicks([]);
    setVisibleHalftimeGroups([]);
    setNcaabResetKey(k => k + 1);

    await Promise.all([
      refetchGames(),
      queryClient.invalidateQueries({ queryKey: ["/api/ncaab/plays"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/ncaab/games"] }),
    ]);

    await new Promise(r => setTimeout(r, 2800));

    setOverlayVisible(false);
    setTimeout(() => { setShowResetOverlay(false); setResetStep(0); }, 300);

    localStorage.setItem("lastSlateReset", new Date().toISOString());
  };

  useEffect(() => {
    let cancelled = false;
    getResetTime().then(({ hours, minutes }) => {
      if (!cancelled) rescheduleResetTimer.current(hours, minutes);
    });
    return () => { cancelled = true; if (resetTimerRef.current) clearTimeout(resetTimerRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 300);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const syncRostersMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sync-rosters"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/players"] }),
  });

  const [selectedGameId, setSelectedGameId] = useState<string | undefined>();
  const [selectedGameTeams, setSelectedGameTeams] = useState<{
    home: string; away: string; homeAbbr: string; awayAbbr: string;
  } | undefined>();
  const [parlayPicks, setParlayPicks] = useState<ParlayPickInput[]>([]);
  const [showParlay, setShowParlay] = useState(false);
  const [selectedDetailPlay, setSelectedDetailPlay] = useState<UnifiedTopPlay | null>(null);
  const [selectedDetailRelated, setSelectedDetailRelated] = useState<UnifiedTopPlay[]>([]);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 1024);
  const [selectedSportsbook, setSelectedSportsbook] = useState<string>("manual");
  const [autoFilledFields, setAutoFilledFields] = useState<Set<string>>(new Set());
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [copiedPick, setCopiedPick] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [showManageModal, setShowManageModal] = useState(false);

  const [activeTab, setActiveTab] = useState<"calculator" | "ncaab" | "analytics" | "mlb">("calculator");
  const [nbaSubTab, setNbaSubTab] = useState<"live" | "halftime">("live");
  const [mlbSubTab, setMlbSubTab] = useState<"live_feed" | "hr_radar">("hr_radar");
  const [expandToGameId, setExpandToGameId] = useState<string | null>(null);
  const [showWelcomeBanner, setShowWelcomeBanner] = useState(false);
  const [showSportPicker, setShowSportPicker] = useState(false);
  const [onboardingCompleted, setOnboardingCompleted] = useState(true);
  const [userHydrated, setUserHydrated] = useState(false);

  useEffect(() => {
    if (user && !userHydrated) {
      setUserHydrated(true);
      if (!user.sportFocus) {
        setShowSportPicker(true);
      }
      if (user.sportFocus === "mlb") {
        setActiveTab("mlb");
      }
      setOnboardingCompleted(user.hasCompletedOnboarding ?? false);
    }
  }, [user, userHydrated]);
  const [verifyBannerDismissed, setVerifyBannerDismissed] = useState(false);
  const [resendingVerify, setResendingVerify] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [slateFilterProp, setSlateFilterProp] = useState<string>("all");
  const [slateFilterProb, setSlateFilterProb] = useState<string>("all");
  const [nbaBookFilter, setNbaBookFilter] = useState<string>("all");
  const [ncaabBookFilter, setNcaabBookFilter] = useState<string>("all");
  const [showHistorySheet, setShowHistorySheet] = useState(false);
  const [notificationLog, setNotificationLog] = useState<NotificationLog[]>([]);
  const [isSmallScreen, setIsSmallScreen] = useState(() => window.innerWidth < 768);
  const [exitingGames, setExitingGames] = useState<Record<string, boolean>>({});
  const [visibleHalftimeGroups, setVisibleHalftimeGroups] = useState<Array<{
    gameId: string; awayTeamAbbr: string; homeTeamAbbr: string;
    awayFull: string; homeFull: string; awayScore: number; homeScore: number; plays: any[];
  }>>([]);
  const [currentHalftimePage, setCurrentHalftimePage] = useState(1);
  const [halftimeCountPulse, setHalftimeCountPulse] = useState(false);
  const [halfTransitionToast, setHalfTransitionToast] = useState<{ away: string; home: string } | null>(null);
  const halftimeSectionRef = useRef<HTMLDivElement>(null);
  const prevLiveGamesRef = useRef<any[]>([]);
  const exitingGamesRef = useRef<Record<string, boolean>>({});
  const visibleHalftimeGroupsRef = useRef<typeof visibleHalftimeGroups>([]);

  // ── SMS Bell state (localStorage-persisted) ───────────────────────────────
  type SmsStatus = "unprompted" | "opted-in" | "opted-out";
  const [smsStatus, setSmsStatusState] = useState<SmsStatus>(() =>
    (localStorage.getItem("smsStatus") as SmsStatus) ?? "unprompted"
  );
  const setSmsStatus = (s: SmsStatus) => {
    setSmsStatusState(s);
    localStorage.setItem("smsStatus", s);
  };
  const [showSmsModal, setShowSmsModal] = useState(false);
  const [smsBellInput, setSmsBellInput] = useState(() => localStorage.getItem("smsPhone") ?? "");
  const [smsBellInputError, setSmsBellInputError] = useState("");
  const [smsModalFlow, setSmsModalFlow] = useState<"view" | "update">("view");
  const bellRef = useRef<SVGSVGElement>(null);

  const isValidPhone = (phone: string) => {
    const cleaned = phone.replace(/\D/g, "");
    return cleaned.length === 10 || (cleaned.length === 11 && cleaned[0] === "1");
  };

  const triggerBellFlash = () => {
    if (!bellRef.current) return;
    bellRef.current.classList.remove("bell-flash");
    void (bellRef.current as unknown as HTMLElement).offsetWidth; // force reflow
    bellRef.current.classList.add("bell-flash");
  };

  useEffect(() => {
    if (smsStatus === "unprompted") triggerBellFlash();
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showAlertsModal, setShowAlertsModal] = useState(() => {
    try { return !localStorage.getItem("ll_alerts_onboarded"); } catch { return false; }
  });
  const [pwaPromptDismissed, setPwaPromptDismissed] = useState(() => !!localStorage.getItem("ll_pwa_dismissed"));
  const deferredInstallPromptRef = useRef<any>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [isIosPwa] = useState(() => {
    const ua = navigator.userAgent.toLowerCase();
    const isIos = /iphone|ipad|ipod/.test(ua);
    const isStandalone = (window.navigator as any).standalone === true;
    return isIos && !isStandalone;
  });
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsLoading, setSmsLoading] = useState(false);
  const [alertHistory, setAlertHistory] = useState<{ title: string; body: string; time: number }[]>(() => {
    try { return JSON.parse(localStorage.getItem("ll_alerts") ?? "[]"); } catch { return []; }
  });

  const loadPlayInCalculator = (play: any) => {
    if (play.gameId) setSelectedGameId(play.gameId);
    form.setValue("playerId" as any, String(play.playerId));
    form.setValue("statType" as any, play.statType);
    form.setValue("liveLine" as any, play.line);
    form.setValue("halftimeStat" as any, play.halftimeStat ?? 0);
    form.setValue("halftimeMinutes" as any, play.halftimeMinutes ?? 0);
    form.setValue("halftimeFouls" as any, play.halftimeFouls ?? 0);
    form.setValue("opponentTeam" as any, play.opponent ?? "");
    form.setValue("currentPeriod" as any, 3);
    form.setValue("gameClock" as any, "12:00");
    skipAutoFillRef.current = true;
    setActiveTab("calculator");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const [mlbPopoverOpen, setMlbPopoverOpen] = useState(false);
  const [showMlbUpgradeModal, setShowMlbUpgradeModal] = useState(false);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const skipAutoFillRef = useRef(false);

  const calculateMutation = useCalculateProbability();

  const form = useForm<CalculateProbabilityRequest>({
    resolver: zodResolver(calculateProbabilitySchema),
    defaultValues: {
      halftimeMinutes: 0,
      halftimeFouls: 0,
      halftimeStat: 0,
      liveLine: 0,
      statType: "points",
      halftimeScore: "",
      gameId: "",
      currentPeriod: 3,
      gameClock: "12:00",
    },
  });

  // ── PWA install prompt ────────────────────────────────────────────────────
  useEffect(() => {
    if (pwaPromptDismissed) return;
    const handler = (e: Event) => {
      e.preventDefault();
      deferredInstallPromptRef.current = e;
      setShowInstallBanner(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    if (isIosPwa) setShowInstallBanner(true);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, [pwaPromptDismissed, isIosPwa]);

  const handleInstall = async () => {
    if (deferredInstallPromptRef.current) {
      deferredInstallPromptRef.current.prompt();
      const choice = await deferredInstallPromptRef.current.userChoice;
      if (choice.outcome === "accepted") {
        setShowInstallBanner(false);
        setPwaPromptDismissed(true);
        localStorage.setItem("ll_pwa_dismissed", "1");
      }
    }
  };

  const dismissInstallBanner = () => {
    setShowInstallBanner(false);
    setPwaPromptDismissed(true);
    localStorage.setItem("ll_pwa_dismissed", "1");
  };

  // ── Daily notification log reset ────────────────────────────────────────
  useEffect(() => {
    const today = new Date().toDateString();
    const lastLogDate = localStorage.getItem("lastLogDate");
    if (lastLogDate !== today) {
      setNotificationLog([]);
      localStorage.setItem("lastLogDate", today);
    }
  }, []);

  // ── Deep-link on mount: URL params from notification tap ─────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    const gameId = params.get("gameId");
    const cardType = params.get("cardType");
    if (tab === "ncaab" || tab === "calculator" || tab === "mlb" || tab === "analytics") setActiveTab(tab as any);
    if (gameId && cardType === "game") {
      setTimeout(() => setSelectedGameId(gameId), 400);
    }
    if (params.toString()) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Push notification subscription state ─────────────────────────────────
  useEffect(() => {
    if (!user) return;
    fetch("/api/user/alerts").then(r => r.json()).then(d => {
      if (d.hasSubscription) setPushSubscribed(true);
      if (d.phoneNumber) setPhoneInput(d.phoneNumber);
      if (d.smsAlerts) setSmsEnabled(true);
    }).catch(() => {});

    if ("serviceWorker" in navigator && "PushManager" in window) {
      navigator.serviceWorker.ready.then(reg => {
        reg.pushManager.getSubscription().then(sub => {
          if (sub) setPushSubscribed(true);
        });
      });
      const handleSwMessage = (e: MessageEvent) => {
        if (e.data?.type === "ALERT_RECEIVED") {
          const payload = e.data.payload;
          setAlertHistory(prev => {
            const updated = [{ title: payload.title, body: payload.body, time: Date.now() }, ...prev].slice(0, 10);
            try { localStorage.setItem("ll_alerts", JSON.stringify(updated)); } catch {}
            return updated;
          });
          const entry: NotificationLog = {
            id: `notif-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            timestamp: Date.now(),
            type: payload.cardType === "game" ? "game" : "prop",
            sport: payload.tab === "ncaab" ? "ncaab" : "nba",
            title: payload.title ?? "LiveLocks Alert",
            body: payload.body ?? "",
            confidence: payload.confidence ?? 0,
            gameId: payload.gameId ?? "",
            playerId: payload.playerId,
            market: payload.market,
            direction: payload.direction,
            line: payload.line,
            result: null,
          };
          setNotificationLog(prev => [entry, ...prev]);
        }
        if (e.data?.type === "NOTIFICATION_NAVIGATE") {
          const { tab, gameId, cardType } = e.data.data ?? {};
          if (tab === "ncaab" || tab === "calculator") setActiveTab(tab as any);
          setTimeout(() => {
            if (gameId && cardType === "game") setSelectedGameId(gameId);
          }, 300);
        }
      };
      navigator.serviceWorker.addEventListener("message", handleSwMessage);
      return () => navigator.serviceWorker.removeEventListener("message", handleSwMessage);
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleEnablePush = async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      toast({ title: "Push not supported", description: "Please use Chrome or Firefox on Android, or install the app on iOS 16.4+.", variant: "destructive" });
      return;
    }
    // Pre-check permission so a previously-denied user gets a clear message
    // instead of a silent pushManager.subscribe() failure.
    if (typeof Notification !== "undefined" && Notification.permission === "denied") {
      toast({ title: "Notifications are blocked", description: "Enable notifications for this site in your browser settings, then try again.", variant: "destructive" });
      return;
    }
    setPushLoading(true);
    try {
      const keyRes = await fetch("/api/vapid-public-key");
      if (!keyRes.ok) { toast({ title: "Push not configured yet", variant: "destructive" }); return; }
      const { publicKey } = await keyRes.json();
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await apiRequest("POST", "/api/user/alerts/push-subscription", { subscription: sub.toJSON() });
      setPushSubscribed(true);
      toast({ title: "Push alerts enabled!", description: "You'll be notified when plays hit ≥75% or 2H goes live." });
    } catch (err: any) {
      toast({ title: "Could not enable push", description: err.message, variant: "destructive" });
    } finally {
      setPushLoading(false);
    }
  };

  const handleDisablePush = async () => {
    setPushLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      await apiRequest("DELETE", "/api/user/alerts/push-subscription", {});
      setPushSubscribed(false);
      toast({ title: "Push alerts disabled" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setPushLoading(false);
    }
  };

  const settleNotificationLogs = (game: any) => {
    setNotificationLog(prev => prev.map(entry => {
      if (entry.gameId !== String(game.id ?? game.gameId)) return entry;
      if (entry.result !== null) return entry;
      if (entry.type === "game") {
        const total = (game.finalAwayScore ?? game.awayScore ?? 0) + (game.finalHomeScore ?? game.homeScore ?? 0);
        const push = entry.line !== undefined && total === entry.line;
        const hitOver = entry.line !== undefined && total > entry.line;
        const hitUnder = entry.line !== undefined && total < entry.line;
        let result: "HIT" | "MISS" | "PUSH" = "MISS";
        if (push) result = "PUSH";
        else if (entry.direction === "Over" && hitOver) result = "HIT";
        else if (entry.direction === "Under" && hitUnder) result = "HIT";
        return { ...entry, result, settledAt: Date.now() };
      }
      return entry;
    }));
  };

  const handleSaveSms = async () => {
    setSmsLoading(true);
    try {
      await apiRequest("POST", "/api/user/alerts/sms", { phoneNumber: phoneInput, smsAlerts: smsEnabled });
      toast({ title: "SMS settings saved!" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSmsLoading(false);
    }
  };

  // ── Injury data (polled every 5 min) ──────────────────────────────────────
  const { data: injuryData } = useQuery<InjuryPlayer[]>({
    queryKey: ["/api/injuries"],
    queryFn: async () => {
      const res = await fetch("/api/injuries");
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 4 * 60 * 1000,
  });

  const injuredPlayerNames = new Set(
    (injuryData ?? [])
      .filter(p => p.status === "Out" || p.status === "Questionable")
      .map(p => p.playerName.toLowerCase())
  );

  // ── Halftime plays ────────────────────────────────────────────────────────
  const [unlockedGameIds, setUnlockedGameIds] = useState<Set<string>>(new Set());
  const [unlocking2hGame, setUnlocking2hGame] = useState<string | null>(null);

  const { data: halftimePlaysData, isLoading: isHalftimePlaysLoading, refetch: refetchHalftimePlays } = useQuery<{
    plays: any[];
    message?: string;
    eligibleGames?: number;
    eligibleGameDetails?: Array<{
      gameId: string;
      homeTeamAbbr: string;
      awayTeamAbbr: string;
      homeFull: string;
      awayFull: string;
      homeScore: number;
      awayScore: number;
      halftimePhase?: "halftime" | "end_2q" | "early_3q" | "none";
      isEarly3QGrace?: boolean;
    }>;
    diagnostics?: Record<string, number>;
  }>({
    queryKey: ["/api/halftime-plays"],
    // Phase 9: halftime is a short window. Poll fast so eligibility flips
    // (end of Q2 → halftime → early Q3) propagate within seconds.
    refetchInterval: 15_000,
    staleTime: 5_000,
    // 2H NBA fix: always pull fresh from the server when the dashboard
    // (re)mounts. The global QueryClient default is `staleTime: Infinity`
    // and the per-query `staleTime: 5_000` only marks the cache stale —
    // it does not by itself force a fetch on remount when the cache is
    // still considered fresh. "always" guarantees the user sees a fresh
    // server-side computation on every dashboard load, not the last
    // cached snapshot from a previous session.
    refetchOnMount: "always",
    // Pull again when the browser/network reconnects (laptop wake, mobile
    // tab regaining focus from background) so a stale cache from before
    // the disconnect is replaced immediately.
    refetchOnReconnect: "always",
  });

  useEffect(() => {
    if (halftimePlaysData !== undefined) {
      const plays = halftimePlaysData.plays ?? [];
      const fetchedOver = plays.filter((p: any) => p.betDirection === "over").length;
      const fetchedUnder = plays.filter((p: any) => p.betDirection === "under").length;
      console.log("[HT_CLIENT_FETCHED]", { received: plays.length, over: fetchedOver, under: fetchedUnder });
      if (plays.length > 0) {
        fetch("/api/halftime-plays/verify-client", { credentials: "include",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientReceived: true,
            sourceCount: plays.length,
          }),
        }).catch(() => {/* fire-and-forget */});
      }
    }
  }, [halftimePlaysData]);

  const { data: liveSignalsData } = useQuery<{ signals: any[]; engineOutput: Record<number, Record<string, any>>; updatedAt?: number; generatedAt?: number; stale?: boolean; mode?: string }>({
    queryKey: ["/api/live-signals", selectedGameId],
    enabled: !!selectedGameId,
    refetchInterval: 20_000,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });

  // Freshness Integrity Fix #3.6 — when the server reports a stale or error
  // payload (transient ESPN/odds failure), do not render last-cycle signal
  // dots or engineOutput as if they were current. Empty arrays mean the UI
  // honestly shows "no live data" instead of a frozen prior frame.
  const nbaLiveSignalsStale = liveSignalsData?.stale === true;
  const safeLiveSignalsData = nbaLiveSignalsStale
    ? { ...(liveSignalsData ?? {}), signals: [], engineOutput: {} }
    : liveSignalsData;
  const safeEngineOutput = nbaLiveSignalsStale ? {} : (liveSignalsData?.engineOutput ?? {});

  const halftimeGameGroups = useMemo(() => {
    const plays = halftimePlaysData?.plays ?? [];
    const gameMap = new Map<string, {
      gameId: string; awayTeamAbbr: string; homeTeamAbbr: string;
      awayFull: string; homeFull: string; awayScore: number; homeScore: number; plays: any[];
    }>();
    for (const play of plays) {
      if (!gameMap.has(play.gameId)) {
        gameMap.set(play.gameId, {
          gameId: play.gameId,
          awayTeamAbbr: play.awayTeamAbbr ?? play.team,
          homeTeamAbbr: play.homeTeamAbbr ?? play.opponent,
          awayFull: play.awayFull ?? play.team,
          homeFull: play.homeFull ?? play.opponent,
          awayScore: play.awayScore ?? 0,
          homeScore: play.homeScore ?? 0,
          plays: [],
        });
      }
      gameMap.get(play.gameId)!.plays.push(play);
    }
    const groups = Array.from(gameMap.values());
    const stage1Plays = groups.flatMap(g => g.plays);
    console.log("[HT_STAGE_1_GROUP]", {
      input: plays.length,
      output: stage1Plays.length,
      games: groups.length,
      over: stage1Plays.filter(p => p.betDirection === "over").length,
      under: stage1Plays.filter(p => p.betDirection === "under").length,
    });
    return groups;
  }, [halftimePlaysData]);

  useEffect(() => {
    const sourcePlays = halftimePlaysData?.plays ?? [];
    const gameGroups = halftimeGameGroups;
    console.log("[QUICK_VIEW_SOURCE_AUDIT]", {
      inputCount: sourcePlays.length,
      renderedCount: gameGroups.reduce((sum, g) => sum + g.plays.length, 0),
      gameCount: gameGroups.length,
      hasMessage: !!(halftimePlaysData?.message),
      message: halftimePlaysData?.message ?? null,
    });
  }, [halftimePlaysData, halftimeGameGroups]);

  // ── 20-second auto-refresh for live box score ──────────────────────────────
  // NBA possessions land every ~20-25s, so a 2-min cadence made the quick view
  // feel frozen between updates. Tightened to 20s for stats/signals to match
  // the live-signals tier elsewhere in this file. Halftime plays still only
  // re-pull when the halftime sub-tab is open (every ~60s) so we don't hammer
  // a heavier endpoint.
  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    if (selectedGameId) {
      let halftimeTick = 0;
      autoRefreshRef.current = setInterval(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/live-stats", selectedGameId] });
        queryClient.invalidateQueries({ queryKey: ["/api/live-signals", selectedGameId] });
        setLastRefreshed(new Date());
        halftimeTick++;
        if (halftimeTick >= 3 && activeTab === "calculator" && nbaSubTab === "halftime") {
          refetchHalftimePlays();
          halftimeTick = 0;
        }
        // Freshness Integrity Fix #3.2 — tightened from 20s → 15s so the
        // dashboard tick aligns with useLiveStats' own 15s refetch (Fix #3.1)
        // and the server's 15s freshness contract for live signals.
      }, 15 * 1000);
    }
    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
  }, [selectedGameId, activeTab]);

  // ── Auto-refresh halftime plays when sub-tab is opened ─────────────────────
  useEffect(() => {
    if (activeTab === "calculator" && nbaSubTab === "halftime") {
      refetchHalftimePlays();
    }
  }, [activeTab, nbaSubTab]);

  useEffect(() => {
    if (activeTab === "calculator" && nbaSubTab === "halftime" && selectedGameId) {
      queryClient.invalidateQueries({ queryKey: ["/api/halftime-plays"] });
      refetchHalftimePlays();
    }
  }, [activeTab, nbaSubTab, selectedGameId]);

  // ── Mobile breakpoint detection ────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => {
      setIsMobile(window.innerWidth < 1024);
      setIsSmallScreen(window.innerWidth < 768);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ── Sync refs for halftime transition logic ────────────────────────────────
  useEffect(() => { visibleHalftimeGroupsRef.current = visibleHalftimeGroups; }, [visibleHalftimeGroups]);

  // Post quickViewRendered verification when groups are rendered — satisfies server success gate condition 6
  useEffect(() => {
    if (visibleHalftimeGroups.length > 0) {
      const plays = halftimePlaysData?.plays ?? [];
      const renderedPlays = visibleHalftimeGroups.flatMap(g => g.plays);
      const renderedOver = renderedPlays.filter((p: any) => p.betDirection === "over").length;
      const renderedUnder = renderedPlays.filter((p: any) => p.betDirection === "under").length;
      console.log("[HT_CLIENT_RENDERED]", {
        games: visibleHalftimeGroups.length,
        totalPlays: renderedPlays.length,
        over: renderedOver,
        under: renderedUnder,
      });
      fetch("/api/halftime-plays/verify-client", { credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientReceived: plays.length > 0,
          quickViewRendered: true,
          sourceCount: plays.length,
          renderedCount: visibleHalftimeGroups.length,
        }),
      }).catch(() => {/* fire-and-forget */});
    }
  }, [visibleHalftimeGroups.length]);

  // ── Sync visibleHalftimeGroups from API data (add new, keep exiting) ───────
  useEffect(() => {
    setVisibleHalftimeGroups(prev => {
      const newMap = new Map(halftimeGameGroups.map(g => [g.gameId, g]));
      const exitingToKeep = prev.filter(g => exitingGamesRef.current[g.gameId] && !newMap.has(g.gameId));
      return [...halftimeGameGroups, ...exitingToKeep];
    });
  }, [halftimeGameGroups]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Page decrement guard when current page empties after card removal ──────
  useEffect(() => {
    const total = Math.max(1, Math.ceil(visibleHalftimeGroups.length / 4));
    setCurrentHalftimePage(prev => (prev > total ? total : prev));
  }, [visibleHalftimeGroups.length]);

  // ── Trigger halftime exit animation + cleanup ──────────────────────────────
  const triggerHalftimeExit = (gameId: string, awayAbbr: string, homeAbbr: string) => {
    exitingGamesRef.current = { ...exitingGamesRef.current, [gameId]: true };
    setExitingGames(prev => ({ ...prev, [gameId]: true }));
    if (selectedGameId !== gameId) {
      setHalfTransitionToast({ away: awayAbbr, home: homeAbbr });
      setTimeout(() => setHalfTransitionToast(null), 3000);
    }
    setTimeout(() => {
      setVisibleHalftimeGroups(prev => prev.filter(g => g.gameId !== gameId));
      delete exitingGamesRef.current[gameId];
      setExitingGames(prev => { const next = { ...prev }; delete next[gameId]; return next; });
      setHalftimeCountPulse(true);
      setTimeout(() => setHalftimeCountPulse(false), 350);
    }, 2500);
  };

  // ── Check for halftime → 2H live transitions on every liveGames refresh ───
  useEffect(() => {
    if (!liveGames) { prevLiveGamesRef.current = []; return; }
    const prevById = new Map(prevLiveGamesRef.current.map((g: any) => [g.id, g]));
    for (const group of visibleHalftimeGroupsRef.current) {
      if (exitingGamesRef.current[group.gameId]) continue;
      const curr = liveGames.find((g: any) => g.id === group.gameId);
      const prev = prevById.get(group.gameId);
      const isNow2H = curr?.period === 3 && (curr?.status === "In Progress" || curr?.status === "in_progress");
      const wasHalftime = !prev || prev.period <= 2 || prev.status === "Halftime" || prev.status === "Half Time";
      if (isNow2H && wasHalftime) {
        triggerHalftimeExit(group.gameId, group.awayTeamAbbr, group.homeTeamAbbr);
      }
    }
    prevLiveGamesRef.current = liveGames;
  }, [liveGames]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Play limit gating ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!calculateMutation.error) return;
    if (calculateMutation.error instanceof PlayLimitError) {
      setUpgradeModalState({ playsUsed: calculateMutation.error.playsUsed, limit: calculateMutation.error.limit });
      setShowUpgradeModal(true);
    } else if (calculateMutation.error.message?.toLowerCase().includes("verify your email")) {
      toast({
        title: "Email not verified",
        description: "Check your inbox and click the verification link to unlock your plays.",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Calculation failed",
        description: calculateMutation.error.message || "Something went wrong. Check your inputs and try again.",
        variant: "destructive",
      });
    }
  }, [calculateMutation.error]);

  useEffect(() => {
    if (!user || user.isAdmin || user.subscriptionTier) return;
    if ((user.playsUsedToday ?? 0) >= 3) {
      setUpgradeModalState({ playsUsed: user.playsUsedToday ?? 3, limit: 3 });
      setShowUpgradeModal(true);
    }
  }, [user?.playsUsedToday]);

  const handleUpgradeClick = () => { setShowUpgradeModal(true); };

  // ── Handle Stripe redirect back to app ────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    const tier = params.get("tier");
    const sessionId = params.get("session_id");
    if (payment === "success" && tier) {
      window.history.replaceState({}, "", "/dashboard");

      const applyTierUpdate = (data: any) => {
        const confirmedTier = data.subscriptionTier ?? null;
        if (confirmedTier) {
          setLocalTier(confirmedTier);
        }
        const currentUser = queryClient.getQueryData<any>(["/api/auth/me"]);
        if (currentUser && data.hasNBA !== undefined) {
          queryClient.setQueryData(["/api/auth/me"], {
            ...currentUser,
            ...(confirmedTier ? { subscriptionTier: confirmedTier } : {}),
            hasNBA: data.hasNBA,
            hasNCAAB: data.hasNCAAB,
            hasMLB: data.hasMLB,
            hasUnlimited: data.hasUnlimited,
          });
        }
        queryClient.refetchQueries({ queryKey: ["/api/auth/me"] });
        return !!confirmedTier;
      };

      const tryCheckoutComplete = async (attempt: number): Promise<boolean> => {
        try {
          const res = await apiRequest("POST", "/api/stripe/checkout-complete", { tier, sessionId });
          const data = await res.json().catch(() => ({}));
          return applyTierUpdate(data);
        } catch {
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 2000 * attempt));
            return tryCheckoutComplete(attempt + 1);
          }
          return false;
        }
      };

      tryCheckoutComplete(1).then(async (success) => {
        if (success) {
          toast({
            title: "You're all set 🎉",
            description: "Payment received — your upgraded access is now unlocked.",
          });
          return;
        }
        {
          let recovered = false;
          for (let poll = 0; poll < 5; poll++) {
            await new Promise(r => setTimeout(r, 3000));
            try {
              const token = getAuthToken();
              const headers: Record<string, string> = {};
              if (token) headers["Authorization"] = `Bearer ${token}`;
              const meRes = await fetch("/api/me", { credentials: "include", headers });
              if (meRes.ok) {
                const fresh = await meRes.json();
                if (fresh.subscriptionTier) {
                  setLocalTier(fresh.subscriptionTier);
                  queryClient.refetchQueries({ queryKey: ["/api/auth/me"] });
                  recovered = true;
                  break;
                }
              }
            } catch { /* continue polling */ }
          }
          if (recovered) {
            toast({
              title: "You're all set 🎉",
              description: "Payment received — your upgraded access is now unlocked.",
            });
          } else {
            toast({
              title: "Subscription activation delayed",
              description: "Your payment was received. Please refresh the page in a minute to see your upgraded access.",
              variant: "default",
            });
          }
        }
      });
    } else if (payment === "cancelled") {
      window.history.replaceState({}, "", "/dashboard");
      toast({
        title: "Checkout cancelled",
        description: "No charge was made — your current access is unchanged.",
        variant: "default",
      });
    }
  }, []);

  // ── /api/me: fresh DB tier — runs on mount + window focus + every 60s ──────
  useEffect(() => {
    const fetchFreshUser = async () => {
      try {
        const token = getAuthToken();
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch("/api/me", { credentials: "include", headers });
        if (!res.ok) return;
        const fresh = await res.json();
        setLocalTier(fresh.subscriptionTier ?? null);
        if (fresh.requiresRefresh || fresh.hasNBA !== undefined) {
          const currentUser = queryClient.getQueryData<any>(["/api/auth/me"]);
          if (currentUser && fresh.hasNBA !== undefined) {
            queryClient.setQueryData(["/api/auth/me"], {
              ...currentUser,
              subscriptionTier: fresh.subscriptionTier ?? currentUser.subscriptionTier,
              hasNBA: fresh.hasNBA,
              hasNCAAB: fresh.hasNCAAB,
              hasMLB: fresh.hasMLB,
              hasUnlimited: fresh.hasUnlimited,
            });
          }
          if (fresh.requiresRefresh) {
            queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
          }
        }
      } catch (_) {}
    };
    fetchFreshUser();
    window.addEventListener("focus", fetchFreshUser);
    const interval = setInterval(fetchFreshUser, 60_000);
    return () => {
      window.removeEventListener("focus", fetchFreshUser);
      clearInterval(interval);
    };
  }, []);

  const { pullDistance, isRefreshing: isPullRefreshing } = usePullRefresh({
    onRefresh: async () => {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      try {
        const res = await fetch("/api/me", { credentials: "include", headers });
        if (res.ok) {
          const fresh = await res.json();
          setLocalTier(fresh.subscriptionTier ?? null);
          const currentUser = queryClient.getQueryData<any>(["/api/auth/me"]);
          if (currentUser) {
            queryClient.setQueryData(["/api/auth/me"], {
              ...currentUser,
              subscriptionTier: fresh.subscriptionTier ?? currentUser.subscriptionTier,
              hasNBA: fresh.hasNBA,
              hasNCAAB: fresh.hasNCAAB,
              hasMLB: fresh.hasMLB,
              hasUnlimited: fresh.hasUnlimited,
            });
          }
        }
      } catch {}
      await queryClient.invalidateQueries();
    },
  });

  // ── Welcome banner + NEW badge system ────────────────────────────────────
  const { data: ncaabGamesRaw } = useQuery<{ games: Array<{ id: string; status: string; startTime?: string }> }>({
    queryKey: ["/api/ncaab/games"],
    refetchInterval: 60_000,
    enabled: hasNcaabAccess,
  });
  const ncaabGames = ncaabGamesRaw?.games ?? [];

  useEffect(() => {
    if (user?.isNewProUser) setShowWelcomeBanner(true);
  }, [user?.isNewProUser]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const showNewBadge = user?.upgradedAt
    ? (now - new Date(user.upgradedAt).getTime()) < 86_400_000
    : false;

  const dismissWelcomeBanner = () => {
    setShowWelcomeBanner(false);
    apiRequest("POST", "/api/user/clear-new-pro-flag", {}).catch(() => {});
    queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
  };

  const handleExplore = async () => {
    setActiveTab("ncaab");
    await new Promise(r => setTimeout(r, 150));
    const targetGame =
      ncaabGames.find(g => g.status === "In Progress") ??
      ncaabGames.find(g => g.status === "Halftime") ??
      [...ncaabGames]
        .filter(g => g.startTime)
        .sort((a, b) => new Date(a.startTime!).getTime() - new Date(b.startTime!).getTime())[0];
    if (targetGame) {
      setExpandToGameId(targetGame.id);
    }
    dismissWelcomeBanner();
  };

  const ncaabSubtitle = (() => {
    const live = ncaabGames.filter(g => g.status === "In Progress").length;
    const halftime = ncaabGames.filter(g => g.status === "Halftime").length;
    // Top play is always visible when games are live — strong edge or labeled fallback lean
    if (live > 0) return { text: `${live} game${live === 1 ? "" : "s"} live — top play always on`, color: "hsl(var(--brand-accent))" };
    if (halftime > 0) return { text: "Games at halftime — 2H edges ready", color: "#f59e0b" };
    return { text: "NCAAB Live + full access now active", color: "#a1a1aa" };
  })();

  // ── Auto-fill score, period, and clock on every live-games refresh ─────────
  useEffect(() => {
    if (!selectedGameId || !liveGames) return;
    const game = liveGames.find(g => g.id === selectedGameId);
    if (!game) return;
    const isLive = game.status !== "Scheduled" && game.status !== "Pre-Game" && game.status !== "Final";
    if (isLive && game.period >= 1 && game.period <= 4) {
      form.setValue("currentPeriod", game.period);
      form.setValue("gameClock", game.clock || "12:00");
      form.setValue("halftimeScore", `${game.awayScore}-${game.homeScore}`);
    }
  }, [liveGames, selectedGameId]);

  // ── Settle notification logs when games go Final ─────────────────────────
  useEffect(() => {
    if (!liveGames || notificationLog.length === 0) return;
    for (const game of liveGames) {
      if (game.status === "Final") {
        settleNotificationLogs(game);
      }
    }
  }, [liveGames]); // eslint-disable-line react-hooks/exhaustive-deps

  const watchedPlayerId = form.watch("playerId");
  const watchedStatType = form.watch("statType");

  // Get selected player info
  const selectedPlayer = players?.find((p) => p.id === Number(watchedPlayerId));

  // Live stats for selected game
  const { data: liveStats, refetch: refetchLiveStats, isLoading: isLiveStatsLoading } = useLiveStats(selectedGameId);

  // Auto-select an NBA live game so the Live Box Score panel always fires
  // when there's an in-progress game on screen. Two cases handled:
  //   1) No selection + at least one live game → pick the first In-Progress
  //      game so the panel renders without requiring a manual tile click.
  //   2) Current selection is no longer In-Progress (game finalized or no
  //      longer in the live list) → drop the stale selection so the panel
  //      can either auto-pick a different live game or hide cleanly.
  // Scoped to NBA tab (`activeTab === "calculator"`) so MLB/NCAAB tabs are
  // not affected.
  useEffect(() => {
    if (activeTab !== "calculator") return;
    const games = liveGames ?? [];
    const isLiveStatus = (g: { status: string }) =>
      g.status !== "Scheduled" && g.status !== "Pre-Game" && g.status !== "Final";

    // Case 2: prune stale selection — runs even when liveGames is empty
    // (e.g. last live game just finalized and dropped off the list).
    if (selectedGameId) {
      const cur = games.find((g) => g.id === selectedGameId);
      if (!cur || !isLiveStatus(cur)) {
        setSelectedGameId(undefined);
        setSelectedGameTeams(undefined);
        return;
      }
      return;
    }

    if (games.length === 0) return;

    // Case 1: auto-pick the first In-Progress game
    const firstLive = games.find(isLiveStatus);
    if (!firstLive) return;
    setSelectedGameId(firstLive.id);
    setSelectedGameTeams({
      home: firstLive.homeTeam,
      away: firstLive.awayTeam,
      homeAbbr: firstLive.homeTeamAbbr,
      awayAbbr: firstLive.awayTeamAbbr,
    });
    form.setValue("gameId", firstLive.id);
    if (firstLive.period >= 2) {
      form.setValue("halftimeScore", `${firstLive.awayScore}-${firstLive.homeScore}`);
    }
    console.log(`[nba-live] Auto-selected live game ${firstLive.id} (${firstLive.awayTeamAbbr}@${firstLive.homeTeamAbbr}) — Q${firstLive.period} ${firstLive.clock}`);
  }, [activeTab, liveGames, selectedGameId]);

  // Find a DB player by ESPN display name — uses first-initial + last-name matching
  const findPlayerByName = (espnName: string) => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
    const stripSuffix = (parts: string[]): string[] => {
      while (parts.length > 1 && SUFFIXES.has(norm(parts[parts.length - 1]))) {
        parts = parts.slice(0, -1);
      }
      return parts;
    };
    const normedEspn = norm(espnName);
    return (players ?? []).find((p) => {
      if (norm(p.name) === normedEspn) return true;
      const espnParts = stripSuffix(espnName.toLowerCase().split(" "));
      const dbParts = stripSuffix(p.name.toLowerCase().split(" "));
      const espnLast = espnParts[espnParts.length - 1];
      const dbLast = dbParts[dbParts.length - 1];
      return espnLast === dbLast && espnParts[0][0] === dbParts[0][0];
    });
  };

  // Direct fill from box score row — uses stat.playerId (numeric DB ID) directly; falls back to name match
  const handleBoxScoreClick = (stat: import("@shared/schema").LivePlayerStat) => {
    if (stat.playerId != null) {
      form.setValue("playerId" as any, String(stat.playerId));
    } else {
      const matched = findPlayerByName(stat.playerName);
      if (matched) {
        form.setValue("playerId" as any, String(matched.id));
      } else {
        toast({
          title: `${stat.playerName} not in database`,
          description: "Click 'Sync Rosters' to add all active players, then try again.",
          variant: "destructive",
        });
      }
    }

    const minParts = stat.minutes.split(":");
    const minutesDecimal = minParts.length === 2
      ? parseInt(minParts[0]) + parseInt(minParts[1]) / 60
      : parseFloat(stat.minutes) || 0;
    form.setValue("halftimeMinutes", Math.round(minutesDecimal * 10) / 10);
    form.setValue("halftimeFouls", stat.fouls);

    const st = form.getValues("statType");
    let statVal = 0;
    if (st === "points") statVal = stat.points;
    else if (st === "rebounds") statVal = stat.rebounds;
    else if (st === "assists") statVal = stat.assists;
    else if (st === "steals") statVal = stat.steals;
    else if (st === "blocks") statVal = stat.blocks;
    else if (st === "threes") statVal = stat.threes ?? 0;
    else if (st === "pts_reb_ast") statVal = stat.points + stat.rebounds + stat.assists;
    else if (st === "pts_reb") statVal = stat.points + stat.rebounds;
    else if (st === "pts_ast") statVal = stat.points + stat.assists;
    else if (st === "reb_ast") statVal = stat.rebounds + stat.assists;
    else if (st === "stl_blk") statVal = stat.steals + stat.blocks;
    form.setValue("halftimeStat", statVal);

    // Set the live game's current period and clock so the projection is accurate
    // regardless of whether it's Q1, Q2, halftime, Q3, or Q4
    if (selectedGameId && liveGames) {
      const game = liveGames.find(g => g.id === selectedGameId);
      if (game && game.period >= 1 && game.period <= 4) {
        form.setValue("currentPeriod", game.period);
        form.setValue("gameClock", game.clock || "12:00");
      }
    }

    // Wire live shooting efficiency to calculator
    form.setValue("liveFgm" as any, stat.fgm ?? 0);
    form.setValue("liveFga" as any, stat.fga ?? 0);
    form.setValue("liveFtm" as any, stat.ftm ?? 0);
    form.setValue("liveFta" as any, stat.fta ?? 0);
    form.setValue("liveFg3m" as any, stat.fg3m ?? 0);
    form.setValue("liveFg3a" as any, stat.fg3a ?? 0);

    setAutoFilledFields(new Set(["halftimeMinutes", "halftimeFouls", "halftimeStat"]));
  };

  // Determine opponent team: prefer game tile selection, fall back to form field
  const watchedOpponent = form.watch("opponentTeam");
  const isSelectedGameLive = selectedGameId
    ? (liveGames ?? []).some(g => g.id === selectedGameId && g.status !== "Scheduled" && g.status !== "Final")
    : false;

  // Live odds — works with or without a game tile selected.
  // Uses player's DB team + manually selected opponent abbreviations.
  const { data: oddsData, isLoading: isOddsLoading, dataUpdatedAt: oddsUpdatedAt } = usePlayerOdds(
    selectedPlayer?.team,
    watchedOpponent || undefined,
    selectedPlayer?.name,
    watchedStatType,
    isSelectedGameLive
  );

  // Game-level spread + total — auto-fetched from The Odds API when player + opponent known
  const { data: gameLines } = useGameLines(
    selectedPlayer?.team,
    watchedOpponent || undefined
  );

  // Clear auto-fill badges when player changes manually
  useEffect(() => {
    setAutoFilledFields(new Set());
  }, [watchedPlayerId]);

  useEffect(() => {
    if (!selectedGameTeams || !watchedPlayerId) return;
    const player = (players ?? []).find(p => String(p.id) === String(watchedPlayerId));
    if (!player) return;
    const playerTeamDb = player.team.toUpperCase();
    const homeDb = espnToDb(selectedGameTeams.homeAbbr);
    const awayDb = espnToDb(selectedGameTeams.awayAbbr);
    if (playerTeamDb === homeDb) {
      form.setValue("opponentTeam", awayDb);
    } else if (playerTeamDb === awayDb) {
      form.setValue("opponentTeam", homeDb);
    }
  }, [watchedPlayerId, selectedGameId]);

  // Auto-fill halftime stats from live box score when player or stat type changes
  useEffect(() => {
    if (skipAutoFillRef.current) { skipAutoFillRef.current = false; return; }
    if (!liveStats || !selectedPlayer) return;
    const norm2 = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    const SFXS = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
    const strip = (parts: string[]): string[] => {
      while (parts.length > 1 && SFXS.has(norm2(parts[parts.length - 1]))) parts = parts.slice(0, -1);
      return parts;
    };
    const playerStat = liveStats.find((s) => {
      if (norm2(s.playerName) === norm2(selectedPlayer.name)) return true;
      const espnParts = strip(s.playerName.toLowerCase().split(" "));
      const dbParts = strip(selectedPlayer.name.toLowerCase().split(" "));
      return (
        espnParts[espnParts.length - 1] === dbParts[dbParts.length - 1] &&
        espnParts[0]?.[0] === dbParts[0]?.[0]
      );
    });
    if (!playerStat) return;

    const minParts = playerStat.minutes.split(":");
    const minutesDecimal = minParts.length === 2
      ? parseInt(minParts[0]) + parseInt(minParts[1]) / 60
      : parseFloat(playerStat.minutes) || 0;

    form.setValue("halftimeMinutes", Math.round(minutesDecimal * 10) / 10);
    form.setValue("halftimeFouls", playerStat.fouls);

    const st = watchedStatType;
    let statVal = 0;
    if (st === "points") statVal = playerStat.points;
    else if (st === "rebounds") statVal = playerStat.rebounds;
    else if (st === "assists") statVal = playerStat.assists;
    else if (st === "steals") statVal = playerStat.steals;
    else if (st === "blocks") statVal = playerStat.blocks;
    else if (st === "threes") statVal = playerStat.threes ?? 0;
    else if (st === "pts_reb_ast") statVal = playerStat.points + playerStat.rebounds + playerStat.assists;
    else if (st === "pts_reb") statVal = playerStat.points + playerStat.rebounds;
    else if (st === "pts_ast") statVal = playerStat.points + playerStat.assists;
    else if (st === "reb_ast") statVal = playerStat.rebounds + playerStat.assists;
    else if (st === "stl_blk") statVal = playerStat.steals + playerStat.blocks;
    form.setValue("halftimeStat", statVal);

    // Wire live shooting efficiency
    form.setValue("liveFgm" as any, playerStat.fgm ?? 0);
    form.setValue("liveFga" as any, playerStat.fga ?? 0);
    form.setValue("liveFtm" as any, playerStat.ftm ?? 0);
    form.setValue("liveFta" as any, playerStat.fta ?? 0);
    form.setValue("liveFg3m" as any, playerStat.fg3m ?? 0);
    form.setValue("liveFg3a" as any, playerStat.fg3a ?? 0);

    setAutoFilledFields(new Set(["halftimeMinutes", "halftimeFouls", "halftimeStat"]));
  }, [liveStats, selectedPlayer, watchedStatType]);

  const onSubmit = (data: CalculateProbabilityRequest) => {
    if (!data.playerId || data.playerId === 0) {
      toast({ title: "Select a player", description: "Please choose a player before calculating.", variant: "destructive" });
      return;
    }
    if (!data.opponentTeam) {
      toast({ title: "Select an opponent", description: "Please choose an opponent team.", variant: "destructive" });
      return;
    }
    calculateMutation.mutate({
      ...data,
      gameId: selectedGameId,
      gameSpread: gameLines?.spread ?? undefined,
      gameTotalLine: gameLines?.total ?? undefined,
    });
  };

  const handleAddToParlay = (direction: "over" | "under") => {
    if (!calculateMutation.data || !selectedPlayer) return;
    const result = calculateMutation.data;
    const formVals = form.getValues();
    const odds = oddsData && selectedSportsbook !== "manual"
      ? oddsData[selectedSportsbook]
      : null;

    const overProb = result.probability;
    const probability = direction === "over" ? overProb : Math.round((100 - overProb) * 10) / 10;
    const oddsAmerican = direction === "over"
      ? (odds?.overOdds ?? 0)
      : (odds?.underOdds ?? 0);

    const pick: ParlayPickInput = {
      playerId: selectedPlayer.id,
      playerName: selectedPlayer.name,
      playerTeam: selectedPlayer.team,
      statType: formVals.statType,
      line: formVals.liveLine,
      probability,
      betDirection: direction,
      sportsbook: selectedSportsbook !== "manual" ? selectedSportsbook : "",
      oddsAmerican,
      gameId: selectedGameId,
    };

    if (parlayPicks.length < 10) {
      setParlayPicks((prev) => [...prev, pick]);
      setShowParlay(true);
    }
  };

  // Shared sport-tab navigation used by TopPlaysPanel and the View Details
  // dialog. Pure UI navigation; no engine/persistence side effects.
  const handleNavigateToSport = (sport: string) => {
    if (sport === "nba") setActiveTab("calculator");
    else if (sport === "ncaab") {
      if (!hasNcaabAccess) {
        setUpgradeModalState({ playsUsed: user?.playsUsedToday ?? 0, limit: 3 });
        setShowUpgradeModal(true);
        return;
      }
      setActiveTab("ncaab");
    } else if (sport === "mlb") {
      setActiveTab("calculator");
    }
  };

  // Shared add-to-slip used by TopPlaysPanel cards and the View Details
  // dialog. Reuses the existing parlay slip state — no new slip backend.
  const handleTopPlayAddToSlip = (play: UnifiedTopPlay) => {
    if (parlayPicks.length >= 10) return;
    const parsedPlayerId = typeof play.playerId === "number" ? play.playerId : Number(play.playerId);
    if (!play.market || !play.side) {
      console.warn("[NBA_CLICK_FLOW] Skipping add-to-slip — missing market or side", { player: play.playerOrTeam });
      return;
    }
    const parsedLine = typeof play.line === "number" ? play.line : parseFloat(String(play.line ?? ""));
    if (!Number.isFinite(parsedLine)) {
      console.warn("[NBA_CLICK_FLOW] Skipping add-to-slip — invalid line", { player: play.playerOrTeam, line: play.line });
      return;
    }
    const normalizedSide = play.betDirection?.toLowerCase() ?? play.side?.toLowerCase() ?? "";
    const betDirection: "over" | "under" = normalizedSide.includes("under") ? "under" : "over";
    console.log("[NBA_CLICK_FLOW] TopPlays add-to-slip", { sport: play.sport, player: play.playerOrTeam, market: play.market, side: betDirection });
    const pick: ParlayPickInput = {
      playerId: Number.isFinite(parsedPlayerId) ? parsedPlayerId : 0,
      playerName: play.playerOrTeam,
      playerTeam: play.team ?? "",
      statType: play.market,
      line: parsedLine,
      probability: play.probability,
      betDirection,
      sportsbook: play.sportsbook ?? "",
      oddsAmerican: -110,
      gameId: play.gameId,
      confidenceTier: play.confidenceTier,
    };
    setParlayPicks((prev) => [...prev, pick]);
    setShowParlay(true);
  };

  // Detect whether a top-play is already on the slip (presentation-only).
  const isPlayOnSlip = (play: UnifiedTopPlay | null): boolean => {
    if (!play || !play.market) return false;
    const parsedLine = typeof play.line === "number" ? play.line : parseFloat(String(play.line ?? ""));
    if (!Number.isFinite(parsedLine)) return false;
    const normalizedSide = play.betDirection?.toLowerCase() ?? play.side?.toLowerCase() ?? "";
    const betDirection: "over" | "under" = normalizedSide.includes("under") ? "under" : "over";
    return parlayPicks.some(
      (p) =>
        p.playerName === play.playerOrTeam &&
        p.statType === play.market &&
        p.line === parsedLine &&
        p.betDirection === betDirection,
    );
  };

  // When a game is selected, filter players to only those two teams
  const filteredPlayers = selectedGameId && selectedGameTeams
    ? (players ?? []).filter(p => {
        const homeDb = espnToDb(selectedGameTeams.homeAbbr);
        const awayDb = espnToDb(selectedGameTeams.awayAbbr);
        return p.team === homeDb || p.team === awayDb;
      })
    : (players ?? []);

  const playersByTeam = filteredPlayers.reduce<Record<string, typeof players>>((acc, p) => {
    if (!acc[p.team]) acc[p.team] = [];
    acc[p.team]!.push(p);
    return acc;
  }, {});
  const sortedTeamKeys = Object.keys(playersByTeam).sort();

  const isLoading = isPlayersLoading || isTeamsLoading;
  const result = calculateMutation.data;

  const tweetTemplateIndexRef = useRef<number | null>(null);
  const lastResultRef = useRef<typeof result | null>(null);
  const [tweetSnippet, setTweetSnippet] = useState("");

  useEffect(() => {
    if (!result || result === lastResultRef.current) return;
    lastResultRef.current = result;
    const rawCounter = parseInt(localStorage.getItem(TWEET_COUNTER_KEY) ?? "0", 10);
    const counter = Number.isFinite(rawCounter) ? rawCounter : 0;
    tweetTemplateIndexRef.current = counter % 3;
    localStorage.setItem(TWEET_COUNTER_KEY, String(counter + 1));

    const id = form.getValues("playerId");
    const playerObj = (players ?? []).find(pl => pl.id === Number(id));
    const playerName = playerObj?.name ?? "Player";
    const rawStatType = form.getValues("statType");
    const statLabel = STAT_TYPES.find(s => s.value === rawStatType)?.label ?? rawStatType;
    const line = form.getValues("liveLine");
    const prob = result.probability;
    const isOver = prob >= 50;
    const direction = isOver ? "Over" : "Under";
    const directionProb = isOver ? prob.toFixed(0) : (100 - prob).toFixed(0);
    const projection = result.expectedTotal.toFixed(1);
    const atHalftime = !!form.getValues("halftimeScore");
    const gap = Math.abs(parseFloat(String(line)) - parseFloat(projection)).toFixed(1);
    const teamCashtag = playerObj?.team ? `$${playerObj.team}` : "";
    const oppCashtag = form.getValues("opponentTeam") ? `$${form.getValues("opponentTeam")}` : "";
    setTweetSnippet(buildTweetSnippet({ playerName, direction, line, statLabel, directionProb, projection, gap, atHalftime, teamCashtag, oppCashtag, templateIndex: tweetTemplateIndexRef.current }));
  }, [result]);

  const nbaActiveGames = (liveGames ?? []).filter(
    (g) => g.status !== "Scheduled" && g.status !== "Final"
  );
  const allGames = liveGames ?? [];

  const hasLiveNba = nbaActiveGames.some((g) => g.status === "In Progress" || g.status === "Halftime" || g.status === "End of Period");

  const { data: mlbGamesData } = useQuery<{ games: { status: string }[] }>({
    queryKey: ["/api/mlb/live-games"],
    refetchInterval: 60_000,
  });
  const mlbLiveGames = (mlbGamesData?.games ?? []).filter((g: any) => g.status === "live");
  const hasLiveMlb = mlbLiveGames.length > 0;
  // Sport-aware header counter: show MLB live games on MLB tab, NBA active games elsewhere.
  const activeGames = activeTab === "mlb" ? mlbLiveGames : nbaActiveGames;

  // Task #134 — Record a single FreeActivationRail impression per mount
  // when a free user first sees the rail. Ref-guarded so re-renders don't
  // spam the analytics endpoint. MUST be declared before any early return
  // to keep React's hook order stable across the loading→loaded transition.
  // Eligibility mirrors the actual rail render condition below
  // (`!user.isAdmin && !hasProAccess(effectiveTier)`) so impressions are
  // only attributed when the rail truly shows.
  const railImpressionIsFreeUser = !!user && !user.isAdmin && !hasProAccess(effectiveTier);
  const railImpressionPlaysUsed = user?.playsUsedToday ?? 0;
  const railImpressionFiredRef = useRef(false);
  useEffect(() => {
    if (!railImpressionIsFreeUser) return;
    if (railImpressionFiredRef.current) return;
    railImpressionFiredRef.current = true;
    const playsLimit = 3;
    const exhausted = railImpressionPlaysUsed >= playsLimit;
    void trackRailEvent({
      eventType: "impression",
      exhausted,
      playsUsedToday: railImpressionPlaysUsed,
      playsLimit,
    });
  }, [railImpressionIsFreeUser, railImpressionPlaysUsed]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-12 h-12 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const isFreeUser = !!user && !user.isAdmin && !user.subscriptionTier;
  const playsUsed = user?.playsUsedToday ?? 0;
  const visibleEdgeLimit = 2;

  // Derived from the flat halftime plays array for the upgrade modal locked-edge preview.
  // visibleEdgeLimit (2) applies per game but we use the full plays list here as a proxy
  // for the total locked count, so the modal copy reflects the real slate breadth.
  const slateAllPlays = halftimePlaysData?.plays ?? [];
  const slateLockedEdgesCount = isFreeUser ? Math.max(0, slateAllPlays.length - visibleEdgeLimit) : 0;
  const slateTopLockedEdge = isFreeUser ? slateAllPlays[visibleEdgeLimit] : undefined;

  const filterPlay = (play: any) => {
    if (slateFilterProp === "combo" && !play.statType.includes("_")) return false;
    if (slateFilterProp !== "all" && slateFilterProp !== "combo" && play.statType !== slateFilterProp) return false;
    const dp = play.probability;
    if (slateFilterProb === "elite" && dp < 85) return false;
    if (slateFilterProb === "strong" && (dp < 70 || dp >= 85)) return false;
    if (slateFilterProb === "value" && (dp < 60 || dp >= 70)) return false;
    return true;
  };

  const BOOK_OPTIONS = [
    { key: "all", abbr: "All", label: "All Books" },
    { key: "dk",  abbr: "DK",  label: "DraftKings" },
    { key: "fd",  abbr: "FD",  label: "FanDuel" },
    { key: "hr",  abbr: "HR",  label: "Hard Rock" },
    { key: "pp",  abbr: "PP",  label: "PrizePicks" },
    { key: "ud",  abbr: "UD",  label: "Underdog" },
    { key: "fan", abbr: "FAN", label: "Fanatics" },
  ] as const;

  const bookKeyMap: Record<string, string[]> = {
    dk:  ["draftkings", "draft_kings", "dk"],
    fd:  ["fanduel", "fan_duel", "fd"],
    hr:  ["hardrockbet", "hard_rock", "hardrock"],
    pp:  ["prizepicks", "prize_picks"],
    ud:  ["underdogfantasy", "underdog_fantasy", "underdog"],
    fan: ["fanatics"],
  };

  const filterByBook = (plays: any[], bookKey: string): any[] => {
    if (bookKey === "all") return plays;
    const validKeys = bookKeyMap[bookKey] ?? [bookKey];
    return plays.filter(play => {
      const bookKeys: string[] = play.bookKeys ?? [];
      return bookKeys.some(bk => validKeys.some(vk => bk.toLowerCase().includes(vk)));
    });
  };

  const getBookCount = (plays: any[], bookKey: string): number => {
    const preFiltered = plays.filter(filterPlay);
    return filterByBook(preFiltered, bookKey).length;
  };

  const unlock2hGame = async (gameId: string) => {
    if (unlocking2hGame) return;
    setUnlocking2hGame(gameId);
    try {
      const { getAuthToken: tok } = await import("@/lib/queryClient");
      const token = tok();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/2h-game-view", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ gameId }),
      });
      if (res.status === 402) {
        const err = await res.json().catch(() => ({}));
        setUpgradeModalState({ playsUsed: err.playsUsedToday ?? err.playsUsed ?? user?.playsUsedToday ?? 0, limit: err.limit ?? 3 });
        setShowUpgradeModal(true);
      } else if (res.ok) {
        setUnlockedGameIds(prev => new Set(Array.from(prev).concat(gameId)));
        queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      } else {
        toast({ title: "Could not unlock game", description: "Please try again.", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Could not unlock game", description: err.message, variant: "destructive" });
    } finally {
      setUnlocking2hGame(null);
    }
  };

  return (
    <div
      className={`min-h-screen overflow-x-hidden bg-background transition-transform duration-200 ${isFreeUser ? "pb-20" : ""}`}
      style={{
        transform: (pullDistance > 0 || isPullRefreshing) ? `translateY(${isPullRefreshing ? 56 : pullDistance}px)` : undefined,
        paddingBottom: isFreeUser ? undefined : "env(safe-area-inset-bottom, 0px)",
      }}
    >
      {(pullDistance > 0 || isPullRefreshing) && (
        <div
          className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-center pointer-events-none"
          style={{ height: isPullRefreshing ? 56 : pullDistance, transform: `translateY(-${isPullRefreshing ? 56 : pullDistance}px)` }}
          data-testid="pull-refresh-indicator"
        >
          <div className={`flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 backdrop-blur-sm ${isPullRefreshing ? "animate-pulse" : ""}`}>
            <RefreshCw
              className={`w-4 h-4 text-primary transition-transform duration-200 ${isPullRefreshing ? "animate-spin" : ""}`}
              style={{ transform: isPullRefreshing ? undefined : `rotate(${Math.min(pullDistance / 80 * 360, 360)}deg)` }}
            />
            <span className="text-xs font-medium text-primary">
              {isPullRefreshing ? "Refreshing..." : pullDistance >= 80 ? "Release to refresh" : "Pull to refresh"}
            </span>
          </div>
        </div>
      )}
      {showResetOverlay && (
        <NewSlateOverlay
          step={resetStep}
          steps={RESET_STEPS}
          date={new Date()}
          liveCount={liveGames?.filter((g: any) => g.status === "in" || g.status === "live" || g.isLive).length ?? 0}
          visible={overlayVisible}
        />
      )}
      {/* Header */}
      <header
        className="border-b border-border/40 bg-background/80 backdrop-blur-xl sticky top-0 z-50"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <button
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity active:opacity-60"
            aria-label="Scroll to top"
            data-testid="button-scroll-to-top"
          >
            <img
              src={propPulseLogo}
              alt="PropPulse"
              className="w-9 h-9 rounded-xl object-cover shadow-lg shadow-primary/20 flex-shrink-0 ring-1 ring-primary/20"
            />
            <div className="flex flex-col leading-none min-w-0">
              <h1 className="text-lg sm:text-xl font-bold tracking-tight text-foreground">LiveLocks</h1>
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest mt-0.5 whitespace-nowrap">
                by PropPulse · {activeTab === "ncaab" ? "NCAAB" : activeTab === "mlb" ? "MLB" : "NBA"}
              </span>
            </div>
          </button>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
              <Radio className="w-3 h-3 text-green-500 animate-pulse" />
              <span>
                {isGamesLoading
                  ? "Fetching..."
                  : `${activeGames.length} live game${activeGames.length !== 1 ? "s" : ""}`}
              </span>
            </div>
            {user && !user.isAdmin && !user.subscriptionTier && (
              <button
                data-testid="button-plays-remaining"
                onClick={() => { setUpgradeModalState({ playsUsed: user.playsUsedToday ?? 0, limit: 3 }); setShowUpgradeModal(true); }}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-500 text-xs font-medium hover:bg-amber-500/20 transition-colors"
              >
                <Zap className="w-3 h-3" />
                {user.playsUsedToday ?? 0} / 3 today · Resets tomorrow
              </button>
            )}
            {user && user.subscriptionTier && (
              <div className="flex items-center gap-1.5">
                <span data-testid="text-subscription-tier" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-medium">
                  <Star className="w-3 h-3" />
                  {user.subscriptionTier === "elite" ? "All Sports" : user.subscriptionTier === "all" ? "Pro" : user.subscriptionTier}
                </span>
                <button
                  data-testid="button-manage-subscription"
                  onClick={() => setShowManageModal(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-secondary transition-colors"
                  title="Manage, cancel, or downgrade your subscription"
                  aria-label="Manage subscription — cancel, downgrade, or update payment"
                >
                  <Settings className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Manage Plan</span>
                </button>
              </div>
            )}
            {user?.isAdmin && (
              <>
                <button
                  onClick={() => syncRostersMutation.mutate()}
                  disabled={syncRostersMutation.isPending}
                  data-testid="button-sync-rosters"
                  title="Pull latest rosters from ESPN to update player team assignments"
                  className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
                >
                  {syncRostersMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  Sync Rosters
                </button>
                {dataHealth && (
                  <div
                    data-testid="text-data-health"
                    className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border ${
                      dataHealth.oddsApi.status === "healthy"
                        ? "bg-green-500/10 border-green-500/30 text-green-500"
                        : dataHealth.oddsApi.status === "degraded"
                        ? "bg-amber-500/10 border-amber-500/30 text-amber-500"
                        : "bg-red-500/10 border-red-500/30 text-red-500"
                    }`}
                    title={`Odds API: ${dataHealth.oddsApi.status}${dataHealth.oddsApi.requestsRemaining !== null ? ` — ${dataHealth.oddsApi.requestsRemaining.toLocaleString()} credits left` : ''}${dataHealth.oddsKeyStatus ? ` — ${dataHealth.oddsKeyStatus.totalKeys} keys, ${dataHealth.oddsKeyStatus.exhaustedKeys.length} exhausted` : ''}`}
                  >
                    <div className={`w-2 h-2 rounded-full ${
                      dataHealth.oddsApi.status === "healthy"
                        ? "bg-green-500"
                        : dataHealth.oddsApi.status === "degraded"
                        ? "bg-amber-500"
                        : "bg-red-500"
                    }`} />
                    {dataHealth.oddsKeyStatus && dataHealth.oddsKeyStatus.exhaustedKeys.length === dataHealth.oddsKeyStatus.totalKeys
                      ? "quota reached"
                      : dataHealth.oddsApi.status}
                  </div>
                )}
              </>
            )}
            {/* Unified notification bell — opens alert history + push/SMS settings */}
            <button
              data-testid="button-notifications"
              onClick={() => setShowHistorySheet(true)}
              className="relative flex items-center justify-center w-9 h-9 rounded-lg bg-secondary border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
              title="Notifications & alert history"
            >
              <Bell ref={bellRef} className="w-4 h-4" />
              {/* Red dot — unread alert history (highest priority) */}
              {notificationLog.length > 0 && (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-500 border border-background" />
              )}
              {/* Amber pulsing dot — SMS not yet configured */}
              {notificationLog.length === 0 && smsStatus === "unprompted" && (
                <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" style={{ animationDuration: "2s" }} />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
                </span>
              )}
              {/* Green dot — SMS opted-in, no new alerts */}
              {notificationLog.length === 0 && smsStatus === "opted-in" && (
                <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-green-400" />
              )}
            </button>
            <button
              onClick={() => setShowParlay(!showParlay)}
              data-testid="button-toggle-parlay"
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/20 transition-colors"
              title="Parlay Slip"
            >
              <Trophy className="w-4 h-4" />
              <span className="hidden sm:inline">Parlay Slip</span>
              {parlayPicks.length > 0 && (
                <span className="bg-primary text-primary-foreground text-xs rounded-full w-5 h-5 flex items-center justify-center">
                  {parlayPicks.length}
                </span>
              )}
            </button>
            {user?.isAdmin && (
              <button
                data-testid="link-performance"
                onClick={() => navigate("/admin")}
                className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 text-xs font-semibold hover:bg-blue-500/20 transition-colors"
                title="Model Performance"
              >
                <BarChart3 className="w-3.5 h-3.5" />
                Analytics
              </button>
            )}
            {user?.isAdmin && (
              <button
                data-testid="link-admin"
                onClick={() => navigate("/admin")}
                className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 text-xs font-semibold hover:bg-amber-500/20 transition-colors"
                title="Admin panel"
              >
                <Settings className="w-3.5 h-3.5" />
                Admin
              </button>
            )}
            {user && (
              <button
                data-testid="button-logout"
                onClick={() => { logout(); navigate("/auth"); }}
                className="flex items-center justify-center gap-1.5 w-9 h-9 sm:w-auto sm:h-auto sm:px-3 sm:py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-secondary/80 transition-colors"
                title={user.email}
                aria-label="Sign out"
              >
                <Users className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            )}
          </div>
        </div>
      </header>


      {/* PWA Install Banner */}
      {showInstallBanner && !pwaPromptDismissed && user && (
        <div className="border-b border-border/60 bg-primary/5">
          <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center gap-3">
            <span className="text-lg">📲</span>
            <p className="flex-1 text-xs text-foreground">
              {isIosPwa
                ? "Tap Share → Add to Home Screen to enable push alerts when the app is closed."
                : "Install LiveLocks to your home screen to get push alerts even when the app is closed."}
            </p>
            {!isIosPwa && (
              <button
                data-testid="button-pwa-install"
                onClick={handleInstall}
                className="shrink-0 px-3 py-1 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90"
              >
                Install
              </button>
            )}
            <button
              data-testid="button-pwa-dismiss"
              onClick={dismissInstallBanner}
              className="shrink-0 text-muted-foreground hover:text-foreground text-xs"
            >✕</button>
          </div>
        </div>
      )}

      <main className={`max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 mt-6 space-y-5 ${isFreeUser ? "pb-24" : "pb-8"}`}>

        {/* Email verification banner */}
        {user && !user.emailVerified && !verifyBannerDismissed && (
          <div
            data-testid="banner-verify-email"
            className="flex items-center justify-between gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm"
          >
            <span className="text-yellow-200 leading-snug">
              Your email isn&apos;t verified yet. Check your inbox and click the link to unlock your{" "}
              <span className="font-semibold">3 free plays</span>.
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                data-testid="button-resend-verify-dashboard"
                disabled={resendingVerify}
                onClick={async () => {
                  setResendingVerify(true);
                  try {
                    await apiRequest("POST", "/api/auth/resend-verification");
                    toast({ title: "Email sent", description: "Check your inbox for the verification link." });
                  } catch {
                    toast({ title: "Error", description: "Could not resend. Try again shortly.", variant: "destructive" });
                  } finally {
                    setResendingVerify(false);
                  }
                }}
                className="text-xs font-medium text-yellow-300 hover:text-yellow-100 underline underline-offset-2 disabled:opacity-50"
              >
                {resendingVerify ? "Sending…" : "Resend email"}
              </button>
              <button
                data-testid="button-dismiss-verify-banner"
                onClick={() => setVerifyBannerDismissed(true)}
                className="text-yellow-400 hover:text-yellow-200 text-xs leading-none"
                aria-label="Dismiss"
              >✕</button>
            </div>
          </div>
        )}

        {/* Welcome banner — shown once after upgrade */}
        {showWelcomeBanner && (
          <WelcomeBanner
            onExplore={handleExplore}
            onDismiss={dismissWelcomeBanner}
            subtitle={ncaabSubtitle.text}
            subtitleColor={ncaabSubtitle.color}
          />
        )}

        <LiveUpdateToast />

        {/*
          Free users get a single-column layout so FreeActivationRail (the
          conversion surface) is the only thing above the sport tabs. They
          must NOT see the right-side UserStatusRail because it surfaces
          "Live Signals 87" / "X signals across all sports" — which is a
          confusing locked-out stat for non-paid users instead of a CTA.

          Paid / admin / trial users keep the existing 1fr+280px layout
          with UserStatusRail rendered exactly as before.
        */}
        <div className={`grid grid-cols-1 gap-4 ${isFreeUser ? "" : "lg:grid-cols-[1fr_280px]"}`}>
          <div className="space-y-4">
            {(() => {
              // Pass 5 — branch precedence: admin/paid → TopPlaysPanel; trialing → TrialMissionRail; free → FreeActivationRail.
              // The trial branch only triggers when `subscriptionStatus === "trialing"` is explicitly populated by
              // the lifecycle sync (Pass 3). Legacy trial users without a synced status fall through to the paid
              // TopPlaysPanel they currently see, so this introduces no silent regression.
              const isAdminOrPaid = !!user?.isAdmin || hasProAccess(effectiveTier);
              const isTrialing = !user?.isAdmin && user?.subscriptionStatus === "trialing";

              if (isTrialing) {
                const alertsStatus = user?.alertsChannelStatus ?? null;
                const alertsConnected = alertsStatus === "connected";
                const alertsAvailable = alertsStatus === "connected" || alertsStatus === "available_not_connected";
                return (
                  <TrialMissionRail
                    trialStartedAt={user?.trialStartedAt ?? null}
                    trialEndsAt={user?.trialEndsAt ?? null}
                    plan={user?.subscriptionTier ?? null}
                    emailVerified={user?.emailVerified ?? false}
                    sportFocus={user?.sportFocus ?? null}
                    alertsConnected={alertsConnected}
                    alertsAvailable={alertsAvailable}
                    isPrimaryLoading={scanningEdges}
                    onOpenBestSignal={() => autoRunBestSignal()}
                    onAlertsCta={() => {
                      toast({
                        title: alertsAvailable ? "Daily alerts" : "Daily alerts coming soon",
                        description: alertsAvailable
                          ? "Open Settings to manage your daily alert preferences."
                          : "We'll notify you the moment alerts go live.",
                      });
                    }}
                  />
                );
              }

              const isFreeUser = !isAdminOrPaid;
              if (isFreeUser) {
                return (
                  <>
                    <FreeActivationRail
                      playsUsedToday={user?.playsUsedToday ?? 0}
                      playsLimit={3}
                      isPrimaryLoading={scanningEdges}
                      scrollTargetId="locked-signal-preview"
                      onPrimaryCta={() => {
                        const playsUsedToday = user?.playsUsedToday ?? 0;
                        const remaining = 3 - playsUsedToday;
                        const exhausted = remaining <= 0;
                        // Task #134 — record click + (if exhausted) the
                        // resulting upgrade modal open so we can compute
                        // rail → upgrade conversion.
                        void trackRailEvent({
                          eventType: "primary_cta_click",
                          exhausted,
                          playsUsedToday,
                          playsLimit: 3,
                        });
                        if (exhausted) {
                          void trackRailEvent({
                            eventType: "upgrade_modal_opened",
                            exhausted: true,
                            playsUsedToday,
                            playsLimit: 3,
                          });
                          setUpgradeModalState({ playsUsed: playsUsedToday || 3, limit: 3 });
                          setShowUpgradeModal(true);
                          return;
                        }
                        autoRunBestSignal();
                      }}
                      onAlertsCta={() => {
                        void trackRailEvent({
                          eventType: "alerts_cta_click",
                          playsUsedToday: user?.playsUsedToday ?? 0,
                          playsLimit: 3,
                        });
                        toast({
                          title: "Daily alerts coming soon",
                          description: "We'll notify you the moment alerts go live.",
                        });
                      }}
                    />
                    {/*
                      Conversion-priority order for free users:
                      1) FreeActivationRail (above)
                      2) Prominent missed-value / locked-profit band
                         (LockedSignalModule) — moved up so the value
                         proposition is visible without scrolling.
                      3) Recent Player Prop Wins proof strip (below).
                      The legacy LockedSignalModule render lower in this
                      file is gated off so it never duplicates here.
                    */}
                    <LockedSignalModule onUpgradeClick={handleUpgradeClick} />
                    {/*
                      Conversion: free users see a forward-looking premium
                      signal preview (no losses, no stale plays, no repeated
                      players). Admins still have full graded history in
                      Analytics. Replaces legacy <PublicProofStrip /> here.
                    */}
                    <SignalPreviewConversionCard onUpgradeClick={handleUpgradeClick} />
                  </>
                );
              }
              // Goldmaster — hide cross-sport "Top Picks / Live Signals"
              // panel from the standard paid-user dashboard surface (per user
              // spec: "guard behind admin/debug flag only"). Admin users
              // keep the panel as an internal diagnostic surface; an env
              // flag also opts any environment back in. Free + trial users
              // are unaffected (handled by branches above).
              const SHOW_LEGACY_GLOBAL_SIGNALS =
                import.meta.env.VITE_SHOW_LEGACY_GLOBAL_SIGNALS === "true" ||
                !!user?.isAdmin;
              if (!SHOW_LEGACY_GLOBAL_SIGNALS) {
                // Paid (non-admin) users do not see the conversion card and
                // do not see the negative recent-results feed. Graded
                // history remains accessible in Analytics for admins only.
                return null;
              }
              return (
                <TopPlaysPanel
                  isElite={!!user?.hasMLB || !!user?.isAdmin}
                  onNavigateToSport={handleNavigateToSport}
                  onAddToSlip={handleTopPlayAddToSlip}
                  onViewDetails={(play, related) => {
                    setSelectedDetailPlay(play);
                    setSelectedDetailRelated(related ?? []);
                  }}
                />
              );
            })()}
            <SignalDetailDialog
              open={selectedDetailPlay !== null}
              onOpenChange={(open) => {
                if (!open) {
                  setSelectedDetailPlay(null);
                  setSelectedDetailRelated([]);
                }
              }}
              play={selectedDetailPlay}
              related={selectedDetailRelated}
              alreadyOnSlip={isPlayOnSlip(selectedDetailPlay)}
              onAddToSlip={handleTopPlayAddToSlip}
              onAddRelatedToSlip={(rel) => {
                const full = selectedDetailRelated.find((r) => r.id === rel.id);
                if (full) handleTopPlayAddToSlip(full);
              }}
              onOpenSport={handleNavigateToSport}
            />
          </div>
          {!isFreeUser && (
            <div className="space-y-4">
              <UserStatusRail
                tier={effectiveTier ?? "free"}
                playsUsed={playsUsed}
                playsLimit={3}
                isAdmin={!!user?.isAdmin}
                onUpgradeClick={() => {
                  setUpgradeModalState({ playsUsed: user?.playsUsedToday ?? 0, limit: 3 });
                  setShowUpgradeModal(true);
                }}
              />
            </div>
          )}
        </div>

        {scanningEdges && (
          <div
            data-testid="scanning-edges-loader"
            className="rounded-xl border border-[#27272a] bg-[#0a0a0a] p-5 flex items-center gap-3 animate-pulse"
          >
            <Loader2 className="w-5 h-5 text-brand animate-spin" />
            <span className="text-sm font-medium text-[#a1a1aa]">Scanning live edges...</span>
          </div>
        )}

        {autoRunResult && (
          <div
            data-testid="auto-run-result"
            className="rounded-2xl border border-brand/30 bg-[#0a0a0a] p-5 animate-fade-in-up"
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-red-500/20 text-red-400">
                LIVE EDGE 🚨
              </span>
              <span className="text-xs text-[#71717a]">{autoRunResult.playerName} · {autoRunResult.statType}</span>
            </div>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="text-5xl font-black text-white leading-none" data-testid="text-auto-run-probability">
                  {autoRunResult.probability.toFixed(1)}%
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <span className="text-sm text-[#a1a1aa]">
                    Projection <strong className="text-white">{autoRunResult.projection.toFixed(1)}</strong> vs. Line <strong className="text-white">{autoRunResult.line.toFixed(1)}</strong>
                  </span>
                </div>
                <div className="mt-1.5">
                  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${
                    autoRunResult.direction === "OVER"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : "bg-red-500/20 text-red-400"
                  }`}>
                    {autoRunResult.direction === "OVER" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {autoRunResult.direction}
                  </span>
                </div>
              </div>
              <div className="flex-shrink-0">
                <ProbabilityRing probability={autoRunResult.probability} />
              </div>
            </div>
            {showConfidenceBadge && (
              <div
                data-testid="badge-model-confidence"
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand/10 border border-brand/20 text-brand text-xs font-medium"
              >
                <Target className="w-3 h-3" />
                Model confidence is strong on this play
              </div>
            )}
          </div>
        )}

        {autoRunFallback && !autoRunResult && (
          <div
            data-testid="auto-run-fallback"
            className="rounded-xl border border-[#27272a] bg-[#0a0a0a] p-4 text-center"
          >
            {/*
              Free users get a conversion-oriented fallback message instead of
              the neutral "Monitoring opportunities — signals appear as games
              go live" copy, which the activation spec explicitly forbids
              showing to free users (it positions them as locked-out spectators
              rather than a future paying customer with a clear next step).
              Paid / trial / admin users keep the informational copy.
            */}
            <p className="text-sm text-[#71717a]">
              {isFreeUser
                ? "No free play available right now — upgrade to unlock unlimited signals as soon as they hit."
                : "Monitoring opportunities — signals appear as games go live."}
            </p>
            {isFreeUser && (
              <button
                data-testid="button-get-full-access-fallback"
                onClick={handleUpgradeClick}
                className="mt-3 px-4 py-2 rounded-lg text-sm font-bold bg-amber-500 text-black active:scale-95 transition-transform"
              >
                Get Full Access
              </button>
            )}
          </div>
        )}

        {/*
          LockedSignalModule was previously rendered here (after the
          scanner / autoRunResult block). Conversion-priority order moved
          it directly under FreeActivationRail above so the missed-value
          band is visible without scrolling. Intentionally not rendered
          here to avoid duplicate display.
        */}

        {isFreeUser && playsUsed === 1 && (
          <div
            data-testid="nudge-plays-remaining"
            className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2.5 text-center"
          >
            <p className="text-sm text-amber-400">2 more free plays today · Resets tomorrow</p>
          </div>
        )}
        {isFreeUser && playsUsed === 2 && (
          <div
            data-testid="nudge-last-play"
            className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2.5 text-center"
          >
            <p className="text-sm text-red-400 font-medium">Last free play today — resets at midnight</p>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="relative flex flex-col gap-0 w-full overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-thin">
          <div className="flex gap-1 bg-secondary/40 border border-border/60 rounded-xl p-1 w-fit">
            <button
              onClick={() => { setActiveTab("calculator"); }}
              data-testid="tab-calculator"
              className={`px-3 sm:px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors relative whitespace-nowrap ${
                activeTab === "calculator"
                  ? "bg-primary text-primary-foreground border-glow"
                  : "text-muted-foreground hover:text-foreground"
              } ${hasLiveNba && activeTab !== "calculator" ? "shadow-[0_0_12px_rgba(34,197,94,0.3)]" : ""}`}
            >
              {hasLiveNba && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
              🏀 NBA Live
            </button>
            <button
              data-testid="tab-mlb"
              onClick={() => {
                setActiveTab("mlb");
                if (!user?.isAdmin && !user?.hasMLB) {
                  setShowMlbUpgradeModal(true);
                }
              }}
              className={`px-3 sm:px-4 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-1.5 transition-colors relative whitespace-nowrap ${
                activeTab === "mlb"
                  ? "bg-primary text-primary-foreground border-glow"
                  : "text-muted-foreground hover:text-foreground"
              } ${hasLiveMlb && activeTab !== "mlb" ? "shadow-[0_0_12px_rgba(34,197,94,0.3)]" : ""}`}
            >
              {hasLiveMlb && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
              <span role="img" aria-label="baseball">⚾</span>
              MLB Live
              {!user?.isAdmin && !user?.hasMLB && (
                <Lock className="w-3 h-3 opacity-50" />
              )}
            </button>
            <button
              data-testid="tab-ncaab"
              onClick={() => {
                if (!hasNcaabAccess) {
                  setUpgradeModalState({ playsUsed: user?.playsUsedToday ?? 0, limit: 3 });
                  setShowUpgradeModal(true);
                  return;
                }
                navigate("/ncaab");
              }}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors flex items-center gap-1.5 ${
                activeTab === "ncaab"
                  ? "bg-primary text-primary-foreground border-glow"
                  : "text-muted-foreground hover:text-foreground"
              } ${!hasNcaabAccess ? "opacity-60" : ""}`}
            >
              <div style={{ position: "relative", display: "inline-flex", alignItems: "center", overflow: "visible" }}>
                🎓 NCAAB Live
                {hasNcaabAccess && showNewBadge && (
                  <span
                    data-testid="ncaab-new-badge"
                    style={{
                      position: "absolute",
                      top: -8,
                      right: -20,
                      background: "hsl(var(--brand-accent))",
                      color: "#000000",
                      fontSize: 9,
                      fontWeight: 700,
                      lineHeight: 1,
                      padding: "2px 5px",
                      borderRadius: 4,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      pointerEvents: "none",
                      animation: "newBadgeScale 300ms cubic-bezier(0.34,1.56,0.64,1) both",
                    }}
                  >
                    NEW
                  </span>
                )}
              </div>
              {!hasNcaabAccess && <Lock className="w-3 h-3 ml-0.5 shrink-0" />}
            </button>
            {user?.isAdmin && (
              <button
                data-testid="tab-analytics"
                onClick={() => setActiveTab("analytics")}
                className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors flex items-center gap-1.5 ${
                  activeTab === "analytics"
                    ? "bg-primary text-primary-foreground border-glow"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                📊 Analytics
              </button>
            )}
          </div>

          {activeTab === "calculator" && (
            <div className="flex gap-1 mt-2 w-fit bg-secondary/40 border border-border/60 rounded-xl p-1">
              <button
                data-testid="tab-nba-live"
                onClick={() => setNbaSubTab("live")}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  nbaSubTab === "live"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Live Props
              </button>
              <button
                data-testid="tab-nba-halftime"
                onClick={() => setNbaSubTab("halftime")}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                  nbaSubTab === "halftime"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                ⏱ 2H Plays
              </button>
            </div>
          )}

          {activeTab === "mlb" && (
            <div className="flex gap-1 mt-2 w-fit bg-secondary/40 border border-border/60 rounded-xl p-1">
              {([
                { key: "hr_radar", label: "HR Radar" },
                // Action Feed (live_feed) hidden for now — re-add this entry to restore.
                // { key: "live_feed", label: "Action Feed" },
              ] as const).map(tab => (
                <button
                  key={tab.key}
                  data-testid={`tab-mlb-${tab.key}`}
                  onClick={() => setMlbSubTab(tab.key)}
                  className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    mlbSubTab === tab.key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  } ${tab.key === "hr_radar" && mlbSubTab !== "hr_radar" ? "relative" : ""}`}
                  style={tab.key === "hr_radar" && mlbSubTab === "hr_radar" ? { boxShadow: "0 0 12px rgba(239,68,68,0.3)", borderColor: "rgba(239,68,68,0.3)" } : undefined}
                >
                  {tab.key === "hr_radar" && (
                    <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  )}
                  {tab.label}
                </button>
              ))}
            </div>
          )}


          {/* MLB Upgrade Modal */}
          {showMlbUpgradeModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowMlbUpgradeModal(false)}>
              <div
                className="relative w-full max-w-md mx-4 bg-card border border-border/60 rounded-2xl p-6 shadow-2xl"
                style={{ boxShadow: "0 0 40px -8px hsl(var(--primary) / 0.3), 0 16px 48px -8px hsl(0 0% 0% / 0.6)" }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  data-testid="button-close-mlb-modal"
                  onClick={() => setShowMlbUpgradeModal(false)}
                  className="absolute top-3 right-3 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
                <div className="text-center mb-4">
                  <span className="text-3xl">⚾</span>
                  <h3 className="text-lg font-bold text-foreground mt-2">Unlock MLB Live</h3>
                </div>
                <p className="text-sm text-muted-foreground text-center mb-4">
                  Get real-time MLB prop predictions, live signals, and edge detection with the All Sports plan.
                </p>
                <div className="bg-secondary/40 border border-border/40 rounded-xl p-3 mb-4 text-xs text-muted-foreground space-y-1.5">
                  <div className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Live MLB prop predictions</div>
                  <div className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Everything in Pro (NBA + NCAAB)</div>
                  <div className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> Priority SMS alerts</div>
                </div>
                <p className="text-xs text-center text-muted-foreground mb-3">
                  You have a 2-play preview — explore MLB games below!
                </p>
                <button
                  data-testid="button-mlb-upgrade"
                  onClick={() => { setShowMlbUpgradeModal(false); setShowUpgradeModal(true); }}
                  className="w-full py-2.5 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors"
                >
                  Upgrade to All Sports — $65/mo
                </button>
                <button
                  data-testid="button-mlb-preview"
                  onClick={() => setShowMlbUpgradeModal(false)}
                  className="w-full mt-2 py-2 px-4 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  Continue with Preview
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Games failed to load — show retry instead of a silently empty slate */}
        {activeTab === "calculator" && allGames.length === 0 && isGamesError && (
          <QueryErrorState
            message="Couldn't load today's games."
            onRetry={() => refetchGames()}
            isRetrying={isGamesFetching}
          />
        )}

        {/* Live Games Strip — NBA Live tab only (hidden on NCAAB and Analytics) */}
        {activeTab === "calculator" && allGames.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                <Radio className="w-3.5 h-3.5 text-green-500" /> Today's Games
              </h2>
              <button
                onClick={() => refetchGames()}
                className="text-muted-foreground flex items-center gap-1 text-xs hover:text-foreground"
                data-testid="button-refresh-games"
              >
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>
            <div className="flex gap-2 flex-wrap">
              {allGames.map((game) => {
                const isLive = game.status !== "Scheduled" && game.status !== "Pre-Game" && game.status !== "Final";
                const isFinal = game.status === "Final";
                const isScheduled = game.status === "Scheduled" || game.status === "Pre-Game";
                const isSelected = game.id === selectedGameId;
                const scoreStr = `${game.awayScore}-${game.homeScore}`;
                const tipoffTime = game.startTime
                  ? new Date(game.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
                  : null;

                return (
                  <button
                    key={game.id}
                    data-testid={`button-game-${game.id}`}
                    onClick={() => {
                      if (isSelected) {
                        setSelectedGameId(undefined);
                        setSelectedGameTeams(undefined);
                        form.setValue("halftimeScore", "");
                        form.setValue("gameId", "");
                        form.setValue("playerId" as any, "");
                      } else {
                        setSelectedGameId(game.id);
                        setSelectedGameTeams({
                          home: game.homeTeam,
                          away: game.awayTeam,
                          homeAbbr: game.homeTeamAbbr,
                          awayAbbr: game.awayTeamAbbr,
                        });
                        form.setValue("gameId", game.id);
                        form.setValue("playerId" as any, "");
                        if (game.period >= 2) {
                          form.setValue("halftimeScore", scoreStr);
                        }
                      }
                    }}
                    className={`flex flex-col items-center px-3 py-2 rounded-lg border text-xs min-w-[130px] transition-all ${
                      isSelected
                        ? "border-primary bg-primary/10 ring-1 ring-primary shadow-[0_0_16px_-3px_hsl(var(--primary)/0.4)]"
                        : "border-border/60 bg-secondary/40 hover:bg-secondary/70 hover:shadow-[0_0_14px_-3px_hsl(var(--primary)/0.25)]"
                    }`}
                  >
                    <div className="flex items-center justify-between w-full gap-2">
                      <span className="font-semibold text-foreground">{game.awayTeamAbbr}</span>
                      <span className="font-mono text-primary font-bold">
                        {game.awayScore} – {game.homeScore}
                      </span>
                      <span className="font-semibold text-foreground">{game.homeTeamAbbr}</span>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground mt-0.5">
                      {isLive && <LiveIndicator />}
                      {isFinal && <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 inline-block" />}
                      <span className={isLive ? "text-green-400" : isFinal ? "text-muted-foreground/60" : ""}>
                        {isLive
                          ? `Q${game.period} ${game.clock}`
                          : isScheduled && tipoffTime
                          ? tipoffTime
                          : game.status}
                      </span>
                      {isSelected && <span className="text-primary font-medium ml-1">●</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}


        {/* Live Box Score — NBA Live tab only */}
        {activeTab === "calculator" && selectedGameId && (liveStats || isLiveStatsLoading) && (
          <>
            {nbaLiveSignalsStale && (
              <div
                className="mb-3 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm flex items-center gap-2"
                data-testid="status-nba-live-stale"
              >
                <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                Updating live data...
              </div>
            )}
            <LiveBoxscore
              liveStats={liveStats}
              engineOutput={safeEngineOutput}
              halftimePlaysData={halftimePlaysData}
              liveSignalsData={safeLiveSignalsData}
              selectedPlayer={selectedPlayer}
              watchedStatType={watchedStatType}
              isLiveStatsLoading={isLiveStatsLoading}
              lastRefreshed={lastRefreshed}
              onRefresh={() => { refetchLiveStats(); setLastRefreshed(new Date()); }}
              onRowClick={handleBoxScoreClick}
              currentGameId={selectedGameId ?? ""}
            />
          </>
        )}

        {/* Main 3-column layout */}
        {activeTab === "calculator" && nbaSubTab === "live" ? <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">

          {/* LEFT: Input Form */}
          <div className="lg:col-span-4 space-y-4 mb-20 lg:mb-0">
            <div className="bg-card border border-border rounded-xl p-5 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-primary to-transparent" />
              <div className="flex items-start justify-between mb-1">
                <h2 className="text-lg font-semibold">Matchup Details</h2>
                {gameLines?.spread && gameLines?.total ? (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-[10px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded">
                      {gameLines.favorite?.split(" ").pop()} -{gameLines.spread}
                    </span>
                    <span className="text-[10px] font-mono bg-secondary text-muted-foreground border border-border/60 px-1.5 py-0.5 rounded">
                      O/U {gameLines.total}
                    </span>
                  </div>
                ) : null}
              </div>
              <p className="text-muted-foreground text-xs mb-4">Enter halftime stats to calculate 2H probability.</p>

              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                {/* Player */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Player</label>
                    {selectedGameId && selectedGameTeams && (
                      <span className="flex items-center gap-1 text-xs text-primary">
                        <Users className="w-3 h-3" />
                        {espnToDb(selectedGameTeams.awayAbbr)} vs {espnToDb(selectedGameTeams.homeAbbr)} only
                      </span>
                    )}
                  </div>
                  <div className="relative">
                    <select
                      {...form.register("playerId")}
                      data-testid="select-player"
                      className="w-full h-10 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none appearance-none text-sm"
                    >
                      <option value="">Select Player...</option>
                      {sortedTeamKeys.map((team) => (
                        <optgroup key={team} label={`${team} – ${TEAM_FULL_NAMES[team] ?? team}`}>
                          {playersByTeam[team]!.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.position})
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  </div>
                </div>

                {/* Opponent */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Opponent Team</label>
                  <div className="relative">
                    <select
                      {...form.register("opponentTeam")}
                      data-testid="select-opponent"
                      className="w-full h-10 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none appearance-none text-sm"
                    >
                      <option value="">Select Opponent...</option>
                      {teams?.map((t) => (
                        <option key={t} value={t}>
                          {t} – {TEAM_FULL_NAMES[t] ?? t}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  </div>
                </div>

                {/* Game Situation */}
                <div className="p-3.5 rounded-lg bg-secondary/40 border border-border/50 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Clock className="w-3 h-3" />
                    Game Situation
                    {autoFilledFields.size > 0 && (
                      <span className="text-green-400 text-xs normal-case font-normal ml-1 flex items-center gap-1">
                        <LiveIndicator />
                        Auto-filled
                      </span>
                    )}
                    {!autoFilledFields.size && liveStats && selectedGameId && (
                      <span className="text-muted-foreground/50 text-xs normal-case font-normal ml-1">
                        · click a box score row
                      </span>
                    )}
                  </h3>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Minutes Played</label>
                      <input
                        type="number" step="0.1"
                        {...form.register("halftimeMinutes", {
                          onChange: () => setAutoFilledFields(prev => { const n = new Set(prev); n.delete("halftimeMinutes"); return n; })
                        })}
                        data-testid="input-minutes"
                        className={`w-full h-9 px-3 rounded-lg bg-input border focus:border-primary outline-none text-sm font-mono transition-colors ${
                          autoFilledFields.has("halftimeMinutes")
                            ? "border-green-500/50 bg-green-500/5 text-green-300"
                            : "border-border"
                        }`}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Fouls</label>
                      <input
                        type="number"
                        {...form.register("halftimeFouls", {
                          onChange: () => setAutoFilledFields(prev => { const n = new Set(prev); n.delete("halftimeFouls"); return n; })
                        })}
                        data-testid="input-fouls"
                        className={`w-full h-9 px-3 rounded-lg bg-input border focus:border-primary outline-none text-sm font-mono transition-colors ${
                          autoFilledFields.has("halftimeFouls")
                            ? "border-green-500/50 bg-green-500/5 text-green-300"
                            : "border-border"
                        }`}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground flex items-center gap-1">
                      <Zap className="w-3 h-3 text-yellow-500" />
                      Halftime Score (optional)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 62-55"
                      {...form.register("halftimeScore")}
                      data-testid="input-score"
                      className="w-full h-9 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none text-sm font-mono"
                    />
                  </div>
                </div>

                {/* Stat Type + Line */}
                <div className="p-3.5 rounded-lg bg-secondary/40 border border-border/50 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Target className="w-3 h-3" /> The Line
                  </h3>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Stat / Prop Type</label>
                    <div className="relative">
                      <select
                        {...form.register("statType")}
                        data-testid="select-stat-type"
                        className="w-full h-9 pl-3 pr-8 rounded-lg bg-input border border-border focus:border-primary outline-none appearance-none text-sm"
                      >
                        {STAT_TYPES.map((s) => (
                          <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Current Stat Total</label>
                      <input
                        type="number" step="0.5"
                        {...form.register("halftimeStat", {
                          onChange: () => setAutoFilledFields(prev => { const n = new Set(prev); n.delete("halftimeStat"); return n; })
                        })}
                        data-testid="input-current-stat"
                        className={`w-full h-9 px-3 rounded-lg bg-input border focus:border-primary outline-none text-sm font-mono transition-colors ${
                          autoFilledFields.has("halftimeStat")
                            ? "border-green-500/50 bg-green-500/5 text-green-300"
                            : "border-border"
                        }`}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-primary font-medium">Live Line</label>
                      <input
                        type="number" step="0.5"
                        {...form.register("liveLine")}
                        data-testid="input-live-line"
                        className="w-full h-9 px-3 rounded-lg bg-primary/10 border border-primary/40 focus:border-primary outline-none text-sm font-mono text-primary font-bold"
                      />
                    </div>
                  </div>

                  {/* Live Odds from Sportsbooks — shows whenever player + opponent are both set */}
                  {selectedPlayer && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-xs text-muted-foreground flex items-center gap-1.5">
                          Lines by Book
                          {isSelectedGameLive && (
                            <span className="text-green-400 font-medium">· Live</span>
                          )}
                          {oddsUpdatedAt > 0 && !isOddsLoading && (
                            <span className="text-muted-foreground/50">
                              · {Date.now() - oddsUpdatedAt < 60000
                                ? `${Math.floor((Date.now() - oddsUpdatedAt) / 1000)}s ago`
                                : `${Math.floor((Date.now() - oddsUpdatedAt) / 60000)}m ago`}
                            </span>
                          )}
                        </label>
                        <div className="flex items-center gap-1.5">
                          {isOddsLoading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                          {watchedOpponent && !isOddsLoading && (
                            <button
                              type="button"
                              data-testid="button-refresh-odds"
                              title="Refresh lines"
                              onClick={() => queryClient.invalidateQueries({
                                queryKey: ["/api/odds", selectedPlayer?.team, watchedOpponent || undefined, selectedPlayer?.name, watchedStatType]
                              })}
                              className="text-muted-foreground/50 hover:text-primary transition-colors"
                            >
                              <RefreshCw className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* No opponent selected yet */}
                      {!watchedOpponent && !isOddsLoading && (
                        <p className="text-xs text-muted-foreground/60 bg-secondary/50 rounded-lg p-2 border border-border/40">
                          Select an opponent team above to load sportsbook lines.
                        </p>
                      )}

                      {watchedOpponent && !isOddsLoading && oddsData && (oddsData as any)._quotaExhausted && (
                        <p className="text-xs text-amber-400/80 bg-amber-500/10 rounded-lg p-2 border border-amber-500/20">
                          Sportsbook lines paused — monthly API credit limit reached. Lines will resume when your billing cycle resets. Cached lines are still powering the signal engine.
                        </p>
                      )}

                      {/* Odds fetched but nothing found */}
                      {watchedOpponent && !isOddsLoading && oddsData && !((oddsData as any)._quotaExhausted) && Object.keys(oddsData).filter(k => k !== '_quotaExhausted').length === 0 && (
                        <p className="text-xs text-muted-foreground/60 bg-secondary/50 rounded-lg p-2 border border-border/40">
                          No lines found — props may not be posted yet, or the player is inactive.
                        </p>
                      )}

                      {/* Odds available */}
                      {oddsData && !((oddsData as any)._quotaExhausted) && Object.keys(oddsData).filter(k => k !== '_quotaExhausted').length > 0 && (
                        <div className="space-y-1.5">
                          {Object.entries(oddsData).filter(([k]) => k !== '_quotaExhausted').map(([sb, odds]) => {
                            const o = odds as import("@shared/schema").OddsLine;
                            const hasMovement = o.lineMovement !== undefined && o.lineMovement !== 0;
                            const droppedFromOpen = (o.lineMovement ?? 0) < 0; // easier Over
                            const roseFromOpen = (o.lineMovement ?? 0) > 0;    // easier Under
                            return (
                              <button
                                key={sb}
                                type="button"
                                data-testid={`button-odds-${sb}`}
                                onClick={() => {
                                  form.setValue("liveLine", o.line);
                                  setSelectedSportsbook(sb);
                                }}
                                className={`w-full flex flex-col px-3 py-2 rounded-lg border text-xs transition-all text-left ${
                                  selectedSportsbook === sb
                                    ? "border-primary bg-primary/10"
                                    : "border-border/50 bg-secondary/30 hover:bg-secondary/60"
                                }`}
                              >
                                {/* Main row: name | line + CLV badge | odds */}
                                <div className="flex items-center justify-between w-full">
                                  <span className="font-semibold text-foreground">{SPORTSBOOK_LABELS[sb] ?? sb}</span>
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono font-bold text-primary">{o.line}</span>
                                    {result && o.line != null && (() => {
                                      const delta = Number(o.line) - Number(form.getValues("liveLine"));
                                      const fmt = (n: number) => n % 1 === 0 ? String(Math.round(n)) : n.toFixed(1);
                                      if (delta === 0) return null;
                                      return (
                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                                          delta > 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/10 text-red-400"
                                        }`}>
                                          {delta > 0 ? "+" : ""}{fmt(delta)}
                                        </span>
                                      );
                                    })()}
                                  </div>
                                  <span className="text-muted-foreground">
                                    O {formatOdds(o.overOdds)} / U {formatOdds(o.underOdds)}
                                  </span>
                                </div>
                                {/* Line movement row */}
                                {hasMovement && o.openLine !== undefined && (
                                  <div className="flex items-center justify-between w-full mt-1 pt-1 border-t border-border/30">
                                    <span className="text-muted-foreground/70">
                                      Open: <span className="font-mono">{o.openLine}</span>
                                    </span>
                                    <span className={`font-semibold flex items-center gap-0.5 ${
                                      droppedFromOpen ? "text-emerald-400" : "text-orange-400"
                                    }`}>
                                      {droppedFromOpen ? "▼" : "▲"}
                                      {Math.abs(o.lineMovement!)}
                                      <span className="font-normal ml-1">
                                        {droppedFromOpen ? "Over edge" : "Under edge"}
                                      </span>
                                    </span>
                                    {o.edgeEstimate !== undefined && o.edgeEstimate !== 0 && (
                                      <span className={`font-bold ${
                                        droppedFromOpen ? "text-emerald-400" : "text-orange-400"
                                      }`}>
                                        {o.edgeEstimate > 0 ? "+" : ""}{o.edgeEstimate}%
                                      </span>
                                    )}
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}

                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={calculateMutation.isPending}
                  data-testid="button-calculate"
                  className="w-full h-10 rounded-lg bg-primary text-primary-foreground font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {calculateMutation.isPending ? (
                    <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                  ) : (
                    "Get Signal Read"
                  )}
                </button>

                {/* Daily free play countdown — shown to free users only */}
                {user && !user.isAdmin && !user.subscriptionTier && (() => {
                  const used = user.playsUsedToday ?? 0;
                  const limit = 3;
                  const remaining = Math.max(0, limit - used);
                  const pct = Math.round((used / limit) * 100);
                  return (
                    <div data-testid="free-play-countdown" className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Zap className="w-3.5 h-3.5 text-amber-500" />
                          <span className="text-xs font-semibold text-amber-400">
                            {remaining > 0 ? `${used} / 3 today` : "All 3 plays used today"}
                          </span>
                        </div>
                        <button
                          type="button"
                          data-testid="button-upgrade-from-countdown"
                          onClick={() => { setUpgradeModalState({ playsUsed: used, limit }); setShowUpgradeModal(true); }}
                          className="text-[10px] font-bold text-amber-500 hover:text-amber-400 underline underline-offset-2 transition-colors"
                        >
                          Upgrade →
                        </button>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-amber-500/15 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${remaining === 0 ? "bg-red-500" : "bg-amber-500"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground/60">{used} of {limit} today · <span className="text-amber-500/80">Resets tomorrow · Upgrade for unlimited</span></p>
                    </div>
                  );
                })()}

                {user && !user.isAdmin && !user.subscriptionTier && (user.playsUsedToday ?? 0) >= 1 && (user.playsUsedToday ?? 0) < 3 && (
                  <div data-testid="near-limit-reminder" className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2.5 flex items-center gap-2">
                    <span className="text-orange-400 text-sm">⚠️</span>
                    <span className="text-xs text-orange-300">
                      {3 - (user.playsUsedToday ?? 0)} free {3 - (user.playsUsedToday ?? 0) === 1 ? "play" : "plays"} remaining today.
                    </span>
                    <button
                      type="button"
                      data-testid="button-upgrade-near-limit"
                      onClick={() => { setUpgradeModalState({ playsUsed: user.playsUsedToday ?? 0, limit: 3 }); setShowUpgradeModal(true); }}
                      className="ml-auto text-[10px] font-bold text-orange-400 hover:text-orange-300 underline underline-offset-2 transition-colors whitespace-nowrap"
                    >
                      Go Pro →
                    </button>
                  </div>
                )}
              </form>
            </div>
          </div>

          {/* CENTER: Results */}
          <div className={showParlay ? "lg:col-span-5" : "lg:col-span-8"}>
            {!result ? (
              <div className="h-full min-h-[400px] flex flex-col items-center justify-center border-2 border-dashed border-border/40 rounded-xl text-muted-foreground bg-gradient-to-b from-card/20 to-transparent p-8 text-center">
                <div className="relative mb-5">
                  <div className="w-20 h-20 rounded-full bg-secondary/80 flex items-center justify-center ring-2 ring-border/40">
                    <Target className="w-9 h-9 text-muted-foreground/40" />
                  </div>
                  <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center">
                    <Zap className="w-3 h-3 text-primary" />
                  </div>
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">Awaiting Signal</h3>
                <p className="max-w-xs text-sm text-muted-foreground mb-4">
                  The Action Feed surfaces signals automatically. Use this panel to read a specific player's live signal on demand.
                </p>
                {allGames.length > 0 && (
                  <div className="space-y-1.5 text-left text-xs text-muted-foreground/70 bg-secondary/30 border border-border/30 rounded-lg px-4 py-3 max-w-xs w-full">
                    <p className="font-semibold text-muted-foreground mb-1 text-[10px] uppercase tracking-wider">Quick start</p>
                    <p>① Click a game tile above</p>
                    <p>② Click a player row in the box score</p>
                    <p>③ Pick a stat type &amp; live line</p>
                    <p>④ Read the live signal</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4 animate-fade-in-up">
                {/* Main Result Card */}
                <div className="bg-card border border-border rounded-xl p-5 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-48 h-48 bg-primary/5 rounded-full blur-[60px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
                  <div className="flex flex-col md:flex-row items-center justify-between gap-5">
                    <div className="flex-1 space-y-3 z-10">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span data-testid="badge-live-edge" className="text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-red-500/20 text-red-400">LIVE EDGE 🚨</span>
                        </div>
                        <div className="text-2xl font-bold tracking-tight">
                          {selectedPlayer?.name ?? "Player"} —{" "}
                          {STAT_TYPES.find((s) => s.value === form.getValues("statType"))?.label}{" "}
                          <span className="text-primary">{form.getValues("liveLine")}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <TrendingUp className="w-4 h-4 text-muted-foreground" />
                        <span className="text-muted-foreground">
                          At half: <span className="text-foreground font-bold">{form.getValues("halftimeStat")}</span>
                          {" · "}Needs{" "}
                          <span className="text-foreground font-bold">
                            {Math.max(0, form.getValues("liveLine") - form.getValues("halftimeStat")).toFixed(1)}
                          </span>{" "}
                          more
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground">
                        <span>Projection <strong className="text-foreground">{result.expectedTotal.toFixed(1)}</strong> vs. Line <strong className="text-foreground">{form.getValues("liveLine")}</strong></span>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
                          result.probability > 50 ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
                        }`}>
                          {result.probability > 50 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {result.probability > 50 ? "OVER" : "UNDER"}
                        </span>
                      </div>
                      {selectedPlayer?.ppg && (
                        <div className="flex gap-3 text-xs text-muted-foreground">
                          <span>Season: <strong className="text-foreground">{Number(selectedPlayer.ppg).toFixed(1)}</strong> PPG</span>
                          {selectedPlayer.rpg && <span><strong className="text-foreground">{Number(selectedPlayer.rpg).toFixed(1)}</strong> RPG</span>}
                          {selectedPlayer.apg && <span><strong className="text-foreground">{Number(selectedPlayer.apg).toFixed(1)}</strong> APG</span>}
                          {selectedPlayer.avgMinutes && <span><strong className="text-foreground">{Number(selectedPlayer.avgMinutes).toFixed(1)}</strong> MPG</span>}
                        </div>
                      )}

                      {/* Add to Parlay — Over / Under */}
                      <div className="flex gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => handleAddToParlay("over")}
                          disabled={parlayPicks.length >= 10}
                          data-testid="button-add-over"
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm font-semibold hover:bg-emerald-500/20 transition-colors disabled:opacity-40"
                        >
                          <TrendingUp className="w-4 h-4" />
                          Over {form.watch("liveLine") || "—"}{" "}
                          <span className="opacity-70">({result.probability.toFixed(0)}%)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAddToParlay("under")}
                          disabled={parlayPicks.length >= 10}
                          data-testid="button-add-under"
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-semibold hover:bg-red-500/20 transition-colors disabled:opacity-40"
                        >
                          <TrendingDown className="w-4 h-4" />
                          Under {form.watch("liveLine") || "—"}{" "}
                          <span className="opacity-70">({(100 - result.probability).toFixed(0)}%)</span>
                        </button>
                        {parlayPicks.length >= 10 && (
                          <span className="text-xs text-muted-foreground self-center">(max 10)</span>
                        )}
                      </div>
                    </div>
                    <div className="flex-shrink-0 z-10 flex flex-col items-center gap-2">
                      <ProbabilityRing probability={result.probability} />
                    </div>
                  </div>
                </div>

                {result && (
                  <div
                    data-testid="badge-model-confidence-calc"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand/10 border border-brand/20 text-brand text-xs font-medium"
                  >
                    <Target className="w-3 h-3" />
                    Model confidence is strong on this play
                  </div>
                )}

                {result && <RecentWinsStrip />}

                {/* EV% Box — shown directly below probability summary when a sportsbook is selected */}
                {selectedSportsbook && selectedSportsbook !== "manual" && oddsData && result && (() => {
                  const mktOdds = (oddsData as Record<string, import("@shared/schema").OddsLine>)[selectedSportsbook];
                  if (!mktOdds?.overOdds) return null;
                  const overImplied = americanToImplied(mktOdds.overOdds) * 100;
                  const underImplied = americanToImplied(mktOdds.underOdds ?? -110) * 100;
                  const overEV = result.probability - overImplied;
                  const underEV = (100 - result.probability) - underImplied;
                  const bestEV = overEV >= underEV ? { side: "Over", ev: overEV, implied: overImplied } : { side: "Under", ev: underEV, implied: underImplied };
                  const isPositive = bestEV.ev > 0;
                  const absEV = Math.abs(bestEV.ev);
                  const edgeLabel = absEV >= 6 ? "Strong" : absEV >= 3 ? "Moderate" : "Slight";
                  const sbName = SPORTSBOOK_LABELS[selectedSportsbook] ?? selectedSportsbook;
                  const hasMovement = mktOdds.lineMovement !== undefined && mktOdds.lineMovement !== 0;
                  const dropped = (mktOdds.lineMovement ?? 0) < 0;
                  return (
                    <div data-testid="ev-box" className={`rounded-xl border p-4 flex gap-3 items-start animate-fade-in-up ${
                      isPositive ? "bg-emerald-500/10 border-emerald-500/30" : "bg-red-500/10 border-red-500/30"
                    }`}>
                      <div className={`mt-0.5 flex-shrink-0 font-bold text-lg ${isPositive ? "text-emerald-400" : "text-red-400"}`}>
                        {isPositive ? "▲" : "▼"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <h4 className={`text-sm font-semibold ${isPositive ? "text-emerald-400" : "text-red-400"}`}>
                            {edgeLabel} {bestEV.side} EV
                          </h4>
                          <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                            isPositive ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
                          }`}>
                            {isPositive ? "+" : ""}{Math.round(bestEV.ev)}% EV
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Model <strong className="text-foreground">{result.probability.toFixed(1)}%</strong>
                          {" vs "}{sbName} <strong className="text-foreground">{formatOdds(bestEV.side === "Over" ? mktOdds.overOdds : (mktOdds.underOdds ?? -110))}</strong>
                        </p>
                        <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                          {absEV >= 6 ? "High conviction edge vs market."
                            : absEV >= 3 ? "Solid discrepancy — model sees value."
                            : isPositive ? "Slight edge — use as tiebreaker."
                            : "Model trails implied — line may be priced in."}
                          {hasMovement && mktOdds.openLine !== undefined && (
                            <span> Line {dropped ? "▼" : "▲"}{Math.abs(mktOdds.lineMovement!)} from open ({mktOdds.openLine}→{mktOdds.line}).</span>
                          )}
                        </p>
                      </div>
                    </div>
                  );
                })()}

                {/* Stats Grid */}
                {(() => {
                  const marketOdds = selectedSportsbook && selectedSportsbook !== "manual" && oddsData
                    ? (oddsData as Record<string, import("@shared/schema").OddsLine>)[selectedSportsbook]
                    : null;
                  const hasMarket = !!(marketOdds?.overOdds);
                  const marketEdge = hasMarket
                    ? result.probability - americanToImplied(marketOdds!.overOdds!) * 100
                    : null;
                  return (
                    <div className={`grid gap-3 ${hasMarket ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" : "grid-cols-2 sm:grid-cols-4"}`}>
                      <StatCard
                        title="Expected Total"
                        value={result.expectedTotal.toFixed(1)}
                        subtitle={`Need: ${form.getValues("liveLine")}`}
                        icon={<Target className="w-4 h-4" />}
                        highlight={result.expectedTotal >= form.getValues("liveLine") ? "positive" : "negative"}
                      />
                      <StatCard
                        title="Proj. Remaining Min"
                        value={result.projectedSecondHalfMinutes.toFixed(1)}
                        subtitle={(result as any).baselineSource === "h2" ? "H2 Baseline" : "Full-Game Baseline"}
                        icon={<Clock className="w-4 h-4" />}
                        highlight="neutral"
                      />
                      <StatCard
                        title="Defense vs Pos"
                        value={`${result.defenseMultiplier > 1 ? "+" : ""}${((result.defenseMultiplier - 1) * 100).toFixed(1)}%`}
                        subtitle="Opp allow vs position"
                        icon={<ShieldAlert className="w-4 h-4" />}
                        highlight={result.defenseMultiplier > 1 ? "positive" : "negative"}
                      />
                      <StatCard
                        title="Game Pace"
                        value={result.paceLabel}
                        subtitle={`${result.teamPace} vs ${result.opponentPace} pos/48`}
                        icon={<Zap className="w-4 h-4" />}
                        highlight={result.paceMultiplier >= 1.02 ? "positive" : result.paceMultiplier <= 0.97 ? "negative" : "neutral"}
                      />
                      {hasMarket && marketEdge !== null && (
                        <StatCard
                          title="vs Market"
                          value={`${marketEdge > 0 ? "+" : ""}${marketEdge.toFixed(1)}%`}
                          subtitle="Model vs implied odds"
                          icon={<TrendingUp className="w-4 h-4" />}
                          highlight={marketEdge > 1 ? "positive" : marketEdge < -1 ? "negative" : "neutral"}
                        />
                      )}
                    </div>
                  );
                })()}

                {/* CLV Alert — shown below result after Calculate when a sportsbook is selected */}
                {selectedSportsbook && selectedSportsbook !== "manual" && oddsData && result && (() => {
                  const selected = (oddsData as Record<string, import("@shared/schema").OddsLine>)[selectedSportsbook];
                  if (!selected?.overOdds) return null;
                  const overImplied = americanToImplied(selected.overOdds) * 100;
                  const overEdge = result.probability - overImplied;
                  const underEdge = (100 - result.probability) - americanToImplied(selected.underOdds ?? -110) * 100;
                  const bestEdge = overEdge >= underEdge ? { side: "Over", edge: overEdge } : { side: "Under", edge: underEdge };
                  const isPositive = bestEdge.edge > 0;
                  const absEdge = Math.abs(bestEdge.edge);
                  const valueLabel = absEdge >= 6 ? "Strong" : absEdge >= 3 ? "Moderate" : "Slight";
                  const sbName = SPORTSBOOK_LABELS[selectedSportsbook] ?? selectedSportsbook;
                  const hasMovement = selected.lineMovement !== undefined && selected.lineMovement !== 0;
                  const dropped = (selected.lineMovement ?? 0) < 0;
                  const clvDelta = Number(selected.line) - Number(form.getValues("liveLine"));
                  const clvFmt = (n: number) => n % 1 === 0 ? String(Math.round(n)) : n.toFixed(1);
                  const clvLabel = clvDelta === 0 ? "Even" : `${clvDelta > 0 ? "+" : ""}${clvFmt(clvDelta)} pt`;
                  const clvPositive = clvDelta > 0;
                  return (
                    <div data-testid="clv-alert" className={`rounded-xl border p-4 flex gap-3 items-start animate-fade-in-up ${
                      isPositive ? "bg-emerald-500/10 border-emerald-500/30" : "bg-red-500/10 border-red-500/30"
                    }`}>
                      <div className={`mt-0.5 flex-shrink-0 font-bold text-lg ${isPositive ? "text-emerald-400" : "text-red-400"}`}>
                        {isPositive ? "▲" : "▼"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <h4 className={`text-sm font-semibold ${isPositive ? "text-emerald-400" : "text-red-400"}`}>
                            {valueLabel} {bestEdge.side} CLV
                          </h4>
                          <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                            clvDelta === 0
                              ? "bg-secondary text-muted-foreground"
                              : clvPositive
                                ? "bg-emerald-500/20 text-emerald-300"
                                : "bg-red-500/20 text-red-300"
                          }`}>
                            {clvLabel}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Model <strong className="text-foreground">{result.probability.toFixed(1)}%</strong>
                          {" vs "}{sbName} <strong className="text-foreground">{formatOdds(selected.overOdds)}</strong>
                        </p>
                        <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                          {absEdge >= 6 ? "High conviction edge vs market."
                            : absEdge >= 3 ? "Solid discrepancy — model sees value."
                            : isPositive ? "Slight edge — use as tiebreaker."
                            : "Model trails implied — line may be priced in."}
                          {hasMovement && selected.openLine !== undefined && (
                            <span> Line {dropped ? "▼" : "▲"}{Math.abs(selected.lineMovement!)} from open ({selected.openLine}→{selected.line}).</span>
                          )}
                        </p>
                      </div>
                    </div>
                  );
                })()}

                {/* Share prompt — shown on all results */}
                <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 flex flex-col gap-3 animate-fade-in-up">
                  <div>
                    <p className="text-xs font-semibold text-foreground mb-2">🚨 Live Edge Detected</p>
                    <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">{tweetSnippet}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      data-testid="button-tweet-pick"
                      onClick={() => window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetSnippet)}`, "_blank", "noopener,noreferrer")}
                      className="flex-1 flex items-center justify-center gap-2 text-sm font-bold py-2.5 px-4 rounded-xl bg-black text-white hover:bg-zinc-800 active:scale-95 transition-all"
                    >
                      <SiX className="w-4 h-4" />
                      Tweet this pick
                    </button>
                    <button
                      data-testid="button-copy-pick"
                      onClick={() => {
                        navigator.clipboard.writeText(tweetSnippet);
                        setCopiedPick(true);
                        setTimeout(() => setCopiedPick(false), 2000);
                      }}
                      className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-2.5 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                    >
                      {copiedPick ? <><Check className="w-3.5 h-3.5" /></> : <><Copy className="w-3.5 h-3.5" /></>}
                    </button>
                  </div>
                </div>

                {/* Foul Alert */}
                {form.getValues("halftimeFouls") >= 3 && (
                  <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-4 flex gap-3 items-start">
                    <AlertTriangle className="w-5 h-5 text-destructive mt-0.5 flex-shrink-0" />
                    <div>
                      <h4 className="text-sm font-semibold text-destructive">Foul Trouble Alert</h4>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {form.getValues("halftimeFouls")} fouls at half — projected 2H minutes are heavily discounted (
                        {form.getValues("halftimeFouls") >= 4 ? "55%" : "30%"} reduction). Bench time likely.
                      </p>
                    </div>
                  </div>
                )}

                {/* Pace Note */}
                {form.getValues("halftimeScore") && (
                  <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex gap-3 items-start">
                    <Zap className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <h4 className="text-sm font-semibold text-yellow-600 dark:text-yellow-400">Live Pace Active</h4>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Score {form.getValues("halftimeScore")} blended with team history → {result.paceLabel.toLowerCase()}{" "}
                        game ({((result.paceMultiplier - 1) * 100).toFixed(1)}% vs league avg).
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* RIGHT: Parlay Slip — desktop side column */}
          {showParlay && !isMobile && (
            <div className="lg:col-span-3">
              <div className="bg-card border border-border rounded-xl p-4 sticky top-20 overflow-y-auto relative" style={{ maxHeight: "calc(100dvh - 6rem)" }}>
                <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-primary to-transparent rounded-t-xl" />
                <ParlaySlip
                  picks={parlayPicks}
                  onRemove={(idx) => setParlayPicks((prev) => prev.filter((_, i) => i !== idx))}
                  onClear={() => { setParlayPicks([]); setShowParlay(false); }}
                  injuredPlayerNames={injuredPlayerNames}
                />
              </div>
            </div>
          )}
        </div> : null}

        {/* 2H Plays Sub-Tab Content */}
        {activeTab === "calculator" && nbaSubTab === "halftime" && (
          <div
            ref={halftimeSectionRef}
            style={{ scrollMarginTop: "80px" }}
            className={showParlay && !isMobile ? "flex items-start gap-5" : "space-y-4"}
          >
            <div className={showParlay && !isMobile ? "bg-card border border-border rounded-xl p-5 flex-1 min-w-0" : "bg-card border border-border rounded-xl p-5"}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  {(() => {
                    // Phase 8 — UI count must reflect detected eligible games
                    // even when 0 plays are returned. Fall back to the rendered
                    // group count when the server hasn't sent eligibleGames yet.
                    const playCount = (halftimePlaysData?.plays ?? []).length;
                    const serverEligible = halftimePlaysData?.eligibleGames;
                    const eligibleCount = typeof serverEligible === "number"
                      ? serverEligible
                      : visibleHalftimeGroups.length;
                    return (
                      <>
                        <h2 className="text-lg font-semibold flex items-center gap-2 flex-wrap">
                          <Star className="w-5 h-5 text-primary" />
                          2H Plays —{" "}
                          <span
                            data-testid="text-halftime-play-count"
                            className={halftimeCountPulse ? "halftime-count-pulse" : ""}
                            style={{ display: "inline-block", color: "hsl(var(--brand-accent))" }}
                            key={`p-${playCount}`}
                          >
                            {playCount}
                          </span>
                          {" "}play{playCount !== 1 ? "s" : ""}
                          <span
                            data-testid="text-halftime-count"
                            className="text-sm font-normal text-muted-foreground"
                            key={`g-${eligibleCount}`}
                          >
                            · {eligibleCount} game{eligibleCount !== 1 ? "s" : ""} eligible
                          </span>
                          {Math.max(1, Math.ceil(visibleHalftimeGroups.length / 4)) > 1 && (
                            <span className="text-sm font-normal text-muted-foreground">
                              · Page {currentHalftimePage} of {Math.max(1, Math.ceil(visibleHalftimeGroups.length / 4))}
                            </span>
                          )}
                        </h2>
                        <p className="text-xs text-muted-foreground mt-1">
                          Top plays by probability edge across all halftime games. Includes overs and unders.
                        </p>
                      </>
                    );
                  })()}
                </div>
                <button
                  onClick={() => refetchHalftimePlays()}
                  disabled={isHalftimePlaysLoading}
                  data-testid="button-refresh-halftime"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary border border-border text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isHalftimePlaysLoading ? "animate-spin" : ""}`} />
                  Refresh
                </button>
              </div>

              {/* Filters */}
              <div className="flex flex-wrap gap-y-2 gap-x-4 mb-4">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-muted-foreground font-medium shrink-0">Prop:</span>
                  <div className="flex gap-1 flex-wrap">
                    {[
                      { value: "all", label: "All" },
                      { value: "points", label: "PTS" },
                      { value: "rebounds", label: "REB" },
                      { value: "assists", label: "AST" },
                      { value: "threes", label: "3PM" },
                      { value: "steals", label: "STL" },
                      { value: "blocks", label: "BLK" },
                      { value: "combo", label: "Combos" },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        data-testid={`slate-filter-prop-${opt.value}`}
                        onClick={() => setSlateFilterProp(opt.value)}
                        className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                          slateFilterProp === opt.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground font-medium shrink-0">Confidence:</span>
                  <div className="flex gap-1 flex-wrap">
                    {[
                      { value: "all", label: "All" },
                      { value: "elite", label: "Elite ≥85%" },
                      { value: "strong", label: "Strong 70–84%" },
                      { value: "value", label: "Value 60–69%" },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        data-testid={`slate-filter-prob-${opt.value}`}
                        onClick={() => setSlateFilterProb(opt.value)}
                        className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                          slateFilterProb === opt.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Book filter */}
              <div className="flex items-center gap-2 mb-3 overflow-x-auto" style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}>
                <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider shrink-0">Book:</span>
                <div className="flex gap-1 flex-nowrap">
                  {(() => {
                    const allPlaysForCount = halftimePlaysData?.plays ?? [];
                    return BOOK_OPTIONS.map(opt => {
                      const count = opt.key === "all" ? null : getBookCount(allPlaysForCount, opt.key);
                      const isZero = count !== null && count === 0;
                      const isSelected = nbaBookFilter === opt.key;
                      return (
                        <button
                          key={opt.key}
                          data-testid={`book-filter-${opt.key}`}
                          onClick={() => setNbaBookFilter(opt.key)}
                          className={`text-xs px-2.5 py-0.5 rounded-full border transition-colors whitespace-nowrap ${
                            isZero ? "opacity-40" : ""
                          } ${
                            isSelected
                              ? "bg-foreground text-background border-foreground font-bold"
                              : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                          }`}
                        >
                          {opt.key === "all" ? "All" : count !== null ? `${opt.abbr} · ${count}` : opt.abbr}
                        </button>
                      );
                    });
                  })()}
                </div>
              </div>

              {/* Loading */}
              {isHalftimePlaysLoading && (
                <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Calculating best plays…</span>
                </div>
              )}

              {/* No halftime games message */}
              {!isHalftimePlaysLoading && halftimePlaysData?.message && halftimePlaysData.plays.length === 0 && (
                <div className="text-center py-12 text-muted-foreground">
                  <Star className="w-8 h-8 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">{halftimePlaysData.message}</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">
                    {(halftimePlaysData?.eligibleGames ?? 0) > 0
                      ? "2H lines / engine output will appear automatically."
                      : "Check back when games are at halftime."}
                  </p>
                </div>
              )}

              {/* No data at all */}
              {!isHalftimePlaysLoading && !halftimePlaysData && (
                <div className="text-center py-12 text-muted-foreground">
                  <Star className="w-8 h-8 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No halftime plays available.</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Click Refresh to check for halftime games.</p>
                </div>
              )}

              {/* Per-game groups — always rendered when data available; empty state handled inside */}
              {!isHalftimePlaysLoading && halftimePlaysData && (() => {
                const GAMES_PER_PAGE = 4;
                const totalPages = Math.max(1, Math.ceil(visibleHalftimeGroups.length / GAMES_PER_PAGE));
                const pageStart = (currentHalftimePage - 1) * GAMES_PER_PAGE;
                const pageGroups = visibleHalftimeGroups.slice(pageStart, pageStart + GAMES_PER_PAGE);
                const sourcePlays = halftimePlaysData?.plays ?? [];
                const renderedPlays = pageGroups.flatMap(g => g.plays ?? []);

                // [QUICK_VIEW_SOURCE_AUDIT] — proves source-vs-render independence
                // renderedRows can be > 0 even when secondHalfMarkets is 0 (absence is valid)
                console.log("[QUICK_VIEW_SOURCE_AUDIT]", {
                  boxScoreRows: visibleHalftimeGroups.length,
                  halftimeGames: visibleHalftimeGroups.length,
                  secondHalfMarkets: sourcePlays.filter((p: any) => p.lineSource === "odds_api").length,
                  renderedRows: renderedPlays.length,
                });

                // [QUICK_VIEW_RENDER_ASSERT] — success condition for Task #93
                console.log("[QUICK_VIEW_RENDER_ASSERT]", {
                  inputGames: visibleHalftimeGroups.length,
                  renderedGames: pageGroups.length,
                  renderedCount: renderedPlays.length,
                });

                // ── Transform stage logs: [HT_STAGE_X] — input/output/OVER/UNDER at each step ──
                // Stage 2: filterPlay (stat type + probability tier filter)
                const stage2Plays = sourcePlays.filter(filterPlay);
                console.log("[HT_STAGE_2_FILTER]", {
                  input: sourcePlays.length,
                  output: stage2Plays.length,
                  over: stage2Plays.filter((p: any) => p.betDirection === "over").length,
                  under: stage2Plays.filter((p: any) => p.betDirection === "under").length,
                  activeFilter: `prop=${slateFilterProp} prob=${slateFilterProb}`,
                });

                // Stage 3: filterByBook (book provider filter)
                const stage3Plays = filterByBook(stage2Plays, nbaBookFilter);
                console.log("[HT_STAGE_3_BOOK]", {
                  input: stage2Plays.length,
                  output: stage3Plays.length,
                  over: stage3Plays.filter((p: any) => p.betDirection === "over").length,
                  under: stage3Plays.filter((p: any) => p.betDirection === "under").length,
                  bookFilter: nbaBookFilter,
                });

                // Stage 4: visibleEdgeLimit (free-user play cap per group)
                const stage4Plays = isFreeUser ? stage3Plays.slice(0, visibleEdgeLimit) : stage3Plays;
                console.log("[HT_STAGE_4_LIMIT]", {
                  input: stage3Plays.length,
                  output: stage4Plays.length,
                  over: stage4Plays.filter((p: any) => p.betDirection === "over").length,
                  under: stage4Plays.filter((p: any) => p.betDirection === "under").length,
                  limited: isFreeUser,
                  limit: visibleEdgeLimit,
                });

                // Stage 5: pagination slice (current page only)
                const stage5Plays = pageGroups.flatMap(g => g.plays ?? []);
                console.log("[HT_STAGE_5_PAGE]", {
                  input: renderedPlays.length,
                  output: stage5Plays.length,
                  over: stage5Plays.filter((p: any) => p.betDirection === "over").length,
                  under: stage5Plays.filter((p: any) => p.betDirection === "under").length,
                  page: currentHalftimePage,
                  totalPages,
                });

                const totalSlateEdges = visibleHalftimeGroups.reduce((sum, g) => sum + filterByBook(g.plays.filter(filterPlay), nbaBookFilter).length, 0);
                const totalVisibleEdges = visibleHalftimeGroups.reduce((sum, g) => {
                  const filtered = filterByBook(g.plays.filter(filterPlay), nbaBookFilter);
                  return sum + Math.min(filtered.length, isFreeUser ? visibleEdgeLimit : filtered.length);
                }, 0);
                const totalLockedEdges = isFreeUser ? totalSlateEdges - totalVisibleEdges : 0;

                return (
                  <div className={isSmallScreen ? "pb-20" : "pb-0"}>
                    {isFreeUser && totalSlateEdges > 0 && (
                      <div data-testid="slate-edge-counter" className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 mb-5 flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-primary text-lg">📊</span>
                          <span className="text-sm font-semibold text-foreground">
                            {totalSlateEdges} prop edge{totalSlateEdges !== 1 ? "s" : ""} detected tonight
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-green-400 font-medium">{totalVisibleEdges} showing</span>
                          {totalLockedEdges > 0 && (
                            <span className="text-amber-400 font-medium">🔒 {totalLockedEdges} locked</span>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="space-y-8">
                      {pageGroups.map((group) => {
                        const isExiting = !!exitingGames[group.gameId];
                        const gameUnlocked = !isFreeUser || unlockedGameIds.has(group.gameId);
                        const groupFiltered = filterByBook(group.plays.filter(filterPlay), nbaBookFilter);
                        const isGameUnlocking = unlocking2hGame === group.gameId;
                        const playsRemaining = Math.max(0, 3 - playsUsed);
                        return (
                          <div
                            key={group.gameId}
                            className="relative"
                            style={{
                              animation: isExiting ? "halftimeExit 2.5s ease forwards" : "none",
                              border: isExiting ? "1px solid hsl(var(--brand-accent) / 0.3)" : "1px solid transparent",
                              borderRadius: 12,
                              transition: "border-color 200ms ease",
                            }}
                          >
                            {/* Inner content — dims when exiting */}
                            <div style={{ opacity: isExiting ? 0.2 : 1, transition: "opacity 200ms ease" }}>
                              {/* Game header */}
                              <div className="flex items-center gap-3 mb-3">
                                <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                                  <span data-testid={`text-game-away-${group.gameId}`}>{group.awayTeamAbbr}</span>
                                  <span className="font-bold" style={{ color: "#ffffff" }}>{group.awayScore}</span>
                                  <span className="text-muted-foreground font-normal">–</span>
                                  <span className="font-bold" style={{ color: "#ffffff" }}>{group.homeScore}</span>
                                  <span data-testid={`text-game-home-${group.gameId}`}>{group.homeTeamAbbr}</span>
                                </div>
                                <span
                                  className="text-xs font-semibold rounded-full"
                                  style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b", padding: "2px 12px" }}
                                >HALFTIME</span>
                                {gameUnlocked && (
                                  <span className="text-xs text-muted-foreground ml-auto">{group.plays.length} plays</span>
                                )}
                              </div>

                              {/* Lock gate for free users */}
                              {!gameUnlocked && (
                                <div className="rounded-xl border border-border bg-muted/20 p-8 flex flex-col items-center gap-4 text-center">
                                  <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                                    <Lock className="w-6 h-6 text-primary" />
                                  </div>
                                  <div>
                                    <p className="text-sm font-bold text-foreground">View 2H Analysis — {group.plays.length} plays found</p>
                                    <p className="text-xs text-muted-foreground mt-1">Unlocking uses 1 of your {3 - playsRemaining} / 3 daily plays. Resets tomorrow.</p>
                                  </div>
                                  {playsRemaining > 0 && (
                                    <button
                                      data-testid={`button-unlock-2h-${group.gameId}`}
                                      onClick={() => unlock2hGame(group.gameId)}
                                      disabled={isGameUnlocking}
                                      className="px-5 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors disabled:opacity-60 flex items-center gap-2"
                                    >
                                      {isGameUnlocking && <Loader2 className="w-4 h-4 animate-spin" />}
                                      {isGameUnlocking ? "Unlocking…" : `View ${group.plays.length} Plays — 1 Free Play`}
                                    </button>
                                  )}
                                  {playsRemaining === 0 && (
                                    <button
                                      data-testid="button-halftime-upgrade"
                                      onClick={() => { setUpgradeModalState({ playsUsed: user?.playsUsedToday ?? 0, limit: 3 }); setShowUpgradeModal(true); }}
                                      className="px-5 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors"
                                    >
                                      View Plans →
                                    </button>
                                  )}
                                </div>
                              )}

                              {/* Edge summary line for free users */}
                              {gameUnlocked && isFreeUser && groupFiltered.length > 0 && (() => {
                                const totalEdges = groupFiltered.length;
                                const lockedEdges = Math.max(0, totalEdges - visibleEdgeLimit);
                                return (
                                  <div data-testid={`text-edge-summary-${group.gameId}`} className="flex items-center gap-2 mb-3 text-xs text-muted-foreground">
                                    <span>{totalEdges} edges detected</span>
                                    <span className="text-muted-foreground/40">·</span>
                                    <span>{Math.min(totalEdges, visibleEdgeLimit)} showing</span>
                                    {lockedEdges > 0 && (
                                      <>
                                        <span className="text-muted-foreground/40">·</span>
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.25)", color: "#f59e0b" }}>
                                          <Lock className="w-3 h-3" /> {lockedEdges} locked
                                        </span>
                                      </>
                                    )}
                                  </div>
                                );
                              })()}

                              {/* Unlocked plays grid */}
                              {gameUnlocked && groupFiltered.length === 0 && (() => {
                                const bookOpt = BOOK_OPTIONS.find(b => b.key === nbaBookFilter);
                                const isBookCausing = nbaBookFilter !== "all" && filterByBook(group.plays.filter(filterPlay), "all").length > 0;
                                if (isBookCausing) {
                                  return (
                                    <div className="text-center py-8 flex flex-col items-center gap-2">
                                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                                      <p className="text-sm font-semibold" style={{ color: "#a1a1aa" }}>{bookOpt?.label ?? "Selected book"} lines not yet posted</p>
                                      <p className="text-xs" style={{ color: "#71717a" }}>Props may not be available at this book for this game yet</p>
                                      <button
                                        data-testid="button-show-all-books"
                                        onClick={() => setNbaBookFilter("all")}
                                        className="mt-1 text-xs px-4 py-1.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
                                      >
                                        Show All Books
                                      </button>
                                    </div>
                                  );
                                }
                                // If the engine has plays but filters hide all of them,
                                // fall back to the lowest available tier (all unfiltered plays)
                                // rather than showing a blank empty state.
                                if (group.plays.length > 0) {
                                  const fallbackPlays = filterByBook(group.plays, "all");
                                  if (fallbackPlays.length > 0) {
                                    return (
                                      <div>
                                        <div className="flex items-center justify-between mb-2">
                                          <p className="text-xs text-muted-foreground/70 italic">Showing all available plays — no plays match current filters.</p>
                                          <button
                                            data-testid="button-clear-filters-fallback"
                                            onClick={() => { setSlateFilterProp("all"); setSlateFilterProb("all"); setNbaBookFilter("all"); }}
                                            className="text-xs text-primary hover:underline"
                                          >
                                            Clear filters
                                          </button>
                                        </div>
                                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                          {fallbackPlays.slice(0, isFreeUser ? visibleEdgeLimit : fallbackPlays.length).map((play: any, idx: number) => {
                                            const isLocked = isFreeUser && idx >= visibleEdgeLimit;
                                            return (
                                              <div
                                                key={`fallback-${play.playerId ?? play.playerName}-${play.statType}`}
                                                data-testid={`play-card-fallback-${idx}`}
                                                className={`rounded-xl border border-border/60 bg-card p-3 ${isLocked ? "opacity-50 pointer-events-none" : ""}`}
                                              >
                                                <p className="text-xs font-semibold text-foreground">{play.playerName}</p>
                                                <p className="text-[10px] text-muted-foreground">{play.statType} · {play.betDirection?.toUpperCase()} {play.line}</p>
                                                <p className="text-xs font-bold text-primary mt-1">{Math.round(play.probability)}%</p>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    );
                                  }
                                }
                                const activePropFilter = slateFilterProp !== "all";
                                const activeConfFilter = slateFilterProb !== "all";
                                const filterDesc = [
                                  activePropFilter ? `prop "${slateFilterProp}"` : null,
                                  activeConfFilter ? `confidence "${slateFilterProb}"` : null,
                                ].filter(Boolean).join(" + ");
                                return (
                                  <div className="text-center py-8 text-muted-foreground">
                                    <p className="text-sm font-medium">No plays match your current filters.</p>
                                    {filterDesc && <p className="text-xs mt-1 text-muted-foreground/60">Active: {filterDesc}</p>}
                                    <button onClick={() => { setSlateFilterProp("all"); setSlateFilterProb("all"); setNbaBookFilter("all"); }} className="text-xs text-primary mt-2 hover:underline">Clear all filters</button>
                                  </div>
                                );
                              })()}
                              {gameUnlocked && groupFiltered.length > 0 && (() => {
                                const lockedEdges = Math.max(0, groupFiltered.length - visibleEdgeLimit);
                                const highestEdgeIdx = groupFiltered.slice(0, isFreeUser ? visibleEdgeLimit : groupFiltered.length).reduce((bestIdx: number, play: any, idx: number, arr: any[]) => play.edge > arr[bestIdx].edge ? idx : bestIdx, 0);
                                return (
                                <>
                                {isFreeUser && (
                                  <p data-testid="model-credibility-line" className="text-xs text-muted-foreground/70 italic mb-2">
                                    LiveLocks typically detects 20+ prop edges per NBA game before sportsbooks adjust.
                                  </p>
                                )}
                                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                  {groupFiltered.map((play: any, idx: number) => {
                                    if (import.meta.env.DEV && play.probability == null) {
                                      console.error("Missing engine probability for play", play);
                                    }
                                    // NBA 2H Goldmaster Repair — degraded halftime cards
                                    // (stale line OR derived 2H fallback) ARE allowed to render.
                                    // Server caps confidence at 72 for these and the card UI
                                    // shows the "Stale Line" / derived badge so the user can
                                    // judge accordingly. Removed prior client-side suppression.
                                    const isLocked = isFreeUser && idx >= visibleEdgeLimit;
                                    const isOver = play.betDirection === "over";
                                    const isInjured = !isLocked && injuredPlayerNames.has(play.playerName.toLowerCase());
                                    const statLabel = STAT_TYPES.find(s => s.value === play.statType)?.label ?? play.statType;
                                    const hasLiveLine = play.lineSource === "odds_api";
                                    const isHighestEdge = !isLocked && idx === highestEdgeIdx && groupFiltered.slice(0, isFreeUser ? visibleEdgeLimit : groupFiltered.length).length > 1;
                                    return (
                                      <div
                                        key={idx}
                                        data-testid={`halftime-play-${idx}`}
                                        className={`rounded-xl border p-4 space-y-2 relative cursor-pointer transition-all ${
                                          isLocked
                                            ? "border-amber-500/20 bg-secondary/20 hover:border-amber-500/40"
                                            : isHighestEdge
                                              ? "border-amber-500/50 bg-amber-500/5 hover:border-amber-500/70 ring-1 ring-amber-500/20"
                                              : isInjured
                                                ? "border-red-500/40 bg-red-500/5 hover:border-red-500/60"
                                                : "border-border/60 bg-secondary/30 hover:border-primary/40 hover:bg-secondary/50"
                                        }`}
                                        style={isLocked ? { opacity: 0.75 } : undefined}
                                        onClick={() => {
                                          if (isLocked) {
                                            setUpgradeModalState({ playsUsed, limit: 3 });
                                            setShowUpgradeModal(true);
                                          } else {
                                            loadPlayInCalculator(play);
                                          }
                                        }}
                                      >
                                        {isHighestEdge && (
                                          <div data-testid={`badge-highest-edge-${idx}`} className="absolute -top-2.5 left-3 text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: "rgba(245,158,11,0.2)", border: "1px solid rgba(245,158,11,0.4)", color: "#f59e0b" }}>
                                            🔥 Highest Edge Detected
                                          </div>
                                        )}
                                        {isLocked && (
                                          <div className="absolute top-3 right-3">
                                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b" }}>
                                              Premium Edge
                                            </span>
                                          </div>
                                        )}
                                        <div className="absolute top-3 left-3 w-5 h-5 flex items-center justify-center" style={{ background: isLocked ? "#52525b" : "#1d4ed8", borderRadius: 8 }}>
                                          <span className="text-[9px] font-bold text-white leading-none">#{idx + 1}</span>
                                        </div>
                                        <div className={`flex items-start justify-between gap-2 pl-7 ${isLocked ? "pr-24" : ""}`}>
                                          <div>
                                            <div className="font-semibold text-sm text-foreground">{play.playerName}</div>
                                            <div className="text-xs text-muted-foreground">{play.team} vs {play.opponent}</div>
                                            {isInjured && (
                                              <span className="text-xs text-red-400 font-semibold flex items-center gap-0.5 mt-0.5">
                                                <AlertTriangle className="w-3 h-3" /> Injured
                                              </span>
                                            )}
                                          </div>
                                          <div className="text-right flex-shrink-0">
                                            {isLocked ? (
                                              <>
                                                <div className="text-xl font-bold font-mono text-muted-foreground/40 flex items-center justify-end gap-1">
                                                  <Lock className="w-4 h-4" />
                                                </div>
                                                <div className="text-[9px] font-semibold text-muted-foreground/40">
                                                  {isOver ? "Over %" : "Under %"}
                                                </div>
                                                <div className="text-xs text-muted-foreground/40 flex items-center justify-end gap-0.5">
                                                  Edge: <Lock className="w-3 h-3" />
                                                </div>
                                              </>
                                            ) : (
                                            <>
                                            {(() => {
                                              const displayProb = typeof play.probability === "number"
                                                ? Math.round(play.probability * 10) / 10
                                                : 0;
                                              const probColor =
                                                displayProb >= 85 ? (play.betDirection === "under" ? "text-red-400" : "text-green-400") :
                                                displayProb >= 70 ? "text-yellow-400" :
                                                displayProb >= 60 ? "text-brand" : "text-muted-foreground";
                                              return (
                                                <>
                                                  <div className={`text-xl font-bold font-mono ${probColor}`}>
                                                    {displayProb.toFixed(1)}%
                                                  </div>
                                                  <div className="text-[9px] font-semibold text-muted-foreground">
                                                    {isOver ? "Over %" : "Under %"}
                                                  </div>
                                                </>
                                              );
                                            })()}
                                            <div className="text-xs text-muted-foreground">
                                              Edge: +{play.edge.toFixed(1)}%
                                            </div>
                                            </>
                                            )}
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <span
                                            className="text-xs font-mono px-2 py-0.5 rounded font-bold"
                                            style={isOver
                                              ? { background: "hsl(var(--brand-accent) / 0.15)", border: "1px solid hsl(var(--brand-accent) / 0.3)", color: "hsl(var(--brand-accent))" }
                                              : { background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444" }
                                            }
                                          >
                                            {statLabel} {isOver ? "O" : "U"}{play.line}
                                          </span>
                                          <span
                                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                                            style={hasLiveLine
                                              ? { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#a1a1aa" }
                                              : { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#71717a" }
                                            }
                                          >
                                            {hasLiveLine
                                              ? "Live Line"
                                              : play.isDerivedLine
                                                ? "Derived Line"
                                                : "Season Avg"}
                                          </span>
                                          {/* Stale Line badge ONLY for genuinely stale book lines.
                                              Derived fallback cards already get the dedicated
                                              "Derived" badge below — surfacing both creates
                                              contradictory provenance text. */}
                                          {play.isDegraded && !play.isDerivedLine && (
                                            <TooltipProvider>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <span
                                                    data-testid={`badge-stale-line-${idx}`}
                                                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded cursor-help"
                                                    style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b" }}
                                                  >
                                                    Stale Line
                                                  </span>
                                                </TooltipTrigger>
                                                <TooltipContent side="top" className="max-w-xs text-xs">
                                                  Odds are from the last successful fetch and may be up to 5 minutes old. The live feed was unavailable when this play was generated.
                                                </TooltipContent>
                                              </Tooltip>
                                            </TooltipProvider>
                                          )}
                                          {play.isDerivedLine && !isLocked && (
                                            <TooltipProvider>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <span
                                                    data-testid={`badge-derived-line-${idx}`}
                                                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded cursor-help"
                                                    style={{ background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.3)", color: "#a78bfa" }}
                                                  >
                                                    Derived
                                                  </span>
                                                </TooltipTrigger>
                                                <TooltipContent side="top" className="max-w-xs text-xs">
                                                  Line projected from live scoring pace — no direct book line available.
                                                </TooltipContent>
                                              </Tooltip>
                                            </TooltipProvider>
                                          )}
                                          {play.sportsbook && !isLocked && (
                                            <span
                                              data-testid={`badge-sportsbook-${idx}`}
                                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                                              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "#71717a" }}
                                            >
                                              {play.sportsbook}
                                            </span>
                                          )}
                                          {play.signalTimestamp && !isLocked && (
                                            <span
                                              data-testid={`text-signal-time-${idx}`}
                                              className="text-[10px] text-muted-foreground/50"
                                            >
                                              {new Date(play.signalTimestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                                            </span>
                                          )}
                                          {isLocked ? (
                                            <>
                                              <span className="text-xs" style={{ color: "#71717a" }}>
                                                Proj: {play.expectedTotal?.toFixed(1)}
                                              </span>
                                              <span className="text-xs text-muted-foreground/40 font-mono">
                                                🔒 Probability & Edge locked
                                              </span>
                                            </>
                                          ) : (
                                          <span className="text-xs" style={{ color: play.halftimeStat > 0 ? "#71717a" : "#52525b" }}>
                                            H1: {play.halftimeStat} · Proj: {play.expectedTotal?.toFixed(1)}
                                          </span>
                                          )}
                                          {idx === 0 && !isLocked && <span data-testid="hint-tap-verify" className="text-[10px] text-muted-foreground/50 italic">Tap to cross-check in calculator →</span>}
                                        </div>
                                        {isLocked ? (
                                          <>
                                            <div className="text-[10px] text-amber-500/80 flex items-center gap-1 pt-1 border-t border-border/30">
                                              🔒 Premium Edge — Upgrade to unlock projection & probability
                                            </div>
                                            <div data-testid={`text-upgrade-label-${idx}`} className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold text-amber-400/80">
                                              <Lock className="w-3 h-3" /> Upgrade to unlock
                                            </div>
                                          </>
                                        ) : (
                                        (() => {
                                          const inParlayIdx = parlayPicks.findIndex(p =>
                                            p.playerId === play.playerId &&
                                            p.statType === play.statType &&
                                            p.betDirection === play.betDirection
                                          );
                                          const isInParlay = inParlayIdx !== -1;
                                          return (
                                            <button
                                              type="button"
                                              data-testid={`button-add-halftime-play-${idx}`}
                                              disabled={!isInParlay && parlayPicks.length >= 10}
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                if (isInParlay) {
                                                  setParlayPicks(prev => prev.filter((_, i) => i !== inParlayIdx));
                                                } else {
                                                  const pick: ParlayPickInput = {
                                                    playerId: play.playerId,
                                                    playerName: play.playerName,
                                                    playerTeam: play.team,
                                                    statType: play.statType,
                                                    line: play.line,
                                                    probability: play.probability,
                                                    betDirection: play.betDirection,
                                                    sportsbook: "",
                                                    oddsAmerican: 0,
                                                    gameId: play.gameId,
                                                  };
                                                  setParlayPicks(prev => [...prev, pick]);
                                                  setShowParlay(true);
                                                }
                                              }}
                                              className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 ${
                                                !isInParlay ? "bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20" : ""
                                              }`}
                                              style={isInParlay
                                                ? { background: "hsl(var(--brand-accent) / 0.15)", border: "1px solid hsl(var(--brand-accent) / 0.3)", color: "hsl(var(--brand-accent))" }
                                                : undefined}
                                            >
                                              {isInParlay ? <>✓ Added</> : <><Plus className="w-3.5 h-3.5" />Add to Parlay</>}
                                            </button>
                                          );
                                        })()
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                                {isFreeUser && lockedEdges > 0 && (
                                  <div data-testid={`cta-unlock-all-${group.gameId}`} className="mt-4 flex flex-col items-center gap-2">
                                    <p className="text-xs text-muted-foreground">{lockedEdges} more edge{lockedEdges !== 1 ? "s" : ""} available with Pro</p>
                                    <button
                                      data-testid={`button-unlock-all-${group.gameId}`}
                                      onClick={() => { setUpgradeModalState({ playsUsed, limit: 3 }); setShowUpgradeModal(true); }}
                                      className="px-5 py-2 rounded-xl text-sm font-bold transition-colors flex items-center gap-2"
                                      style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b" }}
                                    >
                                      <Lock className="w-4 h-4" /> Unlock All Edges
                                    </button>
                                  </div>
                                )}
                                {isFreeUser && (
                                  <div
                                    data-testid={`locked-premium-section-${group.gameId}`}
                                    className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 flex items-center gap-3"
                                    style={{ filter: "blur(0px)" }}
                                  >
                                    <Lock className="w-4 h-4 text-amber-500 shrink-0" />
                                    <div className="flex-1 min-w-0">
                                      <p className="text-xs font-semibold text-amber-400">🔒 More live edges detected</p>
                                      <p className="text-[11px] text-muted-foreground mt-0.5">Upgrade to unlock full access.</p>
                                    </div>
                                    <button
                                      data-testid={`button-locked-premium-upgrade-${group.gameId}`}
                                      onClick={() => { setUpgradeModalState({ playsUsed, limit: 3 }); setShowUpgradeModal(true); }}
                                      className="text-[10px] font-bold text-amber-500 hover:text-amber-400 underline underline-offset-2 whitespace-nowrap"
                                    >
                                      Upgrade →
                                    </button>
                                  </div>
                                )}
                                </>
                                );
                              })()}
                            </div>

                            {/* Exit overlay — "2H Underway" */}
                            {isExiting && (
                              <div style={{
                                position: "absolute", inset: 0,
                                background: "rgba(10,10,10,0.85)",
                                borderRadius: "inherit", zIndex: 10,
                                display: "flex", flexDirection: "column",
                                alignItems: "center", justifyContent: "center", gap: 8,
                              }}>
                                <span className="relative flex h-2.5 w-2.5">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-400" />
                                </span>
                                <span className="text-lg font-bold" style={{ color: "hsl(var(--brand-accent))" }}>2H Underway</span>
                                <span className="font-semibold text-sm text-white">{group.awayTeamAbbr} {group.awayScore} – {group.homeScore} {group.homeTeamAbbr}</span>
                                <span className="text-xs" style={{ color: "#71717a" }}>Tracking live...</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Pagination bar — sticky on mobile, inline on desktop */}
                    {totalPages > 1 && (isSmallScreen ? (
                      <div
                        data-testid="halftime-pagination-sticky"
                        style={{
                          position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 40,
                          background: "#0a0a0a", borderTop: "1px solid #27272a",
                          padding: "12px 16px",
                          paddingBottom: "max(12px, env(safe-area-inset-bottom, 12px))",
                          display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 8,
                        }}
                      >
                        <button
                          data-testid="button-halftime-prev"
                          disabled={currentHalftimePage === 1}
                          onClick={() => {
                            setCurrentHalftimePage(p => Math.max(1, p - 1));
                            halftimeSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                          }}
                          style={{
                            minHeight: 44, background: "#181818", border: "1px solid #27272a",
                            borderRadius: 8, color: currentHalftimePage === 1 ? "#3f3f46" : "#a1a1aa",
                            pointerEvents: currentHalftimePage === 1 ? "none" : "auto",
                            fontSize: 13, fontWeight: 500, cursor: "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                          }}
                        >
                          ← Prev
                        </button>
                        <span className="text-sm font-mono text-center" style={{ color: "#71717a" }}>
                          {currentHalftimePage} of {totalPages}
                        </span>
                        <button
                          data-testid="button-halftime-next"
                          disabled={currentHalftimePage === totalPages}
                          onClick={() => {
                            setCurrentHalftimePage(p => Math.min(totalPages, p + 1));
                            halftimeSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                          }}
                          style={{
                            minHeight: 44, background: "#181818", border: "1px solid #27272a",
                            borderRadius: 8, color: currentHalftimePage === totalPages ? "#3f3f46" : "#a1a1aa",
                            pointerEvents: currentHalftimePage === totalPages ? "none" : "auto",
                            fontSize: 13, fontWeight: 500, cursor: "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                          }}
                        >
                          Next →
                        </button>
                      </div>
                    ) : (
                      <div
                        data-testid="halftime-pagination-inline"
                        style={{
                          display: "grid", gridTemplateColumns: "1fr auto 1fr",
                          alignItems: "center", gap: 8, marginTop: 24,
                        }}
                      >
                        <button
                          data-testid="button-halftime-prev"
                          disabled={currentHalftimePage === 1}
                          onClick={() => {
                            setCurrentHalftimePage(p => Math.max(1, p - 1));
                            halftimeSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                          }}
                          style={{
                            minHeight: 44, background: "#181818", border: "1px solid #27272a",
                            borderRadius: 8, color: currentHalftimePage === 1 ? "#3f3f46" : "#a1a1aa",
                            pointerEvents: currentHalftimePage === 1 ? "none" : "auto",
                            fontSize: 13, fontWeight: 500, cursor: "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                        >
                          ← Prev
                        </button>
                        <span className="text-sm font-mono text-center" style={{ color: "#71717a" }}>
                          {currentHalftimePage} of {totalPages}
                        </span>
                        <button
                          data-testid="button-halftime-next"
                          disabled={currentHalftimePage === totalPages}
                          onClick={() => {
                            setCurrentHalftimePage(p => Math.min(totalPages, p + 1));
                            halftimeSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                          }}
                          style={{
                            minHeight: 44, background: "#181818", border: "1px solid #27272a",
                            borderRadius: 8, color: currentHalftimePage === totalPages ? "#3f3f46" : "#a1a1aa",
                            pointerEvents: currentHalftimePage === totalPages ? "none" : "auto",
                            fontSize: 13, fontWeight: 500, cursor: "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                        >
                          Next →
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Parlay slip side column — halftime tab, desktop only */}
            {showParlay && !isMobile && (
              <div className="w-80 flex-shrink-0">
                <div className="bg-card border border-border rounded-xl p-4 sticky top-20 overflow-y-auto relative" style={{ maxHeight: "calc(100dvh - 6rem)" }}>
                  <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-primary to-transparent rounded-t-xl" />
                  <ParlaySlip
                    picks={parlayPicks}
                    onRemove={(idx) => setParlayPicks((prev) => prev.filter((_, i) => i !== idx))}
                    onClear={() => { setParlayPicks([]); setShowParlay(false); }}
                    injuredPlayerNames={injuredPlayerNames}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* NCAAB Tab — top plays feed always renders (real edge or fallback lean); requires Pro, All Sports, or Admin */}
        {activeTab === "ncaab" && hasNcaabAccess && (
          <NCAABAdminTab
            key={ncaabResetKey}
            isAdmin={user?.isAdmin ?? false}
            expandToGameId={expandToGameId}
            onAddToParlay={(pick) => {
              if (parlayPicks.length < 10) {
                setParlayPicks((prev) => [...prev, pick]);
                setShowParlay(true);
              }
            }}
          />
        )}

        {/* Analytics Tab — redirect to admin */}
        {activeTab === "analytics" && user?.isAdmin && (() => {
          navigate("/admin");
          return null;
        })()}

        {/* MLB Live Tab — all authenticated users (preview gated on backend) */}
        {activeTab === "mlb" && <MlbLivePage activeSubTab={mlbSubTab} />}

      </main>

      {isFreeUser && (
        <div
          data-testid="fixed-upgrade-bar"
          className="fixed bottom-0 inset-x-0 z-40 backdrop-blur bg-black/70 border-t border-white/10 flex items-center justify-center"
          style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom, 12px))", paddingTop: "12px" }}
        >
          <button
            data-testid="button-unlock-full-access-bar"
            onClick={handleUpgradeClick}
            className="px-5 py-2 rounded-lg text-sm font-bold bg-amber-500 text-black active:scale-95 transition-transform"
          >
            Start 3-Day Trial – $1
          </button>
        </div>
      )}

      {showUpgradeModal && (
        <UpgradeModal
          playsUsed={upgradeModalState.playsUsed}
          limit={upgradeModalState.limit}
          onClose={() => setShowUpgradeModal(false)}
          lockedEdgesCount={slateLockedEdgesCount}
          topLockedEdge={slateTopLockedEdge}
          currentTier={effectiveTier ?? user?.subscriptionTier ?? null}
          onUpgradeSuccess={(tier) => setLocalTier(tier)}
        />
      )}

      {user && <FeedbackModal />}

      {showManageModal && user?.subscriptionTier && (
        <ManageSubscriptionModal
          tier={user.subscriptionTier ?? null}
          status={user.subscriptionStatus ?? null}
          cancelAtPeriodEnd={user.cancelAtPeriodEnd ?? null}
          onClose={() => setShowManageModal(false)}
        />
      )}

      {/* Parlay Slip — mobile bottom sheet */}
      {showParlay && isMobile && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => setShowParlay(false)}
          />
          <div className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-card border-t border-border shadow-2xl flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-center pt-3 pb-1 flex-shrink-0">
              <div className="w-10 h-1 rounded-full bg-border" />
            </div>
            <div className="flex items-center justify-between px-4 py-2 flex-shrink-0 border-b border-border/50">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Trophy className="w-4 h-4 text-primary" />
                Parlay Slip
                {parlayPicks.length > 0 && (
                  <span className="bg-primary text-primary-foreground text-xs rounded-full w-5 h-5 flex items-center justify-center">
                    {parlayPicks.length}
                  </span>
                )}
              </div>
              <button
                data-testid="button-close-parlay-sheet"
                onClick={() => setShowParlay(false)}
                className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4">
              <ParlaySlip
                picks={parlayPicks}
                onRemove={(idx) => setParlayPicks((prev) => prev.filter((_, i) => i !== idx))}
                onClear={() => { setParlayPicks([]); setShowParlay(false); }}
                injuredPlayerNames={injuredPlayerNames}
              />
            </div>
          </div>
        </>
      )}

      {showAlertsModal && user && (
        <AlertsOnboardingModal
          onClose={() => {
            setShowAlertsModal(false);
            try { localStorage.setItem("ll_alerts_onboarded", "1"); } catch {}
          }}
          onOpenAlertsPanel={() => {
            setShowAlertsModal(false);
            try { localStorage.setItem("ll_alerts_onboarded", "1"); } catch {}
            setShowAlertsModal(true);
          }}
          hasSmsAccess={!!user.hasUnlimited || (user.isAdmin ?? false)}
          hasPhone={!!phoneInput}
        />
      )}

      {/* ── 2H Transition top toast ─────────────────────────────────────── */}
      {halfTransitionToast && (
        <div
          data-testid="toast-2h-transition"
          style={{
            position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)",
            zIndex: 50, background: "#111111", border: "1px solid #3f3f46",
            borderRadius: 10, padding: "10px 16px",
            display: "flex", alignItems: "center", gap: 8,
            boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
            animation: "fadeIn 200ms ease",
            whiteSpace: "nowrap",
          }}
        >
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
          </span>
          <span className="text-sm font-semibold" style={{ color: "hsl(var(--brand-accent))" }}>
            {halfTransitionToast.away} @ {halfTransitionToast.home}
          </span>
          <span className="text-sm" style={{ color: "#a1a1aa" }}>— 2H Underway</span>
        </div>
      )}

      {/* ── Notification History Sheet ───────────────────────────────────── */}
      <Sheet open={showHistorySheet} onOpenChange={setShowHistorySheet}>
        <SheetContent
          side="bottom"
          className="rounded-t-xl border-t border-border p-0 focus:outline-none"
          style={{ background: "#0a0a0a", maxHeight: "85vh", display: "flex", flexDirection: "column" }}
        >
          {/* Header */}
          <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b border-zinc-800 flex-shrink-0">
            <div>
              <h2 className="text-lg font-bold text-white">Notifications</h2>
              <p className="text-sm text-zinc-400 mt-0.5">Today · {notificationLog.length} alert{notificationLog.length !== 1 ? "s" : ""}</p>
            </div>
            <div className="flex items-center gap-3 mt-1">
              {/* Push toggle inline */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">Push</span>
                {pushSubscribed
                  ? <button data-testid="button-disable-push" onClick={handleDisablePush} disabled={pushLoading} className="text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200 transition-colors disabled:opacity-50">{pushLoading ? "..." : "Disable"}</button>
                  : <button data-testid="button-enable-push" onClick={handleEnablePush} disabled={pushLoading} className="text-xs text-brand underline underline-offset-2 hover:text-white transition-colors disabled:opacity-50">{pushLoading ? "..." : "Enable"}</button>
                }
                {pushSubscribed && <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />}
              </div>
              <button
                data-testid="button-alert-preferences"
                onClick={() => { setSmsModalFlow("view"); setShowSmsModal(true); }}
                className="text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200 transition-colors"
              >
                SMS Settings
              </button>
            </div>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {/* Daily summary row */}
            {notificationLog.length > 0 && (() => {
              const hits = notificationLog.filter(e => e.result === "HIT").length;
              const misses = notificationLog.filter(e => e.result === "MISS").length;
              const pending = notificationLog.filter(e => e.result === null).length;
              return (
                <div className="rounded-lg px-4 py-3 mb-1" style={{ background: "#111111", border: "1px solid #27272a" }}>
                  <p className="text-xs uppercase tracking-wider font-semibold mb-1" style={{ color: "#71717a" }}>Today's Record</p>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg font-bold" style={{ color: "hsl(var(--brand-accent))" }}>{hits}W</span>
                    <span className="text-lg font-bold text-white">–</span>
                    <span className="text-lg font-bold" style={{ color: "#ef4444" }}>{misses}L</span>
                    {pending > 0 && <span className="text-xs ml-2" style={{ color: "#71717a" }}>{pending} pending</span>}
                  </div>
                </div>
              );
            })()}

            {/* Empty state */}
            {notificationLog.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <Clock className="w-10 h-10" style={{ color: "#3f3f46" }} />
                <p className="text-sm font-semibold" style={{ color: "#71717a" }}>No alerts sent yet today</p>
                <p className="text-xs text-center" style={{ color: "#52525b" }}>High-confidence signals will appear here</p>
              </div>
            )}

            {/* Log entries */}
            {notificationLog.map((entry) => {
              const timeStr = new Date(entry.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
              const confColor = entry.confidence >= 85 ? "hsl(var(--brand-accent))" : entry.confidence >= 80 ? "#f59e0b" : "#71717a";
              return (
                <button
                  key={entry.id}
                  data-testid={`notif-log-entry-${entry.id}`}
                  className="w-full text-left rounded-lg px-4 py-3 space-y-2 transition-colors hover:bg-zinc-800/50"
                  style={{ background: "#111111", border: "1px solid #27272a" }}
                  onClick={() => {
                    setShowHistorySheet(false);
                    if (entry.gameId) {
                      if (entry.sport === "ncaab") setActiveTab("ncaab");
                      else {
                        setActiveTab("calculator");
                        setTimeout(() => setSelectedGameId(entry.gameId), 300);
                      }
                    }
                  }}
                >
                  {/* Top row: sport pill + time + result badge */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-xs font-bold px-1.5 py-0.5 rounded"
                        style={{ background: "rgba(59,130,246,0.15)", color: "#3b82f6" }}
                      >
                        {entry.sport === "nba" ? "NBA" : "NCAAB"}
                      </span>
                      <span className="text-xs" style={{ color: "#71717a" }}>{timeStr}</span>
                    </div>
                    {entry.result === null && (
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "#27272a", color: "#71717a" }}>Pending</span>
                    )}
                    {entry.result === "HIT" && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: "hsl(var(--brand-accent) / 0.15)", border: "1px solid hsl(var(--brand-accent) / 0.3)", color: "hsl(var(--brand-accent))" }}>✓ HIT</span>
                    )}
                    {entry.result === "MISS" && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444" }}>✗ MISS</span>
                    )}
                    {entry.result === "PUSH" && (
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "#27272a", border: "1px solid #3f3f46", color: "#a1a1aa" }}>— PUSH</span>
                    )}
                  </div>
                  {/* Middle: notification body */}
                  <p className="text-sm text-white leading-snug">{entry.body}</p>
                  {/* Bottom: confidence + view */}
                  <div className="flex items-center justify-between">
                    {entry.confidence > 0 && (
                      <span className="text-xs font-semibold" style={{ color: confColor }}>{entry.confidence}% confidence</span>
                    )}
                    <span className="text-xs ml-auto" style={{ color: "hsl(var(--brand-accent))" }}>View →</span>
                  </div>
                </button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── SMS Bell Modal (3 content states) ──────────────────────────────── */}
      <Dialog open={showSmsModal} onOpenChange={setShowSmsModal}>
        <DialogContent
          className="max-w-[400px] p-0 overflow-hidden rounded-xl"
          style={{ background: "#09090b", border: "1px solid #27272a" }}
        >
          {/* ── Unprompted: phone opt-in flow ── */}
          {(smsStatus === "unprompted" || smsModalFlow === "update") && (
            <div className="p-6 space-y-5">
              <DialogHeader>
                <DialogTitle className="text-white text-lg font-bold">Get Live Edge Alerts</DialogTitle>
                <DialogDescription className="sr-only">Enter your phone number to receive SMS betting edge alerts</DialogDescription>
                <p className="text-sm mt-1" style={{ color: "#71717a" }}>
                  We&apos;ll text you when the engine detects a strong edge or a significant probability shift
                </p>
              </DialogHeader>
              <div className="space-y-1.5">
                <input
                  data-testid="input-sms-phone"
                  type="tel"
                  placeholder="+1 (555) 000-0000"
                  value={smsBellInput}
                  onChange={e => { setSmsBellInput(e.target.value); setSmsBellInputError(""); }}
                  className="w-full rounded-lg px-3 py-2.5 text-sm text-white outline-none transition-colors"
                  style={{
                    background: "#18181b",
                    border: smsBellInputError ? "1px solid #ef4444" : "1px solid #3f3f46",
                  }}
                  onFocus={e => { if (!smsBellInputError) e.currentTarget.style.borderColor = "hsl(var(--brand-accent))"; }}
                  onBlur={e => { if (!smsBellInputError) e.currentTarget.style.borderColor = "#3f3f46"; }}
                />
                {smsBellInputError && (
                  <p className="text-xs" style={{ color: "#ef4444" }}>{smsBellInputError}</p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <button
                  data-testid="button-sms-enable"
                  onClick={() => {
                    if (!isValidPhone(smsBellInput)) {
                      setSmsBellInputError("Enter a valid US phone number");
                      return;
                    }
                    localStorage.setItem("smsPhone", smsBellInput);
                    setSmsStatus("opted-in");
                    setSmsModalFlow("view");
                    setShowSmsModal(false);
                    toast({ title: "✓ SMS alerts enabled", description: smsBellInput, duration: 3000 });
                  }}
                  className="w-full py-2.5 rounded-lg text-sm font-bold transition-opacity hover:opacity-90"
                  style={{ background: "hsl(var(--brand-accent))", color: "#000" }}
                >
                  Enable SMS Alerts
                </button>
                <button
                  data-testid="button-sms-no-thanks"
                  onClick={() => {
                    setSmsStatus("opted-out");
                    setShowSmsModal(false);
                  }}
                  className="w-full py-2.5 rounded-lg text-sm transition-colors"
                  style={{ background: "transparent", border: "1px solid #3f3f46", color: "#a1a1aa" }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = "#52525b")}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = "#3f3f46")}
                >
                  No thanks
                </button>
              </div>
            </div>
          )}

          {/* ── Opted-in: alerts active ── */}
          {smsStatus === "opted-in" && smsModalFlow === "view" && (
            <div className="p-6 space-y-5">
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-6 h-6" style={{ color: "#4ade80" }} />
                  <DialogTitle className="text-white text-lg font-bold">SMS Alerts Active</DialogTitle>
                </div>
                <DialogDescription className="sr-only">Your SMS alerts are enabled. You can update your number or disable alerts.</DialogDescription>
                <p className="text-sm mt-2" style={{ color: "#71717a" }}>
                  Alerts enabled for <span style={{ color: "#ffffff" }}>{localStorage.getItem("smsPhone") || smsBellInput}</span>
                </p>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <button
                  data-testid="button-sms-update-number"
                  onClick={() => setSmsModalFlow("update")}
                  className="w-full py-2.5 rounded-lg text-sm font-semibold transition-colors"
                  style={{ background: "#18181b", border: "1px solid #3f3f46", color: "#d4d4d8" }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = "#52525b")}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = "#3f3f46")}
                >
                  Update Number
                </button>
                <button
                  data-testid="button-sms-disable"
                  onClick={() => {
                    setSmsStatus("opted-out");
                    localStorage.removeItem("smsPhone");
                    setSmsBellInput("");
                    setShowSmsModal(false);
                    toast({ title: "SMS alerts disabled", duration: 3000 });
                  }}
                  className="w-full py-2.5 rounded-lg text-sm transition-colors"
                  style={{ background: "transparent", border: "1px solid #3f3f46", color: "#71717a" }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = "#52525b")}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = "#3f3f46")}
                >
                  Disable Alerts
                </button>
              </div>
            </div>
          )}

          {/* ── Opted-out: re-enable flow ── */}
          {smsStatus === "opted-out" && smsModalFlow === "view" && (
            <div className="p-6 space-y-5">
              <DialogHeader>
                <DialogTitle className="text-white text-lg font-bold">SMS Alerts Off</DialogTitle>
                <DialogDescription className="sr-only">SMS alerts are currently disabled. Enable them to receive edge alert texts.</DialogDescription>
                <p className="text-sm mt-1" style={{ color: "#71717a" }}>
                  You won&apos;t receive edge alert texts
                </p>
              </DialogHeader>
              <button
                data-testid="button-sms-re-enable"
                onClick={() => { setSmsStatus("unprompted"); setSmsModalFlow("view"); }}
                className="w-full py-2.5 rounded-lg text-sm font-bold transition-opacity hover:opacity-90"
                style={{ background: "hsl(var(--brand-accent))", color: "#000" }}
              >
                Enable Alerts
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Floating scroll-to-top button */}
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        data-testid="button-float-scroll-top"
        aria-label="Scroll to top"
        className={`fixed bottom-6 right-5 z-50 w-10 h-10 rounded-full flex items-center justify-center shadow-lg transition-all duration-300 bg-primary text-primary-foreground hover:opacity-90 active:scale-95 ${showScrollTop ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 translate-y-4 pointer-events-none"}`}
      >
        <ChevronUp className="w-5 h-5" />
      </button>

      {showSportPicker && (
        <SportPicker
          onComplete={(focus) => {
            setShowSportPicker(false);
            if (focus === "mlb") setActiveTab("mlb");
            else if (focus === "nba") setActiveTab("calculator");
          }}
        />
      )}

      {!showSportPicker && (
        <OnboardingTour
          hasCompletedOnboarding={onboardingCompleted}
          onComplete={() => setOnboardingCompleted(true)}
        />
      )}
    </div>
  );
}
