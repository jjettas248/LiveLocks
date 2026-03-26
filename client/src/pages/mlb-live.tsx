import { useState, useEffect, useRef, Component, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ProbabilityRing } from "@/components/probability-ring";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { MLBScheduleList } from "@/components/mlb/MLBScheduleList";

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
          <button
            className="text-xs text-primary underline"
            onClick={() => this.setState({ hasError: false, message: "" })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

type MLBGameMarket = {
  line: number | null;
  odds: { overOdds: number | null; underOdds: number | null } | null;
  projection: number | null;
  edge: number | null;
  probability: number | null;
  oddsUpdatedAt: string | null;
  projectionUpdatedAt: string | null;
};

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
  status: "live" | "pregame" | null;
  startTime?: string | null;
  venue?: string | null;
  weatherSummary?: string | null;
  pitcherAway?: string | null;
  pitcherHome?: string | null;
  awayPitcherHand?: string | null;
  homePitcherHand?: string | null;
  pitcherName?: string | null;
  pitcherThrows?: "L" | "R" | null;
  pitcherTeam?: string | null;
  hasOdds?: boolean;
  signalLocked?: boolean;
  market?: MLBGameMarket | null;
};

// ── Client-side signal helpers ────────────────────────────────────────────────

const STALE_MS = 120_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFresh(ts?: string | null): boolean {
  if (!ts) return false;
  const ms = new Date(ts).getTime();
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms <= STALE_MS;
}

function hasRealOdds(market: MLBGameMarket | null | undefined): boolean {
  if (!market) return false;
  if (!isFiniteNumber(market.line)) return false;
  if (!market.odds) return false;
  const hasSide = isFiniteNumber(market.odds.overOdds) || isFiniteNumber(market.odds.underOdds);
  if (!hasSide) return false;
  if (!isFresh(market.oddsUpdatedAt)) return false;
  return true;
}

function canShowSignal(market: MLBGameMarket | null | undefined): boolean {
  if (!hasRealOdds(market)) return false;
  if (!market) return false;
  if (!isFiniteNumber(market.projection)) return false;
  if (!isFresh(market.projectionUpdatedAt)) return false;
  return true;
}

function hasEdge(market: MLBGameMarket | null | undefined): boolean {
  return isFiniteNumber(market?.edge) && Math.abs(market!.edge) >= 5;
}

type MLBGamesResponse = {
  mode: "live" | "preview" | "preview_locked";
  games: MLBGame[];
  previewPlayers?: PreviewPlayer[];
};

type PreviewPlayer = {
  playerName: string | null;
  matchup: string;
  projection: string;
  tags: string[];
};

type MLBBatter = {
  playerId: string;
  playerName: string;
  teamAbbr: string;
  battingOrderSlot: number;
  ab: number;
  h: number;
  tb: number;
  r: number;
  rbi: number;
  bb: number;
  sb: number;
  k: number;
  lastABOutcome?: "hit" | "out" | "strikeout" | "walk" | "hbp" | "error" | "other" | null;
};

type MLBSignal = {
  playerId: string;
  playerName: string;
  market: string;
  bookLine: number | null;
  enginePct: number;
  edge: number | null;
  odds: { bookLine: number } | null;
  recommendedSide: "OVER" | "UNDER" | "NO_EDGE";
  inning: number;
  tier: "green" | "yellow" | "teal" | "red";
  gameId?: string;
  sportsbook?: string | null;
  derivedLine?: boolean;
  signalTimestamp?: number | null;
  // Phase 8: truth layer additions
  lineSource?: "sportsbook" | "inferred" | "derived" | null;
  availableBooks?: string[] | null;
  bestOdds?: { overOdds: number | null; underOdds: number | null; sportsbook: string | null } | null;
  lineVariance?: number | null;
};

type SignalsResponse = {
  mode: "live" | "no_lines" | "preview" | "preview_locked";
  signals: MLBSignal[];
  updatedAt: number;
  isDegraded?: boolean;
};

type OddsEntry = {
  line: number;
  overOdds: number;
  underOdds: number;
};

type CalcResult = {
  market: string;
  projection: number;
  bookLine: number;
  calibratedProbabilityOver: number;
  calibratedProbabilityUnder: number;
  edge: number;
  recommendedSide: string;
  confidenceTier: string;
  expectedHits: number | null;
  remainingPA: number | null;
  adjustedHitRate: number | null;
  bookImplied: number | null;
  explanationBullets: string[];
  mode?: string;
  isManual?: boolean;
  label?: string;
};

type ManualHitterInputs = {
  pa: string;
  hits: string;
  totalBases: string;
  walks: string;
  k: string;
  battingOrder: string;
};

type ManualPitcherInputs = {
  pitchCount: string;
  ip: string;
  k: string;
  hitsAllowed: string;
  walks: string;
};

type ManualGameContext = {
  inning: string;
  score: string;
  outs: string;
  runners: string;
  isTopInning: boolean;
};

type ManualInputState = {
  hitter: ManualHitterInputs;
  pitcher: ManualPitcherInputs;
  context: ManualGameContext;
  bookLine: string;
};

const TIER_STYLES: Record<string, { border: string; bg: string; dot: string; label: string }> = {
  green:  { border: "#22c55e", bg: "rgba(34,197,94,0.07)",   dot: "#22c55e", label: "Strong Over" },
  red:    { border: "#ef4444", bg: "rgba(239,68,68,0.07)",   dot: "#ef4444", label: "Strong Under" },
  yellow: { border: "#eab308", bg: "rgba(234,179,8,0.07)",   dot: "#eab308", label: "Lean" },
  teal:   { border: "#00d4aa", bg: "rgba(0,212,170,0.07)",   dot: "#00d4aa", label: "Monitor" },
};

const MARKET_LABELS: Record<string, string> = {
  hits: "Hits",
  total_bases: "Total Bases",
  batter_k: "K (Batter)",
  batter_strikeouts: "K (Batter)",
  pitcher_k: "K (Pitcher)",
  pitcher_strikeouts: "K (Pitcher)",
  hits_allowed: "Hits Allowed",
  walks_allowed: "Walks Allowed",
  hr: "Home Runs",
  home_runs: "Home Runs",
  hrr: "HRR",
};

const INNING_TABS: { label: string; min: number }[] = [
  { label: "Live Props", min: 0 },
  { label: "3rd Inning", min: 3 },
  { label: "5th Inning", min: 5 },
  { label: "7th Inning", min: 7 },
];

const BATTER_MARKETS = [
  { value: "hits", label: "Hits" },
  { value: "total_bases", label: "Total Bases" },
  { value: "hr", label: "Home Runs" },
  { value: "batter_k", label: "Strikeouts (B)" },
];

const PITCHER_MARKETS = [
  { value: "pitcher_k", label: "K (Pitcher)" },
  { value: "walks_allowed", label: "Walks Allowed" },
  { value: "hits_allowed", label: "Hits Allowed" },
];

const SPORTSBOOK_LABELS: Record<string, string> = {
  fanduel: "FanDuel",
  draftkings: "DraftKings",
  hardrockbet: "Hard Rock",
  betmgm: "BetMGM",
  caesars: "Caesars",
  pointsbet: "PointsBet",
  bet365: "Bet365",
  betrivers: "BetRivers",
  prizepicks: "PrizePicks",
  underdog: "Underdog",
};

const PITCHER_MARKET_SET = new Set(["pitcher_k", "pitcher_strikeouts", "hits_allowed", "walks_allowed"]);

