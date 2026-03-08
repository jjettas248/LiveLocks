import { useState, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ParlayPickInput, ParlayResult, CorrelationNote } from "@shared/schema";
import { ProbabilityRing } from "./probability-ring";
import { useToast } from "@/hooks/use-toast";
import { getAuthToken } from "@/lib/queryClient";
import {
  X,
  ExternalLink,
  TrendingUp,
  AlertTriangle,
  CheckCircle,
  Minus,
  Trophy,
  ChevronDown,
  ChevronUp,
  Copy,
  Zap,
} from "lucide-react";

interface ParlaySlipProps {
  picks: ParlayPickInput[];
  onRemove: (idx: number) => void;
  onClear: () => void;
  injuredPlayerNames?: Set<string>;
}

const STAT_LABELS: Record<string, string> = {
  points: "PTS",
  rebounds: "REB",
  assists: "AST",
  steals: "STL",
  blocks: "BLK",
  threes: "3PM",
  pts_reb_ast: "PRA",
  pts_reb: "PR",
  pts_ast: "PA",
  reb_ast: "RA",
  stl_blk: "S+B",
  ncaab_total: "Total",
  ncaab_1h_total: "1H Total",
  ncaab_spread: "Spread",
  ncaab_team_total: "Team Total",
};

const DK_SUBCATEGORY: Record<string, string> = {
  points:      "player-points",
  rebounds:    "player-rebounds",
  assists:     "player-assists",
  threes:      "player-threes",
  steals:      "player-steals",
  blocks:      "player-blocks",
  pts_reb_ast: "player-props",
  pts_reb:     "player-props",
  pts_ast:     "player-props",
  reb_ast:     "player-props",
  stl_blk:     "player-props",
};

function dkDeeplink(picks: ParlayPickInput[]): string {
  const firstStatType = picks[0]?.statType;
  const subcategory = (firstStatType && DK_SUBCATEGORY[firstStatType]) || "player-props";
  return `https://sportsbook.draftkings.com/leagues/basketball/nba?category=player-props&subcategory=${subcategory}`;
}

const SPORTSBOOK_INFO: Record<string, {
  label: string;
  color: string;
  deeplink: (picks: ParlayPickInput[]) => string;
  note?: string;
}> = {
  draftkings: {
    label: "DraftKings",
    color: "bg-[#1a6f3c] hover:bg-[#1a8f4c]",
    deeplink: dkDeeplink,
  },
  fanduel: {
    label: "FanDuel",
    color: "bg-[#1358d0] hover:bg-[#1a6af0]",
    deeplink: () => "https://sportsbook.fanduel.com/basketball/nba/player-props",
  },
  hardrockbet: {
    label: "Hard Rock Bet",
    color: "bg-[#b8860b] hover:bg-[#d4a017]",
    deeplink: () => "https://www.hardrock.bet/en-us/sports/basketball/nba/player-props",
  },
  fanatics: {
    label: "Fanatics",
    color: "bg-[#cc0000] hover:bg-[#e60000]",
    deeplink: () => "https://sportsbook.fanatics.com/sports/basketball/nba",
    note: "Search player name manually",
  },
  prizepicks: {
    label: "PrizePicks",
    color: "bg-[#7c3aed] hover:bg-[#8b5cf6]",
    deeplink: () => "https://app.prizepicks.com",
    note: "Search player name manually",
  },
  underdogfantasy: {
    label: "Underdog",
    color: "bg-[#f97316] hover:bg-[#fb923c]",
    deeplink: () => "https://underdogfantasy.com",
    note: "Search player name manually",
  },
};

function formatOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function CorrelationBadge({ note }: { note: CorrelationNote }) {
  const isPositive = note.type === "positive";
  const isNegative = note.type === "negative";
  return (
    <div className={`flex items-start gap-2 p-2.5 rounded-lg text-xs border ${
      isPositive
        ? "bg-green-500/10 border-green-500/30 text-green-400"
        : isNegative
        ? "bg-red-500/10 border-red-500/30 text-red-400"
        : "bg-muted/50 border-border text-muted-foreground"
    }`}>
      {isPositive ? (
        <TrendingUp className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      ) : isNegative ? (
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      ) : (
        <Minus className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      )}
      <div>
        <span className="font-semibold">{note.pick1} × {note.pick2}:</span>{" "}
        {note.explanation}{" "}
        <span className="font-bold">({note.multiplier > 1 ? "+" : ""}{((note.multiplier - 1) * 100).toFixed(0)}%)</span>
      </div>
    </div>
  );
}

