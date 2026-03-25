import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ProbabilityRing } from "@/components/probability-ring";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";

type MLBGameMarket = {
  line: number;
  odds: { overOdds: number | null; underOdds: number | null } | null;
  projection: number;
  edge: number;
  probability: number;
  oddsUpdatedAt: string;
  projectionUpdatedAt: string;
};

type MLBGame = {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  awayAbbr: string;
  homeAbbr: string;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  inning: number;
  isTopInning: boolean;
  status: "live" | "pregame";
  parkName?: string;
  parkFactor?: number | null;
  weatherSummary?: string;
  weatherTemp?: number | null;
  probableAwayPitcher?: string;
  probableHomePitcher?: string;
  awayPitcherHand?: string;
  homePitcherHand?: string;
  pitcherName?: string | null;
  pitcherThrows?: "L" | "R" | null;
  pitcherTeam?: string | null;
  hasOdds?: boolean;
  signalLocked?: boolean;
  market?: MLBGameMarket | null;
};

// ── Client-side render state engine ──────────────────────────────────────────

type RenderState = "INVALID" | "PREVIEW" | "NO_SIGNAL" | "SIGNAL";

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

function resolveRenderState(game: MLBGame): RenderState {
  if (!game.awayTeam || !game.homeTeam) return "INVALID";
  if (!game.awayAbbr || game.awayAbbr.length < 2 || !game.homeAbbr || game.homeAbbr.length < 2) return "INVALID";
  const market = game.market ?? null;
  const realOdds = hasRealOdds(market);
  if (!realOdds) {
    return game.signalLocked ? "NO_SIGNAL" : "PREVIEW";
  }
  if (!canShowSignal(market)) {
    return "NO_SIGNAL";
  }
  if (hasEdge(market)) {
    return "SIGNAL";
  }
  return "NO_SIGNAL";
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
      score: game ? `${game.awayScore}-${game.homeScore}` : "0-0",
      outs: "0",
      runners: "0",
      isTopInning: game ? game.isTopInning : true,
    },
    bookLine: "",
  };
}

