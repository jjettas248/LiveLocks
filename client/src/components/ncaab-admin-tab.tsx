import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, Clock, TrendingUp, CheckCircle, ChevronDown } from "lucide-react";
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
  homeGameTotalIsEstimated: boolean;
  awayGameTotalIsEstimated: boolean;
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
  overOddsAmerican: number | null;
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
  startTime: string;
  isHalftime: boolean;
  isInProgress: boolean;
  isLive: boolean;
}

interface SummaryGame {
  gameId: string;
  awayTeam: string;
  homeTeam: string;
  awayTeamAbbr: string;
  homeTeamAbbr: string;
  awayScore: number;
  homeScore: number;
  line: number | null;
  overProb: number | null;
  edgeGap: number;
}

interface ToastItem {
  id: string;
  game: NCAABGame;
}

function determineResult(game: SummaryGame): "HIT" | "MISS" | "PUSH" {
  if (game.line === null || game.overProb === null) return "PUSH";
  const engineCall = game.overProb > 50 ? "under" : "over";
  const actualTotal = game.awayScore + game.homeScore;
  if (actualTotal === game.line) return "PUSH";
  if (engineCall === "under") return actualTotal < game.line ? "HIT" : "MISS";
  return actualTotal > game.line ? "HIT" : "MISS";
}

