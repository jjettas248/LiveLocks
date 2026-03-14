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
import { NCAABAdminTab } from "@/components/ncaab-admin-tab";
import { AnalyticsTab } from "@/components/analytics-tab";
import MlbLivePage from "@/pages/mlb-live";
import { WelcomeBanner } from "@/components/welcome-banner";
import { AlertsOnboardingModal } from "@/components/alerts-onboarding-modal";
import { useAuth } from "@/hooks/use-auth";
import { hasProAccess } from "@/lib/tierUtils";
import { useLocation } from "wouter";
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
          style={{ width: 64, height: 64, borderRadius: 16, boxShadow: "0 0 32px rgba(0,212,170,0.35)" }}
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
              background: "#00d4aa",
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
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#00d4aa", display: "inline-block" }} />
              <span style={{ color: "#00d4aa", fontSize: 13 }}>{liveCount} game{liveCount !== 1 ? "s" : ""} live now</span>
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

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [upgradeModalState, setUpgradeModalState] = useState<{ playsUsed: number; limit: number }>({ playsUsed: 15, limit: 15 });

  const { data: players, isLoading: isPlayersLoading } = usePlayers();
  const { data: teams, isLoading: isTeamsLoading } = useTeams();
  const { data: liveGames, isLoading: isGamesLoading, refetch: refetchGames } = useLiveGames();

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
    console.log(`[RESET] Rescheduled: ${hours}:${String(minutes).padStart(2, "0")} EST (in ${Math.round(delay / 60000)}m)`);
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
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 1024);
  const [selectedSportsbook, setSelectedSportsbook] = useState<string>("manual");
  const [autoFilledFields, setAutoFilledFields] = useState<Set<string>>(new Set());
  const [showBoxScore, setShowBoxScore] = useState(true);
  const [boxScoreFilter, setBoxScoreFilter] = useState("");
  const [boxScoreSort, setBoxScoreSort] = useState<"stat" | "minutes">("stat");
  const [boxScoreSortDir, setBoxScoreSortDir] = useState<"desc" | "asc">("desc");
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [copiedPick, setCopiedPick] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const res = await apiRequest("POST", "/api/stripe/portal");
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch (err: any) {
      toast({ title: "Could not open billing portal", description: err.message, variant: "destructive" });
    } finally {
      setPortalLoading(false);
    }
  };

  const [activeTab, setActiveTab] = useState<"calculator" | "ncaab" | "analytics" | "mlb">("calculator");
  const [nbaSubTab, setNbaSubTab] = useState<"live" | "halftime">("live");
  const [expandToGameId, setExpandToGameId] = useState<string | null>(null);
  const [showWelcomeBanner, setShowWelcomeBanner] = useState(false);
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
    if (tab === "ncaab" || tab === "calculator") setActiveTab(tab as any);
    if (gameId && cardType === "game") {
      setTimeout(() => setSelectedGameId(gameId), 400);
    }
    if (params.toString()) {
      window.history.replaceState({}, "", "/");
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
      toast({ title: "Push alerts enabled!", description: "You'll be notified when plays hit ≥90% or 2H goes live." });
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
  const { data: halftimePlaysData, isLoading: isHalftimePlaysLoading, refetch: refetchHalftimePlays } = useQuery<{ plays: any[]; message?: string }>({
    queryKey: ["/api/halftime-plays"],
    refetchInterval: 60_000,
    staleTime: 45_000,
  });

  const { data: liveSignalsData } = useQuery<{ signals: any[] }>({
    queryKey: ["/api/live-signals", selectedGameId],
    enabled: !!selectedGameId && showBoxScore,
    refetchInterval: 90_000,
    staleTime: 80_000,
  });

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
    return Array.from(gameMap.values());
  }, [halftimePlaysData]);

  // ── 2-minute auto-refresh for live box score ───────────────────────────────
  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    if (selectedGameId) {
      autoRefreshRef.current = setInterval(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/live-stats", selectedGameId] });
        queryClient.invalidateQueries({ queryKey: ["/api/live-signals", selectedGameId] });
        setLastRefreshed(new Date());
        if (activeTab === "calculator" && nbaSubTab === "halftime") refetchHalftimePlays();
      }, 2 * 60 * 1000);
    }
    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
  }, [selectedGameId, activeTab]);

  // ── Auto-refresh halftime plays when sub-tab is opened ─────────────────────
  useEffect(() => {
    if (activeTab === "calculator" && nbaSubTab === "halftime") {
      refetchHalftimePlays();
    }
  }, [activeTab, nbaSubTab]);

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
    } else {
      toast({
        title: "Calculation failed",
        description: calculateMutation.error.message || "Something went wrong. Check your inputs and try again.",
        variant: "destructive",
      });
    }
  }, [calculateMutation.error]);

  // Auto-show upgrade modal when free user uses their last play successfully
  useEffect(() => {
    if (!user || user.isAdmin || user.subscriptionTier) return;
    if ((user.playsUsed ?? 0) >= 15) {
      setUpgradeModalState({ playsUsed: user.playsUsed ?? 15, limit: 15 });
      setShowUpgradeModal(true);
    }
  }, [user?.playsUsed]);

  // ── Handle Stripe redirect back to app ────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    const tier = params.get("tier");
    const sessionId = params.get("session_id");
    if (payment === "success" && tier) {
      window.history.replaceState({}, "", "/");
      apiRequest("POST", "/api/stripe/checkout-complete", { tier, sessionId })
        .then(() => queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }))
        .catch(() => queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }));
    } else if (payment === "cancelled") {
      window.history.replaceState({}, "", "/");
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
        console.log("[TAB GATE] /api/me →", { subscriptionTier: fresh.subscriptionTier, requiresRefresh: fresh.requiresRefresh });
        // Always sync localTier to DB value
        setLocalTier(fresh.subscriptionTier ?? null);
        // If server flagged requiresRefresh, force auth query refresh
        if (fresh.requiresRefresh) {
          console.log("[TAB GATE] requiresRefresh=true — invalidating auth cache");
          queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
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

  // ── Debug: NCAAB tab gate state ───────────────────────────────────────────
  useEffect(() => {
    console.log("[TAB GATE] Raw tier from session:", effectiveTier);
    console.log("[TAB GATE] hasProAccess:", hasProAccess(effectiveTier));
    console.log("[TAB GATE] isAdmin:", user?.isAdmin ?? false);
    console.log("[TAB GATE] hasNcaabAccess:", hasNcaabAccess);
    console.log("[TAB GATE] NCAAB locked:", !hasNcaabAccess);
  }, [hasNcaabAccess, effectiveTier]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (live > 0) return { text: `${live} game${live === 1 ? "" : "s"} live now — engine is running`, color: "#00d4aa" };
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

  // Direct fill from box score row — bypasses name-matching entirely
  const handleBoxScoreClick = (stat: import("@shared/schema").LivePlayerStat) => {
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

  const activeGames = (liveGames ?? []).filter(
    (g) => g.status !== "Scheduled" && g.status !== "Final"
  );
  const allGames = liveGames ?? [];

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-12 h-12 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const isFreeUser = !!user && !user.isAdmin && !user.subscriptionTier;
  const playsUsed = user?.playsUsed ?? 0;
  const visibleEdgeLimit = 5;

  const filterPlay = (play: any) => {
    if (slateFilterProp === "combo" && !play.statType.includes("_")) return false;
    if (slateFilterProp !== "all" && slateFilterProp !== "combo" && play.statType !== slateFilterProp) return false;
    const dp = play.betDirection === "under" ? (100 - play.probability) : play.probability;
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
        setUpgradeModalState({ playsUsed: err.playsUsed ?? user?.playsUsed ?? 0, limit: err.limit ?? 15 });
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
    <div className="min-h-screen pb-20 bg-background">
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
      <header className="border-b border-border/40 bg-background/80 backdrop-blur-xl sticky top-0 z-50">
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
            <div className="flex flex-col leading-none">
              <h1 className="text-xl font-bold tracking-tight text-foreground">LiveLocks</h1>
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest mt-0.5">
                by PropPulse · {activeTab === "ncaab" ? "NCAAB" : "NBA"}
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
                onClick={() => { setUpgradeModalState({ playsUsed: user.playsUsed, limit: 15 }); setShowUpgradeModal(true); }}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-500 text-xs font-medium hover:bg-amber-500/20 transition-colors"
              >
                <Zap className="w-3 h-3" />
                {Math.max(0, 15 - user.playsUsed)} free plays left
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
                  onClick={handleManageSubscription}
                  disabled={portalLoading}
                  className="hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                  title="Manage or cancel your subscription"
                >
                  {portalLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Manage"}
                </button>
              </div>
            )}
            {user?.isAdmin && (
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/20 transition-colors"
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
                data-testid="link-admin"
                onClick={() => navigate("/admin")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 text-xs font-semibold hover:bg-amber-500/20 transition-colors"
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-secondary/80 transition-colors"
                title={user.email}
              >
                <Users className="w-3.5 h-3.5" />
                Sign Out
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

      <main className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 mt-6 space-y-5">

        {/* Welcome banner — shown once after upgrade */}
        {showWelcomeBanner && (
          <WelcomeBanner
            onExplore={handleExplore}
            onDismiss={dismissWelcomeBanner}
            subtitle={ncaabSubtitle.text}
            subtitleColor={ncaabSubtitle.color}
          />
        )}

        {/* Tab Navigation */}
        <div className="relative flex flex-col gap-0 w-full overflow-x-auto">
          <div className="flex gap-1 bg-secondary/40 border border-border/60 rounded-xl p-1 w-fit">
            <button
              onClick={() => { setActiveTab("calculator"); }}
              data-testid="tab-calculator"
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                activeTab === "calculator"
                  ? "bg-primary text-primary-foreground border-glow"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              🏀 NBA Live
            </button>
            <button
              data-testid="tab-ncaab"
              onClick={() => {
                if (!hasNcaabAccess) {
                  setUpgradeModalState({ playsUsed: user?.playsUsed ?? 0, limit: 15 });
                  setShowUpgradeModal(true);
                  return;
                }
                setActiveTab("ncaab");
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
                      background: "#00d4aa",
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
            {user?.isAdmin ? (
              <button
                data-testid="tab-mlb"
                onClick={() => setActiveTab("mlb")}
                className={`px-4 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-1.5 transition-colors ${
                  activeTab === "mlb"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span role="img" aria-label="baseball">⚾</span>
                MLB Live
              </button>
            ) : (
              <button
                data-testid="tab-mlb-locked"
                onClick={() => setMlbPopoverOpen((v) => !v)}
                className="px-4 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-1.5 opacity-50 cursor-not-allowed text-muted-foreground"
              >
                <span role="img" aria-label="baseball">⚾</span>
                MLB Live
                <Lock className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* NBA sub-tabs */}
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


          {/* MLB locked popover */}
          {mlbPopoverOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMlbPopoverOpen(false)} />
              <div
                className="absolute top-full left-0 mt-2 z-50 w-72 bg-card border border-border/60 rounded-xl p-4 shadow-2xl animate-fade-in-up"
                style={{ boxShadow: "0 0 20px -4px hsl(var(--primary) / 0.2), 0 8px 32px -4px hsl(0 0% 0% / 0.5)" }}
              >
                <p className="text-sm font-semibold text-foreground mb-1 flex items-center gap-1.5">
                  <span role="img" aria-label="baseball">⚾</span> MLB Live
                </p>
                {user?.subscriptionTier === "elite" || user?.isAdmin ? (
                  <p className="text-xs text-muted-foreground">
                    MLB Live prop predictions are launching soon. You'll be the first to know as an All Sports subscriber.
                  </p>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground mb-3">
                      MLB Live prop predictions are included in the All Sports plan ($65/mo). Your current plan does not include MLB access.
                    </p>
                    <button
                      data-testid="button-mlb-upgrade"
                      onClick={() => { setMlbPopoverOpen(false); setShowUpgradeModal(true); }}
                      className="w-full py-1.5 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors"
                    >
                      Upgrade to All Sports — $65/mo
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>

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
                        const homeDb = espnToDb(game.homeTeamAbbr);
                        const awayDb = espnToDb(game.awayTeamAbbr);
                        if (teams?.includes(homeDb)) form.setValue("opponentTeam", homeDb);
                        else if (teams?.includes(awayDb)) form.setValue("opponentTeam", awayDb);
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
                      {isLive && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />}
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
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
              <button
                onClick={() => setShowBoxScore(!showBoxScore)}
                className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                data-testid="button-toggle-boxscore"
              >
                <Activity className="w-3.5 h-3.5 text-green-500" />
                Live Box Score
                {liveStats && (
                  <span className="text-muted-foreground/60 font-normal normal-case ml-1">
                    — click a row to auto-fill
                  </span>
                )}
                <ChevronDown className={`w-3.5 h-3.5 ml-1 transition-transform ${showBoxScore ? "rotate-180" : ""}`} />
              </button>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground/50">
                  Auto-refreshes every 2 min · Last: {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <button
                  onClick={() => { refetchLiveStats(); setLastRefreshed(new Date()); }}
                  disabled={isLiveStatsLoading}
                  data-testid="button-refresh-boxscore"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                >
                  <RefreshCw className={`w-3 h-3 ${isLiveStatsLoading ? "animate-spin" : ""}`} />
                  Refresh
                </button>
              </div>
            </div>
            {showBoxScore && (
              isLiveStatsLoading ? (
                <div className="flex items-center justify-center py-6 text-xs text-muted-foreground gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Fetching live stats…
                </div>
              ) : liveStats && liveStats.filter(s => s.minutes !== "0" && s.minutes !== "0:00").length > 0 ? (
                <div>
                  {/* Signal legend — only shown when halftime plays exist */}
                  {(halftimePlaysData?.plays?.length ?? 0) > 0 && (
                    <div className="px-4 pt-2 pb-1 flex items-center gap-3 text-[10px] text-muted-foreground/70 border-b border-border/20 flex-wrap">
                      <span className="font-medium uppercase tracking-wider">Signal Key:</span>
                      <span className="flex items-center gap-1"><span style={{ color: "#22c55e" }}>●</span> Over ≥85%</span>
                      <span className="flex items-center gap-1"><span style={{ color: "#ef4444" }}>●</span> Under ≥85%</span>
                      <span className="flex items-center gap-1"><span style={{ color: "#eab308" }}>●</span> 70–84%</span>
                      <span className="flex items-center gap-1"><span style={{ color: "#00d4aa" }}>●</span> 60–69%</span>
                    </div>
                  )}
                  {/* Filter + Sort Controls */}
                  <div className="px-4 py-2 border-b border-border/40 flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                      <input
                        type="text"
                        placeholder="Filter by player name…"
                        value={boxScoreFilter}
                        onChange={e => setBoxScoreFilter(e.target.value)}
                        data-testid="input-boxscore-filter"
                        className="w-full h-8 pl-8 pr-3 rounded-lg bg-secondary/50 border border-border/50 text-xs focus:border-primary outline-none"
                      />
                    </div>
                    <button
                      data-testid="button-sort-stat"
                      onClick={() => {
                        if (boxScoreSort === "stat") setBoxScoreSortDir(d => d === "desc" ? "asc" : "desc");
                        else setBoxScoreSort("stat");
                      }}
                      className={`flex items-center gap-1 px-2.5 h-8 rounded-lg border text-xs font-medium transition-colors ${
                        boxScoreSort === "stat" ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-secondary/30 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Stat {boxScoreSort === "stat" ? (boxScoreSortDir === "desc" ? "▼" : "▲") : ""}
                    </button>
                    <button
                      data-testid="button-sort-minutes"
                      onClick={() => {
                        if (boxScoreSort === "minutes") setBoxScoreSortDir(d => d === "desc" ? "asc" : "desc");
                        else setBoxScoreSort("minutes");
                      }}
                      className={`flex items-center gap-1 px-2.5 h-8 rounded-lg border text-xs font-medium transition-colors ${
                        boxScoreSort === "minutes" ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-secondary/30 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      MIN {boxScoreSort === "minutes" ? (boxScoreSortDir === "desc" ? "▼" : "▲") : ""}
                    </button>
                  </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground/70 border-b border-border/40">
                        <th className="text-left px-4 py-2 font-medium">Player</th>
                        <th className="text-right px-3 py-2 font-medium">MIN</th>
                        <th className="text-right px-3 py-2 font-medium text-primary">
                          {STAT_TYPES.find(s => s.value === watchedStatType)?.label ?? "PTS"}
                        </th>
                        <th className="text-right px-3 py-2 font-medium">PTS</th>
                        <th className="text-right px-3 py-2 font-medium">REB</th>
                        <th className="text-right px-3 py-2 font-medium">AST</th>
                        <th className="text-right px-3 py-2 font-medium">FGM-FGA</th>
                        <th className="text-right px-3 py-2 font-medium">FTM-FTA</th>
                        <th className="text-right px-3 py-2 font-medium">3PM-3PA</th>
                        <th className="text-right px-3 py-2 font-medium">PF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const parseMinDec = (m: string) => {
                          const parts = m.split(":");
                          return parts.length === 2 ? parseInt(parts[0]) + parseInt(parts[1]) / 60 : parseFloat(m) || 0;
                        };

                        // Build player signal map — prefer live signals (works Q1-Q4),
                        // fall back to halftimePlaysData for the dedicated halftime panel.
                        type SignalTier = "green" | "red" | "yellow" | "teal";
                        type PlayerSignal = { tier: SignalTier; displayProb: number; betDirection: string; statType: string };
                        const playerSignalMap = new Map<string, PlayerSignal>();
                        const statCellSignalMap = new Map<string, PlayerSignal>();
                        const signalSource = (liveSignalsData?.signals && liveSignalsData.signals.length > 0)
                          ? liveSignalsData.signals
                          : (halftimePlaysData?.plays ?? []);
                        for (const play of signalSource) {
                          const dp = play.betDirection === "under"
                            ? Math.round((100 - play.probability) * 10) / 10
                            : Math.round(play.probability * 10) / 10;
                          const tier: SignalTier | null =
                            dp >= 85 ? (play.betDirection === "under" ? "red" : "green") :
                            dp >= 70 ? "yellow" :
                            dp >= 60 ? "teal" : null;
                          if (!tier) continue;
                          const key = play.playerName.toLowerCase();
                          // Row-level: best signal across all stat types
                          const existing = playerSignalMap.get(key);
                          if (!existing || dp > existing.displayProb) {
                            playerSignalMap.set(key, { tier, displayProb: dp, betDirection: play.betDirection, statType: play.statType });
                          }
                          // Cell-level: only signals matching the active stat type column
                          if (play.statType === watchedStatType) {
                            const existingCell = statCellSignalMap.get(key);
                            if (!existingCell || dp > existingCell.displayProb) {
                              statCellSignalMap.set(key, { tier, displayProb: dp, betDirection: play.betDirection, statType: play.statType });
                            }
                          }
                        }

                        const SIGNAL_STYLES: Record<SignalTier, { border: string; bg: string; dot: string }> = {
                          green:  { border: "#22c55e", bg: "rgba(34,197,94,0.07)",   dot: "#22c55e" },
                          red:    { border: "#ef4444", bg: "rgba(239,68,68,0.07)",   dot: "#ef4444" },
                          yellow: { border: "#eab308", bg: "rgba(234,179,8,0.07)",   dot: "#eab308" },
                          teal:   { border: "#00d4aa", bg: "rgba(0,212,170,0.07)",   dot: "#00d4aa" },
                        };

                        const STAT_LABEL_MAP: Record<string, string> = {
                          points: "PTS", rebounds: "REB", assists: "AST", steals: "STL",
                          blocks: "BLK", threes: "3PM", pts_reb_ast: "PRA", pts_reb: "P+R",
                          pts_ast: "P+A", reb_ast: "R+A", stl_blk: "S+B",
                        };

                        const filterLower = boxScoreFilter.toLowerCase().trim();
                        const playedStats = liveStats
                          .filter(s => s.minutes !== "0" && s.minutes !== "0:00")
                          .filter(s => !filterLower || s.playerName.toLowerCase().includes(filterLower));
                        const teams = Array.from(new Set(playedStats.map(s => s.teamAbbr)));
                        return teams.flatMap((team, ti) => [
                          <tr key={`team-${team}`} className={ti > 0 ? "border-t-2 border-border/60" : ""}>
                            <td colSpan={10} className="px-4 py-1 text-muted-foreground/60 font-semibold uppercase tracking-wider text-[10px] bg-secondary/20">
                              {espnToDb(team)} — {TEAM_FULL_NAMES[espnToDb(team)] ?? team}
                            </td>
                          </tr>,
                          ...playedStats
                            .filter(s => s.teamAbbr === team)
                            .sort((a, b) => {
                              const getStatVal = (s: typeof a) => {
                                if (watchedStatType === "points") return s.points;
                                if (watchedStatType === "rebounds") return s.rebounds;
                                if (watchedStatType === "assists") return s.assists;
                                if (watchedStatType === "steals") return s.steals;
                                if (watchedStatType === "blocks") return s.blocks;
                                if (watchedStatType === "threes") return s.threes;
                                if (watchedStatType === "pts_reb_ast") return s.points + s.rebounds + s.assists;
                                if (watchedStatType === "pts_reb") return s.points + s.rebounds;
                                if (watchedStatType === "pts_ast") return s.points + s.assists;
                                if (watchedStatType === "reb_ast") return s.rebounds + s.assists;
                                if (watchedStatType === "stl_blk") return s.steals + s.blocks;
                                return s.points;
                              };
                              const sortVal = boxScoreSort === "minutes"
                                ? parseMinDec(a.minutes) - parseMinDec(b.minutes)
                                : getStatVal(a) - getStatVal(b);
                              return boxScoreSortDir === "desc" ? -sortVal : sortVal;
                            })
                            .map((stat) => {
                              const isSelected = selectedPlayer && findPlayerByName(stat.playerName)?.id === selectedPlayer.id;
                              const signal = playerSignalMap.get(stat.playerName.toLowerCase()) ?? null;
                              const statTotal = (() => {
                                if (watchedStatType === "points") return stat.points;
                                if (watchedStatType === "rebounds") return stat.rebounds;
                                if (watchedStatType === "assists") return stat.assists;
                                if (watchedStatType === "steals") return stat.steals;
                                if (watchedStatType === "blocks") return stat.blocks;
                                if (watchedStatType === "threes") return stat.threes;
                                if (watchedStatType === "pts_reb_ast") return stat.points + stat.rebounds + stat.assists;
                                if (watchedStatType === "pts_reb") return stat.points + stat.rebounds;
                                if (watchedStatType === "pts_ast") return stat.points + stat.assists;
                                if (watchedStatType === "reb_ast") return stat.rebounds + stat.assists;
                                if (watchedStatType === "stl_blk") return stat.steals + stat.blocks;
                                return stat.points;
                              })();
                              const fgPct = stat.fga != null && stat.fga > 0 ? `${stat.fgm ?? 0}-${stat.fga}` : "—";
                              const ftPct = stat.fta != null && stat.fta > 0 ? `${stat.ftm ?? 0}-${stat.fta}` : "—";
                              const fg3Pct = stat.fg3a != null && stat.fg3a > 0 ? `${stat.fg3m ?? 0}-${stat.fg3a}` : "—";
                              const signalStyle = !isSelected && signal ? SIGNAL_STYLES[signal.tier] : null;
                              const rowStyle = signalStyle
                                ? { background: signalStyle.bg, boxShadow: `inset 3px 0 0 ${signalStyle.border}` }
                                : undefined;
                              // Cell color: look up the stat-type-specific signal map (built above)
                              // so the color always reflects the signal for the exact column on screen.
                              const statCellSignal = statCellSignalMap.get(stat.playerName.toLowerCase()) ?? null;
                              const statCellColor = statCellSignal
                                ? SIGNAL_STYLES[statCellSignal.tier].dot
                                : "#00d4aa";
                              return (
                                <tr
                                  key={`player-${stat.playerId}`}
                                  onClick={() => handleBoxScoreClick(stat)}
                                  data-testid={`boxscore-row-${stat.playerId}`}
                                  style={rowStyle}
                                  className={`border-b border-border/20 cursor-pointer transition-all ${
                                    isSelected
                                      ? "bg-primary/10 border-l-2 border-l-primary"
                                      : signal ? "" : "hover:bg-secondary/40"
                                  }`}
                                >
                                  <td className="px-4 py-2 font-medium text-foreground">
                                    <span className="flex items-center gap-1.5">
                                      <span>{stat.playerName}</span>
                                      {isSelected && <span className="text-primary text-[10px] font-bold">●</span>}
                                      {!isSelected && signal && (
                                        <span
                                          title={`${STAT_LABEL_MAP[signal.statType] ?? signal.statType} ${signal.betDirection === "under" ? "Under" : "Over"} — ${signal.displayProb}% model confidence`}
                                          data-testid={`signal-dot-${stat.playerId}`}
                                          style={{ color: SIGNAL_STYLES[signal.tier].dot }}
                                          className="text-[9px] font-bold cursor-help select-none"
                                        >●</span>
                                      )}
                                    </span>
                                  </td>
                                  <td className="text-right px-3 py-2 font-mono text-muted-foreground">{stat.minutes}</td>
                                  <td className="text-right px-3 py-2 font-mono font-bold" style={{ color: statCellColor }}>{statTotal}</td>
                                  <td className="text-right px-3 py-2 font-mono">{stat.points}</td>
                                  <td className="text-right px-3 py-2 font-mono">{stat.rebounds}</td>
                                  <td className="text-right px-3 py-2 font-mono">{stat.assists}</td>
                                  <td className="text-right px-3 py-2 font-mono text-muted-foreground">{fgPct}</td>
                                  <td className="text-right px-3 py-2 font-mono text-muted-foreground">{ftPct}</td>
                                  <td className="text-right px-3 py-2 font-mono text-muted-foreground">{fg3Pct}</td>
                                  <td className={`text-right px-3 py-2 font-mono ${stat.fouls >= 4 ? "text-red-400 font-bold" : "text-muted-foreground"}`}>{stat.fouls}</td>
                                </tr>
                              );
                            }),
                        ]);
                      })()}
                    </tbody>
                  </table>
                </div>
                </div>
              ) : (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  No live stats available yet — box score updates once the game starts.
                </div>
              )
            )}
          </div>
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
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
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

                      {/* Odds API quota exhausted */}
                      {watchedOpponent && !isOddsLoading && oddsData && (oddsData as any)._quotaExhausted && (
                        <p className="text-xs text-amber-400/80 bg-amber-500/10 rounded-lg p-2 border border-amber-500/20">
                          Sportsbook lines temporarily unavailable — API quota reached. Lines will resume next month.
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
                    "Calculate Probability"
                  )}
                </button>

                {/* Free play countdown — shown to free users only */}
                {user && !user.isAdmin && !user.subscriptionTier && (() => {
                  const used = user.playsUsed ?? 0;
                  const limit = 15;
                  const remaining = Math.max(0, limit - used);
                  const pct = Math.round((used / limit) * 100);
                  return (
                    <div data-testid="free-play-countdown" className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Zap className="w-3.5 h-3.5 text-amber-500" />
                          <span className="text-xs font-semibold text-amber-400">
                            {remaining > 0 ? `${remaining} free ${remaining === 1 ? "play" : "plays"} remaining` : "No free plays left"}
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
                      <p className="text-[10px] text-muted-foreground/60">{used} of {limit} plays used · <span className="text-amber-500/80">Upgrade for unlimited access</span></p>
                    </div>
                  );
                })()}

                {user && !user.isAdmin && !user.subscriptionTier && (user.playsUsed ?? 0) >= 10 && (user.playsUsed ?? 0) < 15 && (
                  <div data-testid="near-limit-reminder" className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2.5 flex items-center gap-2">
                    <span className="text-orange-400 text-sm">⚠️</span>
                    <span className="text-xs text-orange-300">
                      You have {15 - (user.playsUsed ?? 0)} free calculation{15 - (user.playsUsed ?? 0) === 1 ? "" : "s"} remaining.
                    </span>
                    <button
                      type="button"
                      data-testid="button-upgrade-near-limit"
                      onClick={() => { setUpgradeModalState({ playsUsed: user.playsUsed ?? 0, limit: 15 }); setShowUpgradeModal(true); }}
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
                <h3 className="text-lg font-semibold text-foreground mb-2">Ready to Predict</h3>
                <p className="max-w-xs text-sm text-muted-foreground mb-4">
                  Select a player and opponent, fill in halftime stats, then calculate the 2H probability.
                </p>
                {allGames.length > 0 && (
                  <div className="space-y-1.5 text-left text-xs text-muted-foreground/70 bg-secondary/30 border border-border/30 rounded-lg px-4 py-3 max-w-xs w-full">
                    <p className="font-semibold text-muted-foreground mb-1 text-[10px] uppercase tracking-wider">Quick start</p>
                    <p>① Click a game tile above</p>
                    <p>② Click a player row in the box score</p>
                    <p>③ Pick a stat type &amp; live line</p>
                    <p>④ Hit Calculate</p>
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
                        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Live Prediction</p>
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
                          {" vs "}{sbName} implied <strong className="text-foreground">{bestEV.implied.toFixed(1)}%</strong>
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
                          {" vs "}{sbName} implied <strong className="text-foreground">{overImplied.toFixed(1)}%</strong>
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

                {/* Share prompt — shown on strong results */}
                {(result.probability >= 62 || result.probability <= 38) && (() => {
                  const playerName = (() => {
                    const id = form.getValues("playerId");
                    const p = (players ?? []).find(pl => pl.id === Number(id));
                    return p?.name ?? "Player";
                  })();
                  const rawStatType = form.getValues("statType");
                  const statLabel = STAT_TYPES.find(s => s.value === rawStatType)?.label ?? rawStatType;
                  const line = form.getValues("liveLine");
                  const prob = result.probability;
                  const isOver = prob >= 65;
                  const direction = isOver ? "Over" : "Under";
                  const directionProb = isOver ? prob.toFixed(0) : (100 - prob).toFixed(0);
                  const projection = result.expectedTotal.toFixed(1);
                  const atHalftime = !!form.getValues("halftimeScore");
                  const snippet = `LIVE EDGE 🚨\n\n${playerName}\n${direction} ${line} ${statLabel}\n\nModel probability: ${directionProb}%\nProjection: ${projection}${atHalftime ? "\n\nDetected live at halftime." : ""}\n\nRun the engine yourself:\nwww.livelocksai.app\n\nGenerated by LiveLocks\n@proppulsebet #LiveLocks #NBAProps`;
                  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(snippet)}`;
                  return (
                    <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 flex flex-col gap-3 animate-fade-in-up">
                      <div>
                        <p className="text-xs font-semibold text-foreground mb-2">🚨 Live Edge Detected</p>
                        <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">{snippet}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          data-testid="button-tweet-pick"
                          onClick={() => window.open(tweetUrl, "_blank", "noopener,noreferrer")}
                          className="flex-1 flex items-center justify-center gap-2 text-sm font-bold py-2.5 px-4 rounded-xl bg-black text-white hover:bg-zinc-800 active:scale-95 transition-all"
                        >
                          <SiX className="w-4 h-4" />
                          Tweet this pick
                        </button>
                        <button
                          data-testid="button-copy-pick"
                          onClick={() => {
                            navigator.clipboard.writeText(snippet);
                            setCopiedPick(true);
                            setTimeout(() => setCopiedPick(false), 2000);
                          }}
                          className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-2.5 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                        >
                          {copiedPick ? <><Check className="w-3.5 h-3.5" /></> : <><Copy className="w-3.5 h-3.5" /></>}
                        </button>
                      </div>
                    </div>
                  );
                })()}

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
              <div className="bg-card border border-border rounded-xl p-4 sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto relative">
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
                  <h2 className="text-lg font-semibold flex items-center gap-2 flex-wrap">
                    <Star className="w-5 h-5 text-primary" />
                    2H Plays —{" "}
                    <span
                      data-testid="text-halftime-count"
                      className={halftimeCountPulse ? "halftime-count-pulse" : ""}
                      style={{ display: "inline-block", color: "#00d4aa" }}
                      key={visibleHalftimeGroups.length}
                    >
                      {visibleHalftimeGroups.length}
                    </span>
                    {" "}Game{visibleHalftimeGroups.length !== 1 ? "s" : ""} at Halftime
                    {Math.max(1, Math.ceil(visibleHalftimeGroups.length / 4)) > 1 && (
                      <span className="text-sm font-normal text-muted-foreground">
                        · Page {currentHalftimePage} of {Math.max(1, Math.ceil(visibleHalftimeGroups.length / 4))}
                      </span>
                    )}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    Top plays by probability edge across all halftime games. Includes overs and unders.
                  </p>
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
                  <p className="text-xs text-muted-foreground/60 mt-1">Check back when games are at halftime.</p>
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

              {/* Per-game groups — paginated with exit animation */}
              {!isHalftimePlaysLoading && halftimePlaysData && halftimePlaysData.plays.length > 0 && (() => {
                const GAMES_PER_PAGE = 4;
                const totalPages = Math.max(1, Math.ceil(visibleHalftimeGroups.length / GAMES_PER_PAGE));
                const pageStart = (currentHalftimePage - 1) * GAMES_PER_PAGE;
                const pageGroups = visibleHalftimeGroups.slice(pageStart, pageStart + GAMES_PER_PAGE);

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
                        const playsRemaining = Math.max(0, 15 - playsUsed);
                        return (
                          <div
                            key={group.gameId}
                            className="relative"
                            style={{
                              animation: isExiting ? "halftimeExit 2.5s ease forwards" : "none",
                              border: isExiting ? "1px solid rgba(0,212,170,0.3)" : "1px solid transparent",
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
                                    <p className="text-xs text-muted-foreground mt-1">Unlocking this game uses 1 free play. You have {playsRemaining} remaining.</p>
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
                                      onClick={() => { setUpgradeModalState({ playsUsed: user?.playsUsed ?? 0, limit: 15 }); setShowUpgradeModal(true); }}
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
                                            setUpgradeModalState({ playsUsed, limit: 15 });
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
                                              const displayProb = play.betDirection === "under"
                                                ? Math.round((100 - play.probability) * 10) / 10
                                                : play.probability;
                                              const probColor =
                                                displayProb >= 85 ? (play.betDirection === "under" ? "text-red-400" : "text-green-400") :
                                                displayProb >= 70 ? "text-yellow-400" :
                                                displayProb >= 60 ? "text-[#00d4aa]" : "text-muted-foreground";
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
                                              ? { background: "rgba(0,212,170,0.15)", border: "1px solid rgba(0,212,170,0.3)", color: "#00d4aa" }
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
                                            {hasLiveLine ? "Live Line" : "Season Avg"}
                                          </span>
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
                                                ? { background: "rgba(0,212,170,0.15)", border: "1px solid rgba(0,212,170,0.3)", color: "#00d4aa" }
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
                                      onClick={() => { setUpgradeModalState({ playsUsed, limit: 15 }); setShowUpgradeModal(true); }}
                                      className="px-5 py-2 rounded-xl text-sm font-bold transition-colors flex items-center gap-2"
                                      style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b" }}
                                    >
                                      <Lock className="w-4 h-4" /> Unlock All Edges
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
                                <span className="text-lg font-bold" style={{ color: "#00d4aa" }}>2H Underway</span>
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
                <div className="bg-card border border-border rounded-xl p-4 sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto relative">
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

        {/* NCAAB Tab — live data for Pro, All Sports, and Admin */}
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

        {/* Analytics Tab — admin only */}
        {activeTab === "analytics" && user?.isAdmin && (
          <div className="max-w-5xl mx-auto px-4 py-6">
            <AnalyticsTab />
          </div>
        )}

        {/* MLB Live Tab — admin and All Sports users */}
        {activeTab === "mlb" && (user?.isAdmin || user?.subscriptionTier === "elite") && <MlbLivePage />}

      </main>

      {isFreeUser && activeTab === "calculator" && nbaSubTab === "halftime" && !isHalftimePlaysLoading && halftimePlaysData && halftimePlaysData.plays.length > 0 && (() => {
        const stickyTotalLocked = visibleHalftimeGroups.reduce((sum, g) => {
          const filtered = filterByBook(g.plays.filter(filterPlay), nbaBookFilter);
          return sum + Math.max(0, filtered.length - visibleEdgeLimit);
        }, 0);
        if (stickyTotalLocked <= 0) return null;
        return (
          <div
            data-testid="sticky-upgrade-banner"
            style={{
              position: "fixed",
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: 45,
              background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
              borderTop: "1px solid rgba(245,158,11,0.3)",
              padding: "12px 16px",
              paddingBottom: "max(12px, env(safe-area-inset-bottom, 12px))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
            }}
          >
            <span className="text-sm text-amber-300 font-medium">
              🔒 {stickyTotalLocked} premium edge{stickyTotalLocked !== 1 ? "s" : ""} locked
            </span>
            <button
              data-testid="button-unlock-all-edges"
              onClick={() => { setUpgradeModalState({ playsUsed: user?.playsUsed ?? 0, limit: 15 }); setShowUpgradeModal(true); }}
              className="px-4 py-2 rounded-lg text-sm font-bold transition-colors"
              style={{ background: "#f59e0b", color: "#000", }}
            >
              Unlock All Edges
            </button>
          </div>
        );
      })()}

      {showUpgradeModal && (
        <UpgradeModal
          playsUsed={upgradeModalState.playsUsed}
          limit={upgradeModalState.limit}
          onClose={() => setShowUpgradeModal(false)}
        />
      )}

      {user && <FeedbackModal />}

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
          hasSmsAccess={["all", "elite"].includes(user.subscriptionTier ?? "") || (user.isAdmin ?? false)}
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
          <span className="text-sm font-semibold" style={{ color: "#00d4aa" }}>
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
                  : <button data-testid="button-enable-push" onClick={handleEnablePush} disabled={pushLoading} className="text-xs text-[#00d4aa] underline underline-offset-2 hover:text-white transition-colors disabled:opacity-50">{pushLoading ? "..." : "Enable"}</button>
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
                    <span className="text-lg font-bold" style={{ color: "#00d4aa" }}>{hits}W</span>
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
              const confColor = entry.confidence >= 85 ? "#00d4aa" : entry.confidence >= 80 ? "#f59e0b" : "#71717a";
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
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: "rgba(0,212,170,0.15)", border: "1px solid rgba(0,212,170,0.3)", color: "#00d4aa" }}>✓ HIT</span>
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
                    <span className="text-xs ml-auto" style={{ color: "#00d4aa" }}>View →</span>
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
                  onFocus={e => { if (!smsBellInputError) e.currentTarget.style.borderColor = "#00d4aa"; }}
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
                  style={{ background: "#00d4aa", color: "#000" }}
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
                style={{ background: "#00d4aa", color: "#000" }}
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
    </div>
  );
}
