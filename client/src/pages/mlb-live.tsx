import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProbabilityRing } from "@/components/probability-ring";

// ── Local types ───────────────────────────────────────────────────────────────

type MLBGame = {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
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

// ── Constants ─────────────────────────────────────────────────────────────────

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

// ── Inning display helper ─────────────────────────────────────────────────────

function inningLabel(game: MLBGame): string {
  if (game.status === "preview") return "Preview";
  if (!game.inning) return "—";
  const half = game.isTopInning ? "▲" : "▼";
  return `${half}${game.inning}`;
}

// ── Time since helper ─────────────────────────────────────────────────────────

function timeSince(ms: number): string {
  if (!ms) return "never";
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MlbLivePage() {
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [inningTabMin, setInningTabMin] = useState<number>(0);
  const [autoSelected, setAutoSelected] = useState(false);

  // ── Queries ──────────────────────────────────────────────────────────────────

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

  const selectedGame = games.find((g) => g.gameId === selectedGameId) ?? null;

  // ── Auto-select: first live → first preview → empty state ────────────────────

  useEffect(() => {
    if (autoSelected || games.length === 0) return;
    const live = games.find((g) => g.status === "live");
    const preview = games.find((g) => g.status === "preview");
    const target = live ?? preview ?? null;
    if (target) {
      setSelectedGameId(target.gameId);
      setAutoSelected(true);
    }
  }, [games, autoSelected]);

  // ── Build per-player strongest signal map for box score row coloring ─────────

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

  // ── Filtered signals by inning tab ───────────────────────────────────────────

  const currentInning = selectedGame?.inning ?? 0;
  const filteredSignals = inningTabMin === 0
    ? signals
    : signals.filter((s) => s.inning >= inningTabMin);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">

      {/* Game Strip */}
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
                  onClick={() => setSelectedGameId(game.gameId)}
                  className={`flex-shrink-0 px-4 py-2.5 rounded-xl border text-xs font-medium transition-all ${
                    isActive
                      ? "border-primary bg-primary/10 text-primary shadow-sm"
                      : "border-border bg-card text-foreground hover:border-primary/40 hover:bg-muted"
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-semibold text-sm">
                    <span>{game.awayTeam}</span>
                    <span className="text-muted-foreground">{game.awayScore}–{game.homeScore}</span>
                    <span>{game.homeTeam}</span>
                  </div>
                  <div className={`text-center mt-0.5 ${
                    game.status === "live" ? "text-green-500" : "text-muted-foreground"
                  }`}>
                    {inningLabel(game)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Content area: only when a game is selected */}
      {selectedGameId && (
        <>
          {/* Inning Tabs */}
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

          {/* Box Score */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                {selectedGame
                  ? `${selectedGame.awayTeam} @ ${selectedGame.homeTeam} — Box Score`
                  : "Box Score"}
              </h2>
              {playersLoading && (
                <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>
              )}
            </div>

            {!playersLoading && players.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
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
                          style={style ? { backgroundColor: style.bg, borderLeft: `3px solid ${style.border}` } : {}}
                          className="border-b border-border/30 last:border-0 hover:bg-muted/30 transition-colors"
                        >
                          <td className="px-4 py-2">
                            <div className="font-medium text-foreground truncate max-w-[160px]">{p.playerName}</div>
                            <div className="text-muted-foreground text-[10px]">{p.teamAbbr}</div>
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
          </div>

          {/* Edge Cards */}
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
                {filteredSignals.map((sig, i) => {
                  const style = TIER_STYLES[sig.tier];
                  const marketLabel = MARKET_LABELS[sig.market] ?? sig.market;
                  return (
                    <div
                      key={`${sig.playerId}-${sig.market}-${i}`}
                      data-testid={`card-mlb-signal-${sig.playerId}-${sig.market}`}
                      style={{ borderColor: style.border, backgroundColor: style.bg }}
                      className="rounded-xl border p-4 space-y-3"
                    >
                      {/* Header */}
                      <div className="flex items-start justify-between gap-2">
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

                      {/* Stats row */}
                      <div className="flex items-center gap-4">
                        <div className="flex-shrink-0">
                          <ProbabilityRing probability={sig.enginePct} size={56} />
                        </div>
                        <div className="flex-1 grid grid-cols-3 gap-2 text-xs">
                          <div className="text-center">
                            <div className="text-muted-foreground mb-0.5">Line</div>
                            <div className="font-semibold text-foreground">{sig.bookLine}</div>
                          </div>
                          <div className="text-center">
                            <div className="text-muted-foreground mb-0.5">Engine</div>
                            <div className="font-semibold" style={{ color: style.dot }}>
                              {sig.enginePct.toFixed(1)}%
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="text-muted-foreground mb-0.5">Edge</div>
                            <div className="font-semibold text-foreground">
                              +{sig.edge.toFixed(1)}%
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Footer: side badge + parlay button */}
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
        </>
      )}
    </div>
  );
}
