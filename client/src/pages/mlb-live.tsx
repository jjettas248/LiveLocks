import { useState, useEffect, useRef, Component, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ProbabilityRing } from "@/components/probability-ring";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { MLBScheduleList } from "@/components/mlb/MLBScheduleList";

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
};

type ABResultEntry = {
  outcome: "hit" | "out" | "strikeout" | "walk" | "hbp" | "error" | "other";
  exitVelocity: number | null;
  launchAngle: number | null;
  distance: number | null;
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
  formIndicator?: "HOT" | "WARM" | "COLD" | "NEUTRAL" | null;
  formScore?: number | null;
  evPct?: number | null;
  hrFactors?: { count: number; labels: string[] } | null;
  contextScore?: number | null;
  matchupTag?: string | null;
  explanationBullets?: string[];
  awayAbbr?: string | null;
  homeAbbr?: string | null;
};

type SignalsResponse = {
  mode: "live" | "no_lines" | "preview" | "preview_locked";
  signals: MLBSignal[];
  updatedAt: number;
  isDegraded?: boolean;
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
  hits: "Hits", total_bases: "Total Bases", batter_k: "K (Batter)", batter_strikeouts: "K (Batter)",
  pitcher_k: "K (Pitcher)", pitcher_strikeouts: "K (Pitcher)", hits_allowed: "Hits Allowed",
  walks_allowed: "Walks Allowed", hr: "Home Runs", home_runs: "Home Runs", hrr: "HRR",
};

const SPORTSBOOK_LABELS: Record<string, string> = {
  fanduel: "FanDuel", draftkings: "DraftKings", hardrockbet: "Hard Rock", betmgm: "BetMGM",
  caesars: "Caesars", pointsbet: "PointsBet", bet365: "Bet365", betrivers: "BetRivers",
  prizepicks: "PrizePicks", underdog: "Underdog",
};

const PITCHER_MARKET_SET = new Set(["pitcher_k", "pitcher_strikeouts", "hits_allowed", "walks_allowed"]);

const BATTER_MARKETS = [
  { value: "hits", label: "Hits" },
  { value: "total_bases", label: "Total Bases" },
  { value: "hr", label: "Home Runs" },
  { value: "batter_k", label: "Strikeouts (B)" },
];

const PITCHER_MARKETS = [
  { value: "pitcher_k", label: "K (Pitcher)" },
  { value: "walks_allowed", label: "Walks Allowed" },
  { value: "hits_allowed", label: "Hits Allowed" },
];

type MainTab = "games" | "edge_feed" | "inning_feed" | "hr_radar";

function heatEmoji(form: string | null | undefined): string {
  if (!form) return "";
  if (form === "HOT") return "🔥";
  if (form === "WARM") return "🟡";
  if (form === "COLD") return "❄️";
  return "";
}

function heatColor(form: string | null | undefined): string {
  if (form === "HOT") return "text-green-400";
  if (form === "WARM") return "text-yellow-400";
  if (form === "COLD") return "text-blue-400";
  return "text-muted-foreground";
}

function heatGlow(form: string | null | undefined): string {
  if (form === "HOT") return "shadow-[0_0_12px_rgba(34,197,94,0.3)]";
  if (form === "WARM") return "shadow-[0_0_8px_rgba(234,179,8,0.2)]";
  if (form === "COLD") return "shadow-[0_0_8px_rgba(59,130,246,0.2)]";
  return "";
}

function edgeColor(edge: number | null): string {
  if (edge == null) return "text-muted-foreground";
  if (Math.abs(edge) >= 8) return "text-green-400";
  if (Math.abs(edge) >= 5) return "text-yellow-400";
  return "text-muted-foreground";
}

