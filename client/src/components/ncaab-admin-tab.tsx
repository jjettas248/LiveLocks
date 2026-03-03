import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, Clock, TrendingUp, TrendingDown, Plus } from "lucide-react";
import type { ParlayPickInput } from "@shared/schema";

interface BookLine {
  book: string;
  spread: number | null;
  total: number | null;
  favorite: string;
  h1Total: number | null;
  h1Spread: number | null;
  h1Favorite: string;
}

interface HandleSignal {
  pct: number | null;
  signal: "no_edge" | "fade" | "extreme" | "neutral" | "unavailable";
  label: string;
  color: string;
}

interface NCAABPlay {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamAbbr: string;
  awayTeamAbbr: string;
  status: string;
  clock: string;
  half: number;
  period: number;
  homeScore: number;
  awayScore: number;
  currentMargin: number;
  spread: number | null;
  total: number | null;
  favorite: string;
  bookLines: BookLine[];
  h1TotalLine: number | null;
  h1SpreadLine: number | null;
  h1Favorite: string;
  projectedTotal: number | null;
  projectedMargin: number | null;
  proj1HTotal: number | null;
  homeProjected: number | null;
  awayProjected: number | null;
  spreadProb: number | null;
  overProb: number | null;
  spreadEdge: number | null;
  totalEdge: number | null;
  over1HProb: number | null;
  total1HEdge: number | null;
  volatilityBonus: number;
  volatility: number | null;
  bettingWindow: "1H_WINDOW" | "HALFTIME" | "LATE_WINDOW" | "NONE";
  bettingWindowLabel: string;
  handleSignal: HandleSignal;
  desperation3s: boolean;
  intentionalFouling: boolean;
  scoringByPeriod: Record<string, number[]>;
  teamStats: Record<string, any>;
}

export type { ParlayPickInput as NCAABParlayPick };

interface NCAABGame {
  id: string;
  name: string;
  shortName: string;
  homeTeam: string;
  homeTeamAbbr: string;
  homeScore: number;
  awayTeam: string;
  awayTeamAbbr: string;
  awayScore: number;
  status: string;
  period: number;
  clock: string;
  isHalftime: boolean;
  isInProgress: boolean;
  isLive: boolean;
}

const BOOK_LABELS: Record<string, string> = {
  fanduel:    "FD",
  draftkings: "DK",
  betmgm:     "MGM",
  betrivers:  "BR",
};

const WINDOW_COLORS: Record<string, string> = {
  "1H_WINDOW":   "text-blue-400 bg-blue-500/10 border-blue-500/30",
  "HALFTIME":    "text-green-400 bg-green-500/10 border-green-500/30",
  "LATE_WINDOW": "text-orange-400 bg-orange-500/10 border-orange-500/30",
  "NONE":        "text-muted-foreground bg-secondary border-border",
};

