import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, Clock, TrendingUp, ChevronDown, ChevronUp, Plus } from "lucide-react";
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
  homeGameTotalLine: number | null;
  awayGameTotalLine: number | null;
  home1HTotalLine: number | null;
  away1HTotalLine: number | null;
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

function CircleProb({ prob, size = 60 }: { prob: number; size?: number }) {
  const pct = Math.round(Math.min(100, Math.max(0, prob)));
  const r = 22;
  const circ = 2 * Math.PI * r;
  const filled = (pct / 100) * circ;
  const color = pct >= 62 ? "#22c55e" : pct <= 38 ? "#ef4444" : pct >= 55 ? "#a3e635" : "#94a3b8";
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 56 56" style={{ width: size, height: size, transform: "rotate(-90deg)" }}>
        <circle cx="28" cy="28" r={r} fill="none" stroke="hsl(var(--secondary))" strokeWidth="7" />
        <circle cx="28" cy="28" r={r} fill="none" stroke={color} strokeWidth="7"
          strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[11px] font-black" style={{ color }}>{pct}%</span>
      </div>
    </div>
  );
}

function MarketSection({
  title, line, lineIsProj, proj, edge, prob, gameId, testPrefix,
  onOver, onUnder, overLabel, underLabel,
}: {
  title: string; line: number | null; lineIsProj?: boolean;
  proj?: number | null; edge?: number | null; prob: number | null;
  gameId: string; testPrefix: string;
  onOver?: () => void; onUnder?: () => void;
  overLabel?: string; underLabel?: string;
}) {
  if (line === null && prob === null) return null;
  const overPct  = prob ?? 50;
  const underPct = 100 - overPct;
  return (
    <div className="p-4 space-y-3 border-b border-border/40">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider pt-0.5">{title}</p>
        <div className="text-right">
          {line !== null && (
            <span className="text-3xl font-black tabular-nums text-foreground leading-none">
              {line}{lineIsProj && <span className="text-base text-muted-foreground/60 ml-0.5">*</span>}
            </span>
          )}
          {proj !== null && proj !== undefined && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Proj <span className="text-foreground font-semibold">{typeof proj === "number" ? proj.toFixed(1) : proj}</span>
              {edge !== null && edge !== undefined && (
                <span className={`ml-2 font-semibold ${edgeColor(edge)}`}>
                  {edge > 0 ? "↑" : "↓"}{Math.abs(edge).toFixed(1)}pp
                </span>
              )}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {prob !== null && <CircleProb prob={overPct} size={60} />}
        <div className="flex-1 grid grid-cols-2 gap-2">
          {onOver && line !== null && (
            <button
              data-testid={`ncaab-parlay-${testPrefix}-over-${gameId}`}
              onClick={(e) => { e.stopPropagation(); onOver(); }}
              className="flex flex-col items-center py-2.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 transition-colors"
            >
              <span className="text-[9px] font-bold uppercase tracking-wide opacity-70">Over</span>
              <span className="text-lg font-black tabular-nums leading-tight">{overLabel ?? line}</span>
              {prob !== null && <span className="text-[10px] font-semibold text-emerald-400">{overPct.toFixed(1)}%</span>}
            </button>
          )}
          {onUnder && line !== null && (
            <button
              data-testid={`ncaab-parlay-${testPrefix}-under-${gameId}`}
              onClick={(e) => { e.stopPropagation(); onUnder(); }}
              className="flex flex-col items-center py-2.5 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 transition-colors"
            >
              <span className="text-[9px] font-bold uppercase tracking-wide opacity-70">Under</span>
              <span className="text-lg font-black tabular-nums leading-tight">{underLabel ?? line}</span>
              {prob !== null && <span className="text-[10px] font-semibold text-rose-400">{underPct.toFixed(1)}%</span>}
            </button>
          )}
        </div>
      </div>
      {lineIsProj && (
        <p className="text-[10px] text-muted-foreground/50 italic">* No live line — projection used as reference</p>
      )}
    </div>
  );
}

function SpreadSection({
  title, spread, favName, prob, edge, gameId, testPrefix, onCover,
}: {
  title: string; spread: number | null; favName: string;
  prob: number | null; edge?: number | null;
  gameId: string; testPrefix: string; onCover?: () => void;
}) {
  if (spread === null && favName === "") return null;
  const coverPct = prob ?? 50;
  return (
    <div className="p-4 space-y-3 border-b border-border/40">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider pt-0.5">{title}</p>
        <div className="text-right">
          {spread !== null && (
            <span className="text-3xl font-black tabular-nums text-foreground leading-none">-{spread}</span>
          )}
          {favName && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[160px]">{favName}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {prob !== null && <CircleProb prob={coverPct} size={60} />}
        <div className="flex-1">
          {onCover && spread !== null && (
            <button
              data-testid={`ncaab-parlay-${testPrefix}-cover-${gameId}`}
              onClick={(e) => { e.stopPropagation(); onCover(); }}
              className="w-full flex flex-col items-center py-2.5 rounded-lg bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 transition-colors"
            >
              <span className="text-[9px] font-bold uppercase tracking-wide opacity-70">Cover</span>
              <span className="text-base font-black leading-tight">{favName} -{spread}</span>
              {prob !== null && <span className="text-[10px] font-semibold">{coverPct.toFixed(1)}%</span>}
            </button>
          )}
          {!onCover && spread !== null && (
            <div className="bg-secondary/40 rounded-lg px-3 py-2 text-sm font-semibold text-foreground">
              {favName} <span className="text-primary">-{spread}</span>
            </div>
          )}
          {edge !== null && edge !== undefined && (
            <p className={`text-[10px] font-semibold mt-1.5 ${edgeColor(edge)}`}>
              Edge: {edge > 0 ? "+" : ""}{edge}pp
            </p>
          )}
        </div>
      </div>
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
        <div>

          {/* 1H Total */}
          {(isH1 && play.proj1HTotal !== null) || play.h1TotalLine !== null ? (
            <MarketSection
              title="1H Total"
              line={effective1HLine}
              lineIsProj={h1LineIsProj}
              proj={play.proj1HTotal}
              edge={play.total1HEdge}
              prob={play.over1HProb}
              gameId={play.gameId}
              testPrefix="1h"
              onOver={onAddToParlay && effective1HLine !== null ? () => addPick("over", effective1HLine!, effective1HProb, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — 1H Total`) : undefined}
              onUnder={onAddToParlay && effective1HLine !== null ? () => addPick("under", effective1HLine!, 100 - effective1HProb, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — 1H Total`) : undefined}
            />
          ) : null}

          {/* Full Game Total */}
          {play.projectedTotal !== null || play.total !== null ? (
            <MarketSection
              title="Full Game Total"
              line={effectiveFGLine}
              lineIsProj={fgLineIsProj}
              proj={play.projectedTotal}
              edge={play.totalEdge}
              prob={play.overProb}
              gameId={play.gameId}
              testPrefix="fg"
              onOver={onAddToParlay && effectiveFGLine !== null ? () => addPick("over", effectiveFGLine!, effectiveFGProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — Total`) : undefined}
              onUnder={onAddToParlay && effectiveFGLine !== null ? () => addPick("under", effectiveFGLine!, 100 - effectiveFGProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — Total`) : undefined}
            />
          ) : null}

          {/* 1H Spread — SGO live line */}
          {play.h1SpreadLine !== null && (
            <SpreadSection
              title="1H Spread"
              spread={play.h1SpreadLine}
              favName={play.h1Favorite}
              prob={null}
              gameId={play.gameId}
              testPrefix="1h-spread"
              onCover={onAddToParlay ? () => addPick("over", play.h1SpreadLine!, 60, "ncaab_1h_spread", `${play.h1Favorite} -${play.h1SpreadLine} (1H Cover)`) : undefined}
            />
          )}

          {/* Full Game Spread */}
          {(play.spread !== null || play.projectedMargin !== null) && !isH1 && (
            <SpreadSection
              title={play.spread !== null ? `Spread — ${play.favorite}` : "Projected Margin"}
              spread={play.spread}
              favName={play.spread !== null ? play.favorite : (play.projectedMargin !== null ? (play.projectedMargin > 0 ? play.homeTeamAbbr : play.awayTeamAbbr) : "")}
              prob={play.spreadProb}
              edge={play.spreadEdge}
              gameId={play.gameId}
              testPrefix="spread"
              onCover={onAddToParlay && play.spreadProb !== null && play.spread !== null ? () => addPick("over", play.spread!, play.spreadProb!, "ncaab_spread", `${play.favorite} -${play.spread}`) : undefined}
            />
          )}

          {/* Team Totals with market lines */}
          {(play.homeProjected !== null || play.awayProjected !== null || play.homeGameTotalLine !== null || play.awayGameTotalLine !== null) && (
            <div className="p-4 space-y-3 border-b border-border/40">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Team Totals</p>
              <div className="grid grid-cols-2 gap-3">
                {/* Away team */}
                <div className="bg-secondary/40 rounded-lg p-3 space-y-1">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase">{play.awayTeamAbbr}</p>
                  <p className="text-2xl font-black tabular-nums text-foreground leading-tight">
                    {play.awayProjected ?? "—"}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Proj</p>
                  {play.awayGameTotalLine !== null && (
                    <p className="text-[11px] text-foreground font-semibold mt-1">
                      FG O/U <span className="text-primary">{play.awayGameTotalLine}</span>
                    </p>
                  )}
                  {play.away1HTotalLine !== null && (
                    <p className="text-[11px] text-blue-400 font-semibold">
                      1H O/U <span>{play.away1HTotalLine}</span>
                    </p>
                  )}
                </div>
                {/* Home team */}
                <div className="bg-secondary/40 rounded-lg p-3 space-y-1">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase">{play.homeTeamAbbr}</p>
                  <p className="text-2xl font-black tabular-nums text-foreground leading-tight">
                    {play.homeProjected ?? "—"}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Proj</p>
                  {play.homeGameTotalLine !== null && (
                    <p className="text-[11px] text-foreground font-semibold mt-1">
                      FG O/U <span className="text-primary">{play.homeGameTotalLine}</span>
                    </p>
                  )}
                  {play.home1HTotalLine !== null && (
                    <p className="text-[11px] text-blue-400 font-semibold">
                      1H O/U <span>{play.home1HTotalLine}</span>
                    </p>
                  )}
                </div>
              </div>
              {/* Lean bar */}
              {play.homeProjected !== null && play.awayProjected !== null && (() => {
                const tot = play.homeProjected + play.awayProjected;
                if (tot <= 0) return null;
                const homePct = (play.homeProjected / tot) * 100;
                return (
                  <div className="h-2 bg-secondary rounded-full overflow-hidden flex mt-1">
                    <div className="h-full bg-blue-500 transition-all" style={{ width: `${100 - homePct}%` }} />
                    <div className="h-full bg-orange-400 transition-all" style={{ width: `${homePct}%` }} />
                  </div>
                );
              })()}
            </div>
          )}

          {/* Book Lines */}
          {play.bookLines.length > 0 && (
            <div className="px-4 py-3 border-b border-border/40">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Book Lines</p>
              <div className="flex gap-2 flex-wrap">
                {play.bookLines.map(bl => (
                  <div key={bl.book} className="bg-secondary border border-border/60 rounded-lg px-2.5 py-1.5 text-[10px] space-y-0.5">
                    <p className="font-bold text-foreground text-xs">{BOOK_LABELS[bl.book] ?? bl.book}</p>
                    {bl.spread !== null && <p className="text-muted-foreground">Spread -{bl.spread}</p>}
                    {bl.total !== null && <p className="text-muted-foreground">O/U {bl.total}</p>}
                    {bl.h1Total !== null && (
                      <p className="text-blue-400/80">1H O{bl.h1Total}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Handle signal + volatility footer */}
          <div className="px-4 py-2.5 space-y-1">
            {play.handleSignal.signal !== "unavailable" && (
              <p className={`text-[10px] ${play.handleSignal.color}`}>
                <span className="font-semibold">Handle: </span>{play.handleSignal.label}
              </p>
            )}
            {play.volatility !== null && (
              <p className="text-[10px] text-muted-foreground/40">
                Volatility: {play.volatility}{play.volatilityBonus > 0 && ` (+${play.volatilityBonus} bonus)`}
              </p>
            )}
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
        <div className="flex gap-1">
          <button
            data-testid="tab-ncaab-live"
            onClick={() => setNcaabSubTab("live")}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
              ncaabSubTab === "live"
                ? "bg-primary/20 text-primary border border-primary/40"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Live
          </button>
          <button
            data-testid="tab-ncaab-halftime"
            onClick={() => setNcaabSubTab("halftime")}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 ${
              ncaabSubTab === "halftime"
                ? "bg-primary/20 text-primary border border-primary/40"
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

      {/* ── Live sub-tab ───────────────────────────────────────────────────── */}
      {ncaabSubTab === "live" && !loading && (
        <>
          {hasPlays && (
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

          {!hasPlays && !error && (
            <div className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
              <Clock className="w-8 h-8 text-muted-foreground mx-auto" />
              <p className="text-sm font-semibold text-foreground">No Live NCAAB Games Right Now</p>
              <p className="text-xs text-muted-foreground">
                The model will activate automatically when games go live. Check back during game time.
              </p>
            </div>
          )}

          {games.length > 0 && (
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
        </>
      )}

      {/* ── 2H Plays sub-tab ───────────────────────────────────────────────── */}
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
              </div>
              {halftimePlays.map(play => {
                const spreadEdgeAbs = Math.abs(play.spreadEdge ?? 0);
                const totalEdgeAbs  = Math.abs(play.totalEdge ?? 0);
                const bestEdge = Math.max(spreadEdgeAbs, totalEdgeAbs);
                const edgePillColor = bestEdge >= 15
                  ? "text-green-400 bg-green-500/10 border-green-500/30"
                  : bestEdge >= 8
                  ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/30"
                  : "text-muted-foreground bg-secondary border-border";

                return (
                  <div key={play.gameId} data-testid={`ncaab-2h-card-${play.gameId}`} className="bg-card border border-border rounded-xl p-4 space-y-3">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Halftime</p>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-foreground">{play.awayTeamAbbr}</span>
                          <span className="text-lg font-black tabular-nums">{play.awayScore}</span>
                          <span className="text-xs text-muted-foreground">–</span>
                          <span className="text-lg font-black tabular-nums">{play.homeScore}</span>
                          <span className="text-sm font-bold text-foreground">{play.homeTeamAbbr}</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{play.awayTeam} @ {play.homeTeam}</p>
                      </div>
                      {bestEdge > 0 && (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${edgePillColor}`}>
                          +{bestEdge.toFixed(1)} edge
                        </span>
                      )}
                    </div>

                    {/* Spread */}
                    {play.spread !== null && play.spreadProb !== null && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Spread — {play.favorite} {play.spread > 0 ? "+" : ""}{play.spread}</span>
                          <span className={`font-semibold ${play.spreadProb >= 60 ? "text-green-400" : play.spreadProb <= 40 ? "text-red-400" : "text-foreground"}`}>
                            {play.spreadProb.toFixed(0)}% cover
                          </span>
                        </div>
                        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${play.spreadProb >= 60 ? "bg-green-500" : play.spreadProb <= 40 ? "bg-red-500" : "bg-primary"}`}
                            style={{ width: `${Math.min(100, play.spreadProb)}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* O/U */}
                    {play.total !== null && play.overProb !== null && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Total O/U — {play.total}</span>
                          <span className={`font-semibold ${play.overProb >= 60 ? "text-green-400" : play.overProb <= 40 ? "text-red-400" : "text-foreground"}`}>
                            {play.overProb.toFixed(0)}% over
                          </span>
                        </div>
                        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${play.overProb >= 60 ? "bg-green-500" : play.overProb <= 40 ? "bg-red-500" : "bg-primary"}`}
                            style={{ width: `${Math.min(100, play.overProb)}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Team Totals */}
                    {(play.awayProjected !== null || play.homeProjected !== null) && (
                      <div className="flex gap-3">
                        {play.awayProjected !== null && (
                          <div className="flex-1 bg-secondary/40 rounded-lg px-3 py-2 text-center">
                            <p className="text-[10px] text-muted-foreground">{play.awayTeamAbbr} Proj. Final</p>
                            <p className="text-sm font-bold text-foreground">{Math.round(play.awayProjected)}</p>
                          </div>
                        )}
                        {play.homeProjected !== null && (
                          <div className="flex-1 bg-secondary/40 rounded-lg px-3 py-2 text-center">
                            <p className="text-[10px] text-muted-foreground">{play.homeTeamAbbr} Proj. Final</p>
                            <p className="text-sm font-bold text-foreground">{Math.round(play.homeProjected)}</p>
                          </div>
                        )}
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
