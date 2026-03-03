import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, Clock, TrendingUp, Plus, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import type { ParlayPickInput } from "@shared/schema";

interface BookLine {
  book: string;
  name: string;
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
  seasonExpectedTotal?: number;
  seasonExpectedMargin?: number;
  homePPG?: number;
  awayPPG?: number;
  homeTempo?: number;
  awayTempo?: number;
  homeOE?: number;
  awayOE?: number;
  homeDE?: number;
  awayDE?: number;
  expectedPoss?: number;
  homeThreePARate?: number;
  awayThreePARate?: number;
  homeOverProb?: number | null;
  awayOverProb?: number | null;
  homeInjuries?: string[];
  awayInjuries?: string[];
  espnHomeWinPct?: number | null;
  espnAwayWinPct?: number | null;
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

const BOOK_DISPLAY: Record<string, string> = {
  fanduel:      "FanDuel",
  draftkings:   "DraftKings",
  betmgm:       "BetMGM",
  betrivers:    "BetRivers",
  hardrockbet:  "Hard Rock",
  bet365:       "Bet365",
  caesars:      "Caesars",
  pointsbet:    "PointsBet",
  espnbet:      "ESPN Bet",
  betus:        "BetUS",
  mybookieag:   "MyBookie",
  lowvig:       "LowVig",
  betonlineag:  "BetOnline",
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
  const isOver = label === "over" || label === "cover" || (label === undefined && pct >= 50);
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
  const displayLine = `${line}${lineIsProj ? "*" : ""}`;
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
            className="flex items-center justify-center gap-1.5 text-sm font-bold px-3 py-3 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 active:scale-95 transition-all"
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
            className="flex items-center justify-center gap-1.5 text-sm font-bold px-3 py-3 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 active:scale-95 transition-all"
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
  bookKey?: string,
) {
  return function addPick(
    direction: "over" | "under",
    lineVal: number,
    prob: number,
    statType: string,
    label: string,
  ) {
    if (!onAddToParlay) return;
    const sportsbook = bookKey ?? play.bookLines[0]?.book ?? "fanduel";
    onAddToParlay({
      playerId: 0,
      playerName: label,
      playerTeam: "NCAAB",
      statType,
      line: lineVal,
      probability: prob,
      betDirection: direction,
      sportsbook,
      gameId: play.gameId,
      oddsAmerican: probToAmericanOdds(prob),
    });
  };
}

function NCAABGameCard({ play, onAddToParlay }: { play: NCAABPlay; onAddToParlay?: (pick: ParlayPickInput) => void }) {
  const [showDetails, setShowDetails] = useState(false);
  const [preferredBook, setPreferredBook] = useState<string>(() => {
    try { return localStorage.getItem("ncaab_preferred_book") ?? ""; } catch { return ""; }
  });

  const addPick = makeAddPick(onAddToParlay, play);

  const windowClass = WINDOW_COLORS[play.bettingWindow];
  const hasWindow = play.bettingWindow !== "NONE" && windowClass;
  const isH1 = play.half === 1;
  const halfLabel = play.half === 1 ? "H1" : play.half === 2 ? "H2" : "OT";

  const fgLine   = play.total ?? (play.projectedTotal !== null ? Math.round((play.projectedTotal) * 2) / 2 : null);
  const fgIsProj = play.total === null;
  const fgProb   = play.overProb ?? 50;

  const h1Line   = play.h1TotalLine ?? (play.proj1HTotal !== null ? Math.round(play.proj1HTotal * 2) / 2 : null);
  const h1IsProj = play.h1TotalLine === null;
  const h1Prob   = play.over1HProb ?? 50;

  const spLine  = play.spread !== null ? -play.spread : null;
  const spProb  = play.spreadProb ?? null;

  const modelSpreadFav = (play.projectedMargin ?? 0) >= 0 ? play.homeTeamAbbr : play.awayTeamAbbr;
  const modelSpreadLine = play.projectedMargin !== null ? Math.round(Math.abs(play.projectedMargin) * 2) / 2 : null;
  const showModelSpread = spLine === null && play.spreadProb !== null && modelSpreadLine !== null;

  const clv = play.total !== null && play.projectedTotal !== null
    ? Math.round((play.projectedTotal - play.total) * 10) / 10
    : null;
  const showClv = clv !== null && Math.abs(clv) >= 0.5;

  const homeOverProb = play.homeOverProb ?? null;
  const awayOverProb = play.awayOverProb ?? null;

  // ── Best pick recommendation ─────────────────────────────────────────────
  type BestPlay = {
    label: string;
    prob: number;
    edge: number;
    direction: "over" | "under" | "cover";
    line: number | null;
    explanation: string;
  };
  let bestPlay: BestPlay | null = null;

  const candidates: BestPlay[] = [];

  if (fgLine !== null && play.overProb !== null) {
    const overEdge = play.overProb - 50;
    const underEdge = 50 - play.overProb;
    if (overEdge >= 8) {
      const delta = play.projectedTotal !== null && play.total !== null
        ? `+${Math.abs(Math.round((play.projectedTotal - play.total) * 10) / 10)} pts over book`
        : play.projectedTotal !== null ? `projects ${play.projectedTotal} pts` : "";
      candidates.push({
        label: `OVER ${fgLine}${fgIsProj ? "*" : ""}`,
        prob: play.overProb,
        edge: overEdge,
        direction: "over",
        line: typeof fgLine === "number" ? fgLine : null,
        explanation: delta
          ? `Model projects ${play.projectedTotal} pts (${delta}). ${play.overProb.toFixed(0)}% confidence.`
          : `No book line — model baseline is ${play.seasonExpectedTotal ?? "—"} pts. ${play.overProb.toFixed(0)}% confidence.`,
      });
    } else if (underEdge >= 8) {
      const delta = play.projectedTotal !== null && play.total !== null
        ? `${Math.abs(Math.round((play.projectedTotal - play.total) * 10) / 10)} pts under book`
        : play.projectedTotal !== null ? `projects ${play.projectedTotal} pts` : "";
      candidates.push({
        label: `UNDER ${fgLine}${fgIsProj ? "*" : ""}`,
        prob: 100 - play.overProb,
        edge: underEdge,
        direction: "under",
        line: typeof fgLine === "number" ? fgLine : null,
        explanation: delta
          ? `Model projects ${play.projectedTotal} pts (${delta}). ${(100 - play.overProb).toFixed(0)}% confidence.`
          : `No book line — model projects total under baseline. ${(100 - play.overProb).toFixed(0)}% confidence.`,
      });
    }
  }

  if (play.spreadProb !== null) {
    const coverEdge = Math.abs(play.spreadProb - 50);
    if (coverEdge >= 8) {
      const coverTeam = play.spreadProb >= 50 ? play.favorite || play.homeTeamAbbr : (play.spreadProb < 50 ? play.awayTeamAbbr : play.homeTeamAbbr);
      const marginStr = play.projectedMargin !== null ? `${Math.abs(play.projectedMargin).toFixed(1)}-pt model edge` : "";
      candidates.push({
        label: `${coverTeam} COVERS`,
        prob: coverEdge + 50,
        edge: coverEdge,
        direction: "cover",
        line: spLine,
        explanation: `${marginStr ? marginStr + ". " : ""}${(coverEdge + 50).toFixed(0)}% cover probability.`,
      });
    }
  }

  if (candidates.length > 0) {
    bestPlay = candidates.sort((a, b) => b.edge - a.edge)[0];
  }

  const isOver = bestPlay?.direction === "over";
  const isUnder = bestPlay?.direction === "under";

  const homeInjuries = play.homeInjuries ?? [];
  const awayInjuries = play.awayInjuries ?? [];
  const hasInjuries = homeInjuries.length > 0 || awayInjuries.length > 0;

  const selectBook = (bookKey: string) => {
    setPreferredBook(bookKey);
    try { localStorage.setItem("ncaab_preferred_book", bookKey); } catch { /* ignore */ }
  };

  return (
    <div
      data-testid={`ncaab-card-${play.gameId}`}
      className="bg-card border border-border rounded-xl overflow-hidden"
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="px-4 pt-4 pb-3 border-b border-border/40">
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          {hasWindow && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${windowClass}`}>
              {play.bettingWindow === "1H_WINDOW" ? "1H ⏱" : play.bettingWindow === "HALFTIME" ? "HT ⏱" : "2H ⏱"}
            </span>
          )}
          {play.desperation3s && (
            <span className="text-[10px] text-orange-400 bg-orange-500/10 border border-orange-500/20 px-1.5 py-0.5 rounded-full">⚠ Desp. 3s</span>
          )}
          {play.intentionalFouling && (
            <span className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-1.5 py-0.5 rounded-full">⚑ Fouling</span>
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

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="p-4 space-y-5">

        {/* MODEL SAYS banner */}
        {bestPlay && play.bettingWindow !== "NONE" && (
          <div className={`rounded-lg px-3 py-3 border flex items-center gap-3 ${
            isOver
              ? "bg-emerald-500/10 border-emerald-500/30"
              : isUnder
              ? "bg-rose-500/10 border-rose-500/30"
              : "bg-blue-500/10 border-blue-500/30"
          }`}>
            <TrendingUp className={`w-4 h-4 shrink-0 ${isOver ? "text-emerald-400" : isUnder ? "text-rose-400" : "text-blue-400"}`} />
            <div className="flex-1 min-w-0">
              <div className={`text-xs font-bold ${isOver ? "text-emerald-300" : isUnder ? "text-rose-300" : "text-blue-300"}`}>
                MODEL SAYS: {bestPlay.label}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
                {bestPlay.explanation}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className={`text-xl font-black tabular-nums ${isOver ? "text-emerald-400" : isUnder ? "text-rose-400" : "text-blue-400"}`}>
                {bestPlay.prob.toFixed(0)}%
              </div>
              <div className="text-[9px] text-muted-foreground">confidence</div>
            </div>
          </div>
        )}

        {/* Injury warning */}
        {hasInjuries && (
          <div className="flex items-start gap-2 bg-yellow-500/5 border border-yellow-500/20 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 shrink-0 mt-0.5" />
            <div className="text-[10px] text-yellow-300/80 leading-relaxed">
              {awayInjuries.length > 0 && (
                <span>{play.awayTeamAbbr} missing: {awayInjuries.slice(0, 2).join(", ")}{awayInjuries.length > 2 ? ` +${awayInjuries.length - 2}` : ""} · </span>
              )}
              {homeInjuries.length > 0 && (
                <span>{play.homeTeamAbbr} missing: {homeInjuries.slice(0, 2).join(", ")}{homeInjuries.length > 2 ? ` +${homeInjuries.length - 2}` : ""}</span>
              )}
              <span className="text-yellow-400/60"> · Scoring reduced in model</span>
            </div>
          </div>
        )}

        {/* 1H Total */}
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

        {/* Full Game Total with CLV badge */}
        {fgLine !== null && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Game Total O/U</span>
              <div className="flex items-center gap-2">
                {showClv && (
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${clv! > 0 ? "text-emerald-400 bg-emerald-500/10" : "text-rose-400 bg-rose-500/10"}`}>
                    CLV {clv! > 0 ? "+" : ""}{clv}
                  </span>
                )}
                <span className="text-sm font-bold text-foreground tabular-nums">{fgLine}{fgIsProj ? "*" : ""}</span>
              </div>
            </div>
            <ProbBar prob={fgProb} label="over" />
            <div className="text-[10px] text-muted-foreground mt-1 mb-2">
              {play.projectedTotal !== null && play.total !== null
                ? `Proj ${play.projectedTotal} pts vs book ${play.total} · ${play.totalEdge !== null && play.totalEdge > 0 ? "+" : ""}${play.totalEdge ?? "—"}pp edge`
                : play.projectedTotal !== null
                ? `Proj ${play.projectedTotal} pts · No book line — using ${play.seasonExpectedTotal ?? "—"} pts season baseline`
                : "Calculating…"}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {onAddToParlay && (
                <button
                  onClick={() => addPick("over", fgLine as number, fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — O${fgLine}${fgIsProj ? "*" : ""}`)}
                  className="flex items-center justify-center gap-1.5 text-sm font-bold px-3 py-3 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 active:scale-95 transition-all"
                >
                  <Plus className="w-3 h-3" />
                  Over {fgLine}{fgIsProj ? "*" : ""} · {fgProb.toFixed(1)}%
                </button>
              )}
              {onAddToParlay && (
                <button
                  onClick={() => addPick("under", fgLine as number, 100 - fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} — U${fgLine}${fgIsProj ? "*" : ""}`)}
                  className="flex items-center justify-center gap-1.5 text-sm font-bold px-3 py-3 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 active:scale-95 transition-all"
                >
                  <Plus className="w-3 h-3" />
                  Under {fgLine}{fgIsProj ? "*" : ""} · {(100 - fgProb).toFixed(1)}%
                </button>
              )}
            </div>
          </div>
        )}

        {/* Book Spread */}
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

        {/* Model Spread (no book spread) */}
        {showModelSpread && (
          <BetRow
            label={`Model Spread — ${modelSpreadFav}`}
            line={modelSpreadLine!}
            lineIsProj={true}
            overProb={play.spreadProb!}
            onOver={onAddToParlay ? () => addPick("over", modelSpreadLine!, play.spreadProb!, "ncaab_spread", `${modelSpreadFav} -${modelSpreadLine}* Cover (Model)`) : undefined}
            singleSide
            singleLabel={`${modelSpreadFav} -${modelSpreadLine}* (Model)`}
          />
        )}

        {/* Away Team Total */}
        {play.awayProjected !== null && awayOverProb !== null && (
          <BetRow
            label={`${play.awayTeamAbbr} Team Total`}
            line={Math.round(play.awayProjected)}
            lineIsProj={true}
            overProb={awayOverProb}
            onOver={onAddToParlay ? () => addPick("over", Math.round(play.awayProjected!), awayOverProb, "ncaab_team_total", `${play.awayTeamAbbr} Team Over ${Math.round(play.awayProjected!)}*`) : undefined}
            onUnder={onAddToParlay ? () => addPick("under", Math.round(play.awayProjected!), 100 - awayOverProb, "ncaab_team_total", `${play.awayTeamAbbr} Team Under ${Math.round(play.awayProjected!)}*`) : undefined}
          />
        )}

        {/* Home Team Total */}
        {play.homeProjected !== null && homeOverProb !== null && (
          <BetRow
            label={`${play.homeTeamAbbr} Team Total`}
            line={Math.round(play.homeProjected)}
            lineIsProj={true}
            overProb={homeOverProb}
            onOver={onAddToParlay ? () => addPick("over", Math.round(play.homeProjected!), homeOverProb, "ncaab_team_total", `${play.homeTeamAbbr} Team Over ${Math.round(play.homeProjected!)}*`) : undefined}
            onUnder={onAddToParlay ? () => addPick("under", Math.round(play.homeProjected!), 100 - homeOverProb, "ncaab_team_total", `${play.homeTeamAbbr} Team Under ${Math.round(play.homeProjected!)}*`) : undefined}
          />
        )}
      </div>

      {/* ── Sportsbook Line Picker ─────────────────────────────────────── */}
      <div className="px-4 pb-4 border-t border-border/30 pt-3 space-y-2">
        {play.bookLines.length > 0 ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Choose Your Book</span>
              {preferredBook && play.bookLines.find(b => b.book === preferredBook) && (
                <span className="text-[10px] text-primary font-semibold">
                  {BOOK_DISPLAY[preferredBook] ?? preferredBook} preferred
                </span>
              )}
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
              {play.bookLines.map(bl => {
                const isPreferred = bl.book === preferredBook;
                const bookAddPick = makeAddPick(onAddToParlay, play, bl.book);
                return (
                  <div
                    key={bl.book}
                    onClick={() => selectBook(bl.book)}
                    className={`shrink-0 rounded-lg border px-3 py-2 cursor-pointer transition-all min-w-[110px] space-y-1.5 ${
                      isPreferred
                        ? "border-primary/60 bg-primary/10"
                        : "border-border/50 bg-secondary/40 hover:border-border"
                    }`}
                  >
                    <div className={`text-xs font-bold ${isPreferred ? "text-primary" : "text-foreground"}`}>
                      {bl.name}
                    </div>
                    {bl.total !== null && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); selectBook(bl.book); bookAddPick("over", bl.total!, fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} O${bl.total} (${bl.name})`); }}
                          className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 px-1.5 py-0.5 rounded transition-colors"
                        >
                          O{bl.total}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); selectBook(bl.book); bookAddPick("under", bl.total!, 100 - fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} U${bl.total} (${bl.name})`); }}
                          className="text-[10px] font-semibold text-rose-400 hover:text-rose-300 bg-rose-500/10 px-1.5 py-0.5 rounded transition-colors"
                        >
                          U{bl.total}
                        </button>
                      </div>
                    )}
                    {bl.spread !== null && bl.favorite && (
                      <button
                        onClick={(e) => { e.stopPropagation(); selectBook(bl.book); if (spProb !== null) bookAddPick("over", bl.spread!, spProb, "ncaab_spread", `${bl.favorite} -${bl.spread} (${bl.name})`); }}
                        className="text-[10px] font-semibold text-blue-400 hover:text-blue-300 bg-blue-500/10 px-1.5 py-0.5 rounded transition-colors block"
                      >
                        {bl.favorite} -{bl.spread}
                      </button>
                    )}
                    {bl.h1Total !== null && (
                      <div className="text-[9px] text-muted-foreground">1H: {bl.h1Total}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="text-[10px] text-muted-foreground italic">No live book lines — model projections used as reference</p>
        )}

        {/* ESPN Win Probability */}
        {(play.espnHomeWinPct !== null && play.espnHomeWinPct !== undefined) && (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">ESPN Win Prob:</span>
            <span className="text-[10px] text-foreground font-semibold">{play.homeTeamAbbr} {play.espnHomeWinPct?.toFixed(1)}%</span>
            <span className="text-[10px] text-muted-foreground">·</span>
            <span className="text-[10px] text-foreground font-semibold">{play.awayTeamAbbr} {play.espnAwayWinPct?.toFixed(1)}%</span>
          </div>
        )}

        {/* Model Details toggle */}
        <button
          onClick={() => setShowDetails(p => !p)}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors pt-1"
        >
          {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          Model details
        </button>

        {showDetails && (
          <div className="bg-secondary/30 rounded-lg px-3 py-2.5 space-y-1.5 text-[10px]">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
              <div><span className="text-foreground font-semibold">{play.homeTeamAbbr} OE:</span> {play.homeOE ?? "—"}</div>
              <div><span className="text-foreground font-semibold">{play.awayTeamAbbr} OE:</span> {play.awayOE ?? "—"}</div>
              <div><span className="text-foreground font-semibold">{play.homeTeamAbbr} DE:</span> {play.homeDE ?? "—"}</div>
              <div><span className="text-foreground font-semibold">{play.awayTeamAbbr} DE:</span> {play.awayDE ?? "—"}</div>
              <div><span className="text-foreground font-semibold">{play.homeTeamAbbr} Tempo:</span> {play.homeTempo ?? "—"} poss</div>
              <div><span className="text-foreground font-semibold">{play.awayTeamAbbr} Tempo:</span> {play.awayTempo ?? "—"} poss</div>
              <div><span className="text-foreground font-semibold">Exp. Poss:</span> {play.expectedPoss ?? "—"}</div>
              <div><span className="text-foreground font-semibold">Season Exp:</span> {play.seasonExpectedTotal ?? "—"} pts</div>
              {(play.homeThreePARate ?? 0) > 37 && (
                <div className="col-span-2 text-orange-400/80">{play.homeTeamAbbr} 3PA rate: {play.homeThreePARate}%  ← High variance</div>
              )}
              {(play.awayThreePARate ?? 0) > 37 && (
                <div className="col-span-2 text-orange-400/80">{play.awayTeamAbbr} 3PA rate: {play.awayThreePARate}%  ← High variance</div>
              )}
            </div>
            <div className="text-muted-foreground/60 mt-1">OE = offensive efficiency per 100 poss · DE = defensive efficiency · Tempo = possessions/game</div>
          </div>
        )}
      </div>
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
        <div>
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
          <p className="text-[10px] text-muted-foreground mt-1 pl-1">Possession model · ESPN team stats · KenPom-style efficiency</p>
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

      {/* ── LIVE sub-tab ────────────────────────────────────────────────── */}
      {ncaabSubTab === "live" && (
        <div className="space-y-6">
          {loading && (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading NCAAB data…</span>
            </div>
          )}

          {!loading && plays.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Clock className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">No live NCAAB games right now</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Check back during game time</p>
            </div>
          )}

          {!loading && plays.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-3">{plays.length} live game{plays.length !== 1 ? "s" : ""} with betting data</p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {plays.map(play => (
                  <NCAABGameCard
                    key={play.gameId}
                    play={play}
                    onAddToParlay={onAddToParlay}
                  />
                ))}
              </div>
            </div>
          )}

          {!loading && scheduledGames.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Today's NCAAB Slate</p>
              <NCAABAllGamesGrid games={scheduledGames} />
            </div>
          )}
        </div>
      )}

      {/* ── 2H PLAYS sub-tab ────────────────────────────────────────────── */}
      {ncaabSubTab === "halftime" && (
        <div className="space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span className="text-sm">Calculating 2H plays…</span>
            </div>
          )}

          {!loading && halftimePlays.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Clock className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">No games at halftime right now</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Check back when games reach halftime</p>
            </div>
          )}

          {!loading && halftimePlays.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-3">{halftimePlays.length} halftime game{halftimePlays.length !== 1 ? "s" : ""}</p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {halftimePlays.map(play => (
                  <NCAABGameCard
                    key={play.gameId}
                    play={play}
                    onAddToParlay={onAddToParlay}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