function SportsbookButtons({ picks, toast }: { picks: ParlayPickInput[]; toast: ReturnType<typeof useToast>["toast"] }) {
  const uniqueSportsbooks = Array.from(new Set(picks.map((p) => p.sportsbook).filter(Boolean))) as string[];
  const sbList = uniqueSportsbooks.length > 0
    ? [...uniqueSportsbooks, "fanatics", "prizepicks", "underdogfantasy"].filter((v, i, a) => a.indexOf(v) === i)
    : ["draftkings", "fanduel", "hardrockbet", "fanatics", "prizepicks", "underdogfantasy"];

  const copyText = picks.map(p =>
    `${p.playerName} — ${STAT_LABELS[p.statType] ?? p.statType} ${p.betDirection === "over" ? "O" : "U"}${p.line}`
  ).join("\n");

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground uppercase tracking-wider">
          {picks.length === 1 ? "Send Straight to Sportsbook" : "Open Bet Slip"}
        </p>
        <button
          type="button"
          data-testid="button-copy-picks"
          onClick={() => {
            navigator.clipboard.writeText(copyText);
            toast({ title: "Pick copied!", description: "Paste into the sportsbook search." });
          }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Copy className="w-3 h-3" /> Copy
        </button>
      </div>
      {picks.length === 1 && (
        <p className="text-xs text-muted-foreground/60 -mt-1">
          Opens player props — your pick is copied to clipboard automatically.
        </p>
      )}
      {picks.length > 1 && (
        <p className="text-xs text-muted-foreground/60 -mt-1">
          Opens player props — all picks copied to clipboard automatically.
        </p>
      )}
      {sbList.map((sb) => {
        const info = SPORTSBOOK_INFO[sb];
        if (!info) return null;
        return (
          <a
            key={sb}
            href={info.deeplink(picks)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`link-sportsbook-${sb}`}
            onClick={() => {
              navigator.clipboard.writeText(copyText);
              toast({
                title: `Opening ${info.label}`,
                description: picks.length === 1
                  ? "Your pick was copied to clipboard."
                  : "Your picks were copied to clipboard.",
              });
            }}
            className={`flex items-center justify-between w-full px-4 py-2.5 rounded-lg text-white font-semibold text-sm transition-colors ${info.color}`}
          >
            <div>
              <span>{info.label}</span>
              {info.note && <span className="text-white/60 text-xs font-normal ml-2">{info.note}</span>}
            </div>
            <ExternalLink className="w-4 h-4" />
          </a>
        );
      })}
    </div>
  );
}

