import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, Clock, TrendingUp, CheckCircle, ChevronDown, Info } from "lucide-react";
import type { ParlayPickInput } from "@shared/schema";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";

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

type NCAABMarketKey = "full_total" | "full_spread" | "h1_total" | "h1_spread" | "h2_total" | "h2_spread";
type MarketConfidenceTier = "ELITE" | "STRONG" | "VALUE" | "NONE";

type MarketSide = "OVER" | "UNDER" | "HOME" | "AWAY" | null;

interface NCAABMarketClient {
  available: boolean;
  marketKey: NCAABMarketKey;
  label: string;
  sportsbook: string | null;
  bookLine: number | null;
  projection: number | null;
  modelProb: number | null;
  bookImpliedProb: number | null;
  edge: number | null;
  side: MarketSide;
  confidenceTier: MarketConfidenceTier;
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
  spreadTeam: "HOME" | "AWAY" | null;
  bookLines: BookLine[];
  h1TotalLine: number | null;
  h1SpreadLine: number | null;
  h1Favorite: string;
  h2TotalLine: number | null;
  h2SpreadLine: number | null;
  h2Favorite: string;
  over2HProb: number | null;
  effectiveH2Line: number | null;
  h2OverPrice: number | null;
  h2UnderPrice: number | null;
  h2OverPct: number | null;
  h2UnderPct: number | null;
  h2LinesSource: "odds_api" | "action_network" | "derived_h1_pace" | null;
  h2EngineOverProb: number | null;
  h2BookOverImplied: number | null;
  h2BookUnderImplied: number | null;
  h2OverEdge: number | null;
  h2UnderEdge: number | null;
  h2EdgeSide: "OVER" | "UNDER" | null;
  h2Proj: number | null;
  homeGameTotalLine: number | null;
  awayGameTotalLine: number | null;
  homeGameTotalIsEstimated: boolean;
  awayGameTotalIsEstimated: boolean;
  home1HTotalLine: number | null;
  away1HTotalLine: number | null;
  espnHomeWinPct: number | null;
  espnSpreadDetails: string | null;
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
  engineOutput?: {
    gameId: string;
    sport: string;
    marketType: string;
    projectedTotal: number | null;
    projected1HTotal: number | null;
    projected2HTotal: number | null;
    projectedSpread: number | null;
    projectedTeamTotalHome: number | null;
    projectedTeamTotalAway: number | null;
    rawOverProb: number | null;
    rawUnderProb: number | null;
    rawSpreadProb: number | null;
    calibratedOverProb: number | null;
    calibratedUnderProb: number | null;
    calibratedSpreadProb: number | null;
    over1HProb: number | null;
    over2HProb: number | null;
    impliedBookOverProb: number | null;
    impliedBookUnderProb: number | null;
    edgePctOver: number | null;
    edgePctUnder: number | null;
    edgePctSpread: number | null;
    recommendedSide: "OVER" | "UNDER" | "NO_EDGE";
    confidenceTier: "HIGH" | "MEDIUM" | "LOW" | "NO_EDGE";
    explanationBullets: string[];
    dominantMarket: "over" | "under" | "spread";
    displayProjection: string;
    displayProbability: string;
    displayPick: string;
    marketVerdicts: Array<{
      market: string;
      projection: number | null;
      line: number | null;
      overProb: number | null;
      underProb: number | null;
      side: "OVER" | "UNDER" | "NO_EDGE";
      confidenceTier: string;
      edge: number | null;
    }>;
    markets: Record<NCAABMarketKey, NCAABMarketClient>;
    displayOutput: {
      projectedTotal: string;
      projectedSpread: string;
      overProb: string;
      underProb: string;
      spreadProb: string;
      recommendedSide: string;
      confidenceTier: string;
      displayProbability: string;
      edgeLabelOver: string;
      edgeLabelUnder: string;
      edgeLabelSpread: string;
      preGameConfidenceLabel: string;
      explanationBullets: string[];
      warnings: string[];
    };
    warnings: string[];
    engineGeneratedAt: number;
  };
  engineGeneratedAt?: number;
}

export type { ParlayPickInput as NCAABParlayPick };


