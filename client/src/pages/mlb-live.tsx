import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ProbabilityRing } from "@/components/probability-ring";
import { apiRequest, queryClient } from "@/lib/queryClient";

type MLBGame = {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  inning: number;
  isTopInning: boolean;
  status: "live" | "preview";
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
};

type MLBSignal = {
  playerId: string;
  playerName: string;
  market: string;
  bookLine: number;
  enginePct: number;
  edge: number;
  recommendedSide: "OVER" | "UNDER" | "NO_EDGE";
  inning: number;
  tier: "green" | "yellow" | "teal" | "red";
};

type SignalsResponse = {
  signals: MLBSignal[];
  updatedAt: number;
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
  batter_strikeouts: "K (Batter)",
  pitcher_strikeouts: "K (Pitcher)",
  hits_allowed: "Hits Allowed",
  home_runs: "Home Runs",
  hrr: "HRR",
};

const INNING_TABS: { label: string; min: number }[] = [
  { label: "Live Props", min: 0 },
  { label: "3rd Inning", min: 3 },
  { label: "5th Inning", min: 5 },
  { label: "7th Inning", min: 7 },
];

const CALC_MARKETS = [
  { value: "hits", label: "Hits" },
  { value: "total_bases", label: "Total Bases" },
  { value: "batter_strikeouts", label: "Strikeouts" },
];

const SPORTSBOOK_LABELS: Record<string, string> = {
  fanduel: "FanDuel",
  draftkings: "DraftKings",
  hardrockbet: "Hard Rock",
};