function probBarRow(prob: number | null) {
  if (prob === null) return null;
  const pct = Math.min(100, Math.max(0, prob));
  const isOver = pct >= 50;
  const barWidth = isOver ? pct : 100 - pct;
  const barColor = pct >= 58 ? "bg-green-500" : pct <= 42 ? "bg-red-500" : "bg-primary/70";
  const textColor = pct >= 58 ? "text-green-400" : pct <= 42 ? "text-red-400" : "text-foreground";
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${barWidth}%` }} />
      </div>
      <span className={`text-xs font-bold tabular-nums w-12 text-right ${textColor}`}>
        {isOver ? "O " : "U "}{pct.toFixed(1)}%
      </span>
    </div>
  );
}

function BetRow({
  label,
  line,
  lineIsProj,
  prob,
  overProb,
  underProb,
  onOver,
  onUnder,
  singleSide,
  singleLabel,
}: {
  label: string;
  line: number | null;
  lineIsProj?: boolean;
  prob: number | null;
  overProb: number;
  underProb: number;
  onOver?: () => void;
  onUnder?: () => void;
  singleSide?: boolean;
  singleLabel?: string;
}) {
  if (line === null && prob === null) return null;
  const displayLine = line !== null ? `${line}${lineIsProj ? "*" : ""}` : "proj";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</span>
        <span className="text-xs font-bold text-foreground tabular-nums">{displayLine}</span>
      </div>
      {probBarRow(prob)}
      {(onOver || onUnder) && (
        <div className={`grid gap-2 ${singleSide ? "grid-cols-1" : "grid-cols-2"}`}>
          {onOver && (
            <button
              onClick={onOver}
              className="flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 active:scale-95 transition-all"
            >
              <Plus className="w-3 h-3" />
              {singleSide ? (singleLabel ?? `Cover ${displayLine}`) : `Over ${displayLine}`}
            </button>
          )}
          {onUnder && !singleSide && (
            <button
              onClick={onUnder}
              className="flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 active:scale-95 transition-all"
            >
              <Plus className="w-3 h-3" />
              Under {displayLine}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NCAABGameCard({ play, onAddToParlay }: { play: NCAABPlay; onAddToParlay?: (pick: ParlayPickInput) => void }) {
  const windowClass = WINDOW_COLORS[play.bettingWindow] ?? WINDOW_COLORS["NONE"];
  const hasWindow = play.bettingWindow !== "NONE";
  const isH1 = play.half === 1 && play.bettingWindow !== "HALFTIME";
  const isHalftime = play.bettingWindow === "HALFTIME";
  const halfLabel = play.half === 1 ? "H1" : play.half === 2 ? "H2" : "OT";

  const spreadEdgeAbs = Math.abs(play.spreadEdge ?? 0);
  const totalEdgeAbs  = Math.abs(play.totalEdge ?? 0);
  const bestEdge      = Math.max(spreadEdgeAbs, totalEdgeAbs);

  const fgLine   = play.total ?? (play.projectedTotal !== null ? Math.round(play.projectedTotal * 2) / 2 : null);
  const fgIsProj = play.total === null;
  const fgProb   = play.overProb ?? 50;

  const h1Line   = play.h1TotalLine ?? (play.proj1HTotal !== null ? Math.round(play.proj1HTotal * 2) / 2 : null);
  const h1IsProj = play.h1TotalLine === null;
  const h1Prob   = play.over1HProb ?? 50;

  function addPick(direction: "over" | "under", line: number, prob: number, statType: string, label: string) {
    if (!onAddToParlay) return;
    const bestBook = play.bookLines[0]?.book ?? "fanduel";
    const rawOdds = direction === "over"
      ? (prob >= 50 ? -Math.round((prob / (100 - prob)) * 100) : Math.round(((100 - prob) / prob) * 100))
      : (prob < 50 ? Math.round((prob / (100 - prob)) * 100) : -Math.round(((100 - prob) / prob) * 100));
    onAddToParlay({
      playerId: 0,
      playerName: label,
      playerTeam: "NCAAB",
      statType,
      line,
      probability: prob,
      betDirection: direction,
      sportsbook: bestBook,
      gameId: play.gameId,
      oddsAmerican: rawOdds,
    });
  }

  const edgePillColor = bestEdge >= 15
    ? "text-green-400 bg-green-500/10 border-green-500/30"
    : bestEdge >= 8
      ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/30"
      : null;

  return (
    <div
      data-testid={`ncaab-card-${play.gameId}`}
      className="bg-card border border-border rounded-xl overflow-hidden"
      style={bestEdge >= 15 ? { boxShadow: "0 0 12px -2px hsl(var(--primary) / 0.3)" } : undefined}
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="px-4 pt-4 pb-3 border-b border-border/40">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            {hasWindow && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${windowClass}`}>
                {play.bettingWindow === "1H_WINDOW" ? "1H ⏱" : play.bettingWindow === "HALFTIME" ? "HT ⏱" : "2H ⏱"}
              </span>
            )}
            {play.desperation3s && (
              <span className="text-[10px] text-orange-400 bg-orange-500/10 border border-orange-500/20 px-1.5 py-0.5 rounded-full">
                ⚠ Desperation 3s
              </span>
            )}
            {play.intentionalFouling && (
              <span className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-1.5 py-0.5 rounded-full">
                ⚑ Intentional Fouling
              </span>
            )}
          </div>
          {edgePillColor && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border flex-shrink-0 ${edgePillColor}`}>
              {bestEdge.toFixed(1)}pp edge
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-foreground truncate">{play.awayTeamAbbr}</span>
              <span className="text-2xl font-black tabular-nums text-foreground">{play.awayScore}</span>
              <span className="text-muted-foreground text-xs">–</span>
              <span className="text-2xl font-black tabular-nums text-foreground">{play.homeScore}</span>
              <span className="text-sm font-bold text-foreground truncate">{play.homeTeamAbbr}</span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">{play.awayTeam} @ {play.homeTeam}</p>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-xs font-semibold text-foreground">{halfLabel}</p>
            <p className="text-[10px] text-muted-foreground">{play.clock || play.status}</p>
          </div>
        </div>
      </div>

      {/* ── Bet Rows ─────────────────────────────────────────────── */}
      <div className="p-4 space-y-4">

        {/* 1H Total — only in H1 */}
        {isH1 && h1Line !== null && (
          <BetRow
            label="1H Total"
            line={h1Line}
            lineIsProj={h1IsProj}
            prob={h1Prob}
            overProb={h1Prob}
            underProb={100 - h1Prob}
            onOver={onAddToParlay ? () => addPick("over", h1Line, h1Prob, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — 1H Total`) : undefined}
            onUnder={onAddToParlay ? () => addPick("under", h1Line, 100 - h1Prob, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — 1H Total`) : undefined}
          />
        )}

        {/* Full Game Total */}
        {fgLine !== null && (
          <BetRow
            label="Full Game Total"
            line={fgLine}
            lineIsProj={fgIsProj}
            prob={fgProb}
            overProb={fgProb}
            underProb={100 - fgProb}
            onOver={onAddToParlay ? () => addPick("over", fgLine, fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — Total`) : undefined}
            onUnder={onAddToParlay ? () => addPick("under", fgLine, 100 - fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — Total`) : undefined}
          />
        )}

        {/* Spread — shown in H2 and Halftime; not in H1 where we show margin only */}
        {!isH1 && play.spread !== null && play.spreadProb !== null && (
          <BetRow
            label={`Spread — ${play.favorite}`}
            line={-play.spread}
            prob={play.spreadProb}
            overProb={play.spreadProb}
            underProb={100 - play.spreadProb}
            onOver={onAddToParlay ? () => addPick("over", play.spread!, play.spreadProb!, "ncaab_spread", `${play.favorite} -${play.spread} (Cover)`) : undefined}
            singleSide
            singleLabel={`${play.favorite} -${play.spread} Cover`}
          />
        )}

        {/* If H1 and no spread line available — show projected margin as info (no bet button) */}
        {isH1 && play.spread === null && play.projectedMargin !== null && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">1H Margin (proj)</span>
              <span className="text-xs text-muted-foreground">No line</span>
            </div>
            <p className="text-xs text-foreground">
              {play.projectedMargin > 0
                ? `${play.homeTeamAbbr} projected +${play.projectedMargin.toFixed(1)}`
                : play.projectedMargin < 0
                  ? `${play.awayTeamAbbr} projected +${Math.abs(play.projectedMargin).toFixed(1)}`
                  : "Proj pick 'em"}
            </p>
          </div>
        )}

        {/* Projected team finals */}
        {(play.homeProjected !== null || play.awayProjected !== null) && (
          <div className="flex gap-2 pt-1">
            {play.awayProjected !== null && (
              <div className="flex-1 bg-secondary/40 rounded-lg px-3 py-2 text-center">
                <p className="text-[10px] text-muted-foreground">{play.awayTeamAbbr} Proj</p>
                <p className="text-sm font-bold text-foreground">{Math.round(play.awayProjected)}</p>
              </div>
            )}
            {play.homeProjected !== null && (
              <div className="flex-1 bg-secondary/40 rounded-lg px-3 py-2 text-center">
                <p className="text-[10px] text-muted-foreground">{play.homeTeamAbbr} Proj</p>
                <p className="text-sm font-bold text-foreground">{Math.round(play.homeProjected)}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Book Lines footer ─────────────────────────────────────── */}
      {play.bookLines.length > 0 && (
        <div className="px-4 pb-3 border-t border-border/30 pt-3">
          <div className="flex gap-2 flex-wrap">
            {play.bookLines.map(bl => (
              <div key={bl.book} className="bg-secondary/60 border border-border/50 rounded-lg px-2.5 py-1.5 text-[10px] space-y-0.5">
                <span className="font-bold text-foreground">{BOOK_LABELS[bl.book] ?? bl.book}</span>
                {bl.spread !== null && <span className="text-muted-foreground ml-1">Sp {bl.favorite}{bl.spread > 0 ? "+" : ""}{-bl.spread}</span>}
                {bl.total !== null && <span className="text-muted-foreground ml-1">O/U {bl.total}</span>}
                {bl.h1Total !== null && (
                  <div className="text-blue-400/80 mt-0.5">1H O/U {bl.h1Total}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NCAABAllGamesGrid({ games }: { games: NCAABGame[] }) {
  if (games.length === 0) {
    return <p className="text-xs text-muted-foreground">No games found in today's slate.</p>;
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
      {games.map(g => {
        const statusColor = g.isLive ? "text-green-400" : "text-muted-foreground";
        return (
          <div key={g.id} className="bg-secondary/50 border border-border/60 rounded-lg px-3 py-2">
            <p className="text-xs text-foreground font-medium">{g.awayTeam} <span className="text-muted-foreground">@</span> {g.homeTeam}</p>
            <p className={`text-[10px] mt-0.5 ${statusColor}`}>
              {g.isLive ? `LIVE — ${g.status} · ${g.clock}` : g.status}
            </p>
            {g.isLive && (
              <p className="text-xs font-bold tabular-nums text-foreground mt-0.5">
                {g.awayScore} – {g.homeScore}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface NCAABAdminTabProps {
  onAddToParlay?: (pick: ParlayPickInput) => void;
  isAdmin?: boolean;
}

export function NCAABAdminTab({ onAddToParlay }: NCAABAdminTabProps) {
  const [ncaabSubTab, setNcaabSubTab] = useState<"live" | "halftime">("live");

  const playsQuery = useQuery<{ plays: NCAABPlay[] }>({
    queryKey: ["/api/ncaab/plays"],
    refetchInterval: 60 * 1000,
  });

  const gamesQuery = useQuery<{ games: NCAABGame[] }>({
    queryKey: ["/api/ncaab/games"],
    refetchInterval: 90 * 1000,
  });

  const plays  = playsQuery.data?.plays  ?? [];
  const games  = gamesQuery.data?.games  ?? [];
  const loading = playsQuery.isLoading || gamesQuery.isLoading;
  const error   = playsQuery.error ?? gamesQuery.error;

  const liveGames       = games.filter(g => g.isLive);
  const scheduledGames  = games.filter(g => !g.isLive);
  const hasPlays        = plays.length > 0;
  const halftimePlays   = plays.filter(p => p.bettingWindow === "HALFTIME");

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1 bg-secondary/40 border border-border/60 rounded-xl p-1">
          <button
            data-testid="tab-ncaab-live"
            onClick={() => setNcaabSubTab("live")}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              ncaabSubTab === "live"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Live
          </button>
          <button
            data-testid="tab-ncaab-halftime"
            onClick={() => setNcaabSubTab("halftime")}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 ${
              ncaabSubTab === "halftime"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <TrendingUp className="w-3 h-3" />
            2H Plays
          </button>
        </div>
        <button
          data-testid="ncaab-refresh"
          onClick={() => { playsQuery.refetch(); gamesQuery.refetch(); }}
          disabled={loading}
          className="flex-shrink-0 p-1.5 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-muted-foreground ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-xs text-red-400">{(error as any).message ?? "Failed to load NCAAB data"}</p>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !error && (
        <div className="space-y-3">
          {[1, 2].map(i => (
            <div key={i} className="bg-card border border-border rounded-xl p-4 animate-pulse">
              <div className="h-4 bg-secondary rounded w-1/2 mb-2" />
              <div className="h-3 bg-secondary/60 rounded w-1/3" />
            </div>
          ))}
        </div>
      )}

      {/* ── Live sub-tab ─────────────────────────────────────────── */}
      {ncaabSubTab === "live" && !loading && (
        <>
          {hasPlays && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                <p className="text-sm font-semibold text-foreground">
                  {plays.length} Live {plays.length === 1 ? "Game" : "Games"} — Computed Plays
                </p>
                {onAddToParlay && (
                  <span className="text-[10px] text-muted-foreground ml-auto">Tap + to add to parlay</span>
                )}
              </div>
              {plays.map(p => (
                <NCAABGameCard key={p.gameId} play={p} onAddToParlay={onAddToParlay} />
              ))}
            </div>
          )}

          {!hasPlays && !error && (
            <div className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
              <Clock className="w-8 h-8 text-muted-foreground mx-auto" />
              <p className="text-sm font-semibold text-foreground">No Live NCAAB Games Right Now</p>
              <p className="text-xs text-muted-foreground">
                The model will activate automatically when games go live. Check back during game time.
              </p>
            </div>
          )}

          {/* Scheduled games grid */}
          {scheduledGames.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Today's Slate</p>
              <NCAABAllGamesGrid games={scheduledGames} />
            </div>
          )}
        </>
      )}

      {/* ── 2H Plays sub-tab ─────────────────────────────────────── */}
      {ncaabSubTab === "halftime" && !loading && (
        <>
          {halftimePlays.length === 0 && (
            <div className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
              <Clock className="w-8 h-8 text-muted-foreground mx-auto" />
              <p className="text-sm font-semibold text-foreground">No games at halftime right now</p>
              <p className="text-xs text-muted-foreground">
                Check back during live games — 2H plays appear when teams hit the locker room.
              </p>
            </div>
          )}

          {halftimePlays.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                <p className="text-sm font-semibold text-foreground">
                  {halftimePlays.length} {halftimePlays.length === 1 ? "Game" : "Games"} at Halftime
                </p>
                {onAddToParlay && (
                  <span className="text-[10px] text-muted-foreground ml-auto">Tap + to add to parlay</span>
                )}
              </div>
              {halftimePlays.map(play => {
                const spreadEdgeAbs = Math.abs(play.spreadEdge ?? 0);
                const totalEdgeAbs  = Math.abs(play.totalEdge ?? 0);
                const bestEdge = Math.max(spreadEdgeAbs, totalEdgeAbs);
                const edgePillColor = bestEdge >= 15
                  ? "text-green-400 bg-green-500/10 border-green-500/30"
                  : bestEdge >= 8
                    ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/30"
                    : null;

                const fgLine = play.total ?? (play.projectedTotal !== null ? Math.round(play.projectedTotal * 2) / 2 : null);
                const fgIsProj = play.total === null;
                const fgProb = play.overProb ?? 50;

                function addPick(direction: "over" | "under", line: number, prob: number, statType: string, label: string) {
                  if (!onAddToParlay) return;
                  const bestBook = play.bookLines[0]?.book ?? "fanduel";
                  const rawOdds = direction === "over"
                    ? (prob >= 50 ? -Math.round((prob / (100 - prob)) * 100) : Math.round(((100 - prob) / prob) * 100))
                    : (prob < 50 ? Math.round((prob / (100 - prob)) * 100) : -Math.round(((100 - prob) / prob) * 100));
                  onAddToParlay({
                    playerId: 0, playerName: label, playerTeam: "NCAAB",
                    statType, line, probability: prob, betDirection: direction,
                    sportsbook: bestBook, gameId: play.gameId, oddsAmerican: rawOdds,
                  });
                }

                return (
                  <div key={play.gameId} data-testid={`ncaab-2h-card-${play.gameId}`} className="bg-card border border-border rounded-xl overflow-hidden"
                    style={bestEdge >= 15 ? { boxShadow: "0 0 12px -2px hsl(var(--primary) / 0.3)" } : undefined}
                  >
                    {/* Header */}
                    <div className="px-4 pt-4 pb-3 border-b border-border/40">
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border text-green-400 bg-green-500/10 border-green-500/30">HT ⏱</span>
                        {edgePillColor && (
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${edgePillColor}`}>
                            {bestEdge.toFixed(1)}pp edge
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-foreground">{play.awayTeamAbbr}</span>
                        <span className="text-2xl font-black tabular-nums">{play.awayScore}</span>
                        <span className="text-muted-foreground text-xs">–</span>
                        <span className="text-2xl font-black tabular-nums">{play.homeScore}</span>
                        <span className="text-sm font-bold text-foreground">{play.homeTeamAbbr}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{play.awayTeam} @ {play.homeTeam}</p>
                    </div>

                    {/* Bet rows */}
                    <div className="p-4 space-y-4">
                      {/* Full Game Total */}
                      {fgLine !== null && (
                        <BetRow
                          label="Full Game Total"
                          line={fgLine}
                          lineIsProj={fgIsProj}
                          prob={fgProb}
                          overProb={fgProb}
                          underProb={100 - fgProb}
                          onOver={onAddToParlay ? () => addPick("over", fgLine, fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — Total`) : undefined}
                          onUnder={onAddToParlay ? () => addPick("under", fgLine, 100 - fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — Total`) : undefined}
                        />
                      )}

                      {/* Spread */}
                      {play.spread !== null && play.spreadProb !== null && (
                        <BetRow
                          label={`Spread — ${play.favorite}`}
                          line={-play.spread}
                          prob={play.spreadProb}
                          overProb={play.spreadProb}
                          underProb={100 - play.spreadProb}
                          onOver={onAddToParlay ? () => addPick("over", play.spread!, play.spreadProb!, "ncaab_spread", `${play.favorite} -${play.spread} (Cover)`) : undefined}
                          singleSide
                          singleLabel={`${play.favorite} -${play.spread} Cover`}
                        />
                      )}

                      {/* Team Totals */}
                      {(play.awayProjected !== null || play.homeProjected !== null) && (
                        <div className="flex gap-2 pt-1">
                          {play.awayProjected !== null && (
                            <div className="flex-1 bg-secondary/40 rounded-lg px-3 py-2 text-center">
                              <p className="text-[10px] text-muted-foreground">{play.awayTeamAbbr} Proj</p>
                              <p className="text-sm font-bold text-foreground">{Math.round(play.awayProjected)}</p>
                            </div>
                          )}
                          {play.homeProjected !== null && (
                            <div className="flex-1 bg-secondary/40 rounded-lg px-3 py-2 text-center">
                              <p className="text-[10px] text-muted-foreground">{play.homeTeamAbbr} Proj</p>
                              <p className="text-sm font-bold text-foreground">{Math.round(play.homeProjected)}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Book Lines */}
                    {play.bookLines.length > 0 && (
                      <div className="px-4 pb-3 border-t border-border/30 pt-3">
                        <div className="flex gap-2 flex-wrap">
                          {play.bookLines.map(bl => (
                            <div key={bl.book} className="bg-secondary/60 border border-border/50 rounded-lg px-2.5 py-1.5 text-[10px]">
                              <span className="font-bold text-foreground">{BOOK_LABELS[bl.book] ?? bl.book}</span>
                              {bl.spread !== null && <span className="text-muted-foreground ml-1">Sp {bl.favorite}{bl.spread > 0 ? "+" : ""}{-bl.spread}</span>}
                              {bl.total !== null && <span className="text-muted-foreground ml-1">O/U {bl.total}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
