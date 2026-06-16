import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { ArrowLeft, Zap, Activity, Radio, ChevronDown, ChevronUp } from "lucide-react";

const LIVE_REFRESH_MS = 20000;

type MarketSide = "OVER" | "UNDER" | "HOME" | "AWAY" | null;

type SelectedMarket = {
  marketType: "spread" | "total" | "team_total";
  period: "full_game" | "first_half" | "second_half";
  side: MarketSide;
  line: number | null;
  coverProbability: number | null;
  edge: number | null;
  confidenceLabel: string | null;
  engineProbability: number | null;
  bookProbability: number | null;
  signalTag: string | null;
  signalDirection: MarketSide;
  sportsbook: string | null;
};

type FullGameTotal = {
  line: number | null;
  overProbability: number | null;
  underProbability: number | null;
  sportsbookCount: number;
};

type CardMarket = {
  available: boolean;
  marketKey: string;
  label: string;
  sportsbook: string | null;
  bookLine: number | null;
  projection: number | null;
  modelProb: number | null;
  bookImpliedProb: number | null;
  edge: number | null;
  side: MarketSide;
  confidenceTier: string;
};

type NcaabCard = {
  gameId: string;
  awayTeam: string;
  homeTeam: string;
  awayTeamAbbr: string;
  homeTeamAbbr: string;
  awayScore: number;
  homeScore: number;
  periodLabel: string;
  gameClock: string;
  selectedMarket: SelectedMarket;
  fullGameTotal: FullGameTotal;
  badges: { tierBadge: string | null; liveTag: string | null };
  diagnostics?: { engineGeneratedAt?: string | null; dataFreshnessMs?: number | null };
  markets: Record<string, CardMarket>;
  periodMarkets?: Record<string, SelectedMarket>;
  bettingWindow: string;
  bettingWindowLabel: string;
};

type LiveResponse = {
  cards: NcaabCard[];
  topPlays: NcaabCard[];
  updatedAt: string;
};

function formatPct(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(1)}%`;
}

function ProbabilityRing({ value, label, size = "lg", color }: {
  value: number | null;
  label: string;
  size?: "lg" | "sm";
  color?: string;
}) {
  const isLg = size === "lg";
  const dim = isLg ? 140 : 70;
  const stroke = isLg ? 8 : 5;
  const radius = (dim - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = value ?? 0;
  const dashOffset = circumference * (1 - Math.min(pct, 100) / 100);

  const ringColor = color ?? (pct >= 65 ? "hsl(var(--brand-accent))" : pct >= 55 ? "#f59e0b" : pct > 0 ? "#ef4444" : "#374151");

  return (
    <div className="flex flex-col items-center gap-1" data-testid={`ring-${label.toLowerCase()}`}>
      <div className="relative" style={{ width: dim, height: dim }}>
        <svg width={dim} height={dim} className="transform -rotate-90">
          <circle cx={dim / 2} cy={dim / 2} r={radius} fill="none" stroke="#1f2937" strokeWidth={stroke} />
          <circle
            cx={dim / 2} cy={dim / 2} r={radius} fill="none"
            stroke={ringColor}
            strokeWidth={stroke}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            className="transition-all duration-700"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`font-bold ${isLg ? "text-2xl" : "text-sm"}`} style={{ color: ringColor }}>
            {value !== null ? `${value.toFixed(1)}%` : "—"}
          </span>
        </div>
      </div>
      <span className={`font-semibold uppercase tracking-wider ${isLg ? "text-xs" : "text-[10px]"} text-muted-foreground`}>
        {label}
      </span>
    </div>
  );
}

function ValueSignalCard({ title, subtitle, edge }: {
  title: string | null;
  subtitle: string;
  edge: number | null;
}) {
  if (!title) return null;
  const edgeColor = edge !== null && edge > 0 ? "text-emerald-400" : edge !== null && edge < 0 ? "text-red-400" : "text-muted-foreground";
  return (
    <div className="rounded-lg border border-border/50 bg-card/80 p-3" data-testid="value-signal-card">
      <p className="text-sm font-semibold text-emerald-400">{title}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      {edge !== null && (
        <span className={`inline-block mt-1.5 px-2 py-0.5 rounded text-xs font-bold ${edgeColor} bg-background/50`}>
          {edge > 0 ? "+" : ""}{edge.toFixed(1)}pp
        </span>
      )}
    </div>
  );
}

function InfoSignalCard({ title, subtitle, direction }: {
  title: string;
  subtitle: string;
  direction: MarketSide;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/80 p-3" data-testid="info-signal-card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-blue-400">{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        {direction && (
          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
            direction === "OVER" || direction === "HOME" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
          }`}>
            {direction}
          </span>
        )}
      </div>
    </div>
  );
}

