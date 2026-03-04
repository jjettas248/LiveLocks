import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, Clock, TrendingUp, Plus, ChevronDown, ChevronUp, AlertTriangle, Zap, Radio, Lock, X, Settings2 } from "lucide-react";
import { ProbabilityRing } from "@/components/probability-ring";
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
  homeDefRebRate?: number;
  awayDefRebRate?: number;
  bpiHomeMargin?: number | null;
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
  homeTeamId: string;
  homeScore: number;
  awayTeam: string;
  awayTeamAbbr: string;
  awayTeamId: string;
  awayScore: number;
  status: string;
  period: number;
  clock: string;
  isHalftime: boolean;
  isInProgress: boolean;
  isLive: boolean;
  startTime?: string | null;
  homeSpreadLine?: number | null;
  awaySpreadLine?: number | null;
  total?: number | null;
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
  if (point === null || isNaN(point)) return "—";
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
      <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">{label}</span>
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
  const fgProb    = play.overProb ?? 50;
  const spProb    = play.spreadProb ?? 50;
  const spDogProb = 100 - spProb;

  const clv = play.total !== null && play.projectedTotal !== null
    ? Math.round((play.projectedTotal - play.total) * 10) / 10
    : null;
  const showClv = clv !== null && Math.abs(clv) >= 0.5;

  const homeInjuries = play.homeInjuries ?? [];
  const awayInjuries = play.awayInjuries ?? [];
  const hasInjuries = homeInjuries.length > 0 || awayInjuries.length > 0;

  const selectBook = (bookKey: string) => {
    setPreferredBook(bookKey);
    try { localStorage.setItem("ncaab_preferred_book", bookKey); } catch { }
  };

  type BestPlay = { label: string; prob: number; edge: number; direction: "over" | "under" | "cover"; explanation: string };
  const candidates: BestPlay[] = [];

  // Only generate best-play candidates when the game is in an active betting window.
  // bettingWindow="NONE" means no actionable betting window — ring must not fire.
  const inBettingWindow = play.bettingWindow !== "NONE";

  if (inBettingWindow && play.total !== null && play.overProb !== null) {
    const overEdge = play.overProb - 50;
    const underEdge = 50 - play.overProb;
    // Safety guard: only generate a best-play candidate if the projected total
    // is greater than what's already been scored. A projection less than or equal
    // to the live score means corrupted model data — skip it to prevent a false ring.
    const liveTotal = play.homeScore + play.awayScore;
    const projectionSane = play.projectedTotal === null || play.projectedTotal > liveTotal;
    if (overEdge >= 8 && play.projectedTotal !== null && projectionSane) {
      const cappedProb = Math.min(97, play.overProb);
      candidates.push({
        label: `OVER ${play.total}`,
        prob: cappedProb,
        edge: overEdge,
        direction: "over",
        explanation: `Model projects ${play.projectedTotal} pts vs book ${play.total} (+${Math.abs(Math.round((play.projectedTotal - play.total) * 10) / 10)} edge). ${cappedProb >= 97 ? "≥97" : cappedProb.toFixed(0)}% confidence.`,
      });
    } else if (underEdge >= 8 && play.projectedTotal !== null && projectionSane) {
      const cappedProb = Math.min(97, 100 - play.overProb);
      candidates.push({
        label: `UNDER ${play.total}`,
        prob: cappedProb,
        edge: underEdge,
        direction: "under",
        explanation: `Model projects ${play.projectedTotal} pts vs book ${play.total} (${Math.abs(Math.round((play.projectedTotal - play.total) * 10) / 10)} under). ${cappedProb >= 97 ? "≥97" : cappedProb.toFixed(0)}% confidence.`,
      });
    }
  }

  if (inBettingWindow && play.spreadProb !== null) {
    const coverEdge = Math.abs(play.spreadProb - 50);
    if (coverEdge >= 8) {
      const isHomeCover = play.spreadProb >= 50;
      const coverTeam = isHomeCover ? play.homeTeamAbbr : play.awayTeamAbbr;
      const coverLine = isHomeCover
        ? (play.homeSpreadLine !== null ? fmtSpread(play.homeSpreadLine) : "")
        : (play.awaySpreadLine !== null ? fmtSpread(play.awaySpreadLine) : "");
      const cappedProb = Math.min(97, coverEdge + 50);
      candidates.push({
        label: `${coverTeam} ${coverLine} COVER`,
        prob: cappedProb,
        edge: coverEdge,
        direction: "cover",
        explanation: `${play.projectedMargin !== null ? `Model edge: ${Math.abs(play.projectedMargin).toFixed(1)} pts. ` : ""}${cappedProb >= 97 ? "≥97" : cappedProb.toFixed(0)}% cover probability.`,
      });
    }
  }

  const bestPlay: BestPlay | null = candidates.length > 0 ? candidates.sort((a, b) => b.edge - a.edge)[0] : null;
  const isOver = bestPlay?.direction === "over";
  const isUnder = bestPlay?.direction === "under";

  // Projected final score info
  const homeProj = play.homeProjected;
  const awayProj = play.awayProjected;
  const hasProjection = homeProj !== null && awayProj !== null;
  const projTotal = hasProjection ? homeProj! + awayProj! : play.projectedTotal;
  const projMarginAbs = hasProjection ? Math.abs(homeProj! - awayProj!) : null;
  const projFavoredTeam = hasProjection
    ? (homeProj! >= awayProj! ? play.homeTeamAbbr : play.awayTeamAbbr)
    : null;

  // BPI margin display
  const bpiHomeMargin = play.bpiHomeMargin ?? null;
  const bpiFavoredTeam = bpiHomeMargin !== null
    ? (bpiHomeMargin >= 0 ? play.homeTeamAbbr : play.awayTeamAbbr)
    : null;

  // Model engine stats
  const homeOE = play.homeOE ?? null;
  const awayOE = play.awayOE ?? null;
  const homeDE = play.homeDE ?? null;
  const awayDE = play.awayDE ?? null;
  const homeTempo = play.homeTempo ?? null;
  const awayTempo = play.awayTempo ?? null;
  const homeDefRebRate = play.homeDefRebRate ?? null;
  const awayDefRebRate = play.awayDefRebRate ?? null;
  const expectedPoss = play.expectedPoss ?? null;
  const home3PA = play.homeThreePARate ?? null;
  const away3PA = play.awayThreePARate ?? null;
  const homeHighVar = (home3PA ?? 0) > 37;
  const awayHighVar = (away3PA ?? 0) > 37;

  return (
    <div
      data-testid={`ncaab-card-${play.gameId}`}
      className="bg-card border border-border rounded-xl overflow-hidden"
    >
      {/* ── HEADER: scoreboard + probability ring ── */}
      <div className="px-5 pt-5 pb-3 border-b border-border/40">
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
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-muted-foreground">{play.awayTeamAbbr}</span>
              <span className="text-4xl font-black tabular-nums text-foreground">{play.awayScore}</span>
              <span className="text-muted-foreground text-xl font-light">–</span>
              <span className="text-4xl font-black tabular-nums text-foreground">{play.homeScore}</span>
              <span className="text-base font-bold text-muted-foreground">{play.homeTeamAbbr}</span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{play.awayTeam} @ {play.homeTeam}</p>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-xs font-bold text-foreground bg-secondary/60 px-2 py-0.5 rounded-full">{halfLabel}</span>
              <span className="text-xs text-muted-foreground">{play.clock || play.status}</span>
              {(play.espnHomeWinPct !== null && play.espnHomeWinPct !== undefined) && (
                <span className="text-[10px] text-muted-foreground">BPI: {play.homeTeamAbbr} {play.espnHomeWinPct?.toFixed(0)}%</span>
              )}
            </div>
          </div>
          {bestPlay && (
            <div className="shrink-0">
              <ProbabilityRing probability={bestPlay.prob} size={120} strokeWidth={10} />
            </div>
          )}
        </div>
      </div>

      <div className="p-5 space-y-4">

        {/* ── PROJECTED FINAL SCORE (replaces Team Totals 50/50) ── */}
        {hasProjection && (
          <div className="rounded-xl bg-secondary/50 border border-border/60 px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Projected Final</span>
              <span className="text-[10px] text-muted-foreground/60 font-medium">Model*</span>
            </div>
            <div className="flex items-center justify-center gap-4 mb-2">
              <div className="text-center">
                <div className="text-3xl font-black tabular-nums text-foreground">{awayProj}</div>
                <div className="text-[10px] text-muted-foreground font-medium mt-0.5">{play.awayTeamAbbr}</div>
              </div>
              <div className="text-muted-foreground text-lg font-light">–</div>
              <div className="text-center">
                <div className="text-3xl font-black tabular-nums text-foreground">{homeProj}</div>
                <div className="text-[10px] text-muted-foreground font-medium mt-0.5">{play.homeTeamAbbr}</div>
              </div>
            </div>
            <div className="flex items-center justify-center gap-3 text-[11px] text-muted-foreground flex-wrap">
              {projMarginAbs !== null && projFavoredTeam && (
                <span className="font-semibold text-foreground">
                  Spread: <span className="text-primary">{projFavoredTeam} –{projMarginAbs.toFixed(1)}</span>
                </span>
              )}
              {projTotal !== null && (
                <span>Proj O/U: <strong className="text-foreground">{projTotal.toFixed(1)}</strong></span>
              )}
              {bpiHomeMargin !== null && bpiFavoredTeam && (
                <span className="text-muted-foreground/70">
                  BPI: <span className="text-foreground">{bpiFavoredTeam} –{Math.abs(bpiHomeMargin).toFixed(1)}</span>
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── MODEL ENGINE (OE/DE/Tempo at the top) ── */}
        {(homeOE !== null || awayOE !== null) && (
          <div className="rounded-xl bg-secondary/30 border border-border/40 px-4 py-3 space-y-1.5">
            <div className="flex items-center gap-1.5 mb-2">
              <Settings2 className="w-3 h-3 text-primary/60" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Model Engine</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
              {homeOE !== null && (
                <span className="text-muted-foreground">
                  <strong className="text-foreground">{play.homeTeamAbbr}</strong>{" "}
                  OE <span className="text-primary font-semibold">{homeOE}</span>
                  {homeDE !== null && <> · DE {homeDE}</>}
                  {homeTempo !== null && <> · Tempo {homeTempo}</>}
                  {homeDefRebRate !== null && <> · DREB {homeDefRebRate}%</>}
                </span>
              )}
              {awayOE !== null && (
                <span className="text-muted-foreground">
                  <strong className="text-foreground">{play.awayTeamAbbr}</strong>{" "}
                  OE <span className="text-primary font-semibold">{awayOE}</span>
                  {awayDE !== null && <> · DE {awayDE}</>}
                  {awayTempo !== null && <> · Tempo {awayTempo}</>}
                  {awayDefRebRate !== null && <> · DREB {awayDefRebRate}%</>}
                </span>
              )}
            </div>
            {expectedPoss !== null && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground pt-0.5">
                <span>Exp. poss: <strong className="text-foreground">{expectedPoss}</strong></span>
                {homeHighVar && (
                  <span className="text-amber-400 font-semibold">{play.homeTeamAbbr} 3PA {home3PA}% ⚠ High variance</span>
                )}
                {awayHighVar && (
                  <span className="text-amber-400 font-semibold">{play.awayTeamAbbr} 3PA {away3PA}% ⚠ High variance</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* MODEL SAYS banner */}
        {bestPlay && (
          <div className={`rounded-xl px-3 py-3 border flex items-center gap-3 ${
            isOver ? "bg-emerald-500/10 border-emerald-500/30"
            : isUnder ? "bg-rose-500/10 border-rose-500/30"
            : "bg-blue-500/10 border-blue-500/30"
          }`}>
            <TrendingUp className={`w-4 h-4 shrink-0 ${isOver ? "text-emerald-400" : isUnder ? "text-rose-400" : "text-blue-400"}`} />
            <div className="flex-1 min-w-0">
              <div className={`text-[10px] font-bold uppercase tracking-widest mb-0.5 ${isOver ? "text-emerald-400/60" : isUnder ? "text-rose-400/60" : "text-blue-400/60"}`}>
                Model Says
              </div>
              <div className={`text-sm font-black ${isOver ? "text-emerald-300" : isUnder ? "text-rose-300" : "text-blue-300"}`}>
                {bestPlay.label}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{bestPlay.explanation}</div>
            </div>
            <div className={`text-xs font-bold px-2.5 py-1 rounded-full shrink-0 ${
              isOver ? "bg-emerald-500/20 text-emerald-300"
              : isUnder ? "bg-rose-500/20 text-rose-300"
              : "bg-blue-500/20 text-blue-300"
            }`}>
              +{bestPlay.edge.toFixed(0)}% edge
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

        {/* ── SECTION A: FULL GAME LINES (Odds API live) ── */}
        <div>
          <SectionHeader label="Full Game Lines" badge="Live" badgeColor="text-emerald-400 bg-emerald-500/10 border-emerald-500/30" />

          {/* O/U row */}
          {play.total !== null && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Game Total</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-black text-foreground tabular-nums">{play.total}</span>
                  {showClv && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${clv! > 0 ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"}`}>
                      {clv! > 0 ? "+" : ""}{clv} CLV
                    </span>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  data-testid={`ncaab-over-${play.gameId}`}
                  onClick={() => onAddToParlay && addPick("over", play.total!, fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} O${play.total}`)}
                  className="flex flex-col items-center justify-center gap-0.5 py-5 px-4 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 active:scale-95 transition-all"
                >
                  <span className="text-xs font-semibold text-emerald-400/60">{fmtOdds(play.overPrice) || "OVER"}</span>
                  <span className="text-lg font-black">OVER {play.total}</span>
                  <span className="text-sm font-bold text-emerald-200">{fgProb.toFixed(1)}% implied</span>
                </button>
                <button
                  data-testid={`ncaab-under-${play.gameId}`}
                  onClick={() => onAddToParlay && addPick("under", play.total!, 100 - fgProb, "ncaab_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} U${play.total}`)}
                  className="flex flex-col items-center justify-center gap-0.5 py-5 px-4 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 active:scale-95 transition-all"
                >
                  <span className="text-xs font-semibold text-rose-400/60">{fmtOdds(play.underPrice) || "UNDER"}</span>
                  <span className="text-lg font-black">UNDER {play.total}</span>
                  <span className="text-sm font-bold text-rose-200">{(100 - fgProb).toFixed(1)}% implied</span>
                </button>
              </div>
              {play.projectedTotal !== null && (
                <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
                  Model projects <strong className="text-foreground">{play.projectedTotal} pts</strong>
                  {play.totalEdge !== null && <span> · {play.totalEdge > 0 ? "+" : ""}{play.totalEdge}pp edge</span>}
                </p>
              )}
            </div>
          )}

          {/* Spread row */}
          {((play.homeSpreadLine !== null && !isNaN(play.homeSpreadLine)) || (play.awaySpreadLine !== null && !isNaN(play.awaySpreadLine))) && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Spread</span>
                {play.projectedMargin !== null && (
                  <span className="text-xs text-muted-foreground">
                    Model: {play.homeTeamAbbr} {play.projectedMargin >= 0 ? "+" : ""}{play.projectedMargin.toFixed(1)}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  data-testid={`ncaab-home-cover-${play.gameId}`}
                  onClick={() => onAddToParlay && addPick("over", Math.abs(play.homeSpreadLine ?? 0), spProb, "ncaab_spread", `${play.homeTeamAbbr} ${fmtSpread(play.homeSpreadLine)} Cover`)}
                  className="flex flex-col items-center justify-center gap-0.5 py-5 px-4 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 hover:bg-blue-500/25 active:scale-95 transition-all"
                >
                  <span className="text-xs font-semibold text-blue-400/60">HOME</span>
                  <span className="text-lg font-black">{play.homeTeamAbbr} {fmtSpread(play.homeSpreadLine)}</span>
                  <span className="text-sm font-bold text-blue-200">{spProb.toFixed(1)}% cover</span>
                </button>
                <button
                  data-testid={`ncaab-away-cover-${play.gameId}`}
                  onClick={() => onAddToParlay && addPick("over", Math.abs(play.awaySpreadLine ?? 0), spDogProb, "ncaab_spread", `${play.awayTeamAbbr} ${fmtSpread(play.awaySpreadLine)} Cover`)}
                  className="flex flex-col items-center justify-center gap-0.5 py-5 px-4 rounded-xl bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 active:scale-95 transition-all"
                >
                  <span className="text-xs font-semibold text-violet-400/60">AWAY</span>
                  <span className="text-lg font-black">{play.awayTeamAbbr} {fmtSpread(play.awaySpreadLine)}</span>
                  <span className="text-sm font-bold text-violet-200">{spDogProb.toFixed(1)}% cover</span>
                </button>
              </div>
              {play.spreadEdge !== null && (
                <p className="text-xs text-muted-foreground mt-1.5 text-center">
                  {play.spreadEdge > 0 ? "+" : ""}{play.spreadEdge}pp edge on {play.homeTeamAbbr} cover
                </p>
              )}
            </div>
          )}

          {/* No Odds API lines at all */}
          {play.total === null && play.homeSpreadLine === null && (
            <div className="text-center py-3">
              <p className="text-xs text-muted-foreground italic">No live book lines — model projections below</p>
              {play.projectedMargin !== null && (
                <p className="text-xs font-semibold text-foreground mt-1">
                  Model: {play.projectedMargin >= 0 ? play.homeTeamAbbr : play.awayTeamAbbr} by {Math.abs(play.projectedMargin).toFixed(1)}
                </p>
              )}
            </div>
          )}
        </div>

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
                <div className="text-xs text-muted-foreground mt-1 mb-2">
                  {play.proj1HTotal !== null ? `Model: ${play.proj1HTotal} pts projected for H1` : ""}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    data-testid={`ncaab-1h-over-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("over", play.h1TotalLineModel!, play.over1HProb!, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} 1H O${play.h1TotalLineModel}*`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/20 active:scale-95 transition-all"
                  >
                    <span className="text-xs font-semibold text-emerald-400/60">1H OVER</span>
                    <span className="text-lg font-black">{play.h1TotalLineModel}*</span>
                    <span className="text-sm font-bold text-emerald-200">{play.over1HProb.toFixed(1)}% implied</span>
                  </button>
                  <button
                    data-testid={`ncaab-1h-under-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("under", play.h1TotalLineModel!, 100 - play.over1HProb!, "ncaab_1h_total", `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} 1H U${play.h1TotalLineModel}*`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-300 hover:bg-rose-500/20 active:scale-95 transition-all"
                  >
                    <span className="text-xs font-semibold text-rose-400/60">1H UNDER</span>
                    <span className="text-lg font-black">{play.h1TotalLineModel}*</span>
                    <span className="text-sm font-bold text-rose-200">{(100 - play.over1HProb!).toFixed(1)}% implied</span>
                  </button>
                </div>
              </div>
            )}

            {/* 1H Spread */}
            {play.h1SpreadLine !== null && play.h1SpreadProb !== null && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-foreground">1H Spread (proj)</span>
                  <span className="text-xs text-muted-foreground">
                    {play.homeTeamAbbr} {fmtSpread(play.h1SpreadLine)}*
                  </span>
                </div>
                <ProbBar prob={play.h1SpreadProb} />
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button
                    data-testid={`ncaab-1h-home-cover-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("over", Math.abs(play.h1SpreadLine!), play.h1SpreadProb!, "ncaab_1h_spread", `${play.homeTeamAbbr} 1H ${fmtSpread(play.h1SpreadLine)}* Cover`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-blue-500/10 border border-blue-500/25 text-blue-300 hover:bg-blue-500/20 active:scale-95 transition-all"
                  >
                    <span className="text-xs font-semibold text-blue-400/60">1H HOME</span>
                    <span className="text-lg font-black">{play.homeTeamAbbr} {fmtSpread(play.h1SpreadLine)}*</span>
                    <span className="text-sm font-bold text-blue-200">{play.h1SpreadProb.toFixed(1)}% cover</span>
                  </button>
                  <button
                    data-testid={`ncaab-1h-away-cover-${play.gameId}`}
                    onClick={() => onAddToParlay && addPick("over", Math.abs(play.h1SpreadLine!), 100 - play.h1SpreadProb!, "ncaab_1h_spread", `${play.awayTeamAbbr} 1H ${play.h1SpreadLine !== null ? fmtSpread(-play.h1SpreadLine) : ""}* Cover`)}
                    className="flex flex-col items-center justify-center gap-0.5 py-4 rounded-xl bg-violet-500/10 border border-violet-500/25 text-violet-300 hover:bg-violet-500/20 active:scale-95 transition-all"
                  >
                    <span className="text-xs font-semibold text-violet-400/60">1H AWAY</span>
                    <span className="text-lg font-black">{play.awayTeamAbbr} {play.h1SpreadLine !== null ? fmtSpread(-play.h1SpreadLine) : ""}*</span>
                    <span className="text-sm font-bold text-violet-200">{(100 - play.h1SpreadProb!).toFixed(1)}% cover</span>
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
      </div>

      {/* ── SECTION D: PER-BOOK SELECTOR (Odds API) ── */}
      {play.bookLines.length > 0 && (
        <div className="px-5 pb-5 border-t border-border/30 pt-4 space-y-3">
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

          {play.bookLines.length >= 2 && (
            <div className="text-xs text-yellow-400/80 font-medium">
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

      {/* Possession model details (collapsible learn-more) */}
      <div className="px-5 pb-5 space-y-2">
        <button
          onClick={() => setShowDetails(p => !p)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors pt-1"
        >
          {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          Possession model details
        </button>

        {showDetails && (
          <div className="bg-secondary/30 rounded-lg px-3 py-2.5 space-y-1.5 text-[11px]">
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
              {play.bpiHomeMargin !== null && play.bpiHomeMargin !== undefined && (
                <div className="col-span-2 text-muted-foreground/80">
                  BPI Margin: <span className="text-foreground font-semibold">{play.homeTeamAbbr} {play.bpiHomeMargin >= 0 ? "+" : ""}{play.bpiHomeMargin.toFixed(1)}</span> (blended 50/50 with model)
                </div>
              )}
            </div>
            <div className="text-muted-foreground/60 mt-1">OE = offensive efficiency per 100 poss · DE = defensive efficiency · * = model projection · BPI = ESPN Basketball Power Index</div>
          </div>
        )}
      </div>
    </div>
  );
}

interface NCAABAdminTabProps {
  onAddToParlay?: (pick: ParlayPickInput) => void;
  isAdmin?: boolean;
  isFreeUser?: boolean;
  onGameView?: (gameId: string) => Promise<boolean>;
}

function formatTipoff(startTime: string | null | undefined): string {
  if (!startTime) return "";
  try {
    return new Date(startTime).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function roundToHour(startTime: string | null | undefined): string {
  if (!startTime) return "TBD";
  try {
    const d = new Date(startTime);
    const etMin = parseInt(
      d.toLocaleString("en-US", { timeZone: "America/New_York", minute: "numeric" }),
      10
    );
    const adjMs = etMin >= 30 ? (60 - etMin) * 60000 : -etMin * 60000;
    return new Date(d.getTime() + adjMs).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "TBD";
  }
}

export function NCAABAdminTab({ onAddToParlay, isAdmin, isFreeUser, onGameView }: NCAABAdminTabProps) {
  const [ncaabSubTab, setNcaabSubTab] = useState<"live" | "halftime">("live");
  const [selectedGameId, setSelectedGameId] = useState<string | undefined>(undefined);
  const [unlockedGameIds, setUnlockedGameIds] = useState<Set<string>>(new Set());
  const [unlocking, setUnlocking] = useState(false);
  const [expandedTimeGroups, setExpandedTimeGroups] = useState<Set<string>>(new Set(["LIVE"]));

  const playsQuery = useQuery<{ plays: NCAABPlay[] }>({
    queryKey: ["/api/ncaab/plays"],
    refetchInterval: 60 * 1000,
  });

  const gamesQuery = useQuery<{ games: NCAABGame[] }>({
    queryKey: ["/api/ncaab/games"],
    refetchInterval: 30 * 1000,
  });

  const previewQuery = useQuery<NCAABPlay>({
    queryKey: ["/api/ncaab/game-preview", selectedGameId],
    enabled: !!selectedGameId && !!(unlockedGameIds.has(selectedGameId ?? "") || !isFreeUser),
    refetchInterval: 60 * 1000,
    retry: false,
  });

  const plays  = playsQuery.data?.plays  ?? [];
  const games  = gamesQuery.data?.games  ?? [];
  const loading = playsQuery.isLoading || gamesQuery.isLoading;
  const error   = playsQuery.error ?? gamesQuery.error;

  const halftimePlays = plays.filter(p => p.bettingWindow === "HALFTIME");

  const sortedGames = [...games].sort((a, b) => {
    if (a.isLive && !b.isLive) return -1;
    if (!a.isLive && b.isLive) return 1;
    const ta = a.startTime ? new Date(a.startTime).getTime() : Infinity;
    const tb = b.startTime ? new Date(b.startTime).getTime() : Infinity;
    return ta - tb;
  });

  // Group games by time bucket
  const timeGroups = useMemo(() => {
    const groups: Record<string, NCAABGame[]> = {};
    const liveGames: NCAABGame[] = [];
    for (const g of sortedGames) {
      if (g.isLive) {
        liveGames.push(g);
      } else {
        const bucket = roundToHour(g.startTime);
        if (!groups[bucket]) groups[bucket] = [];
        groups[bucket].push(g);
      }
    }
    const result: Array<{ key: string; label: string; games: NCAABGame[]; isLive: boolean }> = [];
    if (liveGames.length > 0) {
      result.push({ key: "LIVE", label: "🔴 Live Now", games: liveGames, isLive: true });
    }
    const bucketKeys = Object.keys(groups).sort((a, b) => {
      try {
        const aTime = new Date(`1970/01/01 ${a}`).getTime();
        const bTime = new Date(`1970/01/01 ${b}`).getTime();
        return aTime - bTime;
      } catch {
        return 0;
      }
    });
    for (const key of bucketKeys) {
      result.push({ key, label: `${key} ET`, games: groups[key], isLive: false });
    }
    return result;
  }, [sortedGames]);

  // Auto-expand first upcoming group on load
  useMemo(() => {
    if (timeGroups.length === 0) return;
    const toExpand = new Set<string>(["LIVE"]);
    const firstUpcoming = timeGroups.find(g => !g.isLive);
    if (firstUpcoming) toExpand.add(firstUpcoming.key);
    setExpandedTimeGroups(toExpand);
  }, [timeGroups.length]);

  const selectedGame = games.find(g => g.id === selectedGameId);
  const selectedLivePlay = plays.find(p => p.gameId === selectedGameId);
  const isSelectedGameLive = selectedGame?.isLive ?? false;

  async function handleTileClick(gameId: string) {
    if (selectedGameId === gameId) {
      setSelectedGameId(undefined);
      return;
    }
    setSelectedGameId(gameId);
    // Auto-expand the time group containing this game
    const group = timeGroups.find(g => g.games.some(game => game.id === gameId));
    if (group) {
      setExpandedTimeGroups(prev => { const n = new Set(prev); n.add(group.key); return n; });
    }
    if (!isFreeUser || unlockedGameIds.has(gameId)) return;
  }

  function toggleTimeGroup(key: string) {
    setExpandedTimeGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function handleUnlock() {
    if (!selectedGameId || !onGameView) return;
    setUnlocking(true);
    const ok = await onGameView(selectedGameId);
    setUnlocking(false);
    if (ok) {
      setUnlockedGameIds(prev => { const n = new Set(prev); n.add(selectedGameId); return n; });
    }
  }

  const displayPlay: NCAABPlay | null = selectedLivePlay ?? previewQuery.data ?? null;
  const isPreGame = selectedGame && !isSelectedGameLive;

  return (
    <div className="space-y-4">

      {/* ── Today's NCAAB Slate ────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-bold text-foreground uppercase tracking-widest">Today's NCAAB Slate</span>
            {sortedGames.length > 0 && (
              <span className="text-[10px] text-muted-foreground/60">({sortedGames.length} games)</span>
            )}
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

        {loading && games.length === 0 && (
          <div className="flex items-center gap-2 text-muted-foreground py-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span className="text-xs">Loading games…</span>
          </div>
        )}

        {!loading && sortedGames.length === 0 && (
          <p className="text-xs text-muted-foreground/60 py-2">No games scheduled today.</p>
        )}

        {/* Collapsible time groups */}
        {timeGroups.length > 0 && (
          <div className="space-y-2">
            {timeGroups.map(group => {
              const isExpanded = expandedTimeGroups.has(group.key);
              return (
                <div key={group.key} className="border border-border/50 rounded-xl overflow-hidden">
                  <button
                    data-testid={`ncaab-time-group-${group.key}`}
                    onClick={() => toggleTimeGroup(group.key)}
                    className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors ${
                      group.isLive
                        ? "bg-emerald-500/10 hover:bg-emerald-500/15"
                        : "bg-secondary/30 hover:bg-secondary/50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {group.isLive && <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
                      <span className={`text-xs font-bold ${group.isLive ? "text-emerald-400" : "text-foreground"}`}>
                        {group.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground/70">
                        {group.games.length} game{group.games.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    {isExpanded
                      ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
                      : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                    }
                  </button>

                  {isExpanded && (
                    <div className="p-2 pt-1.5">
                      <div className="flex gap-2 overflow-x-auto pb-1 flex-wrap">
                        {group.games.map(g => {
                          const isSelected = selectedGameId === g.id;
                          const tipoff = formatTipoff(g.startTime);
                          const isFinal = g.status === "Final" || g.status === "Final/OT";
                          const spreadVal = g.homeSpreadLine !== null && g.homeSpreadLine !== undefined && !isNaN(g.homeSpreadLine) ? fmtSpread(g.homeSpreadLine) : null;
                          const totalVal = g.total !== null && g.total !== undefined && !isNaN(g.total) ? `O/U ${g.total}` : null;
                          return (
                            <button
                              key={g.id}
                              data-testid={`ncaab-game-tile-${g.id}`}
                              onClick={() => handleTileClick(g.id)}
                              className={`min-w-[130px] px-3 py-2 rounded-lg border text-xs flex flex-col gap-0.5 transition-all text-left ${
                                isSelected
                                  ? "border-primary bg-primary/10 ring-1 ring-primary shadow-[0_0_16px_-3px_hsl(var(--primary)/0.4)]"
                                  : "border-border/60 bg-background hover:bg-secondary/50"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-1 font-semibold tabular-nums text-foreground">
                                <span>{g.awayTeamAbbr}</span>
                                {g.isLive && <span className="text-primary">{g.awayScore} – {g.homeScore}</span>}
                                <span>{g.homeTeamAbbr}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                {g.isLive && !isFinal && (
                                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                )}
                                <span className={`text-[10px] ${g.isLive && !isFinal ? "text-emerald-400" : isFinal ? "text-muted-foreground/60" : "text-muted-foreground"}`}>
                                  {isFinal ? "Final" : g.isLive ? `H${g.period <= 1 ? 1 : 2} ${g.clock}` : tipoff || g.status}
                                </span>
                              </div>
                              {(spreadVal || totalVal) && (
                                <div className="flex gap-1 flex-wrap mt-0.5">
                                  {spreadVal && <span className="text-[9px] text-muted-foreground/70 bg-secondary px-1 py-0.5 rounded">{spreadVal}</span>}
                                  {totalVal && <span className="text-[9px] text-muted-foreground/70 bg-secondary px-1 py-0.5 rounded">{totalVal}</span>}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Prediction Panel ──────────────────────────────────────────────── */}
      {selectedGameId && selectedGame && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border/60 bg-secondary/30">
            <div className="flex items-center gap-2">
              {isSelectedGameLive && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              )}
              <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
                {isSelectedGameLive ? "Live Prediction" : "Pre-Game Model"}
              </span>
              <span className="text-xs font-semibold text-foreground">{selectedGame.awayTeamAbbr} @ {selectedGame.homeTeamAbbr}</span>
            </div>
            <button
              data-testid="ncaab-prediction-close"
              onClick={() => setSelectedGameId(undefined)}
              className="p-1 rounded hover:bg-secondary transition-colors"
            >
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>

          {isFreeUser && !unlockedGameIds.has(selectedGameId) ? (
            <div className="flex flex-col items-center justify-center py-10 px-6 gap-4">
              <Lock className="w-8 h-8 text-muted-foreground/40" />
              <div className="text-center">
                <p className="text-sm font-semibold text-foreground mb-1">View Prediction</p>
                <p className="text-xs text-muted-foreground">This uses 1 free play from your 15 total.</p>
              </div>
              <button
                data-testid="ncaab-unlock-game"
                onClick={handleUnlock}
                disabled={unlocking}
                className="px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {unlocking ? "Unlocking…" : "View Prediction (1 play)"}
              </button>
            </div>
          ) : previewQuery.isLoading && isPreGame ? (
            <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading prediction…</span>
            </div>
          ) : displayPlay ? (
            <div className="p-4">
              <NCAABGameCard play={displayPlay} onAddToParlay={onAddToParlay} />
            </div>
          ) : (
            <div className="text-center py-10 text-muted-foreground">
              <Clock className="w-6 h-6 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No prediction available yet</p>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-xs text-red-400">{(error as any).message ?? "Failed to load NCAAB data"}</p>
        </div>
      )}

      {/* ── Sub-tab pills ─────────────────────────────────────────────────── */}
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
          <p className="text-[10px] text-muted-foreground mt-1 pl-1">Possession model · ESPN BPI blend · KenPom-style efficiency</p>
        </div>
      </div>

      {/* Live sub-tab */}
      {ncaabSubTab === "live" && (
        <div className="space-y-6">
          {loading && plays.length === 0 && (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading NCAAB data…</span>
            </div>
          )}

          {!loading && plays.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Clock className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">No live NCAAB games right now</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Select a game from the slate above to see the pre-game model</p>
            </div>
          )}

          {plays.length > 0 && (
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
