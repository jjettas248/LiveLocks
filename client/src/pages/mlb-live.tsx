import { useState, useEffect, useRef, Component, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ProbabilityRing } from "@/components/probability-ring";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { MLBScheduleList } from "@/components/mlb/MLBScheduleList";
import { TopPlays } from "@/components/mlb/TopPlays";
import { LiveBoard } from "@/components/mlb/LiveBoard";

class MLBErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; message: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message ?? "Unknown error" };
  }
  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[MLBErrorBoundary] caught:", error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="max-w-5xl mx-auto px-4 py-12 text-center space-y-3">
          <div className="text-sm font-semibold text-foreground">Something went wrong loading MLB</div>
          <div className="text-xs text-muted-foreground">{this.state.message}</div>
          <button className="text-xs text-primary underline" onClick={() => this.setState({ hasError: false, message: "" })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

type MLBGameMarket = {
  line: number | null;
  odds: { overOdds: number | null; underOdds: number | null } | null;
  projection: number | null;
  edge: number | null;
  probability: number | null;
  oddsUpdatedAt: string | null;
  projectionUpdatedAt: string | null;
};

type MLBGame = {
  gameId: string;
  homeTeam: string | null;
  awayTeam: string | null;
  awayAbbr: string | null;
  homeAbbr: string | null;
  homeScore: number | null;
  awayScore: number | null;
  inning: number;
  isTopInning: boolean;
  status: "live" | "pregame" | null;
  startTime?: string | null;
  venue?: string | null;
  weatherSummary?: string | null;
  weather?: { temperature: number | null; windSpeed: number | null; windDirection: string | null; humidity: number | null } | null;
  pitcherAway?: string | null;
  pitcherHome?: string | null;
  awayPitcherHand?: string | null;
  homePitcherHand?: string | null;
  pitcherName?: string | null;
  pitcherThrows?: "L" | "R" | null;
  pitcherTeam?: string | null;
  pitcherContext?: { pitchCount: number; timesThroughOrder: number; avgVelocity: number | null; velocityDrop: number | null } | null;
  gameState?: { outs: number; runnersOnBase: string[] } | null;
  hasOdds?: boolean;
  signalLocked?: boolean;
  signalCount?: number;
  market?: MLBGameMarket | null;
  gameCardTags?: string[];
};

type ABResultEntry = {
  outcome: "hit" | "out" | "strikeout" | "walk" | "hbp" | "error" | "other";
  exitVelocity: number | null;
  launchAngle: number | null;
  distance: number | null;
  pitchType?: string | null;
  pitchSpeed?: number | null;
};

type MLBBatter = {
  playerId: string;
  playerName: string;
  teamAbbr: string;
  teamSide?: "home" | "away";
  battingOrderSlot: number;
  ab: number;
  h: number;
  tb: number;
  r: number;
  rbi: number;
  bb: number;
  sb: number;
  k: number;
  lastABOutcome?: "hit" | "out" | "strikeout" | "walk" | "hbp" | "error" | "other" | null;
  exitVelocity?: number | null;
  barrelPct?: number | null;
  xBA?: number | null;
  xSLG?: number | null;
  hardHitPct?: number | null;
  priorABResults?: ABResultEntry[];
};

type PitchMixEntry = { pitchType: string; percentage: number; avgVelocity: number | null };

type MLBSignal = {
  playerId: string;
  playerName: string;
  market: string;
  bookLine: number | null;
  projection?: number | null;
  enginePct: number;
  edge: number | null;
  odds: { bookLine: number } | null;
  recommendedSide: "OVER" | "UNDER" | "NO_EDGE";
  inning: number;
  tier: "green" | "yellow" | "teal" | "red";
  gameId?: string;
  sportsbook?: string | null;
  derivedLine?: boolean;
  signalTimestamp?: number | null;
  formIndicator?: "HOT" | "WARM" | "COLD" | "NEUTRAL" | "EXTREME_COLD" | null;
  formScore?: number | null;
  evPct?: number | null;
  hrFactors?: { count: number; labels: string[] } | null;
  contextScore?: number | null;
  matchupTag?: string | null;
  explanationBullets?: string[];
  awayAbbr?: string | null;
  homeAbbr?: string | null;
  bvp?: { atBats: number; hits: number; avg: number | null; homeRuns: number; strikeouts: number } | null;
  modifiers?: { liveForm: number; pitcher: number; pitchType: number; weatherPark: number; lineup: number } | null;
  signalScore?: number | null;
  confidenceTier?: "ELITE" | "STRONG" | "SOLID" | "WATCHLIST" | null;
  signalTags?: string[];
  feedTags?: string[];
  playerGlowEligible?: boolean;
  currentStats?: { ab: number; h: number; hr: number; tb: number; bb: number; rbi: number; k: number; sb: number } | null;
  lastABContact?: {
    exitVelo: number | null;
    launchAngle: number | null;
    batSpeed: number | null;
    distance: number | null;
    barrelPct: number | null;
    hardHitPct: number | null;
    outcome: string | null;
  } | null;
  alreadyHit?: boolean;
  pitchMix?: PitchMixEntry[] | null;
};

type SignalState = "actionable" | "already_hit" | "watchlist" | "stale";

function deriveSignalState(sig: MLBSignal): SignalState {
  if (sig.alreadyHit && sig.recommendedSide === "OVER") return "already_hit";
  const age = sig.signalTimestamp ? Date.now() - sig.signalTimestamp : 0;
  if (age > 180_000) return "stale";
  if (sig.confidenceTier === "WATCHLIST" || (sig.signalScore ?? 0) < 40) return "watchlist";
  return "actionable";
}

const PITCH_LABELS: Record<string, string> = {
  FF: "4-Seam", SI: "Sinker", FC: "Cutter", SL: "Slider",
  CU: "Curve", CH: "Change", FS: "Splitter", KC: "Knuckle Curve",
  KN: "Knuckle", EP: "Eephus", ST: "Sweeper", SV: "Slurve",
};

type SignalsResponse = {
  mode: "live" | "no_lines" | "preview" | "preview_locked" | "monitoring";
  signals: MLBSignal[];
  updatedAt: number;
  isDegraded?: boolean;
  gameCardTags?: string[];
};

type EdgeFeedResponse = {
  signals: MLBSignal[];
};

type MLBGamesResponse = {
  mode: "live" | "preview" | "preview_locked";
  games: MLBGame[];
  previewPlayers?: any[];
};

type OddsEntry = { line: number; overOdds: number; underOdds: number };

type CalcResult = {
  market: string;
  projection: number;
  bookLine: number;
  calibratedProbabilityOver: number;
  calibratedProbabilityUnder: number;
  edge: number;
  recommendedSide: string;
  confidenceTier: string;
  expectedHits: number | null;
  remainingPA: number | null;
  adjustedHitRate: number | null;
  bookImplied: number | null;
  explanationBullets: string[];
  mode?: string;
  isManual?: boolean;
  label?: string;
};

const STALE_MS = 120_000;
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isFresh(ts?: string | null): boolean {
  if (!ts) return false;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) && Date.now() - ms <= STALE_MS;
}
function hasRealOdds(market: MLBGameMarket | null | undefined): boolean {
  if (!market || !isFiniteNumber(market.line) || !market.odds) return false;
  return (isFiniteNumber(market.odds.overOdds) || isFiniteNumber(market.odds.underOdds)) && isFresh(market.oddsUpdatedAt);
}
function canShowSignal(market: MLBGameMarket | null | undefined): boolean {
  return hasRealOdds(market) && isFiniteNumber(market?.projection) && isFresh(market?.projectionUpdatedAt);
}

const MARKET_LABELS: Record<string, string> = {
  hits: "Hits", total_bases: "Total Bases", hrr: "H+R+RBI",
  pitcher_k: "K (Pitcher)", pitcher_strikeouts: "K (Pitcher)", pitcher_outs: "Pitcher Outs",
  hits_allowed: "Hits Allowed", walks_allowed: "Walks Allowed",
  hr: "Home Runs", home_runs: "Home Runs",
  batter_strikeouts: "Strikeouts", hr_allowed: "HR Allowed",
};

const SPORTSBOOK_LABELS: Record<string, string> = {
  fanduel: "FanDuel", draftkings: "DraftKings", hardrockbet: "Hard Rock", betmgm: "BetMGM",
  caesars: "Caesars", pointsbet: "PointsBet", bet365: "Bet365", betrivers: "BetRivers",
  prizepicks: "PrizePicks", underdog: "Underdog", underdogfantasy: "Underdog",
  fanatics: "Fanatics",
};

const PITCHER_MARKET_SET = new Set(["pitcher_k", "pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"]);

const BATTER_MARKETS = [
  { value: "hits", label: "Hits" },
  { value: "total_bases", label: "Total Bases" },
  { value: "hrr", label: "H+R+RBI" },
  { value: "hr", label: "Home Runs" },
  { value: "batter_strikeouts", label: "Strikeouts" },
];

const PITCHER_MARKETS = [
  { value: "pitcher_k", label: "K (Pitcher)" },
  { value: "pitcher_outs", label: "Outs" },
  { value: "walks_allowed", label: "Walks Allowed" },
  { value: "hits_allowed", label: "Hits Allowed" },
  { value: "hr_allowed", label: "HR Allowed" },
];

type MainTab = "games" | "edge_feed" | "inning_feed" | "hr_radar" | "live_feed";

function heatEmoji(form: string | null | undefined): string {
  if (!form) return "";
  const f = form.toUpperCase();
  if (f === "HOT") return "🔥";
  if (f === "WARM") return "🟡";
  if (f === "COLD") return "❄️";
  if (f === "EXTREME_COLD" || f === "ICE_COLD") return "🥶";
  return "";
}

function heatColor(form: string | null | undefined): string {
  if (!form) return "text-muted-foreground";
  const f = form.toUpperCase();
  if (f === "HOT") return "text-green-400";
  if (f === "WARM") return "text-yellow-400";
  if (f === "COLD") return "text-blue-400";
  if (f === "EXTREME_COLD" || f === "ICE_COLD") return "text-blue-600";
  return "text-muted-foreground";
}

function heatGlow(form: string | null | undefined): string {
  if (!form) return "";
  const f = form.toUpperCase();
  if (f === "HOT") return "shadow-[0_0_12px_rgba(34,197,94,0.3)]";
  if (f === "WARM") return "shadow-[0_0_8px_rgba(234,179,8,0.2)]";
  if (f === "COLD") return "shadow-[0_0_8px_rgba(59,130,246,0.2)]";
  if (f === "EXTREME_COLD" || f === "ICE_COLD") return "shadow-[0_0_10px_rgba(37,99,235,0.3)]";
  return "";
}


function edgeColor(edge: number | null): string {
  if (edge == null) return "text-muted-foreground";
  if (edge >= 8) return "text-green-400";
  if (edge >= 5) return "text-yellow-400";
  if (edge >= 0) return "text-muted-foreground/70";
  return "text-red-400";
}

function edgeBg(edge: number | null): string {
  if (edge == null) return "bg-muted/30";
  if (edge >= 8) return "bg-green-500/10";
  if (edge >= 5) return "bg-yellow-500/10";
  if (edge >= 0) return "bg-muted/30";
  return "bg-red-500/10";
}