interface TorvikStats {
  adjO: number; adjD: number; tempo: number;
  efgPct: number; tovPct: number; orbPct: number; ftRate: number;
  barthag: number; rank: number; source: string;
}
interface TorvikTeamDetail {
  homeAdjO: number | null; homeAdjD: number | null;
  awayAdjO: number | null; awayAdjD: number | null;
  last10: string | null; source: string;
}
interface CBBReferenceData {
  wins: number | null; losses: number | null;
  srs: number | null; sos: number | null;
  confRecord: string | null; source: string;
}
interface ActionNetworkData {
  overPct: number | null; underPct: number | null;
  overMoney: number | null; underMoney: number | null;
  total: number | null; openTotal: number | null;
  spread: number | null; openSpread: number | null;
  homeSpreadPct: number | null; awaySpreadPct: number | null;
  source: string;
}
interface VegasInsiderData { openTotal: number | null; currentTotal: number | null; movement: number | null; source: string; }
interface InjuredPlayer { name: string; team: string; position: string; injury: string; status: string; }
interface InjuryImpact { injuries: InjuredPlayer[]; out: number; hasKeyPlayerOut: boolean; summary: string; }
interface PlayerPropLine { playerName: string; team: string; stat: string; line: number; }
interface PropsImplied {
  homeProj: number | null; awayProj: number | null;
  homePlayerCount: number; awayPlayerCount: number;
  source: string;
}
interface TeamRankingsStats { ppg: number; oppPpg: number; }
interface TeamRankingsData {
  home: TeamRankingsStats | null; away: TeamRankingsStats | null;
  impliedTotal: number | null; source: string;
}
interface CompositeSignal { name: string; projTotal: number | null; weight: number; diff: number; }
interface CompositeEngineResult {
  overProb: number; underProb: number; projTotal: number | null;
  signals: CompositeSignal[]; sourceCount: number; sourceSummary: string;
}
interface EnrichedGameData {
  homeTeam: string; awayTeam: string;
  torvik: { home: TorvikStats | null; away: TorvikStats | null };
  torvikDetail: { home: TorvikTeamDetail | null; away: TorvikTeamDetail | null };
  cbbRef: { home: CBBReferenceData | null; away: CBBReferenceData | null };
  actionNetwork: ActionNetworkData | null;
  vegasInsider: VegasInsiderData | null;
  prizePicks: PropsImplied | null;
  underdog: PropsImplied | null;
  teamRankings: TeamRankingsData | null;
  injuries: { home: InjuryImpact | null; away: InjuryImpact | null; all: InjuredPlayer[] };
  composite: CompositeEngineResult | null;
  sources: string[];
  fetchedAt: number;
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
  startTime: string;
  isHalftime: boolean;
  isInProgress: boolean;
  isLive: boolean;
  enginePreGame?: { overProb: number; underProb: number } | null;
  odds?: { homeWinPct: number | null; spreadDetails: string | null; overUnder: number | null } | null;
  competitions?: Array<{ competitors: Array<{ homeAway: string; team: { abbreviation: string } }> }> | null;
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

interface ChipOddsData {
  overUnder: number | null;
  homeWinPct: number | null;
  spreadDetails: string | null;
  fetching?: boolean;
}

interface SharpMoneyResult {
  detected: true;
  sharpSide: "home" | "away";
  gap: number;
  strength: number;
  label: string;
  teamName: string;
}

// ── NCAAB REFRESH AUDIT ──────────────────────────────────────────────────────
// Current interval: dynamic (20s live / 15s halftime / 60s upcoming / 180s idle)
// Fetch function: /api/ncaab/plays (playsQuery) + /api/ncaab/games (gamesQuery)
// Trigger conditions: dynamic self-rescheduling via refetchInterval function + visibilitychange
// ESPN endpoint used: site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard

function normalizeGameStatus(game: NCAABGame): "in_progress" | "halftime" | "final" | "scheduled" {
  if (game.isHalftime) return "halftime";
  if (game.isInProgress || game.isLive) return "in_progress";
  const s = (game.status ?? "").toLowerCase();
  if (s.includes("final")) return "final";
  return "scheduled";
}

function getRefreshInterval(games: NCAABGame[]): number {
  const hasHalftime = games.some(g => normalizeGameStatus(g) === "halftime");
  const hasLive     = games.some(g => normalizeGameStatus(g) === "in_progress");
  const hasUpcoming = games.some(g => {
    if (!g.startTime) return false;
    const minsUntil = (new Date(g.startTime).getTime() - Date.now()) / 60000;
    return minsUntil <= 30 && minsUntil > 0;
  });
  if (hasHalftime) return 15000;
  if (hasLive)     return 20000;
  if (hasUpcoming) return 60000;
  return 180000;
}

function isMarchMadness(games: NCAABGame[]): boolean {
  const month = new Date().getMonth();
  if (month < 2 || month > 3) return false;
  return games.some(g =>
    g.name?.toLowerCase().includes("tournament") ||
    g.name?.toLowerCase().includes("march madness") ||
    g.shortName?.toLowerCase().includes("ncaa")
  );
}

function getTournamentAwareInterval(games: NCAABGame[]): number {
  if (isMarchMadness(games)) {
    const hasActive = games.some(g => g.isLive || g.isHalftime);
    return hasActive ? 15000 : 30000;
  }
  return getRefreshInterval(games);
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
        {h2hData !== null && h2hData.length > 0 && h2hData.every(g => g.total === null) && (
          <div className="px-3 py-2 text-center" style={{ borderTop: "1px solid #1a1a1a" }}>
            <p className="text-[10px] italic" style={{ color: "#52525b" }}>O/U lines not available for this matchup.</p>
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
                {g.total !== null && (
                  <div className="text-right">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                      style={{ background: ouBg, color: ouColor, border: `1px solid ${ouBorder}` }}>
                      {ouResult}
                    </span>
                    <p className="text-[9px] mt-0.5" style={{ color: "#3f3f46" }}>O/U: {g.total}</p>
                  </div>
                )}
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
  fanduel:         "FD",
  draftkings:      "DK",
  hardrockbet:     "HRB",
  fanatics:        "FAN",
  prizepicks:      "PP",
  underdogfantasy: "UD",
};

const BOOK_URLS: Record<string, string> = {
  draftkings:      "https://sportsbook.draftkings.com",
  fanduel:         "https://sportsbook.fanduel.com",
  hardrockbet:     "https://www.hardrock.bet",
  fanatics:        "https://sportsbook.fanatics.com",
  prizepicks:      "https://app.prizepicks.com",
  underdogfantasy: "https://underdogfantasy.com",
};

const WINDOW_COLORS: Record<string, string> = {
  "1H_WINDOW":   "text-blue-400 bg-blue-500/10 border-blue-500/30",
  "HALFTIME":    "text-green-400 bg-green-500/10 border-green-500/30",
  "LATE_WINDOW": "text-orange-400 bg-orange-500/10 border-orange-500/30",
  "NONE":        "text-muted-foreground bg-secondary border-border",
};

function getConfidenceTier(prob: number | null): { label: string; color: string; bg: string; border: string } | null {
  if (prob == null) return null;
  const confidence = Math.max(prob, 100 - prob);
  if (confidence >= 85) return { label: "Elite", color: "#00d4aa", bg: "rgba(0,212,170,0.15)", border: "rgba(0,212,170,0.3)" };
  if (confidence >= 70) return { label: "Strong", color: "#f59e0b", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.3)" };
  if (confidence >= 60) return { label: "Value", color: "#38bdf8", bg: "rgba(56,189,248,0.12)", border: "rgba(56,189,248,0.3)" };
  return null;
}

function tierDisplayFromCanonical(tier: string | null | undefined): { label: string; color: string; bg: string; border: string } | null {
  if (!tier || tier === "NONE") return null;
  if (tier === "ELITE")  return { label: "Elite",  color: "#00d4aa", bg: "rgba(0,212,170,0.15)",  border: "rgba(0,212,170,0.3)" };
  if (tier === "STRONG") return { label: "Strong", color: "#f59e0b", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.3)" };
  if (tier === "VALUE")  return { label: "Value",  color: "#38bdf8", bg: "rgba(56,189,248,0.12)", border: "rgba(56,189,248,0.3)" };
  return null;
}

const NCAAB_BOOK_OPTIONS = [
  { key: "all", abbr: "All", label: "All Books" },
  { key: "dk",  abbr: "DK",  label: "DraftKings" },
  { key: "fd",  abbr: "FD",  label: "FanDuel" },
  { key: "hr",  abbr: "HR",  label: "Hard Rock" },
  { key: "pp",  abbr: "PP",  label: "PrizePicks" },
  { key: "ud",  abbr: "UD",  label: "Underdog" },
] as const;

const ncaabBookKeyMap: Record<string, string[]> = {
  dk:  ["draftkings", "draft_kings", "dk"],
  fd:  ["fanduel", "fan_duel", "fd"],
  hr:  ["hardrockbet", "hard_rock", "hardrock"],
  pp:  ["prizepicks", "prize_picks"],
  ud:  ["underdogfantasy", "underdog_fantasy", "underdog"],
};

function filterNcaabPlaysByBook(plays: NCAABPlay[], bookKey: string): NCAABPlay[] {
  if (bookKey === "all") return plays;
  const validKeys = ncaabBookKeyMap[bookKey] ?? [bookKey];
  return plays.filter(play => {
    return play.bookLines.some(bl => validKeys.some(vk => bl.book.toLowerCase().includes(vk)));
  });
}

const TORVIK_TOOLTIPS: Record<string, string> = {
  adjO: "Adjusted Offensive Efficiency — points scored per 100 possessions, adjusted for opponent strength",
  adjD: "Adjusted Defensive Efficiency — points allowed per 100 possessions, adjusted for opponent strength",
  barthag: "Barttorvik power rating — probability of beating an average D-I team on a neutral court",
  tempo: "Tempo — average number of possessions per 40-minute game",
  srs: "Simple Rating System — margin of victory adjusted for strength of schedule",
  sos: "Strength of Schedule — average quality of opponents played this season",
};

function StatWithTooltip({ tooltip, children }: { label?: string; tooltip: string; children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-0.5 cursor-help" style={{ borderBottom: "1px dotted #3f3f46" }}>
            {children}
            <Info className="w-2.5 h-2.5 shrink-0" style={{ color: "#3f3f46" }} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[220px] text-xs" style={{ background: "#1a1a1a", border: "1px solid #3f3f46", color: "#d4d4d8" }}>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── RadialGauge ───────────────────────────────────────────────────────────────
function RadialGauge({ value, color, label, isParlayed, showFullGameLabel, displayDash, size }: {
  value: number; color: string; label: string; isParlayed: boolean; showFullGameLabel?: boolean; displayDash?: boolean; size?: "sm" | "md" | "lg";
}) {
  const cx = 80; const cy = 80;
  const rInner = 68; const rParlay = 80;
  const circInner = 2 * Math.PI * rInner;
  const pct = Math.max(0, Math.min(100, value));
  const dashOffset = circInner - (pct / 100) * circInner;
  const arcColor = displayDash ? "#52525b" : color;
  const dim = size === "sm" ? 90 : size === "lg" ? 130 : 110;
  const pctFontClass = size === "sm" ? "text-xl" : size === "lg" ? "text-4xl" : "text-3xl";
  return (
    <div className="flex flex-col items-center flex-shrink-0 gap-0.5">
      <div className="relative" style={{ width: dim, height: dim }}>
        <svg viewBox="0 0 160 160" style={{ width: dim, height: dim, transform: "rotate(-90deg)" }}>
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
            <span className={`${pctFontClass} font-black tabular-nums leading-none`} style={{ color: "#52525b" }}>--</span>
          ) : (
            <span className={`${pctFontClass} font-black tabular-nums leading-none`} style={{ color }}>
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

// ── Sharp money detection ─────────────────────────────────────────────────────
function detectSharpMoney(opts: {
  homeWinPct: number | null;
  spreadDetails: string | null;
  homeTeamName: string;
  awayTeamName: string;
}): SharpMoneyResult | null {
  const { homeWinPct, spreadDetails, homeTeamName, awayTeamName } = opts;
  if (!homeWinPct || homeWinPct <= 0) return null;
  if (!spreadDetails) return null;
  const spreadMatch = spreadDetails.match(/([+-]?\d+\.?\d*)$/);
  if (!spreadMatch) return null;
  const spreadValue = parseFloat(spreadMatch[1]);
  if (isNaN(spreadValue)) return null;
  const spreadImpliedWinPct = spreadValue < 0
    ? 53 + (Math.abs(spreadValue) * 3)
    : 53 - (Math.abs(spreadValue) * 3);
  const clamped = Math.min(Math.max(spreadImpliedWinPct, 5), 95);
  const gap = homeWinPct - clamped;
  if (Math.abs(gap) < 8) return null;
  const sharpSide = gap > 0 ? "home" : "away";
  const strength = Math.abs(gap);
  const result: SharpMoneyResult = {
    detected: true,
    sharpSide,
    gap: parseFloat(gap.toFixed(1)),
    strength,
    label: strength >= 15 ? "Strong Sharp Signal" : "Sharp Money Signal",
    teamName: sharpSide === "home" ? homeTeamName : awayTeamName,
  };
  console.log(`[SHARP] ESPN=${homeWinPct}% vs Spread=${clamped.toFixed(1)}% | gap=${result.gap}pp | ${result.label} → ${result.teamName}`);
  return result;
}

function getTeamTotalVerdict(
  direction: "over" | "under",
  isEstimated: boolean,
  engineVerdict?: { overProb: number | null; underProb: number | null; edge: number | null; side?: string; confidenceTier?: string } | null
) {
  const engineProb = engineVerdict?.overProb !== null && engineVerdict?.overProb !== undefined ? engineVerdict.overProb : 50;
  const edgeVal = engineVerdict?.edge !== null && engineVerdict?.edge !== undefined ? engineVerdict.edge : 0;
  const absEdge = Math.abs(edgeVal);
  const edgeSide: "Over" | "Under" = edgeVal > 0 ? "Over" : "Under";
  const tierFromEngine = engineVerdict?.confidenceTier;
  const sideFromEngine = engineVerdict?.side;
  const directionSide = direction === "under" ? "Under" : "Over";
  const edgeLabel = sideFromEngine === "NO_EDGE" || absEdge < 5
    ? "Neutral — No Edge"
    : tierFromEngine === "HIGH" ? `Strong ${directionSide} EV`
    : `Lean ${directionSide} EV`;
  return {
    engineProb: parseFloat(engineProb.toFixed(1)),
    bookImplied: isEstimated ? 50 : 52.4,
    edgeGap: parseFloat(absEdge.toFixed(1)),
    edgeSide,
    edgeLabel,
    isEstimated,
  };
}

// ── Pre-game confidence tier ──────────────────────────────────────────────────
const CONFIDENCE_TIER_MAP: Record<string, { label: string; sublabel: string; color: string; bg: string; border: string }> = {
  "No Edge": { label: "No Edge", sublabel: "Model sees even matchup", color: "#71717a", bg: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.08)" },
  "Low": { label: "Low Confidence", sublabel: "Slight lean — insufficient for signal", color: "#71717a", bg: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.08)" },
  "Moderate": { label: "Moderate Signal", sublabel: "Pre-game lean — monitor at tipoff", color: "#f59e0b", bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.2)" },
  "High": { label: "Strong Pre-Game Signal", sublabel: "Model has clear lean before tipoff", color: "#00d4aa", bg: "rgba(0,212,170,0.08)", border: "rgba(0,212,170,0.2)" },
  "Extreme": { label: "High Confidence", sublabel: "Significant model edge pre-game", color: "#00d4aa", bg: "rgba(0,212,170,0.12)", border: "rgba(0,212,170,0.25)" },
};

function getPreGameConfidenceTier(labelOrProb: string | number | null | undefined) {
  if (labelOrProb == null) return null;
  if (typeof labelOrProb === "string") {
    return CONFIDENCE_TIER_MAP[labelOrProb] ?? CONFIDENCE_TIER_MAP["No Edge"];
  }
  const edge = Math.abs(labelOrProb - 50);
  const key = edge < 3 ? "No Edge" : edge < 7 ? "Low" : edge < 12 ? "Moderate" : edge < 18 ? "High" : "Extreme";
  return CONFIDENCE_TIER_MAP[key];
}

// ── MarketRow: single O/U or single-side spread row ──────────────────────────
function MarketRow({
  label, line,
  overProb, underProb,
  overBookImplied, underBookImplied,
  overPrice, underPrice,
  singleSide = false,
  coverProb, bookImplied, price,
  isEstimated = false,
  onSelectOver, onSelectUnder, onSelectSide,
  isSelectedOver, isSelectedUnder, isSelectedSide,
}: {
  label: string; line: number | null;
  overProb?: number | null; underProb?: number | null;
  overBookImplied?: number | null; underBookImplied?: number | null;
  overPrice?: number | null; underPrice?: number | null;
  singleSide?: boolean;
  coverProb?: number | null; bookImplied?: number | null; price?: number | null;
  isEstimated?: boolean;
  onSelectOver?: () => void; onSelectUnder?: () => void; onSelectSide?: () => void;
  isSelectedOver?: boolean; isSelectedUnder?: boolean; isSelectedSide?: boolean;
}) {
  const calcEdge = (eng: number | null | undefined, book: number | null | undefined) =>
    eng != null && book != null ? parseFloat((eng - book).toFixed(1)) : null;
  const edgeColor = (e: number | null) => {
    if (e == null) return "#71717a";
    if (e >= 5) return "#00d4aa";
    if (e >= 2) return "#f59e0b";
    if (e <= -5) return "#ef4444";
    return "#71717a";
  };
  const fmtPrice = (p: number | null | undefined) => p != null ? ` (${p > 0 ? "+" : ""}${p})` : "";

  if (!line) return (
    <div style={{ padding: "10px 16px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ color: "#3f3f46", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{label}</span>
      <span style={{ color: "#3f3f46", fontSize: 11 }}>Unavailable</span>
    </div>
  );

  if (singleSide) {
    const edge = calcEdge(coverProb, bookImplied);
    return (
      <div
        onClick={onSelectSide}
        style={{
          padding: "10px 16px", borderBottom: "1px solid #1a1a1a",
          background: isSelectedSide ? "rgba(0,212,170,0.08)" : (edge ?? 0) >= 5 ? "rgba(0,212,170,0.04)" : "#111111",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          cursor: onSelectSide ? "pointer" : "default",
          outline: isSelectedSide ? "1.5px solid rgba(0,212,170,0.5)" : "none",
          borderRadius: isSelectedSide ? 6 : 0,
          transition: "background 120ms ease",
        }}
      >
        <div>
          <div style={{ color: "#71717a", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
            {label}{isEstimated && <span style={{ color: "#f59e0b", fontSize: 10, marginLeft: 6 }}>~est</span>}
          </div>
          {bookImplied != null && <div style={{ color: "#52525b", fontSize: 10, marginTop: 2 }}>Book: {bookImplied}%{fmtPrice(price)}</div>}
        </div>
        <div style={{ textAlign: "right" as const }}>
          <div style={{ color: "#ffffff", fontSize: 16, fontWeight: 700 }}>{(line ?? 0) > 0 ? "+" : ""}{line}</div>
          {coverProb != null && (
            <div style={{ color: edgeColor(edge), fontSize: 12, fontWeight: 600 }}>
              {coverProb}% cover{edge != null && <span style={{ fontSize: 10, marginLeft: 4 }}>{edge > 0 ? "+" : ""}{edge}pp</span>}
            </div>
          )}
        </div>
      </div>
    );
  }

  const overEdge  = calcEdge(overProb, overBookImplied);
  const underEdge = calcEdge(underProb, underBookImplied);
  return (
    <div style={{ borderBottom: "1px solid #1a1a1a", background: ((overEdge ?? 0) >= 5 || (underEdge ?? 0) >= 5) ? "rgba(0,212,170,0.03)" : "#111111" }}>
      <div style={{ padding: "6px 16px 2px", color: "#71717a", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.05em", display: "flex", alignItems: "center", gap: 6 }}>
        {label}{isEstimated && <span style={{ color: "#f59e0b", fontSize: 9 }}>~est</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, padding: "0 16px 10px" }}>
        {([
          { side: "OVER", line, prob: overProb, bookImplied: overBookImplied, price: overPrice, edge: overEdge, onSel: onSelectOver, isSel: isSelectedOver },
          { side: "UNDER", line, prob: underProb, bookImplied: underBookImplied, price: underPrice, edge: underEdge, onSel: onSelectUnder, isSel: isSelectedUnder },
        ] as const).map(({ side, line: l, prob, bookImplied: bi, price: pr, edge: e, onSel, isSel }) => (
          <div
            key={side}
            onClick={onSel}
            style={{
              background: isSel ? (side === "OVER" ? "rgba(0,212,170,0.15)" : "rgba(239,68,68,0.15)") : (e ?? 0) >= 5 ? (side === "OVER" ? "rgba(0,212,170,0.08)" : "rgba(239,68,68,0.08)") : "rgba(255,255,255,0.02)",
              borderRadius: 6, padding: "8px 10px",
              border: isSel
                ? `1.5px solid ${side === "OVER" ? "#00d4aa" : "#ef4444"}`
                : `1px solid ${(e ?? 0) >= 5 ? (side === "OVER" ? "rgba(0,212,170,0.2)" : "rgba(239,68,68,0.2)") : "#27272a"}`,
              cursor: onSel ? "pointer" : "default",
              transition: "background 120ms ease, border 120ms ease",
            }}
          >
            <div style={{ color: "#52525b", fontSize: 9, textTransform: "uppercase" as const }}>{side} {l}</div>
            {prob != null && <div style={{ color: edgeColor(e), fontSize: 18, fontWeight: 700, margin: "2px 0" }}>{prob}%</div>}
            {bi != null && <div style={{ color: "#3f3f46", fontSize: 10 }}>Book: {bi}%{fmtPrice(pr)}</div>}
            {e != null && <div style={{ color: edgeColor(e), fontSize: 10, fontWeight: 600 }}>{e > 0 ? "+" : ""}{e}pp</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── FullGameMarkets: all 5 full-game market rows ──────────────────────────────
type SelMarket = { label: string; impliedPct: number | null; enginePct: number | null; edge: number | null };
function FullGameMarkets({
  play, homeAbbr, awayAbbr, onSelect, selectedLabel,
}: {
  play: NCAABPlay; homeAbbr: string; awayAbbr: string;
  onSelect?: (m: SelMarket) => void;
  selectedLabel?: string | null;
}) {
  const ftMkt = play.engineOutput?.markets?.full_total;
  const fullTotal   = ftMkt?.available ? ftMkt.bookLine : null;
  const fsMkt = play.engineOutput?.markets?.full_spread;
  const overProb    = ftMkt?.available ? ftMkt.modelProb : null;
  const underProb   = ftMkt?.available && ftMkt.modelProb !== null ? Math.round((100 - ftMkt.modelProb) * 10) / 10 : null;
  const spreadProb  = fsMkt?.available ? fsMkt.modelProb : null;
  const spreadLine  = fsMkt?.available ? fsMkt.bookLine : null;
  const absSpread = spreadLine != null ? Math.abs(spreadLine) : null;
  const resolvedSpreadTeam: "HOME" | "AWAY" | null = play.spreadTeam
    ?? (play.favorite?.toLowerCase() === play.homeTeam?.toLowerCase() ? "HOME"
      : play.favorite?.toLowerCase() === play.awayTeam?.toLowerCase() ? "AWAY"
      : null);
  const isFavHome = resolvedSpreadTeam === "HOME";
  const isFavAway = resolvedSpreadTeam === "AWAY";
  const homeSpread  = absSpread != null
    ? (isFavHome ? -absSpread : isFavAway ? absSpread : null)
    : null;
  const awaySpread  = absSpread != null
    ? (isFavHome ? absSpread : isFavAway ? -absSpread : null)
    : null;
  if (process.env.NODE_ENV !== "production" && resolvedSpreadTeam == null && absSpread != null) {
    console.warn("Spread sign resolution — unresolved spreadTeam", {
      gameId: play.gameId,
      homeTeam: homeAbbr,
      awayTeam: awayAbbr,
      spreadTeam: play.spreadTeam,
      favorite: play.favorite,
      resolvedHomeSpread: homeSpread,
      resolvedAwaySpread: awaySpread,
    });
  }
  const homeTT      = play.homeGameTotalLine;
  const awayTT      = play.awayGameTotalLine;
  const homeTTEst   = play.homeGameTotalIsEstimated;
  const awayTTEst   = play.awayGameTotalIsEstimated;

  const sel = (label: string, eng: number | null | undefined, imp: number | null | undefined) =>
    onSelect?.({ label, enginePct: eng ?? null, impliedPct: imp ?? null, edge: eng != null && imp != null ? parseFloat((eng - imp).toFixed(1)) : null });

  const homeTTOverProb  = null;
  const homeTTUnderProb = null;
  const awayTTOverProb  = null;
  const awayTTUnderProb = null;

  return (
    <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #1f1f1f", marginTop: 8 }}>
      <div style={{ padding: "8px 16px", background: "#0f0f0f", borderBottom: "1px solid #1a1a1a" }}>
        <span style={{ color: "#52525b", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.06em", fontWeight: 600 }}>Full Game Markets</span>
      </div>
      <MarketRow label="Full Game Total" line={fullTotal} overProb={overProb} underProb={underProb}
        onSelectOver={() => sel(`Total Over ${fullTotal}`, overProb, 52.4)}
        onSelectUnder={() => sel(`Total Under ${fullTotal}`, underProb, 52.4)}
        isSelectedOver={selectedLabel === `Total Over ${fullTotal}`}
        isSelectedUnder={selectedLabel === `Total Under ${fullTotal}`}
      />
      <MarketRow label={`${homeAbbr} Spread`} line={homeSpread} singleSide coverProb={
        isFavHome ? spreadProb : isFavAway ? (spreadProb != null ? parseFloat((100 - spreadProb).toFixed(1)) : null) : null
      }
        onSelectSide={() => sel(`${homeAbbr} Spread ${homeSpread && homeSpread > 0 ? "+" : ""}${homeSpread}`,
          isFavHome ? spreadProb : isFavAway ? (spreadProb != null ? parseFloat((100 - spreadProb).toFixed(1)) : null) : null, 52.4)}
        isSelectedSide={selectedLabel === `${homeAbbr} Spread ${homeSpread && homeSpread > 0 ? "+" : ""}${homeSpread}`}
      />
      <MarketRow label={`${awayAbbr} Spread`} line={awaySpread} singleSide coverProb={
        isFavAway ? spreadProb : isFavHome ? (spreadProb != null ? parseFloat((100 - spreadProb).toFixed(1)) : null) : null
      }
        onSelectSide={() => sel(`${awayAbbr} Spread ${awaySpread && awaySpread > 0 ? "+" : ""}${awaySpread}`,
          isFavAway ? spreadProb : isFavHome ? (spreadProb != null ? parseFloat((100 - spreadProb).toFixed(1)) : null) : null, 52.4)}
        isSelectedSide={selectedLabel === `${awayAbbr} Spread ${awaySpread && awaySpread > 0 ? "+" : ""}${awaySpread}`}
      />
      <MarketRow label={`${homeAbbr} Team Total`} line={homeTT} isEstimated={homeTTEst}
        overProb={homeTTOverProb} underProb={homeTTUnderProb}
        onSelectOver={() => sel(`${homeAbbr} TT Over ${homeTT}`, homeTTOverProb, 52.4)}
        onSelectUnder={() => sel(`${homeAbbr} TT Under ${homeTT}`, homeTTUnderProb, 52.4)}
        isSelectedOver={selectedLabel === `${homeAbbr} TT Over ${homeTT}`}
        isSelectedUnder={selectedLabel === `${homeAbbr} TT Under ${homeTT}`}
      />
      <MarketRow label={`${awayAbbr} Team Total`} line={awayTT} isEstimated={awayTTEst}
        overProb={awayTTOverProb} underProb={awayTTUnderProb}
        onSelectOver={() => sel(`${awayAbbr} TT Over ${awayTT}`, awayTTOverProb, 52.4)}
        onSelectUnder={() => sel(`${awayAbbr} TT Under ${awayTT}`, awayTTUnderProb, 52.4)}
        isSelectedOver={selectedLabel === `${awayAbbr} TT Over ${awayTT}`}
        isSelectedUnder={selectedLabel === `${awayAbbr} TT Under ${awayTT}`}
      />
    </div>
  );
}

// ── H1Markets: 1H market rows with fallback estimates ────────────────────────
function H1Markets({
  play, homeAbbr, awayAbbr, onSelect, selectedLabel,
}: {
  play: NCAABPlay; homeAbbr: string; awayAbbr: string;
  onSelect?: (m: SelMarket) => void;
  selectedLabel?: string | null;
}) {
  const h1TotalMktLocal   = play.engineOutput?.markets?.h1_total;
  const h1SpreadMktLocal  = play.engineOutput?.markets?.h1_spread;
  const h1Line      = h1TotalMktLocal?.available ? h1TotalMktLocal.bookLine : null;
  const h1Over      = h1TotalMktLocal?.available ? h1TotalMktLocal.modelProb : null;
  const h1Under     = h1TotalMktLocal?.available && h1TotalMktLocal.modelProb !== null ? Math.round((100 - h1TotalMktLocal.modelProb) * 10) / 10 : null;
  const h1Spread    = h1SpreadMktLocal?.available ? h1SpreadMktLocal.bookLine : null;
  const h1SpreadFav = play.h1Favorite;
  const h1Home1HTL  = play.home1HTotalLine;
  const h1Away1HTL  = play.away1HTotalLine;
  const h1EstimatedLine   = h1Line == null;
  const h1EstimatedSpread = h1Spread == null;
  const h1HomeTTLine = h1Home1HTL ?? (h1Line ? parseFloat((h1Line * 0.48).toFixed(1)) : null);
  const h1AwayTTLine = h1Away1HTL ?? (h1Line ? parseFloat((h1Line * 0.52).toFixed(1)) : null);

  const sel = (label: string, eng: number | null | undefined, imp: number | null | undefined) =>
    onSelect?.({ label, enginePct: eng ?? null, impliedPct: imp ?? null, edge: eng != null && imp != null ? parseFloat((eng - imp).toFixed(1)) : null });

  return (
    <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #1f1f1f", marginTop: 8 }}>
      <div style={{ padding: "8px 16px", background: "#0f0f0f", borderBottom: "1px solid #1a1a1a" }}>
        <span style={{ color: "#52525b", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.06em", fontWeight: 600 }}>1st Half Markets</span>
      </div>
      <MarketRow label="1H Total" line={h1Line} overProb={h1Over} underProb={h1Under} isEstimated={h1EstimatedLine}
        onSelectOver={() => sel(`1H Total Over ${h1Line}`, h1Over, 52.4)}
        onSelectUnder={() => sel(`1H Total Under ${h1Line}`, h1Under, 52.4)}
        isSelectedOver={selectedLabel === `1H Total Over ${h1Line}`}
        isSelectedUnder={selectedLabel === `1H Total Under ${h1Line}`}
      />
      <MarketRow label={`${h1SpreadFav || homeAbbr} 1H Spread`} line={h1Spread} singleSide isEstimated={h1EstimatedSpread}
        onSelectSide={() => sel(`${h1SpreadFav || homeAbbr} 1H Spread ${h1Spread && h1Spread > 0 ? "+" : ""}${h1Spread}`, null, 52.4)}
        isSelectedSide={selectedLabel === `${h1SpreadFav || homeAbbr} 1H Spread ${h1Spread && h1Spread > 0 ? "+" : ""}${h1Spread}`}
      />
      <MarketRow label={`${homeAbbr} 1H Team Total`} line={h1HomeTTLine} isEstimated
        onSelectOver={() => sel(`${homeAbbr} 1H TT Over ${h1HomeTTLine}`, null, 52.4)}
        onSelectUnder={() => sel(`${homeAbbr} 1H TT Under ${h1HomeTTLine}`, null, 52.4)}
        isSelectedOver={selectedLabel === `${homeAbbr} 1H TT Over ${h1HomeTTLine}`}
        isSelectedUnder={selectedLabel === `${homeAbbr} 1H TT Under ${h1HomeTTLine}`}
      />
      <MarketRow label={`${awayAbbr} 1H Team Total`} line={h1AwayTTLine} isEstimated
        onSelectOver={() => sel(`${awayAbbr} 1H TT Over ${h1AwayTTLine}`, null, 52.4)}
        onSelectUnder={() => sel(`${awayAbbr} 1H TT Under ${h1AwayTTLine}`, null, 52.4)}
        isSelectedOver={selectedLabel === `${awayAbbr} 1H TT Over ${h1AwayTTLine}`}
        isSelectedUnder={selectedLabel === `${awayAbbr} 1H TT Under ${h1AwayTTLine}`}
      />
    </div>
  );
}

// ── Live2HPanel: 2H over/under with engine probability vs book ────────────────
function Live2HPanel({
  h2Lines, h2Engine, homeAbbr, awayAbbr, h1HomeScore, h1AwayScore,
}: {
  h2Lines: { h2Total: number | null; h2OverPrice: number | null; h2UnderPrice: number | null; h2Spread: number | null; h2OverPct: number | null; h2UnderPct: number | null; source: string | null } | null;
  h2Engine: { overProb: number; underProb: number; h2Proj: number | null; overEdge: number | null; underEdge: number | null; bookOverImplied: number | null; bookUnderImplied: number | null; hasEdge: boolean; edgeSide: "OVER" | "UNDER" | null; source: string } | null;
  homeAbbr: string; awayAbbr: string;
  h1HomeScore: number; h1AwayScore: number;
}) {
  if (!h2Lines?.h2Total) return null;
  const hasEdge   = h2Engine?.hasEdge ?? false;
  const edgeSide  = h2Engine?.edgeSide ?? null;
  const borderClr = hasEdge ? (edgeSide === "OVER" ? "rgba(0,212,170,0.3)" : "rgba(239,68,68,0.3)") : "#27272a";
  const bgClr     = hasEdge ? (edgeSide === "OVER" ? "rgba(0,212,170,0.04)" : "rgba(239,68,68,0.04)") : "#0f0f0f";

  return (
    <div style={{ margin: "8px 0", border: `1px solid ${borderClr}`, borderRadius: 10, overflow: "hidden", background: bgClr }}>
      <div style={{ padding: "8px 14px", borderBottom: "1px solid #1f1f1f", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#71717a", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>2nd Half Lines</span>
          {h2Lines.source === "derived_h1_pace" && <span style={{ color: "#f59e0b", fontSize: 9 }}>~projected</span>}
          {h2Lines.source === "action_network" && <span style={{ color: "#52525b", fontSize: 9 }}>via AN</span>}
        </div>
        <span style={{ color: "#52525b", fontSize: 11 }}>H1: {awayAbbr} {h1AwayScore} – {h1HomeScore} {homeAbbr}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, padding: "10px 14px" }}>
        {[
          { side: "OVER", line: h2Lines.h2Total, prob: h2Engine?.overProb, bookImplied: h2Engine?.bookOverImplied, edge: h2Engine?.overEdge, isEdge: edgeSide === "OVER" },
          { side: "UNDER", line: h2Lines.h2Total, prob: h2Engine?.underProb, bookImplied: h2Engine?.bookUnderImplied, edge: h2Engine?.underEdge, isEdge: edgeSide === "UNDER" },
        ].map(({ side, line, prob, bookImplied, edge, isEdge }) => (
          <div key={side} style={{ background: isEdge ? (side === "OVER" ? "rgba(0,212,170,0.1)" : "rgba(239,68,68,0.1)") : "rgba(255,255,255,0.03)", borderRadius: 8, padding: "10px 12px", border: `1px solid ${isEdge ? (side === "OVER" ? "rgba(0,212,170,0.25)" : "rgba(239,68,68,0.25)") : "#27272a"}` }}>
            <div style={{ color: "#71717a", fontSize: 9, textTransform: "uppercase" as const, marginBottom: 4 }}>2H {side} {line}</div>
            {prob != null && <div style={{ color: isEdge ? (side === "OVER" ? "#00d4aa" : "#ef4444") : "#ffffff", fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{prob}%</div>}
            {bookImplied != null && <div style={{ color: "#52525b", fontSize: 10, marginTop: 3 }}>Book: {bookImplied}%</div>}
            {edge != null && <div style={{ color: (edge ?? 0) >= 5 ? (side === "OVER" ? "#00d4aa" : "#ef4444") : "#71717a", fontSize: 11, fontWeight: 600, marginTop: 2 }}>{edge > 0 ? "+" : ""}{edge}pp edge</div>}
          </div>
        ))}
      </div>
      {h2Lines.h2Spread != null && (
        <div style={{ padding: "8px 14px", borderTop: "1px solid #1f1f1f", display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "#71717a", fontSize: 10, textTransform: "uppercase" as const }}>2H Spread</span>
          <span style={{ color: "#ffffff", fontSize: 13, fontWeight: 600 }}>{homeAbbr} {h2Lines.h2Spread > 0 ? "+" : ""}{h2Lines.h2Spread}</span>
        </div>
      )}
      {(h2Lines.h2OverPct != null || h2Engine?.h2Proj != null) && (
        <div style={{ padding: "6px 14px", borderTop: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {h2Lines.h2OverPct != null && <span style={{ color: "#52525b", fontSize: 10 }}>Public: Over {h2Lines.h2OverPct}% / Under {h2Lines.h2UnderPct}%</span>}
          {h2Engine?.h2Proj != null && <span style={{ color: "#3f3f46", fontSize: 10 }}>Engine projects {h2Engine.h2Proj} pts</span>}
        </div>
      )}
    </div>
  );
}

// ── NCAABGameCard ─────────────────────────────────────────────────────────────
function NCAABGameCard({
  play,
  onAddToParlay,
  onAddToCard,
  h2hDataFromCache,
  isNewlyLive,
  onShiftDetected,
}: {
  play: NCAABPlay;
  onAddToParlay?: (pick: ParlayPickInput) => void;
  /** Canonical market pass-through: receives the NCAABMarket object directly */
  onAddToCard?: (market: NCAABMarketClient) => void;
  h2hDataFromCache?: H2HGame[] | null;
  isNewlyLive?: boolean;
  onShiftDetected?: (gameId: string) => void;
}) {
  const isH1 = play.half === 1 && !play.bettingWindow.includes("HALFTIME");

  const gameProgress = computeGameProgress(play);
  const ftMarket = play.engineOutput?.markets?.full_total;
  const fsMarket = play.engineOutput?.markets?.full_spread;
  const overProb     = ftMarket?.available ? ftMarket.modelProb : null;
  const underProb    = ftMarket?.available && ftMarket.modelProb !== null ? Math.round((100 - ftMarket.modelProb) * 10) / 10 : null;
  const spreadProb   = fsMarket?.available ? fsMarket.modelProb : null;

  const isNeutral = overProb === null || (gameProgress < 0.10 && overProb >= 45 && overProb <= 55);

  const dominantMarket = play.engineOutput?.dominantMarket ?? "over";

  const [selectedMarket, setSelectedMarket] = useState<"over" | "under" | "spread">(dominantMarket);
  const [marketTab, setMarketTab]           = useState<"full" | "h1" | "h2">("full");
  const [mktCallout, setMktCallout]         = useState<SelMarket | null>(null);
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

  // Enriched data state (BartTorvik, ActionNetwork, Rotowire, composite engine)
  const [enrichedData, setEnrichedData] = useState<EnrichedGameData | null>(null);
  const [enrichedLoading, setEnrichedLoading] = useState(false);
  const [enrichedVersion, setEnrichedVersion] = useState(0);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  // 2H live lines state (fetch on mount for live/halftime; 90s refresh)
  const [h2Lines, setH2Lines] = useState<{ h2Total: number | null; h2OverPrice: number | null; h2UnderPrice: number | null; h2Spread: number | null; h2OverPct: number | null; h2UnderPct: number | null; source: string | null } | null>(null);
  const [h2Engine, setH2Engine] = useState<{ overProb: number; underProb: number; h2Proj: number | null; overEdge: number | null; underEdge: number | null; bookOverImplied: number | null; bookUnderImplied: number | null; hasEdge: boolean; edgeSide: "OVER" | "UNDER" | null; source: string } | null>(null);

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

  // Fetch enriched analytics data (BartTorvik, ActionNetwork, injuries, composite engine)
  useEffect(() => {
    let cancelled = false;
    setEnrichedLoading(true);
    fetch(`/api/ncaab/enriched?gameId=${play.gameId}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: EnrichedGameData | null) => {
        if (!cancelled && data) setEnrichedData(data);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setEnrichedLoading(false); });
    return () => { cancelled = true; };
  }, [play.gameId, enrichedVersion]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Fetch 2H lines for live/halftime games; refresh every 90s
  useEffect(() => {
    const isLiveOrHalftime = play.status === "In Progress" || play.bettingWindow === "HALFTIME";
    if (!isLiveOrHalftime) return;
    let cancelled = false;
    const doFetch = async () => {
      const h1HomeScore = play.homeScore - (play.scoringByPeriod?.[play.homeTeamAbbr]?.[1] ?? 0);
      const h1AwayScore = play.awayScore - (play.scoringByPeriod?.[play.awayTeamAbbr]?.[1] ?? 0);
      const params = new URLSearchParams({
        gameId: play.gameId,
        h1HomeScore: String(h1HomeScore),
        h1AwayScore: String(h1AwayScore),
        ...(effectiveFGLine != null ? { fullLine: String(effectiveFGLine) } : {}),
      });
      try {
        const res = await fetch(`/api/ncaab/2h-lines?${params.toString()}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) {
          setH2Lines(data.lines ?? null);
          setH2Engine(data.engine ?? null);
        }
      } catch { /* non-fatal */ }
    };
    doFetch();
    const iv = setInterval(doFetch, 90000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [play.gameId, play.status, play.bettingWindow]); // eslint-disable-line react-hooks/exhaustive-deps

  // Synchronous trigger of all animations (item 6): one event, no setTimeout chains
  useEffect(() => {
    const prev  = prevOverProb.current;
    if (overProb === null || prev === null) { prevOverProb.current = overProb; return; }
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

  // Canonical markets lookup — direct reads, no cross-tab fallbacks
  const h1TotalMkt = play.engineOutput?.markets?.h1_total;
  const h2TotalMkt = play.engineOutput?.markets?.h2_total;
  const h1SpreadMkt = play.engineOutput?.markets?.h1_spread;
  const h2SpreadMkt = play.engineOutput?.markets?.h2_spread;

  // Book lines sourced from canonical markets only (no play-level field fallbacks)
  const fgLineFromBook   = ftMarket?.available ?? false;
  const h1LineFromBook   = h1TotalMkt?.available ?? false;
  const h2LineFromBook   = h2TotalMkt?.available ?? false;
  const effectiveFGLine  = ftMarket?.available ? ftMarket.bookLine : null;
  const effective1HLine  = h1TotalMkt?.available ? h1TotalMkt.bookLine : null;
  const effectiveLine    = isH1 ? effective1HLine : effectiveFGLine;

  // T002/T003: market tab display derivations — strict market-specific sourcing from canonical
  const effective2HLine    = h2TotalMkt?.available ? h2TotalMkt.bookLine : null;
  const displayLine        = marketTab === "h1" ? effective1HLine : marketTab === "h2" ? effective2HLine : effectiveFGLine;
  const displayLineFromBook = marketTab === "h1" ? h1LineFromBook : marketTab === "h2" ? h2LineFromBook : fgLineFromBook;

  const displayOverProb: number | null =
    marketTab === "h1" ? (h1TotalMkt?.available ? h1TotalMkt.modelProb : null)
    : marketTab === "h2" ? (h2TotalMkt?.available ? h2TotalMkt.modelProb : null)
    : overProb;
  const displayUnderProb: number | null =
    marketTab === "h1" ? (h1TotalMkt?.available && h1TotalMkt.modelProb !== null ? Math.round((100 - h1TotalMkt.modelProb) * 10) / 10 : null)
    : marketTab === "h2" ? (h2TotalMkt?.available && h2TotalMkt.modelProb !== null ? Math.round((100 - h2TotalMkt.modelProb) * 10) / 10 : null)
    : underProb;

  const displaySpreadProb: number | null =
    marketTab === "h1" ? (h1SpreadMkt?.available ? h1SpreadMkt.modelProb : null)
    : marketTab === "h2" ? (h2SpreadMkt?.available ? h2SpreadMkt.modelProb : null)
    : spreadProb;

  const displaySpread      = marketTab === "h1"
        ? (h1SpreadMkt?.available && h1SpreadMkt.bookLine !== null ? Math.abs(h1SpreadMkt.bookLine) : null)
        : marketTab === "h2"
        ? (h2SpreadMkt?.available && h2SpreadMkt.bookLine !== null ? Math.abs(h2SpreadMkt.bookLine) : null)
        : (fsMarket?.available && fsMarket.bookLine !== null ? Math.abs(fsMarket.bookLine) : null);
  const displaySpreadFav   = marketTab === "h1" ? play.h1Favorite : marketTab === "h2" ? play.h2Favorite : play.favorite;
  const h1ProjSplit        = play.proj1HTotal != null ? play.proj1HTotal / 2 : null;
  const displayAwayProj    = marketTab === "h1" ? h1ProjSplit : play.awayProjected;
  const displayHomeProj    = marketTab === "h1" ? h1ProjSplit : play.homeProjected;
  const h1DataUnavailable  = marketTab === "h1" && !play.engineOutput?.markets?.h1_total?.available;
  const h2Mkt = play.engineOutput?.markets?.h2_total;
  const h2DataUnavailable  = marketTab === "h2" && !h2Mkt?.available;

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
  const gaugeValue     = gaugeForMarket(selectedMarket);
  const gaugeColor  = selectedMarket === "over" ? "#00d4aa" : selectedMarket === "under" ? "#ef4444" : "#94a3b8";
  const gaugeLabel  = selectedMarket === "over" ? "OVER" : selectedMarket === "under" ? "UNDER" : "COVER";

  // Read edge and confidence directly from canonical market — tab-aware (never recompute in UI)
  const selectedMkt: NCAABMarketClient | undefined = (() => {
    if (selectedMarket === "spread") {
      const m = marketTab === "h1" ? h1SpreadMkt : marketTab === "h2" ? h2SpreadMkt : fsMarket;
      return m?.available ? m : undefined;
    }
    const m = marketTab === "h1" ? h1TotalMkt : marketTab === "h2" ? h2TotalMkt : ftMarket;
    return m?.available ? m : undefined;
  })();
  const canonicalEdge       = selectedMkt?.edge ?? null;
  const canonicalConfTier   = selectedMkt?.confidenceTier ?? "NONE";
  const canonicalSide       = selectedMkt?.side ?? null;
  const bookImplied         = selectedMkt?.bookImpliedProb ?? null;

  const edgeGap   = canonicalEdge !== null ? Math.abs(canonicalEdge) : 0;
  const edgeSide: "Over" | "Under" =
    (canonicalSide === "UNDER" || canonicalSide === "AWAY") ? "Under" : "Over";
  const edgeLabel =
    canonicalEdge === null ? "Unavailable"
    : canonicalConfTier === "ELITE" ? `Strong ${edgeSide} EV`
    : canonicalConfTier === "STRONG" ? `Lean ${edgeSide} EV`
    : canonicalConfTier === "VALUE" ? `Value ${edgeSide} EV`
    : "Neutral — No Edge";
  const edgeBelow = edgeGap < 4;
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
    return displaySpread !== null ? `${play.favorite} -${displaySpread}` : "Spread";
  };

  const primaryBook = play.bookLines.find(b => b.book === "draftkings") ??
                      play.bookLines.find(b => b.book === "fanduel") ??
                      play.bookLines[0];
  const altBook = play.bookLines.find(b => b.book === "hardrockbet") ??
                  play.bookLines.find(b => b.book === "fanatics") ??
                  play.bookLines.find(b => b.book !== primaryBook?.book) ??
                  play.bookLines[1];
  const altLabel = altBook ? (BOOK_LABELS[altBook.book] ?? altBook.book) : "—";

  const halfLabel = play.half === 1 ? "H1" : play.half === 2 ? "H2" : "OT";
  const bestEdge  = Math.max(Math.abs(play.spreadEdge ?? 0), Math.abs(play.totalEdge ?? 0));

  function addParlayPick(m: "over" | "under" | "spread") {
    if (!onAddToParlay && !onAddToCard) return;
    const line    = m === "spread" ? (displaySpread ?? 0) : (effectiveLine ?? 0);
    const prob    = gaugeForMarket(m);
    if (prob === null) return;
    const rawOdds = prob >= 50
      ? -Math.round((prob / (100 - prob)) * 100)
      :  Math.round(((100 - prob) / prob) * 100);
    if (onAddToParlay) {
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
    // Pass canonical NCAABMarket object directly to the bet card action
    if (onAddToCard && selectedMkt) {
      onAddToCard(selectedMkt);
    }
  }

  function addTeamTotalParlayPick() {
    if (!onAddToParlay || !selectedTeamMarket) return;
    const { team, direction, line, isEstimated, teamAbbr } = selectedTeamMarket;
    const proj = team === "home" ? fullHomeProj : fullAwayProj;
    if (!proj) return;
    const v = getTeamTotalVerdict(direction, isEstimated, null);
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
  const overColor  = overProb  === null ? "#71717a" : overProb  > 50 ? "#00d4aa" : "#ef4444";
  const underColor = underProb === null ? "#71717a" : underProb > 50 ? "#00d4aa" : "#ef4444";

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

        {/* Per-card refresh icon (top-right, below parlay badge) */}
        <button
          data-testid={`ncaab-enrich-refresh-${play.gameId}`}
          onClick={() => setEnrichedVersion(v => v + 1)}
          title="Refresh analytics data"
          className="absolute top-10 right-3 w-5 h-5 flex items-center justify-center rounded transition-colors"
          style={{ color: "#3f3f46", background: "transparent" }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#00d4aa"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "#3f3f46"; }}
        >
          <RefreshCw className={`w-3 h-3 ${enrichedLoading ? "animate-spin" : ""}`} />
        </button>

        {/* ── HEADER ─────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row items-start sm:justify-between gap-3">
          <div className="flex-1 min-w-0 w-full">
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
              {(() => {
                const ftMktTier = play.engineOutput?.markets?.full_total;
                const tier = tierDisplayFromCanonical(ftMktTier?.available ? ftMktTier.confidenceTier : null);
                if (!tier) return null;
                return (
                  <span
                    data-testid={`ncaab-live-tier-badge-${play.gameId}`}
                    className="text-[9px] font-black px-2 py-0.5 rounded-full"
                    style={{ background: tier.bg, color: tier.color, border: `1px solid ${tier.border}` }}
                  >
                    {tier.label}
                  </span>
                );
              })()}
              {play.desperation3s && (
                <span className="text-[9px] text-orange-400 bg-orange-500/10 border border-orange-500/20 px-1.5 py-0.5 rounded">⚠ Desperation 3s</span>
              )}
              {play.intentionalFouling && (
                <span className="text-[9px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-1.5 py-0.5 rounded">⚑ Int. Fouling</span>
              )}
            </div>
          </div>
          {/* Desktop: single gauge at default size */}
          <div className="hidden sm:flex flex-col items-center gap-1.5">
            <RadialGauge
              value={isNeutral || gaugeValue === null ? 50 : gaugeValue}
              color={isNeutral || gaugeValue === null ? "#52525b" : gaugeColor}
              label={isNeutral ? "EARLY GAME" : gaugeValue === null ? "UNAVAILABLE" : gaugeLabel}
              isParlayed={isLegParlayed(selectedMarket)}
              showFullGameLabel
              displayDash={isNeutral || gaugeValue === null}
            />
            {enrichedData && enrichedData.sources.length > 0 && (
              <span
                data-testid={`ncaab-sources-badge-desktop-${play.gameId}`}
                className="text-[9px] font-bold px-2 py-0.5 rounded-full"
                style={{ background: "rgba(0,212,170,0.12)", color: "#00d4aa", border: "1px solid rgba(0,212,170,0.25)" }}
              >
                {enrichedData.sources.length} source{enrichedData.sources.length !== 1 ? "s" : ""}
              </span>
            )}
            {enrichedLoading && !enrichedData && (
              <span className="text-[9px]" style={{ color: "#3f3f46" }}>loading…</span>
            )}
          </div>
          {/* Mobile: primary gauge (lg) + secondary gauges (sm) in 2-col row */}
          <div className="flex sm:hidden flex-col items-center gap-1.5 self-center">
            <RadialGauge
              value={isNeutral || gaugeValue === null ? 50 : gaugeValue}
              color={isNeutral || gaugeValue === null ? "#52525b" : gaugeColor}
              label={isNeutral ? "EARLY GAME" : gaugeValue === null ? "UNAVAILABLE" : gaugeLabel}
              isParlayed={isLegParlayed(selectedMarket)}
              showFullGameLabel
              displayDash={isNeutral || gaugeValue === null}
              size="lg"
            />
            {!isNeutral && (
              <div className="grid grid-cols-2 gap-2">
                {(["over", "under", "spread"] as const)
                  .filter(m => m !== selectedMarket && (m !== "spread" || displaySpread !== null))
                  .map(m => {
                    const mVal = gaugeForMarket(m);
                    const mColor = m === "over" ? "#00d4aa" : m === "under" ? "#ef4444" : "#94a3b8";
                    const mLabel = m === "over" ? "OVER" : m === "under" ? "UNDER" : "COVER";
                    return (
                      <RadialGauge
                        key={m}
                        value={mVal !== null ? mVal : 50}
                        color={mColor}
                        label={mLabel}
                        isParlayed={isLegParlayed(m)}
                        displayDash={mVal === null}
                        size="sm"
                      />
                    );
                  })}
              </div>
            )}
            {enrichedData && enrichedData.sources.length > 0 && (
              <span
                data-testid={`ncaab-sources-badge-${play.gameId}`}
                className="text-[9px] font-bold px-2 py-0.5 rounded-full"
                style={{ background: "rgba(0,212,170,0.12)", color: "#00d4aa", border: "1px solid rgba(0,212,170,0.25)" }}
              >
                {enrichedData.sources.length} source{enrichedData.sources.length !== 1 ? "s" : ""}
              </span>
            )}
            {enrichedLoading && !enrichedData && (
              <span className="text-[9px]" style={{ color: "#3f3f46" }}>loading…</span>
            )}
          </div>
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
                <p className="text-xs" style={{ color: "#a1a1aa" }}>Engine {gaugeValue !== null ? gaugeValue.toFixed(1) : "--"}% vs Book {bookImplied !== null ? bookImplied.toFixed(1) : "--"}%</p>
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

        {/* ── MARKET SIGNAL SECTION (Handle + Sharp Money consolidated) ── */}
        {(() => {
          const sharp = detectSharpMoney({
            homeWinPct: play.espnHomeWinPct,
            spreadDetails: play.espnSpreadDetails,
            homeTeamName: play.homeTeam,
            awayTeamName: play.awayTeam,
          });
          const handle = play.handleSignal;
          const hasHandle = handle && handle.signal !== "unavailable" && handle.signal !== "neutral";
          const hasSharp = !!sharp;

          const handleSide = hasHandle
            ? (handle.signal === "fade" ? "away" : handle.signal === "extreme" ? "home" : null)
            : null;
          const sharpSide = hasSharp ? sharp.sharpSide : null;

          let synthesisLabel = "Signal unavailable";
          let synthesisColor = "#52525b";
          if (hasHandle && hasSharp) {
            if (handleSide === sharpSide) {
              const teamName = sharpSide === "home" ? play.homeTeam : play.awayTeam;
              synthesisLabel = `Confirmed edge: ${teamName}`;
              synthesisColor = "#00d4aa";
            } else {
              synthesisLabel = "Split market signal";
              synthesisColor = "#f59e0b";
            }
          } else if (hasHandle) {
            synthesisLabel = handle.label;
            synthesisColor = handle.color;
          } else if (hasSharp) {
            synthesisLabel = sharp.label;
            synthesisColor = sharp.strength >= 15 ? "#ef4444" : "#f59e0b";
          }

          return (
            <div data-testid={`ncaab-market-signal-${play.gameId}`} className="rounded-lg overflow-hidden" style={{ border: "1px solid #27272a" }}>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ background: `${synthesisColor}0d`, borderBottom: "1px solid #27272a" }}>
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: synthesisColor }}>Market Signal</span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: `${synthesisColor}18`, color: synthesisColor, border: `1px solid ${synthesisColor}40` }}>
                  {synthesisLabel}
                </span>
              </div>
              <div className="px-4 py-2.5 space-y-2" style={{ background: "#0d0d0d" }}>
                {hasHandle && (
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-semibold" style={{ color: handle.color }}>{handle.label}</p>
                      <p className="text-[9px]" style={{ color: "#52525b" }}>Handle signal · {handle.pct != null ? `${handle.pct}%` : "N/A"}</p>
                    </div>
                  </div>
                )}
                {hasSharp && (() => {
                  const sharpColor = sharp.strength >= 15 ? "#ef4444" : "#f59e0b";
                  return (
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-[10px] font-semibold" style={{ color: sharpColor }}>{sharp.label}</p>
                        <p className="text-[9px]" style={{ color: "#52525b" }}>ESPN model vs market · {sharp.teamName}</p>
                      </div>
                      <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full shrink-0"
                        style={{ background: `${sharpColor}22`, color: sharpColor, border: `1px solid ${sharpColor}44`, fontFamily: "monospace" }}>
                        {sharp.sharpSide === "home" ? "↑" : "↓"} {sharp.teamName.split(" ").pop()}
                      </span>
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })()}

        {/* ── TEAM TOTAL VERDICT SECTION (T005) ──────────────────────── */}
        {selectedTeamMarket !== null && (() => {
          const { team, direction, line, isEstimated, teamAbbr } = selectedTeamMarket;
          const proj = team === "home" ? fullHomeProj : fullAwayProj;
          if (proj === null) return null;
          const v = getTeamTotalVerdict(direction, isEstimated, null);
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

        {/* ── FULL GAME / 1H / 2H TOGGLE ─────────────────────────────── */}
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
            {(play.bettingWindow === "HALFTIME" || play.half === 2) && (
              <button
                onClick={() => setMarketTab("h2")}
                style={{
                  background: marketTab === "h2" ? "#27272a" : "transparent",
                  color: marketTab === "h2" ? "#ffffff" : "#71717a",
                  borderRadius: 6,
                  padding: "4px 12px",
                  fontSize: 12,
                  fontWeight: 500,
                  border: "none",
                  cursor: "pointer",
                }}
              >
                2nd Half
              </button>
            )}
          </div>
          {h1DataUnavailable && (
            <p style={{ color: "#71717a", fontSize: 11, fontStyle: "italic" }}>1H lines unavailable</p>
          )}
          {h2DataUnavailable && (
            <p style={{ color: "#71717a", fontSize: 11, fontStyle: "italic" }}>2H lines unavailable</p>
          )}
        </div>

        {/* ── LIVE 2H PANEL (halftime primary + H1 preview) ───────────── */}
        {(play.bettingWindow === "HALFTIME" || play.half === 2) && (
          <Live2HPanel
            h2Lines={h2Lines}
            h2Engine={h2Engine}
            homeAbbr={play.homeTeamAbbr}
            awayAbbr={play.awayTeamAbbr}
            h1HomeScore={play.scoringByPeriod?.[play.homeTeamAbbr]?.[0] ?? Math.round(play.homeScore * 0.5)}
            h1AwayScore={play.scoringByPeriod?.[play.awayTeamAbbr]?.[0] ?? Math.round(play.awayScore * 0.5)}
          />
        )}

        {/* ── STAT GRID (items 4 + 5) ────────────────────────────────── */}
        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #27272a" }}>
          {[0,1,2,3,4,5].map(i => {
            const borderB = i < 5 ? "1px solid #27272a" : undefined;
            if (i === 0) return (
              <div key={0} className="grid grid-cols-3 items-center gap-2" style={{ borderBottom: borderB, background: "#111111", padding: "16px 20px" }}>
                <span className="text-xs font-semibold uppercase tracking-wider truncate" style={{ color: "#71717a" }}>
                  {marketTab === "h1" ? "H1 Total" : marketTab === "h2" ? "2H Total" : "Full Game Total"}
                </span>
                <span className="text-lg font-bold tabular-nums text-center" style={{ color: "#ffffff" }}>
                  {displayLine != null ? String(displayLine) : "—"}
                </span>
                <span className="text-xs text-right truncate" style={{ color: "#a1a1aa" }}>
                  {displayLine == null ? "Unavailable" : displayLineFromBook ? "Sportsbook line" : "Engine est."}
                </span>
              </div>
            );
            if (i === 1) return (
              <div key={1} className="grid grid-cols-3 items-center gap-2" style={{ borderBottom: borderB, background: "#111111", padding: "16px 20px" }}>
                <span className="text-xs font-semibold uppercase tracking-wider truncate" style={{ color: "#71717a" }}>Engine Over%</span>
                <span className="text-lg font-bold tabular-nums text-center">
                  {displayOverProb != null
                    ? <AnimatedNumber value={displayOverProb} decimals={1} suffix="%" color={overColor} colorTransition={isDirectionFlip} />
                    : <span style={{ color: "#52525b" }}>No data</span>}
                </span>
                <span className="text-xs text-right truncate" style={{ color: "#a1a1aa" }}>Model probability</span>
              </div>
            );
            if (i === 2) return (
              <div key={2} className="grid grid-cols-3 items-center gap-2" style={{ borderBottom: borderB, background: "#111111", padding: "16px 20px" }}>
                <span className="text-xs font-semibold uppercase tracking-wider truncate" style={{ color: "#71717a" }}>Engine Under%</span>
                <span className="text-lg font-bold tabular-nums text-center">
                  {displayUnderProb != null
                    ? <AnimatedNumber value={displayUnderProb} decimals={1} suffix="%" color={underColor} colorTransition={isDirectionFlip} />
                    : <span style={{ color: "#52525b" }}>No data</span>}
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
                  ) : displaySpread != null ? `${displaySpreadFav} fav` : "Unavailable"}
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
            // Rule 3: hide spread button on H1/H2 when no period-specific spread verdict
            if (m === "spread" && (marketTab === "h1" || marketTab === "h2") && displaySpreadProb === null) return null;
            const isSelected = selectedMarket === m;
            const isParlayed = isLegParlayed(m);
            const mColor = m === "over" ? "#00d4aa" : m === "under" ? "#ef4444" : "#94a3b8";
            const mProb: number | null = m === "over" ? displayOverProb : m === "under" ? displayUnderProb : displaySpreadProb;
            // Rule 4: prefer displayOutput pre-formatted strings for full-game tab
            const mProbText: string = (() => {
              if (isNeutral) return "--";
              if (marketTab === "full") {
                const doStr = m === "over" ? play.engineOutput?.displayOutput?.overProb
                  : m === "under" ? play.engineOutput?.displayOutput?.underProb
                  : play.engineOutput?.displayOutput?.spreadProb;
                if (doStr) return doStr;
              }
              return mProb != null ? `${mProb.toFixed(1)}%` : "No data";
            })();
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
                  <span className="text-sm font-semibold" style={{ color: isNeutral ? "#52525b" : mProb != null ? mColor : "#52525b" }}>
                    {mProbText}
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
            { label: primaryBook ? (BOOK_LABELS[primaryBook.book] ?? primaryBook.book) : "—", book: primaryBook, url: primaryBook ? (BOOK_URLS[primaryBook.book] ?? "#") : "#" },
            { label: altLabel, book: altBook, url: altBook ? (BOOK_URLS[altBook.book] ?? "#") : "#" },
          ].filter(p => p.label !== "—").map(({ label, book, url }) => {
            const bookLineText = book
              ? (marketTab === "h1"
                  ? (book.h1Total != null ? `H1 O/U ${book.h1Total}` : "H1 Lines TBD")
                  : marketTab === "h2"
                  ? (h2TotalMkt?.available && h2TotalMkt.bookLine != null ? `2H O/U ${h2TotalMkt.bookLine}` : "2H Lines TBD")
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

        {/* ── SELECTED MARKET CALLOUT ─────────────────────────────────── */}
        {mktCallout && (() => {
          const edgeVal = mktCallout.edge;
          const edgeClr = edgeVal == null ? "#71717a" : edgeVal >= 5 ? "#00d4aa" : edgeVal >= 2 ? "#f59e0b" : edgeVal != null && edgeVal <= -5 ? "#ef4444" : "#71717a";
          return (
            <div style={{ margin: "8px 0", padding: "10px 14px", borderRadius: 8, border: "1.5px solid rgba(0,212,170,0.4)", background: "rgba(0,212,170,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ color: "#00d4aa", fontSize: 11, fontWeight: 700, marginBottom: 3 }}>{mktCallout.label}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const }}>
                  {mktCallout.impliedPct != null && (
                    <span style={{ color: "#71717a", fontSize: 10 }}>Book: <span style={{ color: "#a1a1aa", fontWeight: 600 }}>{mktCallout.impliedPct}% implied</span></span>
                  )}
                  {mktCallout.enginePct != null && (
                    <span style={{ color: "#71717a", fontSize: 10 }}>Engine: <span style={{ color: "#ffffff", fontWeight: 700 }}>{mktCallout.enginePct}%</span></span>
                  )}
                  {edgeVal != null && (
                    <span style={{ background: `${edgeClr}22`, border: `1px solid ${edgeClr}44`, color: edgeClr, borderRadius: 9999, padding: "1px 7px", fontSize: 9, fontWeight: 700 }}>
                      {edgeVal > 0 ? "+" : ""}{edgeVal}pp edge
                    </span>
                  )}
                </div>
              </div>
              <button onClick={() => setMktCallout(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#52525b", fontSize: 14, lineHeight: 1, padding: 4, flexShrink: 0 }}>×</button>
            </div>
          );
        })()}

        {/* ── FULL GAME MARKET PANEL ──────────────────────────────────── */}
        {marketTab === "full" && (
          <FullGameMarkets
            play={play} homeAbbr={play.homeTeamAbbr} awayAbbr={play.awayTeamAbbr}
            onSelect={setMktCallout}
            selectedLabel={mktCallout?.label ?? null}
          />
        )}

        {/* ── 1H MARKET PANEL ─────────────────────────────────────────── */}
        {marketTab === "h1" && (
          <H1Markets
            play={play} homeAbbr={play.homeTeamAbbr} awayAbbr={play.awayTeamAbbr}
            onSelect={setMktCallout}
            selectedLabel={mktCallout?.label ?? null}
          />
        )}

        {/* ── BETTING INTELLIGENCE (ActionNetwork) ───────────────────── */}
        {enrichedData?.actionNetwork && (() => {
          const an = enrichedData.actionNetwork!;
          const hasPublicPct = an.overPct != null && an.underPct != null;
          const hasMovement = an.openTotal != null && an.total != null;
          const isSharpOver  = (an.overMoney !== null && an.overMoney !== undefined ? an.overMoney : 0) > 60 && (an.overPct !== null && an.overPct !== undefined ? an.overPct : 50) < 50;
          const isSharpUnder = (an.underMoney !== null && an.underMoney !== undefined ? an.underMoney : 0) > 60 && (an.underPct !== null && an.underPct !== undefined ? an.underPct : 50) < 50;
          const sharpSide = isSharpOver ? "Over" : isSharpUnder ? "Under" : null;
          const movement = hasMovement ? parseFloat(((an.total ?? 0) - (an.openTotal ?? 0)).toFixed(1)) : null;
          return (
            <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #1e3a3a" }}>
              <div className="flex items-center justify-between px-3 py-2" style={{ background: "#0b1f1f" }}>
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#00d4aa" }}>Betting Intelligence</span>
                {sharpSide && (
                  <span className="text-[9px] font-black px-2 py-0.5 rounded-full"
                    style={{ background: sharpSide === "Over" ? "rgba(0,212,170,0.2)" : "rgba(239,68,68,0.2)", color: sharpSide === "Over" ? "#00d4aa" : "#ef4444", border: `1px solid ${sharpSide === "Over" ? "rgba(0,212,170,0.4)" : "rgba(239,68,68,0.4)"}` }}>
                    ⚡ Sharp {sharpSide}
                  </span>
                )}
              </div>
              <div className="px-3 py-2 space-y-1.5" style={{ background: "#0a1a1a" }}>
                {hasPublicPct && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px]" style={{ color: "#71717a" }}>Public %</span>
                    <span className="text-[10px] font-mono font-semibold" style={{ color: "#a1a1aa" }}>
                      <span style={{ color: "#00d4aa" }}>{an.overPct}% Over</span>
                      {" / "}
                      <span style={{ color: "#ef4444" }}>{an.underPct}% Under</span>
                    </span>
                  </div>
                )}
                {an.overMoney != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px]" style={{ color: "#71717a" }}>Money %</span>
                    <span className="text-[10px] font-mono font-semibold" style={{ color: "#a1a1aa" }}>
                      {an.overMoney}% on Over
                    </span>
                  </div>
                )}
                {hasMovement && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px]" style={{ color: "#71717a" }}>Line Movement</span>
                    <span className="text-[10px] font-mono font-semibold"
                      style={{ color: movement === 0 ? "#71717a" : movement! > 0 ? "#00d4aa" : "#ef4444" }}>
                      Open {an.openTotal} → {an.total} {movement !== 0 && movement !== null ? `(${movement > 0 ? "+" : ""}${movement})` : "(no move)"}
                    </span>
                  </div>
                )}
                {an.homeSpreadPct != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px]" style={{ color: "#71717a" }}>Spread Tickets</span>
                    <span className="text-[10px] font-mono" style={{ color: "#71717a" }}>
                      {play.homeTeamAbbr} {an.homeSpreadPct}% / {play.awayTeamAbbr} {an.awaySpreadPct}%
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* ── ADVANCED ANALYTICS (multi-source) ──────────────────────── */}
        {enrichedData && (() => {
          const ht = enrichedData.torvik.home;
          const at = enrichedData.torvik.away;
          const hasTorvik = ht || at;
          const pp = enrichedData.prizePicks;
          const ud = enrichedData.underdog;
          const tr = enrichedData.teamRankings;
          const hcbb = enrichedData.cbbRef?.home;
          const acbb = enrichedData.cbbRef?.away;
          const hasCbbRef = hcbb || acbb;
          if (!hasTorvik && !pp && !ud && !tr && !hasCbbRef) return null;

          const avgTempo = ht?.tempo && at?.tempo ? (ht.tempo + at.tempo) / 2 : null;
          const tempoLabel = avgTempo ? (avgTempo > 72 ? "Fast Pace" : avgTempo < 65 ? "Slow Pace" : "Average Pace") : null;
          const tempoColor = avgTempo ? (avgTempo > 72 ? "#00d4aa" : avgTempo < 65 ? "#ef4444" : "#71717a") : "#71717a";
          const compositeTotal = enrichedData.composite?.projTotal;
          const liveLine = effectiveFGLine;
          const compositeLean = compositeTotal && liveLine ? parseFloat((compositeTotal - liveLine).toFixed(1)) : null;

          const leanColor = (diff: number | null) =>
            diff == null ? "#71717a" : diff > 1 ? "#00d4aa" : diff < -1 ? "#ef4444" : "#71717a";

          return (
            <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #1e293b" }}>
              <div className="flex items-center justify-between px-3 py-2" style={{ background: "#0b1525" }}>
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#60a5fa" }}>Advanced Analytics</span>
                <div className="flex items-center gap-1.5">
                  {tempoLabel && (
                    <span className="text-[9px] font-bold px-2 py-0.5 rounded-full"
                      style={{ color: tempoColor, background: `${tempoColor}18`, border: `1px solid ${tempoColor}40` }}>
                      {tempoLabel}
                    </span>
                  )}
                </div>
              </div>
              <div className="px-3 py-2 space-y-1.5" style={{ background: "#090f1a" }}>

                {/* BartTorvik efficiency rows */}
                {hasTorvik && [
                  { label: play.homeTeamAbbr, t: ht },
                  { label: play.awayTeamAbbr, t: at },
                ].map(({ label, t }) => t && (
                  <div key={label} className="space-y-0.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px]" style={{ color: "#71717a" }}>{label} (Torvik)</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-mono" style={{ color: "#a1a1aa" }}>
                          <StatWithTooltip label="AdjO" tooltip={TORVIK_TOOLTIPS.adjO}>
                            <span>AdjO</span>
                          </StatWithTooltip>{" "}
                          <span style={{ color: "#00d4aa" }}>{t.adjO.toFixed(1)}</span>
                          {" · "}
                          <StatWithTooltip label="AdjD" tooltip={TORVIK_TOOLTIPS.adjD}>
                            <span>AdjD</span>
                          </StatWithTooltip>{" "}
                          <span style={{ color: "#ef4444" }}>{t.adjD.toFixed(1)}</span>
                        </span>
                        {t.rank < 400 && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                            style={{ background: "#1e293b", color: "#60a5fa", border: "1px solid #1e3a5f" }}>
                            #{t.rank}
                          </span>
                        )}
                      </div>
                    </div>
                    {t.barthag != null && (
                      <div className="flex items-center justify-between">
                        <span className="text-[9px]" style={{ color: "#52525b" }}>
                          <StatWithTooltip label="Barthag" tooltip={TORVIK_TOOLTIPS.barthag}>
                            <span>Barthag</span>
                          </StatWithTooltip>
                        </span>
                        <span className="text-[9px] font-mono" style={{ color: "#71717a" }}>{t.barthag.toFixed(4)}</span>
                      </div>
                    )}
                  </div>
                ))}

                {/* Tempo */}
                {avgTempo && (
                  <div className="flex items-center justify-between">
                    <StatWithTooltip label="Tempo" tooltip={TORVIK_TOOLTIPS.tempo}>
                      <span className="text-[10px]" style={{ color: "#71717a" }}>Avg Tempo</span>
                    </StatWithTooltip>
                    <span className="text-[10px] font-mono" style={{ color: tempoColor }}>{avgTempo.toFixed(1)} poss/40min</span>
                  </div>
                )}

                {/* PrizePicks implied team totals */}
                {pp && (pp.homeProj != null || pp.awayProj != null) && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px]" style={{ color: "#71717a" }}>PrizePicks</span>
                    <span className="text-[10px] font-mono" style={{ color: "#a1a1aa" }}>
                      {pp.homeProj != null && <span>{play.homeTeamAbbr} <span style={{ color: "#60a5fa" }}>{pp.homeProj}</span></span>}
                      {pp.homeProj != null && pp.awayProj != null && <span style={{ color: "#3f3f46" }}> · </span>}
                      {pp.awayProj != null && <span>{play.awayTeamAbbr} <span style={{ color: "#60a5fa" }}>{pp.awayProj}</span></span>}
                      {pp.homeProj != null && pp.awayProj != null && (
                        <span style={{ color: "#52525b" }}> = {(pp.homeProj + pp.awayProj).toFixed(1)}</span>
                      )}
                    </span>
                  </div>
                )}

                {/* Underdog implied team totals */}
                {ud && (ud.homeProj != null || ud.awayProj != null) && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px]" style={{ color: "#71717a" }}>Underdog</span>
                    <span className="text-[10px] font-mono" style={{ color: "#a1a1aa" }}>
                      {ud.homeProj != null && <span>{play.homeTeamAbbr} <span style={{ color: "#818cf8" }}>{ud.homeProj}</span></span>}
                      {ud.homeProj != null && ud.awayProj != null && <span style={{ color: "#3f3f46" }}> · </span>}
                      {ud.awayProj != null && <span>{play.awayTeamAbbr} <span style={{ color: "#818cf8" }}>{ud.awayProj}</span></span>}
                      {ud.homeProj != null && ud.awayProj != null && (
                        <span style={{ color: "#52525b" }}> = {(ud.homeProj + ud.awayProj).toFixed(1)}</span>
                      )}
                    </span>
                  </div>
                )}

                {/* TeamRankings season scoring model */}
                {tr?.impliedTotal != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px]" style={{ color: "#71717a" }}>TeamRankings</span>
                    <span className="text-[10px] font-mono" style={{ color: "#a1a1aa" }}>
                      {tr.home?.ppg != null && <span>{play.homeTeamAbbr} <span style={{ color: "#34d399" }}>{tr.home.ppg.toFixed(1)}</span></span>}
                      {tr.home?.ppg != null && tr.away?.ppg != null && <span style={{ color: "#3f3f46" }}> · </span>}
                      {tr.away?.ppg != null && <span>{play.awayTeamAbbr} <span style={{ color: "#34d399" }}>{tr.away.ppg.toFixed(1)}</span></span>}
                      {" "}
                      <span style={{ color: "#52525b" }}>→ {tr.impliedTotal.toFixed(1)}</span>
                    </span>
                  </div>
                )}

                {/* CBBReference SRS / SOS */}
                {hasCbbRef && [
                  { label: play.homeTeamAbbr, c: hcbb },
                  { label: play.awayTeamAbbr, c: acbb },
                ].map(({ label, c }) => c && (c.srs != null || c.sos != null) && (
                  <div key={`cbb-${label}`} className="flex items-center justify-between">
                    <span className="text-[10px]" style={{ color: "#71717a" }}>{label} (CBBRef)</span>
                    <span className="text-[9px] font-mono" style={{ color: "#a1a1aa" }}>
                      {c.srs != null && (
                        <>
                          <StatWithTooltip label="SRS" tooltip={TORVIK_TOOLTIPS.srs}>
                            <span>SRS</span>
                          </StatWithTooltip>{" "}
                          <span style={{ color: c.srs > 0 ? "#00d4aa" : "#ef4444" }}>{c.srs.toFixed(1)}</span>
                        </>
                      )}
                      {c.srs != null && c.sos != null && <span style={{ color: "#3f3f46" }}> · </span>}
                      {c.sos != null && (
                        <>
                          <StatWithTooltip label="SOS" tooltip={TORVIK_TOOLTIPS.sos}>
                            <span>SOS</span>
                          </StatWithTooltip>{" "}
                          <span style={{ color: c.sos > 0 ? "#00d4aa" : "#ef4444" }}>{c.sos.toFixed(1)}</span>
                        </>
                      )}
                    </span>
                  </div>
                ))}

                {/* Composite projection vs live line */}
                {compositeTotal && (
                  <div className="flex items-center justify-between pt-0.5 mt-0.5" style={{ borderTop: "1px solid #1e293b" }}>
                    <span className="text-[10px] font-semibold" style={{ color: "#60a5fa" }}>Composite Proj.</span>
                    <span className="text-[10px] font-mono font-bold" style={{ color: leanColor(compositeLean) }}>
                      {compositeTotal.toFixed(1)} pts
                      {compositeLean != null && (
                        <span style={{ color: "#52525b" }}> ({compositeLean > 0 ? "+" : ""}{compositeLean.toFixed(1)} vs line)</span>
                      )}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* ── INJURY REPORT (Rotowire) ────────────────────────────────── */}
        {enrichedData && (enrichedData.injuries.home || enrichedData.injuries.away) && (() => {
          const hi = enrichedData.injuries.home;
          const ai = enrichedData.injuries.away;
          const allPlayers = [
            ...(hi?.injuries ?? []).map(p => ({ ...p, side: play.homeTeamAbbr })),
            ...(ai?.injuries ?? []).map(p => ({ ...p, side: play.awayTeamAbbr })),
          ];
          if (!allPlayers.length) return null;
          return (
            <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #2d1f1f" }}>
              <div className="flex items-center justify-between px-3 py-2" style={{ background: "#1a0f0f" }}>
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#f87171" }}>Injury Report</span>
                {(hi?.hasKeyPlayerOut || ai?.hasKeyPlayerOut) && (
                  <span className="text-[9px] font-bold px-2 py-0.5 rounded-full"
                    style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.3)" }}>
                    {(hi?.out ?? 0) + (ai?.out ?? 0)} Out/Doubtful
                  </span>
                )}
              </div>
              <div className="px-3 py-2 space-y-1" style={{ background: "#100a0a" }}>
                {allPlayers.slice(0, 8).map((p, i) => {
                  const statusColor = p.status === "Out" ? "#ef4444" : p.status === "Doubtful" ? "#f59e0b" : "#71717a";
                  return (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[9px] font-bold shrink-0"
                          style={{ background: "#1a1a1a", color: "#52525b", border: "1px solid #27272a", padding: "1px 4px", borderRadius: 3 }}>
                          {p.side}
                        </span>
                        <span className="text-[10px] truncate" style={{ color: "#a1a1aa" }}>{p.name}</span>
                        {p.position && <span className="text-[9px] shrink-0" style={{ color: "#52525b" }}>{p.position}</span>}
                      </div>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: `${statusColor}18`, color: statusColor, border: `1px solid ${statusColor}40` }}>
                        {p.status}
                      </span>
                    </div>
                  );
                })}
                {allPlayers.length === 0 && (
                  <p className="text-[10px] italic text-center py-1" style={{ color: "#52525b" }}>No injuries reported</p>
                )}
              </div>
            </div>
          );
        })()}

        {/* ── ENGINE SOURCE BREAKDOWN (collapsible) ──────────────────── */}
        {enrichedData?.composite && enrichedData.composite.signals.length > 0 && (
          <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #1f1f1f" }}>
            <button
              data-testid={`ncaab-sources-toggle-${play.gameId}`}
              onClick={() => setSourcesOpen(o => !o)}
              className="w-full flex items-center justify-between px-3 py-2 transition-colors"
              style={{ background: "#0d0d0d" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#111"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#0d0d0d"; }}
            >
              <span className="text-[10px] font-semibold" style={{ color: "#52525b" }}>
                Sources used: {enrichedData.composite.signals.length}
              </span>
              <ChevronDown className="w-3 h-3 transition-transform duration-200"
                style={{ color: "#52525b", transform: sourcesOpen ? "rotate(180deg)" : "rotate(0deg)" }} />
            </button>
            <div style={{ maxHeight: sourcesOpen ? "300px" : "0px", overflow: "hidden", transition: "max-height 250ms ease", background: "#080808" }}>
              <div className="px-3 py-2 space-y-1">
                {enrichedData.composite.signals.map((sig, i) => (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span className="text-[10px]" style={{ color: "#71717a" }}>{sig.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono"
                        style={{ color: sig.diff > 0.5 ? "#00d4aa" : sig.diff < -0.5 ? "#ef4444" : "#52525b" }}>
                        {sig.diff > 0 ? "+" : ""}{sig.diff.toFixed(1)} pts
                      </span>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                        style={{ background: "#1a1a1a", color: "#52525b", border: "1px solid #27272a" }}>
                        {sig.weight}x
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

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
                        {marketLabel(m)} · Engine {gaugeForMarket(m)?.toFixed(1) ?? "--"}%
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
                    return `${play.awayTeamAbbr} @ ${play.homeTeamAbbr} · ${marketLabel(m)} · Engine: ${gaugeForMarket(m)?.toFixed(1) ?? "--"}%`;
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

// ── GameChip component ────────────────────────────────────────────────────────
// Returns color tier for chip border/bg based on play edge and probability
function getChipColorTier(play: NCAABPlay | undefined): "green" | "yellow" | "red" | "neutral" {
  if (!play) return "neutral";
  const edge = Math.abs(play.totalEdge ?? 0);
  const ftMktChip = play.engineOutput?.markets?.full_total;
  const prob = ftMktChip?.available ? ftMktChip.modelProb : null;
  const confidence = prob !== null ? Math.max(prob, 100 - prob) : 0;
  if (edge >= 10 || confidence >= 70) return "green";
  if (edge >= 5 || confidence >= 60) return "yellow";
  return "red";
}

function getChipValueSignal(play: NCAABPlay | undefined): { label: string; color: string; bg: string } | null {
  if (!play) return null;
  const edge = Math.abs(play.totalEdge ?? 0);
  const bettingWindow = play.bettingWindow;
  if (bettingWindow === "HALFTIME" && edge >= 5) {
    return { label: "2H EDGE", color: "#00d4aa", bg: "rgba(0,212,170,0.15)" };
  }
  if (edge >= 10) {
    return { label: `+${edge.toFixed(0)}%`, color: "#00d4aa", bg: "rgba(0,212,170,0.12)" };
  }
  if (edge >= 5) {
    return { label: `+${edge.toFixed(0)}%`, color: "#f59e0b", bg: "rgba(245,158,11,0.12)" };
  }
  return null;
}

function GameChip({
  game: g,
  isSelected,
  onChipClick,
  oddsData,
  onEnterViewport,
  valueSig,
  colorTier,
}: {
  game: NCAABGame;
  isSelected: boolean;
  onChipClick: () => void;
  oddsData: ChipOddsData | null;
  onEnterViewport: (gameId: string) => void;
  valueSig: { label: string; color: string; bg: string } | null;
  colorTier: "green" | "yellow" | "red" | "neutral";
}) {
  const isFinal     = g.status === "Final";
  const isScheduled = !g.isLive && !isFinal;
  const tipoffTime  = g.startTime
    ? new Date(g.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
    : null;

  const chipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = chipRef.current;
    if (!el || !isScheduled) return;
    const obs = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting) {
          onEnterViewport(g.id);
          obs.disconnect();
        }
      },
      { threshold: 0.1 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [g.id, isScheduled]); // eslint-disable-line react-hooks/exhaustive-deps

  const sharpSignal = oddsData?.homeWinPct != null && oddsData?.spreadDetails != null
    ? detectSharpMoney({
        homeWinPct: oddsData.homeWinPct,
        spreadDetails: oddsData.spreadDetails,
        homeTeamName: g.homeTeam,
        awayTeamName: g.awayTeam,
      })
    : null;

  return (
    <button
      ref={chipRef}
      data-testid={`ncaab-chip-${g.id}`}
      onClick={onChipClick}
      style={{
        minWidth: 160,
        maxWidth: 200,
        background: isSelected
          ? "#1f1f1f"
          : colorTier === "green" ? "rgba(0,212,170,0.05)"
          : colorTier === "yellow" ? "rgba(245,158,11,0.05)"
          : colorTier === "red" ? "rgba(239,68,68,0.05)"
          : "#111111",
        border: isSelected
          ? "1.5px solid #00d4aa"
          : g.isLive
          ? "1px solid rgba(0,212,170,0.2)"
          : "1px solid #27272a",
        borderLeft: isSelected ? undefined
          : colorTier === "green" ? "3px solid #00d4aa"
          : colorTier === "yellow" ? "3px solid #f59e0b"
          : colorTier === "red" ? "3px solid #ef4444"
          : undefined,
        borderRadius: 8,
        padding: "8px 14px",
        cursor: "pointer",
        transition: "all 150ms ease",
        textAlign: "left",
        flexShrink: 0,
        position: "relative",
      }}
      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.borderColor = "#3f3f46"; }}
      onMouseLeave={e => {
        if (!isSelected) {
          e.currentTarget.style.border = g.isLive ? "1px solid rgba(0,212,170,0.2)" : "1px solid #27272a";
          if (colorTier !== "neutral") {
            e.currentTarget.style.borderLeft = colorTier === "green" ? "3px solid #00d4aa" : colorTier === "yellow" ? "3px solid #f59e0b" : "3px solid #ef4444";
          }
        }
      }}
    >
      {/* Value signal badge (top-right pill) or sharp signal dot */}
      {valueSig ? (
        <span
          style={{
            position: "absolute",
            top: 5,
            right: 6,
            background: valueSig.bg,
            border: `1px solid ${valueSig.color}44`,
            borderRadius: 9999,
            padding: "1px 6px",
            fontSize: 9,
            fontWeight: 700,
            color: valueSig.color,
            letterSpacing: "0.03em",
            lineHeight: 1.4,
          }}
        >
          {valueSig.label}
        </span>
      ) : sharpSignal ? (
        <span
          title={`${sharpSignal.label} → ${sharpSignal.teamName}`}
          style={{
            position: "absolute",
            top: 5,
            right: 5,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: sharpSignal.strength >= 15 ? "#ef4444" : "#f59e0b",
            boxShadow: `0 0 4px ${sharpSignal.strength >= 15 ? "#ef444488" : "#f59e0b88"}`,
          }}
        />
      ) : null}
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
      {/* Status + O/U row */}
      <div className="flex items-center justify-between gap-1 mt-1">
        <div className="flex items-center gap-1">
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
        {isScheduled && oddsData?.overUnder != null && (
          <span style={{ color: "#52525b", fontSize: 10, fontFamily: "monospace", flexShrink: 0 }}>
            O/U {oddsData.overUnder}
          </span>
        )}
        {isScheduled && oddsData?.fetching && !oddsData?.overUnder && (
          <span style={{ color: "#3f3f46", fontSize: 9 }}>·</span>
        )}
      </div>
    </button>
  );
}

function NCAABGamesStrip({
  games,
  expandedGameId,
  onChipClick,
  plays,
  collapsed,
  onCollapsedChange,
}: {
  games: NCAABGame[];
  expandedGameId: string | null;
  onChipClick: (id: string) => void;
  plays: NCAABPlay[];
  collapsed: boolean;
  onCollapsedChange: (v: boolean) => void;
}) {
  const liveCount = games.filter(g => g.isLive).length;
  const allFinal  = games.length > 0 && games.every(g => g.status === "Final");
  const timeGroups = groupGamesByTipoff(games);

  const initializedKeys = useRef<Set<string>>(new Set());

  // Chip odds state — lazy loaded via IntersectionObserver per chip
  const [chipOdds, setChipOdds] = useState<Record<string, ChipOddsData>>({});
  const fetchedChipIds = useRef<Set<string>>(new Set());

  const fetchChipOdds = useCallback(async (gameId: string) => {
    if (fetchedChipIds.current.has(gameId)) return;
    fetchedChipIds.current.add(gameId);
    setChipOdds(prev => ({ ...prev, [gameId]: { overUnder: null, homeWinPct: null, spreadDetails: null, fetching: true } }));
    try {
      const res = await fetch(`/api/ncaab/chip-odds?gameId=${gameId}`);
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      setChipOdds(prev => ({ ...prev, [gameId]: { overUnder: data.overUnder ?? null, homeWinPct: data.homeWinPct ?? null, spreadDetails: data.spreadDetails ?? null, fetching: false } }));
    } catch {
      setChipOdds(prev => ({ ...prev, [gameId]: { overUnder: null, homeWinPct: null, spreadDetails: null, fetching: false } }));
    }
  }, []);

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

  // ── Strip collapse state — controlled from parent ─────────────────────────
  const stripCollapsed = collapsed;
  const setStripCollapsed = (fn: boolean | ((prev: boolean) => boolean)) => {
    onCollapsedChange(typeof fn === "function" ? fn(collapsed) : fn);
  };

  // ── Chip row width measurement (kept for ref; chips now wrap) ─────────────
  const stripContainerRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={stripContainerRef}>
      <style>{`@keyframes ncaabFadeIn { from { opacity: 0 } to { opacity: 1 } }`}</style>
      {/* ── Strip header ───────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: stripCollapsed ? 0 : 10 }}>
        <button
          data-testid="button-strip-toggle"
          onClick={() => setStripCollapsed(c => !c)}
          style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
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
          <ChevronDown
            size={12}
            style={{ color: "#52525b", transform: stripCollapsed ? "rotate(180deg)" : "none", transition: "transform 200ms ease", marginLeft: 2 }}
          />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {liveCount > 0 && (
            <span style={{ color: "#4ade80", fontSize: 11, fontWeight: 500, marginRight: 8 }}>
              ● {liveCount} Live
            </span>
          )}
          {!stripCollapsed && (
            <>
              <button
                onClick={() => {
                  const allOpen: Record<string, boolean> = {};
                  timeGroups.forEach(g => { allOpen[g.key] = true; });
                  setOpenGroups(prev => ({ ...prev, ...allOpen }));
                }}
                style={{ color: "#52525b", fontSize: 11, fontWeight: 500, background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }}
              >
                Expand All
              </button>
              <span style={{ color: "#3f3f46", fontSize: 11 }}>·</span>
              <button
                onClick={() => {
                  const allClosed: Record<string, boolean> = {};
                  timeGroups.forEach(g => { allClosed[g.key] = false; });
                  setOpenGroups(prev => ({ ...prev, ...allClosed }));
                }}
                style={{ color: "#52525b", fontSize: 11, fontWeight: 500, background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }}
              >
                Collapse All
              </button>
            </>
          )}
        </div>
      </div>

      {!stripCollapsed && (
      <>
      {/* ── Value legend row (only when any chip has a signal) ──────────── */}
      {(() => {
        const getEdge = (p: NCAABPlay) => {
          const ft = p.engineOutput?.markets?.full_total;
          return ft?.available && ft.edge != null ? Math.abs(ft.edge) : 0;
        };
        const hasTeal  = plays.some(p => getEdge(p) >= 10 || p.bettingWindow === "HALFTIME");
        const hasAmber = plays.some(p => { const e = getEdge(p); return e >= 5 && e < 10 && p.bettingWindow !== "HALFTIME"; });
        if (!hasTeal && !hasAmber) return null;
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, paddingLeft: 2 }}>
            <span style={{ color: "#52525b", fontSize: 10, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em" }}>Legend:</span>
            {hasTeal && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ background: "rgba(0,212,170,0.15)", border: "1px solid rgba(0,212,170,0.27)", borderRadius: 9999, padding: "1px 6px", fontSize: 9, fontWeight: 700, color: "#00d4aa" }}>+10%</span>
                <span style={{ fontSize: 10, color: "#71717a" }}>Strong edge</span>
              </span>
            )}
            {hasAmber && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.27)", borderRadius: 9999, padding: "1px 6px", fontSize: 9, fontWeight: 700, color: "#f59e0b" }}>+5%</span>
                <span style={{ fontSize: 10, color: "#71717a" }}>Moderate edge</span>
              </span>
            )}
          </div>
        );
      })()}

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
                {/* Chips — wrap to multiple rows when there are many games */}
                {isOpen && (
                  <div className="pb-2 mb-1">
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {group.games.map(g => {
                        const matchedPlay = plays.find(p => p.gameId === g.id);
                        return (
                          <GameChip
                            key={g.id}
                            game={g}
                            isSelected={expandedGameId === g.id}
                            onChipClick={() => onChipClick(g.id)}
                            oddsData={chipOdds[g.id] ?? null}
                            onEnterViewport={fetchChipOdds}
                            valueSig={getChipValueSignal(matchedPlay)}
                            colorTier={getChipColorTier(matchedPlay)}
                          />
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
      </>
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
  onAddToCard,
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
  onAddToCard?: (market: NCAABMarketClient) => void;
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
                    className={`scroll-mt-20 flex items-center justify-between px-4 py-3 rounded-lg transition-all duration-200 ${canExpand ? "cursor-pointer" : "cursor-default"}`}
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
                          {g.enginePreGame?.overProb != null ? (
                            <span
                              data-testid={`ncaab-pregame-pill-${g.id}`}
                              className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                              style={{ background: "rgba(0,212,170,0.08)", border: "1px solid rgba(0,212,170,0.2)", color: "#00d4aa" }}
                            >
                              Pre-game model · {g.enginePreGame.overProb > 50 ? "O" : "U"} {Math.round(Math.max(g.enginePreGame.overProb, 100 - g.enginePreGame.overProb))}%
                            </span>
                          ) : (
                            <span className="text-[11px]" style={{ color: "#52525b" }}>
                              {(() => {
                                if (!g.startTime) return "Scheduled";
                                const ms = new Date(g.startTime).getTime() - Date.now();
                                if (ms <= 0) return formatTipoffTime(g.startTime);
                                const h = Math.floor(ms / 3600000);
                                const m = Math.floor((ms % 3600000) / 60000);
                                return h > 0 ? `Tipoff in ${h}h ${m}m` : `Tipoff in ${m}m`;
                              })()}
                            </span>
                          )}
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
                      onAddToCard={onAddToCard}
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
                      onAddToParlay={onAddToParlay}
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
  onAddToParlay,
}: {
  game: NCAABGame;
  onH2hReady: (gameId: string, data: H2HGame[]) => void;
  onAddToParlay?: (pick: ParlayPickInput) => void;
}) {
  const [countdown, setCountdown] = useState("");
  const [timerState, setTimerState] = useState<"countdown" | "live">("countdown");
  const [h2hData, setH2hData] = useState<H2HGame[] | null>(null);
  const [h2hOpen, setH2hOpen] = useState(true); // item 3: expanded by default in pre-game
  const [headerFlash, setHeaderFlash] = useState(false);
  const [preChipOdds, setPreChipOdds] = useState<ChipOddsData | null>(null);
  const [addedLegKey, setAddedLegKey] = useState<string | null>(null);
  const [pendingLeg, setPendingLeg] = useState<{
    legKey: string; market: "total" | "spread";
    direction: "over" | "under"; line: number; prob: number; tierLabel: string;
  } | null>(null);
  const didFireZero = useRef(false);

  // ── Pre-game parlay helpers ────────────────────────────────────────────────
  const buildPreGamePick = (
    market: "total" | "spread", direction: "over" | "under",
    line: number, prob: number, tierLabel: string
  ): ParlayPickInput => {
    const rawOdds = prob >= 50
      ? -Math.round((prob / (100 - prob)) * 100)
      : Math.round(((100 - prob) / prob) * 100);
    return {
      playerId: 0,
      playerName: `${game.awayTeamAbbr} @ ${game.homeTeamAbbr}`,
      playerTeam: "NCAAB",
      statType: market === "total" ? "ncaab_pre_game_total" : "ncaab_pre_game_spread",
      line,
      probability: prob,
      betDirection: direction,
      sportsbook: "pregame",
      gameId: game.id,
      oddsAmerican: rawOdds,
      type: "pre_game",
      confidenceTier: tierLabel,
    };
  };

  const handleScheduledMarketClick = (market: "total" | "spread", direction: "over" | "under") => {
    if (!onAddToParlay) return;
    const overProbRaw = game.enginePreGame?.overProb ?? null;
    const underProbRaw = overProbRaw != null ? parseFloat((100 - overProbRaw).toFixed(1)) : null;
    const line = market === "total" ? (preChipOdds?.overUnder ?? 0) : 0;
    const prob = market === "total"
      ? (direction === "over" ? overProbRaw : underProbRaw)
      : (preChipOdds?.homeWinPct ?? null);
    if (prob === null) return;
    const tier = getPreGameConfidenceTier(overProbRaw);
    const tierLabel = tier?.label ?? "Pre-Game";
    const legKey = `${market}:${direction}`;
    if (addedLegKey === legKey) {
      setAddedLegKey(null);
      return;
    }
    if (addedLegKey && addedLegKey !== legKey) {
      setPendingLeg({ legKey, market, direction, line, prob, tierLabel });
      return;
    }
    onAddToParlay(buildPreGamePick(market, direction, line, prob, tierLabel));
    setAddedLegKey(legKey);
  };

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

  // Fetch chip-odds once on mount — for sharp money signal
  useEffect(() => {
    fetch(`/api/ncaab/chip-odds?gameId=${game.id}`)
      .then(r => r.ok ? r.json() : { overUnder: null, homeWinPct: null, spreadDetails: null })
      .then(data => setPreChipOdds({ overUnder: data.overUnder ?? null, homeWinPct: data.homeWinPct ?? null, spreadDetails: data.spreadDetails ?? null }))
      .catch(() => setPreChipOdds({ overUnder: null, homeWinPct: null, spreadDetails: null }));
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

      {/* Pre-game lines summary (O/U + sharp signal) */}
      {preChipOdds && (() => {
        const sharp = detectSharpMoney({
          homeWinPct: preChipOdds.homeWinPct,
          spreadDetails: preChipOdds.spreadDetails,
          homeTeamName: game.homeTeam,
          awayTeamName: game.awayTeam,
        });
        const hasAnything = preChipOdds.overUnder != null || sharp != null;
        if (!hasAnything) return null;
        return (
          <div className="space-y-2">
            {preChipOdds.overUnder != null && (
              <div className="flex items-center justify-between rounded-lg px-4 py-2.5"
                style={{ background: "#111111", border: "1px solid #27272a" }}>
                <span className="text-xs font-semibold" style={{ color: "#71717a" }}>O/U Total</span>
                <span className="text-sm font-bold tabular-nums" style={{ color: "#ffffff", fontFamily: "monospace" }}>
                  {preChipOdds.overUnder}
                </span>
              </div>
            )}
            {sharp && (() => {
              const sharpColor = sharp.strength >= 15 ? "#ef4444" : "#f59e0b";
              return (
                <div className="rounded-lg flex items-center justify-between gap-2"
                  style={{ background: "#0d0d0d", border: "1px solid #27272a", borderLeft: `3px solid ${sharpColor}`, padding: "10px 16px" }}>
                  <div>
                    <p className="text-xs font-semibold" style={{ color: sharpColor }}>{sharp.label}</p>
                    <p style={{ color: "#71717a", fontSize: 10 }}>ESPN model vs market · {sharp.teamName}</p>
                  </div>
                  <span
                    className="text-[10px] font-black px-2 py-0.5 rounded-full shrink-0"
                    style={{ background: `${sharpColor}22`, color: sharpColor, border: `1px solid ${sharpColor}44`, fontFamily: "monospace" }}
                  >
                    {sharp.sharpSide === "home" ? "↑" : "↓"} {sharp.teamName.split(" ").pop()}
                  </span>
                </div>
              );
            })()}
          </div>
        );
      })()}

      {/* ── Pre-game confidence gauge + tier label ──────────────────────── */}
      {(() => {
        const overProb = game.enginePreGame?.overProb ?? null;
        const tier = getPreGameConfidenceTier(overProb);
        const gaugeVal = overProb;
        const isLowTier = !tier || tier.label === "No Edge" || tier.label === "Low Confidence";
        const gaugeColor = (gaugeVal === null || isLowTier) ? "#52525b" : (gaugeVal > 50 ? "#00d4aa" : "#ef4444");
        const circum = 2 * Math.PI * 68;
        return (
          <div className="flex items-center gap-4 py-1">
            <div style={{ position: "relative", width: 80, height: 80, flexShrink: 0 }}>
              <svg viewBox="0 0 160 160" style={{ width: 80, height: 80, transform: "rotate(-90deg)" }}>
                <circle cx={80} cy={80} r={68} fill="none" stroke="#27272a" strokeWidth={10} />
                {gaugeVal !== null && (
                  <circle
                    cx={80} cy={80} r={68} fill="none" stroke={gaugeColor} strokeWidth={10}
                    strokeDasharray={String(circum)}
                    strokeDashoffset={circum * (1 - gaugeVal / 100)}
                    strokeLinecap="round"
                    style={{ transition: "stroke-dashoffset 300ms ease, stroke 300ms ease" }}
                  />
                )}
              </svg>
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                <span style={{ color: gaugeVal === null ? "#52525b" : (isLowTier ? "#52525b" : gaugeColor), fontSize: 18, fontWeight: 900, lineHeight: 1, fontFamily: "monospace" }}>
                  {gaugeVal != null ? `${Math.round(gaugeVal)}%` : "--"}
                </span>
                <span style={{ color: "#71717a", fontSize: 8, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 2 }}>PRE-GAME</span>
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs" style={{ color: "#71717a" }}>PRE-GAME</p>
              {tier ? (
                <>
                  <p className="text-xs font-semibold" style={{ color: tier.color }}>{tier.label}</p>
                  <p style={{ color: "#52525b", fontSize: 10, marginTop: 2 }}>{tier.sublabel}</p>
                </>
              ) : (
                <p className="text-xs font-semibold" style={{ color: "#52525b" }}>Engine data loading…</p>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Verdict row with tier pill ───────────────────────────────────── */}
      {game.enginePreGame?.overProb != null && (() => {
        const overProb = game.enginePreGame!.overProb;
        const tier = getPreGameConfidenceTier(overProb);
        if (!tier) return null;
        const isLowTier = tier.label === "No Edge" || tier.label === "Low Confidence";
        const edgeGap = parseFloat(Math.abs(overProb - 50).toFixed(1));
        const edgeSide = overProb > 50 ? "Over" : "Under";
        const evColor = isLowTier ? "#52525b" : (overProb > 50 ? "#00d4aa" : "#ef4444");
        const edgeLabel = edgeGap >= 18 ? `Strong ${edgeSide} EV`
          : edgeGap >= 10 ? `Lean ${edgeSide} EV`
          : edgeGap >= 5 ? `Slight ${edgeSide} Lean`
          : "Neutral — No Edge";
        return (
          <div
            className="rounded-lg flex items-center justify-between gap-2"
            style={{ background: "#111111", border: "1px solid #27272a", borderLeft: `3px solid ${isLowTier ? "#52525b" : evColor}`, padding: "12px 16px" }}
          >
            <div>
              <p className="text-sm font-semibold" style={{ color: isLowTier ? "#71717a" : evColor }}>{edgeLabel}</p>
              <p className="text-xs" style={{ color: "#a1a1aa" }}>Engine {overProb.toFixed(1)}% pre-game</p>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              {edgeGap >= 5 && (
                <span
                  className="text-[10px] font-black px-2 py-0.5 rounded-full"
                  style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.3)", fontFamily: "monospace" }}
                >
                  +{edgeGap}pp
                </span>
              )}
              <span
                className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                style={{ background: tier.bg, border: `1px solid ${tier.border}`, color: tier.color }}
              >
                {tier.label}
              </span>
            </div>
          </div>
        );
      })()}

      {/* ── Market buttons (Over / Under) with tier micro-text ──────────── */}
      {onAddToParlay && preChipOdds?.overUnder != null && (() => {
        const overProbRaw = game.enginePreGame?.overProb ?? null;
        const underProbRaw = overProbRaw != null ? parseFloat((100 - overProbRaw).toFixed(1)) : null;
        const tier = getPreGameConfidenceTier(overProbRaw);
        const line = preChipOdds.overUnder;
        return (
          <div className="grid grid-cols-2 gap-2">
            {(["over", "under"] as const).map(dir => {
              const legKey = `total:${dir}`;
              const isSelected = addedLegKey === legKey;
              const isPending = pendingLeg?.legKey === legKey;
              const mColor = dir === "over" ? "#00d4aa" : "#ef4444";
              const mProb = dir === "over" ? overProbRaw : underProbRaw;
              return (
                <div key={dir}>
                  <button
                    data-testid={`ncaab-scheduled-${dir}-${game.id}`}
                    onClick={() => handleScheduledMarketClick("total", dir)}
                    className="w-full rounded-lg py-2.5 px-2 flex flex-col items-center gap-0.5 transition-all duration-200 relative"
                    style={{
                      background: isSelected ? "#1f1f1f" : "#181818",
                      border: isSelected ? `1.5px solid ${mColor}` : "1px solid #27272a",
                    }}
                  >
                    <span className="text-xs font-black uppercase tracking-widest" style={{ color: "#71717a" }}>{dir}</span>
                    <span className="text-xl font-bold tabular-nums leading-tight" style={{ color: "#ffffff" }}>{line}</span>
                    <span className="text-sm font-semibold" style={{ color: mProb != null ? mColor : "#52525b" }}>
                      {mProb != null ? `${mProb.toFixed(1)}%` : "--"}
                    </span>
                    {tier && (
                      <span className="text-[10px] mt-0.5" style={{ color: tier.color }}>{tier.label}</span>
                    )}
                    {isSelected && (
                      <span style={{
                        position: "absolute", top: 4, right: 4, background: mColor, color: "#000",
                        fontSize: 10, fontWeight: 900, width: 16, height: 16, borderRadius: "50%",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>✓</span>
                    )}
                  </button>
                  {isPending && (
                    <div className="mt-1 rounded-lg px-3 py-2" style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}>
                      <p className="text-xs" style={{ color: "#f59e0b" }}>Replace current pick with this?</p>
                      <div className="flex gap-2 mt-1.5">
                        <button
                          onClick={() => setPendingLeg(null)}
                          style={{ color: "#71717a", background: "#27272a", border: "none", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => {
                            if (mProb === null) return;
                            onAddToParlay!(buildPreGamePick("total", dir, line, mProb, tier?.label ?? "Pre-Game"));
                            setAddedLegKey(legKey);
                            setPendingLeg(null);
                          }}
                          style={{ color: "#000", background: "#f59e0b", border: "none", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                        >
                          Replace
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* ── Pre-game signal note ─────────────────────────────────────────── */}
      {(() => {
        const tier = getPreGameConfidenceTier(game.enginePreGame?.overProb ?? null);
        const isLow = !tier || tier.label === "No Edge" || tier.label === "Low Confidence";
        return (
          <p className="text-xs italic" style={{ color: "#52525b", paddingTop: 2 }}>
            {isLow
              ? "Pre-game signal · Insufficient edge — check back at tipoff"
              : "Pre-game signal · Updates live at tipoff"}
          </p>
        );
      })()}

      {/* H2H section (item 3: open by default, collapses on transition) */}
      <H2HSection h2hData={h2hData} h2hOpen={h2hOpen} setH2hOpen={setH2hOpen} />
    </div>
  );
}

interface NCAABAdminTabProps {
  onAddToParlay?: (pick: ParlayPickInput) => void;
  /** Canonical market pass-through: receives the NCAABMarket object directly */
  onAddToCard?: (market: NCAABMarketClient) => void;
  isAdmin?: boolean;
  expandToGameId?: string | null;
}

export function NCAABAdminTab({ onAddToParlay, onAddToCard, expandToGameId, isAdmin }: NCAABAdminTabProps) {
  const [ncaabSubTab, setNcaabSubTab] = useState<"live" | "halftime">("live");
  const [ncaabBookFilter, setNcaabBookFilter] = useState<string>("all");
  const [cacheClearPending, setCacheClearPending] = useState(false);
  const [cacheClearMsg, setCacheClearMsg] = useState<string | null>(null);

  const handleClearEnrichmentCache = async () => {
    if (cacheClearPending) return;
    setCacheClearPending(true);
    setCacheClearMsg(null);
    try {
      const res = await fetch("/api/ncaab/admin/cache-clear", { method: "POST" });
      const data = await res.json() as any;
      if (res.ok) {
        setCacheClearMsg(`Cleared · ${data.stats?.games ?? 0} games flushed`);
        setTimeout(() => setCacheClearMsg(null), 4000);
      } else {
        setCacheClearMsg("Clear failed");
        setTimeout(() => setCacheClearMsg(null), 3000);
      }
    } catch {
      setCacheClearMsg("Network error");
      setTimeout(() => setCacheClearMsg(null), 3000);
    } finally {
      setCacheClearPending(false);
    }
  };

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
  const [gamesStripCollapsed, setGamesStripCollapsed] = useState(false);
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
      rowRefs.current[gameId]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 150);
  }, []);

  const handleExpandGame = (id: string | null) => {
    if (id !== null) {
      handleChipClick(id);
    } else {
      setExpandedGameId(null);
    }
  };

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

  // Dynamic refresh state ───────────────────────────────────────────────────────
  const gamesRef       = useRef<NCAABGame[]>([]);
  const lastRefreshAt  = useRef<number>(Date.now());
  const [countdown, setCountdown] = useState<number>(300);

  const playsQuery = useQuery<{ plays: NCAABPlay[] }>({
    queryKey: ["/api/ncaab/plays"],
    refetchInterval: () => getTournamentAwareInterval(gamesRef.current),
  });

  const gamesQuery = useQuery<{ games: NCAABGame[] }>({
    queryKey: ["/api/ncaab/games"],
    refetchInterval: () => getTournamentAwareInterval(gamesRef.current),
  });

  const plays   = playsQuery.data?.plays ?? [];
  const games   = gamesQuery.data?.games ?? [];

  // Keep gamesRef in sync for interval calculation ──────────────────────────────
  useEffect(() => {
    if (gamesQuery.data?.games) gamesRef.current = gamesQuery.data.games;
  }, [gamesQuery.data]);

  // Reset countdown clock whenever data refreshes ───────────────────────────────
  useEffect(() => {
    lastRefreshAt.current = Date.now();
  }, [playsQuery.dataUpdatedAt]);

  // Countdown ticker (only meaningful when idle at 300s interval) ───────────────
  useEffect(() => {
    const timer = setInterval(() => {
      const interval = getTournamentAwareInterval(gamesRef.current);
      const elapsed  = Math.floor((Date.now() - lastRefreshAt.current) / 1000);
      setCountdown(Math.max(0, Math.floor(interval / 1000) - elapsed));
    }, 1000);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh immediately when tab regains focus ──────────────────────────────────
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        playsQuery.refetch();
        gamesQuery.refetch();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
      const ftMktSum = play?.engineOutput?.markets?.full_total;
      const line     = ftMktSum?.available ? ftMktSum.bookLine : null;
      const overProb = ftMktSum?.available ? ftMktSum.modelProb : null;
      const edgeGap  = ftMktSum?.available && ftMktSum.edge != null ? Math.abs(ftMktSum.edge) : 0;
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
        {/* Refresh indicator */}
        {(() => {
          const isHT       = games.some(g => normalizeGameStatus(g) === "halftime");
          const isActive   = games.some(g => normalizeGameStatus(g) === "in_progress");
          const isUpcoming = games.some(g => {
            if (!g.startTime) return false;
            const m = (new Date(g.startTime).getTime() - Date.now()) / 60000;
            return m <= 30 && m > 0;
          });
          const isMM = isMarchMadness(games);
          if (isHT) return (
            <span data-testid="ncaab-refresh-indicator" className="flex items-center gap-1.5 text-xs" style={{ color: "#71717a" }}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#f59e0b" }} />
              {isMM ? "Tournament · 15s" : "Halftime · 15s"}
            </span>
          );
          if (isActive) return (
            <span data-testid="ncaab-refresh-indicator" className="flex items-center gap-1.5 text-xs" style={{ color: "#71717a" }}>
              <span className="relative flex w-1.5 h-1.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: "#22c55e" }} />
                <span className="relative inline-flex rounded-full w-1.5 h-1.5" style={{ background: "#22c55e" }} />
              </span>
              {isMM ? "Tournament · 15s" : "Live · 20s"}
            </span>
          );
          if (isUpcoming) return (
            <span data-testid="ncaab-refresh-indicator" className="flex items-center gap-1.5 text-xs" style={{ color: "#71717a" }}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#3b82f6" }} />
              {isMM ? "Tournament · 30s" : "Starting soon · 1m"}
            </span>
          );
          return (
            <span data-testid="ncaab-refresh-indicator" className="flex items-center gap-1.5 text-xs" style={{ color: "#52525b" }}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#52525b" }} />
              ↻ {countdown}s
            </span>
          );
        })()}
        <button
          data-testid="ncaab-refresh"
          onClick={() => { playsQuery.refetch(); gamesQuery.refetch(); }}
          disabled={loading}
          className="flex-shrink-0 p-1.5 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-muted-foreground ${loading ? "animate-spin" : ""}`} />
        </button>
        {isAdmin && (
          <button
            data-testid="ncaab-cache-clear"
            onClick={handleClearEnrichmentCache}
            disabled={cacheClearPending}
            title="Clear analytics enrichment cache (admin)"
            className="flex-shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-semibold transition-colors disabled:opacity-50"
            style={{
              background: cacheClearMsg?.startsWith("Cleared") ? "rgba(0,212,170,0.1)" : "#0d0d0d",
              border: cacheClearMsg?.startsWith("Cleared") ? "1px solid rgba(0,212,170,0.3)" : "1px solid #27272a",
              color: cacheClearMsg?.startsWith("Cleared") ? "#00d4aa" : "#52525b",
            }}
          >
            <RefreshCw className={`w-2.5 h-2.5 ${cacheClearPending ? "animate-spin" : ""}`} />
            {cacheClearMsg ?? "Flush Cache"}
          </button>
        )}
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
          {/* ── Today's Games strip — FIRST in live tab ──────────────────── */}
          {games.length > 0 && (
            <div
              style={{
                background: "#0a0a0a",
                paddingTop: 4,
                paddingBottom: gamesStripCollapsed ? 4 : 8,
                marginBottom: gamesStripCollapsed ? 0 : 4,
                borderBottom: gamesStripCollapsed ? "none" : "1px solid #1c1c1e",
              }}
            >
              <NCAABGamesStrip
                games={games}
                expandedGameId={expandedGameId}
                onChipClick={handleChipClick}
                plays={plays}
                collapsed={gamesStripCollapsed}
                onCollapsedChange={setGamesStripCollapsed}
              />
            </div>
          )}

          {/* Slate complete banner */}
          {allFinal && games.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: "rgba(0,212,170,0.08)", border: "1px solid rgba(0,212,170,0.2)" }}>
              <CheckCircle className="w-4 h-4 shrink-0" style={{ color: "#00d4aa" }} />
              <span className="text-xs font-semibold" style={{ color: "#00d4aa" }}>Slate Complete</span>
            </div>
          )}

          {/* ── Top Plays Feed ──────────────────────────────────────────────── */}
          {hasPlays && (() => {
            const filteredPlays = filterNcaabPlaysByBook(plays, ncaabBookFilter);
            const sortedPlays = filteredPlays;
            return (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    <p data-testid="text-top-plays-count" className="text-sm font-semibold text-foreground">
                      Top Plays · {sortedPlays.length}
                    </p>
                  </div>
                </div>
                {/* Book filter pills */}
                <div data-testid="ncaab-book-filter" className="flex gap-1.5 flex-wrap">
                  {NCAAB_BOOK_OPTIONS.map(opt => {
                    const isActive = ncaabBookFilter === opt.key;
                    const count = opt.key === "all" ? plays.length : filterNcaabPlaysByBook(plays, opt.key).length;
                    return (
                      <button
                        key={opt.key}
                        data-testid={`ncaab-book-filter-${opt.key}`}
                        onClick={() => setNcaabBookFilter(opt.key)}
                        className="px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all duration-200"
                        style={{
                          background: isActive ? "rgba(0,212,170,0.15)" : "#111111",
                          border: isActive ? "1px solid rgba(0,212,170,0.4)" : "1px solid #27272a",
                          color: isActive ? "#00d4aa" : "#71717a",
                        }}
                      >
                        {opt.abbr} {count > 0 && <span className="ml-0.5 tabular-nums">{count}</span>}
                      </button>
                    );
                  })}
                </div>
                {/* Play cards — canonical market-based Top Plays (Phase D) */}
                {(() => {
                  const MARKET_KEYS: NCAABMarketKey[] = ["full_total", "full_spread", "h1_total", "h1_spread", "h2_total", "h2_spread"];
                  const TIER_STYLES: Record<string, { color: string; bg: string; border: string }> = {
                    ELITE: { color: "#00d4aa", bg: "rgba(0,212,170,0.12)", border: "rgba(0,212,170,0.35)" },
                    STRONG: { color: "#f59e0b", bg: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.3)" },
                    VALUE: { color: "#71717a", bg: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.1)" },
                    NONE: { color: "#52525b", bg: "rgba(255,255,255,0.02)", border: "#27272a" },
                  };
                  type TopPlayEntry = { play: NCAABPlay; market: NCAABMarketClient };
                  const allEntries: TopPlayEntry[] = [];
                  for (const p of sortedPlays) {
                    if (!p.engineOutput?.markets) continue;
                    const seen = new Map<string, TopPlayEntry>();
                    for (const key of MARKET_KEYS) {
                      const mkt = p.engineOutput.markets[key];
                      if (!mkt?.available || mkt.edge === null) continue;
                      const existing = seen.get(key);
                      if (existing && Math.abs(existing.market.edge ?? 0) >= Math.abs(mkt.edge)) continue;
                      seen.set(key, { play: p, market: mkt });
                    }
                    Array.from(seen.values()).forEach(entry => allEntries.push(entry));
                  }
                  allEntries.sort((a, b) => Math.abs(b.market.edge ?? 0) - Math.abs(a.market.edge ?? 0));
                  const topEntries = allEntries.slice(0, 20);

                  if (topEntries.length === 0) return null;
                  return (
                    <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollSnapType: "x mandatory" }}>
                      {topEntries.map((entry, idx) => {
                        const { play: p, market: mkt } = entry;
                        const tierStyle = TIER_STYLES[mkt.confidenceTier] ?? TIER_STYLES.NONE;
                        const edgeSide = mkt.side === "OVER" ? "Over" : mkt.side === "UNDER" ? "Under" : mkt.side === "HOME" ? "Home" : mkt.side === "AWAY" ? "Away" : "—";
                        const edgeColor = (mkt.side === "OVER" || mkt.side === "HOME") ? "#00d4aa" : (mkt.side === "UNDER" || mkt.side === "AWAY") ? "#ef4444" : "#71717a";
                        const halfLabel = p.half === 1 ? "H1" : p.half === 2 ? "H2" : "OT";
                        return (
                          <div
                            key={`${p.gameId}-${mkt.marketKey}-${idx}`}
                            data-testid={`ncaab-top-play-${p.gameId}-${mkt.marketKey}`}
                            className="flex-shrink-0 rounded-xl p-3.5 space-y-2"
                            style={{
                              width: 260,
                              background: "#0a0a0a",
                              border: `1px solid ${tierStyle.border}`,
                              scrollSnapAlign: "start",
                            }}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
                                </span>
                                <span className="text-[10px] font-semibold" style={{ color: "#4ade80" }}>{halfLabel} · {p.clock}</span>
                              </div>
                              {mkt.confidenceTier !== "NONE" && (
                                <span
                                  data-testid={`ncaab-tier-badge-${p.gameId}-${mkt.marketKey}`}
                                  className="text-[9px] font-black px-2 py-0.5 rounded-full"
                                  style={{ background: tierStyle.bg, color: tierStyle.color, border: `1px solid ${tierStyle.border}` }}
                                >
                                  {mkt.confidenceTier}
                                </span>
                              )}
                            </div>
                            <p className="text-xs font-bold text-white truncate">{p.awayTeamAbbr} @ {p.homeTeamAbbr}</p>
                            <p className="text-lg font-black tabular-nums" style={{ color: "#ffffff" }}>{p.awayScore} – {p.homeScore}</p>
                            <div className="flex items-center justify-between text-[9px]" style={{ color: "#71717a" }}>
                              <span data-testid={`ncaab-top-play-market-${p.gameId}-${mkt.marketKey}`}>{mkt.label}</span>
                              {mkt.sportsbook && (
                                <span style={{ textTransform: "uppercase" }}>{mkt.sportsbook}</span>
                              )}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <div>
                                <span className="text-sm font-bold" style={{ color: edgeColor }}>{edgeSide} {mkt.bookLine ?? "—"}</span>
                                <span className="text-xs ml-1.5 tabular-nums" style={{ color: edgeColor }}>
                                  {mkt.modelProb != null ? `${mkt.modelProb.toFixed(1)}%` : "—"}
                                </span>
                                {mkt.edge != null && Math.abs(mkt.edge) >= 4 && (
                                  <span className="text-[10px] ml-1 tabular-nums" style={{ color: "#f59e0b" }}>
                                    +{Math.abs(mkt.edge).toFixed(1)}pp
                                  </span>
                                )}
                              </div>
                              {(onAddToParlay || onAddToCard) && (
                                <button
                                  data-testid={`ncaab-top-play-parlay-${p.gameId}-${mkt.marketKey}`}
                                  onClick={() => {
                                    // Pass canonical NCAABMarket object directly
                                    if (onAddToCard) onAddToCard(mkt);
                                    if (onAddToParlay) {
                                      if (mkt.modelProb === null) return;
                                      const prob = mkt.modelProb;
                                      const isSpread = mkt.marketKey.includes("spread");
                                      const dir = isSpread
                                        ? (mkt.side === "AWAY" ? "under" : "over")
                                        : (mkt.side === "UNDER" ? "under" : "over");
                                      const rawOdds = prob >= 50
                                        ? -Math.round((prob / (100 - prob)) * 100)
                                        : Math.round(((100 - prob) / prob) * 100);
                                      onAddToParlay({
                                        playerId: 0,
                                        playerName: `${p.awayTeamAbbr} @ ${p.homeTeamAbbr} ${edgeSide} ${mkt.bookLine ?? ""}`,
                                        playerTeam: "NCAAB",
                                        statType: mkt.marketKey.includes("spread") ? "ncaab_spread" : "ncaab_total",
                                        line: mkt.bookLine ?? 0,
                                        probability: prob,
                                        betDirection: dir,
                                        sportsbook: mkt.sportsbook ?? "fanduel",
                                        gameId: p.gameId,
                                        oddsAmerican: rawOdds,
                                      });
                                    }
                                  }}
                                  className="text-[10px] font-bold px-2.5 py-1 rounded-lg transition-colors"
                                  style={{ background: "rgba(0,212,170,0.12)", color: "#00d4aa", border: "1px solid rgba(0,212,170,0.25)" }}
                                >
                                  + Bet Card
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
                {filteredPlays.length === 0 && (
                  <p className="text-xs text-center py-3" style={{ color: "#52525b" }}>No plays for this sportsbook filter</p>
                )}
              </div>
            );
          })()}

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
                  onAddToCard={onAddToCard}
                  h2hDataFromCache={h2hCache.current[p.gameId] ?? null}
                  isNewlyLive={newlyLiveIds.has(p.gameId)}
                  onShiftDetected={handleShiftDetected}
                />
              ))}
            </div>
          )}

          {/* Empty/no-games state */}
          {!hasPlays && !error && liveGames.length === 0 && halftimePlays.length === 0 && (
            <div className="bg-card border border-border rounded-xl p-8 text-center space-y-4">
              <img
                src={propPulseLogo}
                alt="LiveLocks"
                className="w-14 h-14 rounded-xl mx-auto"
                style={{ boxShadow: "0 0 24px rgba(0,212,170,0.2)" }}
              />
              <p data-testid="text-no-games" className="text-sm font-semibold text-foreground">
                {games.length === 0 ? "No NCAAB games scheduled today" : "No live NCAAB games right now"}
              </p>
              {(() => {
                const upcoming = games
                  .filter(g => g.startTime && new Date(g.startTime).getTime() > Date.now())
                  .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
                if (upcoming.length > 0) {
                  const next = upcoming[0];
                  const diff = new Date(next.startTime).getTime() - Date.now();
                  const h = Math.floor(diff / 3600000);
                  const m = Math.floor((diff % 3600000) / 60000);
                  const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
                  return (
                    <p data-testid="text-next-tipoff" className="text-xs text-muted-foreground">
                      Next game: <span className="font-semibold text-foreground">{next.awayTeamAbbr ?? next.awayTeam} @ {next.homeTeamAbbr ?? next.homeTeam}</span>
                      {" "}— tipoff in <span style={{ color: "#00d4aa" }}>{timeStr}</span>
                    </p>
                  );
                }
                return <p className="text-xs text-muted-foreground">Check back during game time — the model activates automatically.</p>;
              })()}
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
                  const engineCall = r.overProb !== null && r.overProb > 50 ? "under" : "over";
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
              onAddToCard={onAddToCard}
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
                // ── Primary call logic — canonical h2_total market ────────────
                const h2TotalMktHalf = play.engineOutput?.markets?.h2_total;
                const h2EngineOverProb = h2TotalMktHalf?.available ? h2TotalMktHalf.modelProb : null;
                const has2HCall = h2TotalMktHalf?.available === true && h2EngineOverProb !== null && h2TotalMktHalf.bookLine !== null;
                const h2Side = h2TotalMktHalf?.available ? h2TotalMktHalf.side : null;
                const h2UnderProb = h2TotalMktHalf?.available && h2TotalMktHalf.modelProb !== null ? Math.round((100 - h2TotalMktHalf.modelProb) * 10) / 10 : null;
                const h2Confidence = h2Side === "OVER"
                  ? h2EngineOverProb
                  : h2Side === "UNDER"
                  ? h2UnderProb
                  : null;
                const h2DisplayLine = h2TotalMktHalf?.available ? h2TotalMktHalf.bookLine : null;
                const h2ActiveEdge = h2TotalMktHalf?.available ? h2TotalMktHalf.edge : null;

                // Best spread call — canonical h2_spread market
                const h2SpreadMktHalf = play.engineOutput?.markets?.h2_spread;
                const spreadProb2H = h2SpreadMktHalf?.available ? h2SpreadMktHalf.modelProb : null;
                const hasCoverCall = h2SpreadMktHalf?.available && h2SpreadMktHalf.bookLine !== null && spreadProb2H !== null && Math.abs(spreadProb2H - 50) >= 8;
                const spreadSide = spreadProb2H !== null ? (spreadProb2H >= 55 ? "COVER" : spreadProb2H <= 45 ? "FADE" : null) : null;
                const spreadUnder2H = h2SpreadMktHalf?.available && h2SpreadMktHalf.modelProb !== null ? Math.round((100 - h2SpreadMktHalf.modelProb) * 10) / 10 : null;
                const spreadConf = spreadSide === "COVER" ? spreadProb2H : spreadSide === "FADE" ? spreadUnder2H : null;

                // Which is the stronger call
                const primaryIs2H = has2HCall && h2Confidence !== null && (h2ActiveEdge ?? 0) >= 5;
                const hasPrimaryCall = primaryIs2H || (hasCoverCall && spreadConf !== null && spreadConf >= 60);

                // Edge color tiers
                const edgeColor = (edge: number | null) => {
                  if (edge === null) return "text-muted-foreground";
                  if (edge >= 10) return "text-green-400";
                  if (edge >= 5)  return "text-yellow-400";
                  return "text-muted-foreground";
                };
                const confBg = (conf: number | null) => {
                  if (conf === null) return "bg-secondary/60 text-muted-foreground";
                  if (conf >= 70) return "bg-green-500/15 text-green-400 border border-green-500/30";
                  if (conf >= 60) return "bg-yellow-500/10 text-yellow-400 border border-yellow-500/30";
                  return "bg-secondary/60 text-muted-foreground border border-border";
                };

                // H2 projected breakdown per team
                const awayH2Pts = play.awayProjected !== null ? Math.round(play.awayProjected - play.awayScore) : null;
                const homeH2Pts = play.homeProjected !== null ? Math.round(play.homeProjected - play.homeScore) : null;

                return (
                  <div key={play.gameId} data-testid={`ncaab-2h-card-${play.gameId}`} className="bg-card border border-border rounded-xl overflow-hidden">

                    {/* ── Header ────────────────────────────────────────────── */}
                    <div className="px-4 pt-4 pb-3 flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
                          <span className="text-[10px] font-semibold text-orange-400 uppercase tracking-wider">Halftime · 2H Plays</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-foreground">{play.awayTeamAbbr}</span>
                          <span className="text-xl font-black tabular-nums text-foreground">{play.awayScore}</span>
                          <span className="text-sm text-muted-foreground">–</span>
                          <span className="text-xl font-black tabular-nums text-foreground">{play.homeScore}</span>
                          <span className="text-sm font-bold text-foreground">{play.homeTeamAbbr}</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{play.awayTeam} @ {play.homeTeam}</p>
                      </div>
                      {play.h2LinesSource && (
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${play.h2LinesSource === "odds_api" || play.h2LinesSource === "action_network" ? "text-green-400 bg-green-500/10 border-green-500/30" : "text-muted-foreground bg-secondary border-border"}`}>
                          {play.h2LinesSource === "odds_api" ? "Live Odds" : play.h2LinesSource === "action_network" ? "Action Network" : "Est."}
                        </span>
                      )}
                    </div>

                    {/* ── Primary call box ──────────────────────────────────── */}
                    {primaryIs2H && h2Side && h2Confidence !== null && h2DisplayLine !== null ? (
                      <div className="mx-4 mb-3 rounded-lg bg-secondary/40 border border-border p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">2H Best Play</p>
                            <p className="text-base font-black text-foreground tracking-tight">
                              {h2Side} {h2DisplayLine}
                            </p>
                          </div>
                          <span className={`text-sm font-bold px-2.5 py-1 rounded-lg ${confBg(h2Confidence)}`}>
                            {h2Confidence.toFixed(0)}%
                          </span>
                        </div>
                        {/* Engine vs Book comparison */}
                        {play.h2BookOverImplied !== null && (
                          <div className="flex items-center gap-3 text-[10px]">
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Engine:</span>
                              <span className="font-semibold text-foreground">{(h2EngineOverProb ?? 0).toFixed(0)}% over</span>
                            </div>
                            <span className="text-border">|</span>
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Book implied:</span>
                              <span className="font-semibold text-foreground">{play.h2BookOverImplied.toFixed(0)}% over</span>
                            </div>
                            {h2ActiveEdge !== null && (
                              <>
                                <span className="text-border">|</span>
                                <span className={`font-bold ${edgeColor(h2ActiveEdge)}`}>+{h2ActiveEdge.toFixed(1)} edge</span>
                              </>
                            )}
                          </div>
                        )}
                        {/* Action Network betting % */}
                        {play.h2OverPct !== null && play.h2UnderPct !== null && (
                          <div className="space-y-0.5">
                            <div className="flex justify-between text-[10px] text-muted-foreground">
                              <span>Over {play.h2OverPct}%</span>
                              <span>Under {play.h2UnderPct}%</span>
                            </div>
                            <div className="h-1 bg-secondary rounded-full overflow-hidden">
                              <div className="h-full bg-primary/60 rounded-full" style={{ width: `${play.h2OverPct}%` }} />
                            </div>
                            <p className="text-[9px] text-muted-foreground/60">Betting % from Action Network</p>
                          </div>
                        )}
                      </div>
                    ) : hasCoverCall && spreadSide && spreadConf !== null ? (
                      <div className="mx-4 mb-3 rounded-lg bg-secondary/40 border border-border p-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Spread Best Play</p>
                            <p className="text-base font-black text-foreground">
                              {spreadSide === "COVER" ? "Cover" : "Fade"} {play.favorite} {h2SpreadMktHalf?.bookLine !== null && h2SpreadMktHalf?.bookLine !== undefined ? `-${Math.abs(h2SpreadMktHalf.bookLine)}` : ""}
                            </p>
                          </div>
                          <span className={`text-sm font-bold px-2.5 py-1 rounded-lg ${confBg(spreadConf)}`}>
                            {spreadConf.toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="mx-4 mb-3 rounded-lg bg-secondary/20 border border-dashed border-border p-3 text-center">
                        <p className="text-xs text-muted-foreground">Monitor — no strong 2H signal yet</p>
                        {!h2TotalMktHalf?.available && <p className="text-[10px] text-muted-foreground/60 mt-0.5">Waiting for live 2H lines from books</p>}
                      </div>
                    )}

                    {/* ── Market rows ───────────────────────────────────────── */}
                    <div className="px-4 pb-3 space-y-2.5">

                      {/* 2H Total — only when canonical h2_total market is available */}
                      {h2TotalMktHalf?.available && h2TotalMktHalf.bookLine !== null && h2EngineOverProb !== null && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground font-medium">2H Total O/U {h2TotalMktHalf.bookLine}</span>
                            <div className="flex items-center gap-2">
                              {play.h2OverPrice !== null && (
                                <span className="text-[10px] text-muted-foreground/70">{play.h2OverPrice > 0 ? "+" : ""}{play.h2OverPrice} / {play.h2UnderPrice !== null ? (play.h2UnderPrice > 0 ? "+" : "") + play.h2UnderPrice : "—"}</span>
                              )}
                              <span className={`font-semibold ${h2EngineOverProb >= 60 ? "text-green-400" : h2EngineOverProb <= 40 ? "text-red-400" : "text-foreground"}`}>
                                {h2EngineOverProb.toFixed(0)}% over
                              </span>
                            </div>
                          </div>
                          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${h2EngineOverProb >= 60 ? "bg-green-500" : h2EngineOverProb <= 40 ? "bg-red-500" : "bg-primary"}`}
                              style={{ width: `${Math.min(100, h2EngineOverProb)}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* 2H Spread — Rule 1+4: h2_spread verdict only; no full-game fallback */}
                      {(() => {
                        const h2SpLine = h2SpreadMktHalf?.available ? h2SpreadMktHalf.bookLine : null;
                        if (h2SpLine == null || spreadProb2H == null) return null;
                        const sp = spreadProb2H;
                        return (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground font-medium">2H Spread — {play.h2Favorite} {h2SpLine > 0 ? "+" : ""}{h2SpLine}</span>
                            <span className={`font-semibold ${sp >= 60 ? "text-green-400" : sp <= 40 ? "text-red-400" : "text-foreground"}`}>
                              {sp >= 50
                                ? `${sp.toFixed(0)}% cover`
                                : `${(100 - sp).toFixed(0)}% fade`}
                            </span>
                          </div>
                          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${sp >= 60 ? "bg-green-500" : sp <= 40 ? "bg-red-500" : "bg-primary"}`}
                              style={{ width: `${Math.min(100, sp)}%` }}
                            />
                          </div>
                        </div>
                        );
                      })()}
                    </div>

                    {/* ── H2 Projections ────────────────────────────────────── */}
                    {(awayH2Pts !== null || homeH2Pts !== null) && (
                      <div className="border-t border-border/50 px-4 py-3">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">
                          H2 Projection{play.h2Proj !== null ? ` — ${play.h2Proj} combined pts` : ""}
                        </p>
                        <div className="flex gap-3">
                          {awayH2Pts !== null && play.awayProjected !== null && (
                            <div className="flex-1 bg-secondary/30 rounded-lg px-3 py-2">
                              <p className="text-[10px] text-muted-foreground mb-0.5">{play.awayTeamAbbr}</p>
                              <div className="flex items-baseline gap-1">
                                <span className="text-xs text-muted-foreground">{play.awayScore}</span>
                                <span className="text-[10px] text-green-400 font-semibold">+{awayH2Pts > 0 ? awayH2Pts : 0}</span>
                                <span className="text-[10px] text-muted-foreground">=</span>
                                <span className="text-sm font-bold text-foreground">{Math.round(play.awayProjected)}</span>
                              </div>
                            </div>
                          )}
                          {homeH2Pts !== null && play.homeProjected !== null && (
                            <div className="flex-1 bg-secondary/30 rounded-lg px-3 py-2">
                              <p className="text-[10px] text-muted-foreground mb-0.5">{play.homeTeamAbbr}</p>
                              <div className="flex items-baseline gap-1">
                                <span className="text-xs text-muted-foreground">{play.homeScore}</span>
                                <span className="text-[10px] text-green-400 font-semibold">+{homeH2Pts > 0 ? homeH2Pts : 0}</span>
                                <span className="text-[10px] text-muted-foreground">=</span>
                                <span className="text-sm font-bold text-foreground">{Math.round(play.homeProjected)}</span>
                              </div>
                            </div>
                          )}
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