function inningLabel(game: MLBGame): string {
  if (game.status === "pregame") return "Pre-Game";
  if (!game.inning) return "—";
  const half = game.isTopInning ? "▲" : "▼";
  return `${half}${game.inning}`;
}

function timeSince(ms: number): string {
  if (!ms) return "never";
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

function formatOdds(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function isValidSignal(sig: MLBSignal, selectedGameId: string, rosterPlayerIds?: Set<string>): boolean {
  if (!sig.playerId) return false;
  if (!sig.market) return false;
  if (sig.bookLine == null) return false;
  if (typeof sig.enginePct !== "number" || !Number.isFinite(sig.enginePct)) return false;
  if (sig.enginePct < 0 || sig.enginePct > 100) return false;
  if (sig.edge !== null && sig.edge !== undefined && (typeof sig.edge !== "number" || !Number.isFinite(sig.edge))) return false;
  if (sig.gameId !== selectedGameId) return false;
  if (rosterPlayerIds && rosterPlayerIds.size > 0 && !PITCHER_MARKET_SET.has(sig.market) && !rosterPlayerIds.has(String(sig.playerId))) return false;
  return true;
}

function defaultManualInputs(player: MLBBatter | null, game: MLBGame | null): ManualInputState {
  return {
    hitter: {
      pa: player ? String(player.ab + player.bb) : "",
      hits: player ? String(player.h) : "",
      totalBases: player ? String(player.tb) : "",
      walks: player ? String(player.bb) : "",
      k: player ? String(player.k) : "",
      battingOrder: player ? String(player.battingOrderSlot) : "",
    },
    pitcher: {
      pitchCount: "",
      ip: "",
      k: "",
      hitsAllowed: "",
      walks: "",
    },
    context: {
      inning: game ? String(game.inning) : "1",
      score: game && game.status === "live" && game.awayScore != null && game.homeScore != null
        ? `${game.awayScore}-${game.homeScore}`
        : "0-0",
      outs: "0",
      runners: "0",
      isTopInning: game ? game.isTopInning : true,
    },
    bookLine: "",
  };
}

function MlbLiveInner() {
  const { user, isLoading: authLoading } = useAuth();
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [inningTabMin, setInningTabMin] = useState<number>(0);
  const [boxExpanded, setBoxExpanded] = useState(true);
  const [selectedPlayer, setSelectedPlayer] = useState<MLBBatter | null>(null);
  const [selectedMarket, setSelectedMarket] = useState("hits");
  const [selectedLine, setSelectedLine] = useState<{ book: string; line: number; overOdds: number; underOdds: number } | null>(null);
  const [calcResult, setCalcResult] = useState<CalcResult | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualInputs, setManualInputs] = useState<ManualInputState>(defaultManualInputs(null, null));

  const { data: gamesResp, isLoading: gamesLoading } = useQuery<MLBGamesResponse>({
    queryKey: ["/api/mlb/live-games"],
    refetchInterval: 30_000,
  });

  const responseMode = gamesResp?.mode ?? "preview";
  const games = Array.isArray(gamesResp?.games) ? gamesResp!.games : [];
  const previewPlayers = Array.isArray(gamesResp?.previewPlayers) ? gamesResp!.previewPlayers : [];
  const hasAnyOdds = games.some((g) => g?.hasOdds === true);
  const isElite = user?.isAdmin || user?.subscriptionTier === "elite";

  const { data: playersRaw, isLoading: playersLoading } = useQuery<MLBBatter[]>({
    queryKey: ["/api/mlb/live-stats", selectedGameId],
    enabled: !!selectedGameId,
    refetchInterval: 30_000,
  });
  const players = Array.isArray(playersRaw) ? playersRaw : [];

  const { data: signalsResp, isLoading: signalsLoading } = useQuery<SignalsResponse>({
    queryKey: ["/api/mlb/live-signals", selectedGameId],
    enabled: !!selectedGameId,
    refetchInterval: 90_000,
  });

  const signalMode = signalsResp?.mode ?? "no_lines";
  const signals = Array.isArray(signalsResp?.signals) ? signalsResp!.signals : [];
  const updatedAt = signalsResp?.updatedAt ?? 0;
  const signalsDegraded = signalsResp?.isDegraded ?? false;
  const selectedGameRaw = games.find((g) => g?.gameId === selectedGameId) ?? null;
  const selectedGameRef = useRef<MLBGame | null>(null);

  useEffect(() => {
    if (selectedGameRaw) {
      selectedGameRef.current = selectedGameRaw;
    }
  }, [selectedGameRaw]);

  const selectedGame = selectedGameRaw ?? selectedGameRef.current;

  const opponentTeam = selectedPlayer && selectedGame
    ? (selectedPlayer.teamAbbr === selectedGame.homeAbbr ? selectedGame.awayAbbr : selectedGame.homeAbbr)
    : null;

  const { data: oddsData, isLoading: oddsLoading } = useQuery<Record<string, OddsEntry>>({
    queryKey: ["/api/mlb/odds", selectedPlayer?.teamAbbr, opponentTeam, selectedPlayer?.playerName, selectedMarket],
    enabled: !!selectedPlayer && !!opponentTeam,
    refetchInterval: 120_000,
    queryFn: async () => {
      const params = new URLSearchParams({
        playerTeam: selectedPlayer!.teamAbbr,
        opponentTeam: opponentTeam!,
        playerName: selectedPlayer!.playerName,
        statType: selectedMarket,
        inPlay: selectedGame?.status === "live" ? "true" : "false",
      });
      const res = await fetch(`/api/mlb/odds?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch odds");
      return res.json();
    },
  });

  const calcMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPlayer || !selectedGame) throw new Error("Missing data");

      if (manualMode) {
        const bookLine = parseFloat(manualInputs.bookLine);
        if (isNaN(bookLine) || bookLine <= 0) throw new Error("Book line is required and must be positive");

        const isPitcherMarket = PITCHER_MARKET_SET.has(selectedMarket);
        const body = {
          playerId: selectedPlayer.playerId,
          playerName: selectedPlayer.playerName,
          market: selectedMarket,
          bookLine,
          team: selectedPlayer.teamAbbr,
          opponent: opponentTeam,
          gameId: selectedGame.gameId,
          currentStats: isPitcherMarket ? {} : {
            pa: manualInputs.hitter.pa ? parseInt(manualInputs.hitter.pa, 10) : selectedPlayer.ab + selectedPlayer.bb,
            hits: manualInputs.hitter.hits ? parseInt(manualInputs.hitter.hits, 10) : selectedPlayer.h,
            totalBases: manualInputs.hitter.totalBases ? parseInt(manualInputs.hitter.totalBases, 10) : selectedPlayer.tb,
            walks: manualInputs.hitter.walks ? parseInt(manualInputs.hitter.walks, 10) : selectedPlayer.bb,
            k: manualInputs.hitter.k ? parseInt(manualInputs.hitter.k, 10) : selectedPlayer.k,
            battingOrder: manualInputs.hitter.battingOrder ? parseInt(manualInputs.hitter.battingOrder, 10) : selectedPlayer.battingOrderSlot,
          },
          pitcherProps: isPitcherMarket ? {
            pitchCount: manualInputs.pitcher.pitchCount ? parseInt(manualInputs.pitcher.pitchCount, 10) : 0,
            ip: manualInputs.pitcher.ip ? parseFloat(manualInputs.pitcher.ip) : null,
            k: manualInputs.pitcher.k ? parseInt(manualInputs.pitcher.k, 10) : null,
            hitsAllowed: manualInputs.pitcher.hitsAllowed ? parseInt(manualInputs.pitcher.hitsAllowed, 10) : null,
            walks: manualInputs.pitcher.walks ? parseInt(manualInputs.pitcher.walks, 10) : null,
          } : {},
          gameContext: {
            inning: manualInputs.context.inning ? parseInt(manualInputs.context.inning, 10) : selectedGame.inning,
            isTopInning: manualInputs.context.isTopInning,
            runners: manualInputs.context.runners ? parseInt(manualInputs.context.runners, 10) : 0,
            outs: manualInputs.context.outs ? parseInt(manualInputs.context.outs, 10) : 0,
            score: manualInputs.context.score ||
              (selectedGame.status === "live" && selectedGame.awayScore != null && selectedGame.homeScore != null
                ? `${selectedGame.awayScore}-${selectedGame.homeScore}`
                : "0-0"),
          },
        };
        const res = await apiRequest("POST", "/api/mlb/calculate-manual", body);
        return res.json();
      }

      if (!selectedLine) throw new Error("Missing line selection");
      const body = {
        playerId: selectedPlayer.playerId,
        playerName: selectedPlayer.playerName,
        market: selectedMarket,
        line: selectedLine.line,
        overOdds: selectedLine.overOdds,
        team: selectedPlayer.teamAbbr,
        opponent: opponentTeam,
        gameId: selectedGame.gameId,
        currentInning: selectedGame.inning,
        isTopInning: selectedGame.isTopInning,
        battingOrderSlot: selectedPlayer.battingOrderSlot,
        currentStats: {
          ab: selectedPlayer.ab,
          h: selectedPlayer.h,
          tb: selectedPlayer.tb,
          bb: selectedPlayer.bb,
          k: selectedPlayer.k,
          sb: selectedPlayer.sb,
          rbi: selectedPlayer.rbi,
        },
      };
      const res = await apiRequest("POST", "/api/mlb/calculate", body);
      return res.json();
    },
    onSuccess: (data) => {
      setCalcResult(data);
    },
  });

  useEffect(() => {
    setSelectedLine(null);
    setCalcResult(null);
    setManualMode(false);
  }, [selectedMarket]);

  useEffect(() => {
    setSelectedLine(null);
    setCalcResult(null);
    setManualMode(false);
    if (selectedPlayer) {
      setManualInputs(defaultManualInputs(selectedPlayer, selectedGame));
    }
  }, [selectedPlayer?.playerId]);

  // Reset all state when switching games
  useEffect(() => {
    setSelectedPlayer(null);
    setCalcResult(null);
    setSelectedLine(null);
    setSelectedMarket("hits");
    setManualMode(false);
    setManualInputs(defaultManualInputs(null, null));
  }, [selectedGameId]);

  const oddsEntries = oddsData
    ? Object.entries(oddsData).filter(([k]) => k !== "_quotaExhausted")
    : [];

  useEffect(() => {
    const noOdds = !oddsLoading && oddsEntries.length === 0 && selectedPlayer;
    if (noOdds || !hasAnyOdds) {
      setManualMode(true);
      setManualInputs(defaultManualInputs(selectedPlayer, selectedGame));
    } else if (oddsEntries.length > 0) {
      setManualMode(false);
    }
  }, [oddsLoading, oddsEntries.length, selectedPlayer?.playerId, hasAnyOdds]);

  const playerTierMap = new Map<string, string>();
  for (const sig of signals) {
    if (!sig || !sig.playerId) continue;
    const existing = playerTierMap.get(sig.playerId);
    if (!existing) {
      playerTierMap.set(sig.playerId, sig.tier);
    } else {
      const existingSignal = signals.find((s) => s?.playerId === sig.playerId && s?.tier === existing);
      const existingEdge = existingSignal?.edge ?? 0;
      const sigEdge = sig.edge ?? 0;
      if (sigEdge > existingEdge) {
        playerTierMap.set(sig.playerId, sig.tier);
      }
    }
  }

  const currentInning = selectedGame?.inning ?? 0;
  const rosterPlayerIds = new Set<string>(players.filter((p) => p && p.playerId != null).map((p) => String(p.playerId)));

  const validatedSignals = selectedGameId
    ? signals.filter((sig) => sig && isValidSignal(sig, selectedGameId, rosterPlayerIds))
    : [];

  const filteredSignals = inningTabMin === 0
    ? validatedSignals
    : validatedSignals.filter((s) => s && s.inning >= inningTabMin);

  const isPitcherMarket = PITCHER_MARKET_SET.has(selectedMarket);
  const manualCanCalc = manualMode && manualInputs.bookLine.trim() !== "" && !isNaN(parseFloat(manualInputs.bookLine)) && parseFloat(manualInputs.bookLine) > 0;
  const canCalculate = manualMode ? manualCanCalc : !!selectedLine;

  // Determine the effective UI mode for the signals panel
  function getUiMode(): "live" | "preview" | "preview_locked" | "manual" | "no_lines" {
    if (manualMode && calcResult?.isManual) return "manual";
    if (!selectedGameId) return "preview";
    if (!isElite) return "preview_locked";
    if (signalMode === "no_lines") return "no_lines";
    if (signalMode === "live") return "live";
    return "no_lines";
  }

  const uiMode = getUiMode();

  if (authLoading || gamesLoading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-12 flex flex-col items-center justify-center gap-3">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">Loading MLB…</span>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Schedule layer — always rendered when games exist, independent of signal state */}
      {gamesLoading && (
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">Today's Games</span>
          <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>
        </div>
      )}
      {!gamesLoading && games.length === 0 && (
        <div className="text-xs text-muted-foreground py-3" data-testid="text-no-mlb-games-today">
          No MLB games scheduled today. Check back soon.
        </div>
      )}
      {!gamesLoading && games.length > 0 && (
        <MLBScheduleList
          games={games}
          selectedGameId={selectedGameId}
          onSelectGame={setSelectedGameId}
        />
      )}

      {/* Preview/locked state when no game selected */}
      {!selectedGameId && (responseMode === "preview" || responseMode === "preview_locked") && previewPlayers.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Projected Opportunities</h2>
            {!isElite && (
              <span className="text-xs text-muted-foreground">
                {responseMode === "preview" ? "Lines forming…" : "Elite tier required"}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {previewPlayers.map((p, i) => {
              if (!p || (!p.playerName && !p.matchup)) return null;
              return (
              <div
                key={i}
                data-testid={`card-mlb-preview-${i}`}
                className="rounded-xl border border-border/40 bg-card p-4 relative overflow-hidden"
              >
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="text-sm font-semibold text-foreground">{p.playerName ?? p.matchup}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{p.playerName ? p.matchup : "Edges forming"}</div>
                  </div>
                  <div className="flex gap-1 flex-wrap justify-end">
                    {(Array.isArray(p.tags) ? p.tags : []).map((tag, ti) => (
                      <span key={ti} className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-xs font-medium text-foreground">{p.projection}</div>
                {!isElite && (
                  <div className="mt-3 flex items-center gap-3">
                    <div className="flex-1 h-6 bg-secondary/30 rounded flex items-center justify-center">
                      <span className="text-[10px] text-muted-foreground/50 font-medium">Probability locked</span>
                    </div>
                    <div className="flex-1 h-6 bg-secondary/30 rounded flex items-center justify-center">
                      <span className="text-[10px] text-muted-foreground/50 font-medium">Edge locked</span>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>

          {!isElite && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 text-center space-y-3">
              <div className="text-sm font-bold text-foreground">Unlock MLB Edges</div>
              <div className="text-xs text-muted-foreground">
                {responseMode === "preview"
                  ? "Sportsbook lines are still forming. All Sports members get instant alerts when live odds are available."
                  : "Upgrade to All Sports to see live probabilities, edge percentages, and bet recommendations for every MLB game."}
              </div>
              <a
                href="/upgrade"
                data-testid="link-mlb-upgrade-cta"
                className="inline-block px-5 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors"
              >
                Upgrade to All Sports →
              </a>
            </div>
          )}
        </div>
      )}

      {/* Main content: only shown after game selection */}
      {selectedGameId && selectedGame && (
        <>
          <div className="flex items-center gap-3" data-testid="text-mlb-game-header">
            <h2 className="text-sm font-semibold text-foreground">
              {selectedGame.awayAbbr} vs {selectedGame.homeAbbr}
            </h2>
            {selectedGame.status === "live" && selectedGame.awayScore != null && selectedGame.homeScore != null && (
              <span className="text-xs text-muted-foreground font-mono">
                {selectedGame.awayScore}–{selectedGame.homeScore}
              </span>
            )}
            <span className={`text-xs ${selectedGame.status === "live" ? "text-green-500" : "text-muted-foreground"}`}>
              {inningLabel(selectedGame)}
            </span>
            {selectedGame.venue && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border/40">
                {selectedGame.venue}
              </span>
            )}
            {selectedGame.weatherSummary && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border/40">
                {selectedGame.weatherSummary}
              </span>
            )}
          </div>

          <div className="flex gap-1.5 flex-wrap">
            {INNING_TABS.map((tab) => {
              const disabled = tab.min > 0 && currentInning < tab.min;
              const active = inningTabMin === tab.min;
              return (
                <button
                  key={tab.min}
                  data-testid={`tab-mlb-inning-${tab.min}`}
                  onClick={() => !disabled && setInningTabMin(tab.min)}
                  disabled={disabled}
                  className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : disabled
                        ? "border-border/40 text-muted-foreground/40 cursor-not-allowed"
                        : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Box score */}
          {selectedPlayer === null && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <button
              data-testid="button-toggle-boxscore"
              onClick={() => setBoxExpanded(prev => !prev)}
              className="w-full px-4 py-3 border-b border-border/60 flex items-center justify-between hover:bg-muted/30 transition-colors"
            >
              <h2 className="text-sm font-semibold text-foreground">
                {boxExpanded ? "▾ Box Score" : "▸ Box Score"}
              </h2>
              {playersLoading && (
                <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>
              )}
            </button>

            {boxExpanded && (
              <>
                {!playersLoading && players.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="text-no-boxscore">
                    No box score data available yet.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/60 bg-muted/40">
                          <th className="px-4 py-2 text-left font-semibold text-muted-foreground w-[180px]">Player</th>
                          <th className="px-3 py-2 text-center font-semibold text-muted-foreground">AB</th>
                          <th className="px-3 py-2 text-center font-semibold text-muted-foreground">H</th>
                          <th className="px-3 py-2 text-center font-semibold text-muted-foreground">TB</th>
                          <th className="px-3 py-2 text-center font-semibold text-muted-foreground">R</th>
                          <th className="px-3 py-2 text-center font-semibold text-muted-foreground">RBI</th>
                          <th className="px-3 py-2 text-center font-semibold text-muted-foreground">BB</th>
                          <th className="px-3 py-2 text-center font-semibold text-muted-foreground">SB</th>
                          <th className="px-3 py-2 text-center font-semibold text-muted-foreground">K</th>
                        </tr>
                      </thead>
                      <tbody>
                        {players.map((p) => {
                          if (!p || !p.playerId) return null;
                          const tier = playerTierMap.get(p.playerId);
                          const style = tier ? TIER_STYLES[tier] : null;
                          return (
                            <tr
                              key={p.playerId}
                              data-testid={`row-mlb-batter-${p.playerId}`}
                              onClick={() => {
                                setSelectedPlayer(p);
                                setCalcResult(null);
                                setSelectedLine(null);
                              }}
                              style={style ? { backgroundColor: style.bg, borderLeft: `3px solid ${style.border}` } : {}}
                              className="border-b border-border/30 last:border-0 cursor-pointer hover:bg-neutral-800 transition"
                            >
                              <td className="px-4 py-2">
                                <div className="font-medium text-foreground truncate max-w-[160px]">{p.playerName}</div>
                                <div className="text-muted-foreground text-[10px]">{p.teamAbbr} · #{p.battingOrderSlot}</div>
                              </td>
                              <td className="px-3 py-2 text-center text-foreground">{p.ab}</td>
                              <td className="px-3 py-2 text-center text-foreground">{p.h}</td>
                              <td className="px-3 py-2 text-center text-foreground">{p.tb}</td>
                              <td className="px-3 py-2 text-center text-foreground">{p.r}</td>
                              <td className="px-3 py-2 text-center text-foreground">{p.rbi}</td>
                              <td className="px-3 py-2 text-center text-foreground">{p.bb}</td>
                              <td className="px-3 py-2 text-center text-foreground">{p.sb}</td>
                              <td className="px-3 py-2 text-center text-foreground">{p.k}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
          )}

          {/* Signal/preview panel — deterministic render contract ─────────────────
              Resolves to exactly ONE of: PREVIEW | NO_SIGNAL | SIGNAL
              - PREVIEW:   no valid odds for this game yet
              - NO_SIGNAL: odds exist + no qualifying edge (signalMode is not "live", or live with 0 filtered signals)
              - SIGNAL:    odds exist + signalMode === "live" + filteredSignals.length > 0
              NOTE: entitlement (isElite) is an overlay — it renders a paywall inside each state,
              not a separate state. This keeps state semantics tied to data, not access tier. */}
          {selectedPlayer === null && (() => {
            // Compute single panel state — mutually exclusive; strictly based on data availability
            const panelState: "PREVIEW" | "NO_SIGNAL" | "SIGNAL" = (() => {
              if (!selectedGame.hasOdds) return "PREVIEW";
              if (signalMode === "live" && filteredSignals.length > 0) return "SIGNAL";
              return "NO_SIGNAL";
            })();

            const pitcherBothPresent =
              !!(selectedGame.pitcherAway?.trim() && selectedGame.pitcherHome?.trim());

            const gameStatusBadge = (
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                selectedGame.status === "live"
                  ? "bg-green-500/15 text-green-500"
                  : "bg-muted text-muted-foreground"
              }`}>
                {selectedGame.status === "live" ? "LIVE" : "PRE-GAME"}
              </span>
            );

            const gameTeamHeader = (
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    {selectedGame.awayAbbr} vs {selectedGame.homeAbbr}
                  </div>
                  {selectedGame.awayTeam && selectedGame.homeTeam && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {selectedGame.awayTeam} vs {selectedGame.homeTeam}
                    </div>
                  )}
                </div>
                {gameStatusBadge}
              </div>
            );

            const pitcherPill = pitcherBothPresent ? (
              <div className="flex gap-2 text-xs">
                <span className="px-2 py-1 rounded bg-secondary/50 border border-border/30 text-muted-foreground">
                  {selectedGame.pitcherAway}
                </span>
                <span className="self-center text-muted-foreground/40">vs</span>
                <span className="px-2 py-1 rounded bg-secondary/50 border border-border/30 text-muted-foreground">
                  {selectedGame.pitcherHome}
                </span>
              </div>
            ) : null;

            return (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-foreground">
                    {panelState === "SIGNAL" ? "Edge Signals" : "Projected Opportunities"}
                  </h2>
                  <div className="flex items-center gap-3">
                    {updatedAt > 0 && isElite && (
                      <span className="text-xs text-muted-foreground" data-testid="text-mlb-signals-freshness">
                        Updated {timeSince(updatedAt)}
                      </span>
                    )}
                    {signalsLoading && (
                      <span className="text-xs text-muted-foreground animate-pulse">Refreshing…</span>
                    )}
                  </div>
                </div>

                {panelState === "PREVIEW" && (
                  <div>
                    <div
                      data-testid="card-mlb-game-preview"
                      className="rounded-xl border border-border/40 bg-card p-5 space-y-3"
                    >
                      {gameTeamHeader}
                      {pitcherPill}
                      <div className="text-xs text-muted-foreground/70 font-medium" data-testid="text-mlb-awaiting-lines">
                        Awaiting live lines
                      </div>
                    </div>
                    {!isElite && (
                      <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 text-center space-y-3 mt-4">
                        <div className="text-sm font-bold text-foreground">Unlock MLB Edges</div>
                        <div className="text-xs text-muted-foreground">
                          Upgrade to All Sports to see live probabilities, edge percentages, and bet recommendations.
                        </div>
                        <a
                          href="/upgrade"
                          data-testid="link-mlb-upgrade-cta-signals"
                          className="inline-block px-5 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors"
                        >
                          Upgrade to All Sports →
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {panelState === "NO_SIGNAL" && (
                  <div
                    data-testid="card-mlb-game-no-signal"
                    className="rounded-xl border border-border/40 bg-card p-5 space-y-3"
                  >
                    {gameTeamHeader}
                    {pitcherPill}
                    <div className="text-xs text-muted-foreground" data-testid="text-no-signals">
                      {selectedGame.status !== "live"
                        ? "No live data available yet — edges appear once the game is in progress."
                        : validatedSignals.length === 0
                          ? "No strong edge detected. Lines are still forming — check back as the game progresses."
                          : `${validatedSignals.length} signal${validatedSignals.length !== 1 ? "s" : ""} available but none meet the current filter.`}
                    </div>
                  </div>
                )}

                {panelState === "SIGNAL" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(Array.isArray(filteredSignals) ? filteredSignals : []).map((sig) => {
                      if (!sig || !sig.playerId || !sig.market) return null;
                      const style = TIER_STYLES[sig.tier] ?? TIER_STYLES.yellow;
                      const marketLabel = MARKET_LABELS[sig.market] ?? sig.market;
                      return (
                        <div
                          key={`${sig.playerId}-${sig.market}`}
                          data-testid={`card-mlb-signal-${sig.playerId}-${sig.market}`}
                          style={{ borderColor: style.border, backgroundColor: style.bg }}
                          className="rounded-xl border p-4 space-y-3"
                        >
                          <div className="flex justify-between items-center gap-2">
                            <div>
                              <div className="text-sm font-semibold text-foreground">{sig.playerName}</div>
                              <div className="text-xs text-muted-foreground mt-0.5">{marketLabel}</div>
                            </div>
                            <span
                              className="text-xs font-bold px-2 py-0.5 rounded-full"
                              style={{ color: style.dot, backgroundColor: `${style.dot}20` }}
                            >
                              {style.label}
                            </span>
                          </div>

                          <div className="flex justify-between items-center">
                            <div className="text-4xl font-bold" style={{ color: style.dot }}>
                              {sig.enginePct.toFixed(1)}%
                            </div>
                            <div className="flex-1 grid grid-cols-2 gap-2 text-xs ml-4">
                              <div className="text-center">
                                <div className="text-muted-foreground mb-0.5">Line</div>
                                <div className="font-semibold text-foreground">{sig.bookLine != null ? sig.bookLine : "—"}</div>
                              </div>
                              <div className="text-center">
                                <div className="text-muted-foreground mb-0.5">Edge</div>
                                <div className="font-semibold text-foreground">
                                  {sig.edge != null ? `+${sig.edge.toFixed(1)}%` : <span className="text-muted-foreground font-normal">—</span>}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 flex-wrap pb-1">
                            {sig.sportsbook && (
                              <span
                                data-testid={`badge-mlb-sportsbook-${sig.playerId}-${sig.market}`}
                                className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "#71717a" }}
                              >
                                {SPORTSBOOK_LABELS[sig.sportsbook] ?? sig.sportsbook}
                              </span>
                            )}
                            {sig.derivedLine && (
                              <span
                                data-testid={`badge-mlb-derived-${sig.playerId}-${sig.market}`}
                                className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                                style={{ background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.3)", color: "#a78bfa" }}
                              >
                                Derived
                              </span>
                            )}
                            {sig.lineSource && sig.lineSource !== "sportsbook" && (
                              <span
                                data-testid={`badge-mlb-linesource-${sig.playerId}-${sig.market}`}
                                className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                                style={{
                                  background: sig.lineSource === "inferred" ? "rgba(251,191,36,0.1)" : "rgba(139,92,246,0.12)",
                                  border: `1px solid ${sig.lineSource === "inferred" ? "rgba(251,191,36,0.3)" : "rgba(139,92,246,0.3)"}`,
                                  color: sig.lineSource === "inferred" ? "#fbbf24" : "#a78bfa",
                                }}
                              >
                                {sig.lineSource === "inferred" ? "Inferred" : "Derived Line"}
                              </span>
                            )}
                            {sig.availableBooks && sig.availableBooks.length > 0 && (
                              <span
                                data-testid={`text-mlb-books-${sig.playerId}-${sig.market}`}
                                className="text-[10px] text-muted-foreground/50"
                                title={sig.availableBooks.join(", ")}
                              >
                                {sig.availableBooks.length} book{sig.availableBooks.length > 1 ? "s" : ""}
                              </span>
                            )}
                            {sig.signalTimestamp && (
                              <span
                                data-testid={`text-mlb-signal-time-${sig.playerId}-${sig.market}`}
                                className="text-[10px] text-muted-foreground/50"
                              >
                                {new Date(sig.signalTimestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                              </span>
                            )}
                            {sig.bestOdds?.sportsbook && (
                              <span
                                data-testid={`text-mlb-best-odds-${sig.playerId}-${sig.market}`}
                                className="text-[10px] text-muted-foreground/50"
                              >
                                Best: {SPORTSBOOK_LABELS[sig.bestOdds.sportsbook] ?? sig.bestOdds.sportsbook}
                                {sig.bestOdds.overOdds != null ? ` O${sig.bestOdds.overOdds > 0 ? "+" : ""}${sig.bestOdds.overOdds}` : ""}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center justify-between pt-1 border-t border-border/30">
                            <span className="text-xs font-bold tracking-wide" style={{ color: style.dot }}>
                              {sig.recommendedSide}{sig.bookLine != null ? ` ${sig.bookLine}` : ""}
                            </span>
                            <button
                              data-testid={`button-mlb-add-parlay-${sig.playerId}-${sig.market}`}
                              className="text-xs px-3 py-1 rounded-lg border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                            >
                              + Parlay
                            </button>
                          </div>

                          {/* Phase 15: How to Bet execution block */}
                          {(sig.bestOdds?.sportsbook || sig.sportsbook) && sig.bookLine != null && (() => {
                            const execBook = sig.bestOdds?.sportsbook ?? sig.sportsbook ?? "";
                            const execOdds = sig.recommendedSide === "UNDER"
                              ? (sig.bestOdds?.underOdds ?? null)
                              : (sig.bestOdds?.overOdds ?? null);
                            const execLine = sig.bookLine;
                            const betStr = `${SPORTSBOOK_LABELS[execBook] ?? execBook}: ${sig.recommendedSide} ${execLine}${execOdds != null ? ` (${execOdds > 0 ? "+" : ""}${execOdds})` : ""}`;
                            return (
                              <div
                                className="mt-2 rounded-lg p-2.5 flex items-center justify-between gap-2"
                                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                              >
                                <div className="flex flex-col gap-0.5 min-w-0">
                                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground/50 font-semibold">How to Bet</span>
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span
                                      data-testid={`text-mlb-execbook-${sig.playerId}-${sig.market}`}
                                      className="text-xs font-bold text-foreground/90"
                                    >
                                      {SPORTSBOOK_LABELS[execBook] ?? execBook}
                                    </span>
                                    <span className="text-xs text-muted-foreground">·</span>
                                    <span
                                      data-testid={`text-mlb-execbet-${sig.playerId}-${sig.market}`}
                                      className="text-xs font-semibold"
                                      style={{ color: style.dot }}
                                    >
                                      {sig.recommendedSide} {execLine}
                                      {execOdds != null && (
                                        <span className="text-muted-foreground font-normal ml-1">
                                          ({execOdds > 0 ? "+" : ""}{execOdds})
                                        </span>
                                      )}
                                    </span>
                                  </div>
                                </div>
                                <button
                                  data-testid={`button-mlb-copy-bet-${sig.playerId}-${sig.market}`}
                                  className="shrink-0 text-[10px] px-2 py-1 rounded-md border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                                  title="Copy bet to clipboard"
                                  onClick={() => {
                                    navigator.clipboard?.writeText(betStr).catch(() => {});
                                  }}
                                >
                                  Copy
                                </button>
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Matchup detail + calc panel */}
          {selectedPlayer !== null && selectedGame && (
            <div className="space-y-4">
              <button
                data-testid="button-back-to-game"
                onClick={() => {
                  setSelectedPlayer(null);
                  setCalcResult(null);
                  setSelectedLine(null);
                  setManualMode(false);
                }}
                className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors font-medium"
              >
                ← Back to Game
              </button>

              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Player Matchup</h3>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                    selectedGame.status === "live"
                      ? "bg-green-500/15 text-green-500"
                      : "bg-muted text-muted-foreground"
                  }`}>
                    {selectedGame.status === "live" ? "LIVE" : "PREVIEW"}
                  </span>
                </div>

                <div className="px-4 py-3 border-b border-border/40 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-base font-bold text-foreground" data-testid="text-matchup-player">{selectedPlayer.playerName}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {selectedPlayer.teamAbbr} vs {opponentTeam} · #{selectedPlayer.battingOrderSlot}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">Inning</div>
                    <div className="text-sm font-bold text-foreground">{inningLabel(selectedGame)}</div>
                  </div>
                </div>

                <div className="px-4 py-3 border-b border-border/40">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Matchup Context</div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div>
                      <div className="text-muted-foreground text-[10px]">Batting Order</div>
                      <div className="font-semibold text-foreground">#{selectedPlayer.battingOrderSlot}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-[10px]">Half</div>
                      <div className="font-semibold text-foreground">{selectedGame.isTopInning ? "Top ▲" : "Bottom ▼"} {selectedGame.inning || "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-[10px]">Score</div>
                      <div className="font-semibold text-foreground">
                        {selectedGame.status === "live" && selectedGame.awayScore != null && selectedGame.homeScore != null
                          ? `${selectedGame.awayAbbr} ${selectedGame.awayScore} – ${selectedGame.homeAbbr} ${selectedGame.homeScore}`
                          : "Pre-Game"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-[10px]">Status</div>
                      <div className="font-semibold text-foreground">{selectedGame.status === "live" ? "In Progress" : "Preview"}</div>
                    </div>
                  </div>
                </div>

                <div className="px-4 py-3 border-b border-border/40">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Live Stats</div>
                  <div className="grid grid-cols-4 sm:grid-cols-8 gap-2 text-xs">
                    {[
                      { label: "AB", value: selectedPlayer.ab },
                      { label: "H", value: selectedPlayer.h },
                      { label: "TB", value: selectedPlayer.tb },
                      { label: "BB", value: selectedPlayer.bb },
                      { label: "K", value: selectedPlayer.k },
                      { label: "RBI", value: selectedPlayer.rbi },
                      { label: "SB", value: selectedPlayer.sb },
                      { label: "R", value: selectedPlayer.r },
                    ].map((stat) => (
                      <div key={stat.label} className="bg-secondary/40 rounded-lg p-2 text-center">
                        <div className="text-muted-foreground text-[10px]">{stat.label}</div>
                        <div className="font-bold text-foreground">{stat.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="px-4 py-3 border-b border-border/40">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Current Form</div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                    <div>
                      <div className="text-muted-foreground text-[10px]">AVG</div>
                      <div className="font-semibold text-foreground">
                        {selectedPlayer.ab > 0 ? (selectedPlayer.h / selectedPlayer.ab).toFixed(3) : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-[10px]">SLG</div>
                      <div className="font-semibold text-foreground">
                        {selectedPlayer.ab > 0 ? (selectedPlayer.tb / selectedPlayer.ab).toFixed(3) : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-[10px]">PA</div>
                      <div className="font-semibold text-foreground">{selectedPlayer.ab + selectedPlayer.bb}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-[10px]">K Rate</div>
                      <div className="font-semibold text-foreground">
                        {(selectedPlayer.ab + selectedPlayer.bb) > 0
                          ? `${((selectedPlayer.k / (selectedPlayer.ab + selectedPlayer.bb)) * 100).toFixed(0)}%`
                          : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-[10px]">Form</div>
                      <div className="font-semibold">
                        {(() => {
                          if (selectedPlayer.ab === 0) return <span className="text-muted-foreground">No AB</span>;
                          const avg = selectedPlayer.h / selectedPlayer.ab;
                          if (avg >= 0.400) return <span className="text-green-500">Hot</span>;
                          if (avg >= 0.250) return <span className="text-yellow-500">Warm</span>;
                          return <span className="text-red-400">Cold</span>;
                        })()}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                    {selectedPlayer.lastABOutcome ? (
                      <>
                        <span>Last AB:</span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          selectedPlayer.lastABOutcome === "hit"
                            ? "bg-green-500/15 text-green-500"
                            : selectedPlayer.lastABOutcome === "strikeout"
                            ? "bg-red-500/10 text-red-400"
                            : selectedPlayer.lastABOutcome === "walk" || selectedPlayer.lastABOutcome === "hbp"
                            ? "bg-blue-500/10 text-blue-400"
                            : "bg-secondary text-muted-foreground"
                        }`} data-testid="text-mlb-last-ab">
                          {selectedPlayer.lastABOutcome.toUpperCase()}
                        </span>
                      </>
                    ) : (
                      <span>
                        {selectedPlayer.ab > 0
                          ? (selectedPlayer.h > 0 ? `${selectedPlayer.h}-for-${selectedPlayer.ab}` : `0-for-${selectedPlayer.ab}`)
                          : "No at-bats yet"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="px-4 py-3 border-b border-border/40">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Pitcher Context</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="bg-secondary/30 rounded-lg p-2.5">
                      <div className="text-muted-foreground text-[10px] mb-1">{selectedGame.awayAbbr} Starter</div>
                      <div className="font-semibold text-foreground flex items-center gap-1.5">
                        <span>{selectedGame.pitcherAway || "TBD"}</span>
                        {selectedGame.awayPitcherHand && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-secondary border border-border/30 text-muted-foreground">
                            {selectedGame.awayPitcherHand === "L" ? "LHP" : selectedGame.awayPitcherHand === "R" ? "RHP" : selectedGame.awayPitcherHand}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="bg-secondary/30 rounded-lg p-2.5">
                      <div className="text-muted-foreground text-[10px] mb-1">{selectedGame.homeAbbr} Starter</div>
                      <div className="font-semibold text-foreground flex items-center gap-1.5">
                        <span>{selectedGame.pitcherHome || "TBD"}</span>
                        {selectedGame.homePitcherHand && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-secondary border border-border/30 text-muted-foreground">
                            {selectedGame.homePitcherHand === "L" ? "LHP" : selectedGame.homePitcherHand === "R" ? "RHP" : selectedGame.homePitcherHand}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {selectedGame.pitcherName && (
                    <div className="mt-2 bg-secondary/30 rounded-lg p-2.5">
                      <div className="text-muted-foreground text-[10px] mb-1">Current Pitcher</div>
                      <div className="font-semibold text-foreground flex items-center gap-1.5 text-xs" data-testid="text-mlb-pitcher-name">
                        <span>{selectedGame.pitcherName}</span>
                        {selectedGame.pitcherThrows && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-secondary border border-border/30 text-muted-foreground">
                            {selectedGame.pitcherThrows === "L" ? "LHP" : "RHP"}
                          </span>
                        )}
                        {selectedGame.pitcherTeam && (
                          <span className="text-[9px] text-muted-foreground">({selectedGame.pitcherTeam})</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="px-4 py-3">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Park / Weather</div>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="text-muted-foreground text-[10px]">Venue</div>
                      <div className="font-semibold text-foreground" data-testid="text-mlb-venue">{selectedGame.venue ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-[10px]">Weather</div>
                      <div className="font-semibold text-foreground">{selectedGame.weatherSummary || "Not available"}</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Market selector */}
              <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-semibold text-foreground">Market</h3>

                <div className="space-y-2">
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Batters</div>
                  <div className="flex gap-1.5 flex-wrap">
                    {BATTER_MARKETS.map((m) => (
                      <button
                        key={m.value}
                        data-testid={`button-market-${m.value}`}
                        onClick={() => setSelectedMarket(m.value)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                          selectedMarket === m.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>

                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider pt-1">Pitchers</div>
                  <div className="flex gap-1.5 flex-wrap">
                    {PITCHER_MARKETS.map((m) => (
                      <button
                        key={m.value}
                        data-testid={`button-market-${m.value}`}
                        onClick={() => setSelectedMarket(m.value)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                          selectedMarket === m.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Sportsbook lines or manual input */}
              <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">
                    {manualMode ? (hasAnyOdds ? "Manual Input" : "Manual Projection (No Live Odds)") : "Sportsbook Lines"}
                  </h3>
                  {selectedGame.status === "live" && !manualMode && (
                    <span className="text-[10px] font-bold text-green-500">· Live</span>
                  )}
                  {manualMode && hasAnyOdds && (
                    <button
                      data-testid="button-manual-toggle"
                      onClick={() => setManualMode(false)}
                      className="text-xs text-primary hover:text-primary/80 transition-colors"
                    >
                      Back to lines
                    </button>
                  )}
                </div>

                {oddsLoading && !manualMode && (
                  <div className="flex items-center gap-2 py-3">
                    <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-muted-foreground">Loading sportsbook lines…</span>
                  </div>
                )}

                {!oddsLoading && !manualMode && oddsEntries.length === 0 && (
                  <p className="text-xs text-muted-foreground/60 bg-secondary/50 rounded-lg p-3 border border-border/40" data-testid="text-no-sportsbook-line">
                    No sportsbook line available — enter values manually below.
                  </p>
                )}

                {!oddsLoading && !manualMode && oddsEntries.length > 0 && (
                  <div className="space-y-1.5">
                    {oddsEntries.map(([sb, odds]) => {
                      const o = odds as OddsEntry;
                      const isActive = selectedLine?.book === sb;
                      return (
                        <button
                          key={sb}
                          type="button"
                          data-testid={`button-mlb-odds-${sb}`}
                          onClick={() => {
                            setSelectedLine({ book: sb, line: o.line, overOdds: o.overOdds, underOdds: o.underOdds });
                            setCalcResult(null);
                          }}
                          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-xs transition-all ${
                            isActive
                              ? "border-primary bg-primary/10"
                              : "border-border/50 bg-secondary/30 hover:bg-secondary/60"
                          }`}
                        >
                          <span className="font-semibold text-foreground">{SPORTSBOOK_LABELS[sb] ?? sb}</span>
                          <span className="font-mono font-bold text-primary">{o.line}</span>
                          <span className="text-muted-foreground">
                            O {formatOdds(o.overOdds)} / U {formatOdds(o.underOdds)}
                          </span>
                        </button>
                      );
                    })}
                    <button
                      data-testid="button-switch-to-manual"
                      onClick={() => { setManualMode(true); setSelectedLine(null); }}
                      className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                    >
                      Enter line manually instead
                    </button>
                  </div>
                )}

                {/* Manual input form — shown when no odds or user switched to manual */}
                {manualMode && (
                  <div className="space-y-4">
                    {!hasAnyOdds && (
                      <div className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                        No sportsbook lines available for this game. Enter props manually for a projection.
                      </div>
                    )}

                    {/* Book line */}
                    <div>
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Book Line *</label>
                      <input
                        data-testid="input-manual-line"
                        type="number"
                        step="0.5"
                        value={manualInputs.bookLine}
                        onChange={(e) => setManualInputs(prev => ({ ...prev, bookLine: e.target.value }))}
                        placeholder="e.g. 1.5"
                        className="w-full mt-1 px-3 py-2 rounded-lg border border-border bg-secondary/30 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary"
                      />
                    </div>

                    {/* Hitter props (shown for non-pitcher markets) */}
                    {!isPitcherMarket && (
                      <div>
                        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Hitter Props (optional)</div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {[
                            { key: "pa" as const, label: "PA" },
                            { key: "hits" as const, label: "Hits" },
                            { key: "totalBases" as const, label: "Total Bases" },
                            { key: "walks" as const, label: "Walks" },
                            { key: "k" as const, label: "K" },
                            { key: "battingOrder" as const, label: "Batting Order" },
                          ].map(({ key, label }) => (
                            <div key={key}>
                              <label className="text-[9px] text-muted-foreground">{label}</label>
                              <input
                                data-testid={`input-manual-hitter-${key}`}
                                type="number"
                                value={manualInputs.hitter[key]}
                                onChange={(e) => setManualInputs(prev => ({ ...prev, hitter: { ...prev.hitter, [key]: e.target.value } }))}
                                className="w-full mt-0.5 px-2 py-1.5 rounded border border-border/60 bg-secondary/20 text-xs text-foreground focus:outline-none focus:border-primary"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Pitcher props (shown for pitcher markets) */}
                    {isPitcherMarket && (
                      <div>
                        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Pitcher Props (optional)</div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {[
                            { key: "pitchCount" as const, label: "Pitch Count" },
                            { key: "ip" as const, label: "IP" },
                            { key: "k" as const, label: "K" },
                            { key: "hitsAllowed" as const, label: "Hits Allowed" },
                            { key: "walks" as const, label: "Walks" },
                          ].map(({ key, label }) => (
                            <div key={key}>
                              <label className="text-[9px] text-muted-foreground">{label}</label>
                              <input
                                data-testid={`input-manual-pitcher-${key}`}
                                type="number"
                                value={manualInputs.pitcher[key]}
                                onChange={(e) => setManualInputs(prev => ({ ...prev, pitcher: { ...prev.pitcher, [key]: e.target.value } }))}
                                className="w-full mt-0.5 px-2 py-1.5 rounded border border-border/60 bg-secondary/20 text-xs text-foreground focus:outline-none focus:border-primary"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Game context */}
                    <div>
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Game Context</div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <div>
                          <label className="text-[9px] text-muted-foreground">Inning</label>
                          <input
                            data-testid="input-manual-inning"
                            type="number"
                            value={manualInputs.context.inning}
                            onChange={(e) => setManualInputs(prev => ({ ...prev, context: { ...prev.context, inning: e.target.value } }))}
                            className="w-full mt-0.5 px-2 py-1.5 rounded border border-border/60 bg-secondary/20 text-xs text-foreground focus:outline-none focus:border-primary"
                          />
                        </div>
                        <div>
                          <label className="text-[9px] text-muted-foreground">Outs</label>
                          <input
                            data-testid="input-manual-outs"
                            type="number"
                            min="0"
                            max="2"
                            value={manualInputs.context.outs}
                            onChange={(e) => setManualInputs(prev => ({ ...prev, context: { ...prev.context, outs: e.target.value } }))}
                            className="w-full mt-0.5 px-2 py-1.5 rounded border border-border/60 bg-secondary/20 text-xs text-foreground focus:outline-none focus:border-primary"
                          />
                        </div>
                        <div>
                          <label className="text-[9px] text-muted-foreground">Runners</label>
                          <input
                            data-testid="input-manual-runners"
                            type="number"
                            min="0"
                            max="3"
                            value={manualInputs.context.runners}
                            onChange={(e) => setManualInputs(prev => ({ ...prev, context: { ...prev.context, runners: e.target.value } }))}
                            className="w-full mt-0.5 px-2 py-1.5 rounded border border-border/60 bg-secondary/20 text-xs text-foreground focus:outline-none focus:border-primary"
                          />
                        </div>
                        <div>
                          <label className="text-[9px] text-muted-foreground">Half</label>
                          <div className="flex gap-1 mt-0.5">
                            <button
                              data-testid="button-manual-top"
                              type="button"
                              onClick={() => setManualInputs(prev => ({ ...prev, context: { ...prev.context, isTopInning: true } }))}
                              className={`flex-1 px-2 py-1.5 rounded border text-xs font-medium transition-colors ${
                                manualInputs.context.isTopInning
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border/60 text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              Top ▲
                            </button>
                            <button
                              data-testid="button-manual-bottom"
                              type="button"
                              onClick={() => setManualInputs(prev => ({ ...prev, context: { ...prev.context, isTopInning: false } }))}
                              className={`flex-1 px-2 py-1.5 rounded border text-xs font-medium transition-colors ${
                                !manualInputs.context.isTopInning
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border/60 text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              Bot ▼
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <button
                  data-testid="button-calculate-mlb"
                  disabled={!canCalculate || calcMutation.isPending}
                  onClick={() => calcMutation.mutate()}
                  className="w-full h-10 rounded-lg bg-primary text-primary-foreground font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50 transition-opacity"
                >
                  {calcMutation.isPending ? (
                    <>
                      <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                      Calculating…
                    </>
                  ) : (
                    manualMode ? "Calculate Manual Projection" : "Calculate Probability"
                  )}
                </button>
              </div>

              {/* Prediction result */}
              {calcResult && (
                <div className="bg-card border border-border rounded-xl p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-foreground">
                      {calcResult.isManual ? "Manual Projection (No Live Odds)" : "Prediction Result"}
                    </h3>
                    {calcResult.isManual && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-semibold">
                        Manual
                      </span>
                    )}
                  </div>

                  <div className="flex flex-col items-center gap-4">
                    <ProbabilityRing probability={calcResult.calibratedProbabilityOver} size={140} strokeWidth={12} />

                    <div className="text-center">
                      <span className={`text-sm font-bold px-3 py-1 rounded-full ${
                        calcResult.edge > 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/10 text-red-400"
                      }`}>
                        {calcResult.recommendedSide} {calcResult.bookLine}
                        {!calcResult.isManual && ` · ${calcResult.edge > 0 ? "+" : ""}${calcResult.edge.toFixed(1)}% Edge`}
                      </span>
                    </div>
                    {calcResult.isManual && (
                      <div className="text-xs text-muted-foreground">
                        Confidence: <span className="font-bold text-foreground">{calcResult.confidenceTier}</span>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                    <div className="bg-secondary/40 rounded-lg p-3 text-center">
                      <div className="text-muted-foreground mb-1">Projection</div>
                      <div className="font-bold text-foreground text-lg">{calcResult.projection.toFixed(2)}</div>
                    </div>
                    {!calcResult.isManual && (
                      <div className="bg-secondary/40 rounded-lg p-3 text-center">
                        <div className="text-muted-foreground mb-1">Edge %</div>
                        <div className={`font-bold text-lg ${calcResult.edge > 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {calcResult.edge > 0 ? "+" : ""}{calcResult.edge.toFixed(1)}%
                        </div>
                      </div>
                    )}
                    <div className="bg-secondary/40 rounded-lg p-3 text-center">
                      <div className="text-muted-foreground mb-1">Over%</div>
                      <div className="font-bold text-foreground text-lg">{calcResult.calibratedProbabilityOver.toFixed(1)}%</div>
                    </div>
                    <div className="bg-secondary/40 rounded-lg p-3 text-center">
                      <div className="text-muted-foreground mb-1">Under%</div>
                      <div className="font-bold text-foreground text-lg">{calcResult.calibratedProbabilityUnder.toFixed(1)}%</div>
                    </div>
                    <div className="bg-secondary/40 rounded-lg p-3 text-center">
                      <div className="text-muted-foreground mb-1">Tier</div>
                      <div className={`font-bold text-lg ${
                        calcResult.confidenceTier === "ELITE" ? "text-green-400"
                        : calcResult.confidenceTier === "STRONG" ? "text-emerald-400"
                        : calcResult.confidenceTier === "LEAN" ? "text-yellow-400"
                        : "text-muted-foreground"
                      }`}>{calcResult.confidenceTier}</div>
                    </div>
                    {calcResult.remainingPA != null && (
                      <div className="bg-secondary/40 rounded-lg p-3 text-center">
                        <div className="text-muted-foreground mb-1">Remaining PA</div>
                        <div className="font-bold text-foreground text-lg">{calcResult.remainingPA}</div>
                      </div>
                    )}
                  </div>

                  {Array.isArray(calcResult.explanationBullets) && calcResult.explanationBullets.length > 0 && (
                    <div className="space-y-1.5">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Analysis</h4>
                      <ul className="space-y-1">
                        {calcResult.explanationBullets.map((bullet, i) => (
                          <li key={i} className="text-xs text-muted-foreground flex gap-2">
                            <span className="text-primary mt-0.5">·</span>
                            <span>{bullet}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function MlbLivePage() {
  return (
    <MLBErrorBoundary>
      <MlbLiveInner />
    </MLBErrorBoundary>
  );
}