function ordinal(n: number): string {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

function passLabel(n: number): string {
  if (n === 1) return "First look";
  if (n === 2) return "Second look";
  return `${ordinal(n)} time through`;
}

function inningLabel(game: MLBGame): string {
  if (game.status === "pregame") return "Pre-Game";
  if (!game.inning) return "—";
  return `${game.isTopInning ? "▲" : "▼"}${game.inning}`;
}

function formatOdds(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function generateTweet(sig: MLBSignal, isElite: boolean): string {
  const marketLabel = MARKET_LABELS[sig.market] ?? sig.market;
  const side = sig.recommendedSide;
  const line = sig.bookLine != null ? sig.bookLine : "";
  const pct = Math.round(sig.enginePct);
  const edge = sig.edge != null ? `+${sig.edge.toFixed(1)}%` : "";
  const formTag = sig.formIndicator && sig.formIndicator !== "NEUTRAL" ? ` [${sig.formIndicator}]` : "";
  const bullets = (sig.explanationBullets ?? []).slice(0, 2).map(b => `- ${b}`).join("\n");

  if (isElite) {
    const evLine = sig.evPct != null ? `EV: ${sig.evPct > 0 ? "+" : ""}${sig.evPct.toFixed(1)}%` : "";
    const hrLine = sig.hrFactors?.count ? `HR Factors: ${sig.hrFactors.labels.join(", ")}` : "";
    const matchup = sig.matchupTag ? `Matchup: ${sig.matchupTag}` : "";
    return [
      `${sig.playerName}${formTag} | ${marketLabel} ${side} ${line}`,
      `Engine: ${pct}% | Edge: ${edge}${evLine ? ` | ${evLine}` : ""}`,
      matchup, hrLine, bullets, "", "Powered by LiveLocks",
    ].filter(Boolean).join("\n");
  }
  return [
    `${sig.playerName} | ${marketLabel} ${side} ${line}`,
    `Engine: ${pct}%${edge ? ` | Edge: ${edge}` : ""}`,
    bullets, "", "Powered by LiveLocks",
  ].filter(Boolean).join("\n");
}

function isValidSignal(sig: MLBSignal, selectedGameId: string, rosterPlayerIds?: Set<string>): boolean {
  if (!sig.playerId || !sig.market) return false;
  if (sig.bookLine == null) return false;
  if (typeof sig.enginePct !== "number" || !Number.isFinite(sig.enginePct)) return false;
  if (sig.enginePct < 0 || sig.enginePct > 100) return false;
  if (sig.gameId !== selectedGameId) return false;
  if (rosterPlayerIds?.size && !PITCHER_MARKET_SET.has(sig.market) && !rosterPlayerIds.has(String(sig.playerId))) return false;
  return true;
}

function ABOutcomePill({ outcome, pitchType, pitchSpeed, exitVelocity }: { outcome: string; pitchType?: string | null; pitchSpeed?: number | null; exitVelocity?: number | null }) {
  const styles: Record<string, string> = {
    hit: "bg-green-500/20 text-green-400 border-green-500/30",
    strikeout: "bg-red-500/15 text-red-400 border-red-500/25",
    walk: "bg-blue-500/15 text-blue-400 border-blue-500/25",
    hbp: "bg-blue-500/15 text-blue-400 border-blue-500/25",
    out: "bg-muted/50 text-muted-foreground border-border/30",
    error: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
    other: "bg-muted/50 text-muted-foreground border-border/30",
  };
  const labels: Record<string, string> = {
    hit: "H", strikeout: "K", walk: "BB", hbp: "HBP", out: "O", error: "E", other: "—",
  };
  const pitchLabel = pitchType ? (pitchType.length > 4 ? pitchType.slice(0, 2).toUpperCase() : pitchType.toUpperCase()) : null;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md border ${styles[outcome] ?? styles.other}`}>
        {labels[outcome] ?? outcome}
      </span>
      {(pitchLabel || pitchSpeed != null || exitVelocity != null) && (
        <span className="text-[7px] text-muted-foreground/60 leading-tight text-center">
          {exitVelocity != null ? `${Math.round(exitVelocity)}mph` : pitchLabel && pitchSpeed ? `${pitchLabel} ${Math.round(pitchSpeed)}` : pitchSpeed ? `${Math.round(pitchSpeed)}mph` : pitchLabel ?? ""}
        </span>
      )}
    </div>
  );
}

function SignalCard({ sig, isElite, compact, onClickThrough, onAddToSlip }: {
  sig: MLBSignal; isElite: boolean; compact?: boolean;
  onClickThrough?: (sig: MLBSignal) => void;
  onAddToSlip?: (sig: MLBSignal) => void;
}) {
  const marketLabel = MARKET_LABELS[sig.market] ?? sig.market;
  const isHrMarket = sig.market === "home_runs" || sig.market === "hr";
  const form = sig.formIndicator;
  const probWhole = Math.round(sig.enginePct);
  const state = deriveSignalState(sig);
  const glowEligible = sig.playerGlowEligible &&
    (sig.confidenceTier === "ELITE" || sig.confidenceTier === "STRONG") &&
    (sig.edge ?? 0) >= 10;
  const glowClass = glowEligible
    ? (sig.recommendedSide === "OVER"
      ? "border-green-500/50 shadow-[0_0_16px_rgba(34,197,94,0.25)]"
      : sig.recommendedSide === "UNDER"
      ? "border-blue-500/50 shadow-[0_0_16px_rgba(59,130,246,0.25)]"
      : "border-green-500/40 shadow-[0_0_12px_rgba(34,197,94,0.2)]")
    : "";

  const stateStyles = state === "already_hit"
    ? "border-emerald-500/40 bg-emerald-500/5"
    : state === "stale"
    ? "opacity-50 border-border/20"
    : state === "watchlist"
    ? "border-border/30 bg-secondary/20"
    : "";

  return (
    <div
      data-testid={`card-mlb-signal-${sig.playerId}-${sig.market}`}
      className={`rounded-xl border p-4 sm:p-5 space-y-3 transition-all ${stateStyles} ${glowClass || heatGlow(form)} ${edgeBg(sig.edge)} border-border/40 ${onClickThrough ? "cursor-pointer hover:border-primary/40 active:scale-[0.99]" : ""}`}
      onClick={() => onClickThrough?.(sig)}
    >
      {state === "already_hit" && (
        <div className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-emerald-500/15 border border-emerald-500/30 mb-1">
          <span className="text-emerald-400 text-xs font-black tracking-wider">ALREADY HIT</span>
          <span className="text-emerald-400/70 text-[10px]">Player cleared the line</span>
        </div>
      )}

      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-foreground truncate">{sig.playerName}</span>
            {form && form !== "NEUTRAL" && (
              <span className={`text-xs font-bold ${heatColor(form)}`}>
                {heatEmoji(form)} {form}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-xs text-muted-foreground">{marketLabel}</span>
            {compact && sig.awayAbbr && sig.homeAbbr && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary/60 text-muted-foreground border border-border/30">
                {sig.awayAbbr} vs {sig.homeAbbr}
              </span>
            )}
            {sig.matchupTag && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary/60 text-muted-foreground border border-border/30">
                {sig.matchupTag}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {sig.confidenceTier && sig.confidenceTier !== "WATCHLIST" && (
            <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${
              sig.confidenceTier === "ELITE" ? "bg-green-500/20 text-green-400" :
              sig.confidenceTier === "STRONG" ? "bg-yellow-500/20 text-yellow-400" :
              "bg-blue-500/15 text-blue-400"
            }`}>{sig.confidenceTier}</span>
          )}
          <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${edgeColor(sig.edge)} ${edgeBg(sig.edge)}`}>
            {sig.recommendedSide}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 text-center">
        <div>
          <div className="text-[10px] text-muted-foreground">Prob</div>
          <div className={`text-base sm:text-lg font-bold ${edgeColor(sig.edge)}`}>{probWhole}%</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">EV%</div>
          <div className={`text-base sm:text-lg font-bold ${sig.evPct != null && sig.evPct > 0 ? "text-green-400" : "text-muted-foreground"}`}>
            {sig.evPct != null ? `${sig.evPct > 0 ? "+" : ""}${sig.evPct.toFixed(1)}` : "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">Proj</div>
          <div className="text-base sm:text-lg font-bold text-foreground">{sig.projection != null ? sig.projection.toFixed(1) : "—"}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">Line</div>
          <div className="text-base sm:text-lg font-bold text-foreground">{sig.bookLine ?? "—"}</div>
        </div>
      </div>

      {sig.edge != null && (
        <div className={`text-center py-2 rounded-lg text-xs font-bold ${edgeBg(sig.edge)} ${sig.edge >= 0 ? "text-green-400" : "text-red-400"}`}>
          Edge: {sig.edge >= 0 ? "+" : ""}{sig.edge.toFixed(1)}%
        </div>
      )}

      {sig.currentStats && (() => {
        const cs = sig.currentStats;
        const line = sig.bookLine ?? 0;
        const currentVal = sig.market === "hits" ? cs.h
          : sig.market === "home_runs" || sig.market === "hr" ? cs.hr
          : sig.market === "total_bases" ? cs.tb
          : sig.market === "hrr" ? (cs.h + cs.hr + cs.rbi)
          : cs.h;
        const alreadyOver = currentVal >= line && line > 0;
        const edgeHit = sig.recommendedSide === "OVER" && alreadyOver;
        return (
          <div className={`flex items-center gap-3 py-2 px-3 rounded-lg border ${
            edgeHit
              ? "bg-green-500/10 border-green-500/30"
              : alreadyOver
                ? "bg-yellow-500/10 border-yellow-500/30"
                : "bg-secondary/40 border-border/30"
          }`}>
            <span className={`text-[10px] font-semibold uppercase tracking-wider shrink-0 ${
              edgeHit ? "text-green-400" : "text-muted-foreground"
            }`}>{edgeHit ? "HIT" : "Today"}</span>
            <div className="flex items-center gap-2 flex-wrap text-[11px]">
              <span className={`font-semibold ${alreadyOver ? "text-green-400" : "text-foreground"}`}>
                {cs.ab > 0 ? `${cs.h}-${cs.ab}` : "0 AB"}
              </span>
              {cs.hr > 0 && <span className="text-orange-400 font-bold">{cs.hr} HR</span>}
              {cs.rbi > 0 && <span className="text-muted-foreground">{cs.rbi} RBI</span>}
              {cs.bb > 0 && <span className="text-muted-foreground">{cs.bb} BB</span>}
              {cs.k > 0 && <span className="text-red-400">{cs.k} K</span>}
              {cs.tb > 0 && <span className="text-muted-foreground">{cs.tb} TB</span>}
            </div>
          </div>
        );
      })()}

      {sig.lastABContact && (sig.lastABContact.exitVelo || sig.lastABContact.launchAngle || sig.lastABContact.barrelPct) && (
        <div className="flex items-center gap-3 py-2 px-3 rounded-lg bg-secondary/30 border border-border/20">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider shrink-0">Last AB</span>
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            {sig.lastABContact.exitVelo != null && (
              <span className={sig.lastABContact.exitVelo >= 95 ? "text-green-400 font-bold" : sig.lastABContact.exitVelo >= 88 ? "text-yellow-400" : "text-muted-foreground"}>
                {sig.lastABContact.exitVelo.toFixed(0)} mph
              </span>
            )}
            {sig.lastABContact.launchAngle != null && (
              <span className={sig.lastABContact.launchAngle >= 10 && sig.lastABContact.launchAngle <= 30 ? "text-green-400" : "text-muted-foreground"}>
                {sig.lastABContact.launchAngle.toFixed(0)}° LA
              </span>
            )}
            {sig.lastABContact.distance != null && sig.lastABContact.distance > 0 && (
              <span className={sig.lastABContact.distance >= 340 ? "text-green-400" : "text-muted-foreground"}>
                {sig.lastABContact.distance.toFixed(0)} ft
              </span>
            )}
            {sig.lastABContact.barrelPct != null && sig.lastABContact.barrelPct > 0 && (
              <span className={sig.lastABContact.barrelPct >= 10 ? "text-green-400" : "text-muted-foreground"}>
                {sig.lastABContact.barrelPct.toFixed(0)}% Barrel
              </span>
            )}
            {sig.lastABContact.hardHitPct != null && sig.lastABContact.hardHitPct > 0 && (
              <span className={sig.lastABContact.hardHitPct >= 40 ? "text-green-400" : "text-muted-foreground"}>
                {sig.lastABContact.hardHitPct.toFixed(0)}% HH
              </span>
            )}
            {sig.lastABContact.outcome && (
              <span className={sig.lastABContact.outcome === "hit" ? "text-green-400 font-bold" : sig.lastABContact.outcome === "strikeout" ? "text-red-400" : "text-muted-foreground"}>
                {sig.lastABContact.outcome === "hit" ? "HIT" : sig.lastABContact.outcome === "strikeout" ? "K" : sig.lastABContact.outcome.toUpperCase()}
              </span>
            )}
          </div>
        </div>
      )}

      {sig.pitchMix && sig.pitchMix.length > 0 && (
        <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Pitcher Arsenal</div>
          <div className="flex flex-wrap gap-1.5">
            {sig.pitchMix.slice(0, 5).map((p, i) => (
              <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-secondary/60 text-foreground border border-border/30">
                {PITCH_LABELS[p.pitchType] ?? p.pitchType} {Math.round(p.percentage)}%
                {p.avgVelocity != null && <span className="text-muted-foreground ml-1">{p.avgVelocity.toFixed(0)}mph</span>}
              </span>
            ))}
          </div>
          {(() => {
            const era = (sig as any).pitcherEra;
            const attackable = (sig.signalTags ?? []).includes("ATTACKABLE PITCHER");
            if (!attackable && !era) return null;
            return (
              <div className={`text-[10px] font-semibold mt-0.5 ${attackable ? "text-green-400" : "text-muted-foreground"}`}>
                {attackable ? "Attackable" : "Neutral"} Matchup
                {era != null && <span className="text-muted-foreground ml-1">ERA {era.toFixed(2)}</span>}
              </div>
            );
          })()}
        </div>
      )}

      {isHrMarket && sig.hrFactors && sig.hrFactors.count > 0 && (
        <div className="rounded-lg p-2.5 space-y-1" style={{ background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.2)" }}>
          <div className="text-[10px] font-bold uppercase tracking-wider text-orange-400">
            {sig.hrFactors.count} HR Factor{sig.hrFactors.count !== 1 ? "s" : ""}
          </div>
          <div className="flex flex-wrap gap-1">
            {sig.hrFactors.labels.map((label, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-300 border border-orange-500/20">
                {label}
              </span>
            ))}
          </div>
        </div>
      )}

      {sig.explanationBullets && sig.explanationBullets.length > 0 && (
        <div className="space-y-1 pt-1">
          {sig.explanationBullets.slice(0, 3).map((bullet, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <span className="text-muted-foreground/50 mt-px">•</span>
              <span>{bullet}</span>
            </div>
          ))}
        </div>
      )}

      {sig.signalTags && sig.signalTags.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {sig.signalTags.map(tag => (
            <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded bg-secondary/50 text-muted-foreground border border-border/20">
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-border/30 gap-2" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground min-w-0">
          {sig.sportsbook && <span className="font-semibold truncate">{SPORTSBOOK_LABELS[sig.sportsbook] ?? sig.sportsbook}</span>}
          {sig.signalTimestamp && (
            <span className="shrink-0">{new Date(sig.signalTimestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {state === "actionable" && onAddToSlip && (
            <button
              data-testid={`button-mlb-slip-${sig.playerId}-${sig.market}`}
              className="text-xs px-3 py-1.5 rounded-lg border border-green-500/30 bg-green-500/10 hover:bg-green-500/20 transition-colors text-green-400 hover:text-green-300 font-semibold"
              onClick={(e) => { e.stopPropagation(); onAddToSlip(sig); }}
            >
              + Slip
            </button>
          )}
          <button
            data-testid={`button-mlb-tweet-${sig.playerId}-${sig.market}`}
            className="text-xs px-3 py-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 transition-colors text-blue-400 hover:text-blue-300 font-semibold"
            onClick={(e) => {
              e.stopPropagation();
              const tweet = generateTweet(sig, isElite);
              const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`;
              window.open(url, "_blank", "noopener,noreferrer,width=550,height=420");
            }}
          >
            𝕏 Tweet
          </button>
          <button
            data-testid={`button-mlb-copy-${sig.playerId}-${sig.market}`}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              const tweet = generateTweet(sig, isElite);
              if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(tweet).then(() => {
                  const btn = document.querySelector(`[data-testid="button-mlb-copy-${sig.playerId}-${sig.market}"]`);
                  if (btn) { btn.textContent = "✓"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); }
                }).catch(() => {});
              }
            }}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}