export function ParlaySlip({ picks, onRemove, onClear, injuredPlayerNames }: ParlaySlipProps) {
  const [result, setResult] = useState<ParlayResult | null>(null);
  const [showCorrelations, setShowCorrelations] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();
  const isStraight = picks.length === 1;

  const calculateParlay = useMutation({
    mutationFn: async (picks: ParlayPickInput[]): Promise<ParlayResult> => {
      const token = getAuthToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/parlay/calculate", {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ picks }),
      });
      if (!res.ok) throw new Error("Failed to calculate parlay");
      return res.json();
    },
    onSuccess: (data) => setResult(data),
  });

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (picks.length >= 2) {
      debounceRef.current = setTimeout(() => calculateParlay.mutate(picks), 300);
    } else {
      setResult(null);
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [picks]);

  if (picks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-center p-6">
        <Trophy className="w-10 h-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No picks yet.</p>
        <p className="text-xs text-muted-foreground/60 mt-1">Calculate a prop then click Over or Under to add.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {isStraight ? (
            <Zap className="w-4 h-4 text-amber-400" />
          ) : (
            <Trophy className="w-4 h-4 text-primary" />
          )}
          <span className="font-semibold text-sm">
            {isStraight ? "Straight Bet" : `${picks.length}-Leg Parlay`}
          </span>
        </div>
        <button
          onClick={onClear}
          className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1"
          data-testid="button-clear-parlay"
        >
          <X className="w-3 h-3" /> Clear All
        </button>
      </div>

      {/* Picks List */}
      <div className="space-y-2 mb-3">
        {picks.map((pick, idx) => {
          const isInjured = injuredPlayerNames?.has(pick.playerName.toLowerCase());
          return (
            <div
              key={idx}
              data-testid={`parlay-pick-${idx}`}
              className={`flex items-center gap-2 p-2.5 rounded-lg border ${
                isInjured ? "bg-red-500/10 border-red-500/40" : "bg-secondary/50 border-border/50"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-sm text-foreground truncate">{pick.playerName}</span>
                  {pick.isEstimated && (
                    <span
                      title="Line derived from projection — no book line currently available"
                      style={{
                        background: "rgba(245,158,11,0.15)",
                        border: "1px solid rgba(245,158,11,0.25)",
                        color: "#f59e0b",
                        fontSize: 10,
                        padding: "1px 5px",
                        borderRadius: 4,
                        cursor: "help",
                        flexShrink: 0,
                      }}
                    >
                      Est.
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">{pick.playerTeam}</span>
                  {isInjured && (
                    <span className="text-xs font-bold text-red-400 flex items-center gap-0.5">
                      <AlertTriangle className="w-3 h-3" /> Injured
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                    pick.betDirection === "under"
                      ? "bg-red-500/10 text-red-400"
                      : "bg-emerald-500/10 text-emerald-400"
                  }`}>
                    {STAT_LABELS[pick.statType] ?? pick.statType} {pick.betDirection === "under" ? "U" : "O"}{pick.line}
                  </span>
                  {pick.sportsbook && (
                    <span className="text-xs text-muted-foreground">
                      {SPORTSBOOK_INFO[pick.sportsbook]?.label ?? pick.sportsbook}
                      {pick.oddsAmerican ? ` (${formatOdds(pick.oddsAmerican)})` : ""}
                    </span>
                  )}
                  <span className={`text-xs font-bold ml-auto ${
                    pick.probability >= 65
                      ? "text-green-400"
                      : pick.probability <= 35
                      ? "text-red-400"
                      : "text-yellow-400"
                  }`}>
                    {pick.probability.toFixed(1)}%
                  </span>
                </div>
              </div>
              <button
                onClick={() => onRemove(idx)}
                data-testid={`button-remove-pick-${idx}`}
                className="text-muted-foreground hover:text-destructive flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Straight Bet — sportsbook deeplinks shown immediately */}
      {isStraight && (
        <div className="space-y-3 flex-1 overflow-y-auto">
          {/* Single pick odds display */}
          {picks[0].oddsAmerican && (
            <div className="bg-secondary/50 rounded-xl p-3 border border-border/50">
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Sportsbook Odds</span>
                <span className={`text-xl font-bold font-mono ${picks[0].oddsAmerican > 0 ? "text-green-400" : "text-foreground"}`}>
                  {formatOdds(picks[0].oddsAmerican)}
                </span>
              </div>
            </div>
          )}
          <SportsbookButtons picks={picks} toast={toast} />
        </div>
      )}

      {/* Parlay (2+ legs) */}
      {!isStraight && (
        <>
          {/* Calculate / auto-calculating */}
          {calculateParlay.isPending ? (
            <div className="w-full h-10 rounded-lg bg-primary/20 border border-primary/30 text-primary/80 text-sm font-semibold flex items-center justify-center gap-2 mb-3">
              <div className="w-3.5 h-3.5 border-2 border-primary/60 border-t-transparent rounded-full animate-spin" />
              Calculating…
            </div>
          ) : (
            <button
              onClick={() => calculateParlay.mutate(picks)}
              data-testid="button-calculate-parlay"
              className="w-full h-10 rounded-lg bg-primary/10 border border-primary/30 text-primary font-semibold text-sm flex items-center justify-center gap-2 hover:bg-primary/20 transition-colors mb-3"
            >
              <Trophy className="w-4 h-4" />
              {result ? "Recalculate" : "Calculate Parlay"}
            </button>
          )}

          {result && (
            <div className="space-y-3 flex-1 overflow-y-auto">
              {/* Probability Ring */}
              <div className="bg-card border border-border rounded-xl p-4 flex flex-col items-center">
                <ProbabilityRing
                  probability={result.correlationAdjustedProbability}
                  size={140}
                  strokeWidth={12}
                />
                <div className="text-center mt-2">
                  <div className="text-xs text-muted-foreground">Correlation-Adjusted Hit %</div>
                  {result.correlationAdjustedProbability !== result.combinedProbability && (
                    <div className="text-xs text-muted-foreground/60 mt-1">
                      Base: {result.combinedProbability.toFixed(1)}%
                    </div>
                  )}
                </div>
              </div>

              {/* Implied Odds */}
              <div className="bg-secondary/50 rounded-xl p-3 border border-border/50">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">Implied Odds</span>
                  <span className={`text-xl font-bold font-mono ${result.impliedAmericanOdds > 0 ? "text-green-400" : "text-foreground"}`}>
                    {formatOdds(result.impliedAmericanOdds)}
                  </span>
                </div>
              </div>

              {/* Correlations */}
              {result.correlations.length > 0 && (
                <div className="space-y-1.5">
                  <button
                    className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground w-full"
                    onClick={() => setShowCorrelations(!showCorrelations)}
                    data-testid="button-toggle-correlations"
                  >
                    <CheckCircle className="w-3.5 h-3.5" />
                    {result.correlations.length} Correlation{result.correlations.length !== 1 ? "s" : ""} Detected
                    {showCorrelations ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
                  </button>
                  {showCorrelations && (
                    <div className="space-y-1.5">
                      {result.correlations.map((c, i) => (
                        <CorrelationBadge key={i} note={c} />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Sportsbook Deeplinks */}
              <SportsbookButtons picks={picks} toast={toast} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
