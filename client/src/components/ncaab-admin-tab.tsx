import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, Clock, TrendingUp, TrendingDown, ChevronDown, ChevronUp, Plus } from "lucide-react";
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

function edgeColor(edge: number | null): string {
  if (edge === null) return "text-muted-foreground";
  const abs = Math.abs(edge);
  if (abs >= 15) return edge > 0 ? "text-green-400" : "text-red-400";
  if (abs >= 8)  return edge > 0 ? "text-yellow-400" : "text-orange-400";
  return "text-muted-foreground";
}

function probBar(prob: number | null, compact?: boolean, showLabels?: boolean) {
  if (prob === null) return null;
  const pct = Math.min(100, Math.max(0, prob));
  const isOver = pct >= 50;
  const barWidth = isOver ? pct : 100 - pct;
  const barColor = isOver ? "bg-green-500" : "bg-red-500";
  const overPct = pct;
  const underPct = 100 - pct;

  if (showLabels) {
    return (
      <div className="space-y-1 mt-1">
        <div className="flex justify-between text-[10px] font-semibold">
          <span className="text-green-400">Over {overPct.toFixed(1)}%</span>
          <span className="text-red-400">Under {underPct.toFixed(1)}%</span>
        </div>
        <div className={`flex-1 ${compact ? "h-1" : "h-1.5"} bg-secondary rounded-full overflow-hidden`}>
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${barWidth}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-1.5 ${compact ? "" : "mt-1"}`}>
      <div className={`flex-1 ${compact ? "h-1" : "h-1.5"} bg-secondary rounded-full overflow-hidden`}>
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${barWidth}%` }} />
      </div>
      <span className={`${compact ? "text-[9px]" : "text-[10px]"} font-bold font-mono ${isOver ? "text-green-400" : "text-red-400"}`}>
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

function teamLeanBar(homeProj: number | null, awayProj: number | null, homeAbbr: string, awayAbbr: string) {
  if (homeProj === null || awayProj === null) return null;
  const total = homeProj + awayProj;
  if (total <= 0) return null;
  const homePct = (homeProj / total) * 100;
  const isHomeFavored = homePct >= 50;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span className="font-semibold text-foreground">{awayAbbr} <span className="font-mono text-foreground">{awayProj}</span></span>
        <span className="font-semibold text-foreground">{homeAbbr} <span className="font-mono text-foreground">{homeProj}</span></span>
      </div>
      <div className="h-1.5 bg-secondary rounded-full overflow-hidden flex">
        <div
          className="h-full bg-blue-500 rounded-l-full transition-all"
          style={{ width: `${100 - homePct}%` }}
        />
        <div
          className="h-full bg-orange-500 rounded-r-full transition-all"
          style={{ width: `${homePct}%` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground text-center">
        {isHomeFavored ? homeAbbr : awayAbbr} projected to outscore opponent
      </p>
    </div>
  );
}

function NCAABGameCard({ play, onAddToParlay }: { play: NCAABPlay; onAddToParlay?: (pick: ParlayPickInput) => void }) {
  const [expanded, setExpanded] = useState(false);

  const windowClass = WINDOW_COLORS[play.bettingWindow] ?? WINDOW_COLORS["NONE"];
  const hasWindow = play.bettingWindow !== "NONE";
  const spreadEdgeAbs = Math.abs(play.spreadEdge ?? 0);
  const totalEdgeAbs  = Math.abs(play.totalEdge ?? 0);
  const bestEdge      = Math.max(spreadEdgeAbs, totalEdgeAbs);
  const halfLabel = play.half === 1 ? "H1" : play.half === 2 ? "H2" : "OT";

  const isH1 = play.half === 1 && !play.bettingWindow.includes("HALFTIME");

  const effectiveFGLine = play.total ?? (play.projectedTotal !== null ? Math.round(play.projectedTotal * 2) / 2 : null);
  const effectiveFGProb = play.overProb ?? 50;
  const fgLineIsProj = play.total === null && effectiveFGLine !== null;

  const effective1HLine = play.h1TotalLine ?? (play.proj1HTotal !== null ? Math.round(play.proj1HTotal * 2) / 2 : null);
  const effective1HProb = play.over1HProb ?? 50;
  const h1LineIsProj = play.h1TotalLine === null && effective1HLine !== null;

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

  return (
    <div
      data-testid={`ncaab-card-${play.gameId}`}
      className="bg-card border border-border rounded-xl overflow-hidden"
      style={bestEdge >= 15 ? { boxShadow: "0 0 12px -2px hsl(var(--primary) / 0.3)" } : undefined}
    >
      {/* Header — clickable to expand */}
      <button
        className="w-full text-left px-4 pt-4 pb-3 border-b border-border/50 hover:bg-secondary/20 transition-colors"
        onClick={() => setExpanded(!expanded)}
        data-testid={`ncaab-card-toggle-${play.gameId}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground mb-0.5">{halfLabel} · {play.clock || play.status}</p>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="hidden sm:inline text-sm font-bold text-foreground">{play.awayTeam}</span>
              <span className="sm:hidden text-sm font-bold text-foreground">{play.awayTeamAbbr}</span>
              <span className="text-2xl font-black tabular-nums text-foreground">{play.awayScore}</span>
              <span className="text-muted-foreground text-xs font-medium">vs</span>
              <span className="text-2xl font-black tabular-nums text-foreground">{play.homeScore}</span>
              <span className="hidden sm:inline text-sm font-bold text-foreground">{play.homeTeam}</span>
              <span className="sm:hidden text-sm font-bold text-foreground">{play.homeTeamAbbr}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {hasWindow && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${windowClass}`}>
                {play.bettingWindow === "1H_WINDOW" ? "1H ⏱" : play.bettingWindow === "HALFTIME" ? "HT ⏱" : "2H ⏱"}
              </span>
            )}
            {hasWindow && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border hidden sm:inline-block ${windowClass}`}>
                {play.bettingWindowLabel}
              </span>
            )}
            {expanded
              ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
              : <ChevronDown className="w-4 h-4 text-muted-foreground" />
            }
          </div>
        </div>

        {/* Coaching flags */}
        <div className="flex gap-2 mt-1.5 flex-wrap">
          {play.desperation3s && (
            <span className="text-[10px] text-orange-400 bg-orange-500/10 border border-orange-500/20 px-1.5 py-0.5 rounded">
              ⚠ Desperation 3s (+{play.volatilityBonus} vol)
            </span>
          )}
          {play.intentionalFouling && (
            <span className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-1.5 py-0.5 rounded">
              ⚑ Intentional Fouling (+6 proj)
            </span>
          )}
        </div>

        {/* Collapsed summary row — always shows proj total */}
        {!expanded && (
          <div className="flex gap-3 mt-2 flex-wrap items-center">
            {play.projectedTotal !== null && (
              <span className="text-[11px] text-muted-foreground">
                Proj <span className="text-foreground font-semibold">{play.projectedTotal.toFixed(1)}</span>
                {play.total !== null && (
                  <>
                    {" "}vs O/U {play.total}
                    {" · "}
                    <span className={(() => {
                      const edge = play.totalEdge ?? 0;
                      const abs = Math.abs(edge);
                      if (abs >= 10) return edge > 0 ? "text-green-400 font-semibold" : "text-red-400 font-semibold";
                      if (abs >= 5)  return edge > 0 ? "text-yellow-400 font-semibold" : "text-orange-400 font-semibold";
                      return "text-muted-foreground";
                    })()}>
                      {play.totalEdge !== null && play.totalEdge > 0 ? "↑ Over lean" : "↓ Under lean"}
                    </span>
                    {" "}
                    <span className={`inline-block w-2 h-2 rounded-full ${(() => {
                      const abs = Math.abs(play.totalEdge ?? 0);
                      if (abs >= 10) return "bg-green-500";
                      if (abs >= 5)  return "bg-yellow-500";
                      return "bg-secondary";
                    })()}`} />
                  </>
                )}
              </span>
            )}
            {play.projectedTotal === null && play.totalEdge !== null && play.total !== null && (
              <span className={`text-[11px] font-semibold ${edgeColor(play.totalEdge)}`}>
                {play.totalEdge > 0 ? "↑ Over" : "↓ Under"} O{play.total} · {Math.abs(play.totalEdge).toFixed(1)}pp edge
              </span>
            )}
            {play.spreadEdge !== null && play.spread !== null && (
              <span className={`text-[11px] font-semibold ${edgeColor(play.spreadEdge)}`}>
                {play.favorite} -{play.spread} · {Math.abs(play.spreadEdge).toFixed(1)}pp
              </span>
            )}
          </div>
        )}
      </button>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="divide-y divide-border/40">

          {/* 1H Projection — shown whenever in H1 and we have a proj1HTotal */}
          {isH1 && play.proj1HTotal !== null && (
            <div className="p-4 space-y-2">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <span className="text-blue-400">1H</span> Projection
              </p>
              <div className="bg-secondary/40 rounded-lg p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Proj 1H total: <span className="text-foreground font-semibold text-sm">{play.proj1HTotal}</span>
                    </p>
                    {play.h1TotalLine !== null && (
                      <p className="text-xs text-foreground">
                        Line: <span className="font-semibold">{play.h1TotalLine}</span>
                        <span className="text-muted-foreground ml-2 text-[10px]">
                          {play.h1TotalLine === Math.round((play.total ?? 0) * 0.47 * 2) / 2 ? "(est)" : "(live)"}
                        </span>
                      </p>
                    )}
                    {play.total1HEdge !== null && (
                      <p className={`text-xs font-semibold ${edgeColor(play.total1HEdge)}`}>
                        {play.total1HEdge > 0
                          ? <TrendingUp className="inline w-3 h-3 mr-0.5" />
                          : <TrendingDown className="inline w-3 h-3 mr-0.5" />
                        }
                        {play.total1HEdge > 0 ? "Over" : "Under"} edge: {Math.abs(play.total1HEdge).toFixed(1)}pp
                      </p>
                    )}
                    {probBar(play.over1HProb, false, true)}
                    {play.h1TotalLine === null && (
                      <p className="text-[10px] text-muted-foreground/50 italic">No 1H line — using proj as reference</p>
                    )}
                  </div>
                  {onAddToParlay && effective1HLine !== null && (
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <button
                        data-testid={`ncaab-parlay-1h-over-${play.gameId}`}
                        onClick={(e) => { e.stopPropagation(); addPick("over", effective1HLine, effective1HProb, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — 1H Total`); }}
                        className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                      >
                        <Plus className="w-2.5 h-2.5" /> Over {effective1HLine}{h1LineIsProj ? " (proj)" : ""}
                      </button>
                      <button
                        data-testid={`ncaab-parlay-1h-under-${play.gameId}`}
                        onClick={(e) => { e.stopPropagation(); addPick("under", effective1HLine, 100 - effective1HProb, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — 1H Total`); }}
                        className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 transition-colors"
                      >
                        <Plus className="w-2.5 h-2.5" /> Under {effective1HLine}{h1LineIsProj ? " (proj)" : ""}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Full Game Projection — shown whenever we have projectedTotal (H1, Halftime, H2) */}
          {play.projectedTotal !== null && (
            <div className="p-4 space-y-2">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Full Game Projection
              </p>
              <div className="bg-secondary/40 rounded-lg p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Proj total: <span className="text-foreground font-semibold text-sm">{play.projectedTotal.toFixed(1)}</span>
                    </p>
                    {play.total !== null && (
                      <p className="text-xs text-foreground">Line: <span className="font-semibold">{play.total}</span></p>
                    )}
                    {play.totalEdge !== null && (
                      <p className={`text-xs font-semibold ${edgeColor(play.totalEdge)}`}>
                        {play.totalEdge > 0
                          ? <TrendingUp className="inline w-3 h-3 mr-0.5" />
                          : <TrendingDown className="inline w-3 h-3 mr-0.5" />
                        }
                        {play.totalEdge > 0 ? "Over" : "Under"} edge: {Math.abs(play.totalEdge).toFixed(1)}pp
                      </p>
                    )}
                    {probBar(play.overProb, false, true)}
                    {play.total === null && (
                      <p className="text-[10px] text-muted-foreground/50 italic">No line — using proj as reference</p>
                    )}
                  </div>
                  {onAddToParlay && effectiveFGLine !== null && (
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <button
                        data-testid={`ncaab-parlay-over-${play.gameId}`}
                        onClick={(e) => { e.stopPropagation(); addPick("over", effectiveFGLine, effectiveFGProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — Total`); }}
                        className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                      >
                        <Plus className="w-2.5 h-2.5" /> Over {effectiveFGLine}{fgLineIsProj ? " (proj)" : ""}
                      </button>
                      <button
                        data-testid={`ncaab-parlay-under-${play.gameId}`}
                        onClick={(e) => { e.stopPropagation(); addPick("under", effectiveFGLine, 100 - effectiveFGProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — Total`); }}
                        className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 transition-colors"
                      >
                        <Plus className="w-2.5 h-2.5" /> Under {effectiveFGLine}{fgLineIsProj ? " (proj)" : ""}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Team Totals Lean */}
          {(play.homeProjected !== null || play.awayProjected !== null) && (
            <div className="p-4 space-y-2">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Team Totals Lean</p>
              <div className="bg-secondary/40 rounded-lg p-3">
                {teamLeanBar(play.homeProjected, play.awayProjected, play.homeTeamAbbr, play.awayTeamAbbr)}
              </div>
            </div>
          )}

          {/* Spread / Projected Margin — show if we have a spread line OR a projected margin */}
          {(play.spread !== null || play.projectedMargin !== null) && (
            <div className="p-4 space-y-2">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                {isH1 ? "Projected 1H Margin" : play.spread !== null ? "Spread" : "Projected Margin"}
              </p>
              <div className="bg-secondary/40 rounded-lg p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 space-y-1">
                    {play.spread !== null && !isH1 && (
                      <p className="text-xs text-foreground">
                        <span className="font-semibold">{play.favorite}</span>
                        <span className="text-muted-foreground ml-1">-{play.spread}</span>
                      </p>
                    )}
                    {play.projectedMargin !== null && (
                      <p className="text-xs text-foreground font-medium">
                        {play.projectedMargin > 0
                          ? `${play.homeTeamAbbr} projected to lead by ${play.projectedMargin.toFixed(1)}`
                          : play.projectedMargin < 0
                            ? `${play.awayTeamAbbr} projected to lead by ${Math.abs(play.projectedMargin).toFixed(1)}`
                            : "Pick 'em"}
                      </p>
                    )}
                    {play.spread === null && play.projectedMargin !== null && (
                      <p className="text-[10px] text-muted-foreground/50 italic">
                        {isH1 ? "No 1H spread line — margin only" : "No spread line available"}
                      </p>
                    )}
                    {play.spreadEdge !== null && !isH1 && (
                      <p className={`text-xs font-semibold ${edgeColor(play.spreadEdge)}`}>
                        {play.spreadEdge > 0
                          ? <TrendingUp className="inline w-3 h-3 mr-0.5" />
                          : <TrendingDown className="inline w-3 h-3 mr-0.5" />
                        }
                        Edge: {play.spreadEdge > 0 ? "+" : ""}{play.spreadEdge}pp
                      </p>
                    )}
                    {probBar(play.spreadProb, false, true)}
                  </div>
                  {onAddToParlay && play.spreadProb !== null && play.spread !== null && !isH1 && (
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <button
                        data-testid={`ncaab-parlay-spread-fav-${play.gameId}`}
                        onClick={(e) => { e.stopPropagation(); addPick("over", play.spread!, play.spreadProb!, "ncaab_spread", `${play.favorite} -${play.spread}`); }}
                        className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 transition-colors"
                      >
                        <Plus className="w-2.5 h-2.5" /> {play.favorite?.split(" ").slice(-1)[0]} -{play.spread}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Book Lines */}
          {play.bookLines.length > 0 && (
            <div className="px-4 py-3">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Book Lines</p>
              <div className="flex gap-2 flex-wrap">
                {play.bookLines.map(bl => (
                  <div key={bl.book} className="bg-secondary border border-border/60 rounded px-2 py-1 text-[10px] space-y-0.5">
                    <span className="font-bold text-foreground">{BOOK_LABELS[bl.book] ?? bl.book}</span>
                    {bl.spread !== null && <span className="text-muted-foreground ml-1">-{bl.spread}</span>}
                    {bl.total !== null && <span className="text-muted-foreground ml-1">O{bl.total}</span>}
                    {bl.h1Total !== null && (
                      <div className="text-blue-400/80">1H O{bl.h1Total}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Handle + volatility */}
          <div className="px-4 py-3 space-y-1">
            {play.handleSignal.signal !== "unavailable" && (
              <p className={`text-[10px] ${play.handleSignal.color}`}>
                <span className="font-semibold">Handle: </span>{play.handleSignal.label}
              </p>
            )}
          </div>

          {/* Volatility footer */}
          {play.volatility !== null && (
            <p className="text-[10px] text-muted-foreground/40 px-4 pb-3">
              Volatility: {play.volatility}{play.volatilityBonus > 0 && ` (+${play.volatilityBonus} bonus)`}
            </p>
          )}
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
}

export function NCAABAdminTab({ onAddToParlay }: NCAABAdminTabProps) {
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
  const hasPlays       = plays.length > 0;

  return (
    <div className="space-y-4">
      {/* Admin banner */}
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="text-yellow-400 text-base">🏀</span>
          <div>
            <p className="text-sm font-semibold text-yellow-400">NCAAB Live Analytics — Admin Only</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              ESPN scoreboard + box scores + The Odds API (basketball_ncaab). Auto-refreshes every 60 seconds.
              Tap any game card to expand probabilities. Invisible to non-admin users.
            </p>
          </div>
        </div>
        <button
          data-testid="ncaab-refresh"
          onClick={() => { playsQuery.refetch(); gamesQuery.refetch(); }}
          disabled={loading}
          className="flex-shrink-0 p-1.5 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50"
          title="Refresh now"
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

      {/* Live plays */}
      {!loading && hasPlays && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <p className="text-sm font-semibold text-foreground">
              {plays.length} Live {plays.length === 1 ? "Game" : "Games"} — Computed Plays
            </p>
          </div>
          {plays.map(p => (
            <NCAABGameCard key={p.gameId} play={p} onAddToParlay={onAddToParlay} />
          ))}
        </div>
      )}

      {/* No live games */}
      {!loading && !hasPlays && !error && (
        <div className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
          <Clock className="w-8 h-8 text-muted-foreground mx-auto" />
          <p className="text-sm font-semibold text-foreground">No Live NCAAB Games Right Now</p>
          <p className="text-xs text-muted-foreground">
            The model will activate automatically when games go live. Check back during game time.
          </p>
        </div>
      )}

      {/* All-games scoreboard */}
      {!loading && games.length > 0 && (
        <div className="space-y-3">
          {liveGames.length > 0 && scheduledGames.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-2">Also Scheduled Today</p>
              <NCAABAllGamesGrid games={scheduledGames} />
            </div>
          )}
          {liveGames.length === 0 && scheduledGames.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-2">Today's Slate</p>
              <NCAABAllGamesGrid games={scheduledGames} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