function edgeBg(edge: number | null): string {
  if (edge == null) return "bg-muted/30";
  if (Math.abs(edge) >= 8) return "bg-green-500/10";
  if (Math.abs(edge) >= 5) return "bg-yellow-500/10";
  return "bg-muted/30";
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

function ABOutcomePill({ outcome }: { outcome: string }) {
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
  return (
    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md border ${styles[outcome] ?? styles.other}`}>
      {labels[outcome] ?? outcome}
    </span>
  );
}

function SignalCard({ sig, isElite, compact }: { sig: MLBSignal; isElite: boolean; compact?: boolean }) {
  const marketLabel = MARKET_LABELS[sig.market] ?? sig.market;
  const isHrMarket = sig.market === "home_runs" || sig.market === "hr" || sig.market === "hrr";
  const form = sig.formIndicator;
  const probWhole = Math.round(sig.enginePct);

  return (
    <div
      data-testid={`card-mlb-signal-${sig.playerId}-${sig.market}`}
      className={`rounded-xl border p-4 space-y-3 ${heatGlow(form)} ${edgeBg(sig.edge)} border-border/40`}
    >
      <div className="flex justify-between items-start gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-foreground">{sig.playerName}</span>
            {form && form !== "NEUTRAL" && (
              <span className={`text-xs font-bold ${heatColor(form)}`}>
                {heatEmoji(form)} {form}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
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
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full shrink-0 ${edgeColor(sig.edge)} ${edgeBg(sig.edge)}`}>
          {sig.recommendedSide}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="text-[10px] text-muted-foreground">Probability</div>
          <div className={`text-lg font-bold ${edgeColor(sig.edge)}`}>{probWhole}%</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">EV%</div>
          <div className={`text-lg font-bold ${sig.evPct != null && sig.evPct > 0 ? "text-green-400" : "text-muted-foreground"}`}>
            {sig.evPct != null ? `${sig.evPct > 0 ? "+" : ""}${sig.evPct.toFixed(1)}` : "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">Projection</div>
          <div className="text-lg font-bold text-foreground">{sig.projection != null ? sig.projection.toFixed(2) : "—"}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">Line</div>
          <div className="text-lg font-bold text-foreground">{sig.bookLine ?? "—"}</div>
        </div>
      </div>

      {sig.edge != null && (
        <div className={`text-center py-1.5 rounded-lg text-xs font-bold ${edgeBg(sig.edge)} ${edgeColor(sig.edge)}`}>
          Edge: +{sig.edge.toFixed(1)}%
        </div>
      )}

      {isHrMarket && sig.hrFactors && sig.hrFactors.count > 0 && (
        <div className="rounded-lg p-2 space-y-1" style={{ background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.2)" }}>
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

      <div className="flex items-center justify-between pt-1 border-t border-border/30">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {sig.sportsbook && <span className="font-semibold">{SPORTSBOOK_LABELS[sig.sportsbook] ?? sig.sportsbook}</span>}
          {sig.signalTimestamp && (
            <span>{new Date(sig.signalTimestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          )}
        </div>
        <button
          data-testid={`button-mlb-tweet-${sig.playerId}-${sig.market}`}
          className="text-xs px-3 py-1 rounded-lg border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          onClick={() => {
            const tweet = generateTweet(sig, isElite);
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(tweet).then(() => {
                const btn = document.querySelector(`[data-testid="button-mlb-tweet-${sig.playerId}-${sig.market}"]`);
                if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Tweet"; }, 1500); }
              }).catch(() => {});
            }
          }}
        >
          Tweet
        </button>
      </div>
    </div>
  );
}

function BatterCard({ player, signals, game, isElite, onSelect }: {
  player: MLBBatter;
  signals: MLBSignal[];
  game: MLBGame;
  isElite: boolean;
  onSelect: () => void;
}) {
  const playerSignals = signals.filter(s => s.playerId === player.playerId);
  const bestSignal = playerSignals.length > 0
    ? playerSignals.reduce((best, s) => Math.abs(s.edge ?? 0) > Math.abs(best.edge ?? 0) ? s : best)
    : null;
  const form = bestSignal?.formIndicator ?? null;
  const abResults = player.priorABResults ?? [];

  return (
    <div
      data-testid={`card-mlb-batter-${player.playerId}`}
      className={`rounded-xl border border-border/40 bg-card p-4 space-y-3 cursor-pointer hover:border-primary/40 transition-all ${heatGlow(form)}`}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-foreground">{player.playerName}</span>
            {form && form !== "NEUTRAL" && (
              <span className={`text-xs font-bold ${heatColor(form)}`}>
                {heatEmoji(form)} {form}
              </span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {player.teamAbbr} · #{player.battingOrderSlot}
          </div>
        </div>
        {bestSignal && (
          <div className="text-right">
            <div className={`text-lg font-bold ${edgeColor(bestSignal.edge)}`}>{Math.round(bestSignal.enginePct)}%</div>
            <div className="text-[10px] text-muted-foreground">
              {bestSignal.edge != null && <span className={edgeColor(bestSignal.edge)}>+{bestSignal.edge.toFixed(1)}%</span>}
            </div>
          </div>
        )}
      </div>

      {abResults.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground mb-1">Last ABs</div>
          <div className="flex gap-1">
            {abResults.slice(-5).map((ab, i) => (
              <ABOutcomePill key={i} outcome={ab.outcome} />
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-4 gap-2 text-xs">
        <div className="bg-secondary/30 rounded-lg p-1.5 text-center">
          <div className="text-[9px] text-muted-foreground">EV</div>
          <div className="font-bold text-foreground">{player.exitVelocity != null ? `${player.exitVelocity}` : "—"}</div>
        </div>
        <div className="bg-secondary/30 rounded-lg p-1.5 text-center">
          <div className="text-[9px] text-muted-foreground">Barrel%</div>
          <div className="font-bold text-foreground">{player.barrelPct != null ? `${Math.round(player.barrelPct)}%` : "—"}</div>
        </div>
        <div className="bg-secondary/30 rounded-lg p-1.5 text-center">
          <div className="text-[9px] text-muted-foreground">xBA</div>
          <div className="font-bold text-foreground">{player.xBA != null ? `.${(player.xBA * 1000).toFixed(0).padStart(3, "0")}` : "—"}</div>
        </div>
        <div className="bg-secondary/30 rounded-lg p-1.5 text-center">
          <div className="text-[9px] text-muted-foreground">H/AB</div>
          <div className="font-bold text-foreground">{player.ab > 0 ? `${player.h}/${player.ab}` : "—"}</div>
        </div>
      </div>

      {playerSignals.length > 0 && (
        <div className="space-y-1.5 pt-1 border-t border-border/20">
          {playerSignals.slice(0, 2).map(sig => (
            <div key={`${sig.playerId}-${sig.market}`} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className={`font-bold ${edgeColor(sig.edge)}`}>{sig.recommendedSide}</span>
                <span className="text-muted-foreground">{MARKET_LABELS[sig.market] ?? sig.market}</span>
                <span className="text-foreground font-semibold">{sig.bookLine}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`font-bold ${edgeColor(sig.edge)}`}>{Math.round(sig.enginePct)}%</span>
                {sig.edge != null && <span className={`text-[10px] ${edgeColor(sig.edge)}`}>+{sig.edge.toFixed(1)}%</span>}
              </div>
            </div>
          ))}
        </div>
      )}
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

  const isElite = user?.hasMLB === true;

  const { data: gamesResp, isLoading: gamesLoading } = useQuery<MLBGamesResponse>({
    queryKey: ["/api/mlb/live-games"],
    refetchInterval: 30_000,
  });

  const games = Array.isArray(gamesResp?.games) ? gamesResp!.games : [];
  const hasAnyOdds = games.some(g => g?.hasOdds === true);

  const { data: playersRaw, isLoading: playersLoading, error: playersError } = useQuery<MLBBatter[]>({
    queryKey: ["/api/mlb/live-stats", selectedGameId],
    enabled: !!selectedGameId && !mlbUpgradeNeeded,
    refetchInterval: 30_000,
    retry: (fc, err: any) => !(err?.message?.includes("MLB_UPGRADE_REQUIRED") || err?.status === 402) && fc < 2,
  });
  const players = Array.isArray(playersRaw) ? playersRaw : [];

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
    enabled: mainTab === "edge_feed" || mainTab === "inning_feed" || mainTab === "hr_radar",
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
  }, [selectedGameId]);
  useEffect(() => {
    if ((!oddsLoading && oddsEntries.length === 0 && selectedPlayer) || !hasAnyOdds) setManualMode(true);
    else if (oddsEntries.length > 0) setManualMode(false);
  }, [oddsLoading, oddsEntries.length, selectedPlayer?.playerId, hasAnyOdds]);

  const rosterPlayerIds = new Set<string>(players.filter(p => p?.playerId).map(p => String(p.playerId)));
  const validatedSignals = selectedGameId ? signals.filter(sig => sig && isValidSignal(sig, selectedGameId, rosterPlayerIds)) : [];
  const pitchersResolved = !!(selectedGame?.pitcherAway || selectedGame?.pitcherHome);
  const canCalculate = pitchersResolved && (manualMode ? (manualBookLine.trim() !== "" && !isNaN(parseFloat(manualBookLine)) && parseFloat(manualBookLine) > 0) : !!selectedLine);

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
    { key: "edge_feed", label: "Live Edge Feed" },
    { key: "inning_feed", label: "Inning Edge Feed" },
    { key: "hr_radar", label: "HR Radar", color: "orange" },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div className="flex gap-1.5 flex-wrap" data-testid="nav-mlb-tabs">
        {TABS.map(tab => {
          const active = mainTab === tab.key;
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
            <GameDetailView
              game={selectedGame}
              players={players}
              signals={validatedSignals}
              isElite={isElite}
              signalsLoading={signalsLoading}
              playersLoading={playersLoading}
              updatedAt={updatedAt}
              onSelectPlayer={(p) => setSelectedPlayer(p)}
              onBack={() => setSelectedGameId(null)}
            />
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
              calcMutation={calcMutation}
              calcResult={calcResult}
              opponentTeam={opponentTeam}
              onBack={() => { setSelectedPlayer(null); setCalcResult(null); setSelectedLine(null); setManualMode(false); }}
            />
          )}
        </>
      )}

      {mainTab === "edge_feed" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-foreground">Live Edge Feed</h2>
            <span className="text-[10px] text-muted-foreground">{edgeFeedSignals.length} signal{edgeFeedSignals.length !== 1 ? "s" : ""} across all games</span>
          </div>
          {edgeFeedSignals.length === 0 ? (
            <div className="rounded-xl border border-border/40 bg-card p-8 text-center">
              <div className="text-sm text-muted-foreground">No edges above threshold</div>
              <div className="text-xs text-muted-foreground/60 mt-1">Edges require 5%+ edge with verified odds. They appear as live games progress and sportsbook lines update.</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {edgeFeedSignals.map(sig => (
                <SignalCard key={`${sig.playerId}-${sig.market}-${sig.gameId}`} sig={sig} isElite={isElite} compact />
              ))}
            </div>
          )}
        </div>
      )}

      {mainTab === "inning_feed" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-foreground">Inning Edge Feed</h2>
          </div>
          <div className="flex gap-1.5">
            {([3, 5, 7] as const).map(inn => (
              <button
                key={inn}
                data-testid={`tab-inning-${inn}`}
                onClick={() => setInningFeedTab(inn)}
                className={`px-4 py-2 text-xs font-semibold rounded-full border transition-all ${
                  inningFeedTab === inn ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {inn === 3 ? "3rd Inning" : inn === 5 ? "5th Inning" : "7th Inning"}
              </button>
            ))}
          </div>
          {(() => {
            const filtered = edgeFeedSignals.filter(s => s.inning >= inningFeedTab);
            return filtered.length === 0 ? (
              <div className="rounded-xl border border-border/40 bg-card p-8 text-center">
                <div className="text-sm text-muted-foreground">No edges from inning {inningFeedTab}+</div>
                <div className="text-xs text-muted-foreground/60 mt-1">Edges for later innings appear as games progress and pitcher fatigue data accumulates.</div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {filtered.map(sig => (
                  <SignalCard key={`${sig.playerId}-${sig.market}-${sig.gameId}`} sig={sig} isElite={isElite} compact />
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {mainTab === "hr_radar" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-foreground" style={{ color: "#f97316" }}>HR Radar</h2>
          </div>
          {(() => {
            const hrSignals = edgeFeedSignals.filter(s => s.market === "home_runs" || s.market === "hr" || s.market === "hrr");
            const hrEnvironmentSignals = edgeFeedSignals.filter(s =>
              s.hrFactors && s.hrFactors.count >= 1 &&
              !(s.market === "home_runs" || s.market === "hr" || s.market === "hrr")
            );
            return (
              <>
                {hrSignals.length > 0 ? (
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-green-400 uppercase tracking-wider">Bettable HR Edges</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {hrSignals.map(sig => (
                        <SignalCard key={`${sig.playerId}-${sig.market}-${sig.gameId}`} sig={sig} isElite={isElite} compact />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-6 text-center">
                    <div className="text-sm text-muted-foreground">No HR edges above threshold</div>
                    <div className="text-xs text-muted-foreground/60 mt-1">HR edges require 3+ qualifying factors (hard contact, favorable park/weather, vulnerable pitcher). See environment context below.</div>
                  </div>
                )}

                {hrEnvironmentSignals.length > 0 && (
                  <div className="space-y-2 mt-4">
                    <h3 className="text-xs font-semibold text-orange-400 uppercase tracking-wider">HR Environment Watchlist</h3>
                    <div className="text-[10px] text-muted-foreground/70 mb-1">Players with HR-favorable context (hard contact, wind, park factors) but in non-HR markets</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {hrEnvironmentSignals.map(sig => (
                        <div key={`hr-env-${sig.playerId}-${sig.market}-${sig.gameId}`}
                          className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-bold text-foreground">{sig.playerName}</span>
                            <span className="text-[10px] text-orange-400">{sig.hrFactors?.labels?.join(", ")}</span>
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {sig.market} | {sig.hrFactors?.count} HR factor{sig.hrFactors?.count !== 1 ? "s" : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {hrSignals.length === 0 && hrEnvironmentSignals.length === 0 && (
                  <div className="text-xs text-muted-foreground/60 text-center py-2">
                    No players with HR-favorable context detected yet. Watchlist populates as games progress and contact data accumulates.
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function GameDetailView({ game, players, signals, isElite, signalsLoading, playersLoading, updatedAt, onSelectPlayer, onBack }: {
  game: MLBGame;
  players: MLBBatter[];
  signals: MLBSignal[];
  isElite: boolean;
  signalsLoading: boolean;
  playersLoading: boolean;
  updatedAt: number;
  onSelectPlayer: (p: MLBBatter) => void;
  onBack: () => void;
}) {
  const awayPlayers = players.filter(p => p.teamSide === "away" || (game.awayAbbr && p.teamAbbr === game.awayAbbr));
  const homePlayers = players.filter(p => p.teamSide === "home" || (game.homeAbbr && p.teamAbbr === game.homeAbbr));

  return (
    <div className="space-y-4">
      <button data-testid="button-back-to-games" onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors font-medium">
        ← Back to Games
      </button>

      <div className="rounded-xl border border-border/40 bg-card overflow-hidden" data-testid="card-mlb-game-detail">
        <div className="p-4 border-b border-border/30">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-bold text-foreground">{game.awayAbbr} vs {game.homeAbbr}</h2>
              {game.status === "live" ? (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-green-500/15 text-green-500 animate-pulse">LIVE</span>
              ) : (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-muted text-muted-foreground">PRE</span>
              )}
            </div>
            {game.status === "live" && game.inning > 0 && (
              <span className="text-sm font-bold text-green-400">{game.isTopInning ? "▲" : "▼"}{game.inning}</span>
            )}
          </div>

          {game.status === "live" && game.awayScore != null && game.homeScore != null && (
            <div className="flex items-center justify-center gap-8 py-3">
              <div className="text-center">
                <div className="text-xs text-muted-foreground mb-1">{game.awayAbbr}</div>
                <div className="text-3xl font-bold text-foreground">{game.awayScore}</div>
              </div>
              <span className="text-xl text-muted-foreground/30">–</span>
              <div className="text-center">
                <div className="text-xs text-muted-foreground mb-1">{game.homeAbbr}</div>
                <div className="text-3xl font-bold text-foreground">{game.homeScore}</div>
              </div>
            </div>
          )}

          {game.status === "pregame" && game.startTime && (
            <div className="text-center py-2">
              <div className="text-xs text-muted-foreground">First Pitch</div>
              <div className="text-sm font-bold text-foreground mt-0.5">
                {new Date(game.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-0 border-b border-border/30">
          <div className="p-3 border-r border-border/20">
            <div className="text-[10px] text-muted-foreground mb-1">{game.awayAbbr} Pitcher</div>
            <div className="text-xs font-bold text-foreground">{game.pitcherAway || (game.status === "pregame" ? "Pending" : "Resolving…")}</div>
          </div>
          <div className="p-3">
            <div className="text-[10px] text-muted-foreground mb-1">{game.homeAbbr} Pitcher</div>
            <div className="text-xs font-bold text-foreground">{game.pitcherHome || (game.status === "pregame" ? "Pending" : "Resolving…")}</div>
          </div>
        </div>

        {game.pitcherContext && (
          <div className="px-4 py-2 border-b border-border/30 flex gap-4 text-xs">
            <div>
              <span className="text-muted-foreground">Pitches: </span>
              <span className={`font-bold ${game.pitcherContext.pitchCount >= 85 ? "text-red-400" : "text-foreground"}`}>{game.pitcherContext.pitchCount}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Through Order: </span>
              <span className={`font-bold ${game.pitcherContext.timesThroughOrder >= 3 ? "text-red-400" : "text-foreground"}`}>{game.pitcherContext.timesThroughOrder}x</span>
            </div>
            {game.pitcherContext.avgVelocity != null && (
              <div>
                <span className="text-muted-foreground">Velo: </span>
                <span className="font-bold text-foreground">{game.pitcherContext.avgVelocity.toFixed(1)} mph</span>
              </div>
            )}
            {game.pitcherContext.velocityDrop != null && game.pitcherContext.velocityDrop > 0 && (
              <div>
                <span className="text-muted-foreground">Drop: </span>
                <span className="font-bold text-red-400">-{game.pitcherContext.velocityDrop.toFixed(1)} mph</span>
              </div>
            )}
          </div>
        )}

        <div className="px-4 py-2 border-b border-border/30 flex gap-4 text-xs text-muted-foreground">
          {game.venue && <span>{game.venue}</span>}
          {game.weather?.temperature != null && (
            <span>{game.weather.temperature}°F</span>
          )}
          {game.weather?.windSpeed != null && game.weather.windDirection && (
            <span>Wind {game.weather.windDirection} {game.weather.windSpeed}mph</span>
          )}
          {game.weather?.humidity != null && (
            <span>Humidity {game.weather.humidity}%</span>
          )}
        </div>
      </div>

      {signals.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-foreground">Edge Signals</h3>
            <div className="flex items-center gap-2">
              {updatedAt > 0 && isElite && (
                <span className="text-[10px] text-muted-foreground">
                  Updated {(() => { const s = Math.floor((Date.now() - updatedAt) / 1000); return s < 60 ? `${s}s ago` : `${Math.floor(s/60)}m ago`; })()}
                </span>
              )}
              {signalsLoading && <span className="text-[10px] text-muted-foreground animate-pulse">Refreshing…</span>}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {signals.map(sig => (
              <SignalCard key={`${sig.playerId}-${sig.market}`} sig={sig} isElite={isElite} />
            ))}
          </div>
        </div>
      )}

      {signals.length === 0 && game.status === "live" && (
        <div className="rounded-xl border border-border/40 bg-card p-6 text-center">
          <div className="text-sm text-muted-foreground">No qualified edges for this game</div>
          <div className="text-xs text-muted-foreground/60 mt-1">Edges require 5%+ edge with verified sportsbook odds. The engine re-evaluates every cycle as lines update.</div>
        </div>
      )}

      {signals.length === 0 && game.status === "pregame" && (
        <div className="rounded-xl border border-border/40 bg-card p-6 text-center">
          <div className="text-sm text-muted-foreground">Pre-Game</div>
          <div className="text-xs text-muted-foreground/60 mt-1">Live edges will appear once the game begins and odds are available.</div>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-foreground">Batters</h3>
          {playersLoading && <span className="text-[10px] text-muted-foreground animate-pulse">Loading…</span>}
        </div>

        {!playersLoading && players.length === 0 && (
          <div className="rounded-lg border border-border/30 bg-card/50 p-4 text-center">
            <div className="text-xs text-muted-foreground">No contact data available</div>
            <div className="text-[10px] text-muted-foreground/50 mt-1">{game.status === "pregame" ? "Batter data populates once the game starts and at-bats are recorded." : "Batter data is loading. Contact stats update as at-bats are recorded."}</div>
          </div>
        )}

        {(awayPlayers.length > 0 || homePlayers.length > 0) && (
          <>
            {awayPlayers.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{game.awayAbbr}</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {awayPlayers.map(p => (
                    <BatterCard key={p.playerId} player={p} signals={signals} game={game} isElite={isElite} onSelect={() => onSelectPlayer(p)} />
                  ))}
                </div>
              </div>
            )}
            {homePlayers.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{game.homeAbbr}</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {homePlayers.map(p => (
                    <BatterCard key={p.playerId} player={p} signals={signals} game={game} isElite={isElite} onSelect={() => onSelectPlayer(p)} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {awayPlayers.length === 0 && homePlayers.length === 0 && players.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {players.map(p => (
              <BatterCard key={p.playerId} player={p} signals={signals} game={game} isElite={isElite} onSelect={() => onSelectPlayer(p)} />
            ))}
          </div>
        )}
      </div>

      {!isElite && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 text-center space-y-3">
          <div className="text-sm font-bold text-foreground">Unlock Full MLB Analysis</div>
          <div className="text-xs text-muted-foreground">Upgrade to All Sports for unlimited signals, batter analysis, and bet recommendations.</div>
          <a href="/upgrade" data-testid="link-mlb-upgrade-cta-detail"
            className="inline-block px-5 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors">
            Upgrade to All Sports →
          </a>
        </div>
      )}
    </div>
  );
}

function PlayerDetailView({ player, game, signals, isElite, oddsEntries, oddsLoading, selectedMarket, setSelectedMarket,
  selectedLine, setSelectedLine, manualMode, setManualMode, manualBookLine, setManualBookLine, hasAnyOdds, canCalculate,
  calcMutation, calcResult, opponentTeam, onBack }: {
  player: MLBBatter; game: MLBGame; signals: MLBSignal[]; isElite: boolean;
  oddsEntries: [string, OddsEntry][]; oddsLoading: boolean; selectedMarket: string;
  setSelectedMarket: (m: string) => void; selectedLine: any; setSelectedLine: (l: any) => void;
  manualMode: boolean; setManualMode: (m: boolean) => void; manualBookLine: string;
  setManualBookLine: (v: string) => void; hasAnyOdds: boolean; canCalculate: boolean;
  calcMutation: any; calcResult: CalcResult | null; opponentTeam: string | null; onBack: () => void;
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
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${game.status === "live" ? "bg-green-500/15 text-green-500" : "bg-muted text-muted-foreground"}`}>
            {game.status === "live" ? `LIVE ${inningLabel(game)}` : "PRE"}
          </span>
        </div>

        {abResults.length > 0 && (
          <div className="px-4 py-3 border-b border-border/30">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">At-Bat Results</div>
            <div className="flex gap-2 flex-wrap">
              {abResults.map((ab, i) => (
                <div key={i} className="flex flex-col items-center gap-0.5">
                  <ABOutcomePill outcome={ab.outcome} />
                  {ab.exitVelocity != null && <span className="text-[8px] text-muted-foreground">{ab.exitVelocity} mph</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="px-4 py-3 border-b border-border/30">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Contact Quality</div>
          <div className="grid grid-cols-5 gap-2 text-xs">
            <div className="bg-secondary/30 rounded-lg p-2 text-center">
              <div className="text-[9px] text-muted-foreground">EV</div>
              <div className="font-bold text-foreground">{player.exitVelocity != null ? `${player.exitVelocity}` : "—"}</div>
            </div>
            <div className="bg-secondary/30 rounded-lg p-2 text-center">
              <div className="text-[9px] text-muted-foreground">Barrel%</div>
              <div className="font-bold text-foreground">{player.barrelPct != null ? `${Math.round(player.barrelPct)}%` : "—"}</div>
            </div>
            <div className="bg-secondary/30 rounded-lg p-2 text-center">
              <div className="text-[9px] text-muted-foreground">xBA</div>
              <div className="font-bold text-foreground">{player.xBA != null ? `.${(player.xBA * 1000).toFixed(0).padStart(3, "0")}` : "—"}</div>
            </div>
            <div className="bg-secondary/30 rounded-lg p-2 text-center">
              <div className="text-[9px] text-muted-foreground">xSLG</div>
              <div className="font-bold text-foreground">{player.xSLG != null ? `.${(player.xSLG * 1000).toFixed(0).padStart(3, "0")}` : "—"}</div>
            </div>
            <div className="bg-secondary/30 rounded-lg p-2 text-center">
              <div className="text-[9px] text-muted-foreground">Hard Hit</div>
              <div className="font-bold text-foreground">{player.hardHitPct != null ? `${Math.round(player.hardHitPct)}%` : "—"}</div>
            </div>
          </div>
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
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Game Info</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground text-[10px]">Score</div>
              <div className="font-semibold text-foreground">
                {game.status === "live" && game.awayScore != null && game.homeScore != null
                  ? `${game.awayAbbr} ${game.awayScore} – ${game.homeAbbr} ${game.homeScore}` : "Pre-Game"}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-[10px]">Venue</div>
              <div className="font-semibold text-foreground">{game.venue ?? "—"}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-[10px]">Weather</div>
              <div className="font-semibold text-foreground">{game.weatherSummary || "—"}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-[10px]">Pitcher</div>
              <div className="font-semibold text-foreground">{game.pitcherName ?? "—"}</div>
            </div>
          </div>
        </div>
      </div>

      {playerSignals.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-bold text-foreground">Engine Signals</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {playerSignals.map(sig => (
              <SignalCard key={`${sig.playerId}-${sig.market}`} sig={sig} isElite={isElite} />
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
            <button data-testid="button-switch-to-manual" onClick={() => { setManualMode(true); setSelectedLine(null); }}
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