function probColor(pct: number): string {
  if (pct >= 75) return "text-green-400";
  if (pct >= 65) return "text-yellow-400";
  return "text-foreground";
}

function BatterCard({ player, signals, game, isElite, onSelect }: {
  player: MLBBatter;
  signals: MLBSignal[];
  game: MLBGame;
  isElite: boolean;
  onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const playerSignals = signals.filter(s => s.playerId === player.playerId && !PITCHER_MARKET_SET.has(s.market));
  const bestSignal = playerSignals.length > 0
    ? playerSignals.reduce((best, s) => (s.enginePct ?? 0) > (best.enginePct ?? 0) ? s : best)
    : null;
  const form = bestSignal?.formIndicator ?? null;
  const abResults = player.priorABResults ?? [];
  const glowEligible = playerSignals.some(s =>
    s.playerGlowEligible &&
    (s.confidenceTier === "ELITE" || s.confidenceTier === "STRONG") &&
    (s.edge ?? 0) >= 10
  );
  const bestTier = bestSignal?.confidenceTier ?? null;

  const hasLiveContact = player.exitVelocity != null || player.barrelPct != null || player.hardHitPct != null;
  const hasRecentForm = player.xBA != null || player.xSLG != null;
  const hasContact = hasLiveContact || hasRecentForm;
  const sideColor = bestSignal?.recommendedSide === "OVER"
    ? "border-green-500/40 shadow-[0_0_14px_rgba(34,197,94,0.15)]"
    : bestSignal?.recommendedSide === "UNDER"
    ? "border-blue-500/40 shadow-[0_0_14px_rgba(59,130,246,0.15)]"
    : "";

  return (
    <div
      data-testid={`card-mlb-batter-${player.playerId}`}
      className={`rounded-lg border overflow-hidden transition-all ${
        glowEligible ? sideColor || "border-green-500/60 shadow-[0_0_10px_rgba(34,197,94,0.2)]" : "border-border/30 hover:border-primary/40"
      }`}
    >
      <div className="px-3 py-2 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div
            className="flex items-center gap-1.5 min-w-0 cursor-pointer"
            onClick={(e) => { e.stopPropagation(); setShowDetail(!showDetail); }}
          >
            <span className="text-xs font-bold text-foreground truncate">{player.playerName}</span>
            <span className="text-[9px] text-muted-foreground shrink-0">#{player.battingOrderSlot}</span>
            {form && form !== "NEUTRAL" && (
              <span className={`text-[9px] font-bold shrink-0 ${heatColor(form)}`}>{heatEmoji(form)}</span>
            )}
            {bestTier && bestTier !== "WATCHLIST" && (
              <span className={`text-[8px] font-black px-1 py-0.5 rounded shrink-0 ${bestTier === "ELITE" ? "bg-green-500/20 text-green-400" : bestTier === "STRONG" ? "bg-yellow-500/20 text-yellow-400" : "bg-blue-500/15 text-blue-400"}`}>
                {bestTier}
              </span>
            )}
            <span className="text-[9px] text-muted-foreground/50">{showDetail ? "▾" : "▸"}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {bestSignal && (
              <>
                <span className={`text-sm font-black ${probColor(bestSignal.enginePct)}`}>{Math.round(bestSignal.enginePct)}%</span>
                {bestSignal.edge != null && bestSignal.edge > 0 && (
                  <span className={`text-[9px] font-bold ${edgeColor(bestSignal.edge)}`}>+{bestSignal.edge.toFixed(1)}%</span>
                )}
              </>
            )}
            <button
              data-testid={`btn-calc-${player.playerId}`}
              className="text-[8px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-bold hover:bg-primary/25 transition-colors"
              onClick={(e) => { e.stopPropagation(); onSelect(); }}
            >
              CALC
            </button>
          </div>
        </div>

        {showDetail && (
          <div className="space-y-2 pt-1 border-t border-border/20 animate-in slide-in-from-top-1 duration-200">
            {player.ab > 0 && (
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { label: "AB", value: player.ab }, { label: "H", value: player.h },
                  { label: "TB", value: player.tb }, { label: "K", value: player.k },
                ].map(s => (
                  <div key={s.label} className="bg-secondary/30 rounded p-1 text-center">
                    <div className="text-[7px] text-muted-foreground">{s.label}</div>
                    <div className="text-[10px] font-bold text-foreground">{s.value}</div>
                  </div>
                ))}
              </div>
            )}

            {hasContact && (
              <div className="flex items-center gap-2 text-[9px]">
                {player.exitVelocity != null && (
                  <span className={player.exitVelocity >= 95 ? "text-green-400 font-semibold" : player.exitVelocity >= 88 ? "text-yellow-400" : "text-muted-foreground"}>
                    EV {player.exitVelocity.toFixed(1)}
                  </span>
                )}
                {player.xBA != null && (
                  <span className={player.xBA >= 0.280 ? "text-green-400 font-semibold" : player.xBA >= 0.240 ? "text-yellow-400" : "text-muted-foreground"}>
                    xBA .{(player.xBA * 1000).toFixed(0).padStart(3, "0")}
                  </span>
                )}
                {player.hardHitPct != null && (
                  <span className={player.hardHitPct >= 45 ? "text-green-400 font-semibold" : player.hardHitPct >= 35 ? "text-yellow-400" : "text-muted-foreground"}>
                    Hard {Math.round(player.hardHitPct)}%
                  </span>
                )}
                {player.xSLG != null && (
                  <span className={player.xSLG >= 0.450 ? "text-green-400 font-semibold" : player.xSLG >= 0.370 ? "text-yellow-400" : "text-muted-foreground"}>
                    xSLG .{(player.xSLG * 1000).toFixed(0).padStart(3, "0")}
                  </span>
                )}
              </div>
            )}

            {abResults.length > 0 && (
              <div>
                <div className="text-[8px] text-muted-foreground uppercase tracking-wider mb-1">At-Bat Results</div>
                <div className="flex items-center gap-1">
                  {abResults.slice(-6).map((ab, i) => (
                    <ABOutcomePill key={i} outcome={ab.outcome} pitchType={ab.pitchType} pitchSpeed={ab.pitchSpeed} exitVelocity={ab.exitVelocity} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {!showDetail && (
          <>
            {hasContact && (
              <div className="flex items-center gap-2 text-[9px]">
                {player.exitVelocity != null && (
                  <span className={player.exitVelocity >= 95 ? "text-green-400 font-semibold" : player.exitVelocity >= 88 ? "text-yellow-400" : "text-muted-foreground"}>
                    EV {player.exitVelocity.toFixed(1)}
                  </span>
                )}
                {player.xBA != null && (
                  <span className={player.xBA >= 0.280 ? "text-green-400 font-semibold" : player.xBA >= 0.240 ? "text-yellow-400" : "text-muted-foreground"}>
                    xBA .{(player.xBA * 1000).toFixed(0).padStart(3, "0")}
                  </span>
                )}
                {player.hardHitPct != null && (
                  <span className={player.hardHitPct >= 45 ? "text-green-400 font-semibold" : player.hardHitPct >= 35 ? "text-yellow-400" : "text-muted-foreground"}>
                    Hard {Math.round(player.hardHitPct)}%
                  </span>
                )}
                {player.ab > 0 && (
                  <span className="text-muted-foreground ml-auto">{player.h}/{player.ab}</span>
                )}
              </div>
            )}

            {abResults.length > 0 && (
              <div className="flex items-center gap-1">
                {abResults.slice(-5).map((ab, i) => (
                  <ABOutcomePill key={i} outcome={ab.outcome} pitchType={ab.pitchType} pitchSpeed={ab.pitchSpeed} exitVelocity={ab.exitVelocity} />
                ))}
              </div>
            )}
          </>
        )}

        {playerSignals.length > 0 && (
          <div className="space-y-0.5 pt-1 border-t border-border/20">
            {playerSignals.slice(0, expanded ? 8 : 2).map(sig => (
              <div key={`${sig.playerId}-${sig.market}`} className="flex items-center justify-between text-[10px] px-1.5 py-0.5 rounded">
                <div className="flex items-center gap-1">
                  <span className={`font-bold px-1 py-0.5 rounded text-[9px] ${sig.recommendedSide === "OVER" ? "bg-green-500/20 text-green-400" : sig.recommendedSide === "UNDER" ? "bg-blue-500/20 text-blue-400" : "bg-muted/30 text-muted-foreground"}`}>
                    {sig.recommendedSide === "OVER" ? "O" : sig.recommendedSide === "UNDER" ? "U" : "—"}
                  </span>
                  <span className="text-muted-foreground">{MARKET_LABELS[sig.market] ?? sig.market}</span>
                  {sig.bookLine != null && <span className="text-foreground font-semibold">{sig.bookLine}</span>}
                </div>
                <div className="flex items-center gap-1">
                  <span className={`font-bold ${probColor(sig.enginePct)}`}>{Math.round(sig.enginePct)}%</span>
                  <button
                    data-testid={`btn-tweet-inline-${sig.playerId}-${sig.market}`}
                    className="text-[8px] px-1 py-0.5 rounded border border-blue-500/20 text-blue-400/70 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      const tweet = generateTweet(sig, isElite);
                      window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`, "_blank", "noopener,noreferrer,width=550,height=420");
                    }}
                  >
                    𝕏
                  </button>
                </div>
              </div>
            ))}
            {playerSignals.length > 2 && (
              <button
                data-testid={`btn-expand-signals-${player.playerId}`}
                className="text-[9px] text-primary hover:underline w-full text-center"
                onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
              >
                {expanded ? "Show less" : `+${playerSignals.length - 2} more`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MlbLiveInner() {
  const { user, isLoading: authLoading } = useAuth();
  const [mainTab, setMainTab] = useState<MainTab>("games");
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [selectedPlayer, setSelectedPlayer] = useState<MLBBatter | null>(null);
  const [selectedMarket, setSelectedMarket] = useState("hits");
  const [selectedLine, setSelectedLine] = useState<{ book: string; line: number; overOdds: number; underOdds: number } | null>(null);
  const [calcResult, setCalcResult] = useState<CalcResult | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualBookLine, setManualBookLine] = useState("");
  const [mlbUpgradeNeeded, setMlbUpgradeNeeded] = useState(false);
  const [inningFeedTab, setInningFeedTab] = useState<3 | 5 | 7>(3);
  const gameDetailRef = useRef<HTMLDivElement>(null);
  const [mlbSlipPicks, setMlbSlipPicks] = useState<Array<{ playerId: string; playerName: string; market: string; line: number; side: string; sportsbook: string; edge: number | null; enginePct: number; gameId: string }>>([]);

  const handleAddToSlip = (sig: MLBSignal) => {
    if (mlbSlipPicks.length >= 10) return;
    const exists = mlbSlipPicks.find(p => p.playerId === sig.playerId && p.market === sig.market);
    if (exists) return;
    setMlbSlipPicks(prev => [...prev, {
      playerId: sig.playerId, playerName: sig.playerName, market: sig.market,
      line: sig.bookLine ?? 0, side: sig.recommendedSide,
      sportsbook: sig.sportsbook ?? "draftkings", edge: sig.edge,
      enginePct: sig.enginePct, gameId: sig.gameId ?? "",
    }]);
  };

  const handleSignalClickThrough = (sig: MLBSignal) => {
    if (sig.gameId) {
      setSelectedGameId(sig.gameId);
      setMainTab("games");
      if (sig.market) setSelectedMarket(sig.market);
      setTimeout(() => {
        gameDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 150);
    }
  };

  const isElite = user?.hasMLB === true;

  const { data: gamesResp, isLoading: gamesLoading } = useQuery<MLBGamesResponse>({
    queryKey: ["/api/mlb/live-games"],
    refetchInterval: 30_000,
  });

  const games = Array.isArray(gamesResp?.games) ? gamesResp!.games : [];
  const hasAnyOdds = games.some(g => g?.hasOdds === true);

  const { data: playersRaw, isLoading: playersLoading, error: playersError } = useQuery<{ ready: boolean; reason: string | null; players: MLBBatter[] }>({
    queryKey: ["/api/mlb/live-stats", selectedGameId],
    enabled: !!selectedGameId && !mlbUpgradeNeeded,
    refetchInterval: 30_000,
    retry: (fc, err: any) => !(err?.message?.includes("MLB_UPGRADE_REQUIRED") || err?.status === 402) && fc < 2,
  });
  const lineupReady = playersRaw?.ready ?? false;
  const lineupReason = playersRaw?.reason ?? null;
  const players = Array.isArray(playersRaw?.players) ? playersRaw!.players : (Array.isArray(playersRaw) ? (playersRaw as any as MLBBatter[]) : []);

  useEffect(() => {
    if (playersError && ((playersError as any)?.message?.includes("MLB_UPGRADE_REQUIRED") || (playersError as any)?.status === 402))
      setMlbUpgradeNeeded(true);
  }, [playersError]);

  const { data: signalsResp, isLoading: signalsLoading, error: signalsError } = useQuery<SignalsResponse>({
    queryKey: ["/api/mlb/live-signals", selectedGameId],
    enabled: !!selectedGameId && !mlbUpgradeNeeded,
    refetchInterval: 90_000,
    retry: (fc, err: any) => !(err?.message?.includes("MLB_UPGRADE_REQUIRED") || err?.status === 402) && fc < 2,
  });

  useEffect(() => {
    if (signalsError && ((signalsError as any)?.message?.includes("MLB_UPGRADE_REQUIRED") || (signalsError as any)?.status === 402))
      setMlbUpgradeNeeded(true);
  }, [signalsError]);

  const signals = Array.isArray(signalsResp?.signals) ? signalsResp!.signals : [];
  const updatedAt = signalsResp?.updatedAt ?? 0;

  const { data: edgeFeedResp } = useQuery<EdgeFeedResponse>({
    queryKey: ["/api/mlb/edge-feed"],
    enabled: mainTab === "live_feed" || mainTab === "edge_feed" || mainTab === "inning_feed" || mainTab === "hr_radar",
    refetchInterval: 60_000,
  });
  const edgeFeedSignals = Array.isArray(edgeFeedResp?.signals) ? edgeFeedResp!.signals : [];

  const selectedGameRaw = games.find(g => g?.gameId === selectedGameId) ?? null;
  const selectedGameRef = useRef<MLBGame | null>(null);
  useEffect(() => { if (selectedGameRaw) selectedGameRef.current = selectedGameRaw; }, [selectedGameRaw]);
  const selectedGame = selectedGameRaw ?? selectedGameRef.current;

  const opponentTeam = selectedPlayer && selectedGame
    ? (selectedPlayer.teamAbbr === selectedGame.homeAbbr ? selectedGame.awayAbbr : selectedGame.homeAbbr)
    : null;

  const { data: oddsData, isLoading: oddsLoading } = useQuery<Record<string, OddsEntry>>({
    queryKey: ["/api/mlb/odds", selectedPlayer?.teamAbbr, opponentTeam, selectedPlayer?.playerName, selectedMarket],
    enabled: !!selectedPlayer && !!opponentTeam,
    refetchInterval: 120_000,
    queryFn: async () => {
      const params = new URLSearchParams({
        playerTeam: selectedPlayer!.teamAbbr, opponentTeam: opponentTeam!, playerName: selectedPlayer!.playerName,
        statType: selectedMarket, inPlay: selectedGame?.status === "live" ? "true" : "false",
      });
      const token = localStorage.getItem("ll_auth_token");
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`/api/mlb/odds?${params}`, { credentials: "include", headers });
      if (!res.ok) throw new Error("Failed to fetch odds");
      return res.json();
    },
  });

  const calcMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPlayer || !selectedGame) throw new Error("Missing data");
      if (manualMode) {
        const bookLine = parseFloat(manualBookLine);
        if (isNaN(bookLine) || bookLine <= 0) throw new Error("Book line required");
        const body = {
          playerId: selectedPlayer.playerId, playerName: selectedPlayer.playerName, market: selectedMarket,
          bookLine, team: selectedPlayer.teamAbbr, opponent: opponentTeam, gameId: selectedGame.gameId,
          currentStats: { pa: selectedPlayer.ab + selectedPlayer.bb, hits: selectedPlayer.h, totalBases: selectedPlayer.tb,
            walks: selectedPlayer.bb, k: selectedPlayer.k, battingOrder: selectedPlayer.battingOrderSlot },
          gameContext: { inning: selectedGame.inning, isTopInning: selectedGame.isTopInning, runners: 0, outs: 0,
            score: selectedGame.status === "live" && selectedGame.awayScore != null && selectedGame.homeScore != null
              ? `${selectedGame.awayScore}-${selectedGame.homeScore}` : "0-0" },
        };
        const res = await apiRequest("POST", "/api/mlb/calculate-manual", body);
        return res.json();
      }
      if (!selectedLine) throw new Error("Missing line");
      const body = {
        playerId: selectedPlayer.playerId, playerName: selectedPlayer.playerName, market: selectedMarket,
        line: selectedLine.line, overOdds: selectedLine.overOdds, team: selectedPlayer.teamAbbr,
        opponent: opponentTeam, gameId: selectedGame.gameId, currentInning: selectedGame.inning,
        isTopInning: selectedGame.isTopInning, battingOrderSlot: selectedPlayer.battingOrderSlot,
        currentStats: { ab: selectedPlayer.ab, h: selectedPlayer.h, tb: selectedPlayer.tb, bb: selectedPlayer.bb,
          k: selectedPlayer.k, sb: selectedPlayer.sb, rbi: selectedPlayer.rbi },
      };
      const res = await apiRequest("POST", "/api/mlb/calculate", body);
      return res.json();
    },
    onSuccess: (data) => setCalcResult(data),
    onError: (err: any) => {
      if (err?.message?.includes("MLB_UPGRADE_REQUIRED") || err?.status === 402) setMlbUpgradeNeeded(true);
    },
  });

  const oddsEntries = oddsData ? Object.entries(oddsData).filter(([k]) => k !== "_quotaExhausted") : [];

  useEffect(() => { setSelectedLine(null); setCalcResult(null); setManualMode(false); }, [selectedMarket]);
  useEffect(() => {
    setSelectedLine(null); setCalcResult(null); setManualMode(false);
    if (selectedPlayer) setManualBookLine("");
  }, [selectedPlayer?.playerId]);
  useEffect(() => {
    setSelectedPlayer(null); setCalcResult(null); setSelectedLine(null); setSelectedMarket("hits"); setManualMode(false);
    if (selectedGameId) {
      setTimeout(() => {
        gameDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    }
  }, [selectedGameId]);
  useEffect(() => {
    if ((!oddsLoading && oddsEntries.length === 0 && selectedPlayer) || !hasAnyOdds) setManualMode(true);
    else if (oddsEntries.length > 0) {
      setManualMode(false);
      if (!selectedLine && oddsEntries.length > 0) {
        const sorted = [...oddsEntries].sort((a, b) => {
          const oA = (a[1] as OddsEntry).overOdds ?? -999;
          const oB = (b[1] as OddsEntry).overOdds ?? -999;
          return oB - oA;
        });
        const [bestBook, bestOdds] = sorted[0];
        const o = bestOdds as OddsEntry;
        if (o.line != null && o.overOdds != null && o.underOdds != null) {
          setSelectedLine({ book: bestBook, line: o.line, overOdds: o.overOdds, underOdds: o.underOdds });
        }
      }
    }
  }, [oddsLoading, oddsEntries.length, selectedPlayer?.playerId, hasAnyOdds]);

  const rosterPlayerIds = new Set<string>(players.filter(p => p?.playerId).map(p => String(p.playerId)));
  const validatedSignals = selectedGameId ? signals.filter(sig => sig && isValidSignal(sig, selectedGameId, rosterPlayerIds)) : [];
  const pitchersResolved = !!(selectedGame?.pitcherAway || selectedGame?.pitcherHome);
  const gameHydrated = !!(
    pitchersResolved &&
    selectedGame?.status != null &&
    (selectedGame?.status !== "live" || (selectedGame?.inning != null && selectedGame.inning >= 1)) &&
    players.length > 0
  );
  const playerHydrated = !!(
    selectedPlayer &&
    selectedPlayer.ab != null &&
    selectedPlayer.battingOrderSlot > 0
  );
  const lineValid = manualMode
    ? (manualBookLine.trim() !== "" && !isNaN(parseFloat(manualBookLine)) && parseFloat(manualBookLine) > 0)
    : !!selectedLine;
  const canCalculate = gameHydrated && playerHydrated && lineValid;

  if (authLoading || gamesLoading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-12 flex flex-col items-center justify-center gap-3">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">Loading MLB…</span>
      </div>
    );
  }

  if (mlbUpgradeNeeded) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-12 flex flex-col items-center justify-center gap-4">
        <span className="text-4xl">⚾</span>
        <h3 className="text-lg font-bold text-foreground">MLB Preview Limit Reached</h3>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          You've used your 2 free MLB preview plays for today. Upgrade to All Sports for unlimited MLB access.
        </p>
        <a href="/pricing" data-testid="link-mlb-upgrade-pricing"
          className="w-full max-w-xs py-2.5 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors text-center block">
          Upgrade to All Sports — $65/mo
        </a>
      </div>
    );
  }

  const TABS: { key: MainTab; label: string; color?: string }[] = [
    { key: "games", label: "Games" },
    { key: "live_feed", label: "Live Feed" },
    { key: "hr_radar", label: "HR Radar", color: "orange" },
  ];

  const [liveFeedSub, setLiveFeedSub] = useState<"all" | "3rd" | "5th" | "7th">("all");

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/mlb/live-games"] });
    if (selectedGameId) {
      queryClient.invalidateQueries({ queryKey: ["/api/mlb/live-stats", selectedGameId] });
      queryClient.invalidateQueries({ queryKey: ["/api/mlb/live-signals", selectedGameId] });
      queryClient.invalidateQueries({ queryKey: ["/api/mlb/odds"] });
    }
    queryClient.invalidateQueries({ queryKey: ["/api/mlb/edge-feed"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mlb/hr-radar"] });
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap" data-testid="nav-mlb-tabs">
        <div className="flex gap-1.5 flex-wrap">
          {TABS.map(tab => {
            const active = mainTab === tab.key || (tab.key === "live_feed" && (mainTab === "edge_feed" || mainTab === "inning_feed"));
            const isOrange = tab.color === "orange";
            return (
              <button
                key={tab.key}
                data-testid={`tab-mlb-${tab.key}`}
                onClick={() => { setMainTab(tab.key); if (tab.key !== "games") setSelectedGameId(null); }}
                className={`px-4 py-2 text-xs font-semibold rounded-full border transition-all ${
                  active
                    ? isOrange ? "bg-orange-500 text-white border-orange-500" : "bg-primary text-primary-foreground border-primary"
                    : isOrange ? "border-orange-500/40 text-orange-400 hover:text-orange-300 hover:border-orange-500/60" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <button
          data-testid="button-mlb-refresh"
          onClick={handleRefresh}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-all"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
          Refresh
        </button>
      </div>

      {mainTab === "games" && (
        <>
          {games.length === 0 ? (
            <div className="text-xs text-muted-foreground py-3" data-testid="text-no-mlb-games-today">
              No MLB games scheduled today. Check back soon.
            </div>
          ) : (
            <MLBScheduleList games={games} selectedGameId={selectedGameId} onSelectGame={(id) => { setSelectedGameId(id); setMainTab("games"); }} />
          )}

          {!selectedGameId && !isElite && games.length > 0 && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 text-center space-y-3">
              <div className="text-sm font-bold text-foreground">Unlock MLB Edges</div>
              <div className="text-xs text-muted-foreground">
                Upgrade to All Sports to see live probabilities, edge percentages, and bet recommendations for every MLB game.
              </div>
              <a href="/upgrade" data-testid="link-mlb-upgrade-cta"
                className="inline-block px-5 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors">
                Upgrade to All Sports →
              </a>
            </div>
          )}

          {selectedGameId && selectedGame && selectedPlayer === null && (
            <div ref={gameDetailRef}>
            <GameDetailView
              game={selectedGame}
              players={players}
              signals={validatedSignals}
              isElite={isElite}
              signalsLoading={signalsLoading}
              playersLoading={playersLoading}
              updatedAt={updatedAt}
              lineupReady={lineupReady}
              lineupReason={lineupReason}
              onSelectPlayer={(p) => setSelectedPlayer(p)}
              onBack={() => setSelectedGameId(null)}
              onRefresh={handleRefresh}
            />
            </div>
          )}

          {selectedGameId && selectedGame && selectedPlayer !== null && (
            <PlayerDetailView
              player={selectedPlayer}
              game={selectedGame}
              signals={validatedSignals}
              isElite={isElite}
              oddsEntries={oddsEntries}
              oddsLoading={oddsLoading}
              selectedMarket={selectedMarket}
              setSelectedMarket={setSelectedMarket}
              selectedLine={selectedLine}
              setSelectedLine={setSelectedLine}
              manualMode={manualMode}
              setManualMode={setManualMode}
              manualBookLine={manualBookLine}
              setManualBookLine={setManualBookLine}
              hasAnyOdds={hasAnyOdds}
              canCalculate={canCalculate}
              gameHydrated={gameHydrated}
              playerHydrated={playerHydrated}
              lineValid={lineValid}
              lineupReady={lineupReady}
              calcMutation={calcMutation}
              calcResult={calcResult}
              setCalcResult={setCalcResult}
              opponentTeam={opponentTeam}
              onBack={() => { setSelectedPlayer(null); setCalcResult(null); setSelectedLine(null); setManualMode(false); }}
            />
          )}
        </>
      )}

      {(mainTab === "live_feed" || mainTab === "edge_feed" || mainTab === "inning_feed") && (
        <div className="space-y-4">
          <div className="flex gap-1.5 flex-wrap">
            {(["all", "3rd", "5th", "7th"] as const).map(sub => (
              <button
                key={sub}
                data-testid={`tab-feed-${sub}`}
                onClick={() => setLiveFeedSub(sub)}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-full border transition-all ${
                  liveFeedSub === sub ? "bg-background text-foreground border-primary/50 shadow-sm" : "border-border/50 text-muted-foreground hover:text-foreground"
                }`}
              >
                {sub === "all" ? "All Signals" : sub === "3rd" ? "3rd Inning" : sub === "5th" ? "5th Inning" : "7th Inning"}
              </button>
            ))}
          </div>
          {(() => {
            let filtered = edgeFeedSignals;
            if (liveFeedSub !== "all") {
              const feedTagKey = liveFeedSub === "3rd" ? "inning_3" : liveFeedSub === "5th" ? "inning_5" : "inning_7";
              filtered = edgeFeedSignals.filter(s => (s.feedTags ?? []).includes(feedTagKey));
            }
            if (liveFeedSub === "all") {
              return (
                <div className="space-y-6">
                  <TopPlays signals={filtered} onPlayerClick={(gameId, _playerId) => { setSelectedGameId(gameId); setMainTab("games"); setTimeout(() => gameDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150); }} />
                  <LiveBoard signals={filtered} onPlayerClick={(gameId, _playerId) => { setSelectedGameId(gameId); setMainTab("games"); setTimeout(() => gameDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150); }} />
                </div>
              );
            }
            return filtered.length === 0 ? (
              <div className="rounded-xl border border-border/40 bg-card p-8 text-center">
                <div className="flex items-center justify-center gap-2 text-sm text-blue-400">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400" />
                  </span>
                  Monitoring {liveFeedSub} inning signals
                </div>
                <div className="text-xs text-muted-foreground/60 mt-1">Signals appear as games progress and pitcher fatigue data accumulates.</div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {filtered.map(sig => (
                  <SignalCard key={`${sig.playerId}-${sig.market}-${sig.gameId}`} sig={sig} isElite={isElite} compact onClickThrough={handleSignalClickThrough} onAddToSlip={handleAddToSlip} />
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {mainTab === "hr_radar" && (
        <HRRadarSection isElite={isElite} />
      )}

      {mlbSlipPicks.length > 0 && (
        <div className="fixed bottom-4 right-4 left-4 sm:left-auto sm:w-96 z-50" data-testid="mlb-bet-slip">
          <div className="rounded-xl border border-green-500/30 bg-card shadow-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-foreground">MLB Bet Slip ({mlbSlipPicks.length})</span>
              <button
                data-testid="button-clear-mlb-slip"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setMlbSlipPicks([])}
              >Clear All</button>
            </div>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {mlbSlipPicks.map((pick, idx) => (
                <div key={`${pick.playerId}-${pick.market}`} className="flex items-center justify-between text-xs py-1.5 px-2 rounded-lg bg-secondary/40 border border-border/30">
                  <div className="min-w-0">
                    <span className="font-semibold text-foreground truncate block">{pick.playerName}</span>
                    <span className="text-muted-foreground">{MARKET_LABELS[pick.market] ?? pick.market} {pick.side} {pick.line}</span>
                  </div>
                  <button
                    data-testid={`button-remove-slip-${idx}`}
                    className="text-muted-foreground hover:text-red-400 shrink-0 ml-2 p-1"
                    onClick={() => setMlbSlipPicks(prev => prev.filter((_, i) => i !== idx))}
                  >✕</button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                data-testid="button-copy-mlb-slip"
                className="flex-1 text-xs py-2 rounded-lg border border-border hover:bg-muted transition-colors text-foreground font-semibold"
                onClick={() => {
                  const text = mlbSlipPicks.map(p => `${p.playerName} — ${MARKET_LABELS[p.market] ?? p.market} ${p.side} ${p.line}`).join("\n");
                  navigator.clipboard?.writeText(text);
                }}
              >Copy All</button>
              <a
                data-testid="link-mlb-slip-dk"
                href="https://sportsbook.draftkings.com/leagues/baseball/mlb?category=player-props"
                target="_blank" rel="noopener noreferrer"
                className="flex-1 text-xs py-2 rounded-lg bg-[#1a6f3c] hover:bg-[#1a8f4c] text-white text-center font-semibold transition-colors"
                onClick={() => {
                  const text = mlbSlipPicks.map(p => `${p.playerName} — ${MARKET_LABELS[p.market] ?? p.market} ${p.side} ${p.line}`).join("\n");
                  navigator.clipboard?.writeText(text);
                }}
              >Open DraftKings</a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type HRRadarResponse = {
  hrEdges: Array<{
    playerId: string; playerName: string; team: string; market: string; side: string;
    line: number; projection: number; engineProbability: number; edge: number | null;
    signalScore: number; confidenceTier: string; badges: string[]; reasons: string[];
    gameId: string; awayAbbr: string | null; homeAbbr: string | null;
  }>;
  hrWatchlist: Array<{
    playerId: string; playerName: string; team: string; hrProbability: number;
    hardHitEvents: number; parkFactor: number | null; windFactor: string;
    reasons: string[]; gameId: string; awayAbbr: string | null; homeAbbr: string | null;
    badges: string[];
  }>;
};

function HRRadarSection({ isElite }: { isElite: boolean }) {
  const { data: hrData, isLoading } = useQuery<HRRadarResponse>({
    queryKey: ["/api/mlb/hr-radar"],
    refetchInterval: 60_000,
  });

  const hrEdges = hrData?.hrEdges ?? [];
  const hrWatchlist = hrData?.hrWatchlist ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-foreground" style={{ color: "#f97316" }} data-testid="text-hr-radar-title">HR Radar</h2>
      </div>

      {isLoading && (
        <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-4 text-center">
          <div className="text-xs text-orange-400 animate-pulse">Loading HR radar data...</div>
        </div>
      )}

      {!isLoading && hrEdges.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-green-400 uppercase tracking-wider" data-testid="text-hr-edges-title">Bettable HR Edges</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {hrEdges.map(edge => (
              <div key={`hr-edge-${edge.playerId}-${edge.market}-${edge.gameId}`}
                data-testid={`card-hr-edge-${edge.playerId}`}
                className="rounded-xl border border-green-500/30 bg-green-500/5 p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-foreground">{edge.playerName}</span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    edge.confidenceTier === "ELITE" ? "bg-green-500/20 text-green-400" :
                    edge.confidenceTier === "STRONG" ? "bg-yellow-500/20 text-yellow-400" :
                    "bg-blue-500/20 text-blue-400"
                  }`}>{edge.confidenceTier}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{edge.team}</span>
                  <span>•</span>
                  <span>{MARKET_LABELS[edge.market] ?? edge.market}</span>
                  <span>•</span>
                  <span className="text-green-400">{edge.side} {edge.line?.toFixed(1)}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px]">
                  <span className="text-foreground">Prob: {edge.engineProbability?.toFixed(1)}%</span>
                  {edge.edge != null && <span className="text-green-400">Edge: {edge.edge > 0 ? "+" : ""}{edge.edge.toFixed(1)}%</span>}
                  <span className="text-muted-foreground">Score: {edge.signalScore}</span>
                </div>
                {Array.isArray(edge.badges) && edge.badges.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {edge.badges.map(b => (
                      <span key={b} className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">{b}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!isLoading && hrEdges.length === 0 && (
        <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-4 text-center space-y-2">
          <div className="flex items-center justify-center gap-2 text-sm text-orange-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-400" />
            </span>
            Scanning HR markets
          </div>
          <div className="text-xs text-muted-foreground/60">HR edges surface when hard contact, park/weather factors, and pitcher vulnerability data align.</div>
        </div>
      )}

      {!isLoading && hrWatchlist.length > 0 && (
        <div className="space-y-2 mt-4">
          <h3 className="text-xs font-semibold text-orange-400 uppercase tracking-wider" data-testid="text-hr-watchlist-title">HR Watchlist</h3>
          <div className="text-[10px] text-muted-foreground/70 mb-1">Players with HR-favorable context</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {hrWatchlist.map(w => (
              <div key={`hr-watch-${w.playerId}-${w.gameId}`}
                data-testid={`card-hr-watch-${w.playerId}`}
                className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold text-foreground">{w.playerName}</span>
                  <span className="text-[10px] text-orange-400">{w.team}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>HR Prob: {w.hrProbability?.toFixed(1)}%</span>
                  {w.hardHitEvents > 0 && <span>• {w.hardHitEvents} hard hits</span>}
                  <span>• Wind: {w.windFactor}</span>
                </div>
                {Array.isArray(w.badges) && w.badges.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {w.badges.map(b => (
                      <span key={b} className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400">{b}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!isLoading && hrEdges.length === 0 && hrWatchlist.length === 0 && (
        <div className="text-xs text-muted-foreground/60 text-center py-2">
          HR context data accumulates as games progress and contact data is recorded.
        </div>
      )}
    </div>
  );
}

function PitcherCard({ game, side, signals, isElite }: {
  game: MLBGame; side: "home" | "away"; signals: MLBSignal[]; isElite: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const pitcherName = side === "home" ? game.pitcherHome : game.pitcherAway;
  const hand = side === "home" ? game.homePitcherHand : game.awayPitcherHand;
  const teamAbbr = side === "home" ? (game.homeAbbr ?? "HOME") : (game.awayAbbr ?? "AWAY");
  const ctx = game.pitcherContext;
  const pitcherSignals = signals.filter(s => {
    if (!PITCHER_MARKET_SET.has(s.market)) return false;
    if (pitcherName && s.playerName && s.playerName.toLowerCase().includes(pitcherName.split(" ").pop()?.toLowerCase() ?? "")) return true;
    return false;
  });
  const bestSig = pitcherSignals.length > 0
    ? pitcherSignals.reduce((b, s) => (s.enginePct ?? 0) > (b.enginePct ?? 0) ? s : b)
    : null;
  const glowEligible = pitcherSignals.some(s =>
    s.playerGlowEligible &&
    (s.confidenceTier === "ELITE" || s.confidenceTier === "STRONG") &&
    (s.edge ?? 0) >= 10
  );

  if (!pitcherName) return null;

  return (
    <div
      data-testid={`card-pitcher-${side}`}
      className={`rounded-lg border overflow-hidden transition-all cursor-pointer ${
        glowEligible
          ? "border-green-500/50 shadow-[0_0_12px_rgba(34,197,94,0.25)]"
          : "border-border/30"
      }`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="px-3 py-2.5 flex items-center justify-between" style={{ background: "rgba(139,92,246,0.06)" }}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[8px] font-black px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400 shrink-0">P</span>
          <span className="text-xs font-bold text-foreground truncate">{pitcherName}</span>
          {hand && <span className="text-[9px] text-muted-foreground shrink-0">({hand}HP)</span>}
          <span className="text-[9px] text-muted-foreground shrink-0">{teamAbbr}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {bestSig && (
            <span className={`text-sm font-black ${probColor(bestSig.enginePct)}`}>{Math.round(bestSig.enginePct)}%</span>
          )}
          {ctx && (
            <span className={`text-[9px] font-semibold ${ctx.pitchCount >= 85 ? "text-red-400" : "text-muted-foreground"}`}>
              {ctx.pitchCount}P
            </span>
          )}
          <span className="text-muted-foreground text-xs">{expanded ? "▾" : "▸"}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-2 space-y-3 border-t border-border/20">
          {ctx && (
            <div>
              <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Pitching Form</div>
              <div className="grid grid-cols-4 gap-2">
                <div className="bg-secondary/30 rounded-lg p-1.5 text-center">
                  <div className="text-[8px] text-muted-foreground">Pitches</div>
                  <div className={`text-xs font-bold ${ctx.pitchCount >= 85 ? "text-red-400" : ctx.pitchCount >= 60 ? "text-yellow-400" : "text-foreground"}`}>
                    {ctx.pitchCount}
                  </div>
                </div>
                <div className="bg-secondary/30 rounded-lg p-1.5 text-center">
                  <div className="text-[8px] text-muted-foreground">Lineup Pass</div>
                  <div className={`text-xs font-bold ${ctx.timesThroughOrder >= 3 ? "text-red-400" : "text-foreground"}`}>
                    {ordinal(ctx.timesThroughOrder)}
                  </div>
                </div>
                {ctx.avgVelocity != null && (
                  <div className="bg-secondary/30 rounded-lg p-1.5 text-center">
                    <div className="text-[8px] text-muted-foreground">Velo</div>
                    <div className="text-xs font-bold text-foreground">{ctx.avgVelocity.toFixed(1)}</div>
                  </div>
                )}
                {ctx.velocityDrop != null && ctx.velocityDrop > 0 && (
                  <div className="bg-secondary/30 rounded-lg p-1.5 text-center">
                    <div className="text-[8px] text-muted-foreground">Drop</div>
                    <div className="text-xs font-bold text-red-400">-{ctx.velocityDrop.toFixed(1)}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {pitcherSignals.length > 0 && (
            <div>
              <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Engine Signals</div>
              <div className="space-y-1">
                {pitcherSignals.map(sig => (
                  <div key={`${sig.playerId}-${sig.market}`} className="flex items-center justify-between text-[10px] px-2 py-1 rounded bg-secondary/20">
                    <div className="flex items-center gap-1.5">
                      <span className={`font-bold px-1 py-0.5 rounded text-[9px] ${sig.recommendedSide === "OVER" ? "bg-green-500/20 text-green-400" : sig.recommendedSide === "UNDER" ? "bg-blue-500/20 text-blue-400" : "bg-muted/30 text-muted-foreground"}`}>
                        {sig.recommendedSide === "OVER" ? "O" : sig.recommendedSide === "UNDER" ? "U" : "—"}
                      </span>
                      <span className="text-muted-foreground">{MARKET_LABELS[sig.market] ?? sig.market}</span>
                      {sig.bookLine != null && <span className="text-foreground font-semibold">{sig.bookLine}</span>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={`font-bold ${probColor(sig.enginePct)}`}>{Math.round(sig.enginePct)}%</span>
                      {sig.edge != null && sig.edge > 0 && (
                        <span className={`text-[9px] ${edgeColor(sig.edge)}`}>+{sig.edge.toFixed(1)}%</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {pitcherSignals.length > 0 && (
            <div className="flex gap-1.5">
              {pitcherSignals.map(sig => (
                <button
                  key={`tweet-${sig.playerId}-${sig.market}`}
                  data-testid={`button-pitcher-tweet-${sig.playerId}-${sig.market}`}
                  className="text-[9px] px-2 py-1 rounded border border-blue-500/30 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors font-semibold"
                  onClick={(e) => {
                    e.stopPropagation();
                    const tweet = generateTweet(sig, isElite);
                    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`, "_blank", "noopener,noreferrer,width=550,height=420");
                  }}
                >
                  𝕏 {MARKET_LABELS[sig.market] ?? sig.market}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TeamBatterSection({ teamAbbr, pitcher, players, signals, game, isElite, onSelectPlayer, side, score }: {
  teamAbbr: string;
  pitcher: string | null;
  players: MLBBatter[];
  signals: MLBSignal[];
  game: MLBGame;
  isElite: boolean;
  onSelectPlayer: (p: MLBBatter) => void;
  side: "home" | "away";
  score: number | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const teamSignals = signals.filter(s => players.some(p => p.playerId === s.playerId));
  const signalCount = teamSignals.length;
  const highProbCount = teamSignals.filter(s => s.enginePct >= 70).length;

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden" data-testid={`section-team-${side}`}>
      <button
        data-testid={`btn-toggle-team-${side}`}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-secondary/20 transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-foreground">{teamAbbr}</span>
          {score != null && <span className="text-xs font-bold text-foreground/80">{score}</span>}
          {pitcher && <span className="text-[10px] text-muted-foreground">· {pitcher}</span>}
        </div>
        <div className="flex items-center gap-2">
          {signalCount > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-bold">
              {signalCount} signal{signalCount !== 1 ? "s" : ""}
            </span>
          )}
          {highProbCount > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 font-bold">
              {highProbCount} 70%+
            </span>
          )}
          <span className="text-muted-foreground text-xs">{collapsed ? "▸" : "▾"}</span>
        </div>
      </button>
      {!collapsed && (
        <div className="px-2 pb-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {players.map(p => (
              <BatterCard key={p.playerId} player={p} signals={signals} game={game} isElite={isElite} onSelect={() => onSelectPlayer(p)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GameDetailView({ game, players, signals, isElite, signalsLoading, playersLoading, updatedAt, lineupReady, lineupReason, onSelectPlayer, onBack, onRefresh }: {
  game: MLBGame;
  players: MLBBatter[];
  signals: MLBSignal[];
  isElite: boolean;
  signalsLoading: boolean;
  playersLoading: boolean;
  updatedAt: number;
  lineupReady: boolean;
  lineupReason: string | null;
  onSelectPlayer: (p: MLBBatter) => void;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const awayPlayers = players.filter(p => p.teamSide === "away" || (game.awayAbbr && p.teamAbbr === game.awayAbbr));
  const homePlayers = players.filter(p => p.teamSide === "home" || (game.homeAbbr && p.teamAbbr === game.homeAbbr));

  const signalGroups = (() => {
    const groups: Record<string, { playerName: string; playerId: string; direction: string; signals: MLBSignal[]; bestPct: number; avgEdge: number }> = {};
    for (const sig of signals) {
      const key = `${sig.playerId}-${sig.recommendedSide}`;
      if (!groups[key]) {
        groups[key] = { playerName: sig.playerName, playerId: sig.playerId, direction: sig.recommendedSide, signals: [], bestPct: 0, avgEdge: 0 };
      }
      groups[key].signals.push(sig);
      if (sig.enginePct > groups[key].bestPct) groups[key].bestPct = sig.enginePct;
    }
    for (const g of Object.values(groups)) {
      g.avgEdge = g.signals.reduce((sum, s) => sum + (s.edge ?? 0), 0) / g.signals.length;
      g.signals.sort((a, b) => (b.enginePct ?? 0) - (a.enginePct ?? 0));
    }
    return Object.values(groups).sort((a, b) => b.bestPct - a.bestPct);
  })();

  return (
    <div className="space-y-3">
      <button data-testid="button-back-to-games" onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors font-medium">
        ← Back to Games
      </button>

      <div className="rounded-lg border border-border/30 bg-card overflow-hidden" data-testid="card-mlb-game-detail">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/20">
          <div className="flex items-center gap-3">
            {game.status === "live" && game.awayScore != null && game.homeScore != null ? (
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-foreground">{game.awayAbbr}</span>
                <span className="text-lg font-black text-foreground">{game.awayScore}</span>
                <span className="text-muted-foreground/40">–</span>
                <span className="text-lg font-black text-foreground">{game.homeScore}</span>
                <span className="text-sm font-bold text-foreground">{game.homeAbbr}</span>
                {game.inning > 0 && (
                  <span className="text-xs font-bold text-green-400 ml-1">{game.isTopInning ? "▲" : "▼"}{game.inning}</span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-foreground">{game.awayAbbr} vs {game.homeAbbr}</span>
                {game.startTime && (
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(game.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                  </span>
                )}
              </div>
            )}
          </div>
          {game.status === "live" ? (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 animate-pulse">LIVE</span>
          ) : (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">PRE</span>
          )}
        </div>

        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border/20 text-[10px] text-muted-foreground overflow-x-auto">
          <span className="shrink-0">{game.pitcherAway?.split(" ").pop() || "Loading..."} vs {game.pitcherHome?.split(" ").pop() || "Loading..."}</span>
          {game.pitcherContext && (
            <>
              <span className={game.pitcherContext.pitchCount >= 85 ? "text-red-400 font-semibold" : ""}>{game.pitcherContext.pitchCount}P</span>
              <span className={game.pitcherContext.timesThroughOrder >= 3 ? "text-red-400 font-semibold" : ""}>{passLabel(game.pitcherContext.timesThroughOrder)}</span>
              {game.pitcherContext.avgVelocity != null && <span>{game.pitcherContext.avgVelocity.toFixed(1)}mph</span>}
              {game.pitcherContext.velocityDrop != null && game.pitcherContext.velocityDrop > 0 && (
                <span className="text-red-400 font-semibold">-{game.pitcherContext.velocityDrop.toFixed(1)}</span>
              )}
            </>
          )}
          <span className="shrink-0 ml-auto">{game.venue ?? ""}</span>
          {game.weather?.temperature != null && <span>{game.weather.temperature}°F</span>}
          {game.weather?.windSpeed != null && game.weather.windDirection && (
            <span>Wind {game.weather.windDirection} {game.weather.windSpeed}mph</span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between px-3 py-1.5">
        <div className="flex items-center gap-2 text-[10px]">
          {lineupReady ? (
            <span className="text-green-400 font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Lineup ready
            </span>
          ) : playersLoading ? (
            <span className="text-muted-foreground font-medium animate-pulse">Lineup syncing…</span>
          ) : (
            <span className="text-yellow-400 font-medium">{lineupReason || "Waiting for official box score"}</span>
          )}
        </div>
        <button data-testid="button-game-refresh" onClick={onRefresh}
          className="text-[10px] px-2 py-0.5 rounded border border-border/50 text-muted-foreground hover:text-foreground transition-colors">
          Refresh
        </button>
      </div>

      {signals.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">Active Signals</h3>
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 font-bold">{signals.length}</span>
              {signalsLoading && <span className="text-[9px] text-muted-foreground animate-pulse">Refreshing…</span>}
            </div>
            {signals.length > 0 && (
              <button
                data-testid="button-tweet-all-signals"
                className="text-[10px] px-2.5 py-1 rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors font-semibold"
                onClick={() => {
                  const tweetParts = signals
                    .sort((a, b) => (b.enginePct ?? 0) - (a.enginePct ?? 0))
                    .slice(0, 4)
                    .map(s => `${s.playerName} ${s.recommendedSide} ${MARKET_LABELS[s.market] ?? s.market} ${s.bookLine ?? ""} (${Math.round(s.enginePct)}%)`)
                    .join("\n");
                  const tweet = `${game.awayAbbr} @ ${game.homeAbbr}\n\n${tweetParts}\n\nPowered by LiveLocks ⚾️`;
                  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`, "_blank", "noopener,noreferrer,width=550,height=420");
                }}
              >
                𝕏 Tweet All
              </button>
            )}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1.5" style={{ scrollSnapType: "x mandatory" }}>
            {signals
              .sort((a, b) => (b.enginePct ?? 0) - (a.enginePct ?? 0))
              .map((sig, idx) => {
                const sideColor = sig.recommendedSide === "OVER" ? { accent: "#22c55e", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.3)" }
                  : { accent: "#3b82f6", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.3)" };
                const tier = sig.confidenceTier;
                const glowClass = sig.playerGlowEligible && (tier === "ELITE" || tier === "STRONG") && (sig.edge ?? 0) >= 10
                  ? "shadow-[0_0_10px_rgba(34,197,94,0.25)]" : "";
                return (
                  <div
                    key={`sig-${sig.playerId}-${sig.market}-${idx}`}
                    data-testid={`signal-strip-${sig.playerId}-${sig.market}`}
                    className={`flex-shrink-0 rounded-lg p-2.5 space-y-1 ${glowClass}`}
                    style={{ width: 180, background: sideColor.bg, border: `1px solid ${sideColor.border}`, scrollSnapAlign: "start" }}
                  >
                    <div className="flex items-center justify-between">
                      {tier && tier !== "WATCHLIST" && (
                        <span className={`text-[7px] font-black px-1 py-0.5 rounded ${tier === "ELITE" ? "bg-green-500/20 text-green-400" : tier === "STRONG" ? "bg-yellow-500/20 text-yellow-400" : "bg-blue-500/15 text-blue-400"}`}>
                          {tier}
                        </span>
                      )}
                      <span className="text-[8px] font-black px-1 py-0.5 rounded" style={{ color: sideColor.accent, background: "rgba(255,255,255,0.04)" }}>
                        {sig.recommendedSide}
                      </span>
                    </div>
                    <div className="text-[10px] font-bold text-foreground truncate">{sig.playerName}</div>
                    <div className="text-[9px] text-muted-foreground">{MARKET_LABELS[sig.market] ?? sig.market} {sig.bookLine}</div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-black" style={{ color: sideColor.accent }}>{Math.round(sig.enginePct)}%</span>
                      {sig.edge != null && sig.edge > 0 && (
                        <span className={`text-[9px] font-bold ${edgeColor(sig.edge)}`}>+{sig.edge.toFixed(1)}%</span>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {signals.length === 0 && (
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-2" data-testid="mlb-game-signal-cta">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400" />
            </span>
            <span className="text-xs font-semibold text-blue-400">
              {game.status === "live" ? "No qualified signals yet" : "Waiting for game start"}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            {game.status === "live"
              ? "Select any batter below to run a manual calculation on their prop markets."
              : "Signals will generate once the game begins and live data flows in."}
          </p>
        </div>
      )}

      {(game.pitcherAway || game.pitcherHome) && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">Pitchers</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <PitcherCard game={game} side="away" signals={signals} isElite={isElite} />
            <PitcherCard game={game} side="home" signals={signals} isElite={isElite} />
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">Lineup</h3>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {playersLoading && <span className="animate-pulse">Loading…</span>}
            {players.length > 0 && <span>{players.length} batters</span>}
          </div>
        </div>

        {!playersLoading && players.length === 0 && (
          <div className="rounded-lg border border-border/30 bg-card/50 p-3 text-center">
            <div className="flex items-center justify-center gap-2 text-xs text-blue-400">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-400" />
              </span>
              {game.status === "pregame" ? "Lineup loading" : "Resolving batter data"}
            </div>
          </div>
        )}

        {(awayPlayers.length > 0 || homePlayers.length > 0) && (
          <>
            <TeamBatterSection
              teamAbbr={game.awayAbbr ?? "AWAY"}
              pitcher={game.pitcherAway ?? null}
              players={awayPlayers}
              signals={signals}
              game={game}
              isElite={isElite}
              onSelectPlayer={onSelectPlayer}
              side="away"
              score={game.awayScore}
            />
            <TeamBatterSection
              teamAbbr={game.homeAbbr ?? "HOME"}
              pitcher={game.pitcherHome ?? null}
              players={homePlayers}
              signals={signals}
              game={game}
              isElite={isElite}
              onSelectPlayer={onSelectPlayer}
              side="home"
              score={game.homeScore}
            />
          </>
        )}

        {awayPlayers.length === 0 && homePlayers.length === 0 && players.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {players.map(p => (
              <BatterCard key={p.playerId} player={p} signals={signals} game={game} isElite={isElite} onSelect={() => onSelectPlayer(p)} />
            ))}
          </div>
        )}
      </div>

      {!isElite && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-center space-y-2">
          <div className="text-sm font-bold text-foreground">Unlock Full MLB Analysis</div>
          <div className="text-xs text-muted-foreground">Upgrade to All Sports for unlimited signals and bet recommendations.</div>
          <a href="/upgrade" data-testid="link-mlb-upgrade-cta-detail"
            className="inline-block px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors">
            Upgrade to All Sports →
          </a>
        </div>
      )}
    </div>
  );
}

function PlayerDetailView({ player, game, signals, isElite, oddsEntries, oddsLoading, selectedMarket, setSelectedMarket,
  selectedLine, setSelectedLine, manualMode, setManualMode, manualBookLine, setManualBookLine, hasAnyOdds, canCalculate,
  gameHydrated, playerHydrated, lineValid, lineupReady,
  calcMutation, calcResult, setCalcResult, opponentTeam, onBack }: {
  player: MLBBatter; game: MLBGame; signals: MLBSignal[]; isElite: boolean;
  oddsEntries: [string, OddsEntry][]; oddsLoading: boolean; selectedMarket: string;
  setSelectedMarket: (m: string) => void; selectedLine: any; setSelectedLine: (l: any) => void;
  manualMode: boolean; setManualMode: (m: boolean) => void; manualBookLine: string;
  setManualBookLine: (v: string) => void; hasAnyOdds: boolean; canCalculate: boolean;
  gameHydrated: boolean; playerHydrated: boolean; lineValid: boolean; lineupReady: boolean;
  calcMutation: any; calcResult: CalcResult | null; setCalcResult: (r: CalcResult | null) => void; opponentTeam: string | null; onBack: () => void;
}) {
  const playerSignals = signals.filter(s => s.playerId === player.playerId);
  const bestSignal = playerSignals.length > 0 ? playerSignals.reduce((b, s) => Math.abs(s.edge ?? 0) > Math.abs(b.edge ?? 0) ? s : b) : null;
  const form = bestSignal?.formIndicator ?? null;
  const abResults = player.priorABResults ?? [];

  return (
    <div className="space-y-4">
      <button data-testid="button-back-to-game" onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors font-medium">
        ← Back to Game
      </button>

      <div className={`rounded-xl border border-border/40 bg-card overflow-hidden ${heatGlow(form)}`}>
        <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-foreground">{player.playerName}</span>
              {form && form !== "NEUTRAL" && (
                <span className={`text-sm font-bold ${heatColor(form)}`}>{heatEmoji(form)} {form}</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{player.teamAbbr} vs {opponentTeam} · #{player.battingOrderSlot}</div>
          </div>
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${game.status === "live" || (game.awayScore != null && game.homeScore != null) ? "bg-green-500/15 text-green-500" : "bg-muted text-muted-foreground"}`}>
            {game.status === "live" || (game.awayScore != null && game.homeScore != null) ? `LIVE ${inningLabel(game)}` : "PRE"}
          </span>
        </div>

        {(() => {
          const bvpData = bestSignal?.bvp;
          if (!bvpData || bvpData.atBats === 0) return null;
          return (
            <div className="px-4 py-3 border-b border-border/30">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Batter vs Pitcher</span>
                <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400">MATCHUP</span>
              </div>
              <div className="grid grid-cols-5 gap-2 text-xs">
                <div className="bg-secondary/30 rounded-lg p-2 text-center">
                  <div className="text-[9px] text-muted-foreground">AB</div>
                  <div className="font-bold text-foreground">{bvpData.atBats}</div>
                </div>
                <div className="bg-secondary/30 rounded-lg p-2 text-center">
                  <div className="text-[9px] text-muted-foreground">H</div>
                  <div className="font-bold text-foreground">{bvpData.hits}</div>
                </div>
                <div className="bg-secondary/30 rounded-lg p-2 text-center">
                  <div className="text-[9px] text-muted-foreground">AVG</div>
                  <div className="font-bold text-foreground">{bvpData.avg != null ? `.${(bvpData.avg * 1000).toFixed(0).padStart(3, "0")}` : "—"}</div>
                </div>
                <div className="bg-secondary/30 rounded-lg p-2 text-center">
                  <div className="text-[9px] text-muted-foreground">HR</div>
                  <div className="font-bold text-foreground">{bvpData.homeRuns}</div>
                </div>
                <div className="bg-secondary/30 rounded-lg p-2 text-center">
                  <div className="text-[9px] text-muted-foreground">K</div>
                  <div className="font-bold text-foreground">{bvpData.strikeouts}</div>
                </div>
              </div>
              {bvpData.atBats < 10 && (
                <div className="text-[9px] text-muted-foreground mt-1.5">Small sample ({bvpData.atBats} AB) — use with caution</div>
              )}
            </div>
          );
        })()}

        {abResults.length > 0 && (
          <div className="px-4 py-3 border-b border-border/30">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">At-Bat Results</div>
            <div className="flex gap-2 flex-wrap">
              {abResults.map((ab, i) => (
                <ABOutcomePill key={i} outcome={ab.outcome} pitchType={ab.pitchType} pitchSpeed={ab.pitchSpeed} exitVelocity={ab.exitVelocity} />
              ))}
            </div>
          </div>
        )}

        <div className="px-4 py-3 border-b border-border/30">
          {(() => {
            const hasLive = player.exitVelocity != null || player.hardHitPct != null || player.barrelPct != null;
            const hasRecent = player.xBA != null || player.xSLG != null;
            if (!hasLive && !hasRecent) {
              return (
                <div className="text-xs text-muted-foreground py-1">Contact quality not available yet</div>
              );
            }
            return (
              <>
                {hasLive && (
                  <div className="mb-2">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Contact Quality</span>
                      <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">LIVE</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      {player.exitVelocity != null && (
                        <div className="bg-secondary/30 rounded-lg p-2 text-center">
                          <div className="text-[9px] text-muted-foreground">EV</div>
                          <div className="font-bold text-foreground">{player.exitVelocity}</div>
                        </div>
                      )}
                      {player.barrelPct != null && (
                        <div className="bg-secondary/30 rounded-lg p-2 text-center">
                          <div className="text-[9px] text-muted-foreground">Barrel%</div>
                          <div className="font-bold text-foreground">{Math.round(player.barrelPct)}%</div>
                        </div>
                      )}
                      {player.hardHitPct != null && (
                        <div className="bg-secondary/30 rounded-lg p-2 text-center">
                          <div className="text-[9px] text-muted-foreground">Hard Hit</div>
                          <div className="font-bold text-foreground">{Math.round(player.hardHitPct)}%</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {hasRecent && (
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      {!hasLive && <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Contact Quality</span>}
                      <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">RECENT FORM</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {player.xBA != null && (
                        <div className="bg-secondary/30 rounded-lg p-2 text-center">
                          <div className="text-[9px] text-muted-foreground">xBA</div>
                          <div className="font-bold text-foreground">.{(player.xBA * 1000).toFixed(0).padStart(3, "0")}</div>
                        </div>
                      )}
                      {player.xSLG != null && (
                        <div className="bg-secondary/30 rounded-lg p-2 text-center">
                          <div className="text-[9px] text-muted-foreground">xSLG</div>
                          <div className="font-bold text-foreground">.{(player.xSLG * 1000).toFixed(0).padStart(3, "0")}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </div>

        <div className="px-4 py-3 border-b border-border/30">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Live Stats</div>
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2 text-xs">
            {[
              { label: "AB", value: player.ab }, { label: "H", value: player.h }, { label: "TB", value: player.tb },
              { label: "BB", value: player.bb }, { label: "K", value: player.k }, { label: "RBI", value: player.rbi },
              { label: "SB", value: player.sb }, { label: "R", value: player.r },
            ].map(stat => (
              <div key={stat.label} className="bg-secondary/40 rounded-lg p-2 text-center">
                <div className="text-muted-foreground text-[10px]">{stat.label}</div>
                <div className="font-bold text-foreground">{stat.value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-4 py-3">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Game Context</div>
          <div className="space-y-2 text-xs">
            <div className="flex items-center gap-3 bg-secondary/30 rounded-lg px-3 py-2">
              {(game.status === "live" || (game.awayScore != null && game.homeScore != null)) ? (
                <>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 shrink-0">LIVE</span>
                  <span className="font-bold text-foreground">{game.awayAbbr} {game.awayScore ?? 0}</span>
                  <span className="text-muted-foreground">–</span>
                  <span className="font-bold text-foreground">{game.homeScore ?? 0} {game.homeAbbr}</span>
                  <span className="text-[9px] text-muted-foreground ml-auto">{inningLabel(game)}</span>
                </>
              ) : (
                <>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">PRE</span>
                  <span className="font-semibold text-muted-foreground">{game.awayAbbr} @ {game.homeAbbr}</span>
                  {game.startTime && (
                    <span className="text-[9px] text-muted-foreground ml-auto">
                      {new Date(game.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </span>
                  )}
                </>
              )}
            </div>

            <div className="bg-secondary/20 rounded-lg px-3 py-2 flex items-center gap-3">
              <div className="text-[9px] text-muted-foreground shrink-0">Pitcher</div>
              <div className="font-semibold text-foreground truncate">{game.pitcherName || "TBD"}</div>
              {game.pitcherThrows && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-secondary/60 text-muted-foreground border border-border/30 shrink-0">
                  {game.pitcherThrows}HP
                </span>
              )}
              {game.pitcherContext?.pitchCount != null && game.pitcherContext.pitchCount > 0 && (
                <span className="text-[9px] text-muted-foreground ml-auto shrink-0">
                  {game.pitcherContext.pitchCount} pitches
                  {game.pitcherContext.timesThroughOrder > 0 && ` · ${ordinal(game.pitcherContext.timesThroughOrder)} pass`}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="bg-secondary/20 rounded-lg px-2.5 py-1.5">
                <div className="text-[9px] text-muted-foreground">Venue</div>
                <div className="font-semibold text-foreground truncate">{game.venue ?? "—"}</div>
              </div>
              <div className="bg-secondary/20 rounded-lg px-2.5 py-1.5">
                <div className="text-[9px] text-muted-foreground">Weather</div>
                <div className="font-semibold text-foreground truncate">
                  {game.weather?.temperature != null
                    ? `${game.weather.temperature}°F`
                    : game.weatherSummary || "—"}
                  {game.weather?.windSpeed != null && ` · ${game.weather.windSpeed}mph ${game.weather.windDirection ?? ""}`}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {playerSignals.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-bold text-foreground">Engine Signals</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {playerSignals.map(sig => (
              <SignalCard key={`${sig.playerId}-${sig.market}`} sig={sig} isElite={isElite} onAddToSlip={handleAddToSlip} />
            ))}
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Market</h3>
        <div className="space-y-2">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Batters</div>
          <div className="flex gap-1.5 flex-wrap">
            {BATTER_MARKETS.map(m => (
              <button key={m.value} data-testid={`button-market-${m.value}`} onClick={() => setSelectedMarket(m.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                  selectedMarket === m.value ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                }`}>{m.label}</button>
            ))}
          </div>
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider pt-1">Pitchers</div>
          <div className="flex gap-1.5 flex-wrap">
            {PITCHER_MARKETS.map(m => (
              <button key={m.value} data-testid={`button-market-${m.value}`} onClick={() => setSelectedMarket(m.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                  selectedMarket === m.value ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                }`}>{m.label}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">
            {manualMode ? (hasAnyOdds ? "Manual Input" : "Manual Projection") : "Sportsbook Lines"}
          </h3>
          {manualMode && hasAnyOdds && (
            <button data-testid="button-manual-toggle" onClick={() => setManualMode(false)}
              className="text-xs text-primary hover:text-primary/80 transition-colors">Back to lines</button>
          )}
        </div>

        {oddsLoading && !manualMode && (
          <div className="flex items-center gap-2 py-3">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-muted-foreground">Loading sportsbook lines…</span>
          </div>
        )}

        {!oddsLoading && !manualMode && oddsEntries.length === 0 && (
          <p className="text-xs text-muted-foreground/60 bg-secondary/50 rounded-lg p-3 border border-border/40">
            No sportsbook line available — enter values manually below.
          </p>
        )}

        {!oddsLoading && !manualMode && oddsEntries.length > 0 && (
          <div className="space-y-1.5">
            {oddsEntries.map(([sb, odds]) => {
              const o = odds as OddsEntry;
              const isActive = selectedLine?.book === sb;
              return (
                <button key={sb} type="button" data-testid={`button-mlb-odds-${sb}`}
                  onClick={() => { setSelectedLine({ book: sb, line: o.line, overOdds: o.overOdds, underOdds: o.underOdds }); setCalcResult(null); }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-xs transition-all ${
                    isActive ? "border-primary bg-primary/10" : "border-border/50 bg-secondary/30 hover:bg-secondary/60"
                  }`}>
                  <span className="font-semibold text-foreground">{SPORTSBOOK_LABELS[sb] ?? sb}</span>
                  <span className="font-mono font-bold text-primary">{o.line}</span>
                  <span className="text-muted-foreground">O {formatOdds(o.overOdds)} / U {formatOdds(o.underOdds)}</span>
                </button>
              );
            })}
            <button data-testid="button-switch-to-manual" onClick={() => {
                setManualMode(true); setSelectedLine(null);
                if (oddsEntries.length > 0) {
                  const lines = oddsEntries.map(([, o]) => (o as OddsEntry).line).filter(l => l != null).sort((a, b) => a - b);
                  if (lines.length > 0) setManualBookLine(String(lines[Math.floor(lines.length / 2)]));
                }
              }}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1">
              Enter line manually instead
            </button>
          </div>
        )}

        {manualMode && (
          <div className="space-y-3">
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Book Line *</label>
              <input data-testid="input-manual-line" type="number" step="0.5" value={manualBookLine}
                onChange={(e) => setManualBookLine(e.target.value)} placeholder="e.g. 1.5"
                className="w-full mt-1 px-3 py-2 rounded-lg border border-border bg-secondary/30 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary" />
            </div>
          </div>
        )}

        {!canCalculate && !calcMutation.isPending && (
          <div className="text-[10px] text-muted-foreground/70 text-center py-1">
            {!gameHydrated
              ? (!lineupReady ? "Waiting for lineup" : !(game.pitcherAway || game.pitcherHome) ? "Waiting for pitcher matchup" : "Waiting for game data…")
              : !playerHydrated ? "Waiting for player stats…"
              : !lineValid ? "Select a line or enter manual line" : ""}
          </div>
        )}
        <button data-testid="button-calculate-mlb" disabled={!canCalculate || calcMutation.isPending}
          onClick={() => calcMutation.mutate()}
          className="w-full h-10 rounded-lg bg-primary text-primary-foreground font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50 transition-opacity">
          {calcMutation.isPending ? (
            <><div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />Calculating…</>
          ) : manualMode ? "Calculate Manual Projection" : "Calculate Probability"}
        </button>
        {!(game.pitcherAway || game.pitcherHome) && (
          <div className="text-[10px] text-muted-foreground/60 text-center mt-1">Calculator requires pitcher data to be resolved</div>
        )}
      </div>

      {calcResult && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-4">
          <h3 className="text-sm font-semibold text-foreground">
            {calcResult.isManual ? "Manual Projection" : "Engine Result"}
          </h3>

          <div className="flex flex-col items-center gap-4">
            <ProbabilityRing probability={calcResult.calibratedProbabilityOver} size={140} strokeWidth={12} />
            <div className="text-center">
              <span className={`text-sm font-bold px-3 py-1 rounded-full ${calcResult.edge > 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                {calcResult.recommendedSide} {calcResult.bookLine}
                {!calcResult.isManual && ` · ${calcResult.edge > 0 ? "+" : ""}${calcResult.edge.toFixed(1)}% Edge`}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="bg-secondary/40 rounded-lg p-3 text-center">
              <div className="text-muted-foreground mb-1">Probability</div>
              <div className="font-bold text-foreground text-lg">{Math.round(calcResult.calibratedProbabilityOver)}%</div>
            </div>
            <div className="bg-secondary/40 rounded-lg p-3 text-center">
              <div className="text-muted-foreground mb-1">Projection</div>
              <div className="font-bold text-foreground text-lg">{calcResult.projection.toFixed(2)}</div>
            </div>
            {!calcResult.isManual && (
              <div className="bg-secondary/40 rounded-lg p-3 text-center">
                <div className="text-muted-foreground mb-1">Edge %</div>
                <div className={`font-bold text-lg ${calcResult.edge > 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {calcResult.edge > 0 ? "+" : ""}{calcResult.edge.toFixed(1)}%
                </div>
              </div>
            )}
            <div className="bg-secondary/40 rounded-lg p-3 text-center">
              <div className="text-muted-foreground mb-1">Tier</div>
              <div className={`font-bold text-lg ${
                calcResult.confidenceTier === "ELITE" ? "text-green-400" : calcResult.confidenceTier === "STRONG" ? "text-emerald-400"
                : calcResult.confidenceTier === "LEAN" ? "text-yellow-400" : "text-muted-foreground"
              }`}>{calcResult.confidenceTier}</div>
            </div>
          </div>

          {Array.isArray(calcResult.explanationBullets) && calcResult.explanationBullets.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Analysis</h4>
              <ul className="space-y-1">
                {calcResult.explanationBullets.map((bullet, i) => (
                  <li key={i} className="text-xs text-muted-foreground flex gap-2">
                    <span className="text-primary mt-0.5">·</span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function MlbLivePage() {
  return (
    <MLBErrorBoundary>
      <MlbLiveInner />
    </MLBErrorBoundary>
  );
}
