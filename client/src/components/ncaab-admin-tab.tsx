import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, Clock, TrendingUp } from "lucide-react";
import type { ParlayPickInput } from "@shared/schema";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

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

// ── RadialGauge ───────────────────────────────────────────────────────────────
function RadialGauge({ value, color, label, isParlayed }: {
  value: number; color: string; label: string; isParlayed: boolean;
}) {
  const cx = 80; const cy = 80;
  const rInner = 60; const rParlay = 70;
  const circInner = 2 * Math.PI * rInner;
  const pct = Math.max(0, Math.min(100, value));
  const dashOffset = circInner - (pct / 100) * circInner;
  return (
    <div className="flex flex-col items-center flex-shrink-0 gap-0.5">
      <div className="relative" style={{ width: 110, height: 110 }}>
        <svg viewBox="0 0 160 160" style={{ width: 110, height: 110, transform: "rotate(-90deg)" }}>
          <circle cx={cx} cy={cy} r={rInner} fill="none" stroke="#27272a" strokeWidth={8} />
          <circle
            cx={cx} cy={cy} r={rInner} fill="none"
            stroke={color} strokeWidth={8}
            strokeDasharray={`${circInner}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            style={{ transition: "stroke-dashoffset 300ms ease, stroke 300ms ease" }}
          />
          {isParlayed && (
            <circle
              cx={cx} cy={cy} r={rParlay} fill="none"
              stroke="#f59e0b" strokeWidth={3}
              strokeDasharray="4 3"
              style={{ animation: "parlay-pulse 2s ease-in-out infinite" }}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-black tabular-nums leading-none" style={{ color }}>
            {Math.round(pct)}%
          </span>
          <span className="text-[9px] uppercase tracking-widest mt-0.5" style={{ color: "#71717a" }}>{label}</span>
        </div>
      </div>
      {isParlayed && (
        <span className="text-[9px] font-black tracking-widest" style={{ color: "#f59e0b" }}>+ PARLAY</span>
      )}
    </div>
  );
}

// ── NCAABGameCard ─────────────────────────────────────────────────────────────
function NCAABGameCard({ play, onAddToParlay }: { play: NCAABPlay; onAddToParlay?: (pick: ParlayPickInput) => void }) {
  const isH1 = play.half === 1 && !play.bettingWindow.includes("HALFTIME");

  const overProb   = isH1 ? (play.over1HProb ?? play.overProb ?? 50) : (play.overProb ?? 50);
  const underProb  = 100 - overProb;
  const spreadProb = play.spreadProb ?? 50;

  const dominantMarket = ((): "over" | "under" | "spread" => {
    const oe = Math.abs(overProb - 50);
    const ue = Math.abs(underProb - 50);
    const se = Math.abs(spreadProb - 50);
    if (se > oe && se > ue && play.spread !== null) return "spread";
    if (ue > oe) return "under";
    return "over";
  })();

  const [selectedMarket, setSelectedMarket] = useState<"over" | "under" | "spread">(dominantMarket);
  const [parlayLegs, setParlayLegs]         = useState<string[]>([]);
  const [showParlayDrawer, setShowParlayDrawer] = useState(false);
  const [flashActive, setFlashActive]       = useState(false);
  const [flashColor, setFlashColor]         = useState("#00d4aa");
  const prevOverProb = useRef(overProb);

  useEffect(() => {
    if (Math.abs(prevOverProb.current - overProb) > 0.5) {
      setFlashColor(overProb > prevOverProb.current ? "#00d4aa" : "#ef4444");
      setFlashActive(true);
      const t = setTimeout(() => setFlashActive(false), 300);
      prevOverProb.current = overProb;
      return () => clearTimeout(t);
    }
  }, [overProb]);

  const effectiveFGLine  = play.total ?? (play.projectedTotal !== null ? Math.round(play.projectedTotal * 2) / 2 : null);
  const effective1HLine  = play.h1TotalLine ?? (play.proj1HTotal !== null ? Math.round(play.proj1HTotal * 2) / 2 : null);
  const effectiveLine    = isH1 ? effective1HLine : effectiveFGLine;

  const gaugeForMarket = (m: "over" | "under" | "spread") =>
    m === "over" ? overProb : m === "under" ? underProb : spreadProb;
  const gaugeValue  = gaugeForMarket(selectedMarket);
  const gaugeColor  = selectedMarket === "over" ? "#00d4aa" : selectedMarket === "under" ? "#ef4444" : "#94a3b8";
  const gaugeLabel  = selectedMarket === "over" ? "OVER" : selectedMarket === "under" ? "UNDER" : "COVER";

  const engineProb  = gaugeValue;
  const bookImplied = 50;
  const edgeGap     = Math.abs(engineProb - bookImplied);
  const edgeSide    = engineProb > bookImplied ? "Under" : "Over";
  const edgeLabel   = edgeGap >= 20 ? `Strong ${edgeSide} EV` : edgeGap >= 10 ? `Lean ${edgeSide} EV` : "Neutral — No Edge";
  const edgeBelow   = edgeGap < 5;
  const evColor     = edgeSide === "Under" ? "#ef4444" : "#00d4aa";

  const getLegId      = (m: string) => `${play.gameId}:${m}`;
  const isLegParlayed = (m: string) => parlayLegs.includes(getLegId(m));
  const toggleLeg     = (m: string) => {
    const id = getLegId(m);
    setParlayLegs(prev => prev.includes(id) ? prev.filter(l => l !== id) : [...prev, id]);
  };

  const marketLabel = (m: "over" | "under" | "spread"): string => {
    if (m === "over")  return effectiveLine !== null ? `Over ${effectiveLine}` : "Over";
    if (m === "under") return effectiveLine !== null ? `Under ${effectiveLine}` : "Under";
    return play.spread !== null ? `${play.favorite} -${play.spread}` : "Spread";
  };

  const mgmBook = play.bookLines.find(b => b.book === "betmgm");
  const altBook = play.bookLines.find(b => b.book === "betrivers") ??
                  play.bookLines.find(b => b.book === "fanduel") ??
                  play.bookLines[1];
  const altLabel = altBook ? (BOOK_LABELS[altBook.book] ?? altBook.book) : "—";

  const getBookLine = (bl: BookLine | undefined): string => {
    if (!bl) return "—";
    if (selectedMarket !== "spread") return bl.total != null ? `O/U ${bl.total}` : "—";
    return bl.spread != null ? `${bl.favorite} -${bl.spread}` : "—";
  };

  const halfLabel = play.half === 1 ? "H1" : play.half === 2 ? "H2" : "OT";
  const bestEdge  = Math.max(Math.abs(play.spreadEdge ?? 0), Math.abs(play.totalEdge ?? 0));

  function addParlayPick(m: "over" | "under" | "spread") {
    if (!onAddToParlay) return;
    const line    = m === "spread" ? (play.spread ?? 0) : (effectiveLine ?? 0);
    const prob    = gaugeForMarket(m);
    const rawOdds = prob >= 50
      ? -Math.round((prob / (100 - prob)) * 100)
      :  Math.round(((100 - prob) / prob) * 100);
    onAddToParlay({
      playerId: 0,
      playerName: marketLabel(m),
      playerTeam: "NCAAB",
      statType: m === "spread" ? "ncaab_spread" : isH1 ? "ncaab_1h_total" : "ncaab_total",
      line,
      probability: prob,
      betDirection: m === "under" ? "under" : "over",
      sportsbook: play.bookLines[0]?.book ?? "fanduel",
      gameId: play.gameId,
      oddsAmerican: rawOdds,
    });
  }

  const statRows = [
    { label: "Full Game Total",    value: effectiveFGLine != null ? String(effectiveFGLine) : "—", sub: "Current line",         vc: "#d4d4d8" },
    { label: "Engine Over%",       value: `${overProb.toFixed(1)}%`,                               sub: "Model probability",    vc: overProb > 50 ? "#00d4aa" : "#71717a" },
    { label: "Engine Under%",      value: `${underProb.toFixed(1)}%`,                              sub: "Model probability",    vc: underProb > 50 ? "#ef4444" : "#71717a" },
    { label: "Spread",             value: play.spread != null ? `-${play.spread}` : "—",           sub: play.spread != null && play.spreadProb != null ? `${play.favorite} cover: ${play.spreadProb.toFixed(0)}%` : "No line", vc: "#d4d4d8" },
    { label: `${play.awayTeamAbbr} Proj`, value: play.awayProjected != null ? String(play.awayProjected) : "—", sub: "Projected final", vc: "#d4d4d8" },
    { label: `${play.homeTeamAbbr} Proj`, value: play.homeProjected != null ? String(play.homeProjected) : "—", sub: "Projected final", vc: "#d4d4d8" },
  ];

  return (
    <>
      <style>{`@keyframes parlay-pulse{0%,100%{opacity:1}50%{opacity:0.5}}`}</style>
      <div
        data-testid={`ncaab-card-${play.gameId}`}
        className="rounded-xl p-5 space-y-4 relative transition-[box-shadow] duration-300"
        style={{
          background: "#0a0a0a",
          border: "1px solid #27272a",
          boxShadow: flashActive
            ? `0 0 0 2px ${flashColor}66`
            : bestEdge >= 15 ? "0 0 14px -3px rgba(0,212,170,0.25)" : undefined,
        }}
      >
        {/* Parlay counter badge */}
        {parlayLegs.length > 0 && (
          <button
            data-testid={`ncaab-parlay-badge-${play.gameId}`}
            onClick={() => setShowParlayDrawer(true)}
            className="absolute top-3 right-3 text-[10px] font-black px-2.5 py-0.5 rounded-full transition-all"
            style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.4)" }}
          >
            {parlayLegs.length} Legs
          </button>
        )}

        {/* ── HEADER ─────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="relative flex h-2 w-2 flex-shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "#71717a" }}>
                LIVE · {halfLabel}&nbsp;&nbsp;{play.clock}
              </span>
            </div>
            <p className="text-base font-bold text-white leading-tight">
              {play.awayTeam} @ {play.homeTeam}
            </p>
            <p className="text-2xl font-black tabular-nums leading-tight mt-0.5" style={{ color: "#d4d4d8" }}>
              {play.awayScore} – {play.homeScore}
            </p>
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              {play.desperation3s && (
                <span className="text-[9px] text-orange-400 bg-orange-500/10 border border-orange-500/20 px-1.5 py-0.5 rounded">⚠ Desperation 3s</span>
              )}
              {play.intentionalFouling && (
                <span className="text-[9px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-1.5 py-0.5 rounded">⚑ Int. Fouling</span>
              )}
            </div>
          </div>
          <RadialGauge value={gaugeValue} color={gaugeColor} label={gaugeLabel} isParlayed={isLegParlayed(selectedMarket)} />
        </div>

        {/* ── VERDICT ROWS ───────────────────────────────────────────── */}
        <div className={`space-y-2 transition-opacity duration-300 ${edgeBelow ? "opacity-40" : ""}`}>
          {edgeBelow && (
            <p className="text-[10px] italic text-center" style={{ color: "#52525b" }}>Edge below threshold — monitoring</p>
          )}
          <div className="rounded-lg p-3 flex items-center justify-between gap-2"
            style={{ background: "#111", border: "1px solid #27272a", borderLeft: `3px solid ${evColor}` }}>
            <div>
              <p className="text-xs font-bold" style={{ color: evColor }}>{edgeLabel}</p>
              <p className="text-[10px]" style={{ color: "#71717a" }}>Engine {engineProb.toFixed(1)}% vs Book {bookImplied}%</p>
            </div>
            {edgeGap >= 5 && (
              <span className="text-[10px] font-black px-2 py-0.5 rounded-full shrink-0"
                style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.3)" }}>
                +{edgeGap.toFixed(1)}pp
              </span>
            )}
          </div>
          <div className="rounded-lg p-3 flex items-center justify-between gap-2"
            style={{ background: "#111", border: "1px solid #27272a", borderLeft: `3px solid ${edgeGap >= 5 ? evColor : "#52525b"}` }}>
            <div>
              <p className="text-xs font-bold" style={{ color: "#d4d4d8" }}>{edgeSide} CLV</p>
              <p className="text-[10px]" style={{ color: "#71717a" }}>Closing line value signal</p>
            </div>
            <span className="text-[10px] font-black px-2 py-0.5 rounded-full shrink-0"
              style={edgeGap >= 5
                ? { background: `${evColor}22`, color: evColor, border: `1px solid ${evColor}44` }
                : { background: "#27272a", color: "#71717a", border: "1px solid #3f3f46" }
              }>
              {edgeGap < 5 ? "Even" : `${edgeSide === "Under" ? "↓" : "↑"} ${edgeSide}`}
            </span>
          </div>
        </div>

        {/* ── STAT GRID ──────────────────────────────────────────────── */}
        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #27272a" }}>
          {statRows.map((row, i) => (
            <div key={i} className="grid grid-cols-3 items-center px-3 py-2 gap-2"
              style={{ borderBottom: i < 5 ? "1px solid #1a1a1a" : undefined, background: i % 2 === 0 ? "#0f0f0f" : "#0a0a0a" }}>
              <span className="text-[10px] font-semibold uppercase tracking-wide truncate" style={{ color: "#71717a" }}>{row.label}</span>
              <span className="text-sm font-black tabular-nums text-center" style={{ color: row.vc }}>{row.value}</span>
              <span className="text-[10px] text-right truncate" style={{ color: "#52525b" }}>{row.sub}</span>
            </div>
          ))}
        </div>

        {/* ── MARKET BUTTONS ─────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-2">
          {(["over", "under", "spread"] as const).map(m => {
            if (m === "spread" && play.spread === null) return null;
            const isSelected = selectedMarket === m;
            const isParlayed = isLegParlayed(m);
            const mColor = m === "over" ? "#00d4aa" : m === "under" ? "#ef4444" : "#94a3b8";
            return (
              <div key={m} className="relative">
                <button
                  data-testid={`ncaab-market-${m}-${play.gameId}`}
                  onClick={() => setSelectedMarket(m)}
                  className="w-full rounded-lg py-2.5 px-2 flex flex-col items-center gap-0.5 transition-all duration-300"
                  style={{
                    background: isSelected ? `${mColor}22` : "#111",
                    border: `1px solid ${isSelected ? mColor : "#27272a"}`,
                    color: isSelected ? mColor : "#71717a",
                  }}
                >
                  <span className="text-[9px] font-black uppercase tracking-widest">{m}</span>
                  <span className="text-sm font-black tabular-nums leading-tight">
                    {m === "spread" ? (play.spread !== null ? `-${play.spread}` : "—") : (effectiveLine ?? "—")}
                  </span>
                  <span className="text-[10px] font-semibold">{gaugeForMarket(m).toFixed(1)}%</span>
                </button>
                <button
                  data-testid={`ncaab-parlay-toggle-${m}-${play.gameId}`}
                  onClick={(e) => { e.stopPropagation(); toggleLeg(m); addParlayPick(m); }}
                  title={isParlayed ? "Remove from parlay" : "Add to parlay"}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black transition-all duration-200"
                  style={{
                    background: isParlayed ? "#f59e0b" : "#27272a",
                    color: isParlayed ? "#000" : "#71717a",
                    border: isParlayed ? "none" : "1px solid #3f3f46",
                  }}
                >
                  +
                </button>
              </div>
            );
          })}
        </div>

        {/* ── BOOK PILLS ─────────────────────────────────────────────── */}
        <div className="flex gap-2 flex-wrap">
          {[
            { label: "MGM", book: mgmBook, url: "https://sports.betmgm.com" },
            { label: altLabel, book: altBook, url: "https://bovada.lv" },
          ].filter(p => p.label !== "—").map(({ label, book, url }) => (
            <button
              key={label}
              data-testid={`ncaab-book-pill-${label}-${play.gameId}`}
              onClick={() => window.open(url, "_blank")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all duration-300"
              style={{ background: "#111", border: "1px solid #27272a", color: "#a1a1aa" }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = "#00d4aa55")}
              onMouseLeave={e => (e.currentTarget.style.borderColor = "#27272a")}
            >
              <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
              </span>
              <span style={{ color: "#d4d4d8", fontWeight: 700 }}>{label}</span>
              <span style={{ color: "#52525b" }}>·</span>
              <span>{getBookLine(book)}</span>
            </button>
          ))}
        </div>

        {/* ── PARLAY DRAWER ──────────────────────────────────────────── */}
        <Sheet open={showParlayDrawer} onOpenChange={setShowParlayDrawer}>
          <SheetContent
            side="bottom"
            className="max-h-[60vh] overflow-y-auto p-5"
            style={{ background: "#050505", borderTop: "1px solid #27272a" }}
          >
            <SheetHeader className="mb-4">
              <SheetTitle className="text-base font-black" style={{ color: "#f59e0b" }}>
                Parlay Slip · {parlayLegs.length} {parlayLegs.length === 1 ? "Leg" : "Legs"}
              </SheetTitle>
            </SheetHeader>
            <div className="space-y-2 mb-4">
              {parlayLegs.map(legId => {
                const m = legId.split(":")[1] as "over" | "under" | "spread";
                return (
                  <div key={legId} className="flex items-center justify-between p-3 rounded-lg"
                    style={{ background: "#111", border: "1px solid #27272a" }}>
                    <div>
                      <p className="text-xs font-bold text-white">{play.awayTeamAbbr} @ {play.homeTeamAbbr}</p>
                      <p className="text-[11px]" style={{ color: "#71717a" }}>
                        {marketLabel(m)} · Engine {gaugeForMarket(m).toFixed(1)}%
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        const remaining = parlayLegs.filter(l => l !== legId);
                        setParlayLegs(remaining);
                        if (remaining.length === 0) setShowParlayDrawer(false);
                      }}
                      className="w-6 h-6 rounded-full flex items-center justify-center text-sm font-black transition-colors"
                      style={{ background: "#27272a", color: "#71717a" }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setParlayLegs([]); setShowParlayDrawer(false); }}
                className="flex-1 py-2.5 rounded-lg text-sm font-bold"
                style={{ background: "#27272a", color: "#d4d4d8", border: "1px solid #3f3f46" }}
              >
                Clear All
              </button>
              <button
                onClick={() => {
                  const text = parlayLegs.map(legId => {
                    const m = legId.split(":")[1] as "over" | "under" | "spread";
                    return `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} · ${marketLabel(m)} · Engine: ${gaugeForMarket(m).toFixed(1)}%`;
                  }).join("\n");
                  navigator.clipboard.writeText(text);
                }}
                className="flex-1 py-2.5 rounded-lg text-sm font-bold"
                style={{ background: "rgba(0,212,170,0.15)", color: "#00d4aa", border: "1px solid rgba(0,212,170,0.3)" }}
              >
                Copy Slip
              </button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
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