function formatTipoffTime(startTime: string): string {
  if (!startTime) return "Today";
  try {
    return new Date(startTime).toLocaleTimeString("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }) + " CT";
  } catch {
    return "Today";
  }
}

interface H2HGame {
  date: string;
  awayTeam: string;
  homeTeam: string;
  awayAbbr: string;
  homeAbbr: string;
  awayScore: number;
  homeScore: number;
  location: string;
  total: number | null;
  spread: number | null;
  spreadTeam: "HOME" | "AWAY" | null;
  isCurrent?: boolean;
}

function determineCoverage(g: H2HGame): { result: "covered" | "failed" | "PUSH" | "N/A"; team: string | null } {
  if (!g.spread || !g.spreadTeam) return { result: "N/A", team: null };
  const absSpread = Math.abs(g.spread);
  if (g.spreadTeam === "HOME") {
    const margin = g.homeScore - g.awayScore;
    if (margin > absSpread) return { result: "covered", team: g.homeAbbr };
    if (margin === absSpread) return { result: "PUSH", team: null };
    return { result: "failed", team: g.homeAbbr };
  }
  const margin = g.awayScore - g.homeScore;
  if (margin > absSpread) return { result: "covered", team: g.awayAbbr };
  if (margin === absSpread) return { result: "PUSH", team: null };
  return { result: "failed", team: g.awayAbbr };
}

// Shared H2H section (items 1 + 4): toggle row + animated rows with dual badges
function H2HSection({
  h2hData,
  h2hOpen,
  setH2hOpen,
}: {
  h2hData: H2HGame[] | null;
  h2hOpen: boolean;
  setH2hOpen: (v: boolean) => void;
}) {
  return (
    <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #27272a" }}>
      {/* Toggle row with chevron animation (item 4) */}
      <button
        onClick={() => setH2hOpen(!h2hOpen)}
        className="w-full flex items-center justify-between px-3 py-2.5 transition-colors duration-200"
        style={{ background: "#0f0f0f" }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#141414"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#0f0f0f"; }}
      >
        <span className="text-sm font-semibold" style={{ color: "#71717a" }}>Matchup History</span>
        <ChevronDown
          className="w-4 h-4 transition-transform duration-300"
          style={{ color: "#52525b", transform: h2hOpen ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      </button>

      {/* Animated slide-down rows */}
      <div
        aria-hidden={!h2hOpen}
        style={{
          maxHeight: h2hOpen ? "420px" : "0px",
          opacity: h2hOpen ? 1 : 0,
          overflow: "hidden",
          visibility: h2hOpen ? "visible" : "hidden",
          transition: "max-height 300ms ease, opacity 200ms ease, visibility 300ms ease",
        }}>
        {/* Loading skeleton */}
        {h2hData === null && (
          <div>
            {[1, 2, 3].map(i => (
              <div key={i} className="flex items-center justify-between px-3 gap-3 animate-pulse"
                style={{ borderTop: "1px solid #1a1a1a", minHeight: "64px", padding: "10px 12px" }}>
                <div className="flex-1">
                  <div className="h-3 rounded w-20 mb-1" style={{ background: "#27272a" }} />
                  <div className="h-2 rounded w-14" style={{ background: "#1e1e1e" }} />
                </div>
                <div className="flex-1 text-center">
                  <div className="h-4 rounded w-16 mx-auto mb-1" style={{ background: "#27272a" }} />
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <div className="h-5 rounded w-12" style={{ background: "#27272a" }} />
                  <div className="h-5 rounded w-12" style={{ background: "#1e1e1e" }} />
                </div>
              </div>
            ))}
          </div>
        )}
        {/* Empty state */}
        {h2hData !== null && h2hData.length === 0 && (
          <div className="px-3 py-4 text-center" style={{ borderTop: "1px solid #1a1a1a" }}>
            <p className="text-xs" style={{ color: "#52525b" }}>No matchup history found for this season</p>
          </div>
        )}
        {/* H2H rows with dual badges (item 1) */}
        {/* 1-game insufficient state note */}
        {h2hData !== null && h2hData.length === 1 && (
          <div className="px-3 pb-3 text-center" style={{ borderTop: "1px solid #1a1a1a" }}>
            <p className="text-[10px] italic" style={{ color: "#52525b" }}>Limited history — 1 game found</p>
          </div>
        )}
        {h2hData !== null && h2hData.map((g, idx) => {
          const actualTotal = g.awayScore + g.homeScore;
          const ouResult = g.total !== null
            ? (actualTotal > g.total ? "OVER" : actualTotal < g.total ? "UNDER" : "PUSH")
            : "N/A";
          const coverage = determineCoverage(g);
          const awayWon = g.awayScore > g.homeScore;

          const ouColor   = ouResult === "OVER" ? "#00d4aa" : ouResult === "UNDER" ? "#ef4444" : "#71717a";
          const ouBg      = ouResult === "OVER" ? "rgba(0,212,170,0.15)" : ouResult === "UNDER" ? "rgba(239,68,68,0.15)" : "#27272a";
          const ouBorder  = ouResult === "OVER" ? "rgba(0,212,170,0.3)"  : ouResult === "UNDER" ? "rgba(239,68,68,0.3)"  : "#3f3f46";
          const covColor  = coverage.result === "covered" ? "#00d4aa" : coverage.result === "failed" ? "#ef4444" : "#71717a";
          const covBg     = coverage.result === "covered" ? "rgba(0,212,170,0.15)" : coverage.result === "failed" ? "rgba(239,68,68,0.15)" : "#27272a";
          const covBorder = coverage.result === "covered" ? "rgba(0,212,170,0.3)"  : coverage.result === "failed" ? "rgba(239,68,68,0.3)"  : "#3f3f46";
          const covLabel  = coverage.result === "covered"
            ? `${coverage.team} cvrd` : coverage.result === "failed"
            ? `${coverage.team} fail` : coverage.result;

          return (
            <div key={idx}
              className="flex items-center justify-between gap-3"
              style={{
                borderTop: "1px solid #1a1a1a",
                minHeight: "64px",
                padding: "10px 12px",
                background: idx % 2 === 0 ? "#0f0f0f" : "#0a0a0a",
              }}>
              {/* Left: date + location */}
              <div className="min-w-0 shrink-0">
                <p className="text-[11px]" style={{
                  color: g.isCurrent === false ? "#52525b" : "#71717a",
                  fontStyle: g.isCurrent === false ? "italic" : "normal",
                }}>
                  {g.isCurrent === false ? `${g.date} · Prior Season` : g.date}
                </p>
                <p className="text-[10px]" style={{ color: "#52525b" }}>{g.location}</p>
              </div>
              {/* Center: score */}
              <div className="flex-1 text-center">
                <p className="text-xs font-black tabular-nums">
                  <span style={{ color: awayWon ? "#ffffff" : "#52525b" }}>{g.awayScore}</span>
                  <span style={{ color: "#3f3f46" }}> – </span>
                  <span style={{ color: awayWon ? "#52525b" : "#ffffff" }}>{g.homeScore}</span>
                </p>
                {g.total !== null && (
                  <p className="text-[9px]" style={{ color: "#52525b" }}>Total: {actualTotal}</p>
                )}
              </div>
              {/* Right: dual badges stacked */}
              <div className="flex flex-col gap-1 items-end shrink-0">
                <div className="text-right">
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                    style={{ background: ouBg, color: ouColor, border: `1px solid ${ouBorder}` }}>
                    {ouResult}
                  </span>
                  {g.total !== null && (
                    <p className="text-[9px] mt-0.5" style={{ color: "#3f3f46" }}>O/U: {g.total}</p>
                  )}
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                    style={{ background: covBg, color: covColor, border: `1px solid ${covBorder}` }}>
                    {covLabel}
                  </span>
                  {g.spread !== null && g.spreadTeam && (
                    <p className="text-[9px] mt-0.5" style={{ color: "#3f3f46" }}>
                      {g.spreadTeam === "HOME" ? g.homeAbbr : g.awayAbbr} -{g.spread}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
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
function RadialGauge({ value, color, label, isParlayed, showFullGameLabel, displayDash }: {
  value: number; color: string; label: string; isParlayed: boolean; showFullGameLabel?: boolean; displayDash?: boolean;
}) {
  const cx = 80; const cy = 80;
  const rInner = 68; const rParlay = 80;
  const circInner = 2 * Math.PI * rInner;
  const pct = Math.max(0, Math.min(100, value));
  const dashOffset = circInner - (pct / 100) * circInner;
  const arcColor = displayDash ? "#52525b" : color;
  return (
    <div className="flex flex-col items-center flex-shrink-0 gap-0.5">
      <div className="relative" style={{ width: 110, height: 110 }}>
        <svg viewBox="0 0 160 160" style={{ width: 110, height: 110, transform: "rotate(-90deg)" }}>
          <circle cx={cx} cy={cy} r={rInner} fill="none" stroke="#27272a" strokeWidth={10} />
          <circle
            cx={cx} cy={cy} r={rInner} fill="none"
            stroke={arcColor} strokeWidth={10}
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
          {displayDash ? (
            <span className="text-3xl font-black tabular-nums leading-none" style={{ color: "#52525b" }}>--</span>
          ) : (
            <span className="text-3xl font-black tabular-nums leading-none" style={{ color }}>
              {Math.round(pct)}%
            </span>
          )}
          <span className="text-[9px] uppercase tracking-widest mt-0.5" style={{ color: "#71717a" }}>{label}</span>
        </div>
      </div>
      {showFullGameLabel && (
        <p style={{ color: "#71717a", fontSize: 10, marginTop: 2 }}>Full Game</p>
      )}
      {isParlayed && (
        <span className="text-[9px] font-black tracking-widest" style={{ color: "#f59e0b" }}>+ PARLAY</span>
      )}
    </div>
  );
}

// ── AnimatedNumber (item 3) ───────────────────────────────────────────────────
// Counts up/down to new value with ease-out cubic. Handles mid-animation interrupts
// by starting from current display value, not from original start (item 7).
function AnimatedNumber({
  value,
  duration = 600,
  decimals = 1,
  suffix = "",
  color,
  colorTransition = false,
}: {
  value: number;
  duration?: number;
  decimals?: number;
  suffix?: string;
  color?: string;
  colorTransition?: boolean;
}) {
  const [display, setDisplay] = useState(value);
  const prevValueRef = useRef(value);
  const displayRef   = useRef(value);
  const frameRef     = useRef<number | null>(null);

  useEffect(() => {
    if (prevValueRef.current === value) return;

    // Item 7: start from current mid-animation display, not original prevValue
    const startVal  = displayRef.current;
    const endVal    = value;
    const startTime = performance.now();

    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);

    const animate = (now: number) => {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased    = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      const cur      = parseFloat((startVal + (endVal - startVal) * eased).toFixed(decimals));
      displayRef.current = cur;
      setDisplay(cur);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate);
      } else {
        frameRef.current = null;
        prevValueRef.current = value;
      }
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current); };
  }, [value, duration, decimals]);

  return (
    <span style={{
      color,
      transition: colorTransition ? "color 600ms ease" : undefined,
    }}>
      {display}{suffix}
    </span>
  );
}

// ── ShiftBadge (item 2) ───────────────────────────────────────────────────────
function ShiftBadge() {
  return (
    <div className="flex items-center gap-1.5 animate-pulse px-2 py-0.5 rounded-full"
      style={{
        background: "rgba(245,158,11,0.10)",
        border:     "1px solid rgba(245,158,11,0.30)",
      }}>
      <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
        <span className="absolute inline-flex h-full w-full rounded-full animate-ping" style={{ background: "#f59e0b", opacity: 0.6 }} />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: "#f59e0b" }} />
      </span>
      <span className="text-xs font-semibold" style={{ color: "#f59e0b" }}>Edge Flipped</span>
    </div>
  );
}

// ── Engine probability helpers ────────────────────────────────────────────────
function computeGameProgress(play: NCAABPlay): number {
  const halfMins = 20;
  const totalMins = 40;
  if (play.period > 2) return 1.0; // overtime — 100%
  const parts = (play.clock ?? "20:00").split(":").map(Number);
  const minsLeft = (parts[0] ?? 20) + ((parts[1] ?? 0) / 60);
  const elapsed = Math.max(0, halfMins - minsLeft) + (play.half - 1) * halfMins;
  return Math.min(Math.max(elapsed / totalMins, 0), 1);
}

function getProgressiveLimits(progress: number): { min: number; max: number } {
  if (progress < 0.10) return { min: 30, max: 70 };
  if (progress < 0.25) return { min: 20, max: 80 };
  if (progress < 0.50) return { min: 10, max: 90 };
  if (progress < 0.75) return { min:  5, max: 95 };
  if (progress < 0.90) return { min:  3, max: 97 };
  return { min: 1, max: 99 };
}

function limitedEngineProb(rawProb: number | null, progress: number, gameId?: string): number {
  if (rawProb === null) return 50;
  const { min, max } = getProgressiveLimits(progress);
  const clamped = Math.min(Math.max(rawProb, min), max);
  if (Math.abs(rawProb - clamped) > 10) {
    console.warn(
      `[ENGINE] Probability clamped: raw=${rawProb.toFixed(1)}% → limited=${clamped.toFixed(1)}% | game=${gameId ?? "?"} | ${(progress * 100).toFixed(0)}% elapsed`
    );
  }
  return parseFloat(clamped.toFixed(1));
}

// ── Team total probability helpers (T005) ────────────────────────────────────
function calculateTeamTotalProb(proj: number, line: number): number {
  const raw = 50 + (proj - line) * 2; // ~2pp per scoring point delta
  return Math.min(Math.max(raw, 1), 99);
}

function getTeamTotalVerdict(
  teamProj: number,
  line: number,
  direction: "over" | "under",
  isEstimated: boolean
) {
  const rawEngine = calculateTeamTotalProb(teamProj, line);
  // Compress toward 50 by 40% when line is estimated (less confidence)
  const engineProb = isEstimated ? 50 + (rawEngine - 50) * 0.6 : rawEngine;
  // No real book odds for estimated lines; standard -110 vig otherwise
  const bookImplied = isEstimated ? 50 : 52.4;
  const edgeGap = parseFloat(Math.abs(engineProb - bookImplied).toFixed(1));
  const edgeSide: "Over" | "Under" = engineProb > bookImplied ? "Over" : "Under";
  const directionSide = direction === "under" ? "Under" : "Over";
  const edgeLabel = edgeGap >= 20 ? `Strong ${directionSide} EV`
    : edgeGap >= 10 ? `Lean ${directionSide} EV`
    : "Neutral — No Edge";
  return {
    engineProb: parseFloat(engineProb.toFixed(1)),
    bookImplied,
    edgeGap,
    edgeSide,
    edgeLabel,
    isEstimated,
  };
}

// ── NCAABGameCard ─────────────────────────────────────────────────────────────
function NCAABGameCard({
  play,
  onAddToParlay,
  h2hDataFromCache,
  isNewlyLive,
  onShiftDetected,
}: {
  play: NCAABPlay;
  onAddToParlay?: (pick: ParlayPickInput) => void;
  h2hDataFromCache?: H2HGame[] | null;
  isNewlyLive?: boolean;
  onShiftDetected?: (gameId: string) => void;
}) {
  const isH1 = play.half === 1 && !play.bettingWindow.includes("HALFTIME");

  // T004: progressive limits applied to engine output
  const gameProgress = computeGameProgress(play);
  const overProb     = limitedEngineProb(play.overProb, gameProgress, play.gameId);
  const underProb    = parseFloat((100 - overProb).toFixed(1));
  const spreadProb   = limitedEngineProb(play.spreadProb, gameProgress, play.gameId);

  // T005: neutral state — engine hasn't accumulated enough data
  const rawOver   = play.overProb ?? 50;
  const isNeutral = gameProgress < 0.10 && rawOver >= 45 && rawOver <= 55;

  const dominantMarket = ((): "over" | "under" | "spread" => {
    const oe = Math.abs(overProb - 50);
    const ue = Math.abs(underProb - 50);
    const se = Math.abs(spreadProb - 50);
    if (se > oe && se > ue && play.spread !== null) return "spread";
    if (ue > oe) return "under";
    return "over";
  })();

  const [selectedMarket, setSelectedMarket] = useState<"over" | "under" | "spread">(dominantMarket);
  const [marketTab, setMarketTab]           = useState<"full" | "h1">("full");
  const [parlayLegs, setParlayLegs]         = useState<string[]>([]);
  const [showParlayDrawer, setShowParlayDrawer] = useState(false);
  const [selectedTeamMarket, setSelectedTeamMarket] = useState<{
    team: "home" | "away";
    direction: "over" | "under";
    line: number;
    isEstimated: boolean;
    teamAbbr: string;
  } | null>(null);
  const [flashActive, setFlashActive]       = useState(false);
  const [flashColor, setFlashColor]         = useState("#00d4aa");
  const prevOverProb = useRef(overProb);

  // H2H state (items 2-4): collapsed by default for live card
  const [h2hData, setH2hData] = useState<H2HGame[] | null>(h2hDataFromCache ?? null);
  const [h2hOpen, setH2hOpen] = useState(false);

  // Direction-flip state (item 5): triggers color transition on Engine Over/Under%
  const [isDirectionFlip, setIsDirectionFlip] = useState(false);

  // Newly-live flash on mount (item 6): inline teal glow instead of toast
  useEffect(() => {
    if (!isNewlyLive) return;
    setFlashColor("#00d4aa");
    setFlashActive(true);
    const t = setTimeout(() => setFlashActive(false), 200);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch H2H once on mount if not already cached (item 2)
  useEffect(() => {
    if (h2hData !== null) return;
    let cancelled = false;
    fetch(`/api/ncaab/h2h?gameId=${play.gameId}`)
      .then(r => r.ok ? r.json() : { games: [] })
      .then(data => { if (!cancelled) setH2hData(data.games ?? []); })
      .catch(() => { if (!cancelled) setH2hData([]); });
    return () => { cancelled = true; };
  }, [play.gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Synchronous trigger of all animations (item 6): one event, no setTimeout chains
  useEffect(() => {
    const prev  = prevOverProb.current;
    const delta = Math.abs(prev - overProb);
    if (delta > 0.5) {
      const directionChanged = (prev > 50) !== (overProb > 50); // crossing the 50-mark
      if (directionChanged) {
        // Direction-change flash: amber border + shift badge (items 5 + 6)
        setFlashColor("#f59e0b");
        setIsDirectionFlip(true);
        onShiftDetected?.(play.gameId);
        const clear = setTimeout(() => { setIsDirectionFlip(false); }, 700);
        setFlashActive(true);
        const clearFlash = setTimeout(() => setFlashActive(false), 300);
        prevOverProb.current = overProb;
        return () => { clearTimeout(clear); clearTimeout(clearFlash); };
      } else {
        // Significant / normal flash
        setFlashColor(overProb > prev ? "#00d4aa" : "#ef4444");
        setFlashActive(true);
        const t = setTimeout(() => setFlashActive(false), 300);
        prevOverProb.current = overProb;
        return () => clearTimeout(t);
      }
    }
  }, [overProb]); // eslint-disable-line react-hooks/exhaustive-deps

  const effectiveFGLine  = play.total ?? (play.projectedTotal !== null ? Math.round(play.projectedTotal * 2) / 2 : null);
  const effective1HLine  = play.h1TotalLine ?? (play.proj1HTotal !== null ? Math.round(play.proj1HTotal * 2) / 2 : null);
  const effectiveLine    = isH1 ? effective1HLine : effectiveFGLine;

  // T002/T003: market tab display derivations
  const displayLine        = marketTab === "h1" ? effective1HLine : effectiveFGLine;
  const displayOverProb    = marketTab === "h1" ? (play.over1HProb ?? overProb) : overProb;
  const displayUnderProb   = parseFloat((100 - displayOverProb).toFixed(4));
  const displaySpread      = marketTab === "h1" ? play.h1SpreadLine : play.spread;
  const displaySpreadFav   = marketTab === "h1" ? play.h1Favorite : play.favorite;
  const displaySpreadProb  = marketTab === "h1" ? null : play.spreadProb;
  const h1ProjSplit        = play.proj1HTotal != null ? play.proj1HTotal / 2 : null;
  const displayAwayProj    = marketTab === "h1" ? h1ProjSplit : play.awayProjected;
  const displayHomeProj    = marketTab === "h1" ? h1ProjSplit : play.homeProjected;
  const h1DataUnavailable  = marketTab === "h1" && effective1HLine == null && play.over1HProb == null;

  // T004: derive team total lines — SGO/ESPN book line first, fallback to projection-derived
  function deriveTeamTotalLine(proj: number | null): number | null {
    if (!proj || proj <= 0) return null;
    return Math.round(proj * 2) / 2;
  }

  // Full-game projected values for team total context (not H1 split)
  const fullAwayProj = play.awayProjected;
  const fullHomeProj = play.homeProjected;
  const awayEffTotalLine = play.awayGameTotalLine ?? deriveTeamTotalLine(fullAwayProj);
  const homeEffTotalLine = play.homeGameTotalLine ?? deriveTeamTotalLine(fullHomeProj);
  // isEstimated comes from server; if line was null (derived), the server sets estimated=true
  const awayIsEstimated = play.awayGameTotalIsEstimated;
  const homeIsEstimated = play.homeGameTotalIsEstimated;

  // Only show team total buttons when projection is within a valid college scoring range
  const isValidAwayProj = fullAwayProj != null && fullAwayProj >= 10 && fullAwayProj <= 100;
  const isValidHomeProj = fullHomeProj != null && fullHomeProj >= 10 && fullHomeProj <= 100;
  if (fullAwayProj != null && (fullAwayProj < 10 || fullAwayProj > 100)) {
    console.warn(`[ENGINE] Suspicious team proj: ${fullAwayProj} for ${play.awayTeamAbbr} — hiding team total market`);
  }
  if (fullHomeProj != null && (fullHomeProj < 10 || fullHomeProj > 100)) {
    console.warn(`[ENGINE] Suspicious team proj: ${fullHomeProj} for ${play.homeTeamAbbr} — hiding team total market`);
  }

  const gaugeForMarket = (m: "over" | "under" | "spread") =>
    m === "over" ? overProb : m === "under" ? underProb : spreadProb;
  const gaugeValue  = gaugeForMarket(selectedMarket);
  const gaugeColor  = selectedMarket === "over" ? "#00d4aa" : selectedMarket === "under" ? "#ef4444" : "#94a3b8";
  const gaugeLabel  = selectedMarket === "over" ? "OVER" : selectedMarket === "under" ? "UNDER" : "COVER";

  const engineProb  = gaugeValue;

  // T003: derive bookImplied from American odds price in Odds API response
  function americanToImplied(odds: number): number {
    return odds < 0
      ? (Math.abs(odds) / (Math.abs(odds) + 100)) * 100
      : (100 / (odds + 100)) * 100;
  }
  const bookImplied = play.overOddsAmerican != null
    ? parseFloat(americanToImplied(play.overOddsAmerican).toFixed(1))
    : 52.4; // standard -110 vig default

  const edgeGap = Math.abs(engineProb - bookImplied);

  // T004: fix inverted direction — market-aware edgeSide
  const edgeSide: "Over" | "Under" =
    selectedMarket === "under"
      ? (engineProb > bookImplied ? "Under" : "Over")
      : (engineProb > bookImplied ? "Over" : "Under");

  const edgeLabel = edgeGap >= 20
    ? `Strong ${edgeSide} EV`
    : edgeGap >= 10
    ? `Lean ${edgeSide} EV`
    : "Neutral — No Edge";
  const edgeBelow = edgeGap < 5;
  const evColor   = edgeSide === "Under" ? "#ef4444" : "#00d4aa";

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

  function addTeamTotalParlayPick() {
    if (!onAddToParlay || !selectedTeamMarket) return;
    const { team, direction, line, isEstimated, teamAbbr } = selectedTeamMarket;
    const proj = team === "home" ? fullHomeProj : fullAwayProj;
    if (!proj) return;
    const v = getTeamTotalVerdict(proj, line, direction, isEstimated);
    const prob = v.engineProb;
    const rawOdds = prob >= 50
      ? -Math.round((prob / (100 - prob)) * 100)
      : Math.round(((100 - prob) / prob) * 100);
    onAddToParlay({
      playerId: 0,
      playerName: `${teamAbbr} ${direction === "over" ? "Over" : "Under"} ${isEstimated ? "~" : ""}${line}`,
      playerTeam: "NCAAB",
      statType: "ncaab_team_total",
      line,
      probability: prob,
      betDirection: direction,
      sportsbook: play.bookLines[0]?.book ?? "fanduel",
      gameId: play.gameId,
      oddsAmerican: rawOdds,
      isEstimated,
    });
  }

  // Animated stat grid colors (item 5): color transitions for Engine Over/Under% on direction flip
  // T004: always teal/red — never muted #71717a
  const overColor  = overProb  > 50 ? "#00d4aa" : "#ef4444";
  const underColor = underProb > 50 ? "#00d4aa" : "#ef4444";

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
              <span
                className="text-[11px] font-semibold"
                style={{
                  background: "rgba(22,163,74,0.15)",
                  border: "1px solid rgba(22,163,74,0.25)",
                  borderRadius: 9999,
                  padding: "2px 10px",
                  color: "#ffffff",
                }}
              >
                LIVE · {halfLabel}&nbsp;&nbsp;{play.clock}
              </span>
            </div>
            <p className="text-lg font-bold text-white leading-tight">
              {play.awayTeam} @ {play.homeTeam}
            </p>
            <p className="text-4xl font-black tabular-nums leading-tight mt-0.5" style={{ color: "#ffffff" }}>
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
          <RadialGauge
            value={isNeutral ? 50 : gaugeValue}
            color={isNeutral ? "#52525b" : gaugeColor}
            label={isNeutral ? "EARLY GAME" : gaugeLabel}
            isParlayed={isLegParlayed(selectedMarket)}
            showFullGameLabel
            displayDash={isNeutral}
          />
        </div>

        {/* ── VERDICT ROWS ───────────────────────────────────────────── */}
        {isNeutral ? (
          <div className="rounded-lg py-5 text-center" style={{ background: "#0f0f0f", border: "1px solid #27272a" }}>
            <p className="text-sm italic" style={{ color: "#52525b" }}>Insufficient Data — Engine Warming Up</p>
            <p className="text-xs mt-1" style={{ color: "#3f3f46" }}>Probability updates as game data accumulates</p>
          </div>
        ) : (
          <div className={`space-y-2 transition-opacity duration-300 ${edgeBelow ? "opacity-40" : ""}`}>
            {edgeBelow && (
              <p className="text-[10px] italic text-center" style={{ color: "#52525b" }}>Edge below threshold — monitoring</p>
            )}
            <div className="rounded-lg flex items-center justify-between gap-2"
              style={{ background: "#111111", border: "1px solid #27272a", borderLeft: `3px solid ${evColor}`, padding: "16px 20px" }}>
              <div>
                <p className="text-sm font-semibold" style={{ color: evColor }}>{edgeLabel}</p>
                <p className="text-xs" style={{ color: "#a1a1aa" }}>Engine {engineProb.toFixed(1)}% vs Book {bookImplied}%</p>
              </div>
              {edgeGap >= 5 && (
                <span className="text-[10px] font-black px-2 py-0.5 rounded-full shrink-0"
                  style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.3)", fontFamily: "monospace" }}>
                  +{edgeGap.toFixed(1)}pp
                </span>
              )}
            </div>
            <div className="rounded-lg flex items-center justify-between gap-2"
              style={{ background: "#0f0f0f", border: "1px solid #27272a", borderLeft: `3px solid ${edgeGap >= 5 ? evColor : "#52525b"}`, padding: "16px 20px" }}>
              <div>
                <p className="text-sm font-semibold" style={{ color: "#a1a1aa" }}>{edgeSide} CLV</p>
                <p className="text-xs" style={{ color: "#71717a" }}>Closing line value signal</p>
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
        )}

        {/* ── TEAM TOTAL VERDICT SECTION (T005) ──────────────────────── */}
        {selectedTeamMarket !== null && (() => {
          const { team, direction, line, isEstimated, teamAbbr } = selectedTeamMarket;
          const proj = team === "home" ? fullHomeProj : fullAwayProj;
          if (proj === null) return null;
          const v = getTeamTotalVerdict(proj, line, direction, isEstimated);
          const ttColor = v.edgeSide === "Over" ? "#00d4aa" : "#ef4444";
          const ttEdgeBelow = v.edgeGap < 5;
          return (
            <div className="space-y-2">
              {/* Divider header */}
              <div className="flex items-center gap-2 pt-1">
                <div style={{ flex: 1, height: 1, background: "#27272a" }} />
                <span style={{ color: "#71717a", fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                  Team Total · {teamAbbr} {direction === "over" ? "O" : "U"}{isEstimated ? "~" : ""}{line}
                </span>
                {isEstimated && (
                  <span style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#71717a", fontSize: 10, padding: "1px 6px", borderRadius: 4 }}>
                    Est.
                  </span>
                )}
                <div style={{ flex: 1, height: 1, background: "#27272a" }} />
              </div>
              {/* Team total EV row */}
              <div className="relative rounded-lg flex items-center justify-between gap-2"
                style={{ background: "#111111", border: "1px solid #27272a", borderLeft: `3px solid ${ttEdgeBelow ? "#52525b" : ttColor}`, padding: "16px 20px" }}>
                <div>
                  <p className="text-sm font-semibold" style={{ color: ttEdgeBelow ? "#71717a" : ttColor }}>{v.edgeLabel}</p>
                  <p className="text-xs" style={{ color: "#a1a1aa" }}>Engine {v.engineProb}% vs Book {v.bookImplied}%</p>
                </div>
                <div className="flex items-center gap-2">
                  {v.edgeGap >= 5 && (
                    <span className="text-[10px] font-black px-2 py-0.5 rounded-full shrink-0"
                      style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.3)", fontFamily: "monospace" }}>
                      +{v.edgeGap}pp
                    </span>
                  )}
                  {onAddToParlay && (
                    <button
                      data-testid={`ncaab-team-total-parlay-${play.gameId}`}
                      onClick={addTeamTotalParlayPick}
                      title="Add team total to parlay"
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black transition-all duration-200 shrink-0"
                      style={{ background: "#27272a", color: "#a1a1aa", border: "1px solid #3f3f46" }}
                    >
                      +
                    </button>
                  )}
                </div>
              </div>
              {/* Team total CLV row */}
              <div className="rounded-lg flex items-center justify-between gap-2"
                style={{ background: "#0f0f0f", border: "1px solid #27272a", borderLeft: `3px solid ${v.edgeGap >= 5 ? ttColor : "#52525b"}`, padding: "16px 20px" }}>
                <div>
                  <p className="text-sm font-semibold" style={{ color: "#a1a1aa" }}>{v.edgeSide} Team CLV</p>
                  <p className="text-xs" style={{ color: "#71717a" }}>Team total line value signal</p>
                </div>
                <span className="text-[10px] font-black px-2 py-0.5 rounded-full shrink-0"
                  style={v.edgeGap >= 5
                    ? { background: `${ttColor}22`, color: ttColor, border: `1px solid ${ttColor}44` }
                    : { background: "#27272a", color: "#71717a", border: "1px solid #3f3f46" }}>
                  {v.edgeGap < 5 ? "Even" : `${v.edgeSide === "Under" ? "↓" : "↑"} ${v.edgeSide}`}
                </span>
              </div>
              {/* Reduced confidence note for estimated lines */}
              {isEstimated && (
                <p style={{ color: "#52525b", fontSize: 11, fontStyle: "italic", paddingTop: 4, paddingBottom: 8, paddingLeft: 20, paddingRight: 20 }}>
                  Line estimated from projection — reduced confidence signal
                </p>
              )}
            </div>
          );
        })()}

        {/* ── FULL GAME / 1H TOGGLE ──────────────────────────────────── */}
        <div className="flex items-center gap-3">
          <div style={{ display: "inline-flex", background: "#0f0f0f", borderRadius: 8, padding: 4, gap: 4 }}>
            <button
              onClick={() => setMarketTab("full")}
              style={{
                background: marketTab === "full" ? "#27272a" : "transparent",
                color: marketTab === "full" ? "#ffffff" : "#71717a",
                borderRadius: 6,
                padding: "4px 12px",
                fontSize: 12,
                fontWeight: 500,
                border: "none",
                cursor: "pointer",
              }}
            >
              Full Game
            </button>
            <button
              onClick={() => setMarketTab("h1")}
              style={{
                background: marketTab === "h1" ? "#27272a" : "transparent",
                color: marketTab === "h1" ? "#ffffff" : "#71717a",
                borderRadius: 6,
                padding: "4px 12px",
                fontSize: 12,
                fontWeight: 500,
                border: "none",
                cursor: "pointer",
              }}
            >
              1st Half
            </button>
          </div>
          {h1DataUnavailable && (
            <p style={{ color: "#71717a", fontSize: 11, fontStyle: "italic" }}>1H lines unavailable</p>
          )}
        </div>

        {/* ── STAT GRID (items 4 + 5) ────────────────────────────────── */}
        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #27272a" }}>
          {[0,1,2,3,4,5].map(i => {
            const borderB = i < 5 ? "1px solid #27272a" : undefined;
            if (i === 0) return (
              <div key={0} className="grid grid-cols-3 items-center gap-2" style={{ borderBottom: borderB, background: "#111111", padding: "16px 20px" }}>
                <span className="text-xs font-semibold uppercase tracking-wider truncate" style={{ color: "#71717a" }}>
                  {marketTab === "h1" ? "H1 Total" : "Full Game Total"}
                </span>
                <span className="text-lg font-bold tabular-nums text-center" style={{ color: "#ffffff" }}>
                  {displayLine != null ? String(displayLine) : "—"}
                </span>
                <span className="text-xs text-right truncate" style={{ color: "#a1a1aa" }}>Current line</span>
              </div>
            );
            if (i === 1) return (
              <div key={1} className="grid grid-cols-3 items-center gap-2" style={{ borderBottom: borderB, background: "#111111", padding: "16px 20px" }}>
                <span className="text-xs font-semibold uppercase tracking-wider truncate" style={{ color: "#71717a" }}>Engine Over%</span>
                <span className="text-lg font-bold tabular-nums text-center">
                  <AnimatedNumber value={displayOverProb} decimals={1} suffix="%" color={overColor} colorTransition={isDirectionFlip} />
                </span>
                <span className="text-xs text-right truncate" style={{ color: "#a1a1aa" }}>Model probability</span>
              </div>
            );
            if (i === 2) return (
              <div key={2} className="grid grid-cols-3 items-center gap-2" style={{ borderBottom: borderB, background: "#111111", padding: "16px 20px" }}>
                <span className="text-xs font-semibold uppercase tracking-wider truncate" style={{ color: "#71717a" }}>Engine Under%</span>
                <span className="text-lg font-bold tabular-nums text-center">
                  <AnimatedNumber value={displayUnderProb} decimals={1} suffix="%" color={underColor} colorTransition={isDirectionFlip} />
                </span>
                <span className="text-xs text-right truncate" style={{ color: "#a1a1aa" }}>Model probability</span>
              </div>
            );
            if (i === 3) return (
              <div key={3} className="grid grid-cols-3 items-center gap-2" style={{ borderBottom: borderB, background: "#111111", padding: "16px 20px" }}>
                <span className="text-xs font-semibold uppercase tracking-wider truncate" style={{ color: "#71717a" }}>Spread</span>
                <span className="text-lg font-bold tabular-nums text-center" style={{ color: "#ffffff" }}>
                  {displaySpread != null ? `-${displaySpread}` : "—"}
                </span>
                <span className="text-xs text-right truncate" style={{ color: "#a1a1aa" }}>
                  {displaySpread != null && displaySpreadProb != null ? (
                    <>{displaySpreadFav} cover:&nbsp;<AnimatedNumber value={displaySpreadProb} decimals={1} suffix="%" color="#a1a1aa" /></>
                  ) : displaySpread != null ? `${displaySpreadFav} fav` : "No line"}
                </span>
              </div>
            );
            if (i === 4) {
              const showAwayButtons = marketTab === "full" && isValidAwayProj && awayEffTotalLine !== null;
              return (
                <div key={4} className="grid grid-cols-3 items-center gap-2" style={{ borderBottom: borderB, background: "#111111", padding: "16px 20px" }}>
                  <span className="text-xs font-semibold uppercase tracking-wider truncate" style={{ color: "#71717a" }}>{play.awayTeamAbbr} Proj</span>
                  <span className="text-lg font-bold tabular-nums text-center">
                    {displayAwayProj != null
                      ? <AnimatedNumber value={displayAwayProj} decimals={1} suffix="" color="#ffffff" />
                      : <span style={{ color: "#a1a1aa" }}>—</span>}
                  </span>
                  <div className="flex justify-end items-center gap-1">
                    {showAwayButtons ? (
                      <>
                        {(["over", "under"] as const).map(dir => {
                          const isSelected = selectedTeamMarket?.team === "away" && selectedTeamMarket?.direction === dir;
                          const btnColor = dir === "over" ? "#00d4aa" : "#ef4444";
                          const prefix = dir === "over" ? "O" : "U";
                          return (
                            <button
                              key={dir}
                              data-testid={`ncaab-team-total-${dir}-away-${play.gameId}`}
                              onClick={() => setSelectedTeamMarket(isSelected ? null : {
                                team: "away", direction: dir, line: awayEffTotalLine!,
                                isEstimated: awayIsEstimated, teamAbbr: play.awayTeamAbbr,
                              })}
                              style={{
                                fontSize: 9, padding: "2px 5px", borderRadius: 4, fontWeight: 700,
                                border: `1px solid ${isSelected ? btnColor : "#3f3f46"}`,
                                color: isSelected ? btnColor : "#71717a",
                                background: isSelected ? `${btnColor}1e` : "#1a1a1a",
                                cursor: "pointer", lineHeight: 1.4,
                              }}
                            >
                              {prefix}{awayIsEstimated ? "~" : ""}{awayEffTotalLine}
                            </button>
                          );
                        })}
                      </>
                    ) : (
                      <span className="text-xs truncate" style={{ color: "#a1a1aa" }}>
                        {marketTab === "h1" ? "H1 proj" : "Projected final"}
                      </span>
                    )}
                  </div>
                </div>
              );
            }
            return (
              (() => {
                const showHomeButtons = marketTab === "full" && isValidHomeProj && homeEffTotalLine !== null;
                return (
                  <div key={5} className="grid grid-cols-3 items-center gap-2" style={{ borderBottom: borderB, background: "#111111", padding: "16px 20px" }}>
                    <span className="text-xs font-semibold uppercase tracking-wider truncate" style={{ color: "#71717a" }}>{play.homeTeamAbbr} Proj</span>
                    <span className="text-lg font-bold tabular-nums text-center">
                      {displayHomeProj != null
                        ? <AnimatedNumber value={displayHomeProj} decimals={1} suffix="" color="#ffffff" />
                        : <span style={{ color: "#a1a1aa" }}>—</span>}
                    </span>
                    <div className="flex justify-end items-center gap-1">
                      {showHomeButtons ? (
                        <>
                          {(["over", "under"] as const).map(dir => {
                            const isSelected = selectedTeamMarket?.team === "home" && selectedTeamMarket?.direction === dir;
                            const btnColor = dir === "over" ? "#00d4aa" : "#ef4444";
                            const prefix = dir === "over" ? "O" : "U";
                            return (
                              <button
                                key={dir}
                                data-testid={`ncaab-team-total-${dir}-home-${play.gameId}`}
                                onClick={() => setSelectedTeamMarket(isSelected ? null : {
                                  team: "home", direction: dir, line: homeEffTotalLine!,
                                  isEstimated: homeIsEstimated, teamAbbr: play.homeTeamAbbr,
                                })}
                                style={{
                                  fontSize: 9, padding: "2px 5px", borderRadius: 4, fontWeight: 700,
                                  border: `1px solid ${isSelected ? btnColor : "#3f3f46"}`,
                                  color: isSelected ? btnColor : "#71717a",
                                  background: isSelected ? `${btnColor}1e` : "#1a1a1a",
                                  cursor: "pointer", lineHeight: 1.4,
                                }}
                              >
                                {prefix}{homeIsEstimated ? "~" : ""}{homeEffTotalLine}
                              </button>
                            );
                          })}
                        </>
                      ) : (
                        <span className="text-xs truncate" style={{ color: "#a1a1aa" }}>
                          {marketTab === "h1" ? "H1 proj" : "Projected final"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()
            );
          })}
        </div>

        {/* ── H2H SECTION (item 1+4, collapsed by default in live card) ─ */}
        <H2HSection h2hData={h2hData} h2hOpen={h2hOpen} setH2hOpen={setH2hOpen} />

        {/* ── MARKET BUTTONS ─────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-2">
          {(["over", "under", "spread"] as const).map(m => {
            if (m === "spread" && displaySpread === null) return null;
            const isSelected = selectedMarket === m;
            const isParlayed = isLegParlayed(m);
            const mColor = m === "over" ? "#00d4aa" : m === "under" ? "#ef4444" : "#94a3b8";
            const mProb = m === "over" ? displayOverProb : m === "under" ? displayUnderProb : (displaySpreadProb ?? spreadProb);
            return (
              <div key={m} className="relative">
                <button
                  data-testid={`ncaab-market-${m}-${play.gameId}`}
                  onClick={() => setSelectedMarket(m)}
                  title={isNeutral ? "Probability updates as game data accumulates" : undefined}
                  className="w-full rounded-lg py-2.5 px-2 flex flex-col items-center gap-0.5 transition-all duration-300"
                  style={{
                    background: isSelected ? "#1f1f1f" : "#181818",
                    border: isSelected ? "1.5px solid #ffffff" : "1px solid #27272a",
                  }}
                >
                  <span className="text-xs font-black uppercase tracking-widest" style={{ color: "#71717a" }}>{m}</span>
                  <span className="text-xl font-bold tabular-nums leading-tight" style={{ color: "#ffffff" }}>
                    {m === "spread" ? (displaySpread !== null ? `-${displaySpread}` : "—") : (displayLine ?? "—")}
                  </span>
                  <span className="text-sm font-semibold" style={{ color: isNeutral ? "#52525b" : mColor }}>
                    {isNeutral ? "--" : `${mProb.toFixed(1)}%`}
                  </span>
                </button>
                <button
                  data-testid={`ncaab-parlay-toggle-${m}-${play.gameId}`}
                  onClick={(e) => { e.stopPropagation(); toggleLeg(m); addParlayPick(m); }}
                  title={isParlayed ? "Remove from parlay" : "Add to parlay"}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black transition-all duration-200"
                  style={{
                    background: isParlayed ? "#f59e0b" : "#27272a",
                    color: isParlayed ? "#000" : "#a1a1aa",
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
          ].filter(p => p.label !== "—").map(({ label, book, url }) => {
            const bookLineText = book
              ? (marketTab === "h1"
                  ? (book.h1Total != null ? `H1 O/U ${book.h1Total}` : "H1 Lines TBD")
                  : (book.total != null ? `O/U ${book.total}` : "—"))
              : "—";
            return (
              <button
                key={label}
                data-testid={`ncaab-book-pill-${label}-${play.gameId}`}
                onClick={() => window.open(url, "_blank")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all duration-300"
                style={{ background: "#181818", border: "1px solid #27272a", color: "#a1a1aa" }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = "#00d4aa")}
                onMouseLeave={e => (e.currentTarget.style.borderColor = "#27272a")}
              >
                <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
                </span>
                <span style={{ color: "#ffffff", fontWeight: 700 }}>{label}</span>
                <span style={{ color: "#52525b" }}>·</span>
                <span style={{ color: "#a1a1aa" }}>{bookLineText}</span>
              </button>
            );
          })}
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

// ── Group games by tipoff time ────────────────────────────────────────────────
function groupGamesByTipoff(games: NCAABGame[]) {
  const groups: Record<string, { key: string; label: string; tipoffMs: number; games: NCAABGame[] }> = {};
  for (const g of games) {
    if (g.isLive) {
      if (!groups["__live__"]) groups["__live__"] = { key: "__live__", label: "Live Now", tipoffMs: 0, games: [] };
      groups["__live__"].games.push(g);
      continue;
    }
    const d = g.startTime ? new Date(g.startTime) : null;
    if (!d || isNaN(d.getTime())) {
      if (!groups["__tbd__"]) groups["__tbd__"] = { key: "__tbd__", label: "TBD", tipoffMs: Infinity, games: [] };
      groups["__tbd__"].games.push(g);
      continue;
    }
    const label = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
    if (!groups[label]) groups[label] = { key: label, label: label + " CT", tipoffMs: d.getTime(), games: [] };
    groups[label].games.push(g);
  }
  return Object.values(groups).sort((a, b) => a.tipoffMs - b.tipoffMs);
}

function NCAABGamesStrip({
  games,
  expandedGameId,
  onChipClick,
}: {
  games: NCAABGame[];
  expandedGameId: string | null;
  onChipClick: (id: string) => void;
}) {
  const liveCount = games.filter(g => g.isLive).length;
  const allFinal  = games.length > 0 && games.every(g => g.status === "Final");
  const timeGroups = groupGamesByTipoff(games);

  const initializedKeys = useRef<Set<string>>(new Set());

  const computeInitialOpen = useCallback((groupKey: string, group: { key: string; tipoffMs: number; games: NCAABGame[] }): boolean => {
    const now = Date.now();
    const hasLive   = group.key === "__live__" || group.games.some(g => g.isLive);
    const diffHours = (group.tipoffMs - now) / 3_600_000;
    return hasLive || (diffHours >= 0 && diffHours <= 2);
  }, []);

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    groupGamesByTipoff(games).forEach(group => {
      initializedKeys.current.add(group.key);
      initial[group.key] = computeInitialOpen(group.key, group);
    });
    return initial;
  });

  useEffect(() => {
    const newKeys = timeGroups.filter(g => !initializedKeys.current.has(g.key));
    if (newKeys.length === 0) return;
    setOpenGroups(prev => {
      const next = { ...prev };
      newKeys.forEach(group => {
        initializedKeys.current.add(group.key);
        next[group.key] = computeInitialOpen(group.key, group);
      });
      return next;
    });
  }, [timeGroups.map(g => g.key).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleGroup = (key: string) =>
    setOpenGroups(prev => ({ ...prev, [key]: !prev[key] }));

  const renderChip = (g: NCAABGame) => {
    const isSelected  = expandedGameId === g.id;
    const isFinal     = g.status === "Final";
    const isScheduled = !g.isLive && !isFinal;
    const tipoffTime  = g.startTime
      ? new Date(g.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
      : null;
    return (
      <button
        key={g.id}
        data-testid={`ncaab-chip-${g.id}`}
        onClick={() => onChipClick(g.id)}
        style={{
          minWidth: 160,
          maxWidth: 200,
          background: isSelected ? "#1f1f1f" : "#111111",
          border: isSelected
            ? "1.5px solid #00d4aa"
            : g.isLive
            ? "1px solid rgba(0,212,170,0.2)"
            : "1px solid #27272a",
          borderRadius: 8,
          padding: "8px 14px",
          cursor: "pointer",
          transition: "all 150ms ease",
          textAlign: "left",
          flexShrink: 0,
        }}
        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.borderColor = "#3f3f46"; }}
        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.borderColor = g.isLive ? "rgba(0,212,170,0.2)" : "#27272a"; }}
      >
        {/* Team row */}
        <div className="flex items-center justify-between gap-1.5">
          <span
            className="text-xs font-bold"
            style={{ color: "#ffffff", maxWidth: 70, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}
          >
            {g.awayTeamAbbr}
          </span>
          <span
            className="text-xs font-bold tabular-nums"
            style={{ color: isFinal ? "#71717a" : isScheduled ? "#3b82f6" : "#ffffff", flexShrink: 0 }}
          >
            {g.awayScore} – {g.homeScore}
          </span>
          <span
            className="text-xs font-bold"
            style={{ color: "#ffffff", maxWidth: 70, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block", textAlign: "right" }}
          >
            {g.homeTeamAbbr}
          </span>
        </div>
        {/* Status row */}
        <div className="flex items-center gap-1 mt-1">
          {g.isLive && (
            <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
            </span>
          )}
          <span
            className="text-[10px] font-medium"
            style={{ color: g.isLive ? "#4ade80" : isFinal ? "#52525b" : "#71717a" }}
          >
            {g.isLive
              ? `H${g.period} ${g.clock}`
              : isFinal
              ? "Final"
              : tipoffTime ?? "Scheduled"}
          </span>
        </div>
      </button>
    );
  };

  return (
    <div>
      {/* ── Strip header ───────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {liveCount > 0 && (
            <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
            </span>
          )}
          <span
            className="text-xs font-semibold uppercase tracking-wider"
            style={{ color: allFinal ? "#71717a" : "#a1a1aa" }}
          >
            {allFinal ? "TODAY'S SLATE · FINAL" : "TODAY'S GAMES"}
          </span>
          {games.length > 0 && (
            <span style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 9999,
              padding: "1px 8px",
              color: "#a1a1aa",
              fontSize: 11,
              fontFamily: "monospace",
            }}>
              · {games.length}
            </span>
          )}
        </div>
        {liveCount > 0 && (
          <span style={{ color: "#4ade80", fontSize: 11, fontWeight: 500 }}>
            ● {liveCount} Live
          </span>
        )}
      </div>

      {/* ── Time-group collapsible sections ────────────────────────────────── */}
      {games.length === 0 ? null : (
        <div className="space-y-1">
          {timeGroups.map(group => {
            const isOpen      = openGroups[group.key] ?? false;
            const groupIsLive = group.key === "__live__" || group.games.some(g => g.isLive);
            const groupIsFinal = group.games.every(g => g.status === "Final");
            return (
              <div key={group.key}>
                {/* Group header */}
                <button
                  data-testid={`ncaab-strip-group-${group.key}`}
                  onClick={() => toggleGroup(group.key)}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", padding: "5px 0", marginBottom: isOpen ? 6 : 0 }}
                >
                  {/* Left: dot + label */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    {groupIsLive && (
                      <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
                      </span>
                    )}
                    <span
                      className="text-xs font-semibold uppercase tracking-wider"
                      style={{ color: groupIsLive ? "#4ade80" : groupIsFinal ? "#52525b" : "#71717a" }}
                    >
                      {group.label}
                    </span>
                  </div>
                  {/* Center divider */}
                  <div style={{ flex: 1, height: 1, background: "#27272a" }} />
                  {/* Right: count + chevron */}
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    {groupIsLive ? (
                      <span style={{ background: "rgba(74,222,128,0.15)", border: "1px solid rgba(74,222,128,0.3)", borderRadius: 9999, padding: "1px 6px", color: "#4ade80", fontSize: 10, fontWeight: 500 }}>
                        {group.games.length} Live
                      </span>
                    ) : (
                      <span className="text-xs" style={{ color: "#52525b" }}>{group.games.length} games</span>
                    )}
                    <ChevronDown
                      size={12}
                      style={{ color: "#52525b", transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 200ms ease" }}
                    />
                  </div>
                </button>
                {/* Chips row — collapsible */}
                {isOpen && (
                  <div className="overflow-x-auto pb-2 mb-1" style={{ scrollbarWidth: "none" }}>
                    <div className="flex gap-2" style={{ minWidth: "max-content" }}>
                      {group.games.map(g => renderChip(g))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Grouped Games List ────────────────────────────────────────────────────────
function GroupedGamesList({
  games,
  plays,
  rowRefs,
  expandedGameId,
  onExpandGame,
  onH2hReady,
  onAddToParlay,
  shiftedGames,
  onShiftDetected,
}: {
  games: NCAABGame[];
  plays: NCAABPlay[];
  rowRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  expandedGameId: string | null;
  onExpandGame: (id: string | null) => void;
  onH2hReady: (gameId: string, data: H2HGame[]) => void;
  onAddToParlay?: (pick: ParlayPickInput) => void;
  shiftedGames: Record<string, boolean>;
  onShiftDetected?: (gameId: string) => void;
}) {
  if (games.length === 0) {
    return <p className="text-xs" style={{ color: "#71717a" }}>No games found in today's slate.</p>;
  }

  const groupMap: Record<string, { games: NCAABGame[]; rawTime: string }> = {};
  for (const g of games) {
    const key = formatTipoffTime(g.startTime ?? "");
    if (!groupMap[key]) groupMap[key] = { games: [], rawTime: g.startTime ?? "" };
    groupMap[key].games.push(g);
  }

  const sortedGroups = Object.entries(groupMap).sort(([, a], [, b]) =>
    new Date(a.rawTime || 0).getTime() - new Date(b.rawTime || 0).getTime()
  );

  const sortGroup = (gs: NCAABGame[]) => [
    ...gs.filter(g => g.isLive),
    ...gs.filter(g => !g.isLive && g.status !== "Final"),
    ...gs.filter(g => g.status === "Final"),
  ];

  return (
    <div className="space-y-4">
      {sortedGroups.map(([timeLabel, { games: groupGames }]) => (
        <div key={timeLabel}>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "#52525b" }}>
              {timeLabel}
            </span>
            <div className="flex-1 h-px" style={{ background: "#3f3f46" }} />
          </div>
          <div className="space-y-1.5">
            {sortGroup(groupGames).map(g => {
              const isExpanded = expandedGameId === g.id;
              // T001: all non-Final rows are clickable (live + scheduled)
              const canExpand  = g.status !== "Final";
              const matchedPlay = plays.find(p => p.gameId === g.id);
              return (
                <div key={g.id}>
                  <div
                    ref={el => { rowRefs.current[g.id] = el; }}
                    data-testid={`ncaab-game-row-${g.id}`}
                    className={`scroll-mt-24 flex items-center justify-between px-4 py-3 rounded-lg transition-all duration-200 ${canExpand ? "cursor-pointer" : "cursor-default"}`}
                    style={{
                      background: isExpanded ? "#141414" : "#111111",
                      border: `1px solid ${isExpanded ? "#3f3f46" : "#27272a"}`,
                      borderRadius: isExpanded ? "8px 8px 0 0" : "8px",
                    }}
                    onClick={() => canExpand && onExpandGame(isExpanded ? null : g.id)}
                    onMouseEnter={e => canExpand && !isExpanded && (e.currentTarget.style.borderColor = "#52525b")}
                    onMouseLeave={e => canExpand && !isExpanded && (e.currentTarget.style.borderColor = "#27272a")}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-white truncate">
                        {g.awayTeam} <span style={{ color: "#52525b" }}>@</span> {g.homeTeam}
                      </p>
                      {(g.isLive || g.status === "Final") && (
                        <p className="text-xs tabular-nums" style={{ color: "#71717a" }}>
                          {g.awayScore} – {g.homeScore}
                        </p>
                      )}
                    </div>
                    {/* Status — conditionally swap (item 2): ShiftBadge for 6s on direction change */}
                    <div className="shrink-0 ml-3">
                      {shiftedGames[g.id] ? (
                        <ShiftBadge />
                      ) : g.isLive ? (
                        <div className="flex items-center gap-1.5">
                          <span className="relative flex h-2 w-2 flex-shrink-0">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
                          </span>
                          <span className="text-[11px] font-semibold" style={{ color: "#4ade80" }}>
                            Live{g.period > 0 ? ` · H${g.period}` : ""} {g.clock}
                          </span>
                        </div>
                      ) : g.status === "Final" ? (
                        <span className="text-[11px] font-medium" style={{ color: "#52525b" }}>Final</span>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px]" style={{ color: "#52525b" }}>Scheduled</span>
                          <ChevronDown
                            className="w-3 h-3 transition-transform duration-200"
                            style={{ color: "#3f3f46", transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)" }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  {/* T001: Live game row — inline NCAABGameCard */}
                  {isExpanded && g.isLive && matchedPlay && (
                    <NCAABGameCard
                      play={matchedPlay}
                      onAddToParlay={onAddToParlay}
                      h2hDataFromCache={null}
                      isNewlyLive={false}
                      onShiftDetected={onShiftDetected}
                    />
                  )}
                  {/* T001: Live game with no play data yet — loading placeholder */}
                  {isExpanded && g.isLive && !matchedPlay && (
                    <div className="rounded-b-xl p-4 animate-pulse" style={{ background: "#0a0a0a", border: "1px solid #27272a", borderTop: "none" }}>
                      <div className="h-3 rounded w-1/3 mb-2" style={{ background: "#27272a" }} />
                      <div className="h-3 rounded w-1/2" style={{ background: "#1e1e1e" }} />
                    </div>
                  )}
                  {/* Pre-game card expansion for scheduled games */}
                  {isExpanded && !g.isLive && g.status !== "Final" && (
                    <PreGameCard
                      game={g}
                      onH2hReady={onH2hReady}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── PreGameCard (item 2, 3, 4, 6) ─────────────────────────────────────────────
// Shows for scheduled games that the user has expanded. Has countdown + H2H (open by default).
function PreGameCard({
  game,
  onH2hReady,
}: {
  game: NCAABGame;
  onH2hReady: (gameId: string, data: H2HGame[]) => void;
}) {
  const [countdown, setCountdown] = useState("");
  const [timerState, setTimerState] = useState<"countdown" | "live">("countdown");
  const [h2hData, setH2hData] = useState<H2HGame[] | null>(null);
  const [h2hOpen, setH2hOpen] = useState(true); // item 3: expanded by default in pre-game
  const [headerFlash, setHeaderFlash] = useState(false);
  const didFireZero = useRef(false);

  // Countdown timer
  useEffect(() => {
    const tick = () => {
      const diff = new Date(game.startTime).getTime() - Date.now();
      if (diff <= 0 && !didFireZero.current) {
        didFireZero.current = true;
        setTimerState("live");
        setH2hOpen(false); // item 3: collapse H2H on transition
        setHeaderFlash(true); // item 6: brief teal flash on header
        setTimeout(() => setHeaderFlash(false), 200);
      } else if (diff > 0) {
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        setCountdown(h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [game.startTime]);

  // Fetch H2H once on mount — cache result in parent (item 2)
  useEffect(() => {
    fetch(`/api/ncaab/h2h?gameId=${game.id}`)
      .then(r => r.ok ? r.json() : { games: [] })
      .then(data => {
        const games: H2HGame[] = data.games ?? [];
        setH2hData(games);
        onH2hReady(game.id, games); // cache in parent
      })
      .catch(() => {
        setH2hData([]);
        onH2hReady(game.id, []);
      });
  }, [game.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      data-testid={`ncaab-pregame-card-${game.id}`}
      className="rounded-xl p-4 space-y-3 mt-1.5"
      style={{
        background: "#0a0a0a",
        border: "1px solid #27272a",
        boxShadow: headerFlash ? "0 0 0 2px rgba(0,212,170,0.45)" : undefined,
        transition: "box-shadow 200ms ease",
      }}
    >
      {/* Header with countdown (item 6: flash glow at zero) */}
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-white truncate">
            {game.awayTeam} <span style={{ color: "#52525b" }}>@</span> {game.homeTeam}
          </p>
          <p className="text-[10px] mt-0.5" style={{ color: "#52525b" }}>
            {formatTipoffTime(game.startTime)}
          </p>
        </div>
        <div className="shrink-0 ml-3 text-right">
          {timerState === "countdown" ? (
            <>
              <p className="text-[10px] uppercase tracking-wide" style={{ color: "#52525b" }}>Tipoff in</p>
              <p className="text-lg font-black tabular-nums" style={{ color: "#00d4aa" }}>{countdown}</p>
            </>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
              </span>
              <span className="text-xs font-bold" style={{ color: "#4ade80" }}>LIVE · Activating…</span>
            </div>
          )}
        </div>
      </div>

      {/* H2H section (item 3: open by default, collapses on transition) */}
      <H2HSection h2hData={h2hData} h2hOpen={h2hOpen} setH2hOpen={setH2hOpen} />
    </div>
  );
}

interface NCAABAdminTabProps {
  onAddToParlay?: (pick: ParlayPickInput) => void;
  isAdmin?: boolean;
  expandToGameId?: string | null;
}

export function NCAABAdminTab({ onAddToParlay, expandToGameId }: NCAABAdminTabProps) {
  const [ncaabSubTab, setNcaabSubTab] = useState<"live" | "halftime">("live");

  // ── Toast state (build step 1: queue + stacking + dismiss timers) ────────────
  const [toasts, setToasts]                 = useState<ToastItem[]>([]);
  const toastTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // ── Summary state (build step 3–6) ──────────────────────────────────────────
  const [lastSlateDate, setLastSlateDate]   = useState<string | null>(null);
  const [summaryGames, setSummaryGames]     = useState<SummaryGame[]>([]);
  const [expandedSummaryId, setExpandedSummaryId] = useState<string | null>(null);

  // Row refs for "View Game" scroll (build step 2) ──────────────────────────────
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // H2H expansion + cache
  const [expandedGameId, setExpandedGameId] = useState<string | null>(null);
  const h2hCache = useRef<Record<string, H2HGame[]>>({});
  const [newlyLiveIds, setNewlyLiveIds]     = useState<Set<string>>(new Set());

  // shiftedGames (item 1): { [gameId]: boolean } — 6s auto-clear
  const [shiftedGames, setShiftedGames] = useState<Record<string, boolean>>({});

  const handleShiftDetected = useCallback((gameId: string) => {
    setShiftedGames(prev => ({ ...prev, [gameId]: true }));
    setTimeout(() => {
      setShiftedGames(prev => ({ ...prev, [gameId]: false }));
    }, 6000);
  }, []);

  const handleChipClick = useCallback((gameId: string) => {
    setExpandedGameId(prev => prev === gameId ? null : gameId);
    setTimeout(() => {
      rowRefs.current[gameId]?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }, []);

  const handleExpandGame = (id: string | null) => { if (id) handleChipClick(id); };

  // Expand a game from outside (e.g. welcome banner Explore flow)
  useEffect(() => {
    if (!expandToGameId) return;
    setExpandedGameId(expandToGameId);
    setTimeout(() => {
      rowRefs.current[expandToGameId]?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
  }, [expandToGameId]);

  const handleH2hReady = useCallback((gameId: string, data: H2HGame[]) => {
    h2hCache.current[gameId] = data;
  }, []);

  // Previous state refs for transition detection ────────────────────────────────
  const prevGamesRef = useRef<NCAABGame[]>([]);
  const prevPlaysRef = useRef<NCAABPlay[]>([]);

  const playsQuery = useQuery<{ plays: NCAABPlay[] }>({
    queryKey: ["/api/ncaab/plays"],
    refetchInterval: 60 * 1000,
  });

  const gamesQuery = useQuery<{ games: NCAABGame[] }>({
    queryKey: ["/api/ncaab/games"],
    refetchInterval: 90 * 1000,
  });

  const plays   = playsQuery.data?.plays ?? [];
  const games   = gamesQuery.data?.games ?? [];
  const loading = playsQuery.isLoading || gamesQuery.isLoading;
  const error   = playsQuery.error ?? gamesQuery.error;

  const liveGames     = games.filter(g => g.isLive);
  const hasPlays      = plays.length > 0;
  const halftimePlays = plays.filter(p => p.bettingWindow === "HALFTIME");

  // ── Day reset (build step 6: lastSlateDate reset logic) ─────────────────────
  useEffect(() => {
    const today = new Date().toDateString();
    if (lastSlateDate && lastSlateDate !== today) {
      setSummaryGames([]);
      setLastSlateDate(null);
    }
  }, [lastSlateDate]);

  // ── Dismiss toast ────────────────────────────────────────────────────────────
  const dismissToast = useCallback((id: string) => {
    clearTimeout(toastTimers.current[id]);
    delete toastTimers.current[id];
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // ── Add toast (build step 1: 6s auto-dismiss, max 3 visible) ────────────────
  const addToast = useCallback((game: NCAABGame) => {
    const id = `toast-${game.id}-${Date.now()}`;
    setToasts(prev => [...prev, { id, game }].slice(-3));
    toastTimers.current[id] = setTimeout(() => dismissToast(id), 6000);
  }, [dismissToast]);

  // ── Add to summary ───────────────────────────────────────────────────────────
  const addToSummary = useCallback((game: NCAABGame, play: NCAABPlay | undefined) => {
    setSummaryGames(prev => {
      if (prev.find(s => s.gameId === game.id)) return prev;
      const line     = play?.total ?? null;
      const overProb = play?.overProb ?? null;
      const edgeGap  = overProb !== null ? Math.abs(overProb - 50) : 0;
      return [...prev, {
        gameId: game.id,
        awayTeam: game.awayTeam, homeTeam: game.homeTeam,
        awayTeamAbbr: game.awayTeamAbbr, homeTeamAbbr: game.homeTeamAbbr,
        awayScore: game.awayScore, homeScore: game.homeScore,
        line, overProb, edgeGap,
      }];
    });
  }, []);

  // ── Transition detection (Scheduled→Live → toast/flash, Live→Final → summary) ──
  useEffect(() => {
    if (games.length === 0) { prevGamesRef.current = games; prevPlaysRef.current = plays; return; }
    const prev = prevGamesRef.current;
    if (prev.length > 0) {
      // Newly live — suppress toast (item 5) when that game is expanded
      const newlyLive = games.filter(g => g.isLive && prev.find(pg => pg.id === g.id && !pg.isLive));
      newlyLive.forEach(g => {
        if (expandedGameId === g.id) return; // item 5: suppress toast for expanded game
        addToast(g);
      });
      if (newlyLive.length > 0) {
        setNewlyLiveIds(prev => {
          const next = new Set(prev);
          newlyLive.forEach(g => next.add(g.id));
          return next;
        });
        // Clear newlyLive flag after card animation (item 6)
        setTimeout(() => {
          setNewlyLiveIds(prev => {
            const next = new Set(prev);
            newlyLive.forEach(g => next.delete(g.id));
            return next;
          });
        }, 500);
      }
      // Newly final
      games
        .filter(g => g.status === "Final" && prev.find(pg => pg.id === g.id && pg.isLive))
        .forEach(g => addToSummary(g, prevPlaysRef.current.find(p => p.gameId === g.id)));
      // All-final check (build step 6)
      if (games.every(g => g.status === "Final")) {
        setLastSlateDate(new Date().toDateString());
      }
    }
    prevGamesRef.current = games;
    prevPlaysRef.current = plays;
  }, [games, plays, addToast, addToSummary, expandedGameId]);

  // ── Summary computed stats (build step 5: W/L counter) ──────────────────────
  const summaryResults = summaryGames.map(g => ({ ...g, result: determineResult(g) }));
  const wins   = summaryResults.filter(r => r.result === "HIT").length;
  const losses = summaryResults.filter(r => r.result === "MISS").length;
  const allFinal   = games.length > 0 && games.every(g => g.status === "Final");
  const showSummary = summaryGames.length > 0;
  const today = new Date();
  const dateLabel = today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  // ── View Game handler (build step 2) ─────────────────────────────────────────
  const handleViewGame = useCallback((gameId: string, toastId: string) => {
    dismissToast(toastId);
    setTimeout(() => {
      rowRefs.current[gameId]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
  }, [dismissToast]);

  return (
    <>
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
          {/* Slate complete banner */}
          {allFinal && games.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: "rgba(0,212,170,0.08)", border: "1px solid rgba(0,212,170,0.2)" }}>
              <CheckCircle className="w-4 h-4 shrink-0" style={{ color: "#00d4aa" }} />
              <span className="text-xs font-semibold" style={{ color: "#00d4aa" }}>Slate Complete</span>
            </div>
          )}

          {/* Live play cards */}
          {hasPlays && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                <p className="text-sm font-semibold text-foreground">
                  {plays.length} Live {plays.length === 1 ? "Game" : "Games"} — Computed Plays
                </p>
              </div>
              {plays.map(p => (
                <NCAABGameCard
                  key={p.gameId}
                  play={p}
                  onAddToParlay={onAddToParlay}
                  h2hDataFromCache={h2hCache.current[p.gameId] ?? null}
                  isNewlyLive={newlyLiveIds.has(p.gameId)}
                  onShiftDetected={handleShiftDetected}
                />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!hasPlays && !error && (
            <div className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
              <Clock className="w-8 h-8 text-muted-foreground mx-auto" />
              <p className="text-sm font-semibold text-foreground">No Live NCAAB Games Right Now</p>
              <p className="text-xs text-muted-foreground">
                The model will activate automatically when games go live. Check back during game time.
              </p>
            </div>
          )}

          {/* ── Daily Results Summary (build steps 3–5) ────────────────────── */}
          {showSummary && (
            <div className="space-y-3 rounded-xl overflow-hidden" style={{ border: "1px solid #27272a" }}>
              {/* Header */}
              <div className="flex items-center justify-between px-4 pt-4">
                <p className="text-sm font-bold text-white">Today's Results</p>
                <p className="text-xs" style={{ color: "#71717a" }}>{dateLabel}</p>
              </div>

              {/* Engine record (build step 5) */}
              <div className="px-4 pb-2 flex items-center gap-2">
                <p className="text-xs" style={{ color: "#52525b" }}>Engine Record:</p>
                <span className="text-sm font-black" style={{ color: "#00d4aa" }}>{wins}W</span>
                <span className="text-sm font-black" style={{ color: "#71717a" }}>–</span>
                <span className="text-sm font-black" style={{ color: "#ef4444" }}>{losses}L</span>
                <span className="text-[10px] ml-1" style={{ color: "#52525b" }}>· Dominant side at final whistle</span>
              </div>

              {/* Results grid (build step 4) */}
              <div className="space-y-px">
                {summaryResults.map(r => {
                  const isExpanded = expandedSummaryId === r.gameId;
                  const engineCall = (r.overProb ?? 50) > 50 ? "under" : "over";
                  const callLabel  = r.line !== null
                    ? `${engineCall === "under" ? "Under" : "Over"} ${r.line}`
                    : "—";
                  const callColor  = engineCall === "under" ? "#ef4444" : "#00d4aa";
                  const borderColor = r.result === "HIT" ? "#00d4aa" : r.result === "MISS" ? "#ef4444" : "#52525b";
                  const badgeStyle = r.result === "HIT"
                    ? { background: "rgba(0,212,170,0.15)", color: "#00d4aa", border: "1px solid rgba(0,212,170,0.3)" }
                    : r.result === "MISS"
                    ? { background: "rgba(239,68,68,0.15)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.3)" }
                    : { background: "#27272a", color: "#71717a", border: "1px solid #3f3f46" };

                  return (
                    <div
                      key={r.gameId}
                      data-testid={`ncaab-summary-row-${r.gameId}`}
                      className="cursor-pointer transition-all duration-200"
                      style={{ background: "#111111", borderLeft: `3px solid ${borderColor}` }}
                      onClick={() => setExpandedSummaryId(isExpanded ? null : r.gameId)}
                    >
                      <div className="flex items-center justify-between px-4 py-3 gap-3">
                        {/* Left */}
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-white truncate">{r.awayTeam} @ {r.homeTeam}</p>
                          <p className="text-[11px] tabular-nums" style={{ color: "#71717a" }}>
                            {r.awayScore} – {r.homeScore}
                          </p>
                        </div>
                        {/* Center: engine call */}
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded shrink-0"
                          style={{ background: `${callColor}22`, color: callColor, border: `1px solid ${callColor}44` }}>
                          {callLabel}
                        </span>
                        {/* Right: result badge + edge */}
                        <div className="flex flex-col items-end gap-0.5 shrink-0">
                          <span className="text-[10px] font-black px-2 py-0.5 rounded" style={badgeStyle}>
                            {r.result}
                          </span>
                          {r.edgeGap > 0 && (
                            <span className="text-[9px] font-semibold" style={{ color: "#f59e0b" }}>
                              +{r.edgeGap.toFixed(1)}pp
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Summary footer */}
              <div className="flex items-center justify-center gap-2 px-4 py-3" style={{ borderTop: "1px solid #1a1a1a" }}>
                <CheckCircle className="w-3.5 h-3.5 shrink-0" style={{ color: "#00d4aa" }} />
                <p className="text-[11px]" style={{ color: "#52525b" }}>
                  Slate Complete · {summaryGames.length} {summaryGames.length === 1 ? "game" : "games"} · <span style={{ color: "#00d4aa" }}>{wins}W</span> <span style={{ color: "#ef4444" }}>{losses}L</span>
                </p>
              </div>
            </div>
          )}

          {/* ── Today's Games strip — always first, outside scroll container ─ */}
          {games.length > 0 && (
            <NCAABGamesStrip
              games={games}
              expandedGameId={expandedGameId}
              onChipClick={handleChipClick}
            />
          )}

          {/* ── Grouped game list — separate from strip ─────────────────────── */}
          {games.length > 0 && (
            <GroupedGamesList
              games={games}
              plays={plays}
              rowRefs={rowRefs}
              expandedGameId={expandedGameId}
              onExpandGame={handleExpandGame}
              onH2hReady={handleH2hReady}
              onAddToParlay={onAddToParlay}
              shiftedGames={shiftedGames}
              onShiftDetected={handleShiftDetected}
            />
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

    {/* ── Toast Portal (build step 1: stacked, 6s auto-dismiss) ─────────────── */}
    {toasts.length > 0 && createPortal(
      <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", zIndex: 9999, pointerEvents: "none" }}>
        {toasts.slice(-3).map((toast, idx) => {
          const bottomPx = 24 + idx * 72;
          return (
            <div
              key={toast.id}
              data-testid={`ncaab-toast-${toast.game.id}`}
              style={{
                position: "absolute",
                bottom: `${bottomPx}px`,
                left: "50%",
                transform: "translateX(-50%)",
                minWidth: "320px",
                pointerEvents: "auto",
                background: "#18181b",
                border: "1px solid #3f3f46",
                borderRadius: "12px",
                boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                padding: "12px 14px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                transition: "bottom 200ms ease",
              }}
              onMouseEnter={() => { clearTimeout(toastTimers.current[toast.id]); }}
              onMouseLeave={() => { toastTimers.current[toast.id] = setTimeout(() => dismissToast(toast.id), 4000); }}
            >
              {/* Left section */}
              <div className="flex items-start gap-2 min-w-0">
                <span className="relative flex h-2 w-2 mt-1 flex-shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white truncate">
                    {toast.game.awayTeam} @ {toast.game.homeTeam} just tipped off
                  </p>
                  <p className="text-[10px] mt-0.5" style={{ color: "#71717a" }}>Engine activating…</p>
                </div>
              </div>
              {/* Right: View Game + Dismiss */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  data-testid={`ncaab-toast-view-${toast.game.id}`}
                  onClick={() => handleViewGame(toast.game.id, toast.id)}
                  style={{
                    background: "rgba(0,212,170,0.15)",
                    border: "1px solid rgba(0,212,170,0.35)",
                    color: "#00d4aa",
                    fontSize: "11px",
                    fontWeight: 600,
                    borderRadius: "6px",
                    padding: "3px 8px",
                    cursor: "pointer",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(0,212,170,0.25)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "rgba(0,212,170,0.15)")}
                >
                  View Game
                </button>
                <button
                  data-testid={`ncaab-toast-dismiss-${toast.game.id}`}
                  onClick={() => dismissToast(toast.id)}
                  style={{ color: "#52525b", background: "none", border: "none", cursor: "pointer", fontSize: "16px", lineHeight: 1, padding: "2px 4px" }}
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>,
      document.body
    )}
  </>
  );
}
