import { useState, useEffect, useRef } from "react";
import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { calculateProbabilitySchema, type CalculateProbabilityRequest, type ParlayPickInput, type InjuryPlayer } from "@shared/schema";
import { usePlayers, useTeams, useCalculateProbability, useLiveGames, useLiveStats, usePlayerOdds, useGameLines, PlayLimitError } from "@/hooks/use-nba";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ProbabilityRing } from "@/components/probability-ring";
import { StatCard } from "@/components/stat-card";
import { ParlaySlip } from "@/components/parlay-slip";
import { UpgradeModal } from "@/components/upgrade-modal";
import { FeedbackModal } from "@/components/feedback-modal";
import { NCAABAdminTab } from "@/components/ncaab-admin-tab";
import { useAuth } from "@/hooks/use-auth";
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
} from "lucide-react";
import { SiX } from "react-icons/si";

// ESPN abbreviation → our DB team abbreviation
const ESPN_TO_DB: Record<string, string> = {
  GS: "GSW", SA: "SAS", NO: "NOP", NY: "NYK",
  PHO: "PHX", UTH: "UTA", WSH: "WAS", CHO: "CHA",
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
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [upgradeModalState, setUpgradeModalState] = useState<{ playsUsed: number; limit: number }>({ playsUsed: 10, limit: 10 });

  const { data: players, isLoading: isPlayersLoading } = usePlayers();
  const { data: teams, isLoading: isTeamsLoading } = useTeams();
  const { data: liveGames, isLoading: isGamesLoading, refetch: refetchGames } = useLiveGames();

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

  const [activeTab, setActiveTab] = useState<"calculator" | "halftime" | "ncaab">("calculator");
  const [slateFilterProp, setSlateFilterProp] = useState<string>("all");
  const [slateFilterProb, setSlateFilterProb] = useState<string>("all");
  const [showAlertsPanel, setShowAlertsPanel] = useState(false);
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
      navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data?.type === "ALERT_RECEIVED") {
          const payload = e.data.payload;
          setAlertHistory(prev => {
            const updated = [{ title: payload.title, body: payload.body, time: Date.now() }, ...prev].slice(0, 10);
            try { localStorage.setItem("ll_alerts", JSON.stringify(updated)); } catch {}
            return updated;
          });
        }
      });
    }
  }, [user]);

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
  const [halftimeLocked, setHalftimeLocked] = useState(false);
  const { data: halftimePlaysData, isLoading: isHalftimePlaysLoading, refetch: refetchHalftimePlays } = useQuery<{ plays: any[]; message?: string }>({
    queryKey: ["/api/halftime-plays"],
    queryFn: async () => {
      const res = await fetch("/api/halftime-plays");
      if (res.status === 401 || res.status === 403) {
        setHalftimeLocked(true);
        return { plays: [] };
      }
      setHalftimeLocked(false);
      if (!res.ok) return { plays: [] };
      return res.json();
    },
    enabled: activeTab === "halftime",
    refetchInterval: 5 * 60 * 1000,
    staleTime: 4 * 60 * 1000,
  });

  // ── 2-minute auto-refresh for live box score ───────────────────────────────
  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    if (selectedGameId) {
      autoRefreshRef.current = setInterval(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/live-stats", selectedGameId] });
        setLastRefreshed(new Date());
        if (activeTab === "halftime") refetchHalftimePlays();
      }, 2 * 60 * 1000);
    }
    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
  }, [selectedGameId, activeTab]);

  // ── Auto-refresh halftime plays when tab is opened ─────────────────────────
  useEffect(() => {
    if (activeTab === "halftime") {
      refetchHalftimePlays();
    }
  }, [activeTab]);

  // ── Mobile breakpoint detection ────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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

  // ── Handle Stripe redirect back to app ────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    if (payment === "success") {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      window.history.replaceState({}, "", "/");
    } else if (payment === "cancelled") {
      window.history.replaceState({}, "", "/");
    }
  }, []);

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

  const watchedPlayerId = form.watch("playerId");
  const watchedStatType = form.watch("statType");

  // Get selected player info
  const selectedPlayer = players?.find((p) => p.id === Number(watchedPlayerId));

  // Live stats for selected game
  const { data: liveStats, refetch: refetchLiveStats, isLoading: isLiveStatsLoading } = useLiveStats(selectedGameId);

  // Find a DB player by ESPN display name — uses first-initial + last-name matching
  const findPlayerByName = (espnName: string) => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    const normedEspn = norm(espnName);
    return (players ?? []).find((p) => {
      if (norm(p.name) === normedEspn) return true;
      const espnParts = espnName.toLowerCase().split(" ");
      const dbParts = p.name.toLowerCase().split(" ");
      const espnLast = espnParts[espnParts.length - 1];
      const dbLast = dbParts[dbParts.length - 1];
      return espnLast === dbLast && espnParts[0][0] === dbParts[0][0];
    });
  };

  // Direct fill from box score row — bypasses name-matching entirely
  const handleBoxScoreClick = (stat: import("@shared/schema").LivePlayerStat) => {
    const matched = findPlayerByName(stat.playerName);
    if (matched) form.setValue("playerId" as any, String(matched.id));

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
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    const playerStat = liveStats.find((s) => {
      if (norm(s.playerName) === norm(selectedPlayer.name)) return true;
      const espnParts = s.playerName.toLowerCase().split(" ");
      const dbParts = selectedPlayer.name.toLowerCase().split(" ");
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

  const filteredPlays = (halftimePlaysData?.plays ?? []).filter((play: any) => {
    if (slateFilterProp === "combo" && !play.statType.includes("_")) return false;
    if (slateFilterProp !== "all" && slateFilterProp !== "combo" && play.statType !== slateFilterProp) return false;
    if (slateFilterProb === "high" && play.probability < 65 && play.probability > 35) return false;
    if (slateFilterProb === "medium" && (play.probability >= 65 || play.probability <= 35)) return false;
    return true;
  });

  return (
    <div className="min-h-screen pb-20 bg-background">
      {/* Header */}
      <header className="border-b border-border/40 bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
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
          </div>
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
                onClick={() => { setUpgradeModalState({ playsUsed: user.playsUsed, limit: 10 }); setShowUpgradeModal(true); }}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-500 text-xs font-medium hover:bg-amber-500/20 transition-colors"
              >
                <Zap className="w-3 h-3" />
                {Math.max(0, 10 - user.playsUsed)} free plays left
              </button>
            )}
            {user && user.subscriptionTier && (
              <div className="hidden sm:flex items-center gap-1.5">
                <span data-testid="text-subscription-tier" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-medium">
                  <Star className="w-3 h-3" />
                  {user.subscriptionTier === "elite" ? "Elite" : user.subscriptionTier === "all" ? "All Sports" : "NBA Pro"}
                </span>
                <button
                  data-testid="button-manage-subscription"
                  onClick={handleManageSubscription}
                  disabled={portalLoading}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                  title="Manage or cancel your subscription"
                >
                  {portalLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Manage"}
                </button>
              </div>
            )}
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
            <button
              data-testid="button-alerts-panel"
              onClick={() => setShowAlertsPanel((v) => !v)}
              className="relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-secondary/80 transition-colors"
              title="Alerts & notifications"
            >
              <span className="text-sm">🔔</span>
              {alertHistory.length > 0 && !showAlertsPanel && (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-500 border border-background" />
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

      {/* Alerts Panel — slides down below header */}
      {showAlertsPanel && user && (
        <div className="border-b border-border/60 bg-card/80 backdrop-blur-sm">
          <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Alerts & Notifications</h3>
              <button onClick={() => setShowAlertsPanel(false)} className="text-xs text-muted-foreground hover:text-foreground">✕ Close</button>
            </div>

            {/* Push Notifications */}
            <div className="bg-secondary/40 rounded-xl p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">📲 Push Notifications</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Fires when any play hits ≥90% confidence or 2H goes live — even when the app is closed (if installed to home screen).</p>
                </div>
                {pushSubscribed
                  ? (
                    <button
                      data-testid="button-disable-push"
                      onClick={handleDisablePush}
                      disabled={pushLoading}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-secondary border border-border text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {pushLoading ? "..." : "Disable"}
                    </button>
                  ) : (
                    <button
                      data-testid="button-enable-push"
                      onClick={handleEnablePush}
                      disabled={pushLoading}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-50"
                    >
                      {pushLoading ? "..." : "Enable"}
                    </button>
                  )
                }
              </div>
              {pushSubscribed && (
                <p className="text-xs text-green-400 flex items-center gap-1">
                  <span>✓</span> Push alerts active
                </p>
              )}
            </div>

            {/* SMS (Elite only) */}
            <div className="bg-secondary/40 rounded-xl p-4 space-y-3">
              <p className="text-sm font-semibold text-foreground">💬 SMS Alerts</p>
              {["elite"].includes(user.subscriptionTier ?? "") || user.isAdmin
                ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">Get a text message for 2H plays and ≥90% confidence plays.</p>
                    <input
                      data-testid="input-phone-number"
                      type="tel"
                      placeholder="+1 555 000 0000"
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                    />
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <button
                          data-testid="toggle-sms-alerts"
                          type="button"
                          onClick={() => setSmsEnabled(v => !v)}
                          className={`w-10 h-5 rounded-full transition-colors relative ${smsEnabled ? "bg-primary" : "bg-secondary border border-border"}`}
                        >
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${smsEnabled ? "left-5" : "left-0.5"}`} />
                        </button>
                        <span className="text-xs text-muted-foreground">{smsEnabled ? "SMS on" : "SMS off"}</span>
                      </label>
                      <button
                        data-testid="button-save-sms"
                        onClick={handleSaveSms}
                        disabled={smsLoading}
                        className="ml-auto px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-50"
                      >
                        {smsLoading ? "Saving..." : "Save"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">SMS alerts are included in the Elite plan — the nuclear option for never missing a play.</p>
                    <button
                      onClick={() => { setShowAlertsPanel(false); setUpgradeModalState({ playsUsed: user.playsUsed ?? 0, limit: 10 }); setShowUpgradeModal(true); }}
                      className="px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-semibold hover:bg-primary/20"
                    >
                      View Elite Plan →
                    </button>
                  </div>
                )
              }
            </div>

            {/* Alert history */}
            {alertHistory.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Recent Alerts</p>
                {alertHistory.slice(0, 5).map((a, i) => (
                  <div key={i} className="bg-secondary/30 rounded-lg px-3 py-2">
                    <p className="text-xs font-semibold text-foreground">{a.title}</p>
                    <p className="text-xs text-muted-foreground">{a.body}</p>
                    <p className="text-[10px] text-muted-foreground/50 mt-0.5">{new Date(a.time).toLocaleTimeString()}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

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


        {/* Tab Navigation */}
        <div className="relative flex flex-col gap-0 w-full overflow-x-auto">
          <div className="flex gap-1 bg-secondary/40 border border-border/60 rounded-xl p-1 w-fit">
            <button
              onClick={() => setActiveTab("calculator")}
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
              onClick={() => setActiveTab("halftime")}
              data-testid="tab-halftime"
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors flex items-center gap-1.5 ${
                activeTab === "halftime"
                  ? "bg-primary text-primary-foreground border-glow"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Star className="w-3.5 h-3.5" />
              🏀 2H Plays
            </button>
            <button
              data-testid="tab-mlb-locked"
              onClick={() => setMlbPopoverOpen((v) => !v)}
              className="px-4 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-1.5 opacity-50 cursor-not-allowed text-muted-foreground"
            >
              <span role="img" aria-label="baseball">⚾</span>
              MLB Live
              <Lock className="w-3 h-3" />
            </button>
            {(user?.isAdmin || ["all", "elite"].includes(user?.subscriptionTier ?? "")) && (
              <button
                data-testid="tab-ncaab"
                onClick={() => setActiveTab("ncaab")}
                className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors flex items-center gap-1.5 ${
                  activeTab === "ncaab"
                    ? "bg-primary text-primary-foreground border-glow"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                🏀 NCAAB Live
                {user?.isAdmin && (
                  <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-400 ml-0.5">ADMIN</span>
                )}
                {!user?.isAdmin && (
                  <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-blue-500/20 text-blue-400 ml-0.5">LIVE</span>
                )}
              </button>
            )}
          </div>

          {/* MLB locked popover */}
          {mlbPopoverOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMlbPopoverOpen(false)} />
              <div
                className="absolute top-full left-0 mt-2 z-50 w-72 bg-card border border-border/60 rounded-xl p-4 shadow-2xl animate-fade-in-up"
                style={{ boxShadow: "0 0 20px -4px hsl(var(--primary) / 0.2), 0 8px 32px -4px hsl(0 0% 0% / 0.5)" }}
              >
                <p className="text-sm font-semibold text-foreground mb-1 flex items-center gap-1.5">
                  <span role="img" aria-label="baseball">⚾</span> MLB Coming Soon
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                  Live MLB prop predictions are launching next month. All Sports subscribers get early access.
                </p>
                {user && !user.subscriptionTier && !user.isAdmin && (
                  <button
                    data-testid="button-mlb-upgrade"
                    onClick={() => { setMlbPopoverOpen(false); setShowUpgradeModal(true); }}
                    className="w-full py-1.5 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors"
                  >
                    Get All Sports Access
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Live Games Strip — hidden on NCAAB tab */}
        {activeTab !== "ncaab" && allGames.length > 0 && (
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


        {/* Live Box Score — hidden on NCAAB tab */}
        {activeTab !== "ncaab" && selectedGameId && (liveStats || isLiveStatsLoading) && (
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
                              return (
                                <tr
                                  key={`player-${stat.playerId}`}
                                  onClick={() => handleBoxScoreClick(stat)}
                                  data-testid={`boxscore-row-${stat.playerId}`}
                                  className={`border-b border-border/20 cursor-pointer transition-all ${
                                    isSelected
                                      ? "bg-primary/10 border-l-2 border-l-primary"
                                      : "hover:bg-secondary/40"
                                  }`}
                                >
                                  <td className="px-4 py-2 font-medium text-foreground">
                                    {stat.playerName}
                                    {isSelected && <span className="ml-1.5 text-primary text-[10px] font-bold">●</span>}
                                  </td>
                                  <td className="text-right px-3 py-2 font-mono text-muted-foreground">{stat.minutes}</td>
                                  <td className="text-right px-3 py-2 font-mono font-bold text-primary">{statTotal}</td>
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
        {activeTab === "calculator" ? <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">

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
                                {/* Main row: name | line | odds */}
                                <div className="flex items-center justify-between w-full">
                                  <span className="font-semibold text-foreground">{SPORTSBOOK_LABELS[sb] ?? sb}</span>
                                  <span className="font-mono font-bold text-primary">{o.line}</span>
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
                                {/* CLV — line delta vs entered live line, shown after Calculate */}
                                {result && o.line != null && (() => {
                                  const enteredLine = form.getValues("liveLine");
                                  const delta = Number(o.line) - Number(enteredLine);
                                  const isPositive = delta > 0;
                                  const fmt = (n: number) => n % 1 === 0 ? String(Math.round(n)) : n.toFixed(1);
                                  return (
                                    <div className="flex items-center justify-between w-full mt-1 pt-1 border-t border-border/30">
                                      <span className="text-muted-foreground/70">CLV vs your line</span>
                                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                                        isPositive
                                          ? "bg-emerald-500/15 text-emerald-400"
                                          : delta < 0
                                            ? "bg-red-500/10 text-red-400"
                                            : "bg-secondary text-muted-foreground"
                                      }`}>
                                        {delta === 0 ? "Even" : `${isPositive ? "+" : ""}${fmt(delta)} pt`}
                                      </span>
                                    </div>
                                  );
                                })()}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* CLV panel — under Lines by Book, shows after Calculate */}
                      {(() => {
                        if (!selectedSportsbook || selectedSportsbook === "manual" || !oddsData || !result) return null;
                        const selected = (oddsData as Record<string, import("@shared/schema").OddsLine>)[selectedSportsbook];
                        if (!selected?.overOdds) return null;
                        const overImplied = americanToImplied(selected.overOdds) * 100;
                        const underImplied = americanToImplied(selected.underOdds ?? -110) * 100;
                        const overEdge = result.probability - overImplied;
                        const underEdge = (100 - result.probability) - underImplied;
                        const bestEdge = overEdge >= underEdge ? { side: "Over", edge: overEdge } : { side: "Under", edge: underEdge };
                        const isPositive = bestEdge.edge > 0;
                        const absEdge = Math.abs(bestEdge.edge);
                        const valueLabel = absEdge >= 6 ? "Strong" : absEdge >= 3 ? "Moderate" : "Slight";
                        const sbName = SPORTSBOOK_LABELS[selectedSportsbook] ?? selectedSportsbook;
                        const hasMovement = selected.lineMovement !== undefined && selected.lineMovement !== 0;
                        const dropped = (selected.lineMovement ?? 0) < 0;
                        const enteredLine = form.getValues("liveLine");
                        const clvDelta = Number(selected.line) - Number(enteredLine);
                        const clvFmt = (n: number) => n % 1 === 0 ? String(Math.round(n)) : n.toFixed(1);
                        const clvLabel = clvDelta === 0 ? "Even" : `${clvDelta > 0 ? "+" : ""}${clvFmt(clvDelta)} pt`;
                        const clvPositive = clvDelta > 0;
                        return (
                          <div className={`rounded-xl border p-3 flex gap-2.5 items-start ${
                            isPositive ? "bg-emerald-500/10 border-emerald-500/30" : "bg-red-500/10 border-red-500/30"
                          }`}>
                            <div className={`mt-0.5 flex-shrink-0 font-bold text-base ${isPositive ? "text-emerald-400" : "text-red-400"}`}>
                              {isPositive ? "▲" : "▼"}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <h4 className={`text-xs font-semibold ${isPositive ? "text-emerald-400" : "text-red-400"}`}>
                                  {valueLabel} {bestEdge.side} CLV
                                </h4>
                                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
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
                              <p className="text-[10px] text-muted-foreground/60 mt-0.5">
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
                      {selectedSportsbook && selectedSportsbook !== "manual" && oddsData && (() => {
                        const mktOdds = (oddsData as Record<string, import("@shared/schema").OddsLine>)[selectedSportsbook];
                        if (!mktOdds?.overOdds) return null;
                        const ev = result.probability - americanToImplied(mktOdds.overOdds) * 100;
                        return (
                          <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                            ev > 0 ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/15 text-red-400"
                          }`}>
                            {ev > 0 ? "+" : ""}{Math.round(ev)}% EV
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                </div>

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

                {/* Share prompt — shown on strong results */}
                {(result.probability >= 65 || result.probability <= 35) && (() => {
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
                  const snippet = `🏀 ${playerName} ${isOver ? "Over" : "Under"} ${line} ${statLabel} — ${isOver ? prob : (100 - prob).toFixed(0)}% likely by @proppulsebets #LiveLocks`;
                  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(snippet)}`;
                  return (
                    <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 flex flex-col gap-3 animate-fade-in-up">
                      <div>
                        <p className="text-xs font-semibold text-foreground mb-1">🔥 Strong pick detected</p>
                        <p className="text-xs text-muted-foreground leading-relaxed">{snippet}</p>
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

        {/* Halftime Plays Tab Content */}
        {activeTab === "halftime" && (
          <div className={showParlay && !isMobile ? "flex items-start gap-5" : "space-y-4"}>
            <div className={showParlay && !isMobile ? "bg-card border border-border rounded-xl p-5 flex-1 min-w-0" : "bg-card border border-border rounded-xl p-5"}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Star className="w-5 h-5 text-primary" />
                    Top 2H Plays — Full Slate
                  </h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    Top 20 plays by probability edge across all halftime games. Includes overs and unders.
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
              <div className="flex flex-wrap gap-2 mb-4">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground font-medium">Prop:</span>
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
                        { value: "pts_reb", label: "Pts+Reb" },
                        { value: "pts_ast", label: "Pts+Ast" },
                        { value: "pts_reb_ast", label: "Pts+Reb+Ast" },
                        { value: "reb_ast", label: "Reb+Ast" },
                        { value: "stl_blk", label: "Stl+Blk" },
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
                  <div className="flex items-center gap-1.5 ml-auto">
                    <span className="text-xs text-muted-foreground font-medium">Confidence:</span>
                    <div className="flex gap-1">
                      {[
                        { value: "all", label: "All" },
                        { value: "high", label: "High ≥65%" },
                        { value: "medium", label: "Mod 55–65%" },
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

              {/* Locked teaser for free/unauthenticated users */}
              {halftimeLocked && !isHalftimePlaysLoading && (
                <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Lock className="w-7 h-7 text-primary" />
                  </div>
                  <div>
                    <p className="text-base font-bold text-foreground">2H Plays Require NBA Pro</p>
                    <p className="text-sm text-muted-foreground mt-1 max-w-xs mx-auto">
                      The 2H halftime slate scans every live game for high-probability props. Subscribe to unlock unlimited access.
                    </p>
                  </div>
                  <button
                    data-testid="button-halftime-upgrade"
                    onClick={() => { setUpgradeModalState({ playsUsed: user?.playsUsed ?? 10, limit: 10 }); setShowUpgradeModal(true); }}
                    className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors"
                  >
                    View Plans →
                  </button>
                </div>
              )}

              {!halftimeLocked && isHalftimePlaysLoading && (
                <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Calculating best plays…</span>
                </div>
              )}
              {!halftimeLocked && !isHalftimePlaysLoading && halftimePlaysData?.message && halftimePlaysData.plays.length === 0 && (
                <div className="text-center py-12 text-muted-foreground">
                  <Star className="w-8 h-8 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">{halftimePlaysData.message}</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Check back when games are at halftime.</p>
                </div>
              )}
              {!halftimeLocked && !isHalftimePlaysLoading && halftimePlaysData && halftimePlaysData.plays.length > 0 && filteredPlays.length === 0 && (
                <div className="text-center py-10 text-muted-foreground">
                  <p className="text-sm">No plays match the current filters.</p>
                  <button onClick={() => { setSlateFilterProp("all"); setSlateFilterProb("all"); }} className="text-xs text-primary mt-2 hover:underline">Clear filters</button>
                </div>
              )}
              {!halftimeLocked && !isHalftimePlaysLoading && halftimePlaysData && halftimePlaysData.plays.length > 0 && filteredPlays.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {filteredPlays.map((play: any, idx: number) => {
                    const isOver = play.betDirection === "over";
                    const isInjured = injuredPlayerNames.has(play.playerName.toLowerCase());
                    const statLabel = STAT_TYPES.find(s => s.value === play.statType)?.label ?? play.statType;
                    const hasLiveLine = play.lineSource === "odds_api";
                    const globalIdx = halftimePlaysData.plays.indexOf(play);
                    return (
                      <div
                        key={idx}
                        data-testid={`halftime-play-${idx}`}
                        className={`rounded-xl border p-4 space-y-2 relative cursor-pointer transition-all ${
                          isInjured
                            ? "border-red-500/40 bg-red-500/5 hover:border-red-500/60"
                            : "border-border/60 bg-secondary/30 hover:border-primary/40 hover:bg-secondary/50"
                        }`}
                        onClick={() => loadPlayInCalculator(play)}
                      >
                        <div className="absolute top-3 left-3 w-5 h-5 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center">
                          <span className="text-[9px] font-bold text-primary leading-none">#{globalIdx + 1}</span>
                        </div>
                        <div className="flex items-start justify-between gap-2 pl-7">
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
                            {(() => {
                              const displayProb = play.betDirection === "under"
                                ? Math.round((100 - play.probability) * 10) / 10
                                : play.probability;
                              return (
                                <>
                                  <div className={`text-xl font-bold font-mono ${
                                    displayProb >= 65 ? "text-green-400" :
                                    displayProb <= 35 ? "text-red-400" : "text-yellow-400"
                                  }`}>
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
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-xs font-mono px-2 py-0.5 rounded font-bold ${
                            isOver ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                          }`}>
                            {statLabel} {isOver ? "O" : "U"}{play.line}
                          </span>
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                            hasLiveLine
                              ? "bg-green-500/15 text-green-400"
                              : "bg-secondary text-muted-foreground"
                          }`}>
                            {hasLiveLine ? "Live Line" : "Season Avg"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            H1: {play.halftimeStat} · Proj: {play.expectedTotal?.toFixed(1)}
                          </span>
                          <span data-testid="hint-tap-verify" className="text-[10px] text-muted-foreground/50 italic">Tap card to cross-check →</span>
                        </div>
                        <button
                          type="button"
                          data-testid={`button-add-halftime-play-${idx}`}
                          disabled={parlayPicks.length >= 10}
                          onClick={(e) => {
                            e.stopPropagation();
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
                          }}
                          className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-semibold hover:bg-primary/20 transition-colors disabled:opacity-40"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          Add to Parlay
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {!halftimeLocked && !isHalftimePlaysLoading && !halftimePlaysData && (
                <div className="text-center py-12 text-muted-foreground">
                  <Star className="w-8 h-8 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No halftime plays available.</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Click Refresh to check for halftime games.</p>
                </div>
              )}
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

        {/* NCAAB Tab — live data for All Sports, Elite, and Admin */}
        {activeTab === "ncaab" && (user?.isAdmin || ["all", "elite"].includes(user?.subscriptionTier ?? "")) && (
          <NCAABAdminTab
            isAdmin={user?.isAdmin ?? false}
            onAddToParlay={(pick) => {
              if (parlayPicks.length < 10) {
                setParlayPicks((prev) => [...prev, pick]);
                setShowParlay(true);
              }
            }}
          />
        )}

      </main>

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
    </div>
  );
}
