import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, Clock, TrendingUp, Plus, ChevronDown, ChevronUp, AlertTriangle, Zap } from "lucide-react";
import type { ParlayPickInput } from "@shared/schema";

interface BookLine {
  book: string;
  name: string;
  homePoint: number | null;
  awayPoint: number | null;
  homeSpreadPrice: number | null;
  awaySpreadPrice: number | null;
  homeFavorite: boolean;
  total: number | null;
  overPrice: number | null;
  underPrice: number | null;
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

  homeSpreadLine: number | null;
  awaySpreadLine: number | null;
  total: number | null;
  overPrice: number | null;
  underPrice: number | null;
  bookLines: BookLine[];

  h1TotalLineModel: number | null;
  h1SpreadLine: number | null;
  h1SpreadProb: number | null;
  proj1HHome: number | null;
  proj1HAway: number | null;
  h1HomeOverProb: number | null;
  h1AwayOverProb: number | null;

  projectedTotal: number | null;
  projectedMargin: number | null;
  proj1HTotal: number | null;
  homeProjected: number | null;
  awayProjected: number | null;

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

function fmtOdds(price: number | null | undefined): string {
  if (price == null) return "";
  return price > 0 ? `+${price}` : `${price}`;
}

function fmtSpread(point: number | null): string {
  if (point === null) return "—";
  return point > 0 ? `+${point}` : `${point}`;
}

function ProbBar({ prob }: { prob: number }) {
  const pct = Math.min(100, Math.max(0, prob));
  const barColor = pct >= 58 ? "bg-emerald-500" : pct <= 42 ? "bg-rose-500" : "bg-primary/70";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-secondary rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SectionHeader({ label, badge, badgeColor }: { label: string; badge?: string; badgeColor?: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">{label}</span>
      {badge && (
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${badgeColor ?? "text-muted-foreground border-border/50 bg-secondary/50"}`}>
          {badge}
        </span>
      )}
      <div className="flex-1 h-px bg-border/30" />
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
  const isHT = play.bettingWindow === "HALFTIME";

  const fgProb   = play.overProb ?? 50;
  const spProb   = play.spreadProb ?? 50;
  const spDogProb = 100 - spProb;

  const hasApiLines = play.total !== null || play.homeSpreadLine !== null;

  const clv = play.total !== null && play.projectedTotal !== null
    ? Math.round((play.projectedTotal - play.total) * 10) / 10
    : null;
  const showClv = clv !== null && Math.abs(clv) >= 0.5;

  const homeInjuries = play.homeInjuries ?? [];
  const awayInjuries = play.awayInjuries ?? [];
  const hasInjuries = homeInjuries.length > 0 || awayInjuries.length > 0;

  const homeOverProb = play.homeOverProb ?? 50;
  const awayOverProb = play.awayOverProb ?? 50;

  const modelSpreadFav = (play.projectedMargin ?? 0) >= 0 ? play.homeTeamAbbr : play.awayTeamAbbr;
  const modelSpreadDog = (play.projectedMargin ?? 0) >= 0 ? play.awayTeamAbbr : play.homeTeamAbbr;
  const modelSpreadAbs = play.projectedMargin !== null ? Math.round(Math.abs(play.projectedMargin) * 2) / 2 : null;

  const selectBook = (bookKey: string) => {
    setPreferredBook(bookKey);
    try { localStorage.setItem("ncaab_preferred_book", bookKey); } catch { }
  };

  type BestPlay = { label: string; prob: number; edge: number; direction: "over" | "under" | "cover"; explanation: string };
  const candidates: BestPlay[] = [];

  if (play.total !== null && play.overProb !== null) {
    const overEdge = play.overProb - 50;
    const underEdge = 50 - play.overProb;
    if (overEdge >= 8 && play.projectedTotal !== null) {
      candidates.push({
        label: `OVER ${play.total}`,
        prob: play.overProb,
        edge: overEdge,
        direction: "over",
        explanation: `Model projects ${play.projectedTotal} pts vs book ${play.total} (+${Math.abs(Math.round((play.projectedTotal - play.total) * 10) / 10)} edge). ${play.overProb.toFixed(0)}% confidence.`,
      });
    } else if (underEdge >= 8 && play.projectedTotal !== null) {
      candidates.push({
        label: `UNDER ${play.total}`,
        prob: 100 - play.overProb,
        edge: underEdge,
        direction: "under",
        explanation: `Model projects ${play.projectedTotal} pts vs book ${play.total} (${Math.abs(Math.round((play.projectedTotal - play.total) * 10) / 10)} under). ${(100 - play.overProb).toFixed(0)}% confidence.`,
      });
    }
  }

  if (play.spreadProb !== null) {
    const coverEdge = Math.abs(play.spreadProb - 50);
    if (coverEdge >= 8) {
      const isHomeCover = play.spreadProb >= 50;
      const coverTeam = isHomeCover ? play.homeTeamAbbr : play.awayTeamAbbr;
      const coverLine = isHomeCover
        ? (play.homeSpreadLine !== null ? fmtSpread(play.homeSpreadLine) : "")
        : (play.awaySpreadLine !== null ? fmtSpread(play.awaySpreadLine) : "");
      candidates.push({
        label: `${coverTeam} ${coverLine} COVER`,
        prob: coverEdge + 50,
        edge: coverEdge,
        direction: "cover",
        explanation: `${play.projectedMargin !== null ? `Model edge: ${Math.abs(play.projectedMargin).toFixed(1)} pts. ` : ""}${(coverEdge + 50).toFixed(0)}% cover probability.`,
      });
    }
  }

  const bestPlay: BestPlay | null = candidates.length > 0 ? candidates.sort((a, b) => b.edge - a.edge)[0] : null;
  const isOver = bestPlay?.direction === "over";
  const isUnder = bestPlay?.direction === "under";

  return (
    <div
      data-testid={`ncaab-card-${play.gameId}`}
      className="bg-card border border-border rounded-xl overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-border/40">
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          {hasWindow && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${windowClass}`}>
              {play.bettingWindow === "1H_WINDOW" ? "1H ⏱" : play.bettingWindow === "HALFTIME" ? "HT ⏱" : "2H ⏱"}{" "}
              {play.bettingWindowLabel}
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
              <span className="text-sm font-bold text-muted-foreground">{play.awayTeamAbbr}</span>
              <span className="text-2xl font-black tabular-nums text-foreground">{play.awayScore}</span>
              <span className="text-muted-foreground text-sm">vs</span>
              <span className="text-2xl font-black tabular-nums text-foreground">{play.homeScore}</span>
              <span className="text-sm font-bold text-muted-foreground">{play.homeTeamAbbr}</span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">{play.awayTeam} @ {play.homeTeam}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs font-bold text-foreground">{halfLabel} · {play.clock || play.status}</p>
            {(play.espnHomeWinPct !== null && play.espnHomeWinPct !== undefined) && (
              <p className="text-[10px] text-muted-foreground mt-0.5">ESPN: {play.homeTeamAbbr} {play.espnHomeWinPct?.toFixed(0)}%</p>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 space-y-5">
        {/* MODEL SAYS banner */}
        {bestPlay && play.bettingWindow !== "NONE" && (
          <div className={`rounded-xl px-3 py-3 border flex items-center gap-3 ${
            isOver ? "bg-emerald-500/10 border-emerald-500/30"
            : isUnder ? "bg-rose-500/10 border-rose-500/30"
            : "bg-blue-500/10 border-blue-500/30"
          }`}>
            <TrendingUp className={`w-4 h-4 shrink-0 ${isOver ? "text-emerald-400" : isUnder ? "text-rose-400" : "text-blue-400"}`} />
            <div className="flex-1 min-w-0">
              <div className={`text-xs font-bold ${isOver ? "text-emerald-300" : isUnder ? "text-rose-300" : "text-blue-300"}`}>
                MODEL SAYS: {bestPlay.label}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{bestPlay.explanation}</div>
            </div>
            <div className="text-right shrink-0">
              <div className={`text-2xl font-black tabular-nums ${isOver ? "text-emerald-400" : isUnder ? "text-rose-400" : "text-blue-400"}`}>
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
                <span>{play.awayTeamAbbr}: {awayInjuries.slice(0, 2).join(", ")}{awayInjuries.length > 2 ? ` +${awayInjuries.length - 2}` : ""} · </span>
              )}
              {homeInjuries.length > 0 && (
                <span>{play.homeTeamAbbr}: {homeInjuries.slice(0, 2).join(", ")}{homeInjuries.length > 2 ? ` +${homeInjuries.length - 2}` : ""}</span>
              )}
              <span className="text-yellow-400/60"> · Scoring reduced in model</span>
            </div>
          </div>
        )}

        {/* ── SECTION A: FULL GAME LINES (Odds API) ── */}
        {hasApiLines && (
          <div>
            <SectionHeader label="Full Game Lines" badge="Live" badgeColor="text-emerald-400 bg-emerald-500/10 border-emerald-500/30" />

            {/* O/U */}
            {play.total !== null && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-foreground">Game Total O/U</span>
                  <div className="flex items-center gap-2">
                    {showClv && (
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${clv! > 0 ? "text-emerald-400 bg-emerald-500/10" : "text-rose-400 bg-rose-500/10"}`}>
                        CLV {clv! > 0 ? "+" : ""}{clv}
                      </span>
                    )}
                    <span className="text-sm font-black text-foreground tabular-nums">{play.total}</span>
                  </div>
                </div>
                <ProbBar prob={fgProb} />
                <div className="text-[10px] text-muted-foreground mt-1 mb-2">
                  {play.projectedTotal !== null
                    ? `Model: ${play.projectedTotal} pts · ${play.totalEdge !== null && play.totalEdge > 0 ? "+" : ""}${play.totalEdge ?? "—"}pp edge`
                    : "Calculating…"}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    data-testid={`ncaab-over-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("over", play.total!, fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} O${play.total}`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 active:scale-95 transition-all"
                  >
                    <span className="text-[10px] font-semibold text-emerald-400/70">{fmtOdds(play.overPrice)}</span>
                    <span className="text-base font-black">OVER {play.total}</span>
                    <span className="text-[11px] font-bold">{fgProb.toFixed(1)}%</span>
                  </button>
                  <button
                    data-testid={`ncaab-under-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("under", play.total!, 100 - fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} U${play.total}`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 active:scale-95 transition-all"
                  >
                    <span className="text-[10px] font-semibold text-rose-400/70">{fmtOdds(play.underPrice)}</span>
                    <span className="text-base font-black">UNDER {play.total}</span>
                    <span className="text-[11px] font-bold">{(100 - fgProb).toFixed(1)}%</span>
                  </button>
                </div>
              </div>
            )}

            {/* Full Game Spread — both sides */}
            {(play.homeSpreadLine !== null || play.awaySpreadLine !== null) && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-foreground">Game Spread</span>
                  <span className="text-[10px] text-muted-foreground">
                    {play.projectedMargin !== null
                      ? `Model: ${play.homeTeamAbbr} ${play.projectedMargin > 0 ? "+" : ""}${play.projectedMargin.toFixed(1)} margin`
                      : ""}
                  </span>
                </div>
                <ProbBar prob={spProb} />
                <div className="text-[10px] text-muted-foreground mt-1 mb-2">
                  {play.spreadEdge !== null ? `${play.spreadEdge > 0 ? "+" : ""}${play.spreadEdge}pp edge on ${play.homeTeamAbbr} cover` : "Calculating edge…"}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    data-testid={`ncaab-home-cover-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("over", Math.abs(play.homeSpreadLine ?? 0), spProb, "ncaab_spread", `${play.homeTeamAbbr} ${fmtSpread(play.homeSpreadLine)} Cover`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 hover:bg-blue-500/25 active:scale-95 transition-all"
                  >
                    <span className="text-[10px] font-semibold text-blue-400/70">Home</span>
                    <span className="text-base font-black">{play.homeTeamAbbr} {fmtSpread(play.homeSpreadLine)}</span>
                    <span className="text-[11px] font-bold">{spProb.toFixed(1)}% cover</span>
                  </button>
                  <button
                    data-testid={`ncaab-away-cover-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("over", Math.abs(play.awaySpreadLine ?? 0), spDogProb, "ncaab_spread", `${play.awayTeamAbbr} ${fmtSpread(play.awaySpreadLine)} Cover`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 active:scale-95 transition-all"
                  >
                    <span className="text-[10px] font-semibold text-violet-400/70">Away</span>
                    <span className="text-base font-black">{play.awayTeamAbbr} {fmtSpread(play.awaySpreadLine)}</span>
                    <span className="text-[11px] font-bold">{spDogProb.toFixed(1)}% cover</span>
                  </button>
                </div>
              </div>
            )}

            {/* No API lines */}
            {play.total === null && play.homeSpreadLine === null && (
              <p className="text-[10px] text-muted-foreground italic py-2">No live book lines — model projections used below</p>
            )}
          </div>
        )}

        {/* ── SECTION B: 1H PLAYS (Model, H1 only) ── */}
        {isH1 && (
          <div>
            <SectionHeader label="First Half Plays" badge="Model" badgeColor="text-blue-400 bg-blue-500/10 border-blue-500/30" />

            {/* 1H Total */}
            {play.h1TotalLineModel !== null && play.over1HProb !== null && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-foreground">1H Total (proj)</span>
                  <span className="text-sm font-black text-foreground tabular-nums">{play.h1TotalLineModel}*</span>
                </div>
                <ProbBar prob={play.over1HProb} />
                <div className="text-[10px] text-muted-foreground mt-1 mb-2">
                  {play.proj1HTotal !== null ? `Model: ${play.proj1HTotal} pts projected for H1` : ""}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    data-testid={`ncaab-1h-over-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("over", play.h1TotalLineModel!, play.over1HProb!, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} 1H O${play.h1TotalLineModel}*`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/20 active:scale-95 transition-all"
                  >
                    <span className="text-[10px] font-semibold text-emerald-400/60">1H Model</span>
                    <span className="text-base font-black">OVER {play.h1TotalLineModel}*</span>
                    <span className="text-[11px] font-bold">{play.over1HProb.toFixed(1)}%</span>
                  </button>
                  <button
                    data-testid={`ncaab-1h-under-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("under", play.h1TotalLineModel!, 100 - play.over1HProb!, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} 1H U${play.h1TotalLineModel}*`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-300 hover:bg-rose-500/20 active:scale-95 transition-all"
                  >
                    <span className="text-[10px] font-semibold text-rose-400/60">1H Model</span>
                    <span className="text-base font-black">UNDER {play.h1TotalLineModel}*</span>
                    <span className="text-[11px] font-bold">{(100 - play.over1HProb!).toFixed(1)}%</span>
                  </button>
                </div>
              </div>
            )}

            {/* 1H Spread */}
            {play.h1SpreadLine !== null && play.h1SpreadProb !== null && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-foreground">1H Spread (proj)</span>
                  <span className="text-[10px] text-muted-foreground">
                    {play.h1SpreadLine >= 0 ? play.homeTeamAbbr : play.homeTeamAbbr} {fmtSpread(play.h1SpreadLine)}*
                  </span>
                </div>
                <ProbBar prob={play.h1SpreadProb} />
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button
                    data-testid={`ncaab-1h-home-cover-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("over", Math.abs(play.h1SpreadLine!), play.h1SpreadProb!, "ncaab_1h_spread", `${play.homeTeamAbbr} 1H ${fmtSpread(play.h1SpreadLine)}* Cover`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-blue-500/10 border border-blue-500/25 text-blue-300 hover:bg-blue-500/20 active:scale-95 transition-all"
                  >
                    <span className="text-[10px] font-semibold text-blue-400/60">1H Home</span>
                    <span className="text-sm font-black">{play.homeTeamAbbr} {fmtSpread(play.h1SpreadLine)}*</span>
                    <span className="text-[11px] font-bold">{play.h1SpreadProb.toFixed(1)}%</span>
                  </button>
                  <button
                    data-testid={`ncaab-1h-away-cover-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("over", Math.abs(play.h1SpreadLine!), 100 - play.h1SpreadProb!, "ncaab_1h_spread", `${play.awayTeamAbbr} 1H ${fmtSpread(play.h1SpreadLine !== null ? -play.h1SpreadLine : null)}* Cover`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-violet-500/10 border border-violet-500/25 text-violet-300 hover:bg-violet-500/20 active:scale-95 transition-all"
                  >
                    <span className="text-[10px] font-semibold text-violet-400/60">1H Away</span>
                    <span className="text-sm font-black">{play.awayTeamAbbr} {play.h1SpreadLine !== null ? fmtSpread(-play.h1SpreadLine) : ""}*</span>
                    <span className="text-[11px] font-bold">{(100 - play.h1SpreadProb!).toFixed(1)}%</span>
                  </button>
                </div>
              </div>
            )}

            {/* 1H Team Totals */}
            {(play.proj1HHome !== null || play.proj1HAway !== null) && (
              <div>
                <div className="text-xs font-semibold text-foreground mb-2">1H Team Totals (proj)</div>
                <div className="space-y-2">
                  {play.proj1HHome !== null && play.h1HomeOverProb !== null && (
                    <div className="bg-secondary/30 rounded-lg px-3 py-2.5">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-foreground">{play.homeTeamAbbr}</span>
                        <span className="text-xs font-black text-foreground tabular-nums">{play.proj1HHome}*</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          data-testid={`ncaab-1h-home-over-${play.gameId}`}
                          onClick={() => onAddToParlay && addPick("over", play.proj1HHome!, play.h1HomeOverProb!, "ncaab_1h_team_total", `${play.homeTeamAbbr} 1H Over ${play.proj1HHome}*`)}
                          className="flex items-center justify-center gap-1 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/20 active:scale-95 transition-all text-xs font-bold"
                        >
                          <Plus className="w-3 h-3" /> Over · {play.h1HomeOverProb.toFixed(0)}%
                        </button>
                        <button
                          data-testid={`ncaab-1h-home-under-${play.gameId}`}
                          onClick={() => onAddToParlay && addPick("under", play.proj1HHome!, 100 - play.h1HomeOverProb!, "ncaab_1h_team_total", `${play.homeTeamAbbr} 1H Under ${play.proj1HHome}*`)}
                          className="flex items-center justify-center gap-1 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300 hover:bg-rose-500/20 active:scale-95 transition-all text-xs font-bold"
                        >
                          <Plus className="w-3 h-3" /> Under · {(100 - play.h1HomeOverProb!).toFixed(0)}%
                        </button>
                      </div>
                    </div>
                  )}
                  {play.proj1HAway !== null && play.h1AwayOverProb !== null && (
                    <div className="bg-secondary/30 rounded-lg px-3 py-2.5">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-foreground">{play.awayTeamAbbr}</span>
                        <span className="text-xs font-black text-foreground tabular-nums">{play.proj1HAway}*</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          data-testid={`ncaab-1h-away-over-${play.gameId}`}
                          onClick={() => onAddToParlay && addPick("over", play.proj1HAway!, play.h1AwayOverProb!, "ncaab_1h_team_total", `${play.awayTeamAbbr} 1H Over ${play.proj1HAway}*`)}
                          className="flex items-center justify-center gap-1 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/20 active:scale-95 transition-all text-xs font-bold"
                        >
                          <Plus className="w-3 h-3" /> Over · {play.h1AwayOverProb.toFixed(0)}%
                        </button>
                        <button
                          data-testid={`ncaab-1h-away-under-${play.gameId}`}
                          onClick={() => onAddToParlay && addPick("under", play.proj1HAway!, 100 - play.h1AwayOverProb!, "ncaab_1h_team_total", `${play.awayTeamAbbr} 1H Under ${play.proj1HAway}*`)}
                          className="flex items-center justify-center gap-1 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300 hover:bg-rose-500/20 active:scale-95 transition-all text-xs font-bold"
                        >
                          <Plus className="w-3 h-3" /> Under · {(100 - play.h1AwayOverProb!).toFixed(0)}%
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SECTION C: TEAM TOTALS (Model, always) ── */}
        {(play.homeProjected !== null || play.awayProjected !== null) && (
          <div>
            <SectionHeader label="Team Totals" badge="Model" badgeColor="text-blue-400 bg-blue-500/10 border-blue-500/30" />
            <div className="space-y-2">
              {/* Team totals lean bar */}
              {play.homeProjected !== null && play.awayProjected !== null && (
                <div className="bg-secondary/20 rounded-lg px-3 py-2 mb-3">
                  <div className="flex justify-between text-xs font-bold text-muted-foreground mb-1">
                    <span>{play.homeTeamAbbr} {play.homeProjected}</span>
                    <span>{play.awayTeamAbbr} {play.awayProjected}</span>
                  </div>
                  <div className="flex h-1.5 rounded-full overflow-hidden gap-px">
                    <div
                      className="bg-blue-500 rounded-l-full"
                      style={{ width: `${(play.homeProjected / (play.homeProjected + play.awayProjected)) * 100}%` }}
                    />
                    <div
                      className="bg-orange-500 rounded-r-full flex-1"
                    />
                  </div>
                  <div className="text-[10px] text-center text-muted-foreground mt-1">
                    {play.homeProjected > play.awayProjected
                      ? `${play.homeTeamAbbr} projected to outscore by ${(play.homeProjected - play.awayProjected).toFixed(1)}`
                      : `${play.awayTeamAbbr} projected to outscore by ${(play.awayProjected - play.homeProjected).toFixed(1)}`}
                  </div>
                </div>
              )}

              {play.homeProjected !== null && (
                <div className="bg-secondary/30 rounded-lg px-3 py-2.5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-foreground">{play.homeTeamAbbr} Full Game</span>
                    <span className="text-xs font-black text-foreground tabular-nums">{play.homeProjected}*</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      data-testid={`ncaab-home-team-over-${play.gameId}`}
                      onClick={() => onAddToParlay && addPick("over", play.homeProjected!, homeOverProb, "ncaab_team_total", `${play.homeTeamAbbr} Team Over ${play.homeProjected}*`)}
                      className="flex items-center justify-center gap-1 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/20 active:scale-95 transition-all text-xs font-bold"
                    >
                      <Plus className="w-3 h-3" /> Over · {homeOverProb.toFixed(0)}%
                    </button>
                    <button
                      data-testid={`ncaab-home-team-under-${play.gameId}`}
                      onClick={() => onAddToParlay && addPick("under", play.homeProjected!, 100 - homeOverProb, "ncaab_team_total", `${play.homeTeamAbbr} Team Under ${play.homeProjected}*`)}
                      className="flex items-center justify-center gap-1 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300 hover:bg-rose-500/20 active:scale-95 transition-all text-xs font-bold"
                    >
                      <Plus className="w-3 h-3" /> Under · {(100 - homeOverProb).toFixed(0)}%
                    </button>
                  </div>
                </div>
              )}
              {play.awayProjected !== null && (
                <div className="bg-secondary/30 rounded-lg px-3 py-2.5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-foreground">{play.awayTeamAbbr} Full Game</span>
                    <span className="text-xs font-black text-foreground tabular-nums">{play.awayProjected}*</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      data-testid={`ncaab-away-team-over-${play.gameId}`}
                      onClick={() => onAddToParlay && addPick("over", play.awayProjected!, awayOverProb, "ncaab_team_total", `${play.awayTeamAbbr} Team Over ${play.awayProjected}*`)}
                      className="flex items-center justify-center gap-1 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/20 active:scale-95 transition-all text-xs font-bold"
                    >
                      <Plus className="w-3 h-3" /> Over · {awayOverProb.toFixed(0)}%
                    </button>
                    <button
                      data-testid={`ncaab-away-team-under-${play.gameId}`}
                      onClick={() => onAddToParlay && addPick("under", play.awayProjected!, 100 - awayOverProb, "ncaab_team_total", `${play.awayTeamAbbr} Team Under ${play.awayProjected}*`)}
                      className="flex items-center justify-center gap-1 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300 hover:bg-rose-500/20 active:scale-95 transition-all text-xs font-bold"
                    >
                      <Plus className="w-3 h-3" /> Under · {(100 - awayOverProb).toFixed(0)}%
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Model Projected Margin (when no book spread available, or always as reference) */}
        {play.projectedMargin !== null && play.homeSpreadLine === null && modelSpreadAbs !== null && (
          <div className="bg-secondary/20 rounded-lg px-3 py-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Projected Margin (Model)</span>
              <span className="text-sm font-bold text-foreground">{modelSpreadFav} by {modelSpreadAbs}</span>
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">No live spread line available</div>
          </div>
        )}
      </div>

      {/* ── SECTION D: PER-BOOK SELECTOR (Odds API) ── */}
      {play.bookLines.length > 0 && (
        <div className="px-4 pb-4 border-t border-border/30 pt-4 space-y-3">
          <SectionHeader label="Book Lines" badge="Odds API" badgeColor="text-emerald-400 bg-emerald-500/10 border-emerald-500/30" />
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
            {play.bookLines.map(bl => {
              const isPreferred = bl.book === preferredBook;
              const bookAddPick = makeAddPick(onAddToParlay, play, bl.book);
              return (
                <div
                  key={bl.book}
                  onClick={() => selectBook(bl.book)}
                  data-testid={`ncaab-book-${bl.book}-${play.gameId}`}
                  className={`shrink-0 rounded-xl border px-3 py-2.5 cursor-pointer transition-all min-w-[130px] space-y-2 ${
                    isPreferred ? "border-primary/60 bg-primary/10" : "border-border/50 bg-secondary/40 hover:border-border"
                  }`}
                >
                  <div className={`text-xs font-bold ${isPreferred ? "text-primary" : "text-foreground"}`}>{bl.name}</div>

                  {/* Book totals */}
                  {bl.total !== null && (
                    <div className="grid grid-cols-2 gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); selectBook(bl.book); bookAddPick("over", bl.total!, fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} O${bl.total} (${bl.name})`); }}
                        className="text-[10px] font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-2 rounded-lg text-center hover:bg-emerald-500/20 transition-colors"
                      >
                        O{bl.total}
                        {bl.overPrice && <div className="text-[9px] text-emerald-400/60">{fmtOdds(bl.overPrice)}</div>}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); selectBook(bl.book); bookAddPick("under", bl.total!, 100 - fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} U${bl.total} (${bl.name})`); }}
                        className="text-[10px] font-bold text-rose-300 bg-rose-500/10 border border-rose-500/20 px-1.5 py-2 rounded-lg text-center hover:bg-rose-500/20 transition-colors"
                      >
                        U{bl.total}
                        {bl.underPrice && <div className="text-[9px] text-rose-400/60">{fmtOdds(bl.underPrice)}</div>}
                      </button>
                    </div>
                  )}

                  {/* Book spread — both sides */}
                  {(bl.homePoint !== null || bl.awayPoint !== null) && (
                    <div className="grid grid-cols-2 gap-1">
                      {bl.homePoint !== null && (
                        <button
                          onClick={(e) => { e.stopPropagation(); selectBook(bl.book); if (spProb !== null) bookAddPick("over", Math.abs(bl.homePoint!), spProb, "ncaab_spread", `${play.homeTeamAbbr} ${fmtSpread(bl.homePoint)} (${bl.name})`); }}
                          className="text-[10px] font-bold text-blue-300 bg-blue-500/10 border border-blue-500/20 px-1.5 py-2 rounded-lg text-center hover:bg-blue-500/20 transition-colors"
                        >
                          {play.homeTeamAbbr} {fmtSpread(bl.homePoint)}
                          {bl.homeSpreadPrice && <div className="text-[9px] text-blue-400/60">{fmtOdds(bl.homeSpreadPrice)}</div>}
                        </button>
                      )}
                      {bl.awayPoint !== null && (
                        <button
                          onClick={(e) => { e.stopPropagation(); selectBook(bl.book); if (spDogProb !== null) bookAddPick("over", Math.abs(bl.awayPoint!), spDogProb, "ncaab_spread", `${play.awayTeamAbbr} ${fmtSpread(bl.awayPoint)} (${bl.name})`); }}
                          className="text-[10px] font-bold text-violet-300 bg-violet-500/10 border border-violet-500/20 px-1.5 py-2 rounded-lg text-center hover:bg-violet-500/20 transition-colors"
                        >
                          {play.awayTeamAbbr} {fmtSpread(bl.awayPoint)}
                          {bl.awaySpreadPrice && <div className="text-[9px] text-violet-400/60">{fmtOdds(bl.awaySpreadPrice)}</div>}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Handle signal */}
          {play.bookLines.length >= 2 && (
            <div className="text-[10px] text-yellow-400/80 font-medium">
              {(() => {
                const spreads = play.bookLines.map(b => b.homePoint !== null ? Math.abs(b.homePoint) : null).filter((s): s is number => s !== null);
                if (spreads.length >= 2) {
                  const dev = Math.max(...spreads) - Math.min(...spreads);
                  if (dev >= 2) return `⚡ Fade Opportunity — cross-book spread gap of ${dev.toFixed(1)}`;
                  if (dev >= 1) return `Minor cross-book deviation (${dev.toFixed(1)} gap)`;
                }
                return null;
              })()}
            </div>
          )}
        </div>
      )}

      {/* ESPN Win Prob + Model Details */}
      <div className="px-4 pb-4 space-y-2">
        {(play.espnHomeWinPct !== null && play.espnHomeWinPct !== undefined) && (
          <div className="flex items-center gap-2 pt-1 border-t border-border/20">
            <Zap className="w-3 h-3 text-primary/60" />
            <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">ESPN Win Prob:</span>
            <span className="text-[10px] text-foreground font-semibold">{play.homeTeamAbbr} {play.espnHomeWinPct?.toFixed(1)}%</span>
            <span className="text-[10px] text-muted-foreground">·</span>
            <span className="text-[10px] text-foreground font-semibold">{play.awayTeamAbbr} {play.espnAwayWinPct?.toFixed(1)}%</span>
          </div>
        )}

        <button
          onClick={() => setShowDetails(p => !p)}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors pt-1"
        >
          {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          Possession model details
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
                <div className="col-span-2 text-orange-400/80">{play.homeTeamAbbr} 3PA rate: {play.homeThreePARate}% ← High variance</div>
              )}
              {(play.awayThreePARate ?? 0) > 37 && (
                <div className="col-span-2 text-orange-400/80">{play.awayTeamAbbr} 3PA rate: {play.awayThreePARate}% ← High variance</div>
              )}
            </div>
            <div className="text-muted-foreground/60 mt-1">OE = offensive efficiency per 100 poss · DE = defensive efficiency · * = model projection</div>
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
          <p className="text-[10px] text-muted-foreground mt-1 pl-1">Possession model · ESPN stats · KenPom-style efficiency</p>
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

      {/* Live sub-tab */}
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

      {/* 2H Plays sub-tab */}
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
