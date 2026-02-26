import { useState, useEffect, useRef } from "react";
import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";
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

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
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
  const [selectedSportsbook, setSelectedSportsbook] = useState<string>("manual");
  const [autoFilledFields, setAutoFilledFields] = useState<Set<string>>(new Set());
  const [showBoxScore, setShowBoxScore] = useState(true);
  const [boxScoreFilter, setBoxScoreFilter] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [copiedPick, setCopiedPick] = useState(false);
  const [activeTab, setActiveTab] = useState<"calculator" | "halftime">("calculator");
  const [mlbPopoverOpen, setMlbPopoverOpen] = useState(false);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
  const { data: halftimePlaysData, isLoading: isHalftimePlaysLoading, refetch: refetchHalftimePlays } = useQuery<{ plays: any[]; message?: string }>({
    queryKey: ["/api/halftime-plays"],
    queryFn: async () => {
      const res = await fetch("/api/halftime-plays");
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

  // ── Play limit gating ─────────────────────────────────────────────────────
  useEffect(() => {
    if (calculateMutation.error instanceof PlayLimitError) {
      setUpgradeModalState({ playsUsed: calculateMutation.error.playsUsed, limit: calculateMutation.error.limit });
      setShowUpgradeModal(true);
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
    setAutoFilledFields(new Set(["halftimeMinutes", "halftimeFouls", "halftimeStat"]));
  }, [liveStats, selectedPlayer, watchedStatType]);

  const onSubmit = (data: CalculateProbabilityRequest) => {
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
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest mt-0.5">by PropPulse · NBA</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-500 text-xs font-medium hover:bg-amber-500/20 transition-colors"
              >
                <Zap className="w-3 h-3" />
                {Math.max(0, 10 - user.playsUsed)} free plays left
              </button>
            )}
            {user && user.subscriptionTier && (
              <span data-testid="text-subscription-tier" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-medium">
                <Star className="w-3 h-3" />
                {user.subscriptionTier === "all" ? "All Sports" : "NBA"}
              </span>
            )}
            <button
              onClick={() => syncRostersMutation.mutate()}
              disabled={syncRostersMutation.isPending}
              data-testid="button-sync-rosters"
              title="Pull latest rosters from ESPN to update player team assignments"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
            >
              {syncRostersMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Sync Rosters
            </button>
            <button
              onClick={() => setShowParlay(!showParlay)}
              data-testid="button-toggle-parlay"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/20 transition-colors"
            >
              <Trophy className="w-4 h-4" />
              Parlay Slip
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

      <main className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 mt-6 space-y-5">


        {/* Tab Navigation */}
        <div className="relative flex flex-col w-fit gap-0">
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
              Live Calculator
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
              Top 2H Plays
            </button>
            <button
              data-testid="tab-mlb-locked"
              onClick={() => setMlbPopoverOpen((v) => !v)}
              className="px-4 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-1.5 opacity-50 cursor-not-allowed text-muted-foreground"
            >
              <span role="img" aria-label="baseball">⚾</span>
              MLB
              <Lock className="w-3 h-3" />
            </button>
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

        {/* Live Games Strip */}
        {allGames.length > 0 && (
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


        {/* Live Box Score — shown when a game is selected and stats are available */}
        {selectedGameId && (liveStats || isLiveStatsLoading) && (
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
                  <div className="px-4 py-2 border-b border-border/40">
                    <div className="relative">
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
                        <th className="text-right px-3 py-2 font-medium">STL</th>
                        <th className="text-right px-3 py-2 font-medium">BLK</th>
                        <th className="text-right px-3 py-2 font-medium">PF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const filterLower = boxScoreFilter.toLowerCase().trim();
                        const playedStats = liveStats
                          .filter(s => s.minutes !== "0" && s.minutes !== "0:00")
                          .filter(s => !filterLower || s.playerName.toLowerCase().includes(filterLower));
                        const teams = Array.from(new Set(playedStats.map(s => s.teamAbbr)));
                        return teams.flatMap((team, ti) => [
                          <tr key={`team-${team}`} className={ti > 0 ? "border-t-2 border-border/60" : ""}>
                            <td colSpan={9} className="px-4 py-1 text-muted-foreground/60 font-semibold uppercase tracking-wider text-[10px] bg-secondary/20">
                              {espnToDb(team)} — {TEAM_FULL_NAMES[espnToDb(team)] ?? team}
                            </td>
                          </tr>,
                          ...playedStats
                            .filter(s => s.teamAbbr === team)
                            .sort((a, b) => {
                              const statForSort = (s: typeof a) => {
                                if (watchedStatType === "points") return s.points;
                                if (watchedStatType === "rebounds") return s.rebounds;
                                if (watchedStatType === "assists") return s.assists;
                                if (watchedStatType === "steals") return s.steals;
                                if (watchedStatType === "blocks") return s.blocks;
                                if (watchedStatType === "pts_reb_ast") return s.points + s.rebounds + s.assists;
                                if (watchedStatType === "pts_reb") return s.points + s.rebounds;
                                if (watchedStatType === "pts_ast") return s.points + s.assists;
                                if (watchedStatType === "reb_ast") return s.rebounds + s.assists;
                                if (watchedStatType === "stl_blk") return s.steals + s.blocks;
                                return s.points;
                              };
                              return statForSort(b) - statForSort(a);
                            })
                            .map((stat) => {
                              const isSelected = selectedPlayer && findPlayerByName(stat.playerName)?.id === selectedPlayer.id;
                              const statTotal = (() => {
                                if (watchedStatType === "points") return stat.points;
                                if (watchedStatType === "rebounds") return stat.rebounds;
                                if (watchedStatType === "assists") return stat.assists;
                                if (watchedStatType === "steals") return stat.steals;
                                if (watchedStatType === "blocks") return stat.blocks;
                                if (watchedStatType === "pts_reb_ast") return stat.points + stat.rebounds + stat.assists;
                                if (watchedStatType === "pts_reb") return stat.points + stat.rebounds;
                                if (watchedStatType === "pts_ast") return stat.points + stat.assists;
                                if (watchedStatType === "reb_ast") return stat.rebounds + stat.assists;
                                if (watchedStatType === "stl_blk") return stat.steals + stat.blocks;
                                return stat.points;
                              })();
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
                                  <td className="text-right px-3 py-2 font-mono">{stat.steals}</td>
                                  <td className="text-right px-3 py-2 font-mono">{stat.blocks}</td>
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
          <div className="lg:col-span-4 space-y-4">
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
                          {Object.entries(oddsData).map(([sb, odds]) => {
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
                    <div className="flex-shrink-0 z-10">
                      <ProbabilityRing probability={result.probability} />
                    </div>
                  </div>
                </div>

                {/* Stats Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
                </div>

                {/* Share prompt — shown on strong results */}
                {(result.probability >= 65 || result.probability <= 35) && (() => {
                  const playerName = (() => {
                    const id = form.getValues("playerId");
                    const p = (players ?? []).find(pl => pl.id === Number(id));
                    return p?.name ?? "Player";
                  })();
                  const statLabel = form.getValues("statType");
                  const line = form.getValues("liveLine");
                  const prob = result.probability;
                  const isOver = prob >= 65;
                  const snippet = `🏀 ${playerName} ${isOver ? "Over" : "Under"} ${line} ${statLabel} — ${isOver ? prob : (100 - prob).toFixed(0)}% likely via LiveLocks by PropPulse`;
                  return (
                    <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 flex items-center justify-between gap-4 animate-fade-in-up">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-foreground mb-0.5">Strong pick detected</p>
                        <p className="text-xs text-muted-foreground truncate">{snippet}</p>
                      </div>
                      <button
                        data-testid="button-copy-pick"
                        onClick={() => {
                          navigator.clipboard.writeText(snippet);
                          setCopiedPick(true);
                          setTimeout(() => setCopiedPick(false), 2000);
                        }}
                        className="shrink-0 flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                      >
                        {copiedPick ? <><Check className="w-3 h-3" /> Copied!</> : <><Copy className="w-3 h-3" /> Copy Pick</>}
                      </button>
                    </div>
                  );
                })()}

                {/* Line Value Panel — shows when a sportsbook with line movement is selected */}
                {(() => {
                  if (!selectedSportsbook || !oddsData) return null;
                  const selected = (oddsData as Record<string, import("@shared/schema").OddsLine>)[selectedSportsbook];
                  if (!selected || selected.lineMovement === undefined || selected.lineMovement === 0) return null;
                  const dropped = selected.lineMovement < 0;
                  const edge = selected.edgeEstimate ?? 0;
                  const absMove = Math.abs(selected.lineMovement);
                  const absEdge = Math.abs(edge);
                  const valueLabel = absEdge >= 6 ? "Strong" : absEdge >= 3 ? "Moderate" : "Slight";
                  const favorsSide = dropped ? "Over" : "Under";
                  return (
                    <div className={`rounded-xl border p-4 flex gap-3 items-start ${
                      dropped
                        ? "bg-emerald-500/10 border-emerald-500/30"
                        : "bg-orange-500/10 border-orange-500/30"
                    }`}>
                      <div className={`mt-0.5 flex-shrink-0 text-lg font-bold ${dropped ? "text-emerald-400" : "text-orange-400"}`}>
                        {dropped ? "▼" : "▲"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <h4 className={`text-sm font-semibold ${dropped ? "text-emerald-400" : "text-orange-400"}`}>
                            {valueLabel} {favorsSide} Value — Line Movement Detected
                          </h4>
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                            dropped
                              ? "bg-emerald-500/20 text-emerald-300"
                              : "bg-orange-500/20 text-orange-300"
                          }`}>
                            {edge > 0 ? "+" : ""}{edge}% vs Open
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">
                          {SPORTSBOOK_LABELS[selectedSportsbook] ?? selectedSportsbook} line moved{" "}
                          <strong>{dropped ? "down" : "up"} {absMove} pt{absMove !== 1 ? "s" : ""}</strong>{" "}
                          from session open ({selected.openLine} → {selected.line}).{" "}
                          {dropped
                            ? `Lower threshold favors the Over — estimated +${absEdge}% probability gain vs. the open line.`
                            : `Higher threshold favors the Under — estimated +${absEdge}% probability gain vs. the open line.`
                          }
                        </p>
                        <p className="text-xs text-muted-foreground/60 mt-1.5">
                          Session open = first line seen since server start. Refresh regularly to track real-time movement.
                        </p>
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

          {/* RIGHT: Parlay Slip */}
          {showParlay && (
            <div className="lg:col-span-3">
              <div className="bg-card border border-border rounded-xl p-4 sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto">
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
          <div className="space-y-4">
            <div className="bg-card border border-border rounded-xl p-5">
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

              {isHalftimePlaysLoading ? (
                <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Calculating best plays…</span>
                </div>
              ) : halftimePlaysData?.message && halftimePlaysData.plays.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Star className="w-8 h-8 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">{halftimePlaysData.message}</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Check back when games are at halftime.</p>
                </div>
              ) : halftimePlaysData && halftimePlaysData.plays.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {halftimePlaysData.plays.map((play: any, idx: number) => {
                    const isOver = play.betDirection === "over";
                    const isInjured = injuredPlayerNames.has(play.playerName.toLowerCase());
                    const statLabel = STAT_TYPES.find(s => s.value === play.statType)?.label ?? play.statType;
                    const hasLiveLine = play.lineSource === "odds_api";
                    return (
                      <div
                        key={idx}
                        data-testid={`halftime-play-${idx}`}
                        className={`rounded-xl border p-4 space-y-2 relative ${
                          isInjured ? "border-red-500/40 bg-red-500/5" : "border-border/60 bg-secondary/30"
                        }`}
                      >
                        <div className="absolute top-3 left-3 w-5 h-5 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center">
                          <span className="text-[9px] font-bold text-primary leading-none">#{idx + 1}</span>
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
                            <div className={`text-xl font-bold font-mono ${
                              play.probability >= 65 ? "text-green-400" :
                              play.probability <= 35 ? "text-red-400" : "text-yellow-400"
                            }`}>
                              {play.probability.toFixed(1)}%
                            </div>
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
                        </div>
                        <button
                          type="button"
                          data-testid={`button-add-halftime-play-${idx}`}
                          disabled={parlayPicks.length >= 10}
                          onClick={() => {
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
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  <Star className="w-8 h-8 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No halftime plays available.</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Click Refresh to check for halftime games.</p>
                </div>
              )}
            </div>
          </div>
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
    </div>
  );
}