export default function MlbLivePage() {
  const { user } = useAuth();
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
  const games = gamesResp?.games ?? [];
  const previewPlayers = gamesResp?.previewPlayers ?? [];
  const hasAnyOdds = games.some((g) => g.hasOdds === true);
  const isElite = user?.isAdmin || user?.subscriptionTier === "elite";

  const { data: players = [], isLoading: playersLoading } = useQuery<MLBBatter[]>({
    queryKey: ["/api/mlb/live-stats", selectedGameId],
    enabled: !!selectedGameId,
    refetchInterval: 30_000,
  });

  const { data: signalsResp, isLoading: signalsLoading } = useQuery<SignalsResponse>({
    queryKey: ["/api/mlb/live-signals", selectedGameId],
    enabled: !!selectedGameId,
    refetchInterval: 90_000,
  });

  const signalMode = signalsResp?.mode ?? "no_lines";
  const signals = signalsResp?.signals ?? [];
  const updatedAt = signalsResp?.updatedAt ?? 0;
  const signalsDegraded = signalsResp?.isDegraded ?? false;
  const selectedGameRaw = games.find((g) => g.gameId === selectedGameId) ?? null;
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
            score: manualInputs.context.score || `${selectedGame.awayScore}-${selectedGame.homeScore}`,
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
    const existing = playerTierMap.get(sig.playerId);
    if (!existing) {
      playerTierMap.set(sig.playerId, sig.tier);
    } else {
      const existingSignal = signals.find((s) => s.playerId === sig.playerId && s.tier === existing);
      const existingEdge = existingSignal?.edge ?? 0;
      const sigEdge = sig.edge ?? 0;
      if (sigEdge > existingEdge) {
        playerTierMap.set(sig.playerId, sig.tier);
      }
    }
  }

  const currentInning = selectedGame?.inning ?? 0;
  const rosterPlayerIds = new Set<string>(players.map((p) => String(p.playerId)));

  const validatedSignals = selectedGameId
    ? signals.filter((sig) => isValidSignal(sig, selectedGameId, rosterPlayerIds))
    : [];

  const filteredSignals = inningTabMin === 0
    ? validatedSignals
    : validatedSignals.filter((s) => s.inning >= inningTabMin);

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

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Game chip strip */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm font-semibold text-foreground">Today's Games</span>
          {gamesLoading && (
            <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>
          )}
        </div>

        {!gamesLoading && games.length === 0 ? (
          <div className="flex items-center gap-3 px-5 py-8 rounded-xl border border-border bg-card text-center justify-center">
            <span className="text-2xl">⚾</span>
            <div>
              <p className="text-sm font-medium text-foreground" data-testid="text-no-mlb-games">No MLB games today</p>
              <p className="text-xs text-muted-foreground mt-0.5">Check back when the season is active.</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {games.map((game) => {
              const renderState = resolveRenderState(game);
              if (renderState === "INVALID") return null;

              const isActive = game.gameId === selectedGameId;
              const pitcherAway = game.probableAwayPitcher;
              const pitcherHome = game.probableHomePitcher;
              const awayLastName = pitcherAway ? pitcherAway.split(" ").pop() : null;
              const homeLastName = pitcherHome ? pitcherHome.split(" ").pop() : null;
              const pitcherPill = pitcherAway && pitcherHome && awayLastName && homeLastName ? (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-secondary/60 text-muted-foreground border border-border/30 truncate max-w-[90px]">
                  {awayLastName} vs {homeLastName}
                </span>
              ) : null;

              return (
                <button
                  key={game.gameId}
                  data-testid={`chip-mlb-game-${game.gameId}`}
                  onClick={() => setSelectedGameId(game.gameId)}
                  className={`p-3 rounded-xl border text-left transition-all flex flex-col gap-1 ${
                    isActive
                      ? "border-primary bg-primary/10"
                      : "border-white/10 hover:border-white/20 hover:bg-white/5"
                  }`}
                >
                  {/* Row 1: AWAY @ HOME + status badge */}
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-bold text-foreground">
                      {game.awayAbbr} @ {game.homeAbbr}
                    </span>
                    {game.status === "live" ? (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-500">LIVE</span>
                    ) : (
                      <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">PRE</span>
                    )}
                  </div>

                  {/* Row 2: score + inning position */}
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                    <span>{game.awayScore} – {game.homeScore}</span>
                    {game.status === "live" && game.inning > 0 && (
                      <span className="text-green-400 font-semibold">
                        {game.isTopInning ? "▲" : "▼"}{game.inning}
                      </span>
                    )}
                  </div>

                  {/* Row 3: state-driven content */}
                  {renderState === "PREVIEW" && (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {pitcherPill}
                      <div className="text-[9px] text-zinc-400">Awaiting live lines</div>
                    </div>
                  )}

                  {renderState === "NO_SIGNAL" && (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {pitcherPill}
                      <div className="text-[9px] text-zinc-300">No strong edge</div>
                    </div>
                  )}

                  {renderState === "SIGNAL" && game.market && (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {pitcherPill}
                      <div className="text-[9px] text-muted-foreground font-mono">Projection: {game.market.projection.toFixed(1)}</div>
                      <div className="text-[9px] text-green-400 font-mono">Edge: {game.market.edge.toFixed(1)}%</div>
                      <div className="text-[9px] text-muted-foreground font-mono">Probability: {game.market.probability.toFixed(1)}%</div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

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
            {previewPlayers.map((p, i) => (
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
                    {p.tags.map((tag, ti) => (
                      <span key={ti} className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-xs font-medium text-foreground">{p.projection}</div>
                <div className="mt-3 flex items-center gap-3">
                  <div className="flex-1 h-6 bg-secondary/30 rounded flex items-center justify-center relative overflow-hidden">
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-[10px] text-muted-foreground/50 font-medium">Probability locked</span>
                    </div>
                  </div>
                  <div className="flex-1 h-6 bg-secondary/30 rounded flex items-center justify-center relative overflow-hidden">
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-[10px] text-muted-foreground/50 font-medium">Edge locked</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
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
              {selectedGame.awayAbbr} @ {selectedGame.homeAbbr}
            </h2>
            <span className="text-xs text-muted-foreground font-mono">
              {selectedGame.awayScore}–{selectedGame.homeScore}
            </span>
            <span className={`text-xs ${selectedGame.status === "live" ? "text-green-500" : "text-muted-foreground"}`}>
              {inningLabel(selectedGame)}
            </span>
            {selectedGame.parkName && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border/40">
                {selectedGame.parkName}
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

          {/* Signal/preview panel — mode-branched */}
          {selectedPlayer === null && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">
                {!isElite || signalMode !== "live" ? "Projected Opportunities" : "Edge Signals"}
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

            <p className="text-xs text-muted-foreground mb-3">Lines recently updated. Tracking movement…</p>

            {/* preview_locked — non-elite, odds exist */}
            {(!isElite) && (
              <div className="space-y-4">
                {previewPlayers.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {previewPlayers.map((p, i) => (
                      <div
                        key={i}
                        data-testid={`card-mlb-preview-signal-${i}`}
                        className="rounded-xl border border-border/40 bg-card p-4"
                      >
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <div className="text-sm font-semibold text-foreground">{p.playerName ?? p.matchup}</div>
                            <div className="text-xs text-muted-foreground">{p.playerName ? p.matchup : "Edges forming"}</div>
                          </div>
                          <div className="flex gap-1 flex-wrap justify-end">
                            {p.tags.map((tag, ti) => (
                              <span key={ti} className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                                {tag}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="text-xs font-medium text-foreground mb-3">{p.projection}</div>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="bg-secondary/30 rounded p-2 text-center">
                            <div className="text-[9px] text-muted-foreground">Probability</div>
                            <div className="text-xs font-bold text-muted-foreground/40 mt-0.5">••••</div>
                          </div>
                          <div className="bg-secondary/30 rounded p-2 text-center">
                            <div className="text-[9px] text-muted-foreground">Edge</div>
                            <div className="text-xs font-bold text-muted-foreground/40 mt-0.5">••••</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-5 py-8 rounded-xl border border-border bg-card text-center">
                    <p className="text-sm font-medium text-foreground">Projected Opportunities</p>
                    <p className="text-xs text-muted-foreground mt-1">Edges are forming — select a game to see projections.</p>
                  </div>
                )}
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 text-center space-y-3">
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
              </div>
            )}

            {/* no_lines — elite tier, odds not present */}
            {isElite && signalMode === "no_lines" && (
              <div className="px-5 py-8 rounded-xl border border-border bg-card text-center" data-testid="text-no-signals">
                <p className="text-sm font-medium text-foreground">No live edges yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Lines are still forming. All Sports users get alerted instantly when edges appear.
                </p>
                <div className="mt-4">
                  <a
                    href="/upgrade"
                    className="inline-block px-4 py-2 rounded-lg bg-primary/10 text-primary font-semibold text-xs border border-primary/20 hover:bg-primary/20 transition-colors"
                  >
                    Enable Push Alerts →
                  </a>
                </div>
              </div>
            )}

            {/* live — elite tier, signals present */}
            {isElite && signalMode === "live" && (
              filteredSignals.length === 0 ? (
                <div className="px-5 py-8 rounded-xl border border-border bg-card text-center" data-testid="text-no-signals">
                  <p className="text-sm font-medium text-foreground">No strong edges right now</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {selectedGame.status !== "live"
                      ? "No live data available yet — edges appear once the game is in progress."
                      : validatedSignals.length === 0
                        ? "Engine is warming up — edges appear once the orchestrator detects qualifying game state changes."
                        : `${validatedSignals.length} signal${validatedSignals.length !== 1 ? "s" : ""} available but none meet the current filter.`}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {filteredSignals.map((sig) => {
                    const style = TIER_STYLES[sig.tier];
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
                                {sig.edge != null ? `+${sig.edge.toFixed(1)}%` : <span className="text-muted-foreground font-normal">No line</span>}
                              </div>
                            </div>
                          </div>
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
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>
          )}

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
                      <div className="font-semibold text-foreground">{selectedGame.awayAbbr} {selectedGame.awayScore} – {selectedGame.homeAbbr} {selectedGame.homeScore}</div>
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
                        <span>{selectedGame.probableAwayPitcher || "TBD"}</span>
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
                        <span>{selectedGame.probableHomePitcher || "TBD"}</span>
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
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                    <div>
                      <div className="text-muted-foreground text-[10px]">Venue</div>
                      <div className="font-semibold text-foreground" data-testid="text-mlb-venue">{selectedGame.parkName || "Unknown"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-[10px]">Park Factor</div>
                      <div className="font-semibold text-foreground">{selectedGame.parkFactor != null ? selectedGame.parkFactor.toFixed(2) : "Neutral"}</div>
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

                  {calcResult.explanationBullets.length > 0 && (
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