function inningLabel(game: MLBGame): string {
  if (game.status === "preview") return "Preview";
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

export default function MlbLivePage() {
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [inningTabMin, setInningTabMin] = useState<number>(0);
  const [boxExpanded, setBoxExpanded] = useState(true);
  const [selectedPlayer, setSelectedPlayer] = useState<MLBBatter | null>(null);
  const [calcMarket, setCalcMarket] = useState("hits");
  const [selectedLine, setSelectedLine] = useState<{ book: string; line: number; overOdds: number; underOdds: number } | null>(null);
  const [calcResult, setCalcResult] = useState<CalcResult | null>(null);

  const { data: games = [], isLoading: gamesLoading } = useQuery<MLBGame[]>({
    queryKey: ["/api/mlb/live-games"],
    refetchInterval: 30_000,
  });

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

  const signals = signalsResp?.signals ?? [];
  const updatedAt = signalsResp?.updatedAt ?? 0;
  const selectedGameRaw = games.find((g) => g.gameId === selectedGameId) ?? null;
  const selectedGameRef = useRef<MLBGame | null>(null);

  useEffect(() => {
    if (selectedGameRaw) {
      selectedGameRef.current = selectedGameRaw;
    }
  }, [selectedGameRaw]);

  const selectedGame = selectedGameRaw ?? selectedGameRef.current;

  const opponentTeam = selectedPlayer && selectedGame
    ? (selectedPlayer.teamAbbr === selectedGame.homeTeam ? selectedGame.awayTeam : selectedGame.homeTeam)
    : null;

  const { data: oddsData, isLoading: oddsLoading } = useQuery<Record<string, OddsEntry>>({
    queryKey: ["/api/mlb/odds", selectedPlayer?.teamAbbr, opponentTeam, selectedPlayer?.playerName, calcMarket],
    enabled: !!selectedPlayer && !!opponentTeam,
    refetchInterval: 120_000,
    queryFn: async () => {
      const params = new URLSearchParams({
        playerTeam: selectedPlayer!.teamAbbr,
        opponentTeam: opponentTeam!,
        playerName: selectedPlayer!.playerName,
        statType: calcMarket,
        inPlay: selectedGame?.status === "live" ? "true" : "false",
      });
      const res = await fetch(`/api/mlb/odds?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch odds");
      return res.json();
    },
  });

  const calcMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPlayer || !selectedLine || !selectedGame) throw new Error("Missing data");
      const body = {
        playerId: selectedPlayer.playerId,
        playerName: selectedPlayer.playerName,
        market: calcMarket,
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
  }, [calcMarket, selectedPlayer]);

  useEffect(() => {
    setSelectedPlayer(null);
    setCalcResult(null);
    setSelectedLine(null);
  }, [selectedGame?.gameId]);

  const playerTierMap = new Map<string, string>();
  for (const sig of signals) {
    const existing = playerTierMap.get(sig.playerId);
    if (!existing) {
      playerTierMap.set(sig.playerId, sig.tier);
    } else {
      const existingSignal = signals.find(
        (s) => s.playerId === sig.playerId && s.tier === existing
      );
      const existingEdge = existingSignal?.edge ?? 0;
      if (sig.edge > existingEdge) {
        playerTierMap.set(sig.playerId, sig.tier);
      }
    }
  }

  const currentInning = selectedGame?.inning ?? 0;
  const filteredSignals = inningTabMin === 0
    ? signals
    : signals.filter((s) => s.inning >= inningTabMin);

  const bookImplied = calcResult?.bookImplied ?? null;

  const oddsEntries = oddsData
    ? Object.entries(oddsData).filter(([k]) => k !== "_quotaExhausted")
    : [];

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
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
              <p className="text-sm font-medium text-foreground">No MLB games today</p>
              <p className="text-xs text-muted-foreground mt-0.5">Check back when the season is active.</p>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
            {games.map((game) => {
              const isActive = game.gameId === selectedGameId;
              return (
                <button
                  key={game.gameId}
                  data-testid={`chip-mlb-game-${game.gameId}`}
                  onClick={() => {
                    setSelectedGameId(game.gameId);
                    setSelectedPlayer(null);
                    setCalcResult(null);
                    setSelectedLine(null);
                  }}
                  className={`flex-shrink-0 px-4 py-2.5 rounded-xl border text-xs font-medium transition-all ${
                    isActive
                      ? "border-primary bg-primary/10 text-primary shadow-sm"
                      : "border-border bg-card text-foreground hover:border-primary/40 hover:bg-muted"
                  }`}
                >
                  <div className="font-semibold text-sm leading-tight">
                    <span>{game.awayName || game.awayTeam}</span>
                    <span className="text-muted-foreground"> @ </span>
                    <span>{game.homeName || game.homeTeam}</span>
                  </div>
                  <div className="flex items-center justify-center gap-1.5 mt-0.5">
                    <span className="text-muted-foreground text-xs">{game.awayScore}–{game.homeScore}</span>
                    <span className={`text-xs ${
                      game.status === "live" ? "text-green-500" : "text-muted-foreground"
                    }`}>
                      {inningLabel(game)}
                    </span>
                    {game.status === "live" ? (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-500">LIVE</span>
                    ) : (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Preview</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selectedGameId && (
        <>
          <h2 className="text-sm font-semibold text-foreground" data-testid="text-mlb-game-header">
            {selectedGame?.awayName || selectedGame?.awayTeam} @ {selectedGame?.homeName || selectedGame?.homeTeam}
          </h2>

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
                          const isSelected = selectedPlayer?.playerId === p.playerId;
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
                              className={`border-b border-border/30 last:border-0 cursor-pointer hover:bg-neutral-800 transition ${
                                isSelected ? "ring-2 ring-primary ring-inset" : ""
                              }`}
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

          {selectedPlayer === null && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">Edge Signals</h2>
              <div className="flex items-center gap-3">
                {updatedAt > 0 && (
                  <span className="text-xs text-muted-foreground" data-testid="text-mlb-signals-freshness">
                    Updated {timeSince(updatedAt)}
                  </span>
                )}
                {signalsLoading && (
                  <span className="text-xs text-muted-foreground animate-pulse">Refreshing…</span>
                )}
              </div>
            </div>

            {!signalsLoading && filteredSignals.length === 0 ? (
              <div className="px-5 py-8 rounded-xl border border-border bg-card text-center">
                <p className="text-sm font-medium text-foreground">No edge signals yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {signals.length === 0
                    ? "Engine is warming up — signals appear once the orchestrator detects game state changes."
                    : `${signals.length} signal${signals.length !== 1 ? "s" : ""} available but none meet the ${inningTabMin > 0 ? `${inningTabMin}th inning` : ""} filter.`}
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
                            <div className="font-semibold text-foreground">{sig.bookLine}</div>
                          </div>
                          <div className="text-center">
                            <div className="text-muted-foreground mb-0.5">Edge</div>
                            <div className="font-semibold text-foreground">
                              +{sig.edge.toFixed(1)}%
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-1 border-t border-border/30">
                        <span className="text-xs font-bold tracking-wide" style={{ color: style.dot }}>
                          {sig.recommendedSide} {sig.bookLine}
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
            )}
          </div>
          )}

          {selectedPlayer !== null && selectedGame && (
            <div className="space-y-4">
              <button
                data-testid="button-back-to-game"
                onClick={() => {
                  setSelectedPlayer(null);
                  setCalcResult(null);
                  setSelectedLine(null);
                }}
                className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors font-medium"
              >
                ← Back to Game
              </button>

              <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-semibold text-foreground">Matchup Details</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  <div>
                    <div className="text-muted-foreground mb-0.5">Player</div>
                    <div className="font-semibold text-foreground">{selectedPlayer.playerName}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Team</div>
                    <div className="font-semibold text-foreground">{selectedPlayer.teamAbbr}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Opponent</div>
                    <div className="font-semibold text-foreground">{opponentTeam}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Batting Order</div>
                    <div className="font-semibold text-foreground">#{selectedPlayer.battingOrderSlot}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Inning</div>
                    <div className="font-semibold text-foreground">{inningLabel(selectedGame)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Today</div>
                    <div className="font-semibold text-foreground">
                      {selectedPlayer.ab} AB · {selectedPlayer.h} H · {selectedPlayer.tb} TB · {selectedPlayer.bb} BB · {selectedPlayer.k} K · {selectedPlayer.sb} SB
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-semibold text-foreground">Live Lines</h3>

                <div className="flex gap-1.5 flex-wrap">
                  {CALC_MARKETS.map((m) => (
                    <button
                      key={m.value}
                      data-testid={`button-market-${m.value}`}
                      onClick={() => setCalcMarket(m.value)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                        calcMarket === m.value
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                {oddsLoading && (
                  <div className="flex items-center gap-2 py-3">
                    <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-muted-foreground">Loading sportsbook lines…</span>
                  </div>
                )}

                {!oddsLoading && oddsEntries.length === 0 && (
                  <p className="text-xs text-muted-foreground/60 bg-secondary/50 rounded-lg p-3 border border-border/40" data-testid="text-no-sportsbook-line">
                    No sportsbook line available
                  </p>
                )}

                {oddsEntries.length > 0 && (
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
                  </div>
                )}

                <button
                  data-testid="button-calculate-mlb"
                  disabled={!selectedLine || calcMutation.isPending}
                  onClick={() => calcMutation.mutate()}
                  className="w-full h-10 rounded-lg bg-primary text-primary-foreground font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50 transition-opacity"
                >
                  {calcMutation.isPending ? (
                    <>
                      <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                      Calculating…
                    </>
                  ) : (
                    "Calculate Probability"
                  )}
                </button>
              </div>

              {calcResult && (
                <div className="bg-card border border-border rounded-xl p-4 space-y-4">
                  <h3 className="text-sm font-semibold text-foreground">Prediction Result</h3>

                  <div className="flex flex-col items-center gap-4">
                    <ProbabilityRing probability={calcResult.calibratedProbabilityOver} size={140} strokeWidth={12} />

                    <div className="text-center">
                      <span className={`text-sm font-bold px-3 py-1 rounded-full ${
                        calcResult.edge > 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/10 text-red-400"
                      }`}>
                        {calcResult.recommendedSide} {calcResult.bookLine} · {calcResult.edge > 0 ? "+" : ""}{calcResult.edge.toFixed(1)}% Edge
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                    <div className="bg-secondary/40 rounded-lg p-3 text-center">
                      <div className="text-muted-foreground mb-1">Projection</div>
                      <div className="font-bold text-foreground text-lg">{calcResult.projection.toFixed(2)}</div>
                    </div>
                    <div className="bg-secondary/40 rounded-lg p-3 text-center">
                      <div className="text-muted-foreground mb-1">Edge %</div>
                      <div className={`font-bold text-lg ${calcResult.edge > 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {calcResult.edge > 0 ? "+" : ""}{calcResult.edge.toFixed(1)}%
                      </div>
                    </div>
                    {bookImplied != null && (
                      <div className="bg-secondary/40 rounded-lg p-3 text-center">
                        <div className="text-muted-foreground mb-1">Book Implied</div>
                        <div className="font-bold text-foreground text-lg">{bookImplied.toFixed(1)}%</div>
                      </div>
                    )}
                    {calcResult.market === "hits" && calcResult.expectedHits != null && (
                      <div className="bg-secondary/40 rounded-lg p-3 text-center">
                        <div className="text-muted-foreground mb-1">Expected Hits</div>
                        <div className="font-bold text-foreground text-lg">{calcResult.expectedHits.toFixed(2)}</div>
                      </div>
                    )}
                    {calcResult.remainingPA != null && (
                      <div className="bg-secondary/40 rounded-lg p-3 text-center">
                        <div className="text-muted-foreground mb-1">Remaining PA</div>
                        <div className="font-bold text-foreground text-lg">{calcResult.remainingPA.toFixed(1)}</div>
                      </div>
                    )}
                    {calcResult.market === "hits" && calcResult.adjustedHitRate != null && (
                      <div className="bg-secondary/40 rounded-lg p-3 text-center">
                        <div className="text-muted-foreground mb-1">Adjusted Hit Rate</div>
                        <div className="font-bold text-foreground text-lg">{(calcResult.adjustedHitRate * 100).toFixed(1)}%</div>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-end pt-1 border-t border-border/30">
                    <button
                      data-testid="button-mlb-add-parlay-calc"
                      className="text-xs px-3 py-1 rounded-lg border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                    >
                      + Parlay
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