function GameChip({ card, isActive, onClick }: {
  card: NcaabCard;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 rounded-lg px-3 py-2 text-left transition-all border ${
        isActive
          ? "bg-primary/10 border-primary/50 ring-1 ring-primary/30"
          : "bg-card border-border/50 hover:bg-muted/50"
      }`}
      data-testid={`game-chip-${card.gameId}`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium truncate max-w-[60px]">{card.awayTeamAbbr}</span>
        <span className="text-muted-foreground">@</span>
        <span className="font-medium truncate max-w-[60px]">{card.homeTeamAbbr}</span>
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-xs font-bold">{card.awayScore} – {card.homeScore}</span>
        <span className="text-[10px] text-muted-foreground">{card.periodLabel} {card.gameClock}</span>
      </div>
    </button>
  );
}

function TopPlayCard({ card }: { card: NcaabCard }) {
  const sm = card.selectedMarket;
  return (
    <div className="flex-shrink-0 w-72 rounded-xl border border-border/50 bg-card p-4 space-y-2" data-testid={`top-play-${card.gameId}`}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-emerald-400 font-semibold uppercase tracking-wider">
          {card.badges.liveTag}
        </span>
        {card.badges.tierBadge && (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400">
            {card.badges.tierBadge}
          </span>
        )}
      </div>
      <p className="text-sm font-semibold" data-testid={`top-play-matchup-${card.gameId}`}>{card.awayTeamAbbr} @ {card.homeTeamAbbr}</p>
      <p className="text-lg font-bold" data-testid={`top-play-score-${card.gameId}`}>{card.awayScore} – {card.homeScore}</p>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-[10px] text-muted-foreground uppercase">
            {sm.period === "full_game" ? "Full Game" : sm.period === "first_half" ? "1st Half" : "2nd Half"} {sm.marketType}
          </p>
          <p className="text-sm font-bold">
            <span className={sm.side === "OVER" || sm.side === "HOME" ? "text-emerald-400" : "text-red-400"}>
              {sm.side}
            </span>
            {sm.line !== null && <span className="text-muted-foreground ml-1">{sm.line}</span>}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-emerald-400" data-testid={`top-play-prob-${card.gameId}`}>{formatPct(sm.coverProbability)}</p>
          {sm.edge !== null && (
            <p className="text-xs text-emerald-400" data-testid={`top-play-edge-${card.gameId}`}>+{sm.edge.toFixed(1)}pp</p>
          )}
        </div>
      </div>
      {sm.sportsbook && (
        <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
          {sm.sportsbook}
        </span>
      )}
    </div>
  );
}

function NcaabGameCard({ card }: { card: NcaabCard }) {
  const [expanded, setExpanded] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState<"full" | "h1" | "h2">(() => {
    const pm = card.periodMarkets;
    if (pm?.full) return "full";
    if (pm?.h1) return "h1";
    if (pm?.h2) return "h2";
    return "full";
  });

  const activeMarket: SelectedMarket | null = (() => {
    const pm = card.periodMarkets;
    if (pm?.[selectedPeriod]) return pm[selectedPeriod];
    return card.selectedMarket;
  })();

  const periodLabel = selectedPeriod === "full" ? "Full Game" : selectedPeriod === "h1" ? "1st Half" : "2nd Half";

  const tabAvail = (tab: "full" | "h1" | "h2"): boolean => {
    return !!card.periodMarkets?.[tab];
  };

  return (
    <div
      className={`rounded-xl border border-border/50 bg-card overflow-hidden transition-all ${
        card.badges.tierBadge === "Elite" ? "ring-1 ring-amber-500/30" : ""
      }`}
      data-testid={`game-card-${card.gameId}`}
    >
      <div
        className="p-4 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        data-testid={`card-toggle-${card.gameId}`}
      >
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400">
                <Radio className="w-3 h-3" />
                {card.badges.liveTag}
              </span>
              {card.bettingWindow !== "NONE" && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/20 text-blue-400">
                  {card.bettingWindowLabel}
                </span>
              )}
            </div>
            <h2 className="text-base font-bold" data-testid="card-matchup">
              {card.awayTeam} @ {card.homeTeam}
            </h2>
            <div className="text-2xl font-bold tracking-tight" data-testid="card-score">
              {card.awayScore} – {card.homeScore}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            {card.badges.tierBadge && (
              <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${
                card.badges.tierBadge === "Elite" ? "bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/30" :
                card.badges.tierBadge === "Strong" ? "bg-emerald-500/20 text-emerald-400" :
                "bg-blue-500/20 text-blue-400"
              }`} data-testid="tier-badge">
                {card.badges.tierBadge}
              </span>
            )}
            {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          <div className="flex justify-center">
            <ProbabilityRing value={activeMarket?.coverProbability ?? null} label="COVER" size="lg" />
          </div>
          <div className="text-center">
            <span className="text-xs text-muted-foreground font-medium">
              {periodLabel} • {activeMarket?.marketType === "spread" ? "Spread" : "Total"}
              {activeMarket?.line !== null && activeMarket?.line !== undefined && (
                <span className="ml-1 text-foreground font-semibold">{activeMarket.line}</span>
              )}
              {activeMarket?.side && (
                <span className={`ml-1 font-bold ${activeMarket.side === "OVER" || activeMarket.side === "HOME" ? "text-emerald-400" : "text-red-400"}`}>
                  {activeMarket.side}
                </span>
              )}
            </span>
          </div>

          <div className="flex items-center justify-center gap-8">
            <ProbabilityRing value={card.fullGameTotal.overProbability} label="OVER" size="sm" color="hsl(var(--brand-accent))" />
            <div className="flex flex-col items-center gap-0.5">
              {card.fullGameTotal.line !== null && (
                <span className="text-sm font-bold">{card.fullGameTotal.line}</span>
              )}
              <span className="text-[10px] text-muted-foreground">FG Total</span>
            </div>
            <ProbabilityRing value={card.fullGameTotal.underProbability} label="UNDER" size="sm" color="#ef4444" />
          </div>

          <div className="text-center">
            <span className="px-3 py-1 rounded-full text-[10px] bg-muted text-muted-foreground font-medium" data-testid="source-count">
              {card.fullGameTotal.sportsbookCount} source{card.fullGameTotal.sportsbookCount === 1 ? "" : "s"}
            </span>
          </div>

          <div className="space-y-2">
            <ValueSignalCard
              title={activeMarket?.confidenceLabel ?? null}
              subtitle={`Engine ${formatPct(activeMarket?.engineProbability ?? null)} vs Book ${formatPct(activeMarket?.bookProbability ?? null)}`}
              edge={activeMarket?.edge ?? null}
            />

            {activeMarket?.signalTag && (
              <InfoSignalCard
                title={activeMarket.signalTag}
                subtitle="Closing line value signal"
                direction={activeMarket.signalDirection}
              />
            )}
          </div>

          <div className="flex rounded-lg border border-border overflow-hidden" data-testid="market-tabs">
            {(["full", "h1", "h2"] as const).map(tab => {
              const avail = tabAvail(tab);
              return (
                <button
                  key={tab}
                  onClick={() => setSelectedPeriod(tab)}
                  disabled={!avail}
                  className={`flex-1 px-3 py-2 text-xs font-semibold transition-colors ${
                    selectedPeriod === tab
                      ? "bg-primary text-primary-foreground"
                      : avail
                        ? "bg-card text-muted-foreground hover:bg-muted"
                        : "bg-card/50 text-muted-foreground/30 cursor-not-allowed"
                  }`}
                  data-testid={`tab-${tab}`}
                >
                  {tab === "full" ? "Full Game" : tab === "h1" ? "1st Half" : "2nd Half"}
                </button>
              );
            })}
          </div>

          {selectedPeriod !== "full" && activeMarket && (
            <div className="rounded-lg border border-border/30 bg-background/50 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{periodLabel} {activeMarket.marketType}</span>
                <div className="flex items-center gap-2">
                  {activeMarket.side && (
                    <span className={`font-bold ${activeMarket.side === "OVER" || activeMarket.side === "HOME" ? "text-emerald-400" : "text-red-400"}`}>
                      {activeMarket.side}
                    </span>
                  )}
                  {activeMarket.line !== null && <span className="font-mono font-semibold">{activeMarket.line}</span>}
                  {activeMarket.coverProbability !== null && <span className="font-bold text-emerald-400">{activeMarket.coverProbability.toFixed(1)}%</span>}
                  {activeMarket.edge !== null && (
                    <span className="text-emerald-400 text-[10px]">+{activeMarket.edge.toFixed(1)}pp</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function NcaabLivePage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [authLoading, user, navigate]);

  const { data, isLoading, error } = useQuery<LiveResponse>({
    queryKey: ["/api/ncaab/live"],
    enabled: !!user,
    refetchInterval: LIVE_REFRESH_MS,
    refetchOnWindowFocus: true,
  });

  if (authLoading) return <div className="flex items-center justify-center h-screen text-muted-foreground" data-testid="loading-auth">Loading...</div>;
  if (!user) return null;

  const cards = data?.cards ?? [];
  const topPlays = data?.topPlays ?? [];
  const selectedCard = selectedGameId ? cards.find(c => c.gameId === selectedGameId) : null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto px-4 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate("/dashboard")}
              className="p-1.5 rounded-lg hover:bg-muted transition-colors"
              data-testid="btn-back"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-xl font-bold flex items-center gap-2" data-testid="page-title">
                <Activity className="w-5 h-5 text-primary" />
                NCAAB Live
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2" data-testid="live-status">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-muted-foreground">Live · {LIVE_REFRESH_MS / 1000}s</span>
          </div>
        </div>

        {isLoading && !data && (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive text-sm" data-testid="error-msg">
            Failed to load NCAAB live data. Retrying...
          </div>
        )}

        {!isLoading && cards.length === 0 && !error && (
          <div className="text-center py-16">
            <Activity className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground" data-testid="soft-status">Live data updating…</p>
          </div>
        )}

        {topPlays.length > 0 && (
          <div className="mb-6" data-testid="top-plays-section">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              Top Plays
              <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[10px] font-bold">
                {topPlays.length}
              </span>
            </h2>
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-hide">
              {topPlays.map(tp => (
                <TopPlayCard key={tp.gameId} card={tp} />
              ))}
            </div>
          </div>
        )}

        {cards.length > 0 && (
          <div className="mb-4" data-testid="game-chips">
            <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-hide">
              {cards.map(c => (
                <GameChip
                  key={c.gameId}
                  card={c}
                  isActive={selectedGameId === c.gameId}
                  onClick={() => setSelectedGameId(selectedGameId === c.gameId ? null : c.gameId)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4" data-testid="game-cards">
          {(selectedCard ? [selectedCard] : cards).map(card => (
            <NcaabGameCard key={card.gameId} card={card} />
          ))}
        </div>
      </div>
    </div>
  );
}
