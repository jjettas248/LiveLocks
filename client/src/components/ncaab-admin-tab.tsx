import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, Clock, TrendingUp, Plus } from "lucide-react";
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
  desperation3s: boolean;
  intentionalFouling: boolean;
  scoringByPeriod: Record<string, number[]>;
  teamStats: Record<string, any>;
}

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
};

function probToAmericanOdds(prob: number): number {
  const p = Math.max(1, Math.min(99, prob));
  if (p >= 50) return -Math.round((p / (100 - p)) * 100);
  return Math.round(((100 - p) / p) * 100);
}

function ProbBar({ prob, label }: { prob: number; label?: string }) {
  const pct = Math.min(100, Math.max(0, prob));
  const isOver = label === "over" || (label === undefined && pct >= 50);
  const barWidth = isOver ? pct : 100 - pct;
  const barColor = pct >= 58 ? "bg-emerald-500" : pct <= 42 ? "bg-rose-500" : "bg-primary/70";
  const textColor = pct >= 58 ? "text-emerald-400" : pct <= 42 ? "text-rose-400" : "text-muted-foreground";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${barWidth}%` }} />
      </div>
      <span className={`text-xs font-bold tabular-nums shrink-0 ${textColor}`}>
        {(isOver ? pct : 100 - pct).toFixed(1)}%
      </span>
    </div>
  );
}

function BetRow({
  label,
  line,
  lineIsProj,
  overProb,
  onOver,
  onUnder,
  singleSide,
  singleLabel,
}: {
  label: string;
  line: number | string | null;
  lineIsProj?: boolean;
  overProb: number;
  onOver?: () => void;
  onUnder?: () => void;
  singleSide?: boolean;
  singleLabel?: string;
}) {
  if (line === null) return null;
  const displayLine = line !== null ? `${line}${lineIsProj ? "*" : ""}` : "proj";
  const underProb = 100 - overProb;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</span>
        <span className="text-sm font-bold text-foreground tabular-nums">{displayLine}</span>
      </div>
      <ProbBar prob={overProb} label={singleSide ? "cover" : "over"} />
      <div className={`grid gap-2 ${singleSide ? "grid-cols-1" : "grid-cols-2"}`}>
        {onOver && (
          <button
            onClick={onOver}
            className="flex items-center justify-center gap-1.5 text-xs font-bold px-3 py-2.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 active:scale-95 transition-all"
          >
            <Plus className="w-3 h-3" />
            {singleSide
              ? `${singleLabel ?? `Cover ${displayLine}`} · ${overProb.toFixed(1)}%`
              : `Over ${displayLine} · ${overProb.toFixed(1)}%`}
          </button>
        )}
        {onUnder && !singleSide && (
          <button
            onClick={onUnder}
            className="flex items-center justify-center gap-1.5 text-xs font-bold px-3 py-2.5 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 active:scale-95 transition-all"
          >
            <Plus className="w-3 h-3" />
            Under {displayLine} · {underProb.toFixed(1)}%
          </button>
        )}
      </div>
    </div>
  );
}

function makeAddPick(
  onAddToParlay: ((pick: ParlayPickInput) => void) | undefined,
  play: NCAABPlay,
) {
  return function addPick(
    direction: "over" | "under",
    lineVal: number,
    prob: number,
    statType: string,
    label: string,
  ) {
    if (!onAddToParlay) return;
    const bestBook = play.bookLines[0]?.book ?? "fanduel";
    onAddToParlay({
      playerId: 0,
      playerName: label,
      playerTeam: "NCAAB",
      statType,
      line: lineVal,
      probability: prob,
      betDirection: direction,
      sportsbook: bestBook,
      gameId: play.gameId,
      oddsAmerican: probToAmericanOdds(prob),
    });
  };
}

function NCAABGameCard({ play, onAddToParlay }: { play: NCAABPlay; onAddToParlay?: (pick: ParlayPickInput) => void }) {
  const addPick = makeAddPick(onAddToParlay, play);
  const windowClass = WINDOW_COLORS[play.bettingWindow];
  const hasWindow = play.bettingWindow !== "NONE" && windowClass;
  const isH1 = play.half === 1;
  const halfLabel = play.half === 1 ? "H1" : play.half === 2 ? "H2" : "OT";

  const spreadEdgeAbs = Math.abs(play.spreadEdge ?? 0);
  const totalEdgeAbs  = Math.abs(play.totalEdge ?? 0);
  const bestEdge      = Math.max(spreadEdgeAbs, totalEdgeAbs);
  const edgePillColor = bestEdge >= 15
    ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
    : bestEdge >= 8
      ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/30"
      : null;

  const fgLine   = play.total ?? (play.projectedTotal !== null ? Math.round((play.projectedTotal) * 2) / 2 : null);
  const fgIsProj = play.total === null;
  const fgProb   = play.overProb ?? 50;

  const h1Line   = play.h1TotalLine ?? (play.proj1HTotal !== null ? Math.round(play.proj1HTotal * 2) / 2 : null);
  const h1IsProj = play.h1TotalLine === null;
  const h1Prob   = play.over1HProb ?? 50;

  const spLine  = play.spread !== null ? -play.spread : null;
  const spProb  = play.spreadProb ?? null;

  return (
    <div
      data-testid={`ncaab-card-${play.gameId}`}
      className="bg-card border border-border rounded-xl overflow-hidden"
      style={bestEdge >= 15 ? { boxShadow: "0 0 14px -2px hsl(var(--primary) / 0.35)" } : undefined}
    >
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="px-4 pt-4 pb-3 border-b border-border/40">
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          {hasWindow && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${windowClass}`}>
              {play.bettingWindow === "1H_WINDOW" ? "1H ⏱" : play.bettingWindow === "HALFTIME" ? "HT ⏱" : "2H ⏱"}
            </span>
          )}
          {play.desperation3s && (
            <span className="text-[10px] text-orange-400 bg-orange-500/10 border border-orange-500/20 px-1.5 py-0.5 rounded-full">⚠ Desperation 3s</span>
          )}
          {play.intentionalFouling && (
            <span className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-1.5 py-0.5 rounded-full">⚑ Fouling</span>
          )}
          {edgePillColor && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ml-auto ${edgePillColor}`}>
              {bestEdge.toFixed(1)}pp edge
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-foreground">{play.awayTeamAbbr}</span>
              <span className="text-2xl font-black tabular-nums text-foreground">{play.awayScore}</span>
              <span className="text-muted-foreground">–</span>
              <span className="text-2xl font-black tabular-nums text-foreground">{play.homeScore}</span>
              <span className="text-sm font-bold text-foreground">{play.homeTeamAbbr}</span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">{play.awayTeam} @ {play.homeTeam}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs font-bold text-foreground">{halfLabel}</p>
            <p className="text-[10px] text-muted-foreground">{play.clock || play.status}</p>
          </div>
        </div>
      </div>

      {/* ── Bet Rows ─────────────────────────────────────────── */}
      <div className="p-4 space-y-5">
        {/* 1H Total — only when in H1 */}
        {isH1 && h1Line !== null && (
          <BetRow
            label="1H Total"
            line={h1Line}
            lineIsProj={h1IsProj}
            overProb={h1Prob}
            onOver={onAddToParlay ? () => addPick("over", h1Line, h1Prob, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — 1H O${h1Line}${h1IsProj ? "*" : ""}`) : undefined}
            onUnder={onAddToParlay ? () => addPick("under", h1Line, 100 - h1Prob, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — 1H U${h1Line}${h1IsProj ? "*" : ""}`) : undefined}
          />
        )}

        {/* Full Game Total */}
        {fgLine !== null && (
          <BetRow
            label="Full Game Total"
            line={fgLine}
            lineIsProj={fgIsProj}
            overProb={fgProb}
            onOver={onAddToParlay ? () => addPick("over", fgLine, fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — O${fgLine}${fgIsProj ? "*" : ""}`) : undefined}
            onUnder={onAddToParlay ? () => addPick("under", fgLine, 100 - fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — U${fgLine}${fgIsProj ? "*" : ""}`) : undefined}
          />
        )}

        {/* Spread — show whenever data is available (H1 or H2) */}
        {spLine !== null && spProb !== null && (
          <BetRow
            label={`Spread — ${play.favorite}`}
            line={spLine}
            overProb={spProb}
            onOver={onAddToParlay ? () => addPick("over", Math.abs(spLine), spProb, "ncaab_spread", `${play.favorite} ${spLine} Cover`) : undefined}
            singleSide
            singleLabel={`${play.favorite} ${spLine > 0 ? "+" : ""}${spLine} Cover`}
          />
        )}

        {/* Projected margin when no book spread */}
        {spLine === null && play.projectedMargin !== null && (
          <div className="text-xs text-muted-foreground italic">
            1H Margin (proj): {play.projectedMargin > 0
              ? `${play.homeTeamAbbr} +${play.projectedMargin.toFixed(1)}`
              : play.projectedMargin < 0
                ? `${play.awayTeamAbbr} +${Math.abs(play.projectedMargin).toFixed(1)}`
                : "Pick 'em"} — No line
          </div>
        )}

        {/* Projected finals */}
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

      {/* ── Book Lines ─────────────────────────────────────── */}
      {play.bookLines.length > 0 && (
        <div className="px-4 pb-4 border-t border-border/30 pt-3">
          <div className="flex gap-2 flex-wrap">
            {play.bookLines.map(bl => (
              <div key={bl.book} className="bg-secondary/60 border border-border/50 rounded-lg px-2.5 py-1.5 text-[10px] space-y-0.5">
                <span className="font-bold text-foreground">{BOOK_LABELS[bl.book] ?? bl.book}</span>
                {bl.spread !== null && bl.favorite && (
                  <span className="text-muted-foreground ml-1">{bl.favorite} -{Math.abs(bl.spread)}</span>
                )}
                {bl.total !== null && <span className="text-muted-foreground ml-1">O/U {bl.total}</span>}
                {bl.h1Total !== null && <div className="text-blue-400/80">1H O/U {bl.h1Total}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NCAABAllGamesGrid({ games }: { games: NCAABGame[] }) {
  if (games.length === 0) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
      {games.map(g => (
        <div key={g.id} className="bg-secondary/50 border border-border/60 rounded-lg px-3 py-2">
          <p className="text-xs text-foreground font-medium">{g.awayTeam} <span className="text-muted-foreground">@</span> {g.homeTeam}</p>
          <p className={`text-[10px] mt-0.5 ${g.isLive ? "text-emerald-400" : "text-muted-foreground"}`}>
            {g.isLive ? `LIVE — ${g.status} · ${g.clock}` : g.status}
          </p>
          {g.isLive && (
            <p className="text-xs font-bold tabular-nums text-foreground mt-0.5">{g.awayScore} – {g.homeScore}</p>
          )}
        </div>
      ))}
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

  const liveGames      = games.filter(g => g.isLive);
  const scheduledGames = games.filter(g => !g.isLive);
  const halftimePlays  = plays.filter(p => p.bettingWindow === "HALFTIME");

  return (
    <div className="space-y-4">
      {/* Sub-tab pills */}
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
          className="p-1.5 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-muted-foreground ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-xs text-red-400">{(error as any).message ?? "Failed to load NCAAB data"}</p>
        </div>
      )}

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

      {/* Live sub-tab */}
      {ncaabSubTab === "live" && !loading && (
        <>
          {plays.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <p className="text-sm font-semibold text-foreground">
                  {plays.length} Live {plays.length === 1 ? "Game" : "Games"}
                </p>
                {onAddToParlay && (
                  <span className="text-[10px] text-muted-foreground ml-auto">+ buttons add to parlay</span>
                )}
              </div>
              {plays.map(p => (
                <NCAABGameCard key={p.gameId} play={p} onAddToParlay={onAddToParlay} />
              ))}
            </div>
          )}

          {plays.length === 0 && !error && (
            <div className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
              <Clock className="w-8 h-8 text-muted-foreground mx-auto" />
              <p className="text-sm font-semibold text-foreground">No Live NCAAB Games Right Now</p>
              <p className="text-xs text-muted-foreground">Model activates automatically when games go live.</p>
            </div>
          )}

          {scheduledGames.length > 0 && (
            <div className="space-y-2 mt-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Today's Slate</p>
              <NCAABAllGamesGrid games={scheduledGames} />
            </div>
          )}
        </>
      )}

      {/* 2H Plays sub-tab */}
      {ncaabSubTab === "halftime" && !loading && (
        <>
          {halftimePlays.length === 0 && (
            <div className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
              <Clock className="w-8 h-8 text-muted-foreground mx-auto" />
              <p className="text-sm font-semibold text-foreground">No games at halftime right now</p>
              <p className="text-xs text-muted-foreground">2H plays appear when teams hit the locker room.</p>
            </div>
          )}

          {halftimePlays.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <p className="text-sm font-semibold text-foreground">
                  {halftimePlays.length} {halftimePlays.length === 1 ? "Game" : "Games"} at Halftime
                </p>
                {onAddToParlay && (
                  <span className="text-[10px] text-muted-foreground ml-auto">+ buttons add to parlay</span>
                )}
              </div>
              {halftimePlays.map(play => {
                const addPick = makeAddPick(onAddToParlay, play);
                const spreadEdgeAbs = Math.abs(play.spreadEdge ?? 0);
                const totalEdgeAbs  = Math.abs(play.totalEdge ?? 0);
                const bestEdge = Math.max(spreadEdgeAbs, totalEdgeAbs);
                const edgePillColor = bestEdge >= 15
                  ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
                  : bestEdge >= 8
                    ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/30"
                    : null;

                const fgLine = play.total ?? (play.projectedTotal !== null ? Math.round(play.projectedTotal * 2) / 2 : null);
                const fgIsProj = play.total === null;
                const fgProb = play.overProb ?? 50;
                const spLine = play.spread !== null ? -play.spread : null;
                const spProb = play.spreadProb ?? null;

                return (
                  <div
                    key={play.gameId}
                    data-testid={`ncaab-2h-card-${play.gameId}`}
                    className="bg-card border border-border rounded-xl overflow-hidden"
                    style={bestEdge >= 15 ? { boxShadow: "0 0 14px -2px hsl(var(--primary) / 0.35)" } : undefined}
                  >
                    <div className="px-4 pt-4 pb-3 border-b border-border/40">
                      <div className="flex flex-wrap items-center gap-1.5 mb-2">
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border text-emerald-400 bg-emerald-500/10 border-emerald-500/30">HT ⏱</span>
                        {edgePillColor && (
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ml-auto ${edgePillColor}`}>
                            {bestEdge.toFixed(1)}pp edge
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-foreground">{play.awayTeamAbbr}</span>
                        <span className="text-2xl font-black tabular-nums text-foreground">{play.awayScore}</span>
                        <span className="text-muted-foreground">–</span>
                        <span className="text-2xl font-black tabular-nums text-foreground">{play.homeScore}</span>
                        <span className="text-sm font-bold text-foreground">{play.homeTeamAbbr}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{play.awayTeam} @ {play.homeTeam}</p>
                    </div>

                    <div className="p-4 space-y-5">
                      {fgLine !== null && (
                        <BetRow
                          label="Full Game Total"
                          line={fgLine}
                          lineIsProj={fgIsProj}
                          overProb={fgProb}
                          onOver={onAddToParlay ? () => addPick("over", fgLine, fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — O${fgLine}`) : undefined}
                          onUnder={onAddToParlay ? () => addPick("under", fgLine, 100 - fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — U${fgLine}`) : undefined}
                        />
                      )}
                      {spLine !== null && spProb !== null && (
                        <BetRow
                          label={`Spread — ${play.favorite}`}
                          line={spLine}
                          overProb={spProb}
                          onOver={onAddToParlay ? () => addPick("over", Math.abs(spLine), spProb, "ncaab_spread", `${play.favorite} ${spLine > 0 ? "+" : ""}${spLine} Cover`) : undefined}
                          singleSide
                          singleLabel={`${play.favorite} ${spLine > 0 ? "+" : ""}${spLine} Cover`}
                        />
                      )}
                      {(play.awayProjected !== null || play.homeProjected !== null) && (
                        <div className="flex gap-2">
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

                    {play.bookLines.length > 0 && (
                      <div className="px-4 pb-4 border-t border-border/30 pt-3">
                        <div className="flex gap-2 flex-wrap">
                          {play.bookLines.map(bl => (
                            <div key={bl.book} className="bg-secondary/60 border border-border/50 rounded-lg px-2.5 py-1.5 text-[10px]">
                              <span className="font-bold text-foreground">{BOOK_LABELS[bl.book] ?? bl.book}</span>
                              {bl.spread !== null && bl.favorite && <span className="text-muted-foreground ml-1">{bl.favorite} -{Math.abs(bl.spread)}</span>}
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
